//! Schema introspection: databases / schemas / tables / columns per backend.
//!
//! Each query is hand-written for the backend's catalog tables so the result
//! shape is consistent across drivers. The frontend tree just walks the
//! identifiers it gets back here.

use serde::Serialize;
use sqlx::Row;

use crate::db::Backend;
use crate::error::{AppError, AppResult};

#[derive(Serialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Serialize)]
pub struct SchemaInfo {
    pub name: String,
}

#[derive(Serialize)]
pub struct TableInfo {
    pub name: String,
    /// `"table"` or `"view"`.
    pub kind: &'static str,
    /// Server-side row estimate when available (NULL for views).
    pub rows: Option<i64>,
}

#[derive(Serialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub full_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub is_primary: bool,
    pub is_auto_increment: bool,
    pub ordinal: i64,
}

// ---------------------------- Databases --------------------------------------

pub async fn list_databases(backend: &Backend) -> AppResult<Vec<DatabaseInfo>> {
    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(
                "SELECT schema_name AS name FROM information_schema.schemata \
                 WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') \
                 ORDER BY schema_name",
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| DatabaseInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_default(),
                })
                .collect())
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT datname AS name FROM pg_database \
                 WHERE NOT datistemplate AND datallowconn ORDER BY datname",
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| DatabaseInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_default(),
                })
                .collect())
        }
        Backend::Sqlite(pool) => {
            // SQLite reports attached databases via `PRAGMA database_list`.
            // The primary one is `main`; expose any ATTACH'd ones too.
            let rows = sqlx::query("PRAGMA database_list").fetch_all(pool).await?;
            Ok(rows
                .into_iter()
                .map(|r| DatabaseInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_else(|_| "main".to_string()),
                })
                .collect())
        }
    }
}

// ----------------------------- Schemas ---------------------------------------

pub async fn list_schemas(backend: &Backend, database: &str) -> AppResult<Vec<SchemaInfo>> {
    match backend {
        // For MySQL, a "database" is the schema. Return [database] so the
        // frontend tree stays homogeneous.
        Backend::Mysql(_) => Ok(vec![SchemaInfo {
            name: database.to_string(),
        }]),
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT schema_name AS name FROM information_schema.schemata \
                 WHERE schema_name NOT LIKE 'pg\\_%' AND schema_name <> 'information_schema' \
                 ORDER BY schema_name",
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| SchemaInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_default(),
                })
                .collect())
        }
        Backend::Sqlite(_) => Ok(vec![SchemaInfo {
            name: database.to_string(),
        }]),
    }
}

// ----------------------------- Tables ----------------------------------------

pub async fn list_tables(
    backend: &Backend,
    database: &str,
    schema: &str,
) -> AppResult<Vec<TableInfo>> {
    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(
                "SELECT table_name, table_type, table_rows \
                 FROM information_schema.tables \
                 WHERE table_schema = ? \
                 ORDER BY table_type, table_name",
            )
            .bind(database)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let kind = match r
                        .try_get::<String, _>("table_type")
                        .unwrap_or_default()
                        .as_str()
                    {
                        "VIEW" => "view",
                        _ => "table",
                    };
                    TableInfo {
                        name: r.try_get::<String, _>("table_name").unwrap_or_default(),
                        kind,
                        rows: r.try_get::<i64, _>("table_rows").ok(),
                    }
                })
                .collect())
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT c.relname AS name, c.relkind AS kind, c.reltuples::bigint AS rows \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p') \
                 ORDER BY c.relkind, c.relname",
            )
            .bind(schema)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let raw_kind: String = r.try_get("kind").unwrap_or_default();
                    let kind = match raw_kind.as_str() {
                        "v" | "m" => "view",
                        _ => "table",
                    };
                    TableInfo {
                        name: r.try_get::<String, _>("name").unwrap_or_default(),
                        kind,
                        rows: r.try_get::<i64, _>("rows").ok(),
                    }
                })
                .collect())
        }
        Backend::Sqlite(pool) => {
            let rows = sqlx::query(
                "SELECT name, type FROM sqlite_master \
                 WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
                 ORDER BY type, name",
            )
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| {
                    let kind = match r
                        .try_get::<String, _>("type")
                        .unwrap_or_default()
                        .as_str()
                    {
                        "view" => "view",
                        _ => "table",
                    };
                    TableInfo {
                        name: r.try_get::<String, _>("name").unwrap_or_default(),
                        kind,
                        rows: None,
                    }
                })
                .collect())
        }
    }
}

// ----------------------------- Columns ---------------------------------------

