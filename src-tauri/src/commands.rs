//! IPC handlers aligned with `hifi/lib/shogun-api.js` invoke names.

use crate::{
  auth, biometric, brief, brief_actions, diagnostics, embed_backfill, gmail, google_calendar,
  integration_secrets, integrations, llm, macos_ax, meeting_store, memory_store, secrets,
  settings_store,
};
use crate::paths;
use crate::schedule_queue;
use serde_json::{json, Value};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

const REDACT_MARKERS: &[&str] = &[
  // API key / OAuth token prefixes (token body follows immediately).
  "sk-",
  "ya29.",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xoxs-",
  "xoxo-",
  // HTTP auth header value.
  "Bearer ",
  // JSON body keys (value follows the opening quote).
  "\"apiKey\":\"",
  "\"api_key\":\"",
  "\"accessToken\":\"",
  "\"access_token\":\"",
  "\"refreshToken\":\"",
  "\"refresh_token\":\"",
  "\"oauthClientSecret\":\"",
  "\"clientSecret\":\"",
  "\"client_secret\":\"",
  "\"password\":\"",
  "\"token\":\"",
  // URL query keys (value follows `=`).
  "access_token=",
  "refresh_token=",
  "client_secret=",
  "password=",
  "api_key=",
  "apikey=",
];

fn is_redact_terminator(b: u8) -> bool {
  matches!(
    b,
    b'"' | b' ' | b'\n' | b'\r' | b'\t' | b'&' | b',' | b'}' | b']' | b';' | b'<' | b'>'
  )
}

/// Scans left-to-right once, redacting the token body after any known marker.
/// Non-ASCII bytes outside a match are preserved on char boundaries.
fn redact_sensitive_text(input: &str) -> String {
  if input.is_empty() {
    return String::new();
  }
  let bytes = input.as_bytes();
  let mut out = String::with_capacity(input.len());
  let mut i = 0usize;
  while i < bytes.len() {
    let mut match_len: Option<usize> = None;
    for m in REDACT_MARKERS {
      let mb = m.as_bytes();
      if bytes.len() - i >= mb.len() && &bytes[i..i + mb.len()] == mb {
        match_len = Some(mb.len());
        break;
      }
    }
    if let Some(len) = match_len {
      out.push_str(&input[i..i + len]);
      i += len;
      let start = i;
      while i < bytes.len() && !is_redact_terminator(bytes[i]) {
        i += 1;
      }
      if i > start {
        out.push_str("[REDACTED]");
      }
    } else {
      let ch = input[i..].chars().next().expect("non-empty remainder");
      let clen = ch.len_utf8();
      out.push(ch);
      i += clen;
    }
  }
  out
}

fn ts() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[tauri::command]
pub async fn shogun_memory_search(payload: Value) -> Result<Value, String> {
  memory_store::search_with_semantics(&payload).await
}

#[tauri::command]
pub fn shogun_memory_fetch(payload: Value) -> Result<Value, String> {
  memory_store::fetch(&payload)
}

#[tauri::command]
pub fn shogun_memory_ingest(payload: Value) -> Result<Value, String> {
  memory_store::ingest(&payload)
}

#[tauri::command]
pub fn shogun_memory_delete(payload: Value) -> Result<Value, String> {
  memory_store::delete_items(&payload)
}

#[tauri::command]
pub async fn shogun_memory_embed_backfill(
  app: AppHandle,
  state: tauri::State<'_, embed_backfill::EmbedBackfillState>,
  payload: Value,
) -> Result<Value, String> {
  state.begin_run();
  memory_store::backfill_embeddings(
    &payload,
    memory_store::BackfillEmitContext {
      app: Some(app),
      cancel: Some(state.cancel_flag()),
    },
  )
  .await
}

#[tauri::command]
pub fn shogun_memory_embed_backfill_cancel(
  state: tauri::State<'_, embed_backfill::EmbedBackfillState>,
) -> Result<Value, String> {
  state.request_cancel();
  Ok(json!({ "requested": true }))
}

#[tauri::command]
pub fn shogun_entity_query(payload: Value) -> Result<Value, String> {
  memory_store::entities_from_catalog(&payload)
}

#[tauri::command]
pub async fn shogun_brief_get(payload: Value) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  if brief::should_use_v2(&settings, &payload) {
    let user_tz = payload
      .get("user_tz")
      .and_then(|v| v.as_str())
      .unwrap_or("UTC");
    return Ok(brief::get_morning_brief_v2(user_tz, &payload).await);
  }
  llm::brief_generate(&payload).await
}

