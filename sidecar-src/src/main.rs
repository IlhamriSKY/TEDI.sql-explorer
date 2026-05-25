//! tedi-sql-helper. Sidecar SQL gateway for the tedi.sql-explorer
//! extension. Speaks HTTP+JSON on `127.0.0.1` with a per-boot bearer token.
//!
//! Usage:
//!   tedi-sql-helper                  # bind 127.0.0.1:<random>, print READY
//!   tedi-sql-helper --port 12345     # bind a specific port (rare)
//!   tedi-sql-helper --version
//!
//! On startup the helper:
//!   1. Generates a 32-byte random token, hex-encoded.
//!   2. Binds a TCP listener on `127.0.0.1:<port>` (port 0 = OS picks).
//!   3. Prints one line to stdout: `READY {"port":12345,"token":"abc..."}`
//!      and flushes. The extension reads it via `shell_bg_logs` and connects.
//!   4. Runs the axum router until SIGTERM / Ctrl-C / `/shutdown` is called.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Query, State},
    http::Method,
    middleware,
    response::IntoResponse,
    routing::{get, post},
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};

mod auth;
mod db;
mod edit;
mod error;
mod export;
mod query;
mod schema;
mod state;
mod value;

use crate::db::{ConnectRequest, build_backend, close_backend};
use crate::edit::{
    MutationResponse, RowMutationRequest, TableRowsRequest, delete_row, insert_row, list_rows,
    update_row,
};
use crate::error::{AppError, AppResult};
use crate::export::{ExportRequest, run_export};
use crate::query::{QueryRequest, QueryResponse, execute};
use crate::schema::{
    ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo, list_columns, list_databases, list_schemas,
    list_tables,
};
use crate::state::{AppState, Connection, ConnectionConfig};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(args.iter().next().map(String::as_str), Some("--version" | "-V")) {
        println!("tedi-sql-helper {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let port: u16 = parse_port(&args);
    let token = generate_token();
    let state = AppState::new(token.clone());

    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    // CORS: webview origin varies across Tauri platforms (tauri://localhost,
    // http://tauri.localhost, https://tauri.localhost). The bearer token is
    // the real auth. CORS just controls which origin the browser allows to
    // read responses. Use a permissive policy and lean on the token.
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    let app = build_router(state.clone()).layer(cors);

    // Print the READY line *after* the listener binds successfully, so the
    // extension never reads a port that isn't accepting yet.
    let ready = json!({
        "port": bound.port(),
        "token": token,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    println!("READY {}", serde_json::to_string(&ready).unwrap());
    use std::io::Write;
    let _ = std::io::stdout().flush();
    tracing::info!("listening on {bound}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    // Tear down every live pool on a clean exit.
    let conns = state.connections.read().await;
    for (id, conn) in conns.iter() {
        tracing::info!("closing connection {id} on shutdown");
        // Cloning the backend is cheap (pool is Arc-internal).
        close_backend(conn.backend.clone()).await;
    }
    Ok(())
}

fn init_logging() {
    // Logging goes to stderr. Stdout is reserved for the READY line.
    let env = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,sqlx=warn,hyper=warn"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(env)
        .with_writer(std::io::stderr)
        .with_target(false)
        .try_init();
}

fn parse_port(args: &[String]) -> u16 {
    let mut iter = args.iter();
    while let Some(a) = iter.next() {
        if a == "--port" {
            if let Some(v) = iter.next() {
                if let Ok(n) = v.parse::<u16>() {
                    return n;
                }
            }
        }
    }
    0
}

fn generate_token() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

// ----------------------------- Router ----------------------------------------

fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/version", get(version))
        .route("/connect", post(handle_connect))
        .route("/disconnect", post(handle_disconnect))
        .route("/connections", get(handle_list_connections))
        .route("/databases", get(handle_databases))
        .route("/schemas", get(handle_schemas))
        .route("/tables", get(handle_tables))
        .route("/columns", get(handle_columns))
        .route("/query", post(handle_query))
        .route("/cancel", post(handle_cancel))
        .route("/table-rows", post(handle_table_rows))
        .route("/table-update", post(handle_table_update))
        .route("/table-insert", post(handle_table_insert))
        .route("/table-delete", post(handle_table_delete))
        .route("/export", post(handle_export))
        .route("/shutdown", post(handle_shutdown))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_bearer,
        ))
        .with_state(state)
}

// ----------------------------- Helpers ---------------------------------------

async fn require_connection(state: &AppState, id: &str) -> AppResult<Arc<Connection>> {
    let conns = state.connections.read().await;
    conns
        .get(id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("connection {id} not found")))
}

