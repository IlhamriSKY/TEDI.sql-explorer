//! Table metadata beyond columns: indexes, foreign keys, and CREATE DDL.
//!
//! `schema.rs` answers "what columns does this table have"; everything a
//! workbench's Structure view needs on top of that lives here. Same shape per
//! backend so the frontend renders one table regardless of engine.

use serde::Serialize;
use sqlx::Row;

use crate::db::Backend;
use crate::error::AppResult;
use crate::schema::{escape_mysql_ident, escape_pg_ident, list_columns};

#[derive(Serialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
    /// Engine's own description (`BTREE`, or the full `CREATE INDEX` on PG).
    pub method: String,
}

#[derive(Serialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_schema: String,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    pub on_update: String,
    pub on_delete: String,
}

/// Fold `(group_key, member)` rows — already ordered by group then position —
/// into one entry per group. The catalog queries below all return one row per
/// index/constraint *column*, so every backend needs this same collapse.
fn group_rows<K: PartialEq, T>(rows: Vec<(K, String, T)>, mut build: impl FnMut(K, Vec<String>, T)) {
    let mut iter = rows.into_iter();
    let Some((mut key, first_col, mut extra)) = iter.next() else {
        return;
    };
    let mut cols = vec![first_col];
    for (k, col, ex) in iter {
        if k == key {
            cols.push(col);
            continue;
        }
        build(key, std::mem::take(&mut cols), extra);
        key = k;
        extra = ex;
        cols.push(col);
    }
    build(key, cols, extra);
}

// ----------------------------- Indexes ---------------------------------------

pub async fn list_indexes(
    backend: &Backend,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<IndexInfo>> {
    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(
                "SELECT index_name, column_name, non_unique, index_type \
                 FROM information_schema.statistics \
                 WHERE table_schema = ? AND table_name = ? \
                 ORDER BY index_name, seq_in_index",
            )
            .bind(database)
            .bind(table)
            .fetch_all(pool)
            .await?;
            let flat: Vec<(String, String, (bool, String))> = rows
                .into_iter()
                .map(|r| {
                    let name = r.try_get::<String, _>("index_name").unwrap_or_default();
                    let col = r.try_get::<String, _>("column_name").unwrap_or_default();
                    // `non_unique` is reported as an integer by MySQL and as a
                    // BIGINT by MariaDB; try both widths before giving up.
                    let non_unique = r
                        .try_get::<i64, _>("non_unique")
                        .or_else(|_| r.try_get::<i32, _>("non_unique").map(i64::from))
                        .unwrap_or(1);
                    let method = r.try_get::<String, _>("index_type").unwrap_or_default();
                    (name, col, (non_unique == 0, method))
                })
                .collect();
            let mut out = Vec::new();
            group_rows(flat, |name, columns, (unique, method)| {
                out.push(IndexInfo {
                    primary: name == "PRIMARY",
                    name,
                    columns,
                    unique,
                    method,
                });
            });
            Ok(out)
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT i.relname AS name, a.attname AS column_name, \
                        ix.indisunique AS is_unique, ix.indisprimary AS is_primary, \
                        am.amname AS method \
                 FROM pg_class t \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_index ix ON ix.indrelid = t.oid \
                 JOIN pg_class i ON i.oid = ix.indexrelid \
                 JOIN pg_am am ON am.oid = i.relam \
                 JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord) ON true \
                 JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum \
                 WHERE n.nspname = $1 AND t.relname = $2 \
                 ORDER BY i.relname, k.ord",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool)
            .await?;
            let flat: Vec<(String, String, (bool, bool, String))> = rows
                .into_iter()
                .map(|r| {
                    (
                        r.try_get::<String, _>("name").unwrap_or_default(),
                        r.try_get::<String, _>("column_name").unwrap_or_default(),
                        (
                            r.try_get::<bool, _>("is_unique").unwrap_or(false),
                            r.try_get::<bool, _>("is_primary").unwrap_or(false),
                            r.try_get::<String, _>("method").unwrap_or_default(),
                        ),
                    )
                })
                .collect();
            let mut out = Vec::new();
            group_rows(flat, |name, columns, (unique, primary, method)| {
                out.push(IndexInfo { name, columns, unique, primary, method });
            });
            Ok(out)
        }
        Backend::Sqlite(pool) => {
            let quoted = escape_pg_ident(table)?;
            let rows = sqlx::query(&format!("PRAGMA index_list({quoted})"))
                .fetch_all(pool)
                .await?;
            let mut out = Vec::new();
            for r in rows {
                let name = r.try_get::<String, _>("name").unwrap_or_default();
                let unique = r.try_get::<i64, _>("unique").unwrap_or(0) == 1;
                let origin = r.try_get::<String, _>("origin").unwrap_or_default();
                let info = sqlx::query(&format!("PRAGMA index_info({})", escape_pg_ident(&name)?))
                    .fetch_all(pool)
                    .await
                    .unwrap_or_default();
                out.push(IndexInfo {
                    columns: info
                        .into_iter()
                        .filter_map(|c| c.try_get::<Option<String>, _>("name").ok().flatten())
                        .collect(),
                    primary: origin == "pk",
                    name,
                    unique,
                    method: String::new(),
                });
            }
            Ok(out)
        }
    }
}

