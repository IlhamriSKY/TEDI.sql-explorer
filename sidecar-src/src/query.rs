//! Multi-statement query execution.
//!
//! `/query` accepts a free-form SQL script. We split it into individual
//! statements (honouring the engine's quoting + comments), enforce the
//! connection's `allow_writes` flag, and run them in order on one pinned
//! connection (see `session.rs`). The response holds one entry per statement
//! so the frontend can render each result tab independently.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::postgres::{PgDatabaseError, PgErrorPosition};
use sqlx::{Column, Row, TypeInfo};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::db::{Backend, BackendKind};
use crate::error::{AppError, AppResult};
use crate::session::{is_connection_error, PinnedConn, Session, SessionContext};
use crate::sqltext::{classify, is_read_only_safe, returns_rows, split_statements, StatementKind};
use crate::state::Connection;
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row, Cells};

/// Ceiling on the decoded rows one `/query` holds, on top of the row limit.
/// A row cap alone does not bound memory: 10,000 rows of wide text is
/// gigabytes. The result is marked truncated when this runs out first.
const RESULT_BYTE_BUDGET: usize = 32 * 1024 * 1024;
/// An editor session idle this long is closed; an open transaction on it is
/// rolled back, so a forgotten `BEGIN` cannot hold locks indefinitely.
const EDITOR_IDLE_CLOSE: Duration = Duration::from_secs(10 * 60);
/// An editor session idle this long gets its context re-applied before the
/// next run, which doubles as a liveness probe (servers drop idle sockets).
const EDITOR_PROBE_AFTER: Duration = Duration::from_secs(30);

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
    /// Active database context. MySQL: `USE <db>`. PostgreSQL: selects which
    /// per-database pool answers (PG binds one database per connection).
    #[serde(default)]
    pub database: Option<String>,
    /// Active schema context. PostgreSQL only: becomes `search_path`.
    #[serde(default)]
    pub schema: Option<String>,
    /// Run on the connection's long-lived editor session, so a transaction or
    /// `SET` survives into the next run. Off for one-off callers (AI tools).
    #[serde(default)]
    pub session: bool,
}