#[derive(Deserialize)]
struct ConnIdQuery {
    conn: String,
    #[serde(default)]
    database: Option<String>,
    #[serde(default)]
    schema: Option<String>,
    #[serde(default)]
    table: Option<String>,
}

// ----------------------------- Handlers --------------------------------------

async fn healthz() -> impl IntoResponse {
    Json(json!({ "ok": true }))
}

async fn version() -> impl IntoResponse {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn handle_connect(
    State(state): State<AppState>,
    Json(req): Json<ConnectRequest>,
) -> AppResult<Json<Value>> {
    let kind_str = req.kind.as_str();
    let backend = build_backend(&req).await?;
    let conn = Arc::new(Connection {
        kind: kind_str,
        backend,
        config: ConnectionConfig {
            allow_writes: req.allow_writes,
            row_limit: req.row_limit,
            query_timeout: Duration::from_millis(req.query_timeout_ms.max(100)),
        },
        default_database: req.default_database.clone(),
    });
    let mut conns = state.connections.write().await;
    if let Some(prev) = conns.insert(req.id.clone(), conn) {
        // Replace + drop the previous pool. Detach the close to a task so the
        // /connect response doesn't wait for the old pool's drain.
        let backend = prev.backend.clone();
        tokio::spawn(async move {
            close_backend(backend).await;
        });
    }
    Ok(Json(json!({ "ok": true, "id": req.id, "kind": kind_str })))
}

#[derive(Deserialize)]
struct DisconnectRequest {
    id: String,
}

async fn handle_disconnect(
    State(state): State<AppState>,
    Json(req): Json<DisconnectRequest>,
) -> AppResult<Json<Value>> {
    let mut conns = state.connections.write().await;
    if let Some(c) = conns.remove(&req.id) {
        let backend = c.backend.clone();
        tokio::spawn(async move {
            close_backend(backend).await;
        });
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Serialize)]
struct ConnectionSummary {
    id: String,
    kind: &'static str,
    allow_writes: bool,
    default_database: Option<String>,
}

async fn handle_list_connections(State(state): State<AppState>) -> AppResult<Json<Value>> {
    let conns = state.connections.read().await;
    let mut list = Vec::with_capacity(conns.len());
    for (id, c) in conns.iter() {
        list.push(ConnectionSummary {
            id: id.clone(),
            kind: c.kind,
            allow_writes: c.config.allow_writes,
            default_database: c.default_database.clone(),
        });
    }
    Ok(Json(json!({ "ok": true, "connections": list })))
}

async fn handle_databases(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let dbs: Vec<DatabaseInfo> = list_databases(&conn.backend).await?;
    Ok(Json(json!({ "ok": true, "databases": dbs })))
}

async fn handle_schemas(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let database = q.database.clone().or_else(|| conn.default_database.clone()).unwrap_or_default();
    let schemas: Vec<SchemaInfo> = list_schemas(&conn.backend, &database).await?;
    Ok(Json(json!({ "ok": true, "schemas": schemas })))
}

async fn handle_tables(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let database = q.database.clone().or_else(|| conn.default_database.clone()).unwrap_or_default();
    let schema = q.schema.clone().unwrap_or_else(|| database.clone());
    let tables: Vec<TableInfo> = list_tables(&conn.backend, &database, &schema).await?;
    Ok(Json(json!({ "ok": true, "tables": tables })))
}

async fn handle_columns(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let database = q.database.clone().or_else(|| conn.default_database.clone()).unwrap_or_default();
    let schema = q.schema.clone().unwrap_or_else(|| database.clone());
    let table = q
        .table
        .clone()
        .ok_or_else(|| AppError::BadRequest("missing table".into()))?;
    let cols: Vec<ColumnInfo> = list_columns(&conn.backend, &database, &schema, &table).await?;
    Ok(Json(json!({ "ok": true, "columns": cols })))
}

async fn handle_query(
    State(state): State<AppState>,
    Json(req): Json<QueryRequest>,
) -> AppResult<Json<QueryResponse>> {
    let conn = require_connection(&state, &req.conn).await?;
    let row_limit = req.row_limit.unwrap_or(conn.config.row_limit);
    let timeout = req
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(conn.config.query_timeout);
    let request_id = req
        .request_id
        .clone()
        .unwrap_or_else(|| hex::encode(rand::random::<[u8; 8]>()));
    let cancel = CancellationToken::new();
    {
        let mut in_flight = state.in_flight.write().await;
        in_flight.map.insert(request_id.clone(), cancel.clone());
    }
    let result = execute(
        &conn.backend,
        &conn.config,
        &req.sql,
        row_limit,
        timeout,
        cancel,
    )
    .await;
    {
        let mut in_flight = state.in_flight.write().await;
        in_flight.map.remove(&request_id);
    }
    let statements = result?;
    let aborted = statements.iter().any(|s| {
        matches!(
            s,
            crate::query::StatementResult::Error { error, .. }
                if error == "canceled" || error.starts_with("timed out")
        )
    });
    Ok(Json(QueryResponse {
        statements,
        request_id,
        aborted,
    }))
}

#[derive(Deserialize)]
struct CancelRequest {
    request_id: String,
}

async fn handle_cancel(
    State(state): State<AppState>,
    Json(req): Json<CancelRequest>,
) -> AppResult<Json<Value>> {
    let in_flight = state.in_flight.read().await;
    if let Some(token) = in_flight.map.get(&req.request_id) {
        token.cancel();
        return Ok(Json(json!({ "ok": true, "canceled": true })));
    }
    Ok(Json(json!({ "ok": true, "canceled": false })))
}

async fn handle_table_rows(
    State(state): State<AppState>,
    Json(req): Json<TableRowsRequest>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &req.conn).await?;
    let resp = list_rows(&conn.backend, &req).await?;
    Ok(Json(json!({ "ok": true, "result": resp })))
}

