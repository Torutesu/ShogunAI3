//! Read-only Google Drive sync into local memory. Uses the shared Google
//! OAuth token stored under provider slug `google_drive` (scope:
//! `https://www.googleapis.com/auth/drive.readonly`).
//!
//! Lists files modified within the requested window and ingests each with
//! `source: "google_drive"`, `entity_id: <file_id>`,
//! `provenance: "connector"`. Google Docs / Sheets / Slides have their text
//! exported and stored as the snippet; other file types record metadata only
//! (a minimal body keeps ingest fast and avoids pulling binary content).

use crate::{google_oauth, integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "google_drive";
const API_BASE: &str = "https://www.googleapis.com/drive/v3";
const FILE_HARD_CAP: usize = 3000;
const PAGE_SIZE: u32 = 100;
/// Max characters of exported text to keep per file (snippet is clipped
/// again to 4000 by `memory_store::ingest`; a higher ceiling here lets us
/// preserve sentence boundaries before the clip).
const EXPORT_TEXT_CAP: usize = 8000;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct DriveSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<DriveSyncState> = Mutex::new(DriveSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> DriveSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn not_configured_msg() -> String {
  "Google Drive is not configured. Import credentials via app_integration_import_credentials with provider \"google_drive\" (OAuth access token; scope: https://www.googleapis.com/auth/drive.readonly)."
    .to_string()
}

fn http_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())
}

async fn drive_get(
  token: &str,
  endpoint: &str,
  query: &[(&str, String)],
) -> Result<(StatusCode, String), String> {
  let url = format!("{API_BASE}/{endpoint}");
  let client = http_client()?;
  let mut attempt: u32 = 0;
  loop {
    attempt += 1;
    let resp = client
      .get(&url)
      .query(query)
      .header("Authorization", format!("Bearer {}", token))
      .send()
      .await
      .map_err(|e| format!("Drive {} request failed: {}", endpoint, e))?;
    let status = resp.status();
    if status.is_success() || attempt >= crate::http_retry::DEFAULT_MAX_ATTEMPTS {
      let text = resp.text().await.map_err(|e| e.to_string())?;
      return Ok((status, text));
    }
    match crate::http_retry::next_retry_delay(
      status,
      resp.headers(),
      attempt,
      crate::http_retry::DEFAULT_BASE_DELAY_MS,
      crate::http_retry::DEFAULT_MAX_DELAY_MS,
    ) {
      Some(delay) => {
        let _ = resp.bytes().await;
        tokio::time::sleep(delay).await;
      }
      None => {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        return Ok((status, text));
      }
    }
  }
}

/// Returns plain-text body for Google editor file types, or an empty string
/// for binaries / unknown types.
async fn export_file_text(token: &str, file_id: &str, mime_type: &str) -> String {
  let export_mime = match mime_type {
    "application/vnd.google-apps.document"
    | "application/vnd.google-apps.spreadsheet"
    | "application/vnd.google-apps.presentation" => "text/plain",
    _ => return String::new(),
  };
  let endpoint = format!(
    "files/{}/export",
    urlencoding::encode(file_id),
  );
  let query: Vec<(&str, String)> = vec![("mimeType", export_mime.to_string())];
  let (status, text) = match drive_get(token, &endpoint, &query).await {
    Ok(r) => r,
    Err(e) => {
      log::warn!("Drive export failed for {}: {}", file_id, e);
      return String::new();
    }
  };
  if !status.is_success() {
    log::warn!("Drive export HTTP {} for {}", status, file_id);
    return String::new();
  }
  text.chars().take(EXPORT_TEXT_CAP).collect()
}

fn ingest_drive_file(file: &Value, body_text: &str) -> Result<(), String> {
  let id = file.get("id").and_then(|x| x.as_str()).unwrap_or("");
  if id.is_empty() {
    return Ok(());
  }
  let name = file.get("name").and_then(|x| x.as_str()).unwrap_or("(untitled)");
  let mime = file.get("mimeType").and_then(|x| x.as_str()).unwrap_or("");
  let web_link = file.get("webViewLink").and_then(|x| x.as_str()).unwrap_or("");
  let modified = file.get("modifiedTime").and_then(|x| x.as_str()).unwrap_or("");
  let owner = file
    .pointer("/owners/0/displayName")
    .and_then(|x| x.as_str())
    .unwrap_or("");

  let short_kind = if mime.starts_with("application/vnd.google-apps.") {
    mime
      .trim_start_matches("application/vnd.google-apps.")
      .to_string()
  } else {
    mime.to_string()
  };

  let title = format!("Drive: {}", name);
  let mut snippet = format!(
    "{}\nkind: {} · owner: {} · modified: {}",
    web_link, short_kind, owner, modified,
  );
  if !body_text.is_empty() {
    snippet.push_str("\n\n");
    snippet.push_str(body_text);
  }

  let ing = json!({
    "title": title.chars().take(220).collect::<String>(),
    "snippet": snippet.chars().take(4000).collect::<String>(),
    "source": "google_drive",
    "kinds": ["doc"],
    "provenance": "connector",
    "entity_id": id,
  });
  if let Err(e) = memory_store::ingest(&ing) {
    let _ = crate::dead_letter::record("google_drive", &ing, &e);
    return Err(e);
  }
  Ok(())
}

