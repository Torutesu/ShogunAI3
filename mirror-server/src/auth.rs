//! Bearer-token auth middleware + Argon2id token hashing.

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

/// Generate a 32-byte URL-safe-base64 random token.
pub fn generate_device_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Hash a token with Argon2id.
pub fn hash_token(token: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(token.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| e.to_string())
}

/// Verify a token against an Argon2id hash.
pub fn verify_token(token: &str, hash: &str) -> Result<bool, String> {
    let parsed = PasswordHash::new(hash).map_err(|e| e.to_string())?;
    Ok(Argon2::default()
        .verify_password(token.as_bytes(), &parsed)
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

/// Search devices by bearer token using Argon2id verification.
pub async fn find_device_by_token(
    store: &Arc<dyn BlobStore>,
    token: &str,
) -> Result<Option<DeviceRecord>, ServerError> {
    let devices = store.list_devices().await.map_err(|e| {
        tracing::error!("list_devices error: {e}");
        ServerError::Internal("storage error".to_string())
    })?;
    for record in devices {
        match verify_token(token, &record.token_hash) {
            Ok(true) => return Ok(Some(record)),
            Ok(false) => continue,
            Err(e) => {
                tracing::warn!("token verify error: {e}");
                continue;
            }
        }
    }
    Ok(None)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_roundtrip() {
        let token = generate_device_token();
        assert_eq!(token.len(), 43); // 32 bytes → base64url no-pad = 43 chars
        let hash = hash_token(&token).unwrap();
        assert!(verify_token(&token, &hash).unwrap());
    }

    #[test]
    fn test_wrong_token_rejected() {
        let token = generate_device_token();
        let hash = hash_token(&token).unwrap();
        let wrong = generate_device_token();
        assert!(!verify_token(&wrong, &hash).unwrap());
    }

    #[test]
    fn test_token_is_url_safe() {
        let token = generate_device_token();
        // URL-safe chars only
        assert!(token
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn test_tokens_are_unique() {
        let t1 = generate_device_token();
        let t2 = generate_device_token();
        assert_ne!(t1, t2);
    }
}
