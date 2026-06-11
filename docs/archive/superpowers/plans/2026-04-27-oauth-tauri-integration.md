# OAuth Helper Tauri Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Google OAuth flow from `scripts/oauth-google.mjs` (external CLI + manual DevTools paste) into Tauri so a single Connect click in Settings → Integrations completes consent and saves tokens.

**Architecture:** New Rust module `oauth_flow.rs` contains the full flow: parse `scripts/.env.google-oauth`, bind a `tiny_http` server on port 8723, build auth URL, open system browser via the existing `open` crate, await callback (180s timeout), exchange code for tokens via `reqwest`, then call the existing `commands::persist_integration_credentials_inner` for both `gmail` and `google_calendar` so a single OAuth grants both. New IPC `shogun_oauth_google_start` is the entry point. Frontend Settings UI rewires the Connect button to dispatch `oauth.google.start` instead of the legacy honest-error path.

**Tech Stack:** Rust 1.x (Tauri 2 commands, `tokio`, `reqwest`, `tiny_http` (new), `open`, `uuid`), React via `text/babel` script tag (no JSX build), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-04-27-oauth-tauri-integration-design.md` (commit `512f008`)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/Cargo.toml` | Modify | Add `tiny_http = "0.12"` to `[dependencies]` and `mockito = "1"` to `[dev-dependencies]`. |
| `src-tauri/src/oauth_flow.rs` | Create | OAuth flow body. Types (`OauthError`, `OauthSuccess`), `parse_env`, `mask_secret`, `build_auth_url`, `parse_callback_query`, `exchange_code`, `run` orchestrator, `IN_FLIGHT` mutex, all unit + integration tests. |
| `src-tauri/src/commands.rs` | Modify | Add `shogun_oauth_google_start` Tauri command. Internally calls `oauth_flow::run`, then `persist_integration_credentials_inner` for both providers. |
| `src-tauri/src/lib.rs` | Modify | `mod oauth_flow;` + register the new command in `tauri::generate_handler!`. |
| `hifi/lib/shogun-api.js` | Modify | Add `oauthGoogleStart` API call wrapper. |
| `hifi/lib/action-registry.js` | Modify | Register `oauth.google.start` action. |
| `hifi/app.jsx` | Modify | Runtime API export + action map entry + `mockIpcInvoke` stub. |
| `hifi/lib/ipc-client.js` | Modify | Mock case returning `{ ok: true, provider, scopes, expires_at, refresh_token_present: true }` for dev-without-Tauri. |
| `hifi/settings-modal.jsx` | Modify | Wire Gmail / Google Calendar `Connect` buttons to `oauth.google.start`. Update subtitle / OAuth-Setup drawer copy. Add not-configured modal. Loading + success/error toasts. |
| `tests/e2e/oauth-tauri-integration.spec.js` | Create | Playwright spec — likely `test.fixme`'d per cluster precedent. Bodies preserved as documentation. |

No DB migration. No new feature flag. No new credential storage.

---

## Pre-flight

- [ ] **Step 0.1: Confirm baseline**

```bash
npm run check:actions
npm run check:ipc-mock
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected:
- `check:actions` may have pre-existing warnings (accepted).
- `check:ipc-mock` OK (whatever the current count is — record it).
- `cargo check` warnings only.
- `hifi-smoke` baseline (record passed/failed counts).

- [ ] **Step 0.2: Confirm branch + worktree**

```bash
git branch --show-current
git status --short
```

Expected: branch `feat/oauth-tauri-integration`. Untracked `package-lock.json` and possibly `Cargo.lock` from worktree-setup is OK.

- [ ] **Step 0.3: Confirm `scripts/oauth-google.mjs` and `scripts/.env.google-oauth.example` are present**

```bash
ls scripts/oauth-google.mjs scripts/.env.google-oauth.example
```

Expected: both exist. They are the reference for the Rust port and the user-facing setup template.

---

## Task 1: Add deps + create `oauth_flow.rs` skeleton with parsing helpers

**Why:** Establish the new module with the smallest pure-logic surface (env parsing, mask helper, auth URL builder). Keeps file-I/O and network concerns out of this commit so each test is fast.

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/oauth_flow.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod oauth_flow;`)

