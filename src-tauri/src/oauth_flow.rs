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

/// What we extract from the `?code=...&state=...&error=...` query string on
/// the OAuth redirect URL.
#[derive(Debug)]
pub enum CallbackOutcome {
  Code { code: String, state: String },
  UserCancelled, // ?error=access_denied
  ProviderError(String), // any other ?error= value
  Malformed,
}

/// Parse the query portion of a /callback URL (the part after `?`, no `?`).
pub fn parse_callback_query(qs: &str) -> CallbackOutcome {
  let mut code: Option<String> = None;
  let mut state: Option<String> = None;
  let mut err: Option<String> = None;
  for pair in qs.split('&') {
    let Some((k, v)) = pair.split_once('=') else { continue; };
    let v = match urlencoding::decode(v) {
      Ok(s) => s.into_owned(),
      Err(_) => continue,
    };
    match k {
      "code" => code = Some(v),
      "state" => state = Some(v),
      "error" => err = Some(v),
      _ => {}
    }
  }
  if let Some(e) = err {
    return if e == "access_denied" {
      CallbackOutcome::UserCancelled
    } else {
      CallbackOutcome::ProviderError(e)
    };
  }
  match (code, state) {
    (Some(code), Some(state)) => CallbackOutcome::Code { code, state },
    _ => CallbackOutcome::Malformed,
  }
}

/// POST to Google's token endpoint and parse the response into OauthTokens.
/// `endpoint_override` is for testing only; production callers pass `None`.
pub async fn exchange_code(
  code: &str,
  client_id: &str,
  client_secret: &str,
  endpoint_override: Option<&str>,
) -> Result<OauthTokens, OauthError> {
  let endpoint = endpoint_override.unwrap_or("https://oauth2.googleapis.com/token");
  let body = [
    ("code", code),
    ("client_id", client_id),
    ("client_secret", client_secret),
    ("redirect_uri", REDIRECT_URI),
    ("grant_type", "authorization_code"),
  ];
  let client = reqwest::Client::builder()
    .timeout(Duration::from_secs(60))
    .build()
    .map_err(|e| OauthError::Internal(format!("build client: {}", e)))?;
  let resp = client
    .post(endpoint)
    .form(&body)
    .send()
    .await
    .map_err(|_| OauthError::NetworkError)?;
  let status = resp.status().as_u16();
  let text = resp.text().await.map_err(|_| OauthError::NetworkError)?;
  if status != 200 {
    // Extract Google's error code from the response body if present.
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let google_error = parsed
      .get("error")
      .and_then(|v| v.as_str())
      .unwrap_or("unknown")
      .to_string();
    log::warn!(
      "token exchange failed: status={} error={} (response body redacted)",
      status,
      google_error,
    );
    return Err(OauthError::TokenExchangeFailed { status, code: google_error });
  }
  let parsed: serde_json::Value =
    serde_json::from_str(&text).map_err(|e| OauthError::Internal(format!("parse token JSON: {}", e)))?;
  let access_token = parsed
    .get("access_token")
    .and_then(|v| v.as_str())
    .ok_or_else(|| OauthError::Internal("missing access_token".into()))?
    .to_string();
  let refresh_token = parsed
    .get("refresh_token")
    .and_then(|v| v.as_str())
    .map(String::from);
  let expires_at = parsed
    .get("expires_in")
    .and_then(|v| v.as_i64())
    .map(|sec| (chrono::Utc::now().timestamp() + sec));
  let scopes = parsed
    .get("scope")
    .and_then(|v| v.as_str())
    .map(|s| s.split_whitespace().map(String::from).collect::<Vec<_>>())
    .unwrap_or_default();
  Ok(OauthTokens {
    access_token,
    refresh_token,
    expires_at,
    scopes,
    client_id: client_id.to_string(),
    client_secret: client_secret.to_string(),
  })
}

use std::sync::OnceLock;
use tokio::sync::Mutex;

/// Process-global single-flight lock. Only one OAuth flow at a time.
static IN_FLIGHT: OnceLock<Mutex<()>> = OnceLock::new();

fn in_flight_lock() -> &'static Mutex<()> {
  IN_FLIGHT.get_or_init(|| Mutex::new(()))
}

/// Generate a 32-byte hex state string for CSRF protection.
fn generate_state() -> String {
  uuid::Uuid::new_v4().simple().to_string()
}

