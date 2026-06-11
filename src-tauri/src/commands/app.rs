use crate::{
  biometric, capture_events, capture_sampler, dead_letter, google_calendar, integration_secrets,
  macos_ax, macos_permissions, memory_store, paths, secrets, settings_store,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

pub(crate) fn redact_sensitive_text(input: &str) -> String {
  let mut out = input.to_string();
  for marker in [
    "sk-",
    "Bearer ",
    "\"apiKey\":\"",
    "\"accessToken\":\"",
    "\"refreshToken\":\"",
    "\"oauthClientSecret\":\"",
    "access_token=",
    "refresh_token=",
  ] {
    loop {
      let Some(pos) = out.find(marker) else {
        break;
      };
      let start = pos + marker.len();
      let bytes = out.as_bytes();
      let mut end = start;
      while end < out.len() {
        let b = bytes[end];
        if b == b'"' || b == b' ' || b == b'\n' || b == b'&' {
          break;
        }
        end += 1;
      }
      out.replace_range(start..end, "[REDACTED]");
    }
  }
  out
}


pub(crate) fn ts() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
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


fn usage_percent_from_bytes(bytes: u64) -> u64 {
  let cap = 50u64 * 1024 * 1024;
  u64::min(100, bytes.saturating_mul(100) / cap.max(1))
}


fn percentile_ms(values: &mut [i64], percentile: f64) -> Option<i64> {
  if values.is_empty() {
    return None;
  }
  values.sort_unstable();
  let idx = ((values.len() - 1) as f64 * percentile).round() as usize;
  values.get(idx).copied()
}


fn compute_sli_snapshot(now_ms: i64) -> Result<Value, String> {
  let conn = memory_store::open_conn()?;
  let window_start_ms = now_ms.saturating_sub(24 * 60 * 60 * 1000);

  let mut stmt = conn
    .prepare(
      "SELECT status, COUNT(*)
         FROM extraction_jobs
        WHERE created_at >= ?1
          AND status IN ('done', 'failed')
        GROUP BY status",
    )
    .map_err(|e| format!("prepare extraction_jobs status query: {}", e))?;
  let rows = stmt
    .query_map(params![window_start_ms], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
    .map_err(|e| format!("run extraction_jobs status query: {}", e))?;
  let mut done = 0_i64;
  let mut failed = 0_i64;
  for row in rows {
    let (status, count) = row.map_err(|e| e.to_string())?;
    match status.as_str() {
      "done" => done = count,
      "failed" => failed = count,
      _ => {}
    }
  }
  drop(stmt);

  let completed = done.saturating_add(failed);
  let success_rate = if completed > 0 {
    (done as f64 / completed as f64) * 100.0
  } else {
    100.0
  };

  let mut stmt = conn
    .prepare(
      "SELECT (finished_at - started_at) AS elapsed_ms
         FROM extraction_jobs
        WHERE status = 'done'
          AND finished_at IS NOT NULL
          AND started_at IS NOT NULL
          AND finished_at >= ?1",
    )
    .map_err(|e| format!("prepare extraction_jobs p95 query: {}", e))?;
  let rows = stmt
    .query_map(params![window_start_ms], |r| r.get::<_, i64>(0))
    .map_err(|e| format!("run extraction_jobs p95 query: {}", e))?;
  let mut latencies: Vec<i64> = Vec::new();
  for row in rows {
    let elapsed = row.map_err(|e| e.to_string())?;
    if elapsed >= 0 {
      latencies.push(elapsed);
    }
  }
  drop(stmt);
  let p95_ms = percentile_ms(&mut latencies, 0.95);

  let queued_jobs = conn
    .query_row(
      "SELECT COUNT(*) FROM extraction_jobs WHERE status = 'queued'",
      [],
      |r| r.get::<_, i64>(0),
    )
    .map_err(|e| format!("count queued extraction_jobs: {}", e))?;
  let pending_captures = conn
    .query_row(
      "SELECT COUNT(*) FROM mem_captures WHERE extraction_status IN ('queued', 'failed')",
      [],
      |r| r.get::<_, i64>(0),
    )
    .map_err(|e| format!("count pending mem_captures: {}", e))?;
  let backlog = queued_jobs.saturating_add(pending_captures);

  Ok(json!({
    "windowHours": 24,
    "completed": completed,
    "done": done,
    "failed": failed,
    "successRate": success_rate,
    "p95LatencyMs": p95_ms,
    "backlog": backlog,
    "queuedJobs": queued_jobs,
    "pendingCaptures": pending_captures,
    "generatedAtMs": now_ms,
  }))
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
    let coverage = memory_store::stats_app_coverage(8).unwrap_or_default();
    let max = coverage.iter().map(|(_, c)| *c).max().unwrap_or(1).max(1);
    out["appCoverage"] = json!(
      coverage
        .into_iter()
        .map(|(name, count)| json!([name, count, (count * 100 / max) as i64]))
        .collect::<Vec<_>>()
    );
    out["captureStatus"] = crate::macos_permissions::status_snapshot();
    out["eventsPerMinute"] = json!(crate::capture_events::events_last_minute());
  }
  if payload
    .get("stage")
    .and_then(|s| s.as_str())
    .is_some_and(|s| s == "sli")
  {
    out["sli"] = compute_sli_snapshot(ts() as i64)?;
  }
  Ok(out)
}


#[tauri::command]
pub fn app_open_hummingbird(app: AppHandle, payload: Value) -> Result<Value, String> {
  crate::hummingbird::emit_open("invoke");
  Ok(json!({
    "opened": true,
    "mode": "in_app_overlay",
    "stub": false,
    "echo": payload
  }))
}


#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
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
  // Phase 2 Stage 3 (T8.3): keep the kioku_rules cache aligned with disk.
  // We refresh on every save (cheap: in-memory parse) so the next LLM call
  // sees the update without an app restart, regardless of which section the
  // user touched (kioku_rules edits also occasionally arrive as part of a
  // bulk import).
  crate::kioku_rules::reload_from_settings_now();
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
pub fn app_llm_api_key_status(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  match secrets::get_llm_api_key()? {
    Some(k) if !k.trim().is_empty() => {
      let provider = crate::llm_providers::detect_provider(&k);
      Ok(serde_json::json!({
        "configured": true,
        "provider": provider.as_str(),
        "keyPreview": crate::llm_providers::key_preview(&k),
      }))
    }
    _ => Ok(serde_json::json!({
      "configured": false,
      "provider": null,
      "keyPreview": null,
    })),
  }
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
pub fn shogun_hummingbird_context(payload: Value) -> Result<Value, String> {
  let mut ctx = crate::hummingbird::capture_context();
  if let Some(obj) = ctx.as_object_mut() {
    obj.insert("echo".to_string(), payload);
  }
  Ok(ctx)
}


#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn app_settings_export(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    use std::io::Write;
    let doc = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
    let exported_at = ts();
    let envelope = json!({
      "app": "SHOGUN",
      "kind": "settings_backup",
      "schemaVersion": 1,
      "exportedAt": exported_at,
      "settings": doc,
    });
    let Some(path) = rfd::FileDialog::new()
      .set_file_name("shogun-settings.json")
      .save_file()
    else {
      return Ok(json!({ "cancelled": true, "stub": false, "echo": payload }));
    };
    let body = serde_json::to_string_pretty(&envelope).map_err(|e| e.to_string())?;
    std::fs::File::create(&path)
      .and_then(|mut f| f.write_all(body.as_bytes()))
      .map_err(|e| e.to_string())?;
    Ok(json!({
      "exported": true,
      "path": path.display().to_string(),
      "exportedAt": exported_at,
      "stub": false,
      "echo": payload,
    }))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Settings export is only available on macOS.".to_string())
  }
}


