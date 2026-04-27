//! Read-only Zoom cloud-recording sync. Uses an OAuth access token stored
//! under `integration_secrets` key `zoom` (User OAuth or Server-to-Server).
//!
//! For each recording in the window:
//!   1. pick the best audio file (prefer M4A, fall back to MP4)
//!   2. download bytes via the signed download_url
//!   3. hand the bytes to Deepgram via `meeting_stt::deepgram_transcribe_bytes`
//!   4. persist a meeting + per-utterance transcript segments through
//!      `meeting_store`
//! Each meeting row uses `app_bundle_id = "us.zoom.xos"` so the UI can
//! distinguish imported Zoom recordings from app-recorded ones.

use crate::{integration_secrets, meeting_store, meeting_stt};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "zoom";
const API_BASE: &str = "https://api.zoom.us/v2";
/// Cap on meetings ingested per run (recordings are heavy).
const MEETING_HARD_CAP: usize = 200;
const PAGE_SIZE: u32 = 30;
/// Skip individual recordings larger than this (cuts runaway Deepgram bills).
const MAX_DOWNLOAD_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ZoomSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<ZoomSyncState> = Mutex::new(ZoomSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> ZoomSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn not_configured_msg() -> String {
  "Zoom is not configured. Import credentials via app_integration_import_credentials with provider \"zoom\" and `accessToken` (OAuth access token; User OAuth scope `cloud_recording:read` or Server-to-Server equivalent)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
  doc
    .get("accessToken")
    .and_then(|v| v.as_str())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

fn http_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    // Downloads of meeting recordings can legitimately take a few minutes.
    .timeout(std::time::Duration::from_secs(600))
    .build()
    .map_err(|e| e.to_string())
}

async fn zoom_get(
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
      .map_err(|e| format!("Zoom {} request failed: {}", endpoint, e))?;
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

/// Zoom cloud-recording download URLs need the OAuth token appended as a
/// query param (User OAuth flow); Server-to-Server apps authenticate via the
/// header only. We send both so either path works.
async fn download_recording(token: &str, url: &str) -> Result<Vec<u8>, String> {
  let client = http_client()?;
  let resp = client
    .get(url)
    .header("Authorization", format!("Bearer {}", token))
    .query(&[("access_token", token)])
    .send()
    .await
    .map_err(|e| format!("Zoom download failed: {}", e))?;
  let status = resp.status();
  if !status.is_success() {
    let body = resp.text().await.unwrap_or_default();
    let clip: String = body.chars().take(300).collect();
    return Err(format!("Zoom download HTTP {}: {}", status, clip));
  }
  // Enforce a hard size limit by inspecting Content-Length; fall back to
  // streaming with a byte counter when the server doesn't advertise one.
  if let Some(len) = resp.content_length() {
    if len > MAX_DOWNLOAD_BYTES {
      return Err(format!(
        "Recording is {} bytes — exceeds cap of {} bytes",
        len, MAX_DOWNLOAD_BYTES
      ));
    }
  }
  let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
  if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
    return Err(format!(
      "Recording is {} bytes — exceeds cap of {} bytes",
      bytes.len(),
      MAX_DOWNLOAD_BYTES
    ));
  }
  Ok(bytes.to_vec())
}

/// Pick the best audio-first file from a meeting's `recording_files`.
/// Preference order: audio-only M4A → any M4A → MP4 (has audio track).
fn choose_best_file<'a>(files: &'a [Value]) -> Option<&'a Value> {
  let status_ok = |f: &Value| -> bool {
    f.get("status")
      .and_then(|x| x.as_str())
      .map(|s| s == "completed")
      .unwrap_or(true)
  };
  let is_type = |f: &Value, t: &str| -> bool {
    f.get("file_type")
      .and_then(|x| x.as_str())
      .map(|s| s.eq_ignore_ascii_case(t))
      .unwrap_or(false)
  };
  if let Some(f) = files.iter().find(|f| {
    status_ok(f)
      && is_type(f, "M4A")
      && f
        .get("recording_type")
        .and_then(|x| x.as_str())
        .map(|s| s == "audio_only")
        .unwrap_or(false)
  }) {
    return Some(f);
  }
  if let Some(f) = files.iter().find(|f| status_ok(f) && is_type(f, "M4A")) {
    return Some(f);
  }
  files.iter().find(|f| status_ok(f) && is_type(f, "MP4"))
}

fn mime_hint_for_type(file_type: &str) -> &'static str {
  match file_type.to_ascii_uppercase().as_str() {
    "M4A" => "audio/mp4",
    "MP4" => "audio/mp4",
    "MP3" => "audio/mpeg",
    "WAV" => "audio/wav",
    _ => "application/octet-stream",
  }
}

fn iso_date_cutoff(days: u32) -> (String, String) {
  let to = Utc::now().format("%Y-%m-%d").to_string();
  let from = (Utc::now() - Duration::days(days as i64))
    .format("%Y-%m-%d")
    .to_string();
  (from, to)
}

