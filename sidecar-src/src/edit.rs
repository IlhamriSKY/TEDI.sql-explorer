//! Table-grid edit endpoints: paged SELECT + INSERT / UPDATE / DELETE by PK.
//!
//! Identifiers are escape-and-quoted via `schema::escape_*_ident` before
//! being inlined, so names with hyphens, digits, or non-ASCII characters
//! work the same way they do in `phpMyAdmin` / `psql`. Values flow through
//! bound parameters via the per-backend `bind_json` helpers, so the SQL
//! itself never carries user-supplied data.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{Column, Row, TypeInfo};

use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row};

#[derive(Deserialize)]
pub struct TableRowsRequest {
    pub conn: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default = "default_order_dir")]
    pub order_dir: String,
    #[serde(default)]
    pub page: u64,
    #[serde(default = "default_page_size")]
    pub page_size: u64,
}

fn default_order_dir() -> String {
    "asc".into()
}

fn default_page_size() -> u64 {
    100
}

#[derive(Serialize)]
pub struct TableRowsResponse {
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub total: Option<i64>,
    pub page: u64,
    pub page_size: u64,
}

#[derive(Deserialize)]
pub struct RowMutationRequest {
    pub conn: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    /// Map of primary-key columns to their current values. Required for
    /// UPDATE and DELETE; ignored for INSERT.
    #[serde(default)]
    pub pk: Map<String, Value>,
    /// Columns to set. Used by INSERT (all columns) and UPDATE (changed
    /// columns only).
    #[serde(default)]
    pub values: Map<String, Value>,
}

#[derive(Serialize)]
pub struct MutationResponse {
    pub affected: u64,
}

// --------------------------- Identifier helpers ------------------------------

fn qualify_mysql(database: &str, table: &str) -> AppResult<String> {
    Ok(format!(
        "{}.{}",
        escape_mysql_ident(database)?,
        escape_mysql_ident(table)?
    ))
}

fn qualify_pg(schema: &str, table: &str) -> AppResult<String> {
    Ok(format!(
        "{}.{}",
        escape_pg_ident(schema)?,
        escape_pg_ident(table)?
    ))
}

fn qualify_sqlite(table: &str) -> AppResult<String> {
    escape_pg_ident(table)
}

fn quote_mysql_ident(name: &str) -> AppResult<String> {
    escape_mysql_ident(name)
}

fn quote_pg_ident(name: &str) -> AppResult<String> {
    escape_pg_ident(name)
}

fn order_dir_ok(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "asc" | "desc")
}

// --------------------------- Bind helpers ------------------------------------
//
// Each backend has its own `bind_$backend(query, value)` that translates a
// `serde_json::Value` into the right sqlx Encode call.

fn decode_bytes_marker(v: &Value) -> Option<Vec<u8>> {
    let obj = v.as_object()?;
    let kind = obj.get("__type").and_then(|t| t.as_str())?;
    if kind != "bytes" {
        return None;
    }
    let b64 = obj.get("b64").and_then(|t| t.as_str())?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

macro_rules! impl_bind {
    ($name:ident, $db:ty) => {
        fn $name<'q>(
            mut q: sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>>,
            value: &'q Value,
        ) -> sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>> {
            match value {
                Value::Null => {
                    q = q.bind(None::<String>);
                }
                Value::Bool(b) => {
                    q = q.bind(*b);
                }
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        q = q.bind(i);
                    } else if let Some(f) = n.as_f64() {
                        q = q.bind(f);
                    } else {
                        q = q.bind(n.to_string());
                    }
                }
                Value::String(s) => {
                    q = q.bind(s.as_str());
                }
                other => {
                    // Object / Array. Accept the `bytes` marker; otherwise bind
                    // the JSON text and let the DB coerce (works for JSON
                    // columns; degrades to text for everything else).
                    if let Some(bytes) = decode_bytes_marker(other) {
                        q = q.bind(bytes);
                    } else {
                        q = q.bind(other.to_string());
                    }
                }
            }
            q
        }
    };
}

impl_bind!(bind_mysql, sqlx::MySql);
impl_bind!(bind_pg, sqlx::Postgres);
impl_bind!(bind_sqlite, sqlx::Sqlite);

// --------------------------- /table-rows -------------------------------------