#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn app_settings_import(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    let Some(path) = rfd::FileDialog::new()
      .add_filter("SHOGUN settings", &["json"])
      .pick_file()
    else {
      return Ok(json!({ "cancelled": true, "stub": false, "echo": payload }));
    };
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| format!("Parse failed: {}", e))?;
    let kind = parsed
      .get("kind")
      .and_then(|v| v.as_str())
      .unwrap_or("");
    if kind != "settings_backup" {
      return Err("File is not a SHOGUN settings backup.".to_string());
    }
    let sections = parsed
      .pointer("/settings/sections")
      .and_then(|x| x.as_object())
      .ok_or_else(|| "Backup has no settings.sections".to_string())?;

    let mut restored = 0u32;
    for (section_name, section_val) in sections.iter() {
      let Some(obj) = section_val.as_object() else {
        continue;
      };
      let mut patch = serde_json::Map::new();
      patch.insert("section".to_string(), json!(section_name));
      for (k, v) in obj.iter() {
        patch.insert(k.clone(), v.clone());
      }
      settings_store::save_patch(&Value::Object(patch))?;
      restored += 1;
    }
    Ok(json!({
      "imported": true,
      "sections": restored,
      "path": path.display().to_string(),
      "stub": false,
      "echo": payload,
    }))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Settings import is only available on macOS.".to_string())
  }
}


#[tauri::command]
pub fn shogun_dead_letter_list(payload: Value) -> Result<Value, String> {
  let limit = payload
    .get("limit")
    .and_then(|x| x.as_i64())
    .unwrap_or(200);
  let source = payload
    .get("source")
    .and_then(|x| x.as_str())
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());
  let items = dead_letter::list(limit, source.as_deref())?;
  let counts = dead_letter::counts()?;
  Ok(json!({ "items": items, "counts": counts }))
}


#[tauri::command]
pub fn shogun_dead_letter_retry(payload: Value) -> Result<Value, String> {
  let limit = payload
    .get("limit")
    .and_then(|x| x.as_i64())
    .unwrap_or(500);
  let source = payload
    .get("source")
    .and_then(|x| x.as_str())
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());
  dead_letter::retry_all(limit, source.as_deref())
}


#[tauri::command]
pub fn shogun_dead_letter_clear(payload: Value) -> Result<Value, String> {
  let source = payload
    .get("source")
    .and_then(|x| x.as_str())
    .filter(|s| !s.is_empty())
    .map(|s| s.to_string());
  let removed = dead_letter::clear(source.as_deref())?;
  Ok(json!({ "removed": removed }))
}


