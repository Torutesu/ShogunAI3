//! IPC handlers aligned with `hifi/lib/shogun-api.js` invoke names.

use crate::{
  auth, biometric, brief, brief_actions, dead_letter, embed_backfill, github, gmail,
  google_calendar, google_drive, integration_secrets, integrations, linear, llm, macos_ax,
  memory_export, memory_store, mirror, notion, secrets, settings_store, slack, zoom,
};
use crate::paths;
use crate::schedule_queue;
use rusqlite::params;
use serde_json::{json, Value};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

fn redact_sensitive_text(input: &str) -> String {
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
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn shogun_memory_export(payload: Value) -> Result<Value, String> {
  #[cfg(target_os = "macos")]
  {
    let Some(path) = rfd::FileDialog::new()
      .set_file_name("memory.shogun-memory.jsonl")
      .add_filter("SHOGUN Memory Export", &["jsonl"])
      .save_file()
    else {
      return Ok(json!({ "cancelled": true, "echo": payload }));
    };
    let conn = memory_store::open_conn()?;
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let n = memory_export::export_to_writer(&conn, &mut file)?;
    Ok(json!({
      "exported": n,
      "path": path.to_string_lossy(),
      "echo": payload,
    }))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Memory export is only available on macOS.".to_string())
  }
}

#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn shogun_memory_import(payload: Value) -> Result<Value, String> {
  memory_export::validate_import_payload(&payload)?;
  #[cfg(target_os = "macos")]
  {
    let Some(path) = rfd::FileDialog::new()
      .add_filter("SHOGUN Memory Export", &["jsonl"])
      .pick_file()
    else {
      return Ok(json!({ "cancelled": true, "echo": payload }));
    };
    let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = std::io::BufReader::new(file);
    let conn = memory_store::open_conn()?;
    let n = memory_export::import_from_reader(&conn, reader)?;
    Ok(json!({
      "imported": n,
      "path": path.to_string_lossy(),
      "echo": payload,
    }))
  }
  #[cfg(not(target_os = "macos"))]
  {
    Err("Memory import is only available on macOS.".to_string())
  }
}

#[tauri::command]
pub fn shogun_entity_query(payload: Value) -> Result<Value, String> {
  memory_store::entities_from_catalog(&payload)
}

#[tauri::command]
pub async fn shogun_brief_get(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  if brief::should_use_v2(&settings, &payload) {
    let user_tz = payload
      .get("user_tz")
      .and_then(|v| v.as_str())
      .unwrap_or("UTC");
    let ms = ts();
    return Ok(brief::morning_brief_v2_stub(ms, user_tz, &payload));
  }
  llm::brief_generate(&payload, Some(&*ring)).await
}

#[tauri::command]
pub async fn shogun_chat_complete(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  llm::chat_complete(&payload, Some(&*ring)).await
}

#[tauri::command]
pub async fn shogun_draft(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  llm::draft_from_payload(&payload, Some(&*ring)).await
}

#[tauri::command]
pub fn shogun_schedule_action(payload: Value) -> Result<Value, String> {
  schedule_queue::append(&payload)
}

/// KIOKU graph signals consumed by the AMC pipeline. Returns the same shape
/// as `MorningBriefCandidate.{related_kioku_hits, decision_graph_hits}` so
/// the Node orchestrator can splice the response into a candidate without a
/// translation layer.
///
/// Payload (all optional):
/// ```json
/// { "limit_decisions": 5, "limit_kioku": 12 }
/// ```
#[tauri::command]
pub fn shogun_kioku_brief_signals(payload: Value) -> Result<Value, String> {
  use crate::kioku_decision_graph::{fetch_decision_graph_hits, fetch_recent_kioku_hits};

  let limit_decisions = payload
    .get("limit_decisions")
    .and_then(|v| v.as_u64())
    .unwrap_or(5)
    .clamp(1, 50) as usize;
  let limit_kioku = payload
    .get("limit_kioku")
    .and_then(|v| v.as_u64())
    .unwrap_or(12)
    .clamp(1, 100) as usize;

  let conn = memory_store::open_conn()?;
  let decisions = fetch_decision_graph_hits(&conn, limit_decisions)?;
  let kioku = fetch_recent_kioku_hits(&conn, limit_kioku)?;

  Ok(json!({
    "decision_graph_hits": decisions,
    "related_kioku_hits": kioku,
  }))
}

/// Debug-only consolidated KIOKU observability snapshot (Phase 2 §8 follow-up).
/// Returns queue depth, monthly cost, graph counts, active flags, and rules
/// summary in one payload so the dev `Memory Debugger` UI can render them
/// without N round-trips.
#[tauri::command]
pub fn shogun_kioku_debug_stats(_payload: Value) -> Result<Value, String> {
  let conn = memory_store::open_conn()?;
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let now_ms = ts() as i64;
  crate::kioku_debug_stats::assemble_debug_stats(&conn, &settings, now_ms)
}

/// Run `VACUUM INTO` on the live `memory.db` to produce a consistent
/// compacted copy. Designed to be wired to the `Settings > KIOKU Graph >
/// Backup` button so operators can grab a snapshot before
/// `shogun_kioku_stage5_apply` (or anytime, really).
///
/// Payload:
/// ```jsonc
/// { "dest_path": "/optional/explicit/path.db", "label": "pre-stage5" }
/// ```
/// `dest_path` overrides the default location entirely; `label` is splice-d
/// into the default name (`memory.db.<label>-YYYY-MM-DD-HHMMSS`) for quick
/// labeling without typing the whole path. `dest_path` wins when both are
/// supplied.
#[tauri::command]
pub fn shogun_kioku_backup_db(payload: Value) -> Result<Value, String> {
  use std::path::{Path, PathBuf};
  let conn = memory_store::open_conn()?;
  let source = memory_store::db_path()?;
  let now_ms = ts() as i64;

  let dest: PathBuf = if let Some(explicit) = payload
    .get("dest_path")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
  {
    PathBuf::from(explicit)
  } else {
    let default = crate::kioku_backup::default_backup_dest(&source, now_ms);
    if let Some(label) = payload
      .get("label")
      .and_then(|v| v.as_str())
      .map(|s| s.trim())
      .filter(|s| !s.is_empty())
    {
      // Replace the ".backup-" prefix with the caller's label so e.g.
      // `pre-stage5-2026-04-27-...` lands without manual rename.
      if let Some(name) = default.file_name().and_then(|s| s.to_str()) {
        let renamed = name.replace(".backup-", &format!(".{}-", label));
        let dir = default
          .parent()
          .map(Path::to_path_buf)
          .unwrap_or_else(|| PathBuf::from("."));
        dir.join(renamed)
      } else {
        default
      }
    } else {
      default
    }
  };

  let result = crate::kioku_backup::backup_db(&conn, &source, &dest, now_ms)?;
  serde_json::to_value(&result).map_err(|e| e.to_string())
}

/// Stage 5 dry-run. Read-only — counts and reports without touching any data.
/// Output is JSON-serializable and intended to be archived under
/// `docs/kioku-stage5-${YYYY-MM-DD}-dryrun.txt` for Select review before
/// the matching apply command is run.
#[tauri::command]
pub fn shogun_kioku_stage5_dry_run(_payload: Value) -> Result<Value, String> {
  let conn = memory_store::open_conn()?;
  let now_ms = ts() as i64;
  let report = crate::kioku_stage5::run_dry_run(&conn, now_ms)?;
  serde_json::to_value(&report).map_err(|e| e.to_string())
}

