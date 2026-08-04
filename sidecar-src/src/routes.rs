//! The HTTP surface: the axum router and one handler per endpoint.
//!
//! Handlers stay thin on purpose — each resolves the connection (and, for
//! PostgreSQL, the pool that can actually answer for the requested database),
//! then delegates to the module that owns the work. Split out of `main.rs` so
//! that file is only process bootstrap.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json, Router,
    extract::{Query, State},
    middleware,
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::auth;
use crate::db::{ConnectRequest, build_backend, close_backend, current_database};
use crate::edit::{MutationResponse, RowMutationRequest, delete_row, insert_row, update_row};
use crate::rows::{TableRowsRequest, list_rows};
use crate::error::{AppError, AppResult};
use crate::export::{ExportRequest, run_export};
use crate::meta::{ForeignKeyInfo, IndexInfo, list_foreign_keys, list_indexes, table_ddl};
use crate::query::{ExecuteOptions, QueryRequest, QueryResponse, cancel_on_server, execute};
use crate::schema::{
    ColumnInfo, DatabaseInfo, SchemaInfo, TableInfo, list_columns, list_databases, list_schemas,
    list_tables,
};
use crate::state::{AppState, Connection, ConnectionConfig, InFlightEntry};

// ----------------------------- Router ----------------------------------------

pub fn build_router(state: AppState) -> Router {
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
        .route("/indexes", get(handle_indexes))
        .route("/foreign-keys", get(handle_foreign_keys))
        .route("/ddl", get(handle_ddl))
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
    // Ask the server which database we actually landed on. PostgreSQL binds
    // one database per connection, so `Connection::backend_for` needs to know
    // when a request is asking about a different one.
    let current = current_database(&backend).await;
    let conn = Arc::new(Connection {
        kind: kind_str,
        backend,
        config: ConnectionConfig {
            allow_writes: req.allow_writes,
            row_limit: req.row_limit,
            query_timeout: Duration::from_millis(req.query_timeout_ms.max(100)),
        },
        default_database: req.default_database.clone(),
        current_database: current.clone(),
        url: req.url.clone(),
        max_pool: req.max_pool,
        extra_pools: Default::default(),
    });
    let mut conns = state.connections.write().await;
    if let Some(prev) = conns.insert(req.id.clone(), conn) {
        // Replace + drop the previous pools. Detach the close to a task so the
        // /connect response doesn't wait for their drain.
        tokio::spawn(async move {
            for backend in prev.all_backends().await {
                close_backend(backend).await;
            }
        });
    }
    Ok(Json(
        json!({ "ok": true, "id": req.id, "kind": kind_str, "current_database": current }),
    ))
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
        tokio::spawn(async move {
            for backend in c.all_backends().await {
                close_backend(backend).await;
            }
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
    current_database: Option<String>,
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
            current_database: c.current_database.clone(),
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

/// Resolve `(backend, database, schema)` for a schema-browsing request.
///
/// The backend comes from `Connection::backend_for`, so a PostgreSQL request
/// about a database the base pool is not attached to gets a pool that can
/// actually answer for it instead of silently reporting the connected
/// database's catalog. The schema falls back per engine: MySQL/SQLite treat
/// the database as the schema, PostgreSQL defaults to `public` (its own
/// default, and never the database name).
async fn browse_target(
    conn: &Arc<Connection>,
    q: &ConnIdQuery,
) -> AppResult<(crate::db::Backend, String, String)> {
    let database = q
        .database
        .clone()
        .or_else(|| conn.default_database.clone())
        .or_else(|| conn.current_database.clone())
        .unwrap_or_default();
    let schema = q.schema.clone().unwrap_or_else(|| {
        if conn.kind == "postgres" {
            "public".to_string()
        } else {
            database.clone()
        }
    });
    let backend = conn.backend_for(Some(&database)).await?;
    Ok((backend, database, schema))
}

async fn handle_schemas(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, _) = browse_target(&conn, &q).await?;
    let schemas: Vec<SchemaInfo> = list_schemas(&backend, &database).await?;
    Ok(Json(json!({ "ok": true, "schemas": schemas })))
}

async fn handle_tables(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, schema) = browse_target(&conn, &q).await?;
    let tables: Vec<TableInfo> = list_tables(&backend, &database, &schema).await?;
    Ok(Json(json!({ "ok": true, "tables": tables })))
}

async fn handle_columns(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, schema) = browse_target(&conn, &q).await?;
    let table = require_table(&q)?;
    let cols: Vec<ColumnInfo> = list_columns(&backend, &database, &schema, &table).await?;
    Ok(Json(json!({ "ok": true, "columns": cols })))
}