/// Run the full OAuth flow. Reads `.env.google-oauth`, binds localhost:8723,
/// opens the system browser, awaits the callback with a timeout, exchanges
/// the code for tokens. Returns the tokens (or an OauthError).
///
/// The optional `token_endpoint_override` is for testing; production passes
/// `None`.
pub async fn run(token_endpoint_override: Option<&str>) -> Result<OauthTokens, OauthError> {
  let lock = in_flight_lock();
  let _guard = match lock.try_lock() {
    Ok(g) => g,
    Err(_) => return Err(OauthError::AlreadyInProgress),
  };

  let (client_id, client_secret) = load_env_from_disk()?;
  let state = generate_state();

  // Bind the server. AddrInUse → PortBusy.
  let server = match tiny_http::Server::http(("127.0.0.1", PORT)) {
    Ok(s) => s,
    Err(e) => {
      let s = e.to_string();
      if s.contains("Address already in use") || s.contains("address in use") {
        return Err(OauthError::PortBusy);
      }
      return Err(OauthError::Internal(format!("bind: {}", e)));
    }
  };
  // tiny_http blocks per-request; wrap in Arc + spawn_blocking so we can
  // wait with a timeout from async context.
  let server = std::sync::Arc::new(server);
  let server_for_open = server.clone();

  let auth_url = build_auth_url(&client_id, &state);
  if let Err(e) = open::that(&auth_url) {
    log::warn!("open browser failed: {} — user must open URL manually", e);
    // Continue: flow can still complete if the user pastes auth_url into a browser.
  }

  // Wait for callback in a blocking thread, with a timeout.
  let server_handle = server.clone();
  let state_for_thread = state.clone();
  let join = tokio::task::spawn_blocking(move || -> Result<(String, String), OauthError> {
    let req = server_handle.recv().map_err(|e| OauthError::Internal(format!("recv: {}", e)))?;
    // Parse the URL path + query. `req.url()` is e.g. "/callback?code=...&state=..."
    let url = req.url().to_string();
    let qs = url.splitn(2, '?').nth(1).unwrap_or("");
    let outcome = parse_callback_query(qs);
    // Always respond so the browser tab shows feedback.
    let (status_code, body) = match &outcome {
      CallbackOutcome::Code { state: got, .. } if got == &state_for_thread => (
        200u32,
        "<!DOCTYPE html><html><body style='font-family:system-ui;max-width:560px;margin:80px auto;padding:24px'><h1 style='color:#0a7a2a'>✓ Connected</h1><p>You can close this tab and return to Shogun AI.</p></body></html>".to_string(),
      ),
      _ => (
        400u32,
        "<!DOCTYPE html><html><body style='font-family:system-ui;max-width:560px;margin:80px auto;padding:24px'><h1 style='color:#b00020'>✗ OAuth error</h1><p>Return to Shogun AI for details.</p></body></html>".to_string(),
      ),
    };
    let resp = tiny_http::Response::from_string(body)
      .with_status_code(status_code)
      .with_header(
        "Content-Type: text/html; charset=utf-8"
          .parse::<tiny_http::Header>()
          .unwrap(),
      );
    let _ = req.respond(resp);

    match outcome {
      CallbackOutcome::Code { code, state: got } => {
        if got != state_for_thread {
          return Err(OauthError::StateMismatch);
        }
        Ok((code, got))
      }
      CallbackOutcome::UserCancelled => Err(OauthError::UserCancelled),
      CallbackOutcome::ProviderError(_) => Err(OauthError::UserCancelled),
      CallbackOutcome::Malformed => Err(OauthError::StateMismatch),
    }
  });

  let result = tokio::time::timeout(DEFAULT_TIMEOUT, join).await;
  // Drop the server (closes the listener) regardless of outcome.
  drop(server_for_open);

  let (code, _state) = match result {
    Ok(Ok(Ok(pair))) => pair,
    Ok(Ok(Err(e))) => return Err(e),
    Ok(Err(join_err)) => return Err(OauthError::Internal(format!("join: {}", join_err))),
    Err(_) => return Err(OauthError::Timeout),
  };

  let tokens = exchange_code(&code, &client_id, &client_secret, token_endpoint_override).await?;
  Ok(tokens)
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

  #[test]
  fn parse_callback_query_ok() {
    let r = parse_callback_query("code=abc123&state=xyz&scope=gmail.readonly");
    match r {
      CallbackOutcome::Code { code, state } => {
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
      }
      _ => panic!("expected Code, got {:?}", r),
    }
  }

  #[test]
  fn parse_callback_query_url_encoded() {
    let r = parse_callback_query("code=a%2Fb%2Bc&state=s%3D1");
    match r {
      CallbackOutcome::Code { code, state } => {
        assert_eq!(code, "a/b+c");
        assert_eq!(state, "s=1");
      }
      _ => panic!(),
    }
  }

  #[test]
  fn parse_callback_query_user_cancelled() {
    let r = parse_callback_query("error=access_denied&state=xyz");
    assert!(matches!(r, CallbackOutcome::UserCancelled));
  }

  #[test]
  fn parse_callback_query_provider_error() {
    let r = parse_callback_query("error=invalid_request&state=xyz");
    match r {
      CallbackOutcome::ProviderError(e) => assert_eq!(e, "invalid_request"),
      _ => panic!(),
    }
  }

  #[test]
  fn parse_callback_query_no_code() {
    let r = parse_callback_query("state=xyz");
    assert!(matches!(r, CallbackOutcome::Malformed));
  }

  #[test]
  fn parse_callback_query_empty() {
    let r = parse_callback_query("");
    assert!(matches!(r, CallbackOutcome::Malformed));
  }

  #[tokio::test]
  async fn exchange_code_ok() {
    let mut server = mockito::Server::new_async().await;
    let mock = server
      .mock("POST", "/token")
      .with_status(200)
      .with_header("content-type", "application/json")
      .with_body(
        r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly","token_type":"Bearer"}"#,
      )
      .create_async()
      .await;
    let endpoint = format!("{}/token", server.url());
    let r = exchange_code("CODE", "CID", "CSEC", Some(&endpoint))
      .await
      .expect("exchange_code");
    assert_eq!(r.access_token, "AT");
    assert_eq!(r.refresh_token.as_deref(), Some("RT"));
    assert!(r.expires_at.is_some());
    assert_eq!(r.scopes.len(), 2);
    assert!(r.scopes.iter().any(|s| s.contains("gmail.readonly")));
    mock.assert_async().await;
  }

  #[tokio::test]
  async fn exchange_code_4xx_invalid_grant() {
    let mut server = mockito::Server::new_async().await;
    let _mock = server
      .mock("POST", "/token")
      .with_status(400)
      .with_header("content-type", "application/json")
      .with_body(r#"{"error":"invalid_grant","error_description":"Bad Request"}"#)
      .create_async()
      .await;
    let endpoint = format!("{}/token", server.url());
    let r = exchange_code("CODE", "CID", "CSEC", Some(&endpoint)).await;
    match r {
      Err(OauthError::TokenExchangeFailed { status, code }) => {
        assert_eq!(status, 400);
        assert_eq!(code, "invalid_grant");
      }
      other => panic!("expected TokenExchangeFailed, got {:?}", other),
    }
  }

  #[tokio::test]
  async fn exchange_code_no_refresh_token() {
    let mut server = mockito::Server::new_async().await;
    let _mock = server
      .mock("POST", "/token")
      .with_status(200)
      .with_body(r#"{"access_token":"AT","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#)
      .create_async()
      .await;
    let endpoint = format!("{}/token", server.url());
    let r = exchange_code("CODE", "CID", "CSEC", Some(&endpoint))
      .await
      .expect("exchange_code");
    assert_eq!(r.access_token, "AT");
    assert!(r.refresh_token.is_none());
  }

  #[tokio::test]
  #[ignore] // requires localhost port 8723 and is end-to-end
  async fn run_end_to_end_with_mocked_token_endpoint() {
    // Set up a mocked token endpoint.
    let mut token_server = mockito::Server::new_async().await;
    let _mock = token_server
      .mock("POST", "/token")
      .with_status(200)
      .with_body(
        r#"{"access_token":"AT","refresh_token":"RT","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#,
      )
      .create_async()
      .await;
    let endpoint = format!("{}/token", token_server.url());

    // Set up a writable temp env file. We can't easily override the real
    // load_env_from_disk path; this test assumes a real .env.google-oauth
    // exists at <repo>/scripts/. Skip by checking the prerequisite.
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let env_path = manifest.parent().unwrap().join("scripts/.env.google-oauth");
    if !env_path.exists() {
      eprintln!("SKIP: scripts/.env.google-oauth not present");
      return;
    }

    // Spawn the run() in the background; meanwhile fake-browser hits /callback.
    let run_task = tokio::spawn(async move { run(Some(&endpoint)).await });
    // Give the server a moment to bind.
    tokio::time::sleep(Duration::from_millis(200)).await;

    // We don't know the state without exposing it; for an integration test
    // we'd need the orchestrator to expose state via a channel. As a simpler
    // approach, this test only checks that the flow rejects an unrelated
    // /callback (state mismatch).
    let client = reqwest::Client::new();
    let _ = client
      .get("http://127.0.0.1:8723/callback?code=fake&state=wrong-state")
      .send()
      .await;

    let result = tokio::time::timeout(Duration::from_secs(5), run_task)
      .await
      .expect("timeout")
      .expect("join");
    match result {
      Err(OauthError::StateMismatch) => {} // expected
      other => panic!("expected StateMismatch, got {:?}", other),
    }
  }
}