/// Stage 5 destructive apply. **Gated** behind both:
///   - `settings.kioku_graph.stage5_apply == true` (persisted opt-in)
///   - `payload.confirm_token == "APPLY"` (per-call confirmation)
///
/// Sub-actions follow the migration plan §Stage 5.2–5.5 ordering. Each is
/// individually opt-in via the payload booleans so reviewers can run them in
/// sequence on different days. Default `false` ⇒ no-op.
///
/// Payload:
/// ```jsonc
/// {
///   "confirm_token": "APPLY",
///   "soft_retire": true,
///   "cleanup_ttl": true,
///   "physical_delete": false,
///   "vacuum": false
/// }
/// ```
#[tauri::command]
pub fn shogun_kioku_stage5_apply(payload: Value) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let flag = settings
    .pointer("/sections/kioku_graph/stage5_apply")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  if !flag {
    return Err(
      "Stage 5 apply gate is OFF. Set `settings.sections.kioku_graph.stage5_apply = true` and \
       re-run with `confirm_token = APPLY` after reviewing the dry-run output."
        .into(),
    );
  }
  let confirm = payload
    .get("confirm_token")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  if confirm != "APPLY" {
    return Err(
      "Stage 5 apply requires `confirm_token = \"APPLY\"` in the payload (per-call \
       confirmation, not just the persisted flag)."
        .into(),
    );
  }

  let conn = memory_store::open_conn()?;
  let now_ms = ts() as i64;
  let mut summary = json!({
    "soft_retire": null,
    "cleanup_ttl": null,
    "physical_delete": null,
    "vacuum": null,
  });

  let do_soft = payload.get("soft_retire").and_then(|v| v.as_bool()).unwrap_or(false);
  let do_ttl = payload.get("cleanup_ttl").and_then(|v| v.as_bool()).unwrap_or(false);
  let do_delete = payload.get("physical_delete").and_then(|v| v.as_bool()).unwrap_or(false);
  let do_vacuum = payload.get("vacuum").and_then(|v| v.as_bool()).unwrap_or(false);

  if do_soft {
    let n = crate::kioku_stage5::soft_retire_capture_rows(&conn, now_ms)?;
    summary["soft_retire"] = json!({ "rows_retired": n });
  }
  if do_ttl {
    let r = crate::kioku_stage5::cleanup_ttl_expired_captures(&conn, now_ms)?;
    summary["cleanup_ttl"] = json!({
      "rows_marked_expired": r.rows_marked_expired,
      "raw_paths_unlinked": r.raw_paths_unlinked,
      "raw_text_nulled": r.raw_text_nulled,
    });
  }
  if do_delete {
    let n = crate::kioku_stage5::physical_delete_old_capture_rows(&conn, now_ms)?;
    summary["physical_delete"] = json!({ "rows_deleted": n });
  }
  if do_vacuum {
    crate::kioku_stage5::vacuum_db(&conn)?;
    summary["vacuum"] = json!({ "ok": true });
  }
  Ok(json!({
    "applied_at_ms": now_ms,
    "actions": summary,
  }))
}

/// List `edge_type_proposals` for the Stage 4 review UI.
///
/// Payload (all optional):
/// ```jsonc
/// { "only_unreviewed": true, "limit": 30 }
/// ```
/// `only_unreviewed = true` is the default — operators usually only want
/// to act on rows the worker has freshly proposed. `limit = 0` returns
/// every row.
#[tauri::command]
pub fn shogun_kioku_edge_type_proposals(payload: Value) -> Result<Value, String> {
  let only_unreviewed = payload
    .get("only_unreviewed")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(50)
    .min(500) as usize;
  let conn = memory_store::open_conn()?;
  let rows = crate::kioku_edge_types::list_proposals(&conn, only_unreviewed, limit)?;
  serde_json::to_value(&rows)
    .map(|arr| json!({ "proposals": arr }))
    .map_err(|e| e.to_string())
}

/// Stamp a review decision on an `edge_type_proposals` row.
///
/// Payload:
/// ```jsonc
/// {
///   "edge_type": "discusses",
///   "status": 1,                    // 0 unreview / 1 accept / 2 reject
///   "note": "matches AMC schema"    // optional
/// }
/// ```
#[tauri::command]
pub fn shogun_kioku_edge_type_review(payload: Value) -> Result<Value, String> {
  let edge_type = payload
    .get("edge_type")
    .and_then(|v| v.as_str())
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "edge_type is required".to_string())?;
  let status = payload
    .get("status")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "status is required (0=unreview, 1=accept, 2=reject)".to_string())?;
  let note = payload
    .get("note")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty());
  let conn = memory_store::open_conn()?;
  let n = crate::kioku_edge_types::set_review_status(&conn, edge_type, status, note)?;
  Ok(json!({
    "updated": n,
    "edge_type": edge_type,
    "status": status,
  }))
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

/// `shogun_oauth_google_start` — Run the in-app Google OAuth flow and save
/// tokens for both gmail and google_calendar providers. Replaces the manual
/// scripts/oauth-google.mjs + DevTools-paste workflow.
///
/// payload: { "provider": "gmail" | "google_calendar" }
///
/// Returns: {
///   ok: true,
///   provider: "<echoed from input>",
///   scopes: [...],
///   expiresAt: <epoch_seconds | null>,
///   refreshTokenPresent: <bool>,
/// }
///
/// Token strings are NEVER returned to the frontend.
#[tauri::command]
pub async fn shogun_oauth_google_start(
  app: AppHandle,
  payload: Value,
) -> Result<Value, String> {
  let provider = payload
    .get("provider")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "oauth_invalid_provider".to_string())?;
  if provider != "gmail" && provider != "google_calendar" {
    return Err("oauth_invalid_provider".into());
  }

  let tokens = crate::oauth_flow::run(None).await.map_err(String::from)?;

  // Save tokens for BOTH providers — a single Google OAuth grants both
  // scopes in one consent, matching scripts/oauth-google.mjs's behavior.
  for save_provider in ["gmail", "google_calendar"] {
    let mut save_payload = json!({
      "provider": save_provider,
      "accessToken": tokens.access_token,
      "oauthClientId": tokens.client_id,
      "oauthClientSecret": tokens.client_secret,
    });
    if let Some(rt) = &tokens.refresh_token {
      save_payload["refreshToken"] = json!(rt);
    }
    if let Some(exp) = tokens.expires_at {
      save_payload["expiresAt"] = json!(exp);
    }
    if !tokens.scopes.is_empty() {
      save_payload["scopes"] = json!(tokens.scopes);
    }
    persist_integration_credentials_inner(&save_payload).map_err(|e| {
      format!("oauth_save_failed: {}", e)
    })?;
  }
  let _ = app.emit(
    "credentials-imported",
    json!({ "saved": true, "provider": provider, "via": "oauth_in_app" }),
  );

  Ok(json!({
    "ok": true,
    "provider": provider,
    "scopes": tokens.scopes,
    "expiresAt": tokens.expires_at,
    "refreshTokenPresent": tokens.refresh_token.is_some(),
  }))
}

#[tauri::command]
pub async fn shogun_google_calendar_sync(payload: Value) -> Result<Value, String> {
  let cal = payload
    .get("calendarId")
    .and_then(|c| c.as_str())
    .unwrap_or("primary");
  let days_opt = payload.get("days").and_then(|d| d.as_u64());
  let is_historical = days_opt.is_some();
  let default_max: u64 = if is_historical { 500 } else { 25 };
  let cap_max: u64 = if is_historical { 2500 } else { 50 };
  let max = payload
    .get("maxResults")
    .and_then(|m| m.as_u64())
    .unwrap_or(default_max)
    .clamp(1, cap_max) as usize;
  let past_days = days_opt.unwrap_or(0).min(366) as u32;
  google_calendar::sync_events_to_memory(cal, max, past_days).await
}

