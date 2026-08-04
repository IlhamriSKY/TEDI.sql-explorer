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
use sqlx::{Column, Row, TypeInfo};
use tokio_util::sync::CancellationToken;

use crate::db::Backend;
use crate::sqltext::{StatementKind, classify, is_read_only_safe, split_statements};
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
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
    /// Active database context. MySQL: pins the session with `USE <db>` so
    /// unqualified table names resolve. PostgreSQL: selects which per-database
    /// pool answers (PG binds one database per connection). SQLite: ignored.
    #[serde(default)]
    pub database: Option<String>,
    /// Active schema context. PostgreSQL only: becomes the session
    /// `search_path`, which is what actually resolves an unqualified table
    /// name there — the DATABASE name never does.
    #[serde(default)]
    pub schema: Option<String>,
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

/// Everything a batch needs beyond the connection itself.
pub struct ExecuteOptions<'a> {
    pub row_limit: u64,
    pub timeout: Duration,
    pub cancel: CancellationToken,
    /// MySQL: the database to `USE`. PostgreSQL: informational (which pool
    /// answers is already decided by the caller).
    pub database: Option<&'a str>,
    /// PostgreSQL: the schema that becomes `search_path`.
    pub schema: Option<&'a str>,
    /// Filled in with the server-side connection id once the batch is pinned,
    /// so `/cancel` can stop the statement in the database.
    pub backend_pid: Option<&'a std::sync::Arc<tokio::sync::RwLock<Option<i64>>>>,
}

pub async fn execute(
    backend: &Backend,
    config: &ConnectionConfig,
    sql: &str,
    opts: ExecuteOptions<'_>,
) -> AppResult<Vec<StatementResult>> {
    let ExecuteOptions { row_limit, timeout, cancel, database, schema, backend_pid } = opts;
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Err(AppError::BadRequest("empty SQL".into()));
    }

    // Acquire ONE connection and pin it for the whole batch. Two things need
    // this, not just the database context:
    //   - session state (`USE <db>` / `SET search_path`) must survive across
    //     statements;
    //   - so must a transaction. `BEGIN; UPDATE …; COMMIT;` run through
    //     `pool.execute()` can land on three different physical connections,
    //     which leaves the UPDATE in an open transaction on a connection
    //     nobody commits. Pinning unconditionally is what makes explicit
    //     transactions in the query editor behave.
    // MySQL `USE` (and some `SET` / `SHOW` variants) are not supported by
    // the prepared-statement protocol and return error 1295. Send these
    // session-control statements via the text protocol by calling
    // `Executor::execute(&str)` directly, which sqlx routes through the
    // simple-query path (no `COM_STMT_PREPARE`).
    use sqlx::Executor as _;
    let mut pinned: Option<PinnedConn> = match backend {
        Backend::Mysql(pool) => {
            let mut conn = pool.acquire().await?;
            // Same session-state caveat as the Postgres arm below: the pooled
            // connection keeps whatever database a previous batch selected.
            // MySQL has no "select no database", so the caller passes the
            // connection's own current database as the fallback (see
            // `handle_query`), which makes this `USE` run on every batch.
            if let Some(db) = database.filter(|d| !d.is_empty()) {
                let use_sql = format!("USE {}", escape_mysql_ident(db)?);
                (&mut *conn).execute(use_sql.as_str()).await?;
            }
            Some(PinnedConn::Mysql(conn))
        }
        Backend::Postgres(pool) => {
            let mut conn = pool.acquire().await?;
            // PostgreSQL resolves unqualified names through `search_path`,
            // which holds SCHEMAS. Feeding it the database name (as this used
            // to) sets a search_path that matches nothing, so every
            // unqualified `SELECT * FROM users` failed. `public` stays on the
            // path so extensions and shared types keep resolving.
            //
            // The `else` arm is not optional: `SET` is session state, and the
            // connection goes back to the pool carrying it. Without an
            // explicit reset, a later batch that names no schema silently
            // inherits the previous batch's search_path and resolves
            // unqualified names in a schema the caller never asked for.
            let set_sql = match schema.filter(|s| !s.is_empty()) {
                Some(sc) => format!("SET search_path TO {}, public", escape_pg_ident(sc)?),
                None => "SET search_path TO DEFAULT".to_string(),
            };
            (&mut *conn).execute(set_sql.as_str()).await?;
            Some(PinnedConn::Postgres(conn))
        }
        Backend::Sqlite(_) => None,
    };

    // Publish the server-side connection id so `/cancel` can stop the query
    // in the database, not just drop our end of the socket.
    if let Some(slot) = backend_pid {
        if let Some(pid) = pinned_backend_pid(pinned.as_mut()).await {
            *slot.write().await = Some(pid);
        }
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
        if !config.allow_writes && !is_read_only_safe(&stmt, kind) {
            out.push(StatementResult::Error {
                sql: stmt,
                error: "connection is read-only. Enable writes in the connection settings".into(),
                elapsed_ms: 0,
            });
            continue;
        }
        let start = Instant::now();
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(AppError::Canceled),
            r = tokio::time::timeout(
                timeout,
                run_one(backend, pinned.as_mut(), &stmt, kind, row_limit),
            ) => {
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
            Err(AppError::Timeout) => {
                // Dropping the future only stops US waiting. The server keeps
                // executing the statement (holding its locks), and the pinned
                // connection stays stuck behind it — so every REMAINING
                // statement in the batch timed out too, in a cascade. Tell the
                // server to abort, which also frees the connection to carry on
                // with the rest of the batch.
                if let Some(pid) = read_backend_pid(backend_pid).await {
                    cancel_on_server(backend, pid).await;
                }
                out.push(StatementResult::Error {
                    sql: stmt,
                    error: format!("timed out after {} ms", timeout.as_millis()),
                    elapsed_ms: elapsed,
                });
            }
            Err(e) => out.push(StatementResult::Error {
                sql: stmt,
                error: e.to_string(),
                elapsed_ms: elapsed,
            }),
        }
    }
    Ok(out)
}

