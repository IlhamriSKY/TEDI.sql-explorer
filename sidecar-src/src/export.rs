//! Export the result of a SELECT statement as CSV / JSON / INSERT SQL.
//!
//! Rows are formatted into the output as they stream in, so memory is the
//! output text alone (not every decoded row as well), and the text goes back
//! as the raw response body with the file details in headers, not escaped
//! again inside a JSON envelope.

use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Map, Value};
use sqlx::{Column, Row};

use crate::db::{Backend, BackendKind};
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
use crate::session::{PinnedConn, Session, SessionContext};
use crate::state::ConnectionConfig;
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row, Cells};

#[derive(Deserialize)]
pub struct ExportRequest {
    pub conn: String,
    /// Either raw SQL or a table reference. Exactly one of the two must be set.
    #[serde(default)]
    pub sql: Option<String>,
    /// For raw SQL, the context it runs in (as `/query`): MySQL `USE`s the
    /// database, PostgreSQL sets `search_path` to the schema.
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

impl ExportFormat {
    pub fn mime(self) -> &'static str {
        match self {
            ExportFormat::Csv => "text/csv",
            ExportFormat::Json => "application/json",
            ExportFormat::Sql => "application/sql",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Csv => "csv",
            ExportFormat::Json => "json",
            ExportFormat::Sql => "sql",
        }
    }
}

pub struct ExportOutput {
    pub content: String,
    pub rows: u64,
}

pub async fn run_export(
    backend: &Backend,
    config: &ConnectionConfig,
    req: &ExportRequest,
) -> AppResult<ExportOutput> {
    let kind = backend.kind();
    // Raw SQL runs verbatim; gate it like /query so a read-only connection
    // can't be used to mutate data through the export path.
    if let Some(raw) = &req.sql {
        if !config.allow_writes && !crate::sqltext::all_statements_read_only(raw, kind) {
            return Err(AppError::BadRequest(
                "connection is read-only. Enable writes to export a non-read statement".into(),
            ));
        }
    }
    let sql = build_sql(req, kind)?;
    let ctx = SessionContext {
        database: req.sql.as_ref().and(req.database.clone()),
        schema: req.sql.as_ref().and(req.schema.clone()),
    };
    let mut session = Session::open(backend, None, false).await?;
    session.apply_context(&ctx, false).await?;

    let mut out = Formatter::new(req.format, kind, req.table.as_deref().unwrap_or("rows"));
    macro_rules! stream_into {
        ($exec:expr, $decode:path) => {{
            use futures_util::StreamExt as _;
            let mut stream = sqlx::query(&sql).fetch(&mut **$exec);
            while let Some(row) = stream.next().await {
                let row = row?;
                if out.rows >= req.row_limit {
                    break;
                }
                if out.rows == 0 {
                    let cols: Vec<String> =
                        row.columns().iter().map(|c| c.name().to_string()).collect();
                    out.columns(cols);
                }
                out.row(&$decode(&row, Cells::Export));
            }
        }};
    }
    match &mut session.conn {
        PinnedConn::Mysql(c) => stream_into!(c, decode_mysql_row),
        PinnedConn::Postgres(c) => stream_into!(c, decode_pg_row),
        PinnedConn::Sqlite(c) => stream_into!(c, decode_sqlite_row),
    }
    let rows = out.rows;
    Ok(ExportOutput {
        content: out.finish(),
        rows,
    })
}

fn build_sql(req: &ExportRequest, kind: BackendKind) -> AppResult<String> {
    if let Some(sql) = &req.sql {
        return Ok(sql.clone());
    }
    let table = req
        .table
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("either `sql` or `table` required".into()))?;
    // Quoting follows the CONNECTION's engine, never which fields happen to be
    // set: the export dialog sends both database and schema for an open table.
    type Quoter = fn(&str) -> AppResult<String>;
    let (qualifier, quote): (Option<&str>, Quoter) = match kind {
        // A MySQL "database" IS its schema.
        BackendKind::Mysql => (req.database.as_deref(), escape_mysql_ident),
        // PostgreSQL qualifies with the schema; the database is already decided
        // by which pool runs this.
        BackendKind::Postgres => (req.schema.as_deref(), escape_pg_ident),
        BackendKind::Sqlite => (None, escape_pg_ident),
    };
    let table_sql = match qualifier.filter(|q| !q.is_empty()) {
        Some(q) => format!("{}.{}", quote(q)?, quote(table)?),
        None => quote(table)?,
    };
    Ok(format!("SELECT * FROM {table_sql}"))
}

/// Appends rows to the output text in one format.
struct Formatter {
    format: ExportFormat,
    kind: BackendKind,
    table: String,
    columns: Vec<String>,
    /// The `INSERT INTO t (cols) VALUES ` prefix, built once.
    insert_head: String,
    s: String,
    rows: u64,
}