- [ ] **Step 1.1: Add `tiny_http` and `mockito` to Cargo.toml**

Open `src-tauri/Cargo.toml`. In `[dependencies]` add:

```toml
tiny_http = "0.12"
```

Place near `reqwest`, `tokio`, etc. — alphabetical-ish.

If a `[dev-dependencies]` section exists, add `mockito = "1"` to it. If not, append at the end of the file:

```toml
[dev-dependencies]
mockito = "1"
```

- [ ] **Step 1.2: Verify deps download cleanly**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: warnings only, new crates downloaded, no compile errors.

- [ ] **Step 1.3: Create `src-tauri/src/oauth_flow.rs` (skeleton)**

```rust
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
```

The `thiserror` crate is needed for the `#[derive(thiserror::Error)]`. Verify it's in `Cargo.toml`; if not, add `thiserror = "1"` to `[dependencies]` in this same step.

- [ ] **Step 1.4: Declare the module in `lib.rs`**

In `src-tauri/src/lib.rs`, find the block of `mod` declarations (search via `grep -n "^mod " src-tauri/src/lib.rs | head`). Add a new line in alphabetical position:

```rust
mod oauth_flow;
```

- [ ] **Step 1.5: Run the unit tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow -- --nocapture
```

Expected: 7 tests pass (`parse_env_basic`, `parse_env_single_quoted`, `parse_env_missing_keys`, `parse_env_empty_value`, `mask_secret_short`, `mask_secret_long`, `build_auth_url_includes_all_params`).

- [ ] **Step 1.6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/oauth_flow.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(oauth): oauth_flow skeleton with env parsing + auth URL builder

New Rust module that will host the in-app OAuth flow. This first commit
establishes:
- OauthError enum (mirrors the spec's error variants exactly)
- OauthTokens type (no exposure to frontend)
- parse_env / load_env_from_disk for scripts/.env.google-oauth
- mask_secret for safe logging (matches scripts/oauth-google.mjs rules)
- build_auth_url with all Google consent params
- 7 unit tests covering all the pure-logic paths

Module is declared but not yet consumed by any IPC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: HTTP callback handler + `parse_callback_query`

**Why:** The localhost server is the most fragile concrete piece. Isolating it (with a small parse helper that's pure-logic) makes it easy to test the URL-parsing without spinning up the server.

**Files:**
- Modify: `src-tauri/src/oauth_flow.rs`

- [ ] **Step 2.1: Add `parse_callback_query` + types**

In `src-tauri/src/oauth_flow.rs`, after the `build_auth_url` function and before `#[cfg(test)] mod tests`, add:

```rust
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
```

- [ ] **Step 2.2: Add tests**

In the `#[cfg(test)] mod tests` block, after the existing tests, add:

```rust
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
```

- [ ] **Step 2.3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow -- --nocapture
```

Expected: 13 tests pass (7 prior + 6 new).

- [ ] **Step 2.4: Commit**

```bash
git add src-tauri/src/oauth_flow.rs
git commit -m "$(cat <<'EOF'
feat(oauth): parse_callback_query for the /callback redirect

CallbackOutcome enum captures the four possible states (Code, UserCancelled,
ProviderError, Malformed). URL-decodes values via the existing urlencoding
crate. 6 unit tests including url-encoded inputs, ?error=access_denied,
provider-side errors, and missing-code cases.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `exchange_code` with mocked HTTP

**Why:** Token exchange against `https://oauth2.googleapis.com/token` must be testable without a real network. `mockito` lets us spin up a local HTTP server with predictable responses.

**Files:**
- Modify: `src-tauri/src/oauth_flow.rs`

- [ ] **Step 3.1: Add `exchange_code` (parameterized over endpoint URL for testing)**

In `src-tauri/src/oauth_flow.rs`, after `parse_callback_query`, add:

```rust
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
```

- [ ] **Step 3.2: Add mocked tests**

In the `#[cfg(test)] mod tests` block, add:

```rust
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
```

If `tokio` isn't usable in tests via `#[tokio::test]`, the file may need `[dev-dependencies] tokio = { version = "1", features = ["macros", "rt", "rt-multi-thread"] }`. Verify by running `cargo test --lib oauth_flow` — if the macro isn't found, add the dev-dep with the `macros` and `rt-multi-thread` features (these are not in the production tokio dep) and re-run.