async fn handle_table_update(
    State(state): State<AppState>,
    Json(req): Json<RowMutationRequest>,
) -> AppResult<Json<MutationResponse>> {
    let conn = require_connection(&state, &req.conn).await?;
    if !conn.config.allow_writes {
        return Err(AppError::BadRequest(
            "connection is read-only. Toggle Allow Writes to mutate rows".into(),
        ));
    }
    Ok(Json(update_row(&conn.backend, &req).await?))
}

async fn handle_table_insert(
    State(state): State<AppState>,
    Json(req): Json<RowMutationRequest>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &req.conn).await?;
    if !conn.config.allow_writes {
        return Err(AppError::BadRequest(
            "connection is read-only. Toggle Allow Writes to insert rows".into(),
        ));
    }
    Ok(Json(insert_row(&conn.backend, &req).await?))
}

async fn handle_table_delete(
    State(state): State<AppState>,
    Json(req): Json<RowMutationRequest>,
) -> AppResult<Json<MutationResponse>> {
    let conn = require_connection(&state, &req.conn).await?;
    if !conn.config.allow_writes {
        return Err(AppError::BadRequest(
            "connection is read-only. Toggle Allow Writes to delete rows".into(),
        ));
    }
    Ok(Json(delete_row(&conn.backend, &req).await?))
}

async fn handle_export(
    State(state): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &req.conn).await?;
    let resp = run_export(&conn.backend, &req).await?;
    Ok(Json(json!({ "ok": true, "export": resp })))
}

async fn handle_shutdown() -> impl IntoResponse {
    // Async exit so the response makes it back to the client before the
    // process terminates.
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::process::exit(0);
    });
    Json(json!({ "ok": true }))
}