fn require_table(q: &ConnIdQuery) -> AppResult<String> {
    q.table
        .clone()
        .ok_or_else(|| AppError::BadRequest("missing table".into()))
}

async fn handle_indexes(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, schema) = browse_target(&conn, &q).await?;
    let table = require_table(&q)?;
    let idx: Vec<IndexInfo> = list_indexes(&backend, &database, &schema, &table).await?;
    Ok(Json(json!({ "ok": true, "indexes": idx })))
}

async fn handle_foreign_keys(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, schema) = browse_target(&conn, &q).await?;
    let table = require_table(&q)?;
    let fks: Vec<ForeignKeyInfo> = list_foreign_keys(&backend, &database, &schema, &table).await?;
    Ok(Json(json!({ "ok": true, "foreign_keys": fks })))
}

async fn handle_ddl(
    State(state): State<AppState>,
    Query(q): Query<ConnIdQuery>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &q.conn).await?;
    let (backend, database, schema) = browse_target(&conn, &q).await?;
    let table = require_table(&q)?;
    let ddl = table_ddl(&backend, &database, &schema, &table).await?;
    Ok(Json(json!({ "ok": true, "ddl": ddl })))
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
    let backend_pid = Arc::new(tokio::sync::RwLock::new(None));
    {
        let mut in_flight = state.in_flight.write().await;
        in_flight.map.insert(
            request_id.clone(),
            InFlightEntry {
                cancel: cancel.clone(),
                conn_id: req.conn.clone(),
                backend_pid: backend_pid.clone(),
            },
        );
    }
    // Fall back to the connection's saved default_database when the request
    // omits its own context, so a user who pinned a DB on the connection but
    // typed a free-form query still resolves unqualified names. Then to the
    // database the pool is actually attached to, so MySQL always has a `USE`
    // to run and can't inherit whichever database a previous batch selected on
    // the pooled connection.
    let database = req
        .database
        .as_deref()
        .or(conn.default_database.as_deref())
        .or(conn.current_database.as_deref());
    // PostgreSQL: the query has to run on the pool attached to that database.
    let backend = conn.backend_for(database).await?;
    let result = execute(
        &backend,
        &conn.config,
        &req.sql,
        ExecuteOptions {
            row_limit,
            timeout,
            cancel,
            database,
            schema: req.schema.as_deref(),
            backend_pid: Some(&backend_pid),
        },
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
    // Snapshot what we need, then drop the read guard: the server-side cancel
    // below does its own I/O and must not hold the in-flight lock while the
    // query task is trying to remove itself from it.
    let found = {
        let in_flight = state.in_flight.read().await;
        match in_flight.map.get(&req.request_id) {
            Some(entry) => {
                entry.cancel.cancel();
                Some((entry.conn_id.clone(), *entry.backend_pid.read().await))
            }
            None => None,
        }
    };
    let Some((conn_id, pid)) = found else {
        return Ok(Json(json!({ "ok": true, "canceled": false })));
    };
    // Cancelling the future only drops our socket; the database keeps running
    // the statement (and holding its locks) until it is told to stop.
    let mut server_canceled = false;
    if let Some(pid) = pid {
        if let Ok(conn) = require_connection(&state, &conn_id).await {
            cancel_on_server(&conn.backend, pid).await;
            server_canceled = true;
        }
    }
    Ok(Json(
        json!({ "ok": true, "canceled": true, "server_canceled": server_canceled }),
    ))
}

async fn handle_table_rows(
    State(state): State<AppState>,
    Json(req): Json<TableRowsRequest>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &req.conn).await?;
    let backend = conn.backend_for(Some(&req.database)).await?;
    let resp = list_rows(&backend, &req).await?;
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
    let backend = conn.backend_for(Some(&req.database)).await?;
    Ok(Json(update_row(&backend, &req).await?))
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
    let backend = conn.backend_for(Some(&req.database)).await?;
    Ok(Json(insert_row(&backend, &req).await?))
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
    let backend = conn.backend_for(Some(&req.database)).await?;
    Ok(Json(delete_row(&backend, &req).await?))
}

async fn handle_export(
    State(state): State<AppState>,
    Json(req): Json<ExportRequest>,
) -> AppResult<Json<Value>> {
    let conn = require_connection(&state, &req.conn).await?;
    let backend = conn.backend_for(req.database.as_deref()).await?;
    let resp = run_export(&backend, &conn.config, &req).await?;
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
