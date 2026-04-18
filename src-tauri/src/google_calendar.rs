//! Read-only Google Calendar sync into local memory index (Bearer token from integration_secrets).

use crate::{integration_secrets, memory_store};
use chrono::{Duration, Utc};
use serde_json::{json, Value};

pub async fn sync_events_to_memory(calendar_id: &str, max_results: usize) -> Result<Value, String> {
  let token = integration_secrets::access_token("google_calendar")?
    .filter(|t| !t.trim().is_empty())
    .ok_or_else(|| {
      "Google Calendar is not configured. Import credentials via app_integration_import_credentials."
        .to_string()
    })?;

  let cal = if calendar_id.trim().is_empty() {
    "primary"
  } else {
    calendar_id.trim()
  };

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

  Ok(json!({
    "ingested": ingested,
    "calendarId": cal,
    "stub": false,
  }))
}
