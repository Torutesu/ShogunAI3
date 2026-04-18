//! Read-only Google Calendar sync into local memory index (Bearer token from integration_secrets).
//! Refreshes access tokens when `oauthClientId` + `refreshToken` are stored (optional `oauthClientSecret`).

use crate::{integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};

const PROVIDER: &str = "google_calendar";

fn not_configured_msg() -> String {
  "Google Calendar is not configured. Import credentials via app_integration_import_credentials."
    .to_string()
}

fn access_token_from_doc(doc: &Value) -> Result<String, String> {
  doc
    .get("accessToken")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string())
    .ok_or_else(|| "Missing accessToken in stored credentials".to_string())
}

fn can_refresh(doc: &Value) -> bool {
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

/// Whether a stored credentials document can refresh Google access tokens (`refreshToken` + `oauthClientId`).
pub fn credentials_can_refresh(doc: &Value) -> bool {
  can_refresh(doc)
}

/// Unix seconds for expiry; supports sec or ms in stored JSON.
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

async fn refresh_access_token(doc: &Value) -> Result<Value, String> {
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

async fn maybe_refresh_credentials(doc: &mut Value) -> Result<(), String> {
  if !should_refresh(doc) || !can_refresh(doc) {
    return Ok(());
  }
  let refreshed = refresh_access_token(doc).await?;
  integration_secrets::set_credentials(PROVIDER, &refreshed)?;
  *doc = refreshed;
  log::info!("Google Calendar access token refreshed (proactive)");
  Ok(())
}

async fn calendar_events_request(
  token: &str,
  cal: &str,
  max_results: usize,
) -> Result<(StatusCode, String), String> {
  let time_min = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
  let time_max = (Utc::now() + Duration::days(7))
    .format("%Y-%m-%dT%H:%M:%SZ")
    .to_string();

  let url = format!(
    "https://www.googleapis.com/calendar/v3/calendars/{}/events",
    urlencoding::encode(cal)
  );

  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;

  let resp = client
    .get(&url)
    .query(&[
      ("singleEvents", "true"),
      ("orderBy", "startTime"),
      ("timeMin", time_min.as_str()),
      ("timeMax", time_max.as_str()),
      ("maxResults", &max_results.to_string()),
    ])
    .header(
      "Authorization",
      format!("Bearer {}", token.trim()),
    )
    .send()
    .await
    .map_err(|e| format!("Calendar request failed: {}", e))?;

  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  Ok((status, text))
}

fn ingest_event_items(items: &[Value], max_results: usize) -> Result<u32, String> {
  let mut ingested = 0u32;
  for item in items.iter().take(max_results) {
    let title = item
      .get("summary")
      .and_then(|s| s.as_str())
      .unwrap_or("(no title)");
    let start = item
      .pointer("/start/dateTime")
      .or_else(|| item.pointer("/start/date"))
      .and_then(|v| v.as_str())
      .unwrap_or("");
    let link = item
      .get("htmlLink")
      .and_then(|v| v.as_str())
      .unwrap_or("");
    let snippet = format!("Google Calendar · {} · {}", start, link);
    memory_store::ingest(&json!({
      "title": format!("Calendar: {}", title),
      "snippet": snippet.chars().take(4000).collect::<String>(),
      "source": "google_calendar",
      "kinds": ["calendar"],
    }))?;
    ingested += 1;
  }
  Ok(ingested)
}

pub async fn sync_events_to_memory(calendar_id: &str, max_results: usize) -> Result<Value, String> {
  let mut creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;

  maybe_refresh_credentials(&mut creds).await?;

  let cal = if calendar_id.trim().is_empty() {
    "primary"
  } else {
    calendar_id.trim()
  };

  let mut token = access_token_from_doc(&creds)?;
  let (status, text) = calendar_events_request(&token, cal, max_results).await?;

  let (status, text) = if status == StatusCode::UNAUTHORIZED && can_refresh(&creds) {
    log::warn!("Google Calendar API 401; attempting token refresh");
    let refreshed = refresh_access_token(&creds).await?;
    integration_secrets::set_credentials(PROVIDER, &refreshed)?;
    creds = refreshed;
    token = access_token_from_doc(&creds)?;
    calendar_events_request(&token, cal, max_results).await?
  } else {
    (status, text)
  };

  if !status.is_success() {
    let snippet: String = text.chars().take(600).collect();
    return Err(format!("Google Calendar API {}: {}", status, snippet));
  }

  let body: Value = serde_json::from_str(&text)
    .map_err(|e| format!("Invalid Calendar JSON: {} — {}", e, text.chars().take(200).collect::<String>()))?;

  let items = body
    .get("items")
    .and_then(|i| i.as_array())
    .cloned()
    .unwrap_or_default();

  let ingested = ingest_event_items(&items, max_results)?;

  Ok(json!({
    "ingested": ingested,
    "calendarId": cal,
    "stub": false,
  }))
}
