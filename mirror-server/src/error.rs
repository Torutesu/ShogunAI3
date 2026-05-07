//! `ServerError` — the unified error type for all route handlers.
//!
//! Error codes (the `error` field in the JSON body) are stable per
//! RFC § 5.4 — clients are expected to switch on the `error` value, not
//! on the human-readable `message`.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ServerError {
    /// 400 — envelope is missing required fields or is structurally invalid.
    #[error("invalid envelope: {0}")]
    InvalidEnvelope(String),
    /// 400 — `version` field is not a supported value.
    #[error("unsupported version: {0}")]
    UnsupportedVersion(u8),
    /// 400 — `schema` is not in the known list.
    #[error("unknown schema: {0}")]
    UnknownSchema(String),
    /// 400 — generic bad request that doesn't fit the more specific codes.
    #[error("bad request: {0}")]
    BadRequest(String),
    /// 401 — missing/invalid bearer token, or token doesn't belong to the resource's account.
    #[error("unauthorized")]
    Unauthorized,
    /// 401 — token previously valid but has been revoked (device deleted).
    #[error("revoked token")]
    RevokedToken,
    /// 404 — resource not found.
    #[error("not found")]
    NotFound,
    /// 410 — resource has been tombstoned/deleted.
    #[error("gone")]
    Gone,
    /// 409 — idempotency conflict (same blob_id, different content).
    #[error("conflict: {0}")]
    Conflict(String),
    /// 413 — payload exceeds the 1MB limit.
    #[error("payload too large")]
    PayloadTooLarge,
    /// 429 — rate limit exceeded.
    #[error("rate limited")]
    RateLimited { retry_after_secs: u64 },
    /// 500 — unrecoverable internal error.
    #[error("internal: {0}")]
    Internal(String),
}

impl ServerError {
    /// Stable RFC § 5.4 error code string.
    fn error_code(&self) -> &'static str {
        match self {
            ServerError::InvalidEnvelope(_) => "invalid_envelope",
            ServerError::UnsupportedVersion(_) => "unsupported_version",
            ServerError::UnknownSchema(_) => "unknown_schema",
            ServerError::BadRequest(_) => "invalid_envelope",
            ServerError::Unauthorized => "unauthorized",
            ServerError::RevokedToken => "revoked_token",
            ServerError::NotFound => "not_found",
            ServerError::Gone => "gone",
            ServerError::Conflict(_) => "conflict",
            ServerError::PayloadTooLarge => "payload_too_large",
            ServerError::RateLimited { .. } => "rate_limited",
            ServerError::Internal(_) => "internal_server_error",
        }
    }

    fn status(&self) -> StatusCode {
        match self {
            ServerError::InvalidEnvelope(_)
            | ServerError::UnsupportedVersion(_)
            | ServerError::UnknownSchema(_)
            | ServerError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ServerError::Unauthorized | ServerError::RevokedToken => StatusCode::UNAUTHORIZED,
            ServerError::NotFound => StatusCode::NOT_FOUND,
            ServerError::Gone => StatusCode::GONE,
            ServerError::Conflict(_) => StatusCode::CONFLICT,
            ServerError::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            ServerError::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            ServerError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn message(&self) -> String {
        match self {
            ServerError::InvalidEnvelope(msg) => msg.clone(),
            ServerError::UnsupportedVersion(v) => format!("unsupported envelope version: {v}"),
            ServerError::UnknownSchema(s) => format!("unknown schema: {s}"),
            ServerError::BadRequest(msg) => msg.clone(),
            ServerError::Unauthorized => "invalid or missing bearer token".to_string(),
            ServerError::RevokedToken => "token has been revoked".to_string(),
            ServerError::NotFound => "resource not found".to_string(),
            ServerError::Gone => "resource has been deleted".to_string(),
            ServerError::Conflict(msg) => msg.clone(),
            ServerError::PayloadTooLarge => "payload exceeds 1MB limit".to_string(),
            ServerError::RateLimited { .. } => "rate limit exceeded".to_string(),
            ServerError::Internal(msg) => msg.clone(),
        }
    }
}

impl IntoResponse for ServerError {
    fn into_response(self) -> Response {
        // Rate-limited responses include extra fields and a Retry-After header.
        if let ServerError::RateLimited { retry_after_secs } = &self {
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

        let body = Json(json!({
            "error": self.error_code(),
            "message": self.message(),
        }));
        (self.status(), body).into_response()
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