#[tauri::command]
pub fn shogun_dead_letter_retry_one(payload: Value) -> Result<Value, String> {
  let id = payload
    .get("id")
    .and_then(|x| x.as_i64())
    .ok_or_else(|| "id is required".to_string())?;
  dead_letter::retry_one(id)
}


#[tauri::command]
pub fn shogun_dead_letter_delete(payload: Value) -> Result<Value, String> {
  let id = payload
    .get("id")
    .and_then(|x| x.as_i64())
    .ok_or_else(|| "id is required".to_string())?;
  dead_letter::delete_by_id(id)?;
  Ok(json!({ "deleted": true, "id": id }))
}


#[tauri::command]
pub fn app_capture_pause(payload: Value) -> Result<Value, String> {
  // `paused` is now the single source of truth for "should the capture sampler
  // run?". Legacy `pipelineAvailable` keys in existing settings.json stay
  // around but are ignored by the sampler — see capture_sampler::sampler_should_run_for.
  let _ = settings_store::save_patch(&json!({
    "section": "capture",
    "paused": true,
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
  }))?;
  Ok(json!({
    "paused": false,
    "honestPreferenceOnly": true,
    "message": "Capture resumed. macOS records app focus, AX context, and input events locally (no screenshots).",
    "stub": false,
    "echo": payload,
  }))
}


#[tauri::command]
pub fn shogun_capture_live_events(payload: Value) -> Result<Value, String> {
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(40) as usize;
  Ok(json!({
    "events": crate::capture_events::list_recent(limit),
    "eventsPerMinute": crate::capture_events::events_last_minute(),
    "stub": false,
    "echo": payload,
  }))
}


#[tauri::command]
pub fn shogun_capture_status(payload: Value) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let paused = settings
    .pointer("/sections/capture/paused")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  Ok(json!({
    "paused": paused,
    "permissions": crate::macos_permissions::status_snapshot(),
    "inputTapRunning": crate::macos_input::tap_running(),
    "eventsPerMinute": crate::capture_events::events_last_minute(),
    "stub": false,
    "echo": payload,
  }))
}


#[tauri::command]
pub fn app_onboarding_complete(payload: Value) -> Result<Value, String> {
  let doc = settings_store::save_patch(&json!({
    "section": "onboarding",
    "complete": true,
  }))?;
  let _ = settings_store::save_patch(&json!({
    "section": "capture",
    "paused": false,
  }))?;
  Ok(json!({
    "complete": true,
    "settings": doc,
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
      .unwrap_or("accessibility");
    if target == "screen_capture_request" {
      let granted = crate::macos_permissions::request_screen_capture_access();
      return Ok(json!({
        "requested": true,
        "granted": granted,
        "stub": false,
        "echo": payload,
      }));
    }
    let opened = crate::macos_permissions::open_privacy_pane(target);
    Ok(json!({
      "opened": opened,
      "note": "Opened System Settings for the requested privacy pane when supported.",
      "stub": false,
      "echo": payload,
    }))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Ok(json!({
      "opened": false,
      "note": "Privacy panes are macOS-only.",
      "stub": false,
      "echo": payload,
    }))
  }
}


#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
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
  let summary = json!({
    "capture": capture,
    "macosAccessibilityTrusted": ax_trusted,
    "integrations": {
      "google_calendar": google_calendar_summary,
      "calendarAutoSync": calendar_auto,
    },
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


#[tauri::command]
pub fn app_quit(app: AppHandle) -> Result<(), String> {
  app.exit(0);
  Ok(())
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
      if let Some(since_ms) = payload.get("sinceMs").and_then(|v| v.as_u64()) {
        since_ms
      } else {
        let hours = payload.get("hours").and_then(|v| v.as_u64()).unwrap_or(0);
        let days = payload.get("days").and_then(|v| v.as_u64()).unwrap_or(0);
        if hours == 0 && days == 0 {
          return Err(
            "Custom range requires sinceMs or a positive hours/days value.".to_string(),
          );
        }
        let mut cutoff = now;
        if days > 0 {
          cutoff = cutoff.saturating_sub(days.saturating_mul(86_400_000));
        }
        if hours > 0 {
          cutoff = cutoff.saturating_sub(hours.saturating_mul(3_600_000));
        }
        cutoff
      }
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
  paths::clear_app_data_files()?;
  let _ = secrets::clear_llm_api_key();
  let _ = secrets::clear_clerk_snapshot();
  integration_secrets::clear_all_known();
  Ok(json!({
    "deleted": true,
    "stub": false,
    "echo": payload,
  }))
}


#[tauri::command]
pub fn app_delete_account(payload: Value) -> Result<Value, String> {
  paths::clear_app_data_files()?;
  secrets::clear_llm_api_key()?;
  let _ = secrets::clear_clerk_snapshot();
  integration_secrets::clear_all_known();
  Ok(json!({
    "deleted": true,
    "note": "Local data cleared. No cloud account is associated with this build.",
    "stub": false,
    "echo": payload,
  }))
}
