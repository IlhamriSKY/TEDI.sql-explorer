//! Shared state: bearer token + the live connection registry.
//!
//! Each `/connect` opens a sqlx pool keyed by the caller-supplied connection
//! id and parks it in `connections`. `/disconnect` removes the entry. The
//! map is wrapped in a tokio `RwLock` so reads (the common path for queries)
//! don't block each other.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;

use crate::db::{Backend, BackendKind, build_pool, url_with_database};
use crate::error::AppResult;

#[derive(Clone, Debug)]
pub struct ConnectionConfig {
    pub allow_writes: bool,
    pub row_limit: u64,
    pub query_timeout: Duration,
}

pub struct Connection {
    pub backend: Backend,
    pub config: ConnectionConfig,
    /// Driver name as reported back to the frontend (`mysql` / `postgres` /
    /// `sqlite`). Avoids re-deriving it from `backend` in every response.
    pub kind: &'static str,
    /// Default database / schema the connection was opened against. Used by
    /// schema endpoints when the request omits the database parameter.
    pub default_database: Option<String>,
    /// The database `backend` is really attached to, read back from the server
    /// at connect time. For PostgreSQL this is the one database the base pool
    /// can answer catalog queries for.
    pub current_database: Option<String>,
    /// Connect url + pool size, kept so a PostgreSQL connection can open a
    /// second pool against another database on demand.
    pub url: String,
    pub max_pool: u32,
    /// Lazily-opened per-database pools (PostgreSQL only), keyed by db name.
    pub extra_pools: RwLock<HashMap<String, Backend>>,
}

impl Connection {
    /// The pool that can actually answer for `database`.
    ///
    /// MySQL and SQLite see every database from one connection, so they always
    /// get the base pool. PostgreSQL binds exactly one database per connection:
    /// asking the base pool about another database silently returns the
    /// CONNECTED database's schemas and tables, so we open (and cache) a pool
    /// per database instead.
    pub async fn backend_for(&self, database: Option<&str>) -> AppResult<Backend> {
        let db = match database {
            Some(d) if !d.is_empty() => d,
            _ => return Ok(self.backend.clone()),
        };
        if self.kind != "postgres" {
            return Ok(self.backend.clone());
        }
        if self.current_database.as_deref() == Some(db) {
            return Ok(self.backend.clone());
        }
        if let Some(p) = self.extra_pools.read().await.get(db) {
            return Ok(p.clone());
        }
        let pool = build_pool(
            &BackendKind::Postgres,
            &url_with_database(&self.url, db),
            self.max_pool,
            false,
        )
        .await?;
        let mut extra = self.extra_pools.write().await;
        // Another task may have won the race while we were connecting; keep
        // the pool that is already published and drop ours.
        if let Some(existing) = extra.get(db) {
            let ours = pool;
            let winner = existing.clone();
            tokio::spawn(async move { crate::db::close_backend(ours).await });
            return Ok(winner);
        }
        extra.insert(db.to_string(), pool.clone());
        Ok(pool)
    }

    /// Every pool this connection owns, for teardown.
    pub async fn all_backends(&self) -> Vec<Backend> {
        let mut out = vec![self.backend.clone()];
        out.extend(self.extra_pools.read().await.values().cloned());
        out
    }
}

/// In-flight request tracking. The frontend can call `/cancel` with the
/// `request_id` returned by `/query` to abort a long-running statement.
///
/// Cancelling the Rust future only abandons the socket — the server keeps
/// executing. `backend_pid` is the server-side connection id (MySQL
/// `CONNECTION_ID()`, PostgreSQL `pg_backend_pid()`) of the connection the
/// batch is pinned to, so `/cancel` can also tell the database to stop.
#[derive(Default)]
pub struct InFlight {
    pub map: HashMap<String, InFlightEntry>,
}

pub struct InFlightEntry {
    pub cancel: CancellationToken,
    pub conn_id: String,
    pub backend_pid: Arc<RwLock<Option<i64>>>,
}

#[derive(Clone)]
pub struct AppState {
    pub token: Arc<String>,
    pub connections: Arc<RwLock<HashMap<String, Arc<Connection>>>>,
    pub in_flight: Arc<RwLock<InFlight>>,
}

impl AppState {
    pub fn new(token: String) -> Self {
        Self {
            token: Arc::new(token),
            connections: Arc::new(RwLock::new(HashMap::new())),
            in_flight: Arc::new(RwLock::new(InFlight::default())),
        }
    }
}
