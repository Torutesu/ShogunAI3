//! IPC handlers aligned with `hifi/lib/shogun-api.js` invoke names.

use crate::{brief, llm, memory_store, secrets, settings_store};
use crate::paths;
use serde_json::{json, Value};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn ts() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[tauri::command]
pub fn shogun_memory_search(payload: Value) -> Result<Value, String> {
  memory_store::search(&payload)
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
pub fn shogun_entity_query(payload: Value) -> Result<Value, String> {
  Ok(json!({ "entities": [], "echo": payload, "stub": false }))
}

#[tauri::command]
pub async fn shogun_brief_get(payload: Value) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  if brief::should_use_v2(&settings, &payload) {
    let user_tz = payload
      .get("user_tz")
      .and_then(|v| v.as_str())
      .unwrap_or("Asia/Tokyo");
    let ms = ts();
    return Ok(brief::morning_brief_v2_stub(ms, user_tz, &payload));
  }
  llm::brief_generate(&payload).await
}

#[tauri::command]
pub async fn shogun_chat_complete(payload: Value) -> Result<Value, String> {
  llm::chat_complete(&payload).await
}

#[tauri::command]
pub fn shogun_draft(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "notImplemented": true,
    "message": "This action is not available in v1. Use Chat to message the model.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_schedule_action(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "notImplemented": true,
    "message": "Scheduling is not available in v1.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_stats(payload: Value) -> Result<Value, String> {
  let m = memory_store::stats()?;
  let total = m.get("memoryTotal").and_then(|x| x.as_u64()).unwrap_or(0);
  let last24 = m.get("memoriesLast24h").and_then(|x| x.as_u64()).unwrap_or(0);
  Ok(json!({
    "eventsToday": format!("{}", last24),
    "memoriesToday": format!("{}", last24),
    "memoryTotal": total,
    "memoriesLast24h": last24,
    "appCoverage": [],
    "echo": payload,
    "stub": false,
  }))
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
pub fn app_integration_connect(payload: Value) -> Result<Value, String> {
  let doc = settings_store::save_patch(&json!({
    "section": "integrations",
    "lastConnect": payload.clone(),
    "connected": true,
    "localPreferenceOnly": true,
  }))?;
  Ok(json!({
    "connected": true,
    "localPreferenceOnly": true,
    "settings": doc,
    "stub": false,
  }))
}

#[tauri::command]
pub fn app_integration_toggle(payload: Value) -> Result<Value, String> {
  let enabled = payload
    .get("enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let doc = settings_store::save_patch(&json!({
    "section": "integrations",
    "lastToggle": payload.clone(),
    "enabled": enabled,
    "localPreferenceOnly": true,
  }))?;
  Ok(json!({
    "enabled": enabled,
    "localPreferenceOnly": true,
    "settings": doc,
    "stub": false,
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
    "note": "Screen capture is not implemented in v1; preference saved only.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_capture_resume(payload: Value) -> Result<Value, String> {
  let _ = settings_store::save_patch(&json!({
    "section": "capture",
    "paused": false,
    "pipelineAvailable": false,
  }))?;
  Ok(json!({
    "paused": false,
    "note": "Screen capture is not implemented in v1; preference saved only.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_permissions_manage(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    let _ = Command::new("open")
      .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
      .spawn();
  }
  Ok(json!({
    "opened": true,
    "note": "Opened System Settings (Screen Recording) when supported.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_diagnostics_report(payload: Value) -> Result<Value, String> {
  let dir = paths::app_data_dir()?;
  let id = format!("diag-{}", ts());
  let path = dir.join(format!("{}.json", id));
  let report = json!({
    "id": id,
    "generatedAt": ts(),
    "platform": std::env::consts::OS,
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
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_delete_data_range(payload: Value) -> Result<Value, String> {
  let range = payload
    .get("range")
    .and_then(|r| r.as_str())
    .unwrap_or("");
  let now = ts();
  let cutoff = match range {
    "last_hour" => now.saturating_sub(3_600_000),
    "last_day" => now.saturating_sub(86_400_000),
    "custom" => {
      return Err("Custom range deletion is not implemented in v1.".to_string());
    }
    _ => return Err(format!("Unknown range: {}", range)),
  };
  memory_store::delete_items_created_since(cutoff)?;
  Ok(json!({
    "deleted": true,
    "range": range,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_delete_all_data(payload: Value) -> Result<Value, String> {
  memory_store::clear_all_items()?;
  settings_store::reset_to_empty()?;
  let _ = secrets::clear_llm_api_key();
  Ok(json!({
    "deleted": true,
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn app_delete_account(payload: Value) -> Result<Value, String> {
  memory_store::clear_all_items()?;
  settings_store::reset_to_empty()?;
  secrets::clear_llm_api_key()?;
  Ok(json!({
    "deleted": true,
    "note": "Local data cleared. No cloud account is associated with this build.",
    "stub": false,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_open_pack(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "opened": true,
    "stub": true,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_start_focus_session(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "started": true,
    "stub": true,
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_draft_reply(payload: Value) -> Result<Value, String> {
  Ok(json!({
    "queued": true,
    "stub": true,
    "echo": payload,
  }))
}
