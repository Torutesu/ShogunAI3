//! Read-only Outlook / Microsoft 365 mail sync via Microsoft Graph.
//! Token: OAuth access token with `Mail.Read` (paste via integration import).

use crate::{integration_secrets, memory_store};
use chrono::{DateTime, Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "outlook";
const API_BASE: &str = "https://graph.microsoft.com/v1.0";
const MESSAGE_CAP: usize = 500;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct OutlookSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<OutlookSyncState> = Mutex::new(OutlookSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> OutlookSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn not_configured_msg() -> String {
  "Outlook is not configured. Import credentials via app_integration_import_credentials with provider \"outlook\" and `accessToken` (Microsoft Graph OAuth token with Mail.Read)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
  doc
    .get("accessToken")
    .and_then(|v| v.as_str())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

async fn graph_get(
  token: &str,
  endpoint: &str,
  query: &[(&str, String)],
) -> Result<(StatusCode, String), String> {
  let url = format!("{API_BASE}/{endpoint}");
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())?;
  let resp = client
    .get(&url)
    .query(query)
    .header("Authorization", format!("Bearer {}", token))
    .send()
    .await
    .map_err(|e| format!("Graph {} request failed: {}", endpoint, e))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| e.to_string())?;
  Ok((status, text))
}

fn parse_graph_datetime(raw: &str) -> Option<DateTime<Utc>> {
  DateTime::parse_from_rfc3339(raw)
    .ok()
    .map(|d| d.with_timezone(&Utc))
}

fn ingest_message(item: &Value) -> Result<bool, String> {
  let id = item
    .get("id")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim();
  if id.is_empty() {
    return Ok(false);
  }
  let subject = item
    .get("subject")
    .and_then(|v| v.as_str())
    .unwrap_or("(no subject)");
  let preview = item
    .get("bodyPreview")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let from = item
    .pointer("/from/emailAddress/address")
    .and_then(|v| v.as_str())
    .unwrap_or("unknown");
  let received = item
    .get("receivedDateTime")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let snippet = format!(
    "From: {}\nReceived: {}\n\n{}",
    from,
    received,
    preview.chars().take(4000).collect::<String>()
  );
  let payload = json!({
    "title": format!("Outlook: {}", subject.chars().take(200).collect::<String>()),
    "snippet": snippet,
    "source": PROVIDER,
    "entity_id": id,
    "provenance": "connector",
    "kinds": ["mail"],
  });
  match memory_store::ingest(&payload) {
    Ok(v) => Ok(v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false)),
    Err(e) => {
      let _ = crate::dead_letter::record(PROVIDER, &payload, &e);
      Err(e)
    }
  }
}

pub async fn sync_mail_to_memory(
  days: Option<u32>,
  max_messages: usize,
) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;
  let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

  let window_days = days.unwrap_or(30).min(366);
  let cutoff = Utc::now() - Duration::days(window_days as i64);
  let cap = max_messages.clamp(1, MESSAGE_CAP);

  let mut ingested: u32 = 0;
  let mut skipped: u32 = 0;
  let mut next_link: Option<String> = None;
  crate::progress_emitter::emit(PROVIDER, 0, Some(cap as u64), "list");

  loop {
    let (status, text) = if let Some(url) = &next_link {
      let client = reqwest::Client::new();
      let resp = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
      (resp.status(), resp.text().await.map_err(|e| e.to_string())?)
    } else {
      graph_get(
        &token,
        "me/messages",
        &[
          ("$top", "50".to_string()),
          (
            "$select",
            "id,subject,bodyPreview,receivedDateTime,from".to_string(),
          ),
          ("$orderby", "receivedDateTime desc".to_string()),
        ],
      )
      .await?
    };

    if !status.is_success() {
      let clip: String = text.chars().take(400).collect();
      let err = format!("Outlook Graph HTTP {}: {}", status, clip);
      if let Ok(mut s) = STATE.lock() {
        s.last_error = Some(err.clone());
      }
      return Err(err);
    }

    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Outlook JSON: {}", e))?;
    let items = v
      .get("value")
      .and_then(|x| x.as_array())
      .cloned()
      .unwrap_or_default();
    if items.is_empty() {
      break;
    }

    let mut stop_paging = false;
    for item in items.iter() {
      let received = item
        .get("receivedDateTime")
        .and_then(|x| x.as_str())
        .and_then(parse_graph_datetime);
      if let Some(dt) = received {
        if dt < cutoff {
          stop_paging = true;
          break;
        }
      }
      match ingest_message(item) {
        Ok(true) => skipped += 1,
        Ok(false) => ingested += 1,
        Err(e) => log::warn!("Outlook ingest failed: {}", e),
      }
      if (ingested as usize) >= cap {
        stop_paging = true;
        break;
      }
    }

    if stop_paging {
      break;
    }

    next_link = v
      .get("@odata.nextLink")
      .and_then(|x| x.as_str())
      .map(String::from);
    if next_link.is_none() {
      break;
    }
  }

  crate::progress_emitter::emit(PROVIDER, ingested as u64, Some(cap as u64), "done");
  let elapsed_ms = start.elapsed().as_millis() as u64;
  if let Ok(mut s) = STATE.lock() {
    s.last_sync_ms = Some(now_ms());
    s.last_ingested = Some(ingested as u64);
    s.last_duration_ms = Some(elapsed_ms);
    s.last_error = None;
  }

  Ok(json!({
    "ingested": ingested,
    "skipped": skipped,
    "provider": PROVIDER,
    "windowDays": window_days,
    "elapsedMs": elapsed_ms,
  }))
}