- [ ] **Step 3.3: Run tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow -- --nocapture
```

Expected: 16 tests pass (13 prior + 3 new async).

- [ ] **Step 3.4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/oauth_flow.rs
git commit -m "$(cat <<'EOF'
feat(oauth): exchange_code with reqwest + mocked tests

POSTs to Google's token endpoint with the standard form params, parses
access_token / refresh_token / expires_in / scope. The endpoint_override
parameter lets tests substitute a mockito server. 3 new tests cover the
200 happy path, 400 invalid_grant, and a 200 response that omits
refresh_token (acceptable — flow continues with a UI warning).

Token exchange errors log status + Google's short error code only; the
response body is never logged (could echo client_secret or PII).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: HTTP server + `run` orchestrator + IN_FLIGHT mutex

**Why:** The flow's outer shell. Spawns the localhost server, opens the browser, awaits the callback with timeout, exchanges code, and returns the tokens. The server logic is the most likely place for subtle bugs (port binding, request parsing, lifetime), so this task ships it with one ignored integration test that exercises the whole orchestrator end-to-end with a fake browser thread + mocked token endpoint.

**Files:**
- Modify: `src-tauri/src/oauth_flow.rs`

- [ ] **Step 4.1: Add the `run` orchestrator**

After `exchange_code` and before `#[cfg(test)] mod tests`, add:

```rust
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
```

- [ ] **Step 4.2: Add an ignored integration test**

In the `#[cfg(test)] mod tests` block, add:

```rust
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
```

The integration test is intentionally narrow (only the StateMismatch path) because we can't easily extract the random state from inside `run` without a refactor (e.g., exposing it via a one-shot channel for tests). A fuller end-to-end test belongs in a follow-up that adds a `#[cfg(test)] static` or a test-only param that pre-injects state.

- [ ] **Step 4.3: Run all `oauth_flow` tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow -- --ignored
```

Expected:
- Default: 16 passed, 1 ignored.
- Ignored: 1 passed (or skipped with `SKIP:` message if `.env.google-oauth` doesn't exist locally).

- [ ] **Step 4.4: Commit**

```bash
git add src-tauri/src/oauth_flow.rs
git commit -m "$(cat <<'EOF'
feat(oauth): run orchestrator with localhost callback + IN_FLIGHT mutex

Wires up the full flow:
- Single-flight tokio Mutex (oauth_already_in_progress on contention)
- load_env → generate_state → bind tiny_http on :8723 (port_busy if taken)
- open::that(auth_url) launches system browser; failure logs but doesn't
  abort (user can paste the URL manually)
- spawn_blocking awaits one /callback request, parses query, responds
  with a small HTML success/error page
- 180-second tokio::time::timeout wraps the whole wait
- exchange_code is called only after state validation
- token_endpoint_override is for tests only

One ignored integration test asserts the StateMismatch rejection path.
A fuller end-to-end test that pre-injects state for orchestrator-driven
flows is a follow-up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Tauri command `shogun_oauth_google_start`

**Why:** Glue layer between the JS frontend and the `oauth_flow::run` orchestrator. Also handles the post-flow `persist_integration_credentials_inner` call for both providers and shapes the response so no token strings leak.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 5.1: Add the command in `commands.rs`**

In `src-tauri/src/commands.rs`, find a sensible spot near the other `app_integration_*` commands (search via `grep -n "fn app_integration_credentials_status\|fn app_integration_import_credentials" src-tauri/src/commands.rs`). After `app_integration_credentials_status` (or wherever feels coherent), add:

