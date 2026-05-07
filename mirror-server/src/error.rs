//! `ServerError` — the unified error type for all route handlers.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("gone")]
    Gone,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("payload too large")]
    PayloadTooLarge,
    #[error("rate limited")]
    RateLimited { retry_after_secs: u64 },
    #[error("internal: {0}")]
    Internal(String),
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        let (status, error_code, message) = match &self {
            ServerError::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "invalid or missing bearer token".to_string(),
            ),
            ServerError::Forbidden => (
                StatusCode::FORBIDDEN,
                "forbidden",
                "access denied".to_string(),
            ),
            ServerError::NotFound => (
                StatusCode::NOT_FOUND,
                "not_found",
                "resource not found".to_string(),
            ),
            ServerError::Gone => (
                StatusCode::GONE,
                "gone",
                "resource has been deleted".to_string(),
            ),
            ServerError::Conflict(msg) => (StatusCode::CONFLICT, "conflict", msg.clone()),
            ServerError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "bad_request", msg.clone()),
            ServerError::PayloadTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "payload exceeds 1MB limit".to_string(),
            ),
            ServerError::RateLimited { retry_after_secs } => {
                let body = Json(json!({
                    "error": "rate_limited",
                    "message": "rate limit exceeded",
                    "retry_after_secs": retry_after_secs,
                }));
                let mut resp = (StatusCode::TOO_MANY_REQUESTS, body).into_response();
                resp.headers_mut()
                    .insert("Retry-After", retry_after_secs.to_string().parse().unwrap());
                return resp;
            }
            ServerError::Internal(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_server_error",
                msg.clone(),
            ),
        };

        let body = Json(json!({
            "error": error_code,
            "message": message,
        }));
        (status, body).into_response()
    }
}

impl From<crate::storage::StoreError> for ServerError {
    fn from(e: crate::storage::StoreError) -> Self {
        use crate::storage::StoreError;
        match e {
            StoreError::NotFound => ServerError::NotFound,
            StoreError::Gone => ServerError::Gone,
            StoreError::Conflict(msg) => ServerError::Conflict(msg),
            StoreError::Io(e) => ServerError::Internal(e.to_string()),
            StoreError::Serde(e) => ServerError::Internal(e.to_string()),
            StoreError::Internal(msg) => ServerError::Internal(msg),
        }
    }
}