pub async fn list_rows(backend: &Backend, req: &TableRowsRequest) -> AppResult<TableRowsResponse> {
    if !order_dir_ok(&req.order_dir) {
        return Err(AppError::BadRequest("order_dir must be asc / desc".into()));
    }
    let page_size = req.page_size.clamp(1, 5_000);
    let offset = req.page.saturating_mul(page_size);

    match backend {
        Backend::Mysql(pool) => {
            let table = qualify_mysql(&req.database, &req.table)?;
            let mut sql = format!("SELECT * FROM {table}");
            if let Some(col) = &req.order_by {
                let col = quote_mysql_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns: Vec<String> = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let column_types: Vec<String> = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.type_info().name().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_mysql_row).collect();
            let total = count_mysql(pool, &table).await.ok();
            Ok(TableRowsResponse {
                columns,
                column_types,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
        Backend::Postgres(pool) => {
            let table = qualify_pg(&req.schema, &req.table)?;
            let mut sql = format!("SELECT * FROM {table}");
            if let Some(col) = &req.order_by {
                let col = quote_pg_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns: Vec<String> = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let column_types: Vec<String> = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.type_info().name().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_pg_row).collect();
            let total = count_pg(pool, &table).await.ok();
            Ok(TableRowsResponse {
                columns,
                column_types,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
        Backend::Sqlite(pool) => {
            let table = qualify_sqlite(&req.table)?;
            let mut sql = format!("SELECT * FROM {table}");
            if let Some(col) = &req.order_by {
                let col = quote_pg_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns: Vec<String> = rows
                .first()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let column_types: Vec<String> = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.type_info().name().to_string())
                        .collect()
                })
                .unwrap_or_default();
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_sqlite_row).collect();
            let total = count_sqlite(pool, &table).await.ok();
            Ok(TableRowsResponse {
                columns,
                column_types,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
    }
}

async fn count_mysql(pool: &sqlx::MySqlPool, table: &str) -> AppResult<i64> {
    let row = sqlx::query(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>("n").unwrap_or(0))
}

async fn count_pg(pool: &sqlx::PgPool, table: &str) -> AppResult<i64> {
    let row = sqlx::query(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>("n").unwrap_or(0))
}

async fn count_sqlite(pool: &sqlx::SqlitePool, table: &str) -> AppResult<i64> {
    let row = sqlx::query(&format!("SELECT COUNT(*) AS n FROM {table}"))
        .fetch_one(pool)
        .await?;
    Ok(row.try_get::<i64, _>("n").unwrap_or(0))
}

// --------------------------- /table-update -----------------------------------

pub async fn update_row(backend: &Backend, req: &RowMutationRequest) -> AppResult<MutationResponse> {
    if req.values.is_empty() {
        return Err(AppError::BadRequest("no columns to update".into()));
    }
    if req.pk.is_empty() {
        return Err(AppError::BadRequest("missing primary key".into()));
    }
    match backend {
        Backend::Mysql(pool) => {
            let table = qualify_mysql(&req.database, &req.table)?;
            let mut set_parts = Vec::new();
            for col in req.values.keys() {
                set_parts.push(format!("{} = ?", quote_mysql_ident(col)?));
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", quote_mysql_ident(col)?));
            }
            let sql = format!(
                "UPDATE {} SET {} WHERE {}",
                table,
                set_parts.join(", "),
                where_parts.join(" AND "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_mysql(q, v);
            }
            for v in req.pk.values() {
                q = bind_mysql(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
        Backend::Postgres(pool) => {
            let table = qualify_pg(&req.schema, &req.table)?;
            let mut set_parts = Vec::new();
            let mut idx: usize = 1;
            for col in req.values.keys() {
                set_parts.push(format!("{} = ${}", quote_pg_ident(col)?, idx));
                idx += 1;
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ${}", quote_pg_ident(col)?, idx));
                idx += 1;
            }
            let sql = format!(
                "UPDATE {} SET {} WHERE {}",
                table,
                set_parts.join(", "),
                where_parts.join(" AND "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_pg(q, v);
            }
            for v in req.pk.values() {
                q = bind_pg(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
        Backend::Sqlite(pool) => {
            let table = qualify_sqlite(&req.table)?;
            let mut set_parts = Vec::new();
            for col in req.values.keys() {
                set_parts.push(format!("{} = ?", quote_pg_ident(col)?));
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", quote_pg_ident(col)?));
            }
            let sql = format!(
                "UPDATE {} SET {} WHERE {}",
                table,
                set_parts.join(", "),
                where_parts.join(" AND "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_sqlite(q, v);
            }
            for v in req.pk.values() {
                q = bind_sqlite(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
    }
}

// --------------------------- /table-insert -----------------------------------

pub async fn insert_row(backend: &Backend, req: &RowMutationRequest) -> AppResult<Value> {
    if req.values.is_empty() {
        return Err(AppError::BadRequest("no columns to insert".into()));
    }
    match backend {
        Backend::Mysql(pool) => {
            let table = qualify_mysql(&req.database, &req.table)?;
            let mut cols = Vec::new();
            let mut placeholders = Vec::new();
            for col in req.values.keys() {
                cols.push(quote_mysql_ident(col)?);
                placeholders.push("?".to_string());
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table,
                cols.join(", "),
                placeholders.join(", "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_mysql(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(json!({
                "affected": r.rows_affected(),
                "last_insert_id": r.last_insert_id(),
            }))
        }
        Backend::Postgres(pool) => {
            let table = qualify_pg(&req.schema, &req.table)?;
            let mut cols = Vec::new();
            let mut placeholders = Vec::new();
            for (i, col) in req.values.keys().enumerate() {
                cols.push(quote_pg_ident(col)?);
                placeholders.push(format!("${}", i + 1));
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({}) RETURNING *",
                table,
                cols.join(", "),
                placeholders.join(", "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_pg(q, v);
            }
            let row = q.fetch_optional(pool).await?;
            let returned = row.as_ref().map(decode_pg_row).unwrap_or_default();
            let names: Vec<String> = row
                .as_ref()
                .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
                .unwrap_or_default();
            let mut map = Map::new();
            for (k, v) in names.into_iter().zip(returned.into_iter()) {
                map.insert(k, v);
            }
            Ok(json!({
                "affected": 1,
                "returning": Value::Object(map),
            }))
        }
        Backend::Sqlite(pool) => {
            let table = qualify_sqlite(&req.table)?;
            let mut cols = Vec::new();
            let mut placeholders = Vec::new();
            for col in req.values.keys() {
                cols.push(quote_pg_ident(col)?);
                placeholders.push("?".to_string());
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({})",
                table,
                cols.join(", "),
                placeholders.join(", "),
            );
            let mut q = sqlx::query(&sql);
            for v in req.values.values() {
                q = bind_sqlite(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(json!({
                "affected": r.rows_affected(),
                "last_insert_rowid": r.last_insert_rowid(),
            }))
        }
    }
}

// --------------------------- /table-delete -----------------------------------

pub async fn delete_row(backend: &Backend, req: &RowMutationRequest) -> AppResult<MutationResponse> {
    if req.pk.is_empty() {
        return Err(AppError::BadRequest("missing primary key".into()));
    }
    match backend {
        Backend::Mysql(pool) => {
            let table = qualify_mysql(&req.database, &req.table)?;
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", quote_mysql_ident(col)?));
            }
            let sql = format!("DELETE FROM {} WHERE {}", table, where_parts.join(" AND "));
            let mut q = sqlx::query(&sql);
            for v in req.pk.values() {
                q = bind_mysql(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
        Backend::Postgres(pool) => {
            let table = qualify_pg(&req.schema, &req.table)?;
            let mut where_parts = Vec::new();
            for (i, col) in req.pk.keys().enumerate() {
                where_parts.push(format!("{} = ${}", quote_pg_ident(col)?, i + 1));
            }
            let sql = format!("DELETE FROM {} WHERE {}", table, where_parts.join(" AND "));
            let mut q = sqlx::query(&sql);
            for v in req.pk.values() {
                q = bind_pg(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
        Backend::Sqlite(pool) => {
            let table = qualify_sqlite(&req.table)?;
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", quote_pg_ident(col)?));
            }
            let sql = format!("DELETE FROM {} WHERE {}", table, where_parts.join(" AND "));
            let mut q = sqlx::query(&sql);
            for v in req.pk.values() {
                q = bind_sqlite(q, v);
            }
            let r = q.execute(pool).await?;
            Ok(MutationResponse {
                affected: r.rows_affected(),
            })
        }
    }
}
