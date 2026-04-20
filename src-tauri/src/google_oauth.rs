//! Shared Google OAuth token refresh for integration credentials (Calendar, Gmail, …).

use crate::integration_secrets;
use chrono::Utc;
use serde_json::{json, Value};

pub fn access_token_from_doc(doc: &Value) -> Result<String, String> {
  doc
    .get("accessToken")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string())
    .ok_or_else(|| "Missing accessToken in stored credentials".to_string())
}

pub fn credentials_can_refresh(doc: &Value) -> bool {
  let refresh = doc
    .get("refreshToken")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  let client_id = doc
    .get("oauthClientId")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty());
  refresh.is_some() && client_id.is_some()
}

fn expires_at_unix_secs(doc: &Value) -> Option<i64> {
  let v = doc.get("expiresAt")?;
  let n = v.as_i64().or_else(|| v.as_u64().map(|u| u as i64))?;
  if n > 9_999_999_999 {
    Some(n / 1000)
  } else {
    Some(n)
  }
}

fn should_refresh(doc: &Value) -> bool {
  let Some(exp) = expires_at_unix_secs(doc) else {
    return false;
  };
  let now = Utc::now().timestamp();
  now >= exp - 120
}

pub async fn refresh_access_token(doc: &Value) -> Result<Value, String> {
  let refresh = doc
    .get("refreshToken")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "refreshToken required for token refresh".to_string())?;
  let client_id = doc
    .get("oauthClientId")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "oauthClientId required for token refresh".to_string())?;
  let client_secret = doc
    .get("oauthClientSecret")
    .and_then(|t| t.as_str())
    .unwrap_or("");

  let body = format!(
    "client_id={}&client_secret={}&refresh_token={}&grant_type=refresh_token",
    urlencoding::encode(client_id),
    urlencoding::encode(client_secret),
    urlencoding::encode(refresh),
  );

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| e.to_string())?;

  let resp = client
    .post("https://oauth2.googleapis.com/token")
    .header(
      "Content-Type",
      "application/x-www-form-urlencoded; charset=utf-8",
    )
    .body(body)
    .send()
    .await
    .map_err(|e| format!("Token refresh request failed: {}", e))?;

  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  if !status.is_success() {
    let snippet: String = text.chars().take(400).collect();
    return Err(format!("Google OAuth token endpoint {}: {}", status, snippet));
  }

  let body: Value =
    serde_json::from_str(&text).map_err(|e| format!("Invalid token JSON: {}", e))?;
  let access = body
    .get("access_token")
    .and_then(|t| t.as_str())
    .ok_or_else(|| "token response missing access_token".to_string())?;
  let expires_in = body
    .get("expires_in")
    .and_then(|v| v.as_u64())
    .or_else(|| body.get("expires_in").and_then(|v| v.as_i64()).map(|i| i as u64))
    .unwrap_or(3600);
  let now = Utc::now().timestamp();
  let exp_secs = now.saturating_add(expires_in as i64);

  let mut new_doc = doc.clone();
  new_doc["accessToken"] = json!(access);
  new_doc["expiresAt"] = json!(exp_secs);
  if let Some(nr) = body.get("refresh_token").and_then(|t| t.as_str()) {
    if !nr.trim().is_empty() {
      new_doc["refreshToken"] = json!(nr);
    }
  }

  Ok(new_doc)
}

pub async fn maybe_refresh_credentials(provider: &str, doc: &mut Value) -> Result<(), String> {
  if !should_refresh(doc) || !credentials_can_refresh(doc) {
    return Ok(());
  }
  let refreshed = refresh_access_token(doc).await?;
  integration_secrets::set_credentials(provider, &refreshed)?;
  *doc = refreshed;
  log::info!("Google OAuth access token refreshed for {} (proactive)", provider);
  Ok(())
}