#[tauri::command]
pub async fn shogun_gmail_sync(payload: Value) -> Result<Value, String> {
  let days_opt = payload.get("days").and_then(|d| d.as_u64());
  let is_historical = days_opt.is_some();
  let default_max: u64 = if is_historical { 500 } else { 20 };
  let cap_max: u64 = if is_historical { 500 } else { 50 };
  let max = payload
    .get("maxResults")
    .and_then(|m| m.as_u64())
    .unwrap_or(default_max)
    .clamp(1, cap_max) as usize;
  let days = days_opt.map(|d| d.min(366) as u32);
  gmail::sync_inbox_to_memory(max, days).await
}

#[tauri::command]
pub async fn shogun_slack_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_per_channel = payload
    .get("maxPerChannel")
    .and_then(|m| m.as_u64())
    .unwrap_or(500)
    .clamp(1, 1000) as usize;
  slack::sync_workspace_to_memory(days, max_per_channel).await
}

#[tauri::command]
pub async fn shogun_notion_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_pages = payload
    .get("maxPages")
    .and_then(|m| m.as_u64())
    .unwrap_or(1000)
    .clamp(1, 5000) as usize;
  notion::sync_workspace_to_memory(days, max_pages).await
}

#[tauri::command]
pub async fn shogun_github_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_items = payload
    .get("maxItems")
    .and_then(|m| m.as_u64())
    .unwrap_or(500)
    .clamp(1, 2000) as usize;
  github::sync_activity_to_memory(days, max_items).await
}

#[tauri::command]
pub async fn shogun_linear_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_items = payload
    .get("maxItems")
    .and_then(|m| m.as_u64())
    .unwrap_or(500)
    .clamp(1, 2000) as usize;
  linear::sync_activity_to_memory(days, max_items).await
}

#[tauri::command]
pub async fn shogun_drive_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_files = payload
    .get("maxFiles")
    .and_then(|m| m.as_u64())
    .unwrap_or(500)
    .clamp(1, 3000) as usize;
  google_drive::sync_drive_to_memory(days, max_files).await
}

/// Export the full settings document as JSON to a user-picked file. Skips
/// credential secrets (those live in Keychain / integration_secrets, not in
/// settings.json, so the settings file is already safe to share).
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

/// Import a settings JSON file (previously produced by `app_settings_export`)
/// and merge each top-level section via `save_patch`. Individual sections are
/// replaced wholesale — the user explicitly chose this file, so we trust it
/// over the current state. Credentials are untouched.
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
pub async fn shogun_zoom_sync(payload: Value) -> Result<Value, String> {
  let days = payload
    .get("days")
    .and_then(|d| d.as_u64())
    .map(|d| d.min(366) as u32);
  let max_meetings = payload
    .get("maxMeetings")
    .and_then(|m| m.as_u64())
    .unwrap_or(50)
    .clamp(1, 200) as usize;
  zoom::sync_recordings_to_memory(days, max_meetings).await
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

#[tauri::command]
pub async fn shogun_open_pack(payload: Value) -> Result<Value, String> {
  brief_actions::open_pack(&payload).await
}

#[tauri::command]
pub fn shogun_start_focus_session(payload: Value) -> Result<Value, String> {
  brief_actions::start_focus_session(&payload)
}

#[tauri::command]
pub async fn shogun_draft_reply(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  llm::draft_reply_for_brief(&payload, Some(&*ring)).await
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

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn shogun_memory_debug_query(
  payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  use crate::context_assembly;
  let query = payload
    .get("query")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(12)
    .clamp(1, 80);
  let semantic = payload
    .get("semantic")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: &query,
    limit,
    semantic,
    // Debug command — keep raw signal so the dev tool surfaces every hit.
    excluded_provenances: None,
  })
  .await?;

  let draft_block = context_assembly::format_hits_draft_context(&hits, 10_000);
  let brief_block = context_assembly::format_hits_brief_json_prompt(&hits, 10_000);
  let reply_block = context_assembly::format_hits_reply_draft(&hits);

  let items: Vec<serde_json::Value> = hits
    .iter()
    .map(|h| {
      serde_json::json!({
        "id": h.id,
        "title": h.title,
        "snippet": h.snippet,
        "source": h.source,
        "provenance": h.provenance,
        "created_at": h.created_at,
      })
    })
    .collect();

  Ok(serde_json::json!({
    "hits": items,
    "draft_block": draft_block,
    "brief_block": brief_block,
    "reply_block": reply_block,
    "query": query,
    "limit": limit,
    "semantic": semantic,
  }))
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_recent_calls(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(50)
    .min(crate::memory_debug::RING_CAPACITY as u64) as usize;
  let calls = ring.snapshot(limit);
  Ok(serde_json::json!({
    "calls": calls,
    "capacity": crate::memory_debug::RING_CAPACITY,
  }))
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_stats() -> Result<serde_json::Value, String> {
  crate::memory_store::stats_extended()
}

#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_sync_status() -> Result<serde_json::Value, String> {
  use crate::integration_secrets;
  use crate::settings_store;

  let cal_snap = crate::calendar_sync::snapshot_state();
  let gmail_snap = crate::gmail::snapshot_state();
  let doc = settings_store::load().unwrap_or_else(|_| serde_json::json!({ "sections": {} }));
  let auto_cal = doc
    .pointer("/sections/integrations/googleCalendarAutoSync")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let cal_creds = integration_secrets::get_credentials("google_calendar")
    .ok()
    .flatten()
    .is_some();
  let gmail_creds = integration_secrets::get_credentials("gmail")
    .ok()
    .flatten()
    .is_some();

  Ok(serde_json::json!({
    "google_calendar": {
      "last_sync_ms": cal_snap.last_sync_ms,
      "last_ingested": cal_snap.last_ingested,
      "last_error": cal_snap.last_error,
      "last_duration_ms": cal_snap.last_duration_ms,
      "credentials_present": cal_creds,
      "auto_enabled": auto_cal,
    },
    "gmail": {
      "last_sync_ms": gmail_snap.last_sync_ms,
      "last_ingested": gmail_snap.last_ingested,
      "last_error": gmail_snap.last_error,
      "last_duration_ms": gmail_snap.last_duration_ms,
      "credentials_present": gmail_creds,
      "auto_enabled": false,
    }
  }))
}

#[tauri::command]
pub fn shogun_memory_debug_gate() -> Result<serde_json::Value, String> {
  // `cfg!` evaluates at compile time to a bool — safe to use inside
  // the function body (unlike `#[cfg(...)]` on expression blocks).
  if !cfg!(debug_assertions) {
    return Ok(serde_json::json!({
      "available": false,
      "reason": "release_build",
    }));
  }
  let enabled = settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/developer/memoryDebugger")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(false);
  Ok(serde_json::json!({
    "available": enabled,
    "reason": if enabled { "enabled" } else { "settings_disabled" },
  }))
}

// ---- Memory Digest Phase 1: summary commands ----

/// target_kind="item" 指定で特定 item の summary を取得。キャッシュ優先、なければ同期生成。
///
/// payload: { "targetId": "m_...", "targetKind"?: "item" (default), "item"?: { ... } }
///   - `item` が同梱されていれば再取得不要 (River 側で既に hit を持っている場合)
///   - 無ければ mem_items から fetch (Phase 1 では item 同梱必須 = UI 側で用意)
#[tauri::command]
pub async fn shogun_memory_summary_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId is required".to_string())?
    .to_string();
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item")
    .to_string();
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();

  // 1. cache lookup (lang-aware: mismatched language → cache miss → regen)
  if let Some(cached) = crate::summarizer_store::get_cached(&target_kind, &target_id, &lang)? {
    return Ok(serde_json::json!({ "summary": cached.to_json(), "cached": true }));
  }

  // 2. generate (Phase 1 は item のみサポート)
  if target_kind != "item" {
    return Err(format!("target_kind={} not supported in Phase 1", target_kind));
  }

  let item = payload
    .get("item")
    .cloned()
    .ok_or_else(|| "item payload required when cache miss".to_string())?;

  let summary = crate::summarizer::summarize_item(&item, &lang).await?;
  crate::summarizer_store::upsert(&summary)?;

  Ok(serde_json::json!({ "summary": summary.to_json(), "cached": false }))
}