impl Formatter {
    fn new(format: ExportFormat, kind: BackendKind, table: &str) -> Self {
        Self {
            format,
            kind,
            table: table.to_string(),
            columns: Vec::new(),
            insert_head: String::new(),
            s: String::new(),
            rows: 0,
        }
    }

    fn columns(&mut self, columns: Vec<String>) {
        match self.format {
            ExportFormat::Csv => {
                let head: Vec<String> = columns.iter().map(|c| csv_escape(c)).collect();
                self.s.push_str(&head.join(","));
                self.s.push_str("\r\n");
            }
            ExportFormat::Json => {}
            ExportFormat::Sql => {
                let cols: Vec<String> = columns.iter().map(|c| quote_ident(self.kind, c)).collect();
                self.insert_head = format!(
                    "INSERT INTO {} ({}) VALUES (",
                    quote_ident(self.kind, &self.table),
                    cols.join(", ")
                );
            }
        }
        self.columns = columns;
    }

    fn row(&mut self, row: &[Value]) {
        match self.format {
            ExportFormat::Csv => {
                let cells: Vec<String> = row.iter().map(|c| csv_escape(&render_cell(c))).collect();
                self.s.push_str(&cells.join(","));
                self.s.push_str("\r\n");
            }
            ExportFormat::Json => {
                let obj: Map<String, Value> = self
                    .columns
                    .iter()
                    .cloned()
                    .zip(row.iter().cloned())
                    .collect();
                self.s
                    .push_str(if self.rows == 0 { "[\n  " } else { ",\n  " });
                self.s
                    .push_str(&serde_json::to_string(&obj).unwrap_or_else(|_| "null".into()));
            }
            ExportFormat::Sql => {
                self.s.push_str(&self.insert_head);
                let vals: Vec<String> = row.iter().map(|c| sql_literal(self.kind, c)).collect();
                self.s.push_str(&vals.join(", "));
                self.s.push_str(");\n");
            }
        }
        self.rows += 1;
    }

    fn finish(mut self) -> String {
        if let ExportFormat::Json = self.format {
            self.s.push_str(if self.rows == 0 { "[]" } else { "\n]" });
        }
        self.s
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
                    return format!(
                        "<binary {} bytes>",
                        obj.get("size").cloned().unwrap_or(Value::Null)
                    );
                }
            }
            other.to_string()
        }
    }
}

fn csv_escape(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn quote_ident(kind: BackendKind, s: &str) -> String {
    match kind {
        BackendKind::Mysql => format!("`{}`", s.replace('`', "``")),
        // PostgreSQL and SQLite both use double-quoted identifiers.
        BackendKind::Postgres | BackendKind::Sqlite => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

/// Render a binary blob as an engine-appropriate SQL literal so the exported
/// INSERTs re-run against the source database.
fn binary_literal(kind: BackendKind, b64: &str) -> String {
    match kind {
        BackendKind::Mysql => format!("FROM_BASE64('{b64}')"),
        BackendKind::Postgres => format!("decode('{b64}', 'base64')"),
        BackendKind::Sqlite => match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => format!("X'{}'", hex::encode(bytes)),
            Err(_) => format!("'{b64}'"),
        },
    }
}

fn sql_literal(kind: BackendKind, v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if *b {
                "TRUE".into()
            } else {
                "FALSE".into()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => {
            if let Some(obj) = other.as_object() {
                if obj.get("__type").and_then(|t| t.as_str()) == Some("bytes") {
                    if let Some(b64) = obj.get("b64").and_then(|t| t.as_str()) {
                        return binary_literal(kind, b64);
                    }
                }
            }
            format!("'{}'", other.to_string().replace('\'', "''"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn render(format: ExportFormat, kind: BackendKind) -> String {
        let mut f = Formatter::new(format, kind, "t");
        f.columns(vec!["id".into(), "note".into()]);
        f.row(&[json!(1), json!("a,\"b\"")]);
        f.row(&[json!(2), Value::Null]);
        f.finish()
    }

    #[test]
    fn formats_each_output_as_rows_stream_in() {
        assert_eq!(
            render(ExportFormat::Csv, BackendKind::Mysql),
            "id,note\r\n1,\"a,\"\"b\"\"\"\r\n2,\r\n"
        );
        let json: Value =
            serde_json::from_str(&render(ExportFormat::Json, BackendKind::Mysql)).unwrap();
        assert_eq!(
            json,
            json!([{ "id": 1, "note": "a,\"b\"" }, { "id": 2, "note": null }])
        );
        assert_eq!(
            render(ExportFormat::Sql, BackendKind::Postgres),
            "INSERT INTO \"t\" (\"id\", \"note\") VALUES (1, 'a,\"b\"');\nINSERT INTO \"t\" (\"id\", \"note\") VALUES (2, NULL);\n"
        );
        // An empty result is still valid JSON.
        assert_eq!(
            Formatter::new(ExportFormat::Json, BackendKind::Mysql, "t").finish(),
            "[]"
        );
    }
}
