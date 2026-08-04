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
    // Clamp the caller-supplied pool size to a sane ceiling so a single
    // /connect can't request an unbounded number of backend connections.
    build_pool(
        &req.kind,
        &req.url,
        req.max_pool.clamp(1, 50),
        req.sqlite_read_only,
    )
    .await
}

/// Open one pool. Split out of `build_backend` so a PostgreSQL connection can
/// open a second pool against another database (see `Connection::backend_for`)
/// without reassembling a whole `ConnectRequest`.
pub async fn build_pool(
    kind: &BackendKind,
    url: &str,
    max_pool: u32,
    sqlite_read_only: bool,
) -> AppResult<Backend> {
    let connect_timeout = Duration::from_secs(15);
    let max_pool = max_pool.clamp(1, 50);
    match kind {
        BackendKind::Mysql => {
            let pool = MySqlPoolOptions::new()
                .max_connections(max_pool)
                .acquire_timeout(connect_timeout)
                .connect(url)
                .await
                .map_err(|e| AppError::Database(format!("mysql connect: {e}")))?;
            Ok(Backend::Mysql(pool))
        }
        BackendKind::Postgres => {
            let pool = PgPoolOptions::new()
                .max_connections(max_pool)
                .acquire_timeout(connect_timeout)
                .connect(url)
                .await
                .map_err(|e| AppError::Database(format!("postgres connect: {e}")))?;
            Ok(Backend::Postgres(pool))
        }
        BackendKind::Sqlite => {
            // Accept either a bare path (`/foo/bar.db`) or a full URL
            // (`sqlite:///foo/bar.db`, `sqlite::memory:`). Bare paths get
            // wrapped so SqliteConnectOptions can parse them.
            let url = if url.starts_with("sqlite:") {
                url.to_string()
            } else {
                format!("sqlite://{url}")
            };
            let opts = SqliteConnectOptions::from_str(&url)
                .map_err(|e| AppError::Database(format!("sqlite url: {e}")))?
                .create_if_missing(!sqlite_read_only)
                .read_only(sqlite_read_only)
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

/// The database the pool is actually attached to. MySQL sessions can hop
/// databases with `USE`, so only PostgreSQL (one database per connection)
/// really needs this — we still ask both so `/connections` can report it.
pub async fn current_database(backend: &Backend) -> Option<String> {
    use sqlx::Row as _;
    match backend {
        Backend::Postgres(pool) => sqlx::query("SELECT current_database() AS db")
            .fetch_one(pool)
            .await
            .ok()
            .and_then(|r| r.try_get::<String, _>("db").ok()),
        Backend::Mysql(pool) => sqlx::query("SELECT DATABASE() AS db")
            .fetch_one(pool)
            .await
            .ok()
            .and_then(|r| r.try_get::<Option<String>, _>("db").ok().flatten()),
        Backend::Sqlite(_) => None,
    }
}

/// Percent-encode one URL path segment. The database name lands in the
/// connection url's path, so anything that would terminate the segment
/// (`/ ? #`) or confuse the parser has to be escaped.
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Rewrite a connection url to point at `database`, preserving scheme,
/// credentials, host, and query string. Used to open a second PostgreSQL
/// pool when the user browses a database the base connection isn't attached
/// to — PG binds one database per connection, so a catalog query on the base
/// pool would silently answer for the wrong database.
pub fn url_with_database(url: &str, database: &str) -> String {
    let (head, query) = match url.find('?') {
        Some(i) => (&url[..i], &url[i..]),
        None => (url, ""),
    };
    // Path starts at the first `/` AFTER the `scheme://` authority.
    let authority_at = match head.find("://") {
        Some(i) => i + 3,
        None => 0,
    };
    let base = match head[authority_at..].find('/') {
        Some(i) => &head[..authority_at + i],
        None => head,
    };
    format!("{base}/{}{query}", encode_segment(database))
}

#[cfg(test)]
mod tests {
    use super::url_with_database;

    #[test]
    fn rewrites_the_database_segment_only() {
        assert_eq!(
            url_with_database("postgres://u:p@h:5432/app?sslmode=require", "other"),
            "postgres://u:p@h:5432/other?sslmode=require"
        );
        // No path on the original url.
        assert_eq!(
            url_with_database("postgres://u@h:5432", "other"),
            "postgres://u@h:5432/other"
        );
        // A `/` inside the (percent-encoded) password must not be mistaken
        // for the path separator, and a `/` in the db name gets escaped.
        assert_eq!(
            url_with_database("postgres://u:a%2Fb@h/app", "we/ird"),
            "postgres://u:a%2Fb@h/we%2Fird"
        );
    }
}