```rust
/// Run the in-app Google OAuth flow and save tokens for both gmail and
/// google_calendar providers. Replaces the manual scripts/oauth-google.mjs
/// + DevTools-paste workflow.
///
/// payload: { "provider": "gmail" | "google_calendar" }
///
/// Returns: {
///   ok: true,
///   provider: "<echoed from input>",
///   scopes: [...],
///   expiresAt: <epoch_seconds | null>,
///   refreshTokenPresent: <bool>,
/// }
///
/// Token strings are NEVER returned to the frontend.
#[tauri::command]
pub async fn shogun_oauth_google_start(
  app: AppHandle,
  payload: Value,
) -> Result<Value, String> {
  let provider = payload
    .get("provider")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "oauth_invalid_provider".to_string())?;
  if provider != "gmail" && provider != "google_calendar" {
    return Err("oauth_invalid_provider".into());
  }

  let tokens = crate::oauth_flow::run(None).await.map_err(String::from)?;

  // Save tokens for BOTH providers — a single Google OAuth grants both
  // scopes in one consent, matching scripts/oauth-google.mjs's behavior.
  for save_provider in ["gmail", "google_calendar"] {
    let mut save_payload = json!({
      "provider": save_provider,
      "accessToken": tokens.access_token,
      "oauthClientId": tokens.client_id,
      "oauthClientSecret": tokens.client_secret,
    });
    if let Some(rt) = &tokens.refresh_token {
      save_payload["refreshToken"] = json!(rt);
    }
    if let Some(exp) = tokens.expires_at {
      save_payload["expiresAt"] = json!(exp);
    }
    if !tokens.scopes.is_empty() {
      save_payload["scopes"] = json!(tokens.scopes);
    }
    persist_integration_credentials_inner(&save_payload).map_err(|e| {
      format!("oauth_save_failed: {}", e)
    })?;
  }
  let _ = app.emit(
    "credentials-imported",
    json!({ "saved": true, "provider": provider, "via": "oauth_in_app" }),
  );

  Ok(json!({
    "ok": true,
    "provider": provider,
    "scopes": tokens.scopes,
    "expiresAt": tokens.expires_at,
    "refreshTokenPresent": tokens.refresh_token.is_some(),
  }))
}
```

- [ ] **Step 5.2: Register in `lib.rs`**

In `src-tauri/src/lib.rs`, find the `tauri::generate_handler!` block. Search via `grep -n "app_integration_credentials_status" src-tauri/src/lib.rs`. Add a new line right after it:

```rust
      commands::app_integration_credentials_status,
      commands::shogun_oauth_google_start,
```

- [ ] **Step 5.3: Verify the build**

```bash
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: warnings only, no errors.

- [ ] **Step 5.4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(oauth): shogun_oauth_google_start IPC end-to-end

Validates provider, calls oauth_flow::run, then persists credentials
for BOTH gmail and google_calendar (single consent grants both scopes).
Returns metadata only — no token strings cross the IPC boundary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: JS API + action registry + mock IPC

**Why:** Wire the new IPC into the JS layer so the React UI can call it. Standard pattern across 4 files.

**Files:**
- Modify: `hifi/lib/shogun-api.js`
- Modify: `hifi/lib/action-registry.js`
- Modify: `hifi/app.jsx`
- Modify: `hifi/lib/ipc-client.js`

- [ ] **Step 6.1: `shogun-api.js` wrapper**

In `hifi/lib/shogun-api.js`, find the existing `appIntegrationConnect` or `appIntegrationImportCredentials` definition (`grep -n "appIntegrationConnect\|appIntegrationImportCredentials" hifi/lib/shogun-api.js`). Add right after it:

```js
      oauthGoogleStart: (input) => call("shogun_oauth_google_start", input, WRITE),
```

(Match the surrounding indentation. `WRITE` is correct — this command writes credentials.)

- [ ] **Step 6.2: `action-registry.js` registration**

In `hifi/lib/action-registry.js`, find an existing `integrations.*` registration to anchor near. Add:

```js
    register("oauth.google.start", (payload) => api.oauthGoogleStart(payload));
```

- [ ] **Step 6.3: `app.jsx` wiring**

In `hifi/app.jsx`, find the existing `appIntegrationConnect` runtime API export. Add right after:

```js
        oauthGoogleStart: (input) => client.invoke('shogun_oauth_google_start', input),
```

Find the action map entry for `integrations.connect` (or any `app_integration_*` entry). Add:

```js
          'oauth.google.start': api.oauthGoogleStart,
```

Find the `mockIpcInvoke` switch. Add a stub case (used in browser-only Hi-Fi preview):

```js
    case 'shogun_oauth_google_start':
      return { ok: true, data: {
        ok: true,
        provider: input?.provider || 'gmail',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        refreshTokenPresent: true,
      } };