/// 複数 item 分の summary を並列取得 (max 5)。Phase 1 では item のみ。
///
/// payload: { "items": [ { id, title, snippet, source, ... }, ... ] }
#[tauri::command]
pub async fn shogun_memory_summary_batch(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = payload
    .get("items")
    .and_then(|v| v.as_array())
    .cloned()
    .ok_or_else(|| "items array required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();

  if items.is_empty() {
    return Ok(serde_json::json!({ "ok": [], "failed": [], "heuristicUsed": 0 }));
  }

  // 1. cache lookup for all ids at once
  let ids: Vec<String> = items
    .iter()
    .filter_map(|it| it.get("id").and_then(|v| v.as_str()).map(String::from))
    .collect();
  let cached = crate::summarizer_store::get_cached_many("item", &ids, &lang)?;
  let cached_ids: std::collections::HashSet<String> =
    cached.iter().map(|s| s.target_id.clone()).collect();

  let mut ok_results: Vec<serde_json::Value> = cached.iter().map(|s| s.to_json()).collect();
  let mut failed_results: Vec<serde_json::Value> = Vec::new();
  let mut heuristic_used: u32 = 0;

  // 2. 未キャッシュの item を並列要約 (max 5 並列)
  let to_generate: Vec<serde_json::Value> = items
    .iter()
    .filter(|it| {
      it.get("id")
        .and_then(|v| v.as_str())
        .map_or(false, |id| !cached_ids.contains(id))
    })
    .cloned()
    .collect();

  for chunk in to_generate.chunks(5) {
    let futures: Vec<_> = chunk
      .iter()
      .map(|item| {
        let item_clone = item.clone();
        let lang_clone = lang.clone();
        async move {
          let target_id = item_clone
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
          match crate::summarizer::summarize_item(&item_clone, &lang_clone).await {
            Ok(s) => {
              if let Err(e) = crate::summarizer_store::upsert(&s) {
                log::warn!("summary upsert failed for {}: {}", target_id, e);
              }
              Ok(s)
            }
            Err(e) => Err((target_id, e)),
          }
        }
      })
      .collect();

    let results = futures::future::join_all(futures).await;
    for r in results {
      match r {
        Ok(s) => {
          if s.model == "heuristic" || s.model == "heuristic_prefilter" {
            heuristic_used += 1;
          }
          ok_results.push(s.to_json());
        }
        Err((id, e)) => {
          failed_results.push(serde_json::json!({ "targetId": id, "error": e }));
        }
      }
    }
  }

  Ok(serde_json::json!({
    "ok": ok_results,
    "failed": failed_results,
    "heuristicUsed": heuristic_used,
  }))
}

/// 特定 summary のキャッシュを削除。dev 用途 (次回 get で再生成)。
///
/// payload: { "targetId": "m_...", "targetKind"?: "item" }
#[tauri::command]
pub fn shogun_memory_summary_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  let deleted = crate::summarizer_store::delete(target_kind, target_id)?;
  Ok(serde_json::json!({ "deleted": deleted }))
}

/// 要約をスヌーズする (`untilMs` まで Home digest から非表示)。
/// `untilMs: null` (or omitted) でスヌーズ解除。
///
/// payload: { "targetId": "...", "targetKind"?: "item", "untilMs"?: i64 | null }
#[tauri::command]
pub fn shogun_memory_summary_snooze(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  let until_ms: Option<i64> = match payload.get("untilMs") {
    Some(v) if v.is_null() => None,
    Some(v) => Some(
      v.as_i64()
        .ok_or_else(|| "untilMs must be a number or null".to_string())?,
    ),
    None => None,
  };
  let updated = crate::summarizer_store::set_snoozed(target_kind, target_id, until_ms)?;
  Ok(serde_json::json!({ "updated": updated, "untilMs": until_ms }))
}

