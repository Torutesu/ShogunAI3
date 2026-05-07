//! Bearer-token auth middleware + Argon2id token hashing.
//!
//! ## Token format
//!
//! Tokens are formatted as `<device_id>.<random>` where:
//! - `device_id` is a non-secret ULID (Crockford base32, 26 chars)
//! - `random` is a 32-byte URL-safe-base64 secret (43 chars)
//!
//! The split lets the server look up the `DeviceRecord` directly by `device_id`
//! (single file read) and run Argon2id verification once on the random portion.
//! This avoids the O(N-devices) iteration that was present in earlier drafts and
//! eliminates the timing oracle that an attacker could exploit by measuring the
//! per-request latency vs. the device count.
//!
//! Devices issued tokens before this commit (any token without a `.` separator)
//! are rejected — operators must re-register affected devices. This is acceptable
//! because the server is pre-public-release.

use argon2::{
    password_hash::{rand_core::OsRng, SaltString},
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
};
use axum::{
    body::Body,
    extract::State,
    http::{header, Request},
    middleware::Next,
    response::Response,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use std::sync::Arc;

use crate::{
    error::ServerError,
    storage::{BlobStore, DeviceRecord},
    AppState,
};

// ── Token generation + hashing ────────────────────────────────────────────────

/// Generate a fresh 32-byte URL-safe-base64 random secret. Used internally by
/// `format_device_token`; exposed for testing only.
pub fn generate_random_secret() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Build the wire-format token `<device_id>.<random>`. The `device_id` is
/// non-secret; the `random` portion is what authenticates the device.
pub fn format_device_token(device_id: &str, random: &str) -> String {
    format!("{device_id}.{random}")
}

/// Convenience: generate a fresh secret and format it for `device_id`.
/// Returns `(token, random)`. Only `random` is hashed and stored; the full
/// `token` is what's returned to the client.
pub fn generate_device_token(device_id: &str) -> (String, String) {
    let random = generate_random_secret();
    let token = format_device_token(device_id, &random);
    (token, random)
}

/// Hash a token's random portion with Argon2id.
pub fn hash_token(random: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(random.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Verify a token's random portion against an Argon2id hash.
pub fn verify_token(random: &str, hash: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(hash).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(random.as_bytes(), &parsed)
        .is_ok())
}

// ── Middleware ────────────────────────────────────────────────────────────────

/// Extract the bearer token from the Authorization header.
fn extract_bearer(req: &Request<Body>) -> Result<String, ServerError> {
    let header_val = req
        .headers()
        .get(header::AUTHORIZATION)
        .ok_or(ServerError::Unauthorized)?
        .to_str()
        .map_err(|_| ServerError::Unauthorized)?;

    let token = header_val
        .strip_prefix("Bearer ")
        .ok_or(ServerError::Unauthorized)?
        .to_string();

    if token.is_empty() {
        return Err(ServerError::Unauthorized);
    }
    Ok(token)
}

/// Split a `<device_id>.<random>` token into its two parts. Tokens that don't
/// contain exactly one `.` separator are rejected (legacy tokens from before
/// this format change land here too).
fn split_token(token: &str) -> Result<(&str, &str), ServerError> {
    let mut parts = token.splitn(2, '.');
    let device_id = parts.next().ok_or(ServerError::Unauthorized)?;
    let random = parts.next().ok_or(ServerError::Unauthorized)?;
    if device_id.is_empty() || random.is_empty() {
        return Err(ServerError::Unauthorized);
    }
    Ok((device_id, random))
}

/// Axum middleware that validates the Bearer token and injects a `DeviceRecord` extension.
pub async fn require_device_token(
    State(state): State<AppState>,
    mut req: Request<Body>,
    next: Next,
) -> Result<Response, ServerError> {
    let token = extract_bearer(&req)?;
    let device = find_device_by_token(&state.store, &token)
        .await?
        .ok_or(ServerError::Unauthorized)?;
    req.extensions_mut().insert(device);
    Ok(next.run(req).await)
}

/// Validate a bearer token: extract `device_id` from the token prefix, load
/// that device's record (single file read), then run Argon2id verify exactly
/// once against the random suffix.
///
/// Returns `Ok(None)` for any failure path (unknown device, hash mismatch,
/// malformed token); the caller maps `None` to `Unauthorized`.
pub async fn find_device_by_token(
    store: &Arc<dyn BlobStore>,
    token: &str,
) -> Result<Option<DeviceRecord>, ServerError> {
    let (device_id, random) = match split_token(token) {
        Ok(parts) => parts,
        Err(_) => return Ok(None),
    };

    let record = match store.load_device(device_id).await {
        Ok(Some(r)) => r,
        Ok(None) => return Ok(None),
        Err(e) => {
            tracing::error!("load_device error: {e}");
            return Err(ServerError::Internal("storage error".to_string()));
        }
    };

    match verify_token(random, &record.token_hash) {
        Ok(true) => Ok(Some(record)),
        Ok(false) => Ok(None),
        Err(e) => {
            tracing::warn!("token verify error: {e}");
            Ok(None)
        }
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_roundtrip() {
        let (token, random) = generate_device_token("01HVDDD000000000000000DEV1");
        // 26-char ULID + '.' + 43-char base64 = 70 chars total.
        assert_eq!(token.len(), 70);
        assert!(token.starts_with("01HVDDD000000000000000DEV1."));
        let hash = hash_token(&random).unwrap();
        assert!(verify_token(&random, &hash).unwrap());
    }

    #[test]
    fn test_wrong_random_rejected() {
        let (_token, random) = generate_device_token("dev1");
        let hash = hash_token(&random).unwrap();
        let wrong_random = generate_random_secret();
        assert!(!verify_token(&wrong_random, &hash).unwrap());
    }

    #[test]
    fn test_random_is_url_safe() {
        let r = generate_random_secret();
        assert!(r
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn test_tokens_are_unique() {
        let (t1, _) = generate_device_token("dev1");
        let (t2, _) = generate_device_token("dev1");
        assert_ne!(t1, t2);
    }

    #[test]
    fn test_split_token_valid() {
        let parts = split_token("dev1.secret123").unwrap();
        assert_eq!(parts.0, "dev1");
        assert_eq!(parts.1, "secret123");
    }

    #[test]
    fn test_split_token_no_separator_rejected() {
        // Legacy-format token (no '.') is rejected.
        assert!(split_token("legacysecretwithoutseparator").is_err());
    }

    #[test]
    fn test_split_token_empty_parts_rejected() {
        assert!(split_token(".secret").is_err());
        assert!(split_token("dev1.").is_err());
        assert!(split_token(".").is_err());
    }
}
