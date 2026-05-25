//! Error type + IntoResponse mapping for axum.
//!
//! Every endpoint returns `Result<Json<T>, AppError>`. `AppError` produces a
//! consistent JSON shape so the frontend can render messages without juggling
//! HTTP status codes.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug)]
pub enum AppError {
    BadRequest(String),
    NotFound(String),
    Unauthorized,
    Conflict(String),
    Internal(String),
    Database(String),
    Canceled,
    Timeout,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::BadRequest(m) => write!(f, "bad request: {m}"),
            AppError::NotFound(m) => write!(f, "not found: {m}"),
            AppError::Unauthorized => write!(f, "unauthorized"),
            AppError::Conflict(m) => write!(f, "conflict: {m}"),
            AppError::Internal(m) => write!(f, "internal: {m}"),
            AppError::Database(m) => write!(f, "database: {m}"),
            AppError::Canceled => write!(f, "canceled"),
            AppError::Timeout => write!(f, "timeout"),
        }
    }
}

impl std::error::Error for AppError {}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        AppError::Database(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::BadRequest(value.to_string())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            AppError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
            AppError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
            AppError::Conflict(_) => (StatusCode::CONFLICT, "conflict"),
            AppError::Database(_) => (StatusCode::BAD_REQUEST, "database"),
            AppError::Canceled => (StatusCode::REQUEST_TIMEOUT, "canceled"),
            AppError::Timeout => (StatusCode::REQUEST_TIMEOUT, "timeout"),
            AppError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        let body = Json(json!({
            "ok": false,
            "error": {
                "code": code,
                "message": self.to_string(),
            }
        }));
        (status, body).into_response()
    }
}

pub type AppResult<T> = Result<T, AppError>;