#[tauri::command]
pub async fn shogun_chat_complete(payload: Value) -> Result<Value, String> {
  llm::chat_complete(&payload).await
}

#[tauri::command]
pub async fn shogun_draft(payload: Value) -> Result<Value, String> {
  llm::draft_from_payload(&payload).await
}

#[tauri::command]
pub fn shogun_schedule_action(payload: Value) -> Result<Value, String> {
  schedule_queue::append(&payload)
}

fn fmt_decimal_commas(mut n: u64) -> String {
  if n == 0 {
    return "0".to_string();
  }
  let mut parts: Vec<String> = Vec::new();
  while n > 0 {
    parts.push(format!("{}", n % 1000));
    n /= 1000;
  }
  parts.reverse();
  let mut out = parts[0].clone();
  for p in parts.into_iter().skip(1) {
    out.push(',');
    out.push_str(&format!("{:0>3}", p));
  }
  out
}

fn fmt_disk_short(bytes: u64) -> String {
  if bytes < 1024 {
    return format!("{} B", bytes);
  }
  let kb = bytes as f64 / 1024.0;
  if kb < 1024.0 {
    return format!("{:.1} KB", kb);
  }
  let mb = kb / 1024.0;
  format!("{:.2} MB", mb)
}

/// Maps local app-data footprint to 0–100 for UI meters (50 MiB ~= 100%).
fn usage_percent_from_bytes(bytes: u64) -> u64 {
  let cap = 50u64 * 1024 * 1024;
  u64::min(100, bytes.saturating_mul(100) / cap.max(1))
}

#[tauri::command]
pub fn shogun_stats(payload: Value) -> Result<Value, String> {
  let m = memory_store::stats()?;
  let total = m.get("memoryTotal").and_then(|x| x.as_u64()).unwrap_or(0);
  let last24 = m.get("memoriesLast24h").and_then(|x| x.as_u64()).unwrap_or(0);
  let history_days = m.get("historyDays").and_then(|x| x.as_u64()).unwrap_or(0);
  let bytes = paths::app_data_total_bytes().unwrap_or(0);
  let mut out = json!({
    "eventsToday": format!("{}", last24),
    "memoriesToday": format!("{}", last24),
    "memoryTotal": total,
    "memoriesLast24h": last24,
    "memories": fmt_decimal_commas(total),
    "disk": fmt_disk_short(bytes),
    "historyDays": format!("{} days", history_days),
    "usagePercent": usage_percent_from_bytes(bytes),
    "appCoverage": [],
    "echo": payload,
    "stub": false,
  });
  if payload
    .get("stage")
    .and_then(|s| s.as_str())
    .is_some_and(|s| s == "capture")
  {
    let settings = settings_store::load().unwrap_or_else(|_| json!({}));
    out["settings"] = settings;
  }
  Ok(out)
}

#[tauri::command]
pub fn app_open_hummingbird(payload: Value) -> Result<Value, String> {
  let ok = Command::new("open")
    .args(["-a", "Hummingbird"])
    .status()
    .map(|s| s.success())
    .unwrap_or(false);
  if ok {
    Ok(json!({ "opened": true, "stub": false, "echo": payload }))
  } else {
    Err("Could not open Hummingbird. Install it or use it from /Applications.".to_string())
  }
}

#[tauri::command]
pub fn app_create_share_link(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    use std::io::Write;
    let title = payload
      .get("title")
      .and_then(|t| t.as_str())
      .unwrap_or("SHOGUN export");
    let mode = payload
      .get("mode")
      .and_then(|m| m.as_str())
      .unwrap_or("private");
    let body = payload
      .get("markdown")
      .and_then(|m| m.as_str())
      .unwrap_or("");
    let md = format!(
      "# {}\n\n- Mode: {}\n- Exported (epoch ms): {}\n\n{}\n",
      title,
      mode,
      ts(),
      body
    );
    let Some(path) = rfd::FileDialog::new()
      .set_file_name("shogun-share.md")
      .save_file()
    else {
      return Ok(json!({ "cancelled": true, "stub": false, "echo": payload }));
    };
    std::fs::File::create(&path)
      .and_then(|mut f| f.write_all(md.as_bytes()))
      .map_err(|e| e.to_string())?;
    return Ok(json!({
      "exported": true,
      "path": path.display().to_string(),
      "stub": false,
      "echo": payload,
    }));
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Share export is only available on macOS.".to_string())
  }
}

