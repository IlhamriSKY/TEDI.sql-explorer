//! Bearer-token middleware.
//!
//! Reads the `Authorization: Bearer <token>` header and rejects anything that
//! doesn't match the per-boot token. `OPTIONS` requests are let through for
//! CORS preflight; the frontend never sends auth headers on preflight anyway.

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode, header},
    middleware::Next,
    response::Response,
};

use crate::state::AppState;

pub async fn require_bearer(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    if req.method() == Method::OPTIONS {
        return Ok(next.run(req).await);
    }
    let header_value = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let token = header_value
        .strip_prefix("Bearer ")
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if !constant_time_eq(token.as_bytes(), state.token.as_bytes()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(req).await)
}

/// Constant-time slice comparison so a timing-oracle attacker can't peel the
/// bearer one byte at a time. 32-byte token + 100% loopback exposure makes
/// this borderline paranoid, but cheap to do.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        acc |= x ^ y;
    }
    acc == 0
}
