//! Tauri-side Google OAuth flow. Replaces the manual `scripts/oauth-google.mjs`
//! + DevTools-paste workflow with a single Connect-button experience.
//!
//! Spec: docs/superpowers/specs/2026-04-27-oauth-tauri-integration-design.md

use std::path::Path;
use std::time::Duration;

/// Standard error variants returned to the frontend. The string variant is
/// stable; the frontend maps these to user-visible toasts in settings-modal.
#[derive(Debug, thiserror::Error)]
pub enum OauthError {
  #[error("oauth_credentials_not_configured")]
  CredentialsNotConfigured,
  #[error("oauth_port_busy")]
  PortBusy,
  #[error("oauth_user_cancelled")]
  UserCancelled,
  #[error("oauth_state_mismatch")]
  StateMismatch,
  #[error("oauth_timeout")]
  Timeout,
  #[error("oauth_token_exchange_failed:{status}:{code}")]
  TokenExchangeFailed { status: u16, code: String },
  #[error("oauth_network_error")]
  NetworkError,
  #[error("oauth_invalid_provider")]
  InvalidProvider,
  #[error("oauth_already_in_progress")]
  AlreadyInProgress,
  #[error("oauth_internal: {0}")]
  Internal(String),
}

impl From<OauthError> for String {
  fn from(e: OauthError) -> String {
    e.to_string()
  }
}

/// Token shape returned from `oauth_flow::run`. The frontend never sees the
/// access/refresh tokens — only metadata.
#[derive(Debug, Clone)]
pub struct OauthTokens {
  pub access_token: String,
  pub refresh_token: Option<String>,
  pub expires_at: Option<i64>, // epoch seconds
  pub scopes: Vec<String>,
  pub client_id: String,
  pub client_secret: String,
}

const REDIRECT_URI: &str = "http://localhost:8723/callback";
const PORT: u16 = 8723;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
const SCOPES: &str = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";

/// Parse `scripts/.env.google-oauth`. Returns (CLIENT_ID, CLIENT_SECRET).
pub fn parse_env(text: &str) -> Result<(String, String), OauthError> {
  let mut client_id = String::new();
  let mut client_secret = String::new();
  for raw in text.lines() {
    let line = raw.trim();
    if line.is_empty() || line.starts_with('#') { continue; }
    let Some((key, val_raw)) = line.split_once('=') else { continue; };
    let key = key.trim();
    let mut val = val_raw.trim();
    if (val.starts_with('"') && val.ends_with('"'))
      || (val.starts_with('\'') && val.ends_with('\''))
    {
      val = &val[1..val.len() - 1];
    }
    match key {
      "CLIENT_ID" => client_id = val.to_string(),
      "CLIENT_SECRET" => client_secret = val.to_string(),
      _ => {}
    }
  }
  if client_id.is_empty() || client_secret.is_empty() {
    return Err(OauthError::CredentialsNotConfigured);
  }
  Ok((client_id, client_secret))
}

/// Read `scripts/.env.google-oauth` from disk, relative to the repo root.
/// Path resolution is stable across `cargo run`, `tauri dev`, and `tauri build`
/// because we use `env!("CARGO_MANIFEST_DIR")` (which expands at compile time
/// to `<repo>/src-tauri`).
pub fn load_env_from_disk() -> Result<(String, String), OauthError> {
  let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
  let env_path = manifest
    .parent()
    .ok_or_else(|| OauthError::Internal("manifest has no parent".into()))?
    .join("scripts/.env.google-oauth");
  if !env_path.exists() {
    return Err(OauthError::CredentialsNotConfigured);
  }
  let text = std::fs::read_to_string(&env_path)
    .map_err(|e| OauthError::Internal(format!("read env: {}", e)))?;
  parse_env(&text)
}

/// Mask a secret string for safe logging. ≤ 8 chars → all asterisks.
/// Otherwise: head4 + asterisks + tail4.
pub fn mask_secret(value: &str) -> String {
  if value.len() <= 8 {
    return "*".repeat(value.len());
  }
  let head = &value[..4];
  let tail = &value[value.len() - 4..];
  let middle = "*".repeat(value.len() - 8);
  format!("{}{}{}", head, middle, tail)
}

/// Build the Google OAuth consent URL with all standard params.
pub fn build_auth_url(client_id: &str, state: &str) -> String {
  let params = [
    ("client_id", client_id),
    ("redirect_uri", REDIRECT_URI),
    ("response_type", "code"),
    ("scope", SCOPES),
    ("access_type", "offline"),
    ("prompt", "consent"),
    ("include_granted_scopes", "true"),
    ("state", state),
  ];
  let qs = params
    .iter()
    .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
    .collect::<Vec<_>>()
    .join("&");
  format!("https://accounts.google.com/o/oauth2/v2/auth?{}", qs)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_env_basic() {
    let raw = "
# comment
CLIENT_ID=abc123
CLIENT_SECRET=\"sec ret\"
OTHER=ignored
";
    let (id, secret) = parse_env(raw).expect("parse");
    assert_eq!(id, "abc123");
    assert_eq!(secret, "sec ret");
  }

  #[test]
  fn parse_env_single_quoted() {
    let raw = "CLIENT_ID='id-with-spaces here'\nCLIENT_SECRET=plain";
    let (id, secret) = parse_env(raw).expect("parse");
    assert_eq!(id, "id-with-spaces here");
    assert_eq!(secret, "plain");
  }

  #[test]
  fn parse_env_missing_keys() {
    let raw = "CLIENT_ID=abc123";
    let r = parse_env(raw);
    assert!(matches!(r, Err(OauthError::CredentialsNotConfigured)));
  }

  #[test]
  fn parse_env_empty_value() {
    let raw = "CLIENT_ID=\nCLIENT_SECRET=xyz";
    let r = parse_env(raw);
    assert!(matches!(r, Err(OauthError::CredentialsNotConfigured)));
  }

  #[test]
  fn mask_secret_short() {
    assert_eq!(mask_secret(""), "");
    assert_eq!(mask_secret("abc"), "***");
    assert_eq!(mask_secret("12345678"), "********");
  }

  #[test]
  fn mask_secret_long() {
    assert_eq!(mask_secret("123456789012"), "1234****9012");
    let long = "abcdefghijklmnop";
    let masked = mask_secret(long);
    assert_eq!(masked.len(), long.len());
    assert!(masked.starts_with("abcd"));
    assert!(masked.ends_with("mnop"));
    assert!(masked[4..masked.len() - 4].chars().all(|c| c == '*'));
  }

  #[test]
  fn build_auth_url_includes_all_params() {
    let url = build_auth_url("client-xyz", "state-123");
    assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
    assert!(url.contains("client_id=client-xyz"));
    assert!(url.contains("state=state-123"));
    assert!(url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A8723%2Fcallback"));
    assert!(url.contains("response_type=code"));
    assert!(url.contains("access_type=offline"));
    assert!(url.contains("prompt=consent"));
    assert!(url.contains("include_granted_scopes=true"));
    assert!(url.contains("scope="));
    assert!(url.contains("gmail.readonly"));
    assert!(url.contains("calendar.readonly"));
  }
}