#[tauri::command]
pub fn app_settings_load(payload: Value) -> Result<Value, String> {
  let doc = settings_store::load()?;
  Ok(json!({
    "settings": doc,
    "echo": payload,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_settings_save(payload: Value) -> Result<Value, String> {
  let doc = settings_store::save_patch(&payload)?;
  Ok(json!({
    "saved": true,
    "settings": doc,
    "echo": payload,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_llm_api_key_set(payload: Value) -> Result<Value, String> {
  let key = payload
    .get("apiKey")
    .and_then(|k| k.as_str())
    .ok_or_else(|| "apiKey is required".to_string())?;
  secrets::set_llm_api_key(key)?;
  Ok(json!({ "saved": true, "stub": false }))
}

#[tauri::command]
pub fn app_llm_api_key_status(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "configured": secrets::llm_api_key_configured()?,
    "echo": payload,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_llm_api_key_clear(payload: Value) -> Result<Value, String> {
  secrets::clear_llm_api_key()?;
  Ok(json!({
    "cleared": true,
    "echo": payload,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_integration_connect(payload: Value) -> Result<Value, String> {
  let raw = payload
    .get("provider")
    .and_then(|p| p.as_str())
    .unwrap_or("");
  let slug = integrations::normalize_provider(raw);
  if slug == "gmail" {
    let configured = integration_secrets::get_credentials("gmail")?.is_some();
    if configured {
      settings_store::upsert_integration_provider(
        &slug,
        &json!({ "connected": true, "mode": "oauth_via_agent" }),
      )?;
      return Ok(json!({
        "connected": true,
        "provider": slug,
        "stub": false,
        "echo": payload,
      }));
    }
    return Ok(json!({
      "connected": false,
      "needsCredentials": true,
      "provider": slug,
      "message": "Gmail requires OAuth tokens imported via app_integration_import_credentials (provider: gmail). Scopes must include https://www.googleapis.com/auth/gmail.readonly (or broader Gmail).",
      "stub": false,
      "echo": payload,
    }));
  }
  if integrations::allows_local_connect(&slug) {
    settings_store::upsert_integration_provider(
      &slug,
      &json!({ "connected": true, "mode": "local_tool" }),
    )?;
    return Ok(json!({
      "connected": true,
      "provider": slug,
      "stub": false,
      "echo": payload,
    }));
  }
  Ok(json!({
    "notImplemented": true,
    "message": "Third-party integrations (OAuth, calendar, mail) are not available in v1. This build is local-only; connect Arc, Raycast, or Obsidian for local-only toggles.",
    "stub": false,
    "echo": payload,
  }))
}

/// Shared by [`app_integration_import_credentials`] and the `shogun-ai://credentials/import` deep link handler.
pub(crate) fn persist_integration_credentials_inner(payload: &Value) -> Result<String, String> {
  let raw = payload
    .get("provider")
    .and_then(|p| p.as_str())
    .ok_or_else(|| "provider is required".to_string())?;
  let slug = integrations::normalize_provider(raw);
  let token = payload
    .get("accessToken")
    .and_then(|t| t.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "accessToken is required".to_string())?;

  let mut doc = json!({ "accessToken": token });
  if let Some(r) = payload.get("refreshToken").and_then(|x| x.as_str()) {
    if !r.trim().is_empty() {
      doc["refreshToken"] = json!(r);
    }
  }
  if let Some(exp) = payload.get("expiresAt") {
    doc["expiresAt"] = exp.clone();
  }
  if let Some(sc) = payload.get("scopes") {
    doc["scopes"] = sc.clone();
  }
  if let Some(cid) = payload
    .get("oauthClientId")
    .or_else(|| payload.get("oauth_client_id"))
    .and_then(|x| x.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
  {
    doc["oauthClientId"] = json!(cid);
  }
  if let Some(cs) = payload
    .get("oauthClientSecret")
    .or_else(|| payload.get("oauth_client_secret"))
    .and_then(|x| x.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
  {
    doc["oauthClientSecret"] = json!(cs);
  }

  integration_secrets::set_credentials(&slug, &doc)?;
  if slug == "google_calendar" || slug == "gmail" {
    settings_store::upsert_integration_provider(
      &slug,
      &json!({ "connected": true, "mode": "oauth_via_agent" }),
    )?;
  }
  Ok(slug)
}

#[tauri::command]
pub fn app_integration_import_credentials(app: AppHandle, payload: Value) -> Result<Value, String> {
  let slug = persist_integration_credentials_inner(&payload)?;
  let _ = app.emit(
    "credentials-imported",
    json!({ "saved": true, "provider": slug, "via": "invoke" }),
  );
  Ok(json!({
    "saved": true,
    "provider": slug,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_integration_credentials_status(payload: Value) -> Result<Value, String> {
  let raw = payload
    .get("provider")
    .and_then(|p| p.as_str())
    .unwrap_or("google_calendar");
  let slug = integrations::normalize_provider(raw);
  let creds = integration_secrets::get_credentials(&slug)?;
  let configured = creds.is_some();
  let token_refresh_ready = match creds.as_ref() {
    Some(doc) if slug == "google_calendar" => google_calendar::credentials_can_refresh(doc),
    Some(doc) if slug == "gmail" => crate::google_oauth::credentials_can_refresh(doc),
    _ => false,
  };
  Ok(json!({
    "configured": configured,
    "tokenRefreshReady": token_refresh_ready,
    "provider": slug,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub async fn shogun_google_calendar_sync(payload: Value) -> Result<Value, String> {
  let cal = payload
    .get("calendarId")
    .and_then(|c| c.as_str())
    .unwrap_or("primary");
  let max = payload
    .get("maxResults")
    .and_then(|m| m.as_u64())
    .unwrap_or(25)
    .clamp(1, 50) as usize;
  google_calendar::sync_events_to_memory(cal, max).await
}

#[tauri::command]
pub async fn shogun_gmail_sync(payload: Value) -> Result<Value, String> {
  let max = payload
    .get("maxResults")
    .and_then(|m| m.as_u64())
    .unwrap_or(20)
    .clamp(1, 50) as usize;
  gmail::sync_inbox_to_memory(max).await
}

#[tauri::command]
pub fn app_integration_toggle(payload: Value) -> Result<Value, String> {
  let raw = payload
    .get("provider")
    .and_then(|p| p.as_str())
    .unwrap_or("");
  let slug = integrations::normalize_provider(raw);
  let connected = payload
    .get("connected")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  settings_store::upsert_integration_provider(
    &slug,
    &json!({ "connected": connected, "mode": "ui_toggle" }),
  )?;
  Ok(json!({
    "saved": true,
    "connected": connected,
    "provider": slug,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_capture_pause(payload: Value) -> Result<Value, String> {
  let _ = settings_store::save_patch(&json!({
    "section": "capture",
    "paused": true,
    "pipelineAvailable": false,
  }))?;
  Ok(json!({
    "paused": true,
    "honestPreferenceOnly": true,
    "message": "Capture sampling paused. No new focus events will be recorded until you resume.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_capture_resume(payload: Value) -> Result<Value, String> {
  let _ = settings_store::save_patch(&json!({
    "section": "capture",
    "paused": false,
    "pipelineAvailable": true,
  }))?;
  Ok(json!({
    "paused": false,
    "honestPreferenceOnly": true,
    "message": "Capture sampling resumed. On macOS, frontmost app is sampled periodically into memory (no screenshots).",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_permissions_manage(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    let target = payload
      .get("target")
      .and_then(|t| t.as_str())
      .unwrap_or("screen_capture");
    let url = match target {
      "accessibility" => {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      }
      _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    };
    let _ = Command::new("open").arg(url).spawn();
  }
  Ok(json!({
    "opened": true,
    "note": "Opened System Settings for the requested privacy pane when supported.",
    "stub": false,
    "echo": payload,
  }))
}

/// Native file picker for a `.app` bundle (Privacy → exclude list). Cancel returns `cancelled: true`.
#[tauri::command]
pub fn app_privacy_pick_app(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    let path = rfd::FileDialog::new()
      .set_title("Choose an application to exclude")
      .add_filter("Application", &["app"])
      .pick_file();
    match path {
      None => Ok(json!({
        "cancelled": true,
        "stub": false,
        "echo": payload,
      })),
      Some(p) => {
        let name = p
          .file_stem()
          .and_then(|s| s.to_str())
          .map(str::to_string)
          .filter(|s| !s.is_empty())
          .unwrap_or_else(|| "Application".to_string());
        Ok(json!({
          "cancelled": false,
          "name": name,
          "path": p.display().to_string(),
          "stub": false,
          "echo": payload,
        }))
      }
    }
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("app_privacy_pick_app is only available on macOS.".to_string())
  }
}

#[tauri::command]
pub fn app_diagnostics_report(payload: Value) -> Result<Value, String> {
  let dir = paths::app_data_dir()?;
  let id = format!("diag-{}", ts());
  let path = dir.join(format!("{}.json", id));
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let capture = settings
    .pointer("/sections/capture")
    .cloned()
    .unwrap_or(json!({}));
  let ax_trusted = macos_ax::accessibility_trust_status();
  let google_cal = integration_secrets::get_credentials("google_calendar").ok().flatten();
  let google_calendar_summary = match google_cal.as_ref() {
    Some(doc) => json!({
      "configured": true,
      "tokenRefreshReady": google_calendar::credentials_can_refresh(doc),
    }),
    None => json!({
      "configured": false,
      "tokenRefreshReady": false,
    }),
  };
  let calendar_auto = json!({
    "autoSyncEnabled": settings
      .pointer("/sections/integrations/googleCalendarAutoSync")
      .and_then(|v| v.as_bool())
      .unwrap_or(false),
    "autoSyncIntervalMins": settings
      .pointer("/sections/integrations/googleCalendarSyncIntervalMins")
      .and_then(|v| v.as_u64())
      .unwrap_or(15)
      .clamp(5, 1440),
  });
  let recent_errors = diagnostics::snapshot();
  let summary = json!({
    "capture": capture,
    "macosAccessibilityTrusted": ax_trusted,
    "integrations": {
      "google_calendar": google_calendar_summary,
      "calendarAutoSync": calendar_auto,
    },
    "recentErrors": recent_errors,
  });
  let report = json!({
    "id": id,
    "generatedAt": ts(),
    "platform": std::env::consts::OS,
    "capture": capture,
    "macosAccessibilityTrusted": ax_trusted,
    "integrations": {
      "google_calendar": google_calendar_summary,
      "calendarAutoSync": calendar_auto,
    },
    "recentErrors": recent_errors,
    "echo": payload,
  });
  std::fs::write(
    &path,
    serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
  )
  .map_err(|e| e.to_string())?;
  Ok(json!({
    "reportId": id,
    "path": path.display().to_string(),
    "summary": summary,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_frontend_error_report(payload: Value) -> Result<(), String> {
  let kind = payload
    .get("kind")
    .and_then(|v| v.as_str())
    .unwrap_or("unknown");
  let message = payload
    .get("message")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let stack = payload
    .get("stack")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let msg: String = message.chars().take(2000).collect();
  let stk: String = stack.chars().take(1500).collect();
  let safe_msg = redact_sensitive_text(&msg);
  let safe_stk = redact_sensitive_text(&stk);
  eprintln!("[shogun-frontend:{}] {}", kind, safe_msg);
  if !safe_stk.is_empty() {
    eprintln!("[shogun-frontend:{}] stack {}", kind, safe_stk);
  }
  log::warn!(target: "shogun::frontend", "[{}] {} — {}", kind, safe_msg, safe_stk);
  Ok(())
}

#[tauri::command]
pub async fn app_updates_check(app: AppHandle) -> Result<Value, String> {
  let updater = app.updater().map_err(|e| e.to_string())?;
  match updater.check().await {
    Ok(Some(u)) => Ok(json!({
      "available": true,
      "version": u.version,
      "body": u.body,
      "currentVersion": u.current_version,
    })),
    Ok(None) => Ok(json!({ "available": false })),
    Err(e) => Err(e.to_string()),
  }
}

/// Download signature-verified update and restart the app (macOS / Windows / Linux updater bundles).
#[tauri::command]
pub async fn app_updates_download_install(app: AppHandle) -> Result<(), String> {
  let updater = app.updater().map_err(|e| e.to_string())?;
  let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
    return Err("No update is available.".to_string());
  };
  update
    .download_and_install(|_chunk_len, _total| {}, || {})
    .await
    .map_err(|e| e.to_string())?;
  app.restart();
}

/// Translate a supported `range` token into a cutoff (epoch ms). Rows with
/// `created_at >= cutoff` (or `started_at >= cutoff`) are removed. `now_ms`
/// is passed in to keep the logic pure and testable.
pub(crate) fn compute_range_cutoff_ms(range: &str, now_ms: u64) -> Result<u64, String> {
  match range {
    "last_hour" => Ok(now_ms.saturating_sub(3_600_000)),
    "last_day" => Ok(now_ms.saturating_sub(86_400_000)),
    "custom" => Err("Custom range deletion is not implemented in v1.".to_string()),
    _ => Err(format!("Unknown range: {}", range)),
  }
}

/// Delete data produced within `range` from the local stores.
///
/// **Scope (deleted):**
/// - `mem_items` rows with `created_at >= cutoff` (FTS5 trigger keeps index in sync).
/// - `meetings` rows with `started_at >= cutoff`. Cascades via FK
///   `ON DELETE CASCADE` to `meeting_transcript_segments` and
///   `meeting_note_blocks`.
///
/// **Not affected:** `settings.json`, `schedule_queue.json`, Keychain entries
/// (LLM API key, integration credentials, Clerk session snapshot),
/// material packs under `packs/`, meeting templates, and any rows
/// outside the range.
#[tauri::command]
pub fn app_delete_data_range(payload: Value) -> Result<Value, String> {
  let range = payload
    .get("range")
    .and_then(|r| r.as_str())
    .unwrap_or("");
  let cutoff = compute_range_cutoff_ms(range, ts())?;
  memory_store::delete_items_created_since(cutoff)?;
  let meetings_removed = meeting_store::delete_meetings_started_since(cutoff)?;
  Ok(json!({
    "deleted": true,
    "range": range,
    "meetingsRemoved": meetings_removed,
    "stub": false,
    "echo": payload,
  }))
}

fn clear_schedule_queue_file() -> Result<bool, String> {
  let path = paths::app_data_dir()?.join("schedule_queue.json");
  if path.exists() {
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    Ok(true)
  } else {
    Ok(false)
  }
}

/// Delete **all** local application data on this machine.
///
/// **Scope (deleted):**
/// - Every regular file directly under the app data directory — this
///   includes `memory.db` (dropping both `mem_items` and meeting tables),
///   `settings.json`, `schedule_queue.json`, and any legacy JSON.
/// - The `packs/` directory (material packs + focus notes).
/// - Keychain: LLM API key (`ai.shogun.desktop`), Clerk session snapshot,
///   and every known integration credential (Google Calendar, Gmail, ...).
///
/// **Not affected:** the app data directory itself (recreated on next
/// write); nested subdirectories other than `packs/`.
///
/// Keychain failures are reported as `keychainErrors` in the response
/// rather than aborting, so users can still re-run this command after
/// a partial failure.
#[tauri::command]
pub fn app_delete_all_data(payload: Value) -> Result<Value, String> {
  paths::clear_app_data_files()?;
  let _ = clear_schedule_queue_file(); // best-effort; files pass above may have already removed it.
  let mut keychain_errors: Vec<String> = Vec::new();
  if let Err(e) = secrets::clear_llm_api_key() {
    keychain_errors.push(format!("llm_api_key: {}", e));
  }
  if let Err(e) = secrets::clear_clerk_snapshot() {
    keychain_errors.push(format!("clerk_snapshot: {}", e));
  }
  integration_secrets::clear_all_known();
  Ok(json!({
    "deleted": true,
    "keychainErrors": keychain_errors,
    "stub": false,
    "echo": payload,
  }))
}

/// Delete all local data and surface any Keychain LLM-key failure as an
/// error (the LLM key is treated as account-critical). Clerk snapshot
/// removal failures are reported via `keychainErrors` and do not abort.
///
/// Scope is otherwise identical to [`app_delete_all_data`]; no cloud
/// account is associated with this build.
#[tauri::command]
pub fn app_delete_account(payload: Value) -> Result<Value, String> {
  paths::clear_app_data_files()?;
  let _ = clear_schedule_queue_file();
  secrets::clear_llm_api_key()?;
  let mut keychain_errors: Vec<String> = Vec::new();
  if let Err(e) = secrets::clear_clerk_snapshot() {
    keychain_errors.push(format!("clerk_snapshot: {}", e));
  }
  integration_secrets::clear_all_known();
  Ok(json!({
    "deleted": true,
    "note": "Local data cleared. No cloud account is associated with this build.",
    "keychainErrors": keychain_errors,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_open_pack(payload: Value) -> Result<Value, String> {
  brief_actions::open_pack(&payload)
}

#[tauri::command]
pub fn shogun_start_focus_session(payload: Value) -> Result<Value, String> {
  brief_actions::start_focus_session(&payload)
}

#[tauri::command]
pub async fn shogun_draft_reply(payload: Value) -> Result<Value, String> {
  llm::draft_reply_for_brief(&payload).await
}

#[tauri::command]
pub fn auth_clerk_config() -> Result<Value, String> {
  Ok(auth::clerk_config())
}

#[tauri::command]
pub fn auth_open_browser_sign_in() -> Result<Value, String> {
  let url = auth::sign_in_url()?;
  open::that(&url).map_err(|e| e.to_string())?;
  Ok(json!({ "opened": true }))
}

#[tauri::command]
pub fn auth_open_browser_sign_up() -> Result<Value, String> {
  let url = auth::sign_up_url()?;
  open::that(&url).map_err(|e| e.to_string())?;
  Ok(json!({ "opened": true }))
}

#[tauri::command]
pub fn auth_status() -> Result<Value, String> {
  let cfg = auth::clerk_config();
  let snap_raw = secrets::get_clerk_snapshot()?;
  let snapshot: Value = match snap_raw {
    Some(s) if !s.trim().is_empty() => serde_json::from_str(&s).unwrap_or(json!(null)),
    _ => json!(null),
  };
  Ok(json!({
    "clerk": cfg,
    "snapshot": snapshot,
  }))
}

#[tauri::command]
pub fn auth_session_save(payload: Value) -> Result<Value, String> {
  let body = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
  secrets::set_clerk_snapshot(&body)?;
  Ok(json!({ "saved": true }))
}

#[tauri::command]
pub fn auth_sign_out() -> Result<Value, String> {
  secrets::clear_clerk_snapshot()?;
  Ok(json!({ "signedOut": true }))
}

/// Runs LocalAuthentication work on the blocking pool so the async runtime thread is not wedged
/// (which can freeze the WebView when opening Settings → Privacy).
#[tauri::command]
pub async fn auth_biometric_status(payload: Value) -> Result<Value, String> {
  let echo = payload;
  let mut v = tokio::task::spawn_blocking(biometric::status_json)
    .await
    .map_err(|e| format!("biometric status task failed: {e}"))?;
  if let Some(m) = v.as_object_mut() {
    m.insert("echo".to_string(), echo);
    m.insert("stub".to_string(), json!(false));
  }
  Ok(v)
}

#[tauri::command]
pub fn auth_biometric_authenticate(payload: Value) -> Result<Value, String> {
  let reason = payload
    .get("reason")
    .and_then(|r| r.as_str())
    .unwrap_or("Unlock SHOGUN");
  match biometric::authenticate(reason) {
    Ok(()) => Ok(json!({
      "ok": true,
      "stub": false,
      "echo": payload,
    })),
    Err(msg) => Ok(json!({
      "ok": false,
      "message": msg,
      "stub": false,
      "echo": payload,
    })),
  }
}

#[cfg(test)]
mod redact_tests {
  use super::redact_sensitive_text;

  #[test]
  fn empty_input_stays_empty() {
    assert_eq!(redact_sensitive_text(""), "");
  }

  #[test]
  fn passes_through_text_without_secrets() {
    let s = "hello world — 日本語テキスト — no secrets here";
    assert_eq!(redact_sensitive_text(s), s);
  }

  #[test]
  fn redacts_openai_style_key() {
    let out = redact_sensitive_text("key=sk-abc123XYZ other");
    assert_eq!(out, "key=sk-[REDACTED] other");
  }

  #[test]
  fn redacts_anthropic_style_key_via_sk_prefix() {
    let out = redact_sensitive_text("token sk-ant-api03-abcDEF end");
    assert_eq!(out, "token sk-[REDACTED] end");
  }

  #[test]
  fn redacts_bearer_header_value() {
    let out = redact_sensitive_text("Authorization: Bearer abc.def.ghi\nnext");
    assert_eq!(out, "Authorization: Bearer [REDACTED]\nnext");
  }

  #[test]
  fn bearer_header_does_not_infinite_loop() {
    let out = redact_sensitive_text("Bearer sk-abc");
    assert_eq!(out, "Bearer [REDACTED]");
  }

  #[test]
  fn redacts_json_api_key_variants() {
    let out = redact_sensitive_text(r#"{"apiKey":"sk-abc","api_key":"zzz"}"#);
    assert!(out.contains(r#""apiKey":"[REDACTED]""#));
    assert!(out.contains(r#""api_key":"[REDACTED]""#));
    assert!(!out.contains("sk-abc"));
    assert!(!out.contains("zzz"));
  }

  #[test]
  fn redacts_json_oauth_tokens() {
    let out = redact_sensitive_text(
      r#"{"accessToken":"ya29.FOO","refreshToken":"1//refBAR","oauthClientSecret":"GOCSPX-xyz"}"#,
    );
    assert!(out.contains(r#""accessToken":"[REDACTED]""#));
    assert!(out.contains(r#""refreshToken":"[REDACTED]""#));
    assert!(out.contains(r#""oauthClientSecret":"[REDACTED]""#));
    assert!(!out.contains("ya29.FOO"));
    assert!(!out.contains("1//refBAR"));
    assert!(!out.contains("GOCSPX-xyz"));
  }

  #[test]
  fn redacts_snake_case_json_oauth_tokens() {
    let out = redact_sensitive_text(
      r#"{"access_token":"t1","refresh_token":"t2","client_secret":"s1"}"#,
    );
    assert!(!out.contains("t1"));
    assert!(!out.contains("t2"));
    assert!(!out.contains("s1"));
    assert!(out.contains("\"access_token\":\"[REDACTED]\""));
    assert!(out.contains("\"refresh_token\":\"[REDACTED]\""));
    assert!(out.contains("\"client_secret\":\"[REDACTED]\""));
  }

  #[test]
  fn redacts_password_and_generic_token_fields() {
    let out = redact_sensitive_text(r#"{"password":"hunter2","token":"opaque"}"#);
    assert!(!out.contains("hunter2"));
    assert!(!out.contains("\"opaque\""));
    assert!(out.contains("\"password\":\"[REDACTED]\""));
    assert!(out.contains("\"token\":\"[REDACTED]\""));
  }

  #[test]
  fn redacts_url_query_secrets() {
    let out = redact_sensitive_text(
      "https://api.example.com/cb?access_token=ABC&refresh_token=DEF&state=xyz",
    );
    assert!(!out.contains("ABC"));
    assert!(!out.contains("DEF"));
    assert!(out.contains("access_token=[REDACTED]"));
    assert!(out.contains("refresh_token=[REDACTED]"));
    assert!(out.contains("state=xyz"));
  }

  #[test]
  fn redacts_github_tokens() {
    for prefix in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"] {
      let raw = format!("prefix {}AAAAAAAAAA suffix", prefix);
      let out = redact_sensitive_text(&raw);
      assert_eq!(out, format!("prefix {}[REDACTED] suffix", prefix));
    }
    let out = redact_sensitive_text("pat github_pat_1122AABB end");
    assert_eq!(out, "pat github_pat_[REDACTED] end");
  }

  #[test]
  fn redacts_slack_tokens() {
    let out = redact_sensitive_text("x xoxb-1-2-ABC x xoxp-9-foo ok");
    assert_eq!(out, "x xoxb-[REDACTED] x xoxp-[REDACTED] ok");
  }

  #[test]
  fn marker_with_no_body_does_not_emit_redacted() {
    let out = redact_sensitive_text(r#"{"apiKey":"","other":"v"}"#);
    assert!(!out.contains("[REDACTED]"));
    assert!(out.contains(r#""apiKey":"""#));
  }

  #[test]
  fn preserves_unicode_between_secrets() {
    let out = redact_sensitive_text("鍵: sk-abc 、次: ya29.XYZ 終");
    assert_eq!(out, "鍵: sk-[REDACTED] 、次: ya29.[REDACTED] 終");
  }

  #[test]
  fn multiple_occurrences_all_redacted() {
    let out = redact_sensitive_text("a=sk-one b=sk-two c=sk-three");
    assert_eq!(out, "a=sk-[REDACTED] b=sk-[REDACTED] c=sk-[REDACTED]");
  }

  #[test]
  fn json_object_close_terminates_value() {
    let out = redact_sensitive_text(r#"{"token":"abc}def"}"#);
    // The `}` before `def` is a terminator; anything after stays in place.
    assert_eq!(out, r#"{"token":"[REDACTED]}def"}"#);
  }
}

#[cfg(test)]
mod range_cutoff_tests {
  use super::compute_range_cutoff_ms;

  #[test]
  fn last_hour_subtracts_one_hour() {
    let now = 10_000_000_000u64;
    let cutoff = compute_range_cutoff_ms("last_hour", now).unwrap();
    assert_eq!(cutoff, now - 3_600_000);
  }

  #[test]
  fn last_day_subtracts_one_day() {
    let now = 10_000_000_000u64;
    let cutoff = compute_range_cutoff_ms("last_day", now).unwrap();
    assert_eq!(cutoff, now - 86_400_000);
  }

  #[test]
  fn saturates_at_zero_for_small_now() {
    let cutoff = compute_range_cutoff_ms("last_day", 1000).unwrap();
    assert_eq!(cutoff, 0);
  }

  #[test]
  fn custom_range_is_not_yet_supported() {
    let err = compute_range_cutoff_ms("custom", 1).unwrap_err();
    assert!(err.contains("Custom range"));
  }

  #[test]
  fn unknown_range_returns_error_with_token() {
    let err = compute_range_cutoff_ms("last_week", 1).unwrap_err();
    assert!(err.contains("last_week"));
  }

  #[test]
  fn empty_range_is_rejected() {
    assert!(compute_range_cutoff_ms("", 1).is_err());
  }
}