```

- [ ] **Step 6.4: `ipc-client.js` mock**

In `hifi/lib/ipc-client.js`, find a sensible spot near the `shogun_app_integration_*` cases or the very end of the switch. Add:

```js
      case "shogun_oauth_google_start": {
        // Mock: simulate a successful in-app OAuth flow without the actual
        // browser round-trip. Real backend launches a localhost server +
        // system browser; the mock just returns metadata immediately.
        return {
          ok: true,
          provider: (echo && echo.provider) || "gmail",
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/calendar.readonly",
          ],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          refreshTokenPresent: true,
        };
      }
```

- [ ] **Step 6.5: Verify static checks**

```bash
npm run check:actions
npm run check:ipc-mock
```

Expected:
- `check:actions` lists `oauth.google.start`; pre-existing warnings persist.
- `check:ipc-mock` reports OK with the new count (was N, now N+1).

- [ ] **Step 6.6: Commit**

```bash
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/app.jsx hifi/lib/ipc-client.js
git commit -m "$(cat <<'EOF'
feat(oauth): wire oauth.google.start through the JS layer

Adds the action across shogun-api, action-registry, app.jsx (runtime
API + action map + mockIpcInvoke), and ipc-client.js. Mock returns a
fixed-shape success response for browser-only Hi-Fi preview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Settings UI rewire

**Why:** User-visible piece. Connect button switches to in-app OAuth, copy updates, and the not-configured modal is added.

**Files:**
- Modify: `hifi/settings-modal.jsx`

- [ ] **Step 7.1: Read the current state**

Search for the relevant region first:

```bash
grep -n "v1: In-app OAuth is not wired\|integrations.connect\|provider:'gmail'\|provider:'google_calendar'" hifi/settings-modal.jsx | head -20
```

Read the surrounding context (5-10 lines around each hit) to understand the structure.

- [ ] **Step 7.2: Update the pane subtitle**

Find the existing subtitle text:

```js
<Pane title="All Integrations" jp="連携" subtitle="v1: In-app OAuth is not wired. Google Calendar tokens can be imported by an external agent (Keychain); use Refresh / Sync below. Other Connect rows show an honest notice where applicable.">
```

Replace the `subtitle` prop value with:

```js
subtitle="In-app OAuth: Click Connect on Gmail / Google Calendar to start the consent flow. CLIENT_ID/SECRET are read from scripts/.env.google-oauth (dev). For other providers, agent-based import is still supported (see legacy notes below)."
```

- [ ] **Step 7.3: Replace the Gmail Connect onClick**

Find the Gmail Connect button (search for `provider:'gmail'` near a `Connect` button, around line 2575 in current file). The current handler is something like:

```js
<button className="btn btn-sm btn-secondary" type="button" onClick={() => run('integrations.connect', { provider:'gmail' }, { silentError:true })}>Connect</button>
```

Replace with:

```js
<button
  className="btn btn-sm btn-secondary"
  type="button"
  disabled={oauthBusy}
  onClick={() => handleOauthConnect('gmail')}
>
  {oauthBusy === 'gmail' ? (
    <>
      <span className="en-only">Connecting…</span>
      <span className="jp">接続中…</span>
    </>
  ) : (
    <>
      <span className="en-only">Connect</span>
      <span className="jp">接続</span>
    </>
  )}
</button>
```

Apply the same change to the Google Calendar Connect button (search for `provider:'google_calendar'` near a `Connect` button) — substitute `'google_calendar'` and `oauthBusy === 'google_calendar'` accordingly.

- [ ] **Step 7.4: Add `oauthBusy` state and `handleOauthConnect` helper**

Find the React state cluster near the top of the integrations pane component (search via `grep -n "useState\|integrations" hifi/settings-modal.jsx | head -10`). Add a new state and helper near where Gmail/Calendar status is loaded:

