use super::app::ts;
use crate::{kioku_backup, kioku_debug_stats, kioku_edge_types, kioku_stage5, meeting_kioku, memory_store, settings_store};
use serde_json::{json, Value};

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


#[tauri::command]
pub fn shogun_kioku_debug_stats(_payload: Value) -> Result<Value, String> {
  let conn = memory_store::open_conn()?;
  let settings = settings_store::load().unwrap_or_else(|_| json!({}));
  let now_ms = ts() as i64;
  crate::kioku_debug_stats::assemble_debug_stats(&conn, &settings, now_ms)
}


#[tauri::command]
pub fn shogun_kioku_pipeline_smoke(_payload: Value) -> Result<Value, String> {
  crate::meeting_kioku::pipeline_smoke()
}


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


#[tauri::command]
pub fn shogun_kioku_stage5_dry_run(_payload: Value) -> Result<Value, String> {
  let conn = memory_store::open_conn()?;
  let now_ms = ts() as i64;
  let report = crate::kioku_stage5::run_dry_run(&conn, now_ms)?;
  serde_json::to_value(&report).map_err(|e| e.to_string())
}


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
