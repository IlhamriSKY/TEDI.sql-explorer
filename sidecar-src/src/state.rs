//! Shared state — bearer token + the live connection registry.
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

use crate::db::Backend;

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
}

/// In-flight request tracking. The frontend can call `/cancel` with the
/// `request_id` returned by `/query` to abort a long-running statement.
#[derive(Default)]
pub struct InFlight {
    pub map: HashMap<String, CancellationToken>,
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