/// Holds the pool-acquired connection pinned for the batch, so session state
/// and open transactions survive across its statements. Dropped at the end of
/// `execute()` to return the connection to the pool. SQLite is single-writer
/// and has no session/database concept, so it never pins.
enum PinnedConn {
    Mysql(sqlx::pool::PoolConnection<sqlx::MySql>),
    Postgres(sqlx::pool::PoolConnection<sqlx::Postgres>),
}

/// The database server's own id for the pinned connection (`CONNECTION_ID()`
/// on MySQL, `pg_backend_pid()` on PostgreSQL). Best-effort: a failure just
/// means `/cancel` falls back to abandoning the request locally.
async fn pinned_backend_pid(pinned: Option<&mut PinnedConn>) -> Option<i64> {
    use sqlx::Row as _;
    match pinned? {
        PinnedConn::Mysql(conn) => sqlx::query("SELECT CONNECTION_ID() AS id")
            .fetch_one(&mut **conn)
            .await
            .ok()
            .and_then(|r| {
                r.try_get::<u64, _>("id")
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>("id"))
                    .ok()
            }),
        PinnedConn::Postgres(conn) => sqlx::query("SELECT pg_backend_pid() AS id")
            .fetch_one(&mut **conn)
            .await
            .ok()
            .and_then(|r| r.try_get::<i32, _>("id").map(i64::from).ok()),
    }
}

/// The server-side connection id published by `execute`, if it got one.
async fn read_backend_pid(
    slot: Option<&std::sync::Arc<tokio::sync::RwLock<Option<i64>>>>,
) -> Option<i64> {
    match slot {
        Some(s) => *s.read().await,
        None => None,
    }
}

/// Ask the server to abort whatever `backend_pid` is running. Dropping the
/// Rust future only closes our socket; without this the database keeps
/// grinding through the statement (and holding its locks) after "Stop".
/// Runs on a SEPARATE pool connection — the busy one won't answer.
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

fn stamp_elapsed(sr: &mut StatementResult, elapsed_ms: u64) {
    match sr {
        StatementResult::Rows { elapsed_ms: e, .. } => *e = elapsed_ms,
        StatementResult::Exec { elapsed_ms: e, .. } => *e = elapsed_ms,
        StatementResult::Error { elapsed_ms: e, .. } => *e = elapsed_ms,
    }
}

