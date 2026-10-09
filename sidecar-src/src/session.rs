//! One pinned database connection plus the session state riding on it.
//!
//! Every batch runs on a pinned connection, because `USE` / `SET search_path`
//! and an open transaction are properties of ONE physical connection: run
//! `BEGIN; UPDATE ...; COMMIT;` through the pool and the three statements can
//! land on three connections.
//!
//! Two lifetimes use it:
//! - a one-off batch (AI tools, anything not from the editor) pins a pool
//!   connection for that batch only;
//! - the query editor keeps ONE session per connection across runs (stored on
//!   `Connection::editor`), so `BEGIN` in one run and `COMMIT` in the next
//!   behave like every other SQL client, `SET` sticks, and the context
//!   (`USE`, `search_path`) and server pid are paid for once instead of on
//!   every run.
//!
//! A connection that may carry an open transaction or a user's `SET` is marked
//! `close_on_drop`. sqlx would otherwise hand it back to the pool as-is (it
//! only tracks transactions it started itself), and the next table browse
//! would read inside someone's uncommitted transaction.

use std::time::Instant;

use sqlx::pool::PoolConnection;
use sqlx::{Executor as _, Row as _};

use crate::db::{Backend, BackendKind};
use crate::schema::{escape_mysql_ident, escape_pg_ident};
use crate::sqltext::{changes_session_context, classify, txn_effect, StatementKind, TxnEffect};

pub enum PinnedConn {
    Mysql(PoolConnection<sqlx::MySql>),
    Postgres(PoolConnection<sqlx::Postgres>),
    Sqlite(PoolConnection<sqlx::Sqlite>),
}

impl PinnedConn {
    fn close_on_drop(&mut self) {
        match self {
            PinnedConn::Mysql(c) => c.close_on_drop(),
            PinnedConn::Postgres(c) => c.close_on_drop(),
            PinnedConn::Sqlite(c) => c.close_on_drop(),
        }
    }
}

/// The context a batch asks for: MySQL `USE`s the database, PostgreSQL puts
/// the schema on `search_path`. SQLite has neither.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct SessionContext {
    pub database: Option<String>,
    pub schema: Option<String>,
}

pub struct Session {
    pub conn: PinnedConn,
    pub kind: BackendKind,
    /// PostgreSQL binds one database per connection, so a session belongs to
    /// the database its pool was opened for.
    pub pool_database: Option<String>,
    /// Server-side connection id, for `KILL QUERY` / `pg_cancel_backend`.
    pub backend_pid: Option<i64>,
    /// Best-effort, from the statement text (see `sqltext::txn_effect`).
    pub in_transaction: bool,
    /// True once a statement changed session state we do not track (any
    /// `SET` / `USE`).
    pub dirty: bool,
    applied: Option<SessionContext>,
    pub last_used: Instant,
}

impl Session {
    /// `sticky` is the editor's long-lived session: it never goes back to the
    /// pool. A one-off session returns to the pool when dropped, unless a
    /// statement left a transaction or untracked session state on it.
    pub async fn open(
        backend: &Backend,
        pool_database: Option<String>,
        sticky: bool,
    ) -> sqlx::Result<Self> {
        let mut conn = match backend {
            Backend::Mysql(p) => PinnedConn::Mysql(p.acquire().await?),
            Backend::Postgres(p) => PinnedConn::Postgres(p.acquire().await?),
            Backend::Sqlite(p) => PinnedConn::Sqlite(p.acquire().await?),
        };
        if sticky {
            conn.close_on_drop();
        }
        Ok(Self {
            conn,
            kind: backend.kind(),
            pool_database,
            backend_pid: None,
            in_transaction: false,
            dirty: false,
            applied: None,
            last_used: Instant::now(),
        })
    }

    /// Look up the server's id for this connection, which `/cancel` and the
    /// timeout path need. A separate step so an export (never cancelled that
    /// way) does not pay the round trip.
    pub async fn with_pid(mut self) -> Self {
        self.backend_pid = server_pid(&mut self.conn).await;
        self
    }

