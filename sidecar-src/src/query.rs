//! Multi-statement query execution.
//!
//! `/query` accepts a free-form SQL script. We split it into individual
//! statements (honouring quoting + comment state), classify each as
//! read / write / ddl, enforce the connection's `allow_writes` flag, and
//! run them in order. The response contains one entry per statement so the
//! frontend can render each result tab independently.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Column, Executor, Row, TypeInfo};
use tokio_util::sync::CancellationToken;

use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::state::ConnectionConfig;
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row};

#[derive(Deserialize)]
pub struct QueryRequest {
    pub conn: String,
    pub sql: String,
    /// Optional override; otherwise the connection's default row_limit kicks in.
    #[serde(default)]
    pub row_limit: Option<u64>,
    /// Optional override; otherwise the connection's default timeout kicks in.
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// Caller-supplied request id. The frontend can call `/cancel` with this
    /// id to abort an in-flight query.
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Serialize)]
pub struct QueryResponse {
    pub statements: Vec<StatementResult>,
    pub request_id: String,
    /// True when at least one statement was cancelled / timed out.
    pub aborted: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StatementResult {
    Rows {
        sql: String,
        columns: Vec<ColumnHeader>,
        rows: Vec<Vec<Value>>,
        truncated: bool,
        elapsed_ms: u64,
    },
    Exec {
        sql: String,
        rows_affected: u64,
        elapsed_ms: u64,
    },
    Error {
        sql: String,
        error: String,
        elapsed_ms: u64,
    },
}

#[derive(Serialize)]
pub struct ColumnHeader {
    pub name: String,
    pub data_type: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Read,
    Write,
    Ddl,
    Unknown,
}

/// Naive statement splitter — respects single / double / backtick quotes,
/// `--` line comments, and `/* ... */` block comments. Good enough for
/// "user-typed query editor" semantics; not a full SQL parser.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = sql.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            cur.push(ch);
            if ch == '\n' {
                in_line_comment = false;
            }
            continue;
        }
        if in_block_comment {
            cur.push(ch);
            if ch == '*' && chars.peek() == Some(&'/') {
                cur.push(chars.next().unwrap());
                in_block_comment = false;
            }
            continue;
        }
        if in_single {
            cur.push(ch);
            if ch == '\\' {
                if let Some(&n) = chars.peek() {
                    cur.push(n);
                    chars.next();
                }
                continue;
            }
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            cur.push(ch);
            if ch == '\\' {
                if let Some(&n) = chars.peek() {
                    cur.push(n);
                    chars.next();
                }
                continue;
            }
            if ch == '"' {
                in_double = false;
            }
            continue;
        }
        if in_backtick {
            cur.push(ch);
            if ch == '`' {
                in_backtick = false;
            }
            continue;
        }
        match ch {
            '\'' => {
                in_single = true;
                cur.push(ch);
            }
            '"' => {
                in_double = true;
                cur.push(ch);
            }
            '`' => {
                in_backtick = true;
                cur.push(ch);
            }
            '-' if chars.peek() == Some(&'-') => {
                cur.push(ch);
                cur.push(chars.next().unwrap());
                in_line_comment = true;
            }
            '/' if chars.peek() == Some(&'*') => {
                cur.push(ch);
                cur.push(chars.next().unwrap());
                in_block_comment = true;
            }
            ';' => {
                let trimmed = cur.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let trimmed = cur.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    out
}

/// Classify a single statement based on its first significant keyword.
pub fn classify(sql: &str) -> StatementKind {
    let cleaned = strip_leading_comments(sql);
    let mut first = String::new();
    for ch in cleaned.chars() {
        if ch.is_alphabetic() {
            first.push(ch.to_ascii_uppercase());
        } else if first.is_empty() {
            continue;
        } else {
            break;
        }
    }
    match first.as_str() {
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES" => {
            StatementKind::Read
        }
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" | "UPSERT" | "CALL" => {
            StatementKind::Write
        }
        "CREATE" | "DROP" | "ALTER" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT" | "VACUUM" | "REINDEX" | "ANALYZE" => StatementKind::Ddl,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "SET" | "USE" => {
            // Transaction control + session SETs don't violate `allow_writes`.
            StatementKind::Read
        }
        _ => StatementKind::Unknown,
    }
}

fn strip_leading_comments(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'-' if i + 1 < bytes.len() && bytes[i + 1] == b'-' => {
                // line comment until newline
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => break,
        }
    }
    std::str::from_utf8(&bytes[i.min(bytes.len())..]).unwrap_or("")
}