// --------------------------- Foreign keys ------------------------------------

pub async fn list_foreign_keys(
    backend: &Backend,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<ForeignKeyInfo>> {
    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(
                "SELECT k.constraint_name AS name, k.column_name, \
                        k.referenced_table_schema AS ref_schema, \
                        k.referenced_table_name AS ref_table, \
                        k.referenced_column_name AS ref_column, \
                        r.update_rule, r.delete_rule \
                 FROM information_schema.key_column_usage k \
                 JOIN information_schema.referential_constraints r \
                   ON r.constraint_schema = k.constraint_schema \
                  AND r.constraint_name = k.constraint_name \
                  AND r.table_name = k.table_name \
                 WHERE k.table_schema = ? AND k.table_name = ? \
                   AND k.referenced_table_name IS NOT NULL \
                 ORDER BY k.constraint_name, k.ordinal_position",
            )
            .bind(database)
            .bind(table)
            .fetch_all(pool)
            .await?;
            Ok(collect_fks(rows.into_iter().map(|r| FkRow {
                name: r.try_get::<String, _>("name").unwrap_or_default(),
                column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                ref_schema: r.try_get::<String, _>("ref_schema").unwrap_or_default(),
                ref_table: r.try_get::<String, _>("ref_table").unwrap_or_default(),
                ref_column: r.try_get::<String, _>("ref_column").unwrap_or_default(),
                on_update: r.try_get::<String, _>("update_rule").unwrap_or_default(),
                on_delete: r.try_get::<String, _>("delete_rule").unwrap_or_default(),
            })))
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT c.conname AS name, att.attname AS column_name, \
                        fn.nspname AS ref_schema, fc.relname AS ref_table, \
                        fatt.attname AS ref_column, \
                        c.confupdtype::text AS update_rule, \
                        c.confdeltype::text AS delete_rule \
                 FROM pg_constraint c \
                 JOIN pg_class t ON t.oid = c.conrelid \
                 JOIN pg_namespace n ON n.oid = t.relnamespace \
                 JOIN pg_class fc ON fc.oid = c.confrelid \
                 JOIN pg_namespace fn ON fn.oid = fc.relnamespace \
                 JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS u(att, fatt, ord) ON true \
                 JOIN pg_attribute att ON att.attrelid = t.oid AND att.attnum = u.att \
                 JOIN pg_attribute fatt ON fatt.attrelid = fc.oid AND fatt.attnum = u.fatt \
                 WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = 'f' \
                 ORDER BY c.conname, u.ord",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool)
            .await?;
            Ok(collect_fks(rows.into_iter().map(|r| FkRow {
                name: r.try_get::<String, _>("name").unwrap_or_default(),
                column: r.try_get::<String, _>("column_name").unwrap_or_default(),
                ref_schema: r.try_get::<String, _>("ref_schema").unwrap_or_default(),
                ref_table: r.try_get::<String, _>("ref_table").unwrap_or_default(),
                ref_column: r.try_get::<String, _>("ref_column").unwrap_or_default(),
                on_update: pg_fk_action(&r.try_get::<String, _>("update_rule").unwrap_or_default()),
                on_delete: pg_fk_action(&r.try_get::<String, _>("delete_rule").unwrap_or_default()),
            })))
        }
        Backend::Sqlite(pool) => {
            let quoted = escape_pg_ident(table)?;
            let rows = sqlx::query(&format!("PRAGMA foreign_key_list({quoted})"))
                .fetch_all(pool)
                .await?;
            Ok(collect_fks(rows.into_iter().map(|r| {
                let id = r.try_get::<i64, _>("id").unwrap_or(0);
                FkRow {
                    name: format!("fk_{id}"),
                    column: r.try_get::<String, _>("from").unwrap_or_default(),
                    ref_schema: String::new(),
                    ref_table: r.try_get::<String, _>("table").unwrap_or_default(),
                    ref_column: r.try_get::<String, _>("to").unwrap_or_default(),
                    on_update: r.try_get::<String, _>("on_update").unwrap_or_default(),
                    on_delete: r.try_get::<String, _>("on_delete").unwrap_or_default(),
                }
            })))
        }
    }
}