```js
  const [oauthBusy, setOauthBusy] = React.useState(null); // null | 'gmail' | 'google_calendar'
  const [oauthNotConfigured, setOauthNotConfigured] = React.useState(false);

  const handleOauthConnect = async (provider) => {
    setOauthBusy(provider);
    try {
      const res = await runRuntimeActionA('oauth.google.start', { provider }, { silentError: true });
      if (!res?.ok) {
        const msg = String(res?.error || '');
        if (msg.startsWith('oauth_credentials_not_configured')) {
          setOauthNotConfigured(true);
        } else {
          const friendly = mapOauthError(msg);
          window.SHOGUN_RUNTIME?.pushToast?.(friendly, 'warn');
        }
        return;
      }
      const label = provider === 'gmail' ? 'Gmail' : 'Google Calendar';
      window.SHOGUN_RUNTIME?.pushToast?.(`Connected to ${label}`, 'success');
      // Refresh both statuses (a single OAuth grants both providers).
      await Promise.all([
        runRuntimeActionA('integrations.credentials_status', { provider: 'gmail' }, { silentError: true }),
        runRuntimeActionA('integrations.credentials_status', { provider: 'google_calendar' }, { silentError: true }),
      ]);
    } finally {
      setOauthBusy(null);
    }
  };

  const mapOauthError = (raw) => {
    if (raw.startsWith('oauth_token_exchange_failed:')) {
      const parts = raw.split(':');
      const status = parts[1] || '?';
      const code = parts[2] || '?';
      return `Token exchange failed [${status} ${code}]. Check CLIENT_SECRET.`;
    }
    if (raw === 'oauth_user_cancelled') return 'OAuth was cancelled';
    if (raw === 'oauth_state_mismatch') return 'Security check failed; please try again';
    if (raw === 'oauth_timeout') return 'OAuth timed out. Try again.';
    if (raw === 'oauth_port_busy') return 'Already connecting — please wait or restart';
    if (raw === 'oauth_already_in_progress') return 'Already connecting';
    if (raw === 'oauth_network_error') return 'Network error during token exchange';
    if (raw === 'oauth_invalid_provider') return 'Invalid provider';
    return `OAuth failed: ${raw}`;
  };
```

(Place before the existing `return (` of the integrations pane component. The exact line depends on the file structure — search for `<Pane title="All Integrations"` and add immediately above.)

The `runRuntimeActionA` global is defined in `hifi/screens-a.jsx` and available in this file (it's loaded as a global via the script-tag order). Confirm via `grep -n "function runRuntimeActionA" hifi/screens-a.jsx`.

- [ ] **Step 7.5: Add the not-configured modal**

Inside the integrations pane render output, near the bottom (just before the closing `</Pane>` or wherever modals are placed), add:

```jsx
{oauthNotConfigured && (
  <div
    role="dialog"
    aria-modal="true"
    style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }}
    onClick={() => setOauthNotConfigured(false)}
  >
    <div
      style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 24, maxWidth: 520, color: 'var(--text)',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>
        <span className="en-only">OAuth credentials not configured</span>
        <span className="jp">OAuth 認証情報が未設定</span>
      </h3>
      <p style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-mute)' }}>
        <span className="en-only">
          The file <code>scripts/.env.google-oauth</code> is missing or empty. To enable in-app OAuth:
        </span>
        <span className="jp">
          <code>scripts/.env.google-oauth</code> が見つかりません。アプリ内 OAuth を有効にするには:
        </span>
      </p>
      <pre style={{
        background: 'var(--surface-mute)', padding: 12, borderRadius: 4,
        fontSize: 12, fontFamily: 'var(--font-mono)', overflowX: 'auto',
      }}>
{`cp scripts/.env.google-oauth.example scripts/.env.google-oauth
# Then fill CLIENT_ID and CLIENT_SECRET from Google Cloud Console.`}
      </pre>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={() => {
            navigator.clipboard?.writeText('cp scripts/.env.google-oauth.example scripts/.env.google-oauth');
            window.SHOGUN_RUNTIME?.pushToast?.('Command copied', 'success');
          }}
        >
          <span className="en-only">Copy command</span>
          <span className="jp">コマンドをコピー</span>
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setOauthNotConfigured(false)}
        >
          <span className="en-only">Close</span>
          <span className="jp">閉じる</span>
        </button>
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 7.6: Update the OAuth Setup drawer copy**

Find the existing OAuth Setup drawer (search via `grep -n "OAuth Setup\|Get OAuth access token" hifi/settings-modal.jsx`). It contains a numbered 1) 2) 3) workflow.

Above the existing `1)` line, add a new line that points to the in-app flow:

