//! Read-only Google Calendar sync into local memory index (Bearer token from integration_secrets).
//! Refreshes access tokens when `oauthClientId` + `refreshToken` are stored (optional `oauthClientSecret`).

use crate::{google_oauth, integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};

const PROVIDER: &str = "google_calendar";

fn not_configured_msg() -> String {
    "Google Calendar is not configured. Import credentials via app_integration_import_credentials."
        .to_string()
}

/// Whether a stored credentials document can refresh Google access tokens (`refreshToken` + `oauthClientId`).
pub fn credentials_can_refresh(doc: &Value) -> bool {
    google_oauth::credentials_can_refresh(doc)
}

async fn calendar_events_request(
    token: &str,
    cal: &str,
    max_results: usize,
    past_days: u32,
) -> Result<(StatusCode, String), String> {
    let past_days = past_days as i64;
    let time_min = if past_days > 0 {
        (Utc::now() - Duration::days(past_days))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string()
    } else {
        Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
    };
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

    let max_s = max_results.to_string();
    let resp = client
        .get(&url)
        .query(&[
            ("singleEvents", "true"),
            ("orderBy", "startTime"),
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
            ("maxResults", max_s.as_str()),
        ])
        .header("Authorization", format!("Bearer {}", token.trim()))
        .send()
        .await
        .map_err(|e| format!("Calendar request failed: {}", e))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn ingest_event_items(items: &[Value], max_results: usize) -> Result<(u32, u32), String> {
    let mut ingested = 0u32;
    let mut skipped = 0u32;
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
        let link = item.get("htmlLink").and_then(|v| v.as_str()).unwrap_or("");
        let ev_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let snippet = format!("Google Calendar · {} · {}", start, link);
        let mut ing = json!({
          "title": format!("Calendar: {}", title),
          "snippet": snippet.chars().take(4000).collect::<String>(),
          "source": "google_calendar",
          "kinds": ["calendar"],
          "provenance": "connector",
        });
        if !ev_id.is_empty() {
            ing["entity_id"] = json!(ev_id);
        }
        let out = memory_store::ingest(&ing)?;
        if out
            .get("skipped")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            skipped += 1;
        } else {
            ingested += 1;
        }
    }
    Ok((ingested, skipped))
}

pub async fn sync_events_to_memory(
    calendar_id: &str,
    max_results: usize,
    past_days: u32,
) -> Result<Value, String> {
    let mut creds =
        integration_secrets::get_credentials(PROVIDER)?.ok_or_else(not_configured_msg)?;

    google_oauth::maybe_refresh_credentials(PROVIDER, &mut creds).await?;

    let cal = if calendar_id.trim().is_empty() {
        "primary"
    } else {
        calendar_id.trim()
    };

    let mut token = google_oauth::access_token_from_doc(&creds)?;
    let (status, text) = calendar_events_request(&token, cal, max_results, past_days).await?;

    let (status, text) =
        if status == StatusCode::UNAUTHORIZED && google_oauth::credentials_can_refresh(&creds) {
            log::warn!("Google Calendar API 401; attempting token refresh");
            let refreshed = google_oauth::refresh_access_token(&creds).await?;
            integration_secrets::set_credentials(PROVIDER, &refreshed)?;
            creds = refreshed;
            token = google_oauth::access_token_from_doc(&creds)?;
            calendar_events_request(&token, cal, max_results, past_days).await?
        } else {
            (status, text)
        };

    if !status.is_success() {
        let snippet: String = text.chars().take(600).collect();
        return Err(format!("Google Calendar API {}: {}", status, snippet));
    }

    let body: Value = serde_json::from_str(&text).map_err(|e| {
        format!(
            "Invalid Calendar JSON: {} — {}",
            e,
            text.chars().take(200).collect::<String>()
        )
    })?;

    let items = body
        .get("items")
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    let (ingested, skipped) = ingest_event_items(&items, max_results)?;

    Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "calendarId": cal,
      "pastDays": past_days,
      "stub": false,
    }))
}