struct FkRow {
    name: String,
    column: String,
    ref_schema: String,
    ref_table: String,
    ref_column: String,
    on_update: String,
    on_delete: String,
}

/// PostgreSQL stores referential actions as a single char in `pg_constraint`.
fn pg_fk_action(code: &str) -> String {
    match code {
        "a" => "NO ACTION",
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        other => other,
    }
    .to_string()
}

fn collect_fks(rows: impl Iterator<Item = FkRow>) -> Vec<ForeignKeyInfo> {
    let mut out: Vec<ForeignKeyInfo> = Vec::new();
    for r in rows {
        match out.last_mut() {
            Some(last) if last.name == r.name => {
                last.columns.push(r.column);
                last.ref_columns.push(r.ref_column);
            }
            _ => out.push(ForeignKeyInfo {
                name: r.name,
                columns: vec![r.column],
                ref_schema: r.ref_schema,
                ref_table: r.ref_table,
                ref_columns: vec![r.ref_column],
                on_update: r.on_update,
                on_delete: r.on_delete,
            }),
        }
    }
    out
}

// ------------------------------- DDL -----------------------------------------

/// The `CREATE TABLE` for a table. MySQL and SQLite hand it to us verbatim;
/// PostgreSQL has no such command, so we rebuild a faithful-enough statement
/// from the catalog (columns, primary key, foreign keys, then the index
/// definitions as separate `CREATE INDEX` lines).
pub async fn table_ddl(
    backend: &Backend,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<String> {
    match backend {
        Backend::Mysql(pool) => {
            let sql = format!(
                "SHOW CREATE TABLE {}.{}",
                escape_mysql_ident(database)?,
                escape_mysql_ident(table)?
            );
            let row = sqlx::query(&sql).fetch_one(pool).await?;
            // Column 1 is "Create Table" for a table and "Create View" for a
            // view; index by position so both work.
            Ok(row.try_get::<String, _>(1).unwrap_or_default())
        }
        Backend::Sqlite(pool) => {
            let row = sqlx::query("SELECT sql FROM sqlite_master WHERE name = ?")
                .bind(table)
                .fetch_optional(pool)
                .await?;
            Ok(row
                .and_then(|r| r.try_get::<Option<String>, _>("sql").ok().flatten())
                .unwrap_or_default())
        }
        Backend::Postgres(_) => {
            let cols = list_columns(backend, database, schema, table).await?;
            let idx = list_indexes(backend, database, schema, table).await?;
            let fks = list_foreign_keys(backend, database, schema, table).await?;
            let qualified = format!("{}.{}", escape_pg_ident(schema)?, escape_pg_ident(table)?);
            let mut parts: Vec<String> = Vec::new();
            for c in &cols {
                let mut line = format!("  {} {}", escape_pg_ident(&c.name)?, c.full_type);
                if !c.nullable {
                    line.push_str(" NOT NULL");
                }
                if let Some(d) = &c.default_value {
                    line.push_str(&format!(" DEFAULT {d}"));
                }
                parts.push(line);
            }
            if let Some(pk) = idx.iter().find(|i| i.primary) {
                let cols = quote_list(&pk.columns)?;
                parts.push(format!("  PRIMARY KEY ({cols})"));
            }
            for fk in &fks {
                parts.push(format!(
                    "  CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON UPDATE {} ON DELETE {}",
                    escape_pg_ident(&fk.name)?,
                    quote_list(&fk.columns)?,
                    escape_pg_ident(&fk.ref_schema)?,
                    escape_pg_ident(&fk.ref_table)?,
                    quote_list(&fk.ref_columns)?,
                    fk.on_update,
                    fk.on_delete,
                ));
            }
            let mut ddl = format!("CREATE TABLE {qualified} (\n{}\n);\n", parts.join(",\n"));
            for i in idx.iter().filter(|i| !i.primary) {
                ddl.push_str(&format!(
                    "\nCREATE {}INDEX {} ON {} USING {} ({});",
                    if i.unique { "UNIQUE " } else { "" },
                    escape_pg_ident(&i.name)?,
                    qualified,
                    if i.method.is_empty() { "btree" } else { &i.method },
                    quote_list(&i.columns)?,
                ));
            }
            Ok(ddl)
        }
    }
}

fn quote_list(names: &[String]) -> AppResult<String> {
    let mut out = Vec::with_capacity(names.len());
    for n in names {
        out.push(escape_pg_ident(n)?);
    }
    Ok(out.join(", "))
}
