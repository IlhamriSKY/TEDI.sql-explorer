//! Table-grid edit endpoints: paged SELECT + INSERT / UPDATE / DELETE by PK.
//!
//! Identifiers are escape-and-quoted via `schema::escape_*_ident` before
//! being inlined, so names with hyphens, digits, or non-ASCII characters
//! work the same way they do in `phpMyAdmin` / `psql`. Values never touch the
//! statement text: they go through the bound-parameter layer in `bind.rs`,
//! which also supplies the type casts PostgreSQL needs for composites and
//! NULLs.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{Column, Row};

use crate::bind::{bind_mysql, bind_pg, bind_pg_value, bind_sqlite, pg_cast_types, pg_placeholder};
use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident, qualify_mysql, qualify_pg, qualify_sqlite};
use crate::value::decode_pg_row;

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
                set_parts.push(format!("{} = ?", escape_mysql_ident(col)?));
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", escape_mysql_ident(col)?));
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
            let casts = pg_cast_types(pool, &req.schema, &req.table, &req.values).await;
            let mut set_parts = Vec::new();
            let mut idx: usize = 1;
            for col in req.values.keys() {
                set_parts.push(format!(
                    "{} = {}",
                    escape_pg_ident(col)?,
                    pg_placeholder(&casts, col, idx)
                ));
                idx += 1;
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ${}", escape_pg_ident(col)?, idx));
                idx += 1;
            }
            let sql = format!(
                "UPDATE {} SET {} WHERE {}",
                table,
                set_parts.join(", "),
                where_parts.join(" AND "),
            );
            let mut q = sqlx::query(&sql);
            for (col, v) in req.values.iter() {
                q = bind_pg_value(q, &casts, col, v);
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
                set_parts.push(format!("{} = ?", escape_pg_ident(col)?));
            }
            let mut where_parts = Vec::new();
            for col in req.pk.keys() {
                where_parts.push(format!("{} = ?", escape_pg_ident(col)?));
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
                cols.push(escape_mysql_ident(col)?);
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
            let casts = pg_cast_types(pool, &req.schema, &req.table, &req.values).await;
            let mut cols = Vec::new();
            let mut placeholders = Vec::new();
            for (i, col) in req.values.keys().enumerate() {
                cols.push(escape_pg_ident(col)?);
                placeholders.push(pg_placeholder(&casts, col, i + 1));
            }
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({}) RETURNING *",
                table,
                cols.join(", "),
                placeholders.join(", "),
            );
            let mut q = sqlx::query(&sql);
            for (col, v) in req.values.iter() {
                q = bind_pg_value(q, &casts, col, v);
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
                cols.push(escape_pg_ident(col)?);
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
                where_parts.push(format!("{} = ?", escape_mysql_ident(col)?));
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
                where_parts.push(format!("{} = ${}", escape_pg_ident(col)?, i + 1));
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
                where_parts.push(format!("{} = ?", escape_pg_ident(col)?));
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