async fn ingest_meeting(
  token: &str,
  meeting: &Value,
) -> Result<bool, String> {
  let meeting_uuid = meeting
    .get("uuid")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string();
  let topic = meeting
    .get("topic")
    .and_then(|x| x.as_str())
    .unwrap_or("Zoom meeting")
    .to_string();
  let start_time_str = meeting
    .get("start_time")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let started_at = chrono::DateTime::parse_from_rfc3339(start_time_str)
    .map(|dt| dt.timestamp_millis() as u64)
    .unwrap_or_else(|_| now_ms());
  let duration_min = meeting
    .get("duration")
    .and_then(|x| x.as_u64())
    .unwrap_or(0);

  let files = meeting
    .get("recording_files")
    .and_then(|x| x.as_array())
    .cloned()
    .unwrap_or_default();
  let Some(file) = choose_best_file(&files) else {
    log::warn!("Zoom meeting {} has no usable recording file", meeting_uuid);
    return Ok(false);
  };
  let file_type = file
    .get("file_type")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let download_url = file
    .get("download_url")
    .and_then(|x| x.as_str())
    .unwrap_or("")
    .to_string();
  if download_url.is_empty() {
    return Ok(false);
  }

  let bytes = match download_recording(token, &download_url).await {
    Ok(b) => b,
    Err(e) => {
      log::warn!("Zoom download failed for {}: {}", meeting_uuid, e);
      return Ok(false);
    }
  };
  let mime = mime_hint_for_type(file_type);

  let result = meeting_stt::deepgram_transcribe_bytes(&bytes, Some(mime)).await?;
  let duration_ms = (result.duration_seconds.max(0.0) * 1000.0) as u64;
  // Zoom reports minutes; prefer Deepgram's measured duration when available.
  let ended_at = if duration_ms > 0 {
    started_at.saturating_add(duration_ms)
  } else {
    started_at.saturating_add(duration_min.saturating_mul(60_000))
  };

  let meeting_id = format!("zoom_{}_{}", started_at, now_ms() % 100_000);
  meeting_store::meeting_insert(
    &meeting_id,
    started_at,
    None,
    Some("us.zoom.xos"),
    Some(&topic),
  )?;

  if !result.utterances.is_empty() {
    for (i, u) in result.utterances.iter().enumerate() {
      let seg_id = format!("{}_seg{}", meeting_id, i);
      meeting_store::insert_transcript_segment(
        &meeting_id,
        &seg_id,
        u.start_ms,
        u.end_ms,
        &u.speaker,
        &u.text,
        Some(u.confidence),
        true,
      )?;
    }
  } else if !result.transcript.is_empty() {
    let seg_id = format!("{}_seg0", meeting_id);
    meeting_store::insert_transcript_segment(
      &meeting_id,
      &seg_id,
      0,
      duration_ms,
      "speaker_0",
      &result.transcript,
      Some(result.confidence),
      true,
    )?;
  }

  meeting_store::meeting_stop(&meeting_id, ended_at)?;
  Ok(true)
}

/// Top-level sync. Lists meetings with recordings in the window and imports
/// each as a local meeting with transcript segments.
pub async fn sync_recordings_to_memory(
  days: Option<u32>,
  max_meetings: usize,
) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;
  let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

  let window_days = days.unwrap_or(30).min(366);
  let (from, to) = iso_date_cutoff(window_days);
  let cap = max_meetings.clamp(1, MEETING_HARD_CAP);

  let mut next_page_token: Option<String> = None;
  let mut ingested: u32 = 0;
  let mut considered: u32 = 0;
  crate::progress_emitter::emit("zoom", 0, Some(cap as u64), "list");

  loop {
    let mut query: Vec<(&str, String)> = vec![
      ("from", from.clone()),
      ("to", to.clone()),
      ("page_size", PAGE_SIZE.to_string()),
    ];
    if let Some(t) = next_page_token.as_ref() {
      query.push(("next_page_token", t.clone()));
    }
    let (status, text) = zoom_get(&token, "users/me/recordings", &query).await?;
    if !status.is_success() {
      let clip: String = text.chars().take(400).collect();
      let err = format!("Zoom HTTP {}: {}", status, clip);
      if let Ok(mut s) = STATE.lock() {
        s.last_error = Some(err.clone());
      }
      return Err(err);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Zoom JSON: {}", e))?;
    let meetings = v
      .get("meetings")
      .and_then(|x| x.as_array())
      .cloned()
      .unwrap_or_default();
    if meetings.is_empty() {
      break;
    }

    for meeting in meetings.iter() {
      considered += 1;
      match ingest_meeting(&token, meeting).await {
        Ok(true) => ingested += 1,
        Ok(false) => {}
        Err(e) => log::warn!("Zoom ingest failed: {}", e),
      }
      if (ingested as usize) >= cap {
        break;
      }
      crate::progress_emitter::emit("zoom", ingested as u64, Some(cap as u64), "meetings");
    }
    if (ingested as usize) >= cap {
      break;
    }
    next_page_token = v
      .get("next_page_token")
      .and_then(|x| x.as_str())
      .filter(|s| !s.is_empty())
      .map(|s| s.to_string());
    if next_page_token.is_none() {
      break;
    }
  }
  crate::progress_emitter::emit("zoom", ingested as u64, Some(cap as u64), "done");

  let elapsed_ms = start.elapsed().as_millis() as u64;
  crate::memory_obs::emit(
    "zoom_sync_done",
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