    /// Make the session resolve unqualified names against `ctx`. Skipped when
    /// that context is already in place, unless `force` (used as a liveness
    /// probe on a session that sat idle).
    pub async fn apply_context(&mut self, ctx: &SessionContext, force: bool) -> sqlx::Result<()> {
        if !force && self.applied.as_ref() == Some(ctx) {
            return Ok(());
        }
        match &mut self.conn {
            PinnedConn::Mysql(c) => {
                // MySQL has no "select no database", so callers fall back to
                // the connection's own database and this always has a target.
                // `USE` is not allowed through the prepared protocol (error
                // 1295); a `&str` runs through the text protocol.
                if let Some(db) = ctx.database.as_deref().filter(|d| !d.is_empty()) {
                    let sql = format!("USE {}", escape_ident(escape_mysql_ident, db)?);
                    (&mut **c).execute(sql.as_str()).await?;
                }
            }
            PinnedConn::Postgres(c) => {
                // `search_path` holds SCHEMAS, never the database name. The
                // DEFAULT arm matters: without it a run naming no schema would
                // inherit the previous run's path.
                let sql = match ctx.schema.as_deref().filter(|s| !s.is_empty()) {
                    Some(s) => format!(
                        "SET search_path TO {}, public",
                        escape_ident(escape_pg_ident, s)?
                    ),
                    None => "SET search_path TO DEFAULT".to_string(),
                };
                (&mut **c).execute(sql.as_str()).await?;
            }
            PinnedConn::Sqlite(c) => {
                if force {
                    (&mut **c).execute("SELECT 1").await?;
                }
            }
        }
        self.applied = Some(ctx.clone());
        Ok(())
    }

    /// Record what a statement that SUCCEEDED did to the session.
    pub fn observe(&mut self, sql: &str) {
        match txn_effect(sql, self.kind) {
            Some(TxnEffect::Begin) => self.in_transaction = true,
            Some(TxnEffect::End) => self.in_transaction = false,
            None => {}
        }
        // DDL can drop the database or schema the context points at.
        if changes_session_context(sql, self.kind) || classify(sql, self.kind) == StatementKind::Ddl
        {
            self.applied = None;
        }
        if changes_session_context(sql, self.kind) {
            self.applied = None;
            self.dirty = true;
        }
        if self.in_transaction || self.dirty {
            self.conn.close_on_drop();
        }
    }

    /// Close the connection (the server rolls back anything left open).
    pub async fn close(self) {
        let _ = match self.conn {
            PinnedConn::Mysql(c) => c.close().await,
            PinnedConn::Postgres(c) => c.close().await,
            PinnedConn::Sqlite(c) => c.close().await,
        };
    }
}

fn escape_ident(
    f: fn(&str) -> crate::error::AppResult<String>,
    name: &str,
) -> sqlx::Result<String> {
    f(name).map_err(|e| sqlx::Error::Protocol(e.to_string()))
}

/// The server's own id for this connection. Best-effort: without it `/cancel`
/// can only abandon the request locally.
async fn server_pid(conn: &mut PinnedConn) -> Option<i64> {
    match conn {
        PinnedConn::Mysql(c) => sqlx::query("SELECT CONNECTION_ID() AS id")
            .fetch_one(&mut **c)
            .await
            .ok()
            .and_then(|r| {
                r.try_get::<u64, _>("id")
                    .map(|v| v as i64)
                    .or_else(|_| r.try_get::<i64, _>("id"))
                    .ok()
            }),
        PinnedConn::Postgres(c) => sqlx::query("SELECT pg_backend_pid() AS id")
            .fetch_one(&mut **c)
            .await
            .ok()
            .and_then(|r| r.try_get::<i32, _>("id").map(i64::from).ok()),
        PinnedConn::Sqlite(_) => None,
    }
}

/// An error that means the connection itself is gone, as opposed to the
/// statement failing.
pub fn is_connection_error(e: &sqlx::Error) -> bool {
    matches!(
        e,
        sqlx::Error::Io(_) | sqlx::Error::WorkerCrashed | sqlx::Error::PoolClosed
    )
}
