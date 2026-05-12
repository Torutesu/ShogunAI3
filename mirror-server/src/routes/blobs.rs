//! Blob upload / list / fetch / tombstone endpoints.
//!
//! All require bearer auth (enforced via `require_device_token` middleware).

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    error::ServerError,
    ratelimit::Endpoint,
    routes::metrics,
    storage::{BlobEnvelope, BlobListEntry, DeviceRecord, ListQuery, StoreError},
    AppState,
};

// ── Request / response shapes ─────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct UploadResponse {
    pub blob_id: String,
    pub stored_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ListResponse {
    pub blobs: Vec<BlobListEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ListParams {
    pub cursor: Option<String>,
    pub device_id: Option<String>,
    pub limit: Option<usize>,
    pub since: Option<chrono::DateTime<Utc>>,
    pub until: Option<chrono::DateTime<Utc>>,
}

const MAX_BLOB_SIZE: usize = 1024 * 1024; // 1 MB
const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;
const KNOWN_SCHEMAS: &[&str] = &["mem_items.v1"];
const SUPPORTED_VERSIONS: &[u8] = &[1];

// ── Handlers ──────────────────────────────────────────────────────────────────

/// `POST /v1/blobs` — upload a blob.
pub async fn upload(
    State(state): State<AppState>,
    caller: axum::Extension<DeviceRecord>,
    body: axum::body::Bytes,
) -> Result<impl IntoResponse, ServerError> {
    // Size check before deserialization.
    if body.len() > MAX_BLOB_SIZE {
        return Err(ServerError::PayloadTooLarge);
    }

    let envelope: BlobEnvelope = serde_json::from_slice(&body)
        .map_err(|e| ServerError::InvalidEnvelope(format!("invalid envelope: {e}")))?;

    // Validate fields.
    validate_envelope(&envelope)?;

    // Rate limit.
    match state
        .rate_limiter
        .try_acquire(&caller.device_id, Endpoint::PostBlob)
    {
        Ok(()) => {}
        Err(retry) => {
            metrics::inc_rate_limited();
            return Err(ServerError::RateLimited {
                retry_after_secs: retry.as_secs().max(1),
            });
        }
    }

    // Store.
    match state.store.put(&envelope).await {
        Ok(()) => {}
        Err(StoreError::Conflict(msg)) => {
            return Err(ServerError::Conflict(msg));
        }
        Err(StoreError::Gone) => {
            return Err(ServerError::Gone);
        }
        Err(e) => return Err(e.into()),
    }

    // Retrieve stored_at from the stored blob.
    let stored_at = match state.store.get(&envelope.blob_id).await {
        Ok(Some(env)) => env.stored_at.unwrap_or_else(Utc::now),
        _ => Utc::now(),
    };

    metrics::inc_uploaded();
    Ok((
        StatusCode::CREATED,
        Json(UploadResponse {
            blob_id: envelope.blob_id,
            stored_at,
        }),
    ))
}

/// `GET /v1/blobs` — list blobs (cursor delta-sync or time-range).
pub async fn list(
    State(state): State<AppState>,
    caller: axum::Extension<DeviceRecord>,
    Query(params): Query<ListParams>,
) -> Result<impl IntoResponse, ServerError> {
    // Rate limit.
    match state
        .rate_limiter
        .try_acquire(&caller.device_id, Endpoint::GetBlobList)
    {
        Ok(()) => {}
        Err(retry) => {
            metrics::inc_rate_limited();
            return Err(ServerError::RateLimited {
                retry_after_secs: retry.as_secs().max(1),
            });
        }
    }

    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT);

    let query = ListQuery {
        device_id: params.device_id,
        since: params.since,
        until: params.until,
        cursor: params.cursor,
        limit,
    };

    let result = state.store.list(&query).await?;

    Ok(Json(ListResponse {
        blobs: result.blobs,
        next_cursor: result.next_cursor,
    }))
}

/// `GET /v1/blobs/<id>` — fetch a single blob.
pub async fn fetch(
    State(state): State<AppState>,
    caller: axum::Extension<DeviceRecord>,
    Path(blob_id): Path<String>,
) -> Result<impl IntoResponse, ServerError> {
    // Rate limit.
    match state
        .rate_limiter
        .try_acquire(&caller.device_id, Endpoint::GetBlob)
    {
        Ok(()) => {}
        Err(retry) => {
            metrics::inc_rate_limited();
            return Err(ServerError::RateLimited {
                retry_after_secs: retry.as_secs().max(1),
            });
        }
    }

    match state.store.get(&blob_id).await {
        Ok(Some(env)) => {
            metrics::inc_fetched();
            Ok(Json(env))
        }
        Ok(None) => Err(ServerError::NotFound),
        Err(StoreError::Gone) => Err(ServerError::Gone),
        Err(e) => Err(e.into()),
    }
}

/// `POST /v1/blobs/<id>/tombstone` — mark a blob as deleted.
pub async fn tombstone(
    State(state): State<AppState>,
    _caller: axum::Extension<DeviceRecord>,
    Path(blob_id): Path<String>,
) -> Result<impl IntoResponse, ServerError> {
    match state.store.tombstone(&blob_id).await {
        Ok(()) => {
            metrics::inc_tombstoned();
            Ok(StatusCode::NO_CONTENT)
        }
        Err(StoreError::NotFound) => Err(ServerError::NotFound),
        Err(e) => Err(e.into()),
    }
}

// ── Validation ────────────────────────────────────────────────────────────────

fn validate_envelope(env: &BlobEnvelope) -> Result<(), ServerError> {
    if !SUPPORTED_VERSIONS.contains(&env.version) {
        return Err(ServerError::UnsupportedVersion(env.version));
    }
    if !KNOWN_SCHEMAS.contains(&env.schema.as_str()) {
        return Err(ServerError::UnknownSchema(env.schema.clone()));
    }
    if env.blob_id.is_empty() {
        return Err(ServerError::InvalidEnvelope(
            "blob_id is required".to_string(),
        ));
    }
    if env.device_id.is_empty() {
        return Err(ServerError::InvalidEnvelope(
            "device_id is required".to_string(),
        ));
    }
    if env.ciphertext.nonce.is_empty() {
        return Err(ServerError::InvalidEnvelope(
            "ciphertext.nonce is required".to_string(),
        ));
    }
    if env.ciphertext.data.is_empty() {
        return Err(ServerError::InvalidEnvelope(
            "ciphertext.data is required".to_string(),
        ));
    }
    Ok(())
}
