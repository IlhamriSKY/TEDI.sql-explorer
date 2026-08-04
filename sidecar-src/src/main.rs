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

use axum::http::Method;
use rand::RngCore;
use serde_json::json;

use crate::db::close_backend;
use crate::state::AppState;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

mod auth;
mod bind;
mod db;
mod edit;
mod error;
mod export;
mod meta;
mod query;
mod routes;
mod rows;
mod schema;
mod sqltext;
mod state;
mod value;


#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    init_logging();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
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

    let app = routes::build_router(state.clone()).layer(cors);

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
        // Cloning a backend is cheap (pool is Arc-internal).
        for backend in conn.all_backends().await {
            close_backend(backend).await;
        }
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