pub async fn list_columns(
    backend: &Backend,
    database: &str,
    schema: &str,
    table: &str,
) -> AppResult<Vec<ColumnInfo>> {
    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(
                "SELECT column_name, data_type, column_type, is_nullable, column_default, \
                        column_key, extra, ordinal_position \
                 FROM information_schema.columns \
                 WHERE table_schema = ? AND table_name = ? \
                 ORDER BY ordinal_position",
            )
            .bind(database)
            .bind(table)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| ColumnInfo {
                    name: r.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                    full_type: r.try_get::<String, _>("column_type").unwrap_or_default(),
                    nullable: r
                        .try_get::<String, _>("is_nullable")
                        .map(|s| s.eq_ignore_ascii_case("YES"))
                        .unwrap_or(false),
                    default_value: r.try_get::<Option<String>, _>("column_default").ok().flatten(),
                    is_primary: r
                        .try_get::<String, _>("column_key")
                        .map(|s| s == "PRI")
                        .unwrap_or(false),
                    is_auto_increment: r
                        .try_get::<String, _>("extra")
                        .map(|s| s.to_ascii_lowercase().contains("auto_increment"))
                        .unwrap_or(false),
                    ordinal: r.try_get::<i64, _>("ordinal_position").unwrap_or(0),
                })
                .collect())
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT a.attname AS name, \
                        format_type(a.atttypid, a.atttypmod) AS full_type, \
                        t.typname AS data_type, \
                        NOT a.attnotnull AS nullable, \
                        pg_get_expr(d.adbin, d.adrelid) AS default_value, \
                        EXISTS ( \
                            SELECT 1 FROM pg_constraint pc \
                            WHERE pc.conrelid = a.attrelid AND pc.contype = 'p' AND a.attnum = ANY (pc.conkey) \
                        ) AS is_primary, \
                        (pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL) AS is_auto, \
                        a.attnum AS ordinal \
                 FROM pg_attribute a \
                 JOIN pg_class c ON c.oid = a.attrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_type t ON t.oid = a.atttypid \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(pool)
            .await?;
            Ok(rows
                .into_iter()
                .map(|r| ColumnInfo {
                    name: r.try_get::<String, _>("name").unwrap_or_default(),
                    data_type: r.try_get::<String, _>("data_type").unwrap_or_default(),
                    full_type: r.try_get::<String, _>("full_type").unwrap_or_default(),
                    nullable: r.try_get::<bool, _>("nullable").unwrap_or(false),
                    default_value: r.try_get::<Option<String>, _>("default_value").ok().flatten(),
                    is_primary: r.try_get::<bool, _>("is_primary").unwrap_or(false),
                    is_auto_increment: r.try_get::<bool, _>("is_auto").unwrap_or(false),
                    ordinal: r.try_get::<i32, _>("ordinal").unwrap_or(0) as i64,
                })
                .collect())
        }
        Backend::Sqlite(pool) => {
            // SQLite doesn't accept bound table names in PRAGMA, so we
            // escape-and-quote the identifier inline. `escape_pg_ident`
            // doubles any embedded `"`, which is the only metacharacter
            // inside double-quoted SQLite identifiers.
            let quoted = escape_pg_ident(table)?;
            let sql = format!("PRAGMA table_info({quoted})");
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            // Detect AUTOINCREMENT by inspecting sqlite_sequence.
            let auto_inc = sqlx::query(
                "SELECT name FROM sqlite_sequence WHERE name = ?",
            )
            .bind(table)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .is_some();

            Ok(rows
                .into_iter()
                .map(|r| {
                    let pk = r.try_get::<i64, _>("pk").unwrap_or(0);
                    ColumnInfo {
                        name: r.try_get::<String, _>("name").unwrap_or_default(),
                        data_type: r.try_get::<String, _>("type").unwrap_or_default(),
                        full_type: r.try_get::<String, _>("type").unwrap_or_default(),
                        nullable: r.try_get::<i64, _>("notnull").unwrap_or(0) == 0,
                        default_value: r
                            .try_get::<Option<String>, _>("dflt_value")
                            .ok()
                            .flatten(),
                        is_primary: pk > 0,
                        // SQLite only marks INTEGER PRIMARY KEY columns as
                        // auto-increment when AUTOINCREMENT is declared,
                        // tracked via the sqlite_sequence row above.
                        is_auto_increment: pk == 1 && auto_inc,
                        ordinal: r.try_get::<i64, _>("cid").unwrap_or(0),
                    }
                })
                .collect())
        }
    }
}

/// True iff `s` is non-empty and contains no characters that the SQL
/// parser handles as identifier terminators outside of quotes. NUL is
/// rejected because some drivers truncate at the first NUL byte, which
/// would let an attacker smuggle SQL past the closing quote. Line
/// breaks (`\n`, `\r`) are rejected for the same reason — they're legal
/// inside MySQL backticks / PG quotes but no real schema uses them, and
/// rejecting keeps the boundary conservative without breaking the
/// hyphen / digit-leading / non-ASCII names we want to support.
fn is_valid_quotable_ident(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c == '\0' || c == '\n' || c == '\r')
}

/// Quote an identifier using `quote_char`, doubling any embedded
/// occurrence per SQL spec (`` ` `` for MySQL, `"` for PG / SQLite).
pub fn escape_quoted_ident(name: &str, quote_char: char) -> AppResult<String> {
    if !is_valid_quotable_ident(name) {
        return Err(AppError::BadRequest(format!(
            "invalid identifier: {name:?}"
        )));
    }
    let escaped = name.replace(quote_char, &format!("{quote_char}{quote_char}"));
    Ok(format!("{quote_char}{escaped}{quote_char}"))
}

/// MySQL/MariaDB: wrap in backticks, doubling any embedded backtick.
pub fn escape_mysql_ident(name: &str) -> AppResult<String> {
    escape_quoted_ident(name, '`')
}

/// PostgreSQL / SQLite: wrap in double-quotes, doubling embedded `"`.
pub fn escape_pg_ident(name: &str) -> AppResult<String> {
    escape_quoted_ident(name, '"')
}