/// Headers from a preflight `prepare`, so a 0-row result still names its
/// columns. sqlx caches the prepared statement, so the fetch that follows
/// reuses it instead of paying a second round-trip.
macro_rules! prepared_headers {
    ($exec:expr, $sql:expr) => {{
        use sqlx::{Executor as _, Statement as _};
        $exec.prepare($sql).await.ok().map(|s| {
            s.columns()
                .iter()
                .map(|c| ColumnHeader {
                    name: c.name().to_string(),
                    data_type: c.type_info().name().to_string(),
                })
                .collect::<Vec<_>>()
        })
    }};
}

/// Read at most `limit` rows, decoding as we go and stopping the moment the
/// cap is hit.
///
/// This used to be `fetch_all(..).take(limit)`, which pulls the WHOLE result
/// set over the wire and into memory before throwing most of it away — a
/// `SELECT * FROM` a large table would balloon the helper's RSS (or kill it)
/// no matter how low the row cap was set. Streaming means the cap actually
/// caps. Reading one row past `limit` is what tells us the result was
/// truncated; dropping the stream there stops the transfer.
macro_rules! fetch_capped {
    ($exec:expr, $sql:expr, $limit:expr, $decode:path) => {{
        use futures_util::StreamExt as _;
        let mut stream = sqlx::query($sql).fetch($exec);
        let mut decoded: Vec<Vec<Value>> = Vec::new();
        let mut fallback_headers: Option<Vec<ColumnHeader>> = None;
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row?;
            if decoded.len() as u64 >= $limit {
                truncated = true;
                break;
            }
            if fallback_headers.is_none() {
                fallback_headers = Some(
                    row.columns()
                        .iter()
                        .map(|c| ColumnHeader {
                            name: c.name().to_string(),
                            data_type: c.type_info().name().to_string(),
                        })
                        .collect(),
                );
            }
            decoded.push($decode(&row));
        }
        drop(stream);
        (decoded, fallback_headers, truncated)
    }};
}

/// One `(exec, decode)` pair's read + exec arms. The five call sites below
/// differ only in which executor they hand over and how a row decodes.
macro_rules! run_stmt {
    ($exec:expr, $sql:expr, $is_read:expr, $limit:expr, $decode:path) => {{
        if $is_read {
            let headers = prepared_headers!($exec, $sql);
            let (rows, fallback, truncated) = fetch_capped!($exec, $sql, $limit, $decode);
            Ok(StatementResult::Rows {
                sql: $sql.to_string(),
                columns: headers.or(fallback).unwrap_or_default(),
                rows,
                truncated,
                elapsed_ms: 0,
            })
        } else {
            use sqlx::Executor as _;
            let r = $exec.execute(sqlx::query($sql)).await?;
            Ok(StatementResult::Exec {
                sql: $sql.to_string(),
                rows_affected: r.rows_affected(),
                elapsed_ms: 0,
            })
        }
    }};
}

async fn run_one(
    backend: &Backend,
    pinned: Option<&mut PinnedConn>,
    sql: &str,
    kind: StatementKind,
    row_limit: u64,
) -> AppResult<StatementResult> {
    let is_read = matches!(kind, StatementKind::Read | StatementKind::Unknown);
    match (backend, pinned) {
        (_, Some(PinnedConn::Mysql(conn))) => {
            run_stmt!(&mut **conn, sql, is_read, row_limit, decode_mysql_row)
        }
        (_, Some(PinnedConn::Postgres(conn))) => {
            run_stmt!(&mut **conn, sql, is_read, row_limit, decode_pg_row)
        }
        (Backend::Mysql(pool), _) => run_stmt!(pool, sql, is_read, row_limit, decode_mysql_row),
        (Backend::Postgres(pool), _) => run_stmt!(pool, sql, is_read, row_limit, decode_pg_row),
        (Backend::Sqlite(pool), _) => run_stmt!(pool, sql, is_read, row_limit, decode_sqlite_row),
    }
}