pub async fn execute(
    backend: &Backend,
    config: &ConnectionConfig,
    sql: &str,
    row_limit: u64,
    timeout: Duration,
    cancel: CancellationToken,
) -> AppResult<Vec<StatementResult>> {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Err(AppError::BadRequest("empty SQL".into()));
    }

    let mut out = Vec::with_capacity(statements.len());
    for stmt in statements {
        if cancel.is_cancelled() {
            out.push(StatementResult::Error {
                sql: stmt,
                error: "canceled".into(),
                elapsed_ms: 0,
            });
            break;
        }
        let kind = classify(&stmt);
        if !config.allow_writes
            && matches!(kind, StatementKind::Write | StatementKind::Ddl)
        {
            out.push(StatementResult::Error {
                sql: stmt,
                error: "connection is read-only — enable writes in the connection settings".into(),
                elapsed_ms: 0,
            });
            continue;
        }
        let start = Instant::now();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(AppError::Canceled),
            r = tokio::time::timeout(timeout, run_one(backend, &stmt, kind, row_limit)) => {
                match r {
                    Err(_) => Err(AppError::Timeout),
                    Ok(inner) => inner,
                }
            }
        };
        let elapsed = start.elapsed().as_millis() as u64;
        match result {
            Ok(mut sr) => {
                stamp_elapsed(&mut sr, elapsed);
                out.push(sr);
            }
            Err(AppError::Canceled) => {
                out.push(StatementResult::Error {
                    sql: stmt,
                    error: "canceled".into(),
                    elapsed_ms: elapsed,
                });
                break;
            }
            Err(AppError::Timeout) => out.push(StatementResult::Error {
                sql: stmt,
                error: format!("timed out after {} ms", timeout.as_millis()),
                elapsed_ms: elapsed,
            }),
            Err(e) => out.push(StatementResult::Error {
                sql: stmt,
                error: e.to_string(),
                elapsed_ms: elapsed,
            }),
        }
    }
    Ok(out)
}

fn stamp_elapsed(sr: &mut StatementResult, elapsed_ms: u64) {
    match sr {
        StatementResult::Rows { elapsed_ms: e, .. } => *e = elapsed_ms,
        StatementResult::Exec { elapsed_ms: e, .. } => *e = elapsed_ms,
        StatementResult::Error { elapsed_ms: e, .. } => *e = elapsed_ms,
    }
}

async fn run_one(
    backend: &Backend,
    sql: &str,
    kind: StatementKind,
    row_limit: u64,
) -> AppResult<StatementResult> {
    let is_read = matches!(kind, StatementKind::Read | StatementKind::Unknown);
    match backend {
        Backend::Mysql(pool) => {
            if is_read {
                let rows = sqlx::query(sql).fetch_all(pool).await?;
                let (columns, decoded, truncated) = collect_mysql_rows(rows, row_limit);
                Ok(StatementResult::Rows {
                    sql: sql.to_string(),
                    columns,
                    rows: decoded,
                    truncated,
                    elapsed_ms: 0,
                })
            } else {
                let r = pool.execute(sqlx::query(sql)).await?;
                Ok(StatementResult::Exec {
                    sql: sql.to_string(),
                    rows_affected: r.rows_affected(),
                    elapsed_ms: 0,
                })
            }
        }
        Backend::Postgres(pool) => {
            if is_read {
                let rows = sqlx::query(sql).fetch_all(pool).await?;
                let (columns, decoded, truncated) = collect_pg_rows(rows, row_limit);
                Ok(StatementResult::Rows {
                    sql: sql.to_string(),
                    columns,
                    rows: decoded,
                    truncated,
                    elapsed_ms: 0,
                })
            } else {
                let r = pool.execute(sqlx::query(sql)).await?;
                Ok(StatementResult::Exec {
                    sql: sql.to_string(),
                    rows_affected: r.rows_affected(),
                    elapsed_ms: 0,
                })
            }
        }
        Backend::Sqlite(pool) => {
            if is_read {
                let rows = sqlx::query(sql).fetch_all(pool).await?;
                let (columns, decoded, truncated) = collect_sqlite_rows(rows, row_limit);
                Ok(StatementResult::Rows {
                    sql: sql.to_string(),
                    columns,
                    rows: decoded,
                    truncated,
                    elapsed_ms: 0,
                })
            } else {
                let r = pool.execute(sqlx::query(sql)).await?;
                Ok(StatementResult::Exec {
                    sql: sql.to_string(),
                    rows_affected: r.rows_affected(),
                    elapsed_ms: 0,
                })
            }
        }
    }
}

fn collect_mysql_rows(
    rows: Vec<sqlx::mysql::MySqlRow>,
    limit: u64,
) -> (Vec<ColumnHeader>, Vec<Vec<Value>>, bool) {
    let columns = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnHeader {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let truncated = rows.len() as u64 > limit;
    let decoded: Vec<Vec<Value>> = rows
        .into_iter()
        .take(limit as usize)
        .map(|r| decode_mysql_row(&r))
        .collect();
    (columns, decoded, truncated)
}

fn collect_pg_rows(
    rows: Vec<sqlx::postgres::PgRow>,
    limit: u64,
) -> (Vec<ColumnHeader>, Vec<Vec<Value>>, bool) {
    let columns = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnHeader {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let truncated = rows.len() as u64 > limit;
    let decoded: Vec<Vec<Value>> = rows
        .into_iter()
        .take(limit as usize)
        .map(|r| decode_pg_row(&r))
        .collect();
    (columns, decoded, truncated)
}

fn collect_sqlite_rows(
    rows: Vec<sqlx::sqlite::SqliteRow>,
    limit: u64,
) -> (Vec<ColumnHeader>, Vec<Vec<Value>>, bool) {
    let columns = rows
        .first()
        .map(|r| {
            r.columns()
                .iter()
                .map(|c| ColumnHeader {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let truncated = rows.len() as u64 > limit;
    let decoded: Vec<Vec<Value>> = rows
        .into_iter()
        .take(limit as usize)
        .map(|r| decode_sqlite_row(&r))
        .collect();
    (columns, decoded, truncated)
}