/// エンティティ単位ロールアップ (Phase 3)。`entityId` (例: 連絡先 / プロジェクト) に紐づく
/// 全アイテム要約を集約 → 1 つの "X の最近の動き" を生成。
///
/// payload: {
///   "entityId": "...",
///   "entityLabel"?: "...",  // UI で表示する人/プロジェクト名 (LLM プロンプトに渡す)
///   "lang"?: "en" | "jp" | "bi",
///   "regenerate"?: bool
/// }
#[tauri::command]
pub async fn shogun_memory_entity_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let entity_id = payload
    .get("entityId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "entityId is required".to_string())?
    .to_string();
  let entity_label = payload
    .get("entityLabel")
    .and_then(|v| v.as_str())
    .unwrap_or(&entity_id)
    .to_string();
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("entity_rollup", &entity_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_entity_rollup(&entity_id, &entity_label, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// 要約を "既読" にする (または未読に戻す)。`items` の配列で複数を一括処理可能。
/// unread に戻す場合は `acknowledged: false` を渡す (デフォルトは true = now_ms())。
///
/// payload: {
///   "items": [{ "targetId": "m_...", "targetKind"?: "item" }, ...],
///   "acknowledged"?: bool (default true)
/// }
#[tauri::command]
pub fn shogun_memory_summary_acknowledge(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = payload
    .get("items")
    .and_then(|v| v.as_array())
    .cloned()
    .ok_or_else(|| "items array required".to_string())?;
  let acknowledged = payload
    .get("acknowledged")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let ack_ms: Option<i64> = if acknowledged {
    Some(
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0),
    )
  } else {
    None
  };

  let pairs_owned: Vec<(String, String)> = items
    .iter()
    .filter_map(|it| {
      let id = it.get("targetId").and_then(|v| v.as_str())?.to_string();
      let kind = it
        .get("targetKind")
        .and_then(|v| v.as_str())
        .unwrap_or("item")
        .to_string();
      Some((kind, id))
    })
    .collect();
  let pairs_ref: Vec<(&str, &str)> = pairs_owned
    .iter()
    .map(|(k, i)| (k.as_str(), i.as_str()))
    .collect();
  let updated = if let Some(ms) = ack_ms {
    crate::summarizer_store::acknowledge_many(&pairs_ref, ms)?
  } else {
    let mut n: u64 = 0;
    for (k, id) in &pairs_ref {
      if crate::summarizer_store::set_acknowledged(k, id, None)? {
        n += 1;
      }
    }
    n
  };
  Ok(serde_json::json!({ "updated": updated, "acknowledged": acknowledged }))
}

/// 週次ロールアップ要約を取得 (キャッシュヒット時は即返、無ければ生成)。
///
/// payload: { "weekStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// weekStartMs は週の開始 (通常 Monday 00:00 local) の ms。UI で計算して渡す。
#[tauri::command]
pub async fn shogun_memory_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let week_start_ms = payload
    .get("weekStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "weekStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let week_id = crate::summarizer::format_week_id(week_start_ms);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("week_rollup", &week_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_week_rollup(week_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// 日次ロールアップ要約 (Phase 2.5)。週と同じキャッシュインフラ、target_kind="day_rollup"。
///
/// payload: { "dayStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// dayStartMs は日の開始 (通常 00:00 local) の ms。UI で計算して渡す。
#[tauri::command]
pub async fn shogun_memory_day_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let day_start_ms = payload
    .get("dayStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "dayStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let day_id = crate::summarizer::format_week_id(day_start_ms); // YYYY-MM-DD

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("day_rollup", &day_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_day_rollup(day_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// 月次ロールアップ要約を取得 (キャッシュヒット時は即返、無ければ生成)。
///
/// payload: { "monthStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// monthStartMs は対象月の1日 00:00 (local) の ms。UI で計算して渡す。
#[tauri::command]
pub async fn shogun_memory_month_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let month_start_ms = payload
    .get("monthStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "monthStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let month_id = crate::summarizer::format_month_id(month_start_ms);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("month_rollup", &month_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_month_rollup(month_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// 年次ロールアップ要約 — 構成元は当年内の月次ロールアップ12件。
/// 未キャッシュの月は内部で月次生成→upsert してから合成。
///
/// payload: { "yearStartMs": i64, "lang"?: "en" | "jp" | "bi", "regenerate"?: bool }
/// yearStartMs は対象年の1月1日 00:00 (local) の ms。UI で計算して渡す。
/// regenerate=true は YEAR キャッシュのみ無効化する。月次キャッシュは保持。
#[tauri::command]
pub async fn shogun_memory_year_rollup_get(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let year_start_ms = payload
    .get("yearStartMs")
    .and_then(|v| v.as_i64())
    .ok_or_else(|| "yearStartMs is required".to_string())?;
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  let regenerate = payload
    .get("regenerate")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let year_id = crate::summarizer::format_year_id(year_start_ms);

  if !regenerate {
    if let Some(cached) = crate::summarizer_store::get_cached("year_rollup", &year_id, &lang)? {
      return Ok(serde_json::json!({ "rollup": cached.to_json(), "cached": true }));
    }
  }

  let rollup = crate::summarizer::summarize_year_rollup(year_start_ms, &lang).await?;
  crate::summarizer_store::upsert(&rollup)?;
  Ok(serde_json::json!({ "rollup": rollup.to_json(), "cached": false }))
}

/// Capture a user-rejected chat reply as a Lesson. Frontend calls this from
/// the "Bad response" button click.
///
/// payload: { "userMsg": string, "assistantMsg": string, "chatId"?: string }
#[tauri::command]
pub async fn shogun_lesson_capture_rejection(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let user_msg = payload
    .get("userMsg")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "userMsg is required".to_string())?;
  let assistant_msg = payload
    .get("assistantMsg")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "assistantMsg is required".to_string())?;
  let chat_id = payload.get("chatId").and_then(|v| v.as_str()).map(|s| s.to_string());

  let system = "You generate a one-sentence actionable rule (English) explaining what the AI should NOT do, based on a rejected response. <= 140 chars. Be specific and concrete. Example: 'Don't use emojis in meeting notes.' Output via the emit_lesson_rule tool only.";
  let user_content = format!(
    "User asked: {}\n\nAI replied: {}\n\nUser flagged this reply as bad.",
    user_msg, assistant_msg
  );
  let tool = serde_json::json!({
    "name": "emit_lesson_rule",
    "description": "Emit a single actionable rule.",
    "input_schema": {
      "type": "object",
      "properties": { "rule": { "type": "string" } },
      "required": ["rule"]
    }
  });

  let rule = match crate::llm::anthropic_tool_complete(system, &user_content, &tool, "claude-haiku-4-5-20251001").await {
    Ok(input) => input
      .get("rule")
      .and_then(|v| v.as_str())
      .map(|s| s.trim().to_string())
      .filter(|s| !s.is_empty())
      .unwrap_or_else(|| {
        let date = chrono::Local::now().format("%Y-%m-%d");
        format!("Avoid replies similar to one rejected on {}", date)
      }),
    Err(e) => {
      log::warn!("lesson rejection rule LLM error: {}", e);
      let date = chrono::Local::now().format("%Y-%m-%d");
      format!("Avoid replies similar to one rejected on {}", date)
    }
  };

  let embedding = crate::embeddings::embed_one(&rule).await.ok();

  let conn = crate::memory_store::open_conn()?;
  let id = crate::lessons::insert_lesson(
    &conn,
    &crate::lessons::NewLesson {
      category: "user_rejection".to_string(),
      trigger_context: serde_json::json!({"userMsg": user_msg, "chatId": chat_id}),
      attempted: serde_json::json!({"assistantMsg": assistant_msg}),
      outcome: serde_json::json!({"feedback": "user_rejected"}),
      rule: rule.clone(),
      source: "explicit_feedback".to_string(),
      embedding,
    },
  )?;
  Ok(serde_json::json!({ "id": id, "rule": rule }))
}

/// Capture an agent Run-now tool failure as a Lesson. Frontend calls this from
/// the runAgentNow callback's failure branch in screens-agents.jsx.
///
/// payload: { "agentId": string, "agentName": string, "action": string, "payload": object, "errorMessage": string }
#[tauri::command]
pub async fn shogun_lesson_capture_tool_failure(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let agent_id = payload
    .get("agentId")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "agentId is required".to_string())?
    .to_string();
  let agent_name = payload
    .get("agentName")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "agentName is required".to_string())?
    .to_string();
  let action = payload
    .get("action")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "action is required".to_string())?
    .to_string();
  let inner_payload = payload.get("payload").cloned().unwrap_or(serde_json::json!({}));
  let error_message = payload
    .get("errorMessage")
    .and_then(|v| v.as_str())
    .map(|s| s.trim())
    .filter(|s| !s.is_empty())
    .ok_or_else(|| "errorMessage is required".to_string())?
    .to_string();

  let conn = crate::memory_store::open_conn()?;

  let attempted = serde_json::json!({"action": action, "payload": inner_payload, "agentId": agent_id});
  let outcome = serde_json::json!({"errorMessage": error_message});
  let attempted_json = attempted.to_string();
  let outcome_json = outcome.to_string();

  if let Some(existing_id) = crate::lessons::recent_match(
    &conn,
    "tool_failure",
    &attempted_json,
    &outcome_json,
    24 * 60 * 60 * 1000,
  )? {
    return Ok(serde_json::json!({ "id": existing_id, "deduped": true }));
  }

  let payload_pretty = serde_json::to_string(&inner_payload).unwrap_or_else(|_| "{}".to_string());
  let system = "You generate a one-sentence actionable rule (English) explaining a precondition or constraint to check before invoking a tool, based on an observed failure. <= 140 chars. Output via the emit_lesson_rule tool only.";
  let user_content = format!(
    "Agent '{}' invoked tool '{}' with payload {} and got error: {}.\nWhat rule should the AI follow next time?",
    agent_name, action, payload_pretty, error_message
  );
  let tool = serde_json::json!({
    "name": "emit_lesson_rule",
    "description": "Emit a single actionable rule.",
    "input_schema": {
      "type": "object",
      "properties": { "rule": { "type": "string" } },
      "required": ["rule"]
    }
  });

  let rule = match crate::llm::anthropic_tool_complete(system, &user_content, &tool, "claude-haiku-4-5-20251001").await {
    Ok(input) => input
      .get("rule")
      .and_then(|v| v.as_str())
      .map(|s| s.trim().to_string())
      .filter(|s| !s.is_empty())
      .unwrap_or_else(|| format!("{} failed with: {} — verify preconditions", action, error_message)),
    Err(e) => {
      log::warn!("lesson tool_failure rule LLM error: {}", e);
      format!("{} failed with: {} — verify preconditions", action, error_message)
    }
  };

  let embedding = crate::embeddings::embed_one(&rule).await.ok();

  let id = crate::lessons::insert_lesson(
    &conn,
    &crate::lessons::NewLesson {
      category: "tool_failure".to_string(),
      trigger_context: serde_json::json!({"agentId": agent_id, "agentName": agent_name}),
      attempted,
      outcome,
      rule: rule.clone(),
      source: "tool_error".to_string(),
      embedding,
    },
  )?;
  Ok(serde_json::json!({ "id": id, "deduped": false, "rule": rule }))
}


/// Manually trigger Patterns detection (KIOKU Sub-spec B). Useful for
/// the Settings UI / Memory DBG hooks. Daily background sync covers
/// the production cadence.
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}

/// Manually trigger Supersession detection (KIOKU Sub-spec D). Useful for
/// the Memory DBG hooks. 30-day background sync covers production cadence.
#[tauri::command]
pub async fn shogun_supersession_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let marked = crate::supersession::run_supersession().await?;
  Ok(serde_json::json!({ "marked": marked }))
}

/// Sub-spec C: list active patterns for the Settings UI.
#[tauri::command]
pub fn shogun_patterns_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = crate::patterns::list_for_brief(50, true)?;
  Ok(serde_json::json!({ "items": items }))
}

/// Sub-spec C: invalidate a pattern (`これ違う`). Sets status='stale'.
#[tauri::command]
pub fn shogun_patterns_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload
    .get("id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  crate::patterns::invalidate(id)?;
  Ok(serde_json::json!({ "ok": true }))
}

/// Sub-spec C: list active lessons for the Settings UI.
#[tauri::command]
pub fn shogun_lessons_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let items = crate::lessons::list_active(&conn, 50)?;
  let trimmed: Vec<serde_json::Value> = items
    .iter()
    .map(|l| {
      serde_json::json!({
        "id": l.id,
        "rule": l.rule,
        "category": l.category,
        "applies_n": l.applies_n,
        "created_at": l.created_at,
      })
    })
    .collect();
  Ok(serde_json::json!({ "items": trimmed }))
}

/// Sub-spec C: archive a lesson (`忘れて`). Sets status='archived'.
#[tauri::command]
pub fn shogun_lessons_archive(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload
    .get("id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  let conn = crate::memory_store::open_conn()?;
  crate::lessons::archive(&conn, id)?;
  Ok(serde_json::json!({ "ok": true }))
}

/// Sub-spec C: cumulative stats for the Lessons header.
/// Returns total active lessons + cumulative applies_n sum.
#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let total: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats count: {}", e))?;
  let applied: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(applies_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum applies: {}", e))?;
  let prevented: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(prevented_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum prevented: {}", e))?;
  Ok(serde_json::json!({
    "total_active": total,
    "applied_total": applied,
    "prevented_total": prevented,
  }))
}

/// Manual priority override. Lets the user pin a summary as HIGH / MED / LOW
/// even when the LLM classified it differently, or clear the override back to
/// the LLM assignment. `priority: null` clears the override.
///
/// payload: { "targetId": "m_...", "targetKind"?: "item", "priority"?: "high" | "medium" | "low" | null }
#[tauri::command]
pub fn shogun_memory_summary_set_priority(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  // priority: either a string ('high'|'medium'|'low') to set, or explicit
  // null / missing key to clear the override.
  let priority_opt: Option<String> = match payload.get("priority") {
    Some(v) if v.is_null() => None,
    Some(v) => Some(
      v.as_str()
        .ok_or_else(|| "priority must be a string or null".to_string())?
        .to_string(),
    ),
    None => None,
  };
  let updated = crate::summarizer_store::set_user_priority(
    target_kind,
    target_id,
    priority_opt.as_deref(),
  )?;
  Ok(serde_json::json!({ "updated": updated, "userPriority": priority_opt }))
}

// ─── Phase 2.1.2: Mirror IPC commands ────────────────────────────────────────

/// Register this device with a Mirror server.
/// Payload: { server_url, registration_code, device_name? }
/// Returns: { device_id }
#[tauri::command]
pub async fn mirror_register(payload: Value) -> Result<Value, String> {
  let server_url = payload
    .get("server_url")
    .and_then(|v| v.as_str())
    .ok_or("server_url required")?
    .to_string();
  let registration_code = payload
    .get("registration_code")
    .and_then(|v| v.as_str())
    .ok_or("registration_code required")?;
  let device_name = payload
    .get("device_name")
    .and_then(|v| v.as_str())
    .unwrap_or("My Mac");

  let client = mirror::http::Client::new_unauthenticated(server_url.clone())
    .map_err(|e| e.to_string())?;
  let registration = client
    .register_device(registration_code, device_name)
    .await
    .map_err(|e| e.to_string())?;

  // Persist device_id + server_url to settings.
  settings_store::save_patch(&json!({
    "section": "cloud_mirror",
    "enabled": true,
    "server_url": server_url,
    "device_id": registration.device_id,
  }))?;

  // Persist device_token to Keychain.
  #[cfg(target_os = "macos")]
  mirror::keychain::save_device_token(&registration.device_token)?;

  // Wire up the authenticated client in the SyncEngine.
  let auth_client = mirror::http::Client::new(server_url, registration.device_token)
    .map_err(|e| e.to_string())?;
  mirror::sync::SyncEngine::global().set_client(auth_client);

  Ok(json!({ "device_id": registration.device_id, "stub": false }))
}

/// Unlock Mirror by deriving the MasterKey from the user's passphrase.
/// Payload: { passphrase }
/// Returns: {}
#[tauri::command]
pub fn mirror_unlock(payload: Value) -> Result<Value, String> {
  let passphrase = payload
    .get("passphrase")
    .and_then(|v| v.as_str())
    .ok_or("passphrase required")?;
  mirror::sync::SyncEngine::global().unlock(passphrase)?;
  Ok(json!({ "stub": false }))
}

/// Return the current Mirror sync status.
/// Returns: { enabled, queue_depth, last_sync_at, last_error, locked, device_id }
#[tauri::command]
pub fn mirror_status(_payload: Value) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  let enabled = settings
    .get("sections")
    .and_then(|s| s.get("cloud_mirror"))
    .and_then(|m| m.get("enabled"))
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let device_id = settings
    .get("sections")
    .and_then(|s| s.get("cloud_mirror"))
    .and_then(|m| m.get("device_id"))
    .and_then(|v| v.as_str())
    .map(String::from);

  let stats = mirror::sync::SyncEngine::global().stats();

  Ok(json!({
    "enabled": enabled,
    "queue_depth": stats.queue_depth,
    "last_sync_at": stats.last_sync_at,
    "last_error": stats.last_error,
    "locked": stats.locked,
    "device_id": device_id,
    "stub": false,
  }))
}

/// Trigger an immediate sync cycle outside the schedule.
/// Returns: { synced_count }
///
/// Async (Fix #6): `run_cycle` is synchronous and may take seconds (SQLite
/// I/O + HTTP via the dedicated `MIRROR_RUNTIME`). Wrapping it in
/// `spawn_blocking` keeps the Tauri async runtime free for other IPC during
/// a long sync, and avoids holding a Tauri command worker thread.
#[tauri::command]
pub async fn mirror_sync_now(_payload: Value) -> Result<Value, String> {
  let synced_count = tokio::task::spawn_blocking(|| {
    mirror::sync::SyncEngine::global().run_cycle()
  })
  .await
  .map_err(|e| format!("mirror_sync_now task join error: {}", e))??;
  Ok(json!({ "synced_count": synced_count, "stub": false }))
}

/// Reset all rows that the sync engine marked `excluded=stuck` back to
/// `local_only` so they can be retried. Used by the "Retry stuck rows"
/// admin action surfaced when `mirror_status.last_error` indicates stuck
/// rows. Sync-friendly: just a single `UPDATE`, no I/O over the wire.
/// Returns: { reset: <count> }
#[tauri::command]
pub async fn mirror_reset_stuck(_payload: Value) -> Result<Value, String> {
  let reset = tokio::task::spawn_blocking(|| -> Result<u64, String> {
    let conn = memory_store::open_conn()?;
    let updated = conn
      .execute(
        "UPDATE mem_items
         SET sync_status = 'local_only',
             sync_attempt_count = 0,
             sync_excluded_reason = NULL
         WHERE sync_status = 'excluded' AND sync_excluded_reason = 'stuck'",
        [],
      )
      .map_err(|e| e.to_string())?;
    Ok(updated as u64)
  })
  .await
  .map_err(|e| format!("mirror_reset_stuck task join error: {}", e))??;
  Ok(json!({ "reset": reset, "stub": false }))
}

/// Disable Mirror sync.
/// Payload: { wipe_keys?: bool }
/// Returns: {}
#[tauri::command]
pub fn mirror_disable(payload: Value) -> Result<Value, String> {
  let wipe_keys = payload
    .get("wipe_keys")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  // Always lock the engine (clears in-process MasterKey).
  mirror::sync::SyncEngine::global().lock();
  mirror::sync::SyncEngine::global().clear_client();

  if wipe_keys {
    // Remove Master Key and device token from Keychain.
    #[cfg(target_os = "macos")]
    {
      let _ = mirror::keychain::delete_master_key();
      let _ = mirror::keychain::delete_device_token();
      let _ = mirror::keychain::delete_salt();
    }
  }

  // Disable in settings.
  settings_store::save_patch(&json!({
    "section": "cloud_mirror",
    "enabled": false,
  }))?;

  Ok(json!({ "stub": false }))
}

// ─── Phase 2.1.4: split-arch search + device management ──────────────────────

/// Read the cached `cloud_mirror.device_names` map from settings as a
/// HashMap<device_id, name>. Returns an empty map if the section is missing
/// or malformed.
fn load_device_names_cache() -> std::collections::HashMap<String, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  let mut out = std::collections::HashMap::new();
  if let Some(map) = settings
    .get("sections")
    .and_then(|s| s.get("cloud_mirror"))
    .and_then(|m| m.get("device_names"))
    .and_then(|v| v.as_object())
  {
    for (k, v) in map {
      if let Some(s) = v.as_str() {
        out.insert(k.clone(), s.to_string());
      }
    }
  }
  out
}

/// Read this device's `device_id` from settings, if registered.
fn load_this_device_id() -> Option<String> {
  let settings = settings_store::load().ok()?;
  settings
    .get("sections")
    .and_then(|s| s.get("cloud_mirror"))
    .and_then(|m| m.get("device_id"))
    .and_then(|v| v.as_str())
    .map(String::from)
}

/// Persist a `cloud_mirror.device_names` cache that already had a single entry
/// inserted/removed by the caller. Read-modify-write through `save_patch` so
/// other `cloud_mirror` keys are preserved.
fn save_device_names_cache(
  cache: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
  let mut map = serde_json::Map::new();
  for (k, v) in cache {
    map.insert(k.clone(), Value::String(v.clone()));
  }
  settings_store::save_patch(&json!({
    "section": "cloud_mirror",
    "device_names": Value::Object(map),
  }))?;
  Ok(())
}

/// Search cloud-mirrored blobs in a time window. Decrypts locally with the
/// cached MEK and ranks by cosine similarity against the query embedding.
///
/// Payload: `{ query, since_ms, until_ms }`
/// Returns: `{ hits: [...] }` — each hit carries `{blob_id, device_id, id,
/// title, snippet, source_field, kinds_json, created_at, similarity, source,
/// device_name?}`. `source` is `"mirror-self" | "mirror-other"`; the `"local"`
/// variant is reserved for the T4 frontend merge step. The `MemItemPlaintext`
/// `source` field is renamed to `source_field` in the JSON DTO so it can't
/// collide with the new provenance tag.
///
/// Async (Phase 2.1.4.1 follow-up #4): the per-blob work — XChaCha20-Poly1305
/// decrypt + JSON parse + base64 + cosine similarity — is CPU-bound and for
/// realistic workloads (~500 blobs in a 30-day window) can wedge other IPC
/// for hundreds of ms if it runs inline on Tauri's async runtime. We move
/// the entire search call into `tokio::task::spawn_blocking` and bridge the
/// inner async network calls through the dedicated `MIRROR_RUNTIME` (same
/// pattern used by `mirror_sync_now` / `mirror_reset_stuck`). This keeps
/// Tauri's runtime free for other commands during a long search.
#[tauri::command]
pub async fn mirror_search_blobs(payload: Value) -> Result<Value, String> {
  let query = payload
    .get("query")
    .and_then(|v| v.as_str())
    .ok_or("query required")?
    .to_string();
  let since_ms = payload
    .get("since_ms")
    .and_then(|v| v.as_i64())
    .ok_or("since_ms required")?;
  let until_ms = payload
    .get("until_ms")
    .and_then(|v| v.as_i64())
    .ok_or("until_ms required")?;

  // Defensive lock check — frontend already gates on `mirror_status.locked`,
  // but a race could land here before unlock. Reject early with the same
  // error string the frontend recognizes.
  let stats = mirror::sync::SyncEngine::global().stats();
  if stats.locked {
    return Err("locked".into());
  }

  // Reconstruct the client from persisted state if needed (e.g. fresh app
  // launch where the user already registered but hasn't synced yet).
  // Cheap; safe to run on the Tauri runtime before handing off to spawn_blocking.
  mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();

  // Move the CPU-heavy decrypt/parse/score work into spawn_blocking. The
  // closure captures owned values (`String`, `i64`, `HashMap`) so it is `Send`,
  // and uses the dedicated `MIRROR_RUNTIME` to drive the inner async HTTP
  // calls inside `search_cloud_blobs`.
  let hits = tokio::task::spawn_blocking(
    move || -> Result<Vec<mirror::search::CloudSearchHit>, String> {
      let mek = mirror::sync::SyncEngine::global()
        .mek()
        .ok_or_else(|| "locked".to_string())?;
      let client = mirror::sync::SyncEngine::global()
        .client()
        .ok_or_else(|| "not registered".to_string())?;
      let this_device_id =
        load_this_device_id().unwrap_or_else(|| "unknown_device".to_string());
      let names = load_device_names_cache();

      mirror::sync::mirror_runtime().block_on(mirror::search::search_cloud_blobs(
        &query,
        since_ms,
        until_ms,
        &client,
        &mek,
        &this_device_id,
        move |id: &str| names.get(id).cloned(),
      ))
    },
  )
  .await
  .map_err(|e| format!("mirror_search_blobs task join error: {}", e))??;

  let out: Vec<Value> = hits
    .into_iter()
    .map(|h| {
      let (source_str, device_name) = match h.source {
        mirror::search::HitSource::Local => ("local", None),
        mirror::search::HitSource::MirrorThisDevice => ("mirror-self", None),
        mirror::search::HitSource::MirrorOtherDevice { device_name } => {
          ("mirror-other", Some(device_name))
        }
      };
      let mut obj = serde_json::Map::new();
      obj.insert("blob_id".to_string(), Value::String(h.blob_id));
      obj.insert("device_id".to_string(), Value::String(h.device_id));
      obj.insert("id".to_string(), Value::String(h.mem_item.id));
      obj.insert("title".to_string(), Value::String(h.mem_item.title));
      obj.insert("snippet".to_string(), Value::String(h.mem_item.snippet));
      obj.insert("source_field".to_string(), Value::String(h.mem_item.source));
      obj.insert("kinds_json".to_string(), Value::String(h.mem_item.kinds_json));
      obj.insert("created_at".to_string(), json!(h.mem_item.created_at));
      obj.insert("similarity".to_string(), json!(h.similarity));
      obj.insert("source".to_string(), Value::String(source_str.to_string()));
      if let Some(name) = device_name {
        obj.insert("device_name".to_string(), Value::String(name));
      }
      Value::Object(obj)
    })
    .collect();

  Ok(json!({ "hits": out }))
}

/// List all devices on this account, derived from blob aggregation.
///
/// Payload: `{}`
/// Returns: `{ devices: [...], truncated: bool }` — each device is
/// `{device_id, blob_count, latest_stored_at, is_this_device, device_name?}`.
/// `device_name` is hydrated from the cached `cloud_mirror.device_names` map
/// (server has no `GET /v1/devices` endpoint per design U9).
#[tauri::command]
pub async fn mirror_list_devices(_payload: Value) -> Result<Value, String> {
  mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
  let client = mirror::sync::SyncEngine::global()
    .client()
    .ok_or_else(|| "not registered".to_string())?;

  let result = client
    .list_devices_by_aggregation()
    .await
    .map_err(|e| e.to_string())?;

  let this_device_id = load_this_device_id();
  let names = load_device_names_cache();

  let devices: Vec<Value> = result
    .summaries
    .into_iter()
    .map(|s| {
      let is_self = this_device_id.as_deref() == Some(s.device_id.as_str());
      let mut obj = serde_json::Map::new();
      obj.insert("device_id".to_string(), Value::String(s.device_id.clone()));
      obj.insert("blob_count".to_string(), json!(s.blob_count));
      obj.insert(
        "latest_stored_at".to_string(),
        match s.latest_stored_at {
          Some(v) => Value::String(v),
          None => Value::Null,
        },
      );
      obj.insert("is_this_device".to_string(), Value::Bool(is_self));
      if let Some(name) = names.get(&s.device_id) {
        obj.insert("device_name".to_string(), Value::String(name.clone()));
      }
      Value::Object(obj)
    })
    .collect();

  Ok(json!({
    "devices": devices,
    "truncated": result.truncated,
  }))
}

/// Rename a device on the server, then refresh the local name cache.
///
/// Payload: `{ device_id, new_name }`
/// Returns: `{ device: <DeviceRecord> }`
#[tauri::command]
pub async fn mirror_rename_device(payload: Value) -> Result<Value, String> {
  let device_id = payload
    .get("device_id")
    .and_then(|v| v.as_str())
    .ok_or("device_id required")?
    .to_string();
  let new_name_raw = payload
    .get("new_name")
    .and_then(|v| v.as_str())
    .ok_or("name-empty")?;
  let new_name = new_name_raw.trim();

  if new_name.is_empty() {
    return Err("name-empty".into());
  }
  // RFC § 5.4: device names are bounded by 64 *characters* (not bytes).
  // Use char count so multibyte names (e.g. Japanese, ~3 bytes/char) aren't
  // rejected by an over-strict byte limit.
  if new_name.chars().count() > 64 {
    return Err("name-too-long".into());
  }

  mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
  let client = mirror::sync::SyncEngine::global()
    .client()
    .ok_or_else(|| "not registered".to_string())?;

  let record = client
    .rename_device(&device_id, new_name)
    .await
    .map_err(|e| e.to_string())?;

  // Refresh the local name cache so subsequent list/search responses
  // surface the updated label without re-fetching from the server.
  // Best-effort: TOCTOU race possible if two clients rename/delete concurrently.
  // Acceptable for single-user Settings UI; the server is the source of truth.
  let mut names = load_device_names_cache();
  names.insert(record.device_id.clone(), record.device_name.clone());
  save_device_names_cache(&names)?;

  let device_value = serde_json::to_value(&record).map_err(|e| e.to_string())?;
  Ok(json!({ "device": device_value }))
}

/// Delete a device on the server (tombstones all its blobs). Requires the
/// caller to type-confirm with `confirm: "DELETE"` and refuses to delete the
/// caller's own device (the user must use `mirror_disable` instead).
///
/// Payload: `{ device_id, confirm }`
/// Returns: `{ tombstoned_blobs: <count> }`
#[tauri::command]
pub async fn mirror_delete_device(payload: Value) -> Result<Value, String> {
  let device_id = payload
    .get("device_id")
    .and_then(|v| v.as_str())
    .ok_or("device_id required")?
    .to_string();
  let confirm = payload
    .get("confirm")
    .and_then(|v| v.as_str())
    .unwrap_or("");

  if confirm != "DELETE" {
    return Err("confirm-mismatch".into());
  }

  let this_device_id = load_this_device_id();
  if this_device_id.as_deref() == Some(device_id.as_str()) {
    return Err("cannot-delete-self".into());
  }

  mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
  let client = mirror::sync::SyncEngine::global()
    .client()
    .ok_or_else(|| "not registered".to_string())?;

  let count = client
    .delete_device(&device_id)
    .await
    .map_err(|e| e.to_string())?;

  // Drop the deleted device from the local name cache.
  // Best-effort: TOCTOU race possible if two clients rename/delete concurrently.
  // Acceptable for single-user Settings UI; the server is the source of truth.
  let mut names = load_device_names_cache();
  if names.remove(&device_id).is_some() {
    save_device_names_cache(&names)?;
  }

  Ok(json!({ "tombstoned_blobs": count }))
}

#[cfg(test)]
mod mirror_phase_2_1_4_tests {
  use super::*;

  #[tokio::test]
  async fn mirror_search_blobs_locked_returns_locked() {
    // The engine starts locked by default in unit tests (no Keychain access),
    // so a search call should reject with the "locked" sentinel that the
    // frontend recognizes.
    let payload = json!({
      "query": "hello",
      "since_ms": 0i64,
      "until_ms": 1_700_000_000_000i64,
    });
    let res = mirror_search_blobs(payload).await;
    assert!(res.is_err(), "expected Err while locked, got {:?}", res);
    let err = res.unwrap_err();
    assert_eq!(err, "locked", "expected 'locked' sentinel, got {err:?}");
  }

  #[tokio::test]
  async fn mirror_rename_device_validates_empty_name() {
    let payload = json!({ "device_id": "dev_a", "new_name": "   " });
    let res = mirror_rename_device(payload).await;
    assert!(res.is_err(), "expected Err for empty name, got {:?}", res);
    let err = res.unwrap_err();
    assert_eq!(err, "name-empty", "expected 'name-empty' sentinel, got {err:?}");
  }

  #[tokio::test]
  async fn mirror_rename_device_validates_too_long_name() {
    let too_long = "x".repeat(65);
    let payload = json!({ "device_id": "dev_a", "new_name": too_long });
    let res = mirror_rename_device(payload).await;
    assert!(res.is_err(), "expected Err for >64-char name, got {:?}", res);
    let err = res.unwrap_err();
    assert_eq!(err, "name-too-long", "expected 'name-too-long' sentinel, got {err:?}");
  }

  #[tokio::test]
  async fn mirror_rename_device_accepts_multibyte_name_under_64_chars() {
    // RFC § 5.4 says the limit is 64 *characters*, not bytes. A 22-char
    // Japanese name is ~66 bytes (3 bytes/char) — historically rejected by a
    // byte-count check. It must pass length validation now.
    // 22 CJK chars ⇒ 66 bytes (3 bytes/char): "会議室の私のマックブックプロ一号機テスト用名"
    let multibyte_22 = "会議室の私のマックブックプロ一号機テスト用名";
    assert_eq!(
      multibyte_22.chars().count(),
      22,
      "fixture sanity: char count should be 22, got {}",
      multibyte_22.chars().count()
    );
    assert!(
      multibyte_22.len() > 64,
      "fixture sanity: byte length should be >64 to exercise the regression (got {})",
      multibyte_22.len()
    );

    let payload = json!({ "device_id": "dev_a", "new_name": multibyte_22 });
    let res = mirror_rename_device(payload).await;
    // The call will still fail (unit tests don't have a registered client),
    // but the failure must NOT be a length-validation error.
    assert!(res.is_err(), "expected Err (no client), got {:?}", res);
    let err = res.unwrap_err();
    assert_ne!(err, "name-too-long", "multibyte 22-char name was wrongly rejected as too long");
    assert_ne!(err, "name-empty", "multibyte name was wrongly rejected as empty");
  }

  #[tokio::test]
  async fn mirror_delete_device_validates_confirm() {
    let payload = json!({ "device_id": "dev_a", "confirm": "WRONG" });
    let res = mirror_delete_device(payload).await;
    assert!(res.is_err(), "expected Err for bad confirm, got {:?}", res);
    let err = res.unwrap_err();
    assert_eq!(err, "confirm-mismatch", "expected 'confirm-mismatch' sentinel, got {err:?}");
  }
}