```jsx
<div className="s-field-hint" style={{ marginBottom: 8 }}>
  <span className="en-only">In-app: click Connect above. This drawer is for the agent-based fallback (production / multi-user, when scripts/.env.google-oauth is unavailable).</span>
  <span className="jp">アプリ内: 上の Connect を押す。このドロワは agent 経由の代替手順 (本番 / 複数ユーザ、scripts/.env.google-oauth が使えない場合)。</span>
</div>
```

Find the corresponding section for Gmail and the one for Google Calendar (they may be duplicated — apply to both).

- [ ] **Step 7.7: Verify static checks**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke baseline (record current pass/fail counts; should be unchanged from preflight).

- [ ] **Step 7.8: Commit**

```bash
git add hifi/settings-modal.jsx
git commit -m "$(cat <<'EOF'
feat(oauth): rewire Settings → Integrations Connect to in-app OAuth

Gmail and Google Calendar Connect buttons now dispatch oauth.google.start
instead of the legacy honest-error integrations.connect. Added oauthBusy
state for the loading label, friendly toast on success/failure, and a
dedicated not-configured modal for the oauth_credentials_not_configured
error variant (most common for fresh dev setups).

The OAuth Setup drawer keeps its agent-based 1-2-3 workflow as a fallback
but now opens with a one-line note pointing users at the in-app Connect.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Playwright e2e

**Why:** Lock in the user-visible flow. Cluster precedent says these may be flaky due to React mount async; if so, fixme with the standard comment block.

**Files:**
- Create: `tests/e2e/oauth-tauri-integration.spec.js`

- [ ] **Step 8.1: Write the spec**

Create `tests/e2e/oauth-tauri-integration.spec.js`:

```js
const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function openIntegrationsPane(page) {
  // The Settings modal opens via the user-pill menu → Settings → Integrations.
  await page.locator('.user-pill').click();
  await page.locator('.user-float').getByText('Settings', { exact: true }).click();
  await expect(page.locator('.s-modal')).toBeVisible();
  // Click the Integrations nav row inside the settings modal.
  await page.getByRole('button', { name: 'Integrations' }).click();
}

test.describe('OAuth Tauri integration (Settings → Integrations)', () => {
  test('Gmail Connect → mock IPC → success toast', async ({ page }) => {
    await openHiFi(page);
    await openIntegrationsPane(page);

    // The mock IPC returns ok: true synchronously.
    await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
    await expect(page.locator('text=Connected to Gmail')).toBeVisible({ timeout: 5000 });
  });

  test('Google Calendar Connect → mock IPC → success toast', async ({ page }) => {
    await openHiFi(page);
    await openIntegrationsPane(page);

    // Find the second Connect button (Google Calendar row); the order of
    // Gmail vs Calendar in the pane is stable in current settings-modal.jsx.
    const buttons = page.getByRole('button', { name: 'Connect', exact: true });
    await buttons.nth(1).click();
    await expect(page.locator('text=Connected to Google Calendar')).toBeVisible({ timeout: 5000 });
  });
});
```

- [ ] **Step 8.2: Run the spec**

```bash
npx playwright test tests/e2e/oauth-tauri-integration.spec.js --reporter=line
```

Expected ideally: 2 passed.

If any test fails for the same async-mount race that blocks Phase 4 cluster e2e tests, fixme with this comment block above the first fixme'd test:

```js
  // The N tests below are marked test.fixme due to an inherent race in the
  // Settings modal mount + first IPC settling. Same root cause as the
  // Phase 4 cluster + summary-edit e2e tests in earlier branches.
  //
  // Resolution path: expose a test-only hook (e.g.
  // window.__SHOGUN_TEST__.waitForSettings()) that returns a Promise
  // resolving when the Settings modal's first render completes. Once that
  // hook exists, swap each test.fixme back to test.
```

If only some tests fail, fixme just those.

- [ ] **Step 8.3: Run the full suite**

```bash
npx playwright test --reporter=line
```

Expected: previous baseline + new tests passing or fixme'd as documented.

- [ ] **Step 8.4: Commit**

```bash
git add tests/e2e/oauth-tauri-integration.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): oauth tauri integration

