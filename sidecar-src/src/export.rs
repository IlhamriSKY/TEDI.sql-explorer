//! Export the result of a SELECT statement as CSV / JSON / INSERT SQL.
//!
//! The endpoint returns the formatted text inside a JSON envelope so the
//! frontend can hand the body to the standard TEDI save dialog. Stream-mode
//! exports for huge result sets are a follow-up.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::{Column, Row};

use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
use crate::state::ConnectionConfig;
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row};

/// Engine flavour for the SQL export format: drives identifier quoting and
/// the binary-literal syntax, which differ across MySQL / PostgreSQL / SQLite.
#[derive(Clone, Copy)]
enum SqlDialect {
    Mysql,
    Postgres,
    Sqlite,
}

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

pub async fn run_export(
    backend: &Backend,
    config: &ConnectionConfig,
    req: &ExportRequest,
) -> AppResult<ExportResponse> {
    // Raw-SQL exports run caller-supplied SQL verbatim; gate them on
    // allow_writes the same way /query does, so a read-only connection
    // can't be used to mutate data through the export path.
    if let Some(raw) = &req.sql {
        if !config.allow_writes && !crate::query::all_statements_read_only(raw) {
            return Err(AppError::BadRequest(
                "connection is read-only. Enable writes to export a non-read statement".into(),
            ));
        }
    }
    let sql = build_sql(req)?;
    // `format_output` re-escapes via `quote_ident`, so any table name is
    // safe to pass through. Fall back to `rows` only for raw-SQL exports
    // where the request didn't name a table at all.
    let table_for_sql = req.table.as_deref().unwrap_or("rows");
    // Identifier quoting + binary-literal syntax for the SQL export format
    // depend on the engine.
    let dialect = match backend {
        Backend::Mysql(_) => SqlDialect::Mysql,
        Backend::Postgres(_) => SqlDialect::Postgres,
        Backend::Sqlite(_) => SqlDialect::Sqlite,
    };

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
            Ok(format_output(req.format, &columns, &limited, table_for_sql, dialect))
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
            Ok(format_output(req.format, &columns, &limited, table_for_sql, dialect))
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
            Ok(format_output(req.format, &columns, &limited, table_for_sql, dialect))
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
    dialect: SqlDialect,
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
                s.push_str(&quote_ident(dialect, table));
                s.push_str(" (");
                for (i, col) in columns.iter().enumerate() {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push_str(&quote_ident(dialect, col));
                }
                s.push_str(") VALUES (");
                for (i, cell) in row.iter().enumerate() {
                    if i > 0 {
                        s.push_str(", ");
                    }
                    s.push_str(&sql_literal(dialect, cell));
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

fn quote_ident(dialect: SqlDialect, s: &str) -> String {
    match dialect {
        SqlDialect::Mysql => format!("`{}`", s.replace('`', "``")),
        // PostgreSQL and SQLite both use double-quoted identifiers.
        SqlDialect::Postgres | SqlDialect::Sqlite => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// Render a binary blob as an engine-appropriate SQL literal so the exported
/// INSERTs re-run against the source database.
fn binary_literal(dialect: SqlDialect, b64: &str) -> String {
    match dialect {
        SqlDialect::Mysql => format!("FROM_BASE64('{b64}')"),
        SqlDialect::Postgres => format!("decode('{b64}', 'base64')"),
        SqlDialect::Sqlite => match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => format!("X'{}'", hex::encode(bytes)),
            Err(_) => format!("'{b64}'"),
        },
    }
}

fn sql_literal(dialect: SqlDialect, v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => {
            if let Some(obj) = other.as_object() {
                if obj.get("__type").and_then(|t| t.as_str()) == Some("bytes") {
                    if let Some(b64) = obj.get("b64").and_then(|t| t.as_str()) {
                        return binary_literal(dialect, b64);
                    }
                }
            }
            format!("'{}'", other.to_string().replace('\'', "''"))
        }
    }
}