/// Top-level sync. Filters files by `modifiedTime > cutoff`, fetches text
/// snippet for Google editor files, and ingests each into memory.
pub async fn sync_drive_to_memory(
  days: Option<u32>,
  max_files: usize,
) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let mut creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;
  google_oauth::maybe_refresh_credentials(PROVIDER, &mut creds).await?;
  let token = google_oauth::access_token_from_doc(&creds)?;

  let window_days = days.unwrap_or(30).min(366);
  let cutoff = Utc::now() - Duration::days(window_days as i64);
  let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%SZ").to_string();
  let cap = max_files.clamp(1, FILE_HARD_CAP);

  let q_expr = format!(
    "trashed = false and modifiedTime > '{}'",
    cutoff_iso,
  );
  let fields = "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, owners(displayName))";

  let mut page_token: Option<String> = None;
  let mut ingested: u32 = 0;
  let mut considered: u32 = 0;
  crate::progress_emitter::emit("google_drive", 0, Some(cap as u64), "list");

  loop {
    let mut query: Vec<(&str, String)> = vec![
      ("q", q_expr.clone()),
      ("orderBy", "modifiedTime desc".to_string()),
      ("pageSize", PAGE_SIZE.to_string()),
      ("fields", fields.to_string()),
      ("spaces", "drive".to_string()),
    ];
    if let Some(t) = page_token.as_ref() {
      query.push(("pageToken", t.clone()));
    }
    let (status, text) = drive_get(&token, "files", &query).await?;
    if !status.is_success() {
      let clip: String = text.chars().take(400).collect();
      let err = format!("Drive HTTP {}: {}", status, clip);
      if let Ok(mut s) = STATE.lock() {
        s.last_error = Some(err.clone());
      }
      return Err(err);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Drive JSON: {}", e))?;
    let files = v
      .get("files")
      .and_then(|x| x.as_array())
      .cloned()
      .unwrap_or_default();
    if files.is_empty() {
      break;
    }

    for file in files.iter() {
      considered += 1;
      let file_id = file.get("id").and_then(|x| x.as_str()).unwrap_or("");
      let mime = file.get("mimeType").and_then(|x| x.as_str()).unwrap_or("");
      let body = if !file_id.is_empty() {
        export_file_text(&token, file_id, mime).await
      } else {
        String::new()
      };
      match ingest_drive_file(file, &body) {
        Ok(()) => ingested += 1,
        Err(e) => log::warn!("Drive ingest failed: {}", e),
      }
      if (ingested as usize) >= cap {
        break;
      }
    }
    if (ingested as usize) >= cap {
      break;
    }
    page_token = v
      .get("nextPageToken")
      .and_then(|x| x.as_str())
      .map(|s| s.to_string());
    if page_token.is_none() {
      break;
    }
    crate::progress_emitter::emit("google_drive", ingested as u64, Some(cap as u64), "pages");
  }
  crate::progress_emitter::emit("google_drive", ingested as u64, Some(cap as u64), "done");

  let elapsed_ms = start.elapsed().as_millis() as u64;
  crate::memory_obs::emit(
    "drive_sync_done",
    &[
      ("ingested", ingested.to_string()),
      ("considered", considered.to_string()),
      ("days", window_days.to_string()),
      ("elapsed_ms", elapsed_ms.to_string()),
    ],
  );
  if let Ok(mut s) = STATE.lock() {
    s.last_sync_ms = Some(now_ms());
    s.last_ingested = Some(ingested as u64);
    s.last_error = None;
    s.last_duration_ms = Some(elapsed_ms);
  }
  Ok(json!({
    "ingested": ingested,
    "considered": considered,
    "days": window_days,
    "stub": false,
  }))
}