Click Gmail / Google Calendar Connect → mock IPC → success toast asserts
the wiring without hitting any real OAuth endpoint. The mock returns
ok: true synchronously so this test should be deterministic; if the
async-mount race surfaces (cluster precedent), individual tests are
test.fixme'd with the standard comment block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Adjust the commit message if any tests are fixme'd.)

---

## Task 9: Final verification + branch review

- [ ] **Step 9.1: All checks**

```bash
npm run check:actions
npm run check:ipc-mock
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow
cargo test --manifest-path src-tauri/Cargo.toml --lib oauth_flow -- --ignored
npx playwright test --reporter=line
```

Expected:
- ipc-mock OK with the new count (+1).
- check:actions lists `oauth.google.start`; pre-existing warnings unchanged.
- cargo check warnings only.
- 16 default oauth_flow tests pass; 1 ignored (passes or skips with SKIP).
- Playwright: baseline + 2 new tests (passing or fixme'd).

- [ ] **Step 9.2: Manual smoke**

```bash
npm run dev:desktop
```

Steps in the running app:

1. Verify `<repo>/scripts/.env.google-oauth` exists and is filled.
2. Open Settings (user pill → Settings) → Integrations.
3. Click Gmail "Connect" → system browser opens to Google's consent → grant access → app shows "Connected to Gmail" toast.
4. Refresh the integrations pane (close + reopen) → Gmail status row shows tokenRefreshReady: true.
5. Click Google Calendar "Connect" → no browser this time (the previous OAuth's tokens already cover both). Toast still says "Connected to Google Calendar". Status row updates.
6. Delete `scripts/.env.google-oauth`. Click Gmail "Connect" → not-configured modal appears with copy-able command. Click Copy command → confirm clipboard contains `cp scripts/.env.google-oauth.example scripts/.env.google-oauth`.
7. Restore `scripts/.env.google-oauth`. Click Gmail "Connect" twice in rapid succession → second click is no-op (button disabled mid-flight) OR returns `oauth_already_in_progress` toast.

- [ ] **Step 9.3: Branch summary**

```bash
git log --oneline b4d06b5..HEAD
git diff --stat b4d06b5..HEAD
```

Confirm:
- ~9-12 commits across 8 implementation tasks + the spec/plan commits.
- Files changed match the File Structure table.

- [ ] **Step 9.4: Final dispatch**

After all 8 tasks pass spec + code-quality reviews, dispatch a **branch-level final reviewer** via `superpowers:code-reviewer`. Provide the cumulative diff `b4d06b5..HEAD`. Address any Important issues before invoking `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- § 1 Architecture & data flow — Tasks 1, 2, 3, 4, 5 (backend) + 6, 7 (frontend) ✓
- § 2 Secrets & logging — Task 1 (mask_secret) + Task 3 (token-exchange logging) + Task 5 (return shape excludes tokens) ✓
- § 3 UI — Task 7 ✓
- § 4 Error handling:
  - All 12 error rows mapped to either an `OauthError` variant (Task 1) or a `mapOauthError` branch (Task 7) ✓
  - In-flight mutex (Task 4) + button disabled state (Task 7) ✓
- § 5 Testing:
  - Rust unit tests for parse_env, mask_secret, build_auth_url, parse_callback_query, exchange_code (Tasks 1-3) ✓
  - Integration test for run() (Task 4, ignored) ✓
  - Frontend e2e (Task 8) ✓
  - Static checks across tasks (Tasks 1, 5, 6, 7, 9) ✓
- § 6 Rollout — no flag, no migration; covered implicitly ✓

**Placeholder scan:** No "TBD", "FIXME", "as appropriate", "etc." in any task body.

**Type / API consistency:**
- `OauthError`, `OauthTokens`, `CallbackOutcome` defined Task 1, used Tasks 4, 5.
- `oauth_flow::run` signature matches Task 4 definition + Task 5 caller.
- `parse_env` / `load_env_from_disk` distinct names with consistent meaning.
- IPC name `oauth.google.start` consistent across Tasks 5, 6, 7, 8.
- Mock payload shape (`ok`, `provider`, `scopes`, `expiresAt`, `refreshTokenPresent`) matches the Rust `Ok(json!({...}))` from Task 5.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-oauth-tauri-integration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
