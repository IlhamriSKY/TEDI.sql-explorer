//! Export the result of a SELECT statement as CSV / JSON / INSERT SQL.
//!
//! The endpoint returns the formatted text inside a JSON envelope so the
//! frontend can hand the body to the standard TEDI save dialog. Stream-mode
//! exports for huge result sets are a follow-up.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Column, Row};

use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row};

#[derive(Deserialize)]
pub struct ExportRequest {
    pub conn: String,
    /// Either a raw SQL string (`select_sql`) or a table reference. Exactly
    /// one of the two must be set.
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub table: Option<String>,
    pub format: ExportFormat,
    #[serde(default = "default_export_limit")]
    pub row_limit: u64,
}

fn default_export_limit() -> u64 {
    100_000
}

#[derive(Deserialize, Copy, Clone)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Json,
    Sql,
}

#[derive(Serialize)]
pub struct ExportResponse {
    pub content: String,
    pub mime: &'static str,
    pub extension: &'static str,
    pub rows: u64,
}

pub async fn run_export(backend: &Backend, req: &ExportRequest) -> AppResult<ExportResponse> {
    let sql = build_sql(req)?;
    // `format_output` re-escapes via `quote_ident`, so any table name is
    // safe to pass through. Fall back to `rows` only for raw-SQL exports
    // where the request didn't name a table at all.
    let table_for_sql = req.table.as_deref().unwrap_or("rows");

    match backend {
        Backend::Mysql(pool) => {
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let limited: Vec<Vec<Value>> = rows
                .iter()
                .take(req.row_limit as usize)
                .map(decode_mysql_row)
                .collect();
            Ok(format_output(req.format, &columns, &limited, table_for_sql))
        }
        Backend::Postgres(pool) => {
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let limited: Vec<Vec<Value>> = rows
                .iter()
                .take(req.row_limit as usize)
                .map(decode_pg_row)
                .collect();
            Ok(format_output(req.format, &columns, &limited, table_for_sql))
        }
        Backend::Sqlite(pool) => {
            let rows = sqlx::query(&sql).fetch_all(pool).await?;
            let columns = rows
                .first()
                .map(|r| {
                    r.columns()
                        .iter()
                        .map(|c| c.name().to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let limited: Vec<Vec<Value>> = rows
                .iter()
                .take(req.row_limit as usize)
                .map(decode_sqlite_row)
                .collect();
            Ok(format_output(req.format, &columns, &limited, table_for_sql))
        }
    }
}

fn build_sql(req: &ExportRequest) -> AppResult<String> {
    if let Some(sql) = &req.sql {
        return Ok(sql.clone());
    }
    let table = req
        .table
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("either `sql` or `table` required".into()))?;
    // Identifiers are escape-and-quoted instead of allow-listed so names
    // with hyphens / leading digits / non-ASCII still work. The presence of
    // `database` vs `schema` selects the backend quoting style (MySQL
    // backticks vs PG/SQLite double quotes).
    if let Some(db) = &req.database {
        return Ok(format!(
            "SELECT * FROM {}.{}",
            escape_mysql_ident(db)?,
            escape_mysql_ident(table)?
        ));
    }
    if let Some(sc) = &req.schema {
        return Ok(format!(
            "SELECT * FROM {}.{}",
            escape_pg_ident(sc)?,
            escape_pg_ident(table)?
        ));
    }
    Ok(format!("SELECT * FROM {}", escape_pg_ident(table)?))
}

fn format_output(
    fmt: ExportFormat,
    columns: &[String],
    rows: &[Vec<Value>],
    table: &str,
) -> ExportResponse {
    match fmt {
        ExportFormat::Csv => {
            let mut s = String::new();
            for (i, col) in columns.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push_str(&csv_escape(col));
            }
            s.push_str("\r\n");
            for row in rows {
                for (i, cell) in row.iter().enumerate() {
                    if i > 0 {
                        s.push(',');
                    }
                    s.push_str(&csv_escape(&render_cell(cell)));
                }
                s.push_str("\r\n");
            }
            ExportResponse {
                content: s,
                mime: "text/csv",
                extension: "csv",
                rows: rows.len() as u64,
            }
        }
        ExportFormat::Json => {
            let mut arr = Vec::with_capacity(rows.len());
            for row in rows {
                let mut obj = Map::new();
                for (col, cell) in columns.iter().zip(row.iter()) {
                    obj.insert(col.clone(), cell.clone());
                }
                arr.push(Value::Object(obj));
            }
            let s = serde_json::to_string_pretty(&Value::Array(arr))
                .unwrap_or_else(|_| "[]".into());
            ExportResponse {
                content: s,
                mime: "application/json",
                extension: "json",
                rows: rows.len() as u64,
            }
        }
        ExportFormat::Sql => {
            let mut s = String::new();
            for row in rows {
                s.push_str("INSERT INTO ");
                s.push_str(&quote_ident(table));
                s.push_str(" (");
                for (i, col) in columns.iter().enumerate() {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push_str(&quote_ident(col));
                }
                s.push_str(") VALUES (");
                for (i, cell) in row.iter().enumerate() {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push_str(&sql_literal(cell));
                }
                s.push_str(");\n");
            }
            ExportResponse {
                content: s,
                mime: "application/sql",
                extension: "sql",
                rows: rows.len() as u64,
            }
        }
    }
}

fn render_cell(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        other => {
            if let Some(obj) = other.as_object() {
                if obj.get("__type").and_then(|t| t.as_str()) == Some("bytes") {
                    return format!("<binary {} bytes>", obj.get("size").cloned().unwrap_or(Value::Null));
                }
            }
            other.to_string()
        }
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        let mut out = String::with_capacity(s.len() + 2);
        out.push('"');
        for ch in s.chars() {
            if ch == '"' {
                out.push('"');
            }
            out.push(ch);
        }
        out.push('"');
        out
    } else {
        s.to_string()
    }
}

fn quote_ident(s: &str) -> String {
    format!("`{}`", s.replace('`', "``"))
}

fn sql_literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => {
            if let Some(obj) = other.as_object() {
                if obj.get("__type").and_then(|t| t.as_str()) == Some("bytes") {
                    if let Some(b64) = obj.get("b64").and_then(|t| t.as_str()) {
                        return format!("FROM_BASE64('{b64}')");
                    }
                }
            }
            format!("'{}'", other.to_string().replace('\'', "''"))
        }
    }
}
