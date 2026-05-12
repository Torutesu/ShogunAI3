//! Device registration/rename/delete endpoints.
//!
//! - `POST /v1/devices`       — no auth (registration code required)
//! - `PUT /v1/devices/<id>`   — bearer auth
//! - `DELETE /v1/devices/<id>`— bearer auth

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::{
    auth::{generate_device_token, hash_token},
    error::ServerError,
    ratelimit::Endpoint,
    routes::metrics,
    storage::DeviceRecord,
    AppState,
};

// ── Request / response shapes ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub registration_code: String,
    pub device_name: String,
}

#[derive(Debug, Serialize)]
pub struct RegisterResponse {
    pub device_id: String,
    pub device_token: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameRequest {
    pub device_name: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceResponse {
    pub device_id: String,
    pub device_name: String,
    pub registered_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct DeleteResponse {
    pub device_id: String,
    pub tombstoned_blobs: u64,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/// `POST /v1/devices` — register a new device.
///
/// Rate limit: per client IP (default 10 per hour) — applied BEFORE checking
/// the registration code so an attacker can't burn through it via brute force.
pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(req): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ServerError> {
    // Per-IP rate limit (Fix #7) — applied first so a brute-force attacker
    // is throttled before the registration_code check.
    let ip_key = addr.ip().to_string();
    if let Err(retry) = state
        .register_limiter
        .try_acquire(&ip_key, Endpoint::RegisterByIp)
    {
        metrics::inc_rate_limited();
        return Err(ServerError::RateLimited {
            retry_after_secs: retry.as_secs().max(1),
        });
    }

    // Validate registration code.
    if req.registration_code != state.config.auth.registration_code {
        return Err(ServerError::BadRequest(
            "invalid registration code".to_string(),
        ));
    }

    // Validate device name.
    validate_device_name(&req.device_name)?;

    let device_id = Ulid::new().to_string();
    let (token, random) = generate_device_token(&device_id);
    let token_hash =
        hash_token(&random).map_err(|e| ServerError::Internal(format!("hash error: {e}")))?;

    let record = DeviceRecord {
        device_id: device_id.clone(),
        account_id: state.config.auth.account_id.clone(),
        device_name: req.device_name,
        token_hash,
        registered_at: Utc::now(),
    };

    state.store.save_device(&record).await?;
    metrics::inc_active_devices();

    Ok((
        StatusCode::CREATED,
        Json(RegisterResponse {
            device_id,
            device_token: token,
        }),
    ))
}

/// `PUT /v1/devices/<id>` — rename a device.
pub async fn rename(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    caller: axum::Extension<DeviceRecord>,
    Json(req): Json<RenameRequest>,
) -> Result<impl IntoResponse, ServerError> {
    // Load the target device.
    let target = state
        .store
        .load_device(&device_id)
        .await?
        .ok_or(ServerError::NotFound)?;

    // Only the same account can rename.
    if target.account_id != caller.account_id {
        return Err(ServerError::Unauthorized);
    }

    validate_device_name(&req.device_name)?;

    let updated = state
        .store
        .update_device_name(&device_id, &req.device_name)
        .await?;

    Ok(Json(DeviceResponse {
        device_id: updated.device_id,
        device_name: updated.device_name,
        registered_at: updated.registered_at,
    }))
}

/// `DELETE /v1/devices/<id>` — remove a device and tombstone all its blobs.
pub async fn delete(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
    caller: axum::Extension<DeviceRecord>,
) -> Result<impl IntoResponse, ServerError> {
    // Load target device.
    let target = state
        .store
        .load_device(&device_id)
        .await?
        .ok_or(ServerError::NotFound)?;

    // Only same account.
    if target.account_id != caller.account_id {
        return Err(ServerError::Unauthorized);
    }

    // Tombstone all blobs.
    let tombstoned = state.store.tombstone_device(&device_id).await?;

    // Delete device record.
    state.store.delete_device(&device_id).await?;
    metrics::dec_active_devices();

    Ok(Json(DeleteResponse {
        device_id,
        tombstoned_blobs: tombstoned,
    }))
}

// ── Validation ────────────────────────────────────────────────────────────────

fn validate_device_name(name: &str) -> Result<(), ServerError> {
    if name.is_empty() {
        return Err(ServerError::BadRequest(
            "device_name must not be empty".to_string(),
        ));
    }
    if name.len() > 64 {
        return Err(ServerError::BadRequest(
            "device_name must not exceed 64 characters".to_string(),
        ));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(ServerError::BadRequest(
            "device_name must not contain control characters".to_string(),
        ));
    }
    Ok(())
}
