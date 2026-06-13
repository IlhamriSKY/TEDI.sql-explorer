//! Driver enum + connect / disconnect logic.
//!
//! Each `Backend` variant owns the right `sqlx` Pool. Keeping them in distinct
//! variants (instead of `AnyPool`) means each query path can use the
//! driver-native column / row APIs and decode types properly.

use std::str::FromStr;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::{MySqlPool, PgPool, SqlitePool};
use sqlx::mysql::MySqlPoolOptions;
use sqlx::postgres::PgPoolOptions;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

use crate::error::{AppError, AppResult};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Mysql,
    Postgres,
    Sqlite,
}

impl BackendKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BackendKind::Mysql => "mysql",
            BackendKind::Postgres => "postgres",
            BackendKind::Sqlite => "sqlite",
        }
    }
}

#[derive(Clone)]
pub enum Backend {
    Mysql(MySqlPool),
    Postgres(PgPool),
    Sqlite(SqlitePool),
}

#[derive(Deserialize)]
pub struct ConnectRequest {
    pub id: String,
    pub kind: BackendKind,
    pub url: String,
    #[serde(default = "default_max_pool")]
    pub max_pool: u32,
    #[serde(default)]
    pub allow_writes: bool,
    #[serde(default = "default_timeout_ms")]
    pub query_timeout_ms: u64,
    #[serde(default = "default_row_limit")]
    pub row_limit: u64,
    #[serde(default)]
    pub default_database: Option<String>,
    /// For SQLite: open in read-only mode (`?mode=ro`). Ignored elsewhere.
    #[serde(default)]
    pub sqlite_read_only: bool,
}

fn default_max_pool() -> u32 {
    5
}

fn default_timeout_ms() -> u64 {
    30_000
}

fn default_row_limit() -> u64 {
    10_000
}

pub async fn build_backend(req: &ConnectRequest) -> AppResult<Backend> {
    let connect_timeout = Duration::from_secs(15);
    // Clamp the caller-supplied pool size to a sane ceiling so a single
    // /connect can't request an unbounded number of backend connections.
    let max_pool = req.max_pool.clamp(1, 50);
    match req.kind {
        BackendKind::Mysql => {
            let pool = MySqlPoolOptions::new()
                .max_connections(max_pool)
                .acquire_timeout(connect_timeout)
                .connect(&req.url)
                .await
                .map_err(|e| AppError::Database(format!("mysql connect: {e}")))?;
            Ok(Backend::Mysql(pool))
        }
        BackendKind::Postgres => {
            let pool = PgPoolOptions::new()
                .max_connections(max_pool)
                .acquire_timeout(connect_timeout)
                .connect(&req.url)
                .await
                .map_err(|e| AppError::Database(format!("postgres connect: {e}")))?;
            Ok(Backend::Postgres(pool))
        }
        BackendKind::Sqlite => {
            // Accept either a bare path (`/foo/bar.db`) or a full URL
            // (`sqlite:///foo/bar.db`, `sqlite::memory:`). Bare paths get
            // wrapped so SqliteConnectOptions can parse them.
            let url = if req.url.starts_with("sqlite:") {
                req.url.clone()
            } else {
                format!("sqlite://{}", req.url)
            };
            let opts = SqliteConnectOptions::from_str(&url)
                .map_err(|e| AppError::Database(format!("sqlite url: {e}")))?
                .create_if_missing(!req.sqlite_read_only)
                .read_only(req.sqlite_read_only)
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal);
            let pool = SqlitePoolOptions::new()
                .max_connections(max_pool)
                .acquire_timeout(connect_timeout)
                .connect_with(opts)
                .await
                .map_err(|e| AppError::Database(format!("sqlite connect: {e}")))?;
            Ok(Backend::Sqlite(pool))
        }
    }
}

/// Close a pool gracefully. Sqlx pools tear down their own connections on
/// `close()`. We await it so the OS sockets are released before the helper
/// reports a successful `/disconnect`.
pub async fn close_backend(backend: Backend) {
    match backend {
        Backend::Mysql(p) => p.close().await,
        Backend::Postgres(p) => p.close().await,
        Backend::Sqlite(p) => p.close().await,
    }
}