#[derive(Serialize)]
pub struct QueryResponse {
    pub statements: Vec<StatementResult>,
    pub request_id: String,
    /// True when at least one statement was cancelled / timed out.
    pub aborted: bool,
    /// Whether the editor session is inside a transaction after this run.
    pub in_transaction: bool,
    /// Something the user should know that is not one statement's result,
    /// e.g. a transaction that was rolled back because its connection died.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum StatementResult {
    Rows {
        sql: String,
        columns: Vec<ColumnHeader>,
        rows: Vec<Vec<Value>>,
        truncated: bool,
        /// The byte budget, not the row limit, cut this result short.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        truncated_by_size: bool,
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

/// Run one `/query` request on the right session and report the outcome.
/// `pid_slot` is where the server-side connection id is published for
/// `/cancel`.
pub async fn run_query(
    conn: &Arc<Connection>,
    req: &QueryRequest,
    cancel: CancellationToken,
    pid_slot: &RwLock<Option<i64>>,
) -> AppResult<(Vec<StatementResult>, bool, Option<String>)> {
    if split_statements(&req.sql, conn.kind).is_empty() {
        return Err(AppError::BadRequest("empty SQL".into()));
    }
    // Fall back to the connection's saved database, then to the one the pool
    // is attached to, so MySQL always has a `USE` to run and a pooled
    // connection cannot leak a previous batch's database into this one.
    let database = req
        .database
        .as_deref()
        .or(conn.default_database.as_deref())
        .or(conn.current_database.as_deref())
        .map(str::to_string);
    let ctx = SessionContext {
        database: database.clone(),
        schema: req.schema.clone(),
    };
    let backend = conn.backend_for(database.as_deref()).await?;
    let opts = BatchOptions {
        allow_writes: conn.config.allow_writes,
        row_limit: req.row_limit.unwrap_or(conn.config.row_limit),
        timeout: req
            .timeout_ms
            .map(Duration::from_millis)
            .unwrap_or(conn.config.query_timeout),
        cancel,
    };

    if !req.session {
        let mut session = Session::open(&backend, None, false).await?.with_pid().await;
        session.apply_context(&ctx, false).await?;
        *pid_slot.write().await = session.backend_pid;
        let (out, _) = execute_batch(&mut session, &backend, &req.sql, &opts).await;
        // Dropping a session left inside a transaction closes its connection,
        // which rolls the transaction back (see session.rs).
        let notice = session
            .in_transaction
            .then(|| "The batch left a transaction open, so it was rolled back. Add COMMIT to keep the changes.".to_string());
        return Ok((out, false, notice));
    }

    let pool_database = (conn.kind == BackendKind::Postgres)
        .then(|| database.clone())
        .flatten();
    let mut guard = conn
        .editor
        .try_lock()
        .map_err(|_| AppError::BadRequest("a query is still running in this editor".into()))?;
    // Taken only once the run goes ahead, so an early refusal keeps it.
    let mut notice: Option<String> = None;

    // PostgreSQL: a session belongs to one database.
    if guard
        .as_ref()
        .is_some_and(|s| s.pool_database != pool_database)
    {
        if guard.as_ref().is_some_and(|s| s.in_transaction) {
            return Err(AppError::BadRequest(
                "a transaction is open on another database. COMMIT or ROLLBACK it before switching"
                    .into(),
            ));
        }
        if let Some(old) = guard.take() {
            old.close().await;
        }
    }
    if let Some(session) = guard.as_mut() {
        let probe = session.last_used.elapsed() > EDITOR_PROBE_AFTER && !session.in_transaction;
        if let Err(e) = session.apply_context(&ctx, probe).await {
            if is_connection_error(&e) {
                if session.in_transaction {
                    notice = Some(LOST_TXN.into());
                }
                guard.take();
            } else if !session.in_transaction {
                return Err(e.into());
            }
            // Inside a failed PostgreSQL transaction every statement errors
            // until ROLLBACK, `SET` included; let the batch run so it can.
        }
    }
    if guard.is_none() {
        let mut session = Session::open(&backend, pool_database.clone(), true)
            .await?
            .with_pid()
            .await;
        session.apply_context(&ctx, false).await?;
        *guard = Some(session);
    }
    let session = guard.as_mut().expect("session opened above");
    *pid_slot.write().await = session.backend_pid;
    let was_in_transaction = session.in_transaction;
    let (mut out, mut broken) = execute_batch(session, &backend, &req.sql, &opts).await;
    session.last_used = Instant::now();
    if broken {
        guard.take();
        if was_in_transaction {
            notice = Some(LOST_TXN.into());
        } else if out.len() == 1 && first_statement_is_read(&req.sql, conn.kind) {
            // The connection died under the FIRST statement (the server
            // dropped an idle socket), and a read is safe to run again. A
            // write is not: the server may already have applied it.
            let mut fresh = Session::open(&backend, pool_database, true)
                .await?
                .with_pid()
                .await;
            fresh.apply_context(&ctx, false).await?;
            *pid_slot.write().await = fresh.backend_pid;
            (out, broken) = execute_batch(&mut fresh, &backend, &req.sql, &opts).await;
            fresh.last_used = Instant::now();
            if !broken {
                *guard = Some(fresh);
            }
        }
    }
    if notice.is_none() {
        notice = conn.take_notice();
    }
    let in_transaction = guard.as_ref().is_some_and(|s| s.in_transaction);
    drop(guard);
    schedule_idle_close(conn);
    Ok((out, in_transaction, notice))
}

fn first_statement_is_read(sql: &str, kind: BackendKind) -> bool {
    split_statements(sql, kind)
        .first()
        .is_some_and(|s| classify(s, kind) == StatementKind::Read)
}

const LOST_TXN: &str =
    "The connection was lost, so the open transaction was rolled back by the server.";

/// Close the editor session once it has sat idle for `EDITOR_IDLE_CLOSE`.
/// Each run bumps the epoch, so only the timer armed by the LAST run fires.
fn schedule_idle_close(conn: &Arc<Connection>) {
    let epoch = conn.editor_epoch.fetch_add(1, Ordering::Relaxed) + 1;
    let weak = Arc::downgrade(conn);
    tokio::spawn(async move {
        tokio::time::sleep(EDITOR_IDLE_CLOSE).await;
        let Some(conn) = weak.upgrade() else { return };
        if conn.editor_epoch.load(Ordering::Relaxed) != epoch {
            return;
        }
        let Ok(mut guard) = conn.editor.try_lock() else {
            return;
        };
        if let Some(session) = guard.take() {
            if session.in_transaction {
                conn.set_notice(format!(
                    "The open transaction was rolled back after {} minutes idle.",
                    EDITOR_IDLE_CLOSE.as_secs() / 60
                ));
            }
            session.close().await;
        }
    });
}

pub struct BatchOptions {
    pub allow_writes: bool,
    pub row_limit: u64,
    pub timeout: Duration,
    pub cancel: CancellationToken,
}

/// Run every statement of `sql` on `session`, in order. The second value is
/// true when the connection itself died, so the caller must drop the session.
pub async fn execute_batch(
    session: &mut Session,
    backend: &Backend,
    sql: &str,
    opts: &BatchOptions,
) -> (Vec<StatementResult>, bool) {
    let kind = session.kind;
    let statements = split_statements(sql, kind);
    let mut budget = RESULT_BYTE_BUDGET;
    let mut out = Vec::with_capacity(statements.len());
    for stmt in statements {
        if opts.cancel.is_cancelled() {
            out.push(error_result(stmt, "canceled".into(), 0));
            break;
        }
        if !opts.allow_writes && !is_read_only_safe(&stmt, kind) {
            out.push(error_result(
                stmt,
                "connection is read-only. Enable writes in the connection settings".into(),
                0,
            ));
            continue;
        }
        let is_read = returns_rows(&stmt, kind);
        let start = Instant::now();
        let result = tokio::select! {
            biased;
            _ = opts.cancel.cancelled() => Err(AppError::Canceled),
            r = tokio::time::timeout(
                opts.timeout,
                run_one(&mut session.conn, &stmt, is_read, opts.row_limit, &mut budget),
            ) => match r {
                Err(_) => Err(AppError::Timeout),
                Ok(Ok(sr)) => Ok(sr),
                Ok(Err(e)) => {
                    if is_connection_error(&e) {
                        out.push(error_result(stmt, describe_error(&e, ""), elapsed(start)));
                        return (out, true);
                    }
                    Err(AppError::Database(describe_error(&e, &stmt)))
                }
            },
        };
        let elapsed_ms = elapsed(start);
        match result {
            Ok(mut sr) => {
                session.observe(&stmt);
                stamp_elapsed(&mut sr, elapsed_ms);
                out.push(sr);
            }
            Err(AppError::Canceled) => {
                out.push(error_result(stmt, "canceled".into(), elapsed_ms));
                break;
            }
            Err(AppError::Timeout) => {
                // Dropping the future only stops US waiting: the server keeps
                // executing (holding its locks) and the pinned connection stays
                // stuck behind it, so every remaining statement would time out
                // too. Tell the server to abort.
                if let Some(pid) = session.backend_pid {
                    cancel_on_server(backend, pid).await;
                }
                let msg = format!("timed out after {} ms", opts.timeout.as_millis());
                out.push(error_result(stmt, msg, elapsed_ms));
            }
            Err(AppError::Database(msg)) => out.push(error_result(stmt, msg, elapsed_ms)),
            Err(e) => out.push(error_result(stmt, e.to_string(), elapsed_ms)),
        }
    }
    (out, false)
}

fn elapsed(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn error_result(sql: String, error: String, elapsed_ms: u64) -> StatementResult {
    StatementResult::Error {
        sql,
        error,
        elapsed_ms,
    }
}

/// The database's message, plus what PostgreSQL adds: where in the statement
/// it failed, and its DETAIL / HINT lines.
fn describe_error(e: &sqlx::Error, stmt: &str) -> String {
    let mut msg = e.to_string();
    let Some(pg) = e
        .as_database_error()
        .and_then(|d| d.try_downcast_ref::<PgDatabaseError>())
    else {
        return msg;
    };
    if let Some(PgErrorPosition::Original(pos)) = pg.position() {
        let (line, col) = line_col(stmt, pos);
        msg.push_str(&format!(" (line {line}, column {col})"));
    }
    if let Some(detail) = pg.detail() {
        msg.push_str(&format!("\nDETAIL: {detail}"));
    }
    if let Some(hint) = pg.hint() {
        msg.push_str(&format!("\nHINT: {hint}"));
    }
    msg
}

/// 1-based line and column of the 1-based character position `pos`.
fn line_col(text: &str, pos: usize) -> (usize, usize) {
    let mut line = 1;
    let mut col = 1;
    for c in text.chars().take(pos.saturating_sub(1)) {
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

/// Ask the server to abort whatever `backend_pid` is running. Dropping the
/// Rust future only closes our socket; without this the database keeps
/// grinding through the statement (and holding its locks) after "Stop".
/// Runs on a SEPARATE pool connection, since the busy one won't answer.
pub async fn cancel_on_server(backend: &Backend, backend_pid: i64) {
    let result = match backend {
        Backend::Mysql(pool) => sqlx::query(&format!("KILL QUERY {backend_pid}"))
            .execute(pool)
            .await
            .map(|_| ()),
        Backend::Postgres(pool) => sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(backend_pid as i32)
            .execute(pool)
            .await
            .map(|_| ()),
        // SQLite runs in-process; there is no server-side statement to kill.
        Backend::Sqlite(_) => Ok(()),
    };
    if let Err(e) = result {
        tracing::warn!("server-side cancel of {backend_pid} failed: {e}");
    }
}

fn stamp_elapsed(sr: &mut StatementResult, ms: u64) {
    match sr {
        StatementResult::Rows { elapsed_ms, .. }
        | StatementResult::Exec { elapsed_ms, .. }
        | StatementResult::Error { elapsed_ms, .. } => *elapsed_ms = ms,
    }
}

/// Rough serialized size of a decoded row, for the byte budget.
fn approx_size(v: &Value) -> usize {
    match v {
        Value::Null | Value::Bool(_) => 5,
        Value::Number(_) => 12,
        Value::String(s) => s.len() + 2,
        Value::Array(a) => 2 + a.iter().map(approx_size).sum::<usize>(),
        Value::Object(o) => {
            2 + o
                .iter()
                .map(|(k, v)| k.len() + 3 + approx_size(v))
                .sum::<usize>()
        }
    }
}

fn headers<C: Column>(cols: &[C]) -> Vec<ColumnHeader> {
    cols.iter()
        .map(|c| ColumnHeader {
            name: c.name().to_string(),
            data_type: c.type_info().name().to_string(),
        })
        .collect()
}

/// MySQL error 1295: the statement is not allowed through the prepared
/// protocol (some SHOW / CALL forms), so it has to go as plain text.
fn needs_text_protocol(e: &sqlx::Error) -> bool {
    e.as_database_error().and_then(|d| d.code()).as_deref() == Some("1295")
}

/// Drain a row stream into a `Rows` result, honouring the row and byte caps.
macro_rules! collect_rows {
    ($stream:expr, $limit:expr, $budget:expr, $decode:path) => {{
        use futures_util::StreamExt as _;
        let mut stream = $stream;
        let mut rows: Vec<Vec<Value>> = Vec::new();
        let mut columns = None;
        let mut truncated = false;
        let mut truncated_by_size = false;
        let mut failed = None;
        while let Some(row) = stream.next().await {
            let row = match row {
                Ok(row) => row,
                Err(e) => {
                    failed = Some(e);
                    break;
                }
            };
            if rows.len() as u64 >= $limit {
                truncated = true;
                break;
            }
            if *$budget == 0 {
                truncated = true;
                truncated_by_size = true;
                break;
            }
            if columns.is_none() {
                columns = Some(headers(row.columns()));
            }
            let decoded = $decode(&row, Cells::Display);
            *$budget = $budget.saturating_sub(decoded.iter().map(approx_size).sum());
            rows.push(decoded);
        }
        drop(stream);
        match failed {
            Some(e) => Err(e),
            None => Ok((rows, columns, truncated, truncated_by_size)),
        }
    }};
}

/// One statement on one executor. Reads stream at most `limit` rows (and at
/// most `budget` bytes), decoding as they arrive and dropping the stream the
/// moment either cap is hit, so the cap limits the transfer, not just the
/// display. The preflight `prepare` names the columns of a 0-row result; sqlx
/// caches the statement, so the fetch reuses it.
macro_rules! run_stmt {
    ($exec:expr, $sql:expr, $is_read:expr, $limit:expr, $budget:expr, $decode:path) => {{
        use sqlx::{Executor as _, Statement as _};
        if $is_read {
            let prepared = $exec.prepare($sql).await.ok().map(|s| headers(s.columns()));
            let mut got = collect_rows!(sqlx::query($sql).fetch(&mut *$exec), $limit, $budget, $decode);
            if matches!(&got, Err(e) if needs_text_protocol(e)) {
                got = collect_rows!(sqlx::raw_sql($sql).fetch(&mut *$exec), $limit, $budget, $decode);
            }
            let (rows, columns, truncated, truncated_by_size) = got?;
            Ok(StatementResult::Rows {
                sql: $sql.to_string(),
                columns: prepared.or(columns).unwrap_or_default(),
                rows,
                truncated,
                truncated_by_size,
                elapsed_ms: 0,
            })
        } else {
            // Text protocol: transaction control and many session statements
            // are refused by MySQL's prepared protocol, and a one-off UPDATE
            // gains nothing from a server-side prepared statement.
            let r = $exec.execute($sql).await?;
            Ok(StatementResult::Exec { sql: $sql.to_string(), rows_affected: r.rows_affected(), elapsed_ms: 0 })
        }
    }};
}

async fn run_one(
    conn: &mut PinnedConn,
    sql: &str,
    is_read: bool,
    limit: u64,
    budget: &mut usize,
) -> sqlx::Result<StatementResult> {
    match conn {
        PinnedConn::Mysql(c) => run_stmt!(&mut **c, sql, is_read, limit, budget, decode_mysql_row),
        PinnedConn::Postgres(c) => run_stmt!(&mut **c, sql, is_read, limit, budget, decode_pg_row),
        PinnedConn::Sqlite(c) => {
            run_stmt!(&mut **c, sql, is_read, limit, budget, decode_sqlite_row)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::line_col;

    #[test]
    fn maps_a_character_position_to_line_and_column() {
        assert_eq!(line_col("SELECT x", 8), (1, 8));
        assert_eq!(line_col("SELECT 1\nFROM nope", 15), (2, 6));
        // Positions count characters, not bytes.
        assert_eq!(line_col("SELECT 'é'\n, x", 14), (2, 3));
    }
}
