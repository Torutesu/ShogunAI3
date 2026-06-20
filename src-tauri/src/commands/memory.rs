use crate::context_assembly;
use crate::memory_export;
use crate::memory_store;
use crate::{embed_backfill, settings_store};
use serde_json::{json, Value};
use tauri::AppHandle;

fn search_payload_has_kinds_filter(payload: &Value) -> bool {
    payload
        .get("kinds")
        .and_then(|k| k.as_array())
        .map(|arr| !arr.is_empty())
        .unwrap_or(false)
}

fn search_scope(payload: &Value) -> &str {
    payload
        .get("scope")
        .and_then(|s| s.as_str())
        .unwrap_or("all")
}

fn search_uses_legacy_path(payload: &Value) -> bool {
    let scope = search_scope(payload);
    if scope.eq_ignore_ascii_case("meetings_only") || scope.eq_ignore_ascii_case("meetingsonly") {
        return true;
    }
    let settings = settings_store::load().unwrap_or_else(|_| json!({}));
    context_assembly::read_path_mode(&settings) == "legacy"
}

#[tauri::command]
pub async fn shogun_memory_search(payload: Value) -> Result<Value, String> {
    let scope = search_scope(&payload);
    if scope.eq_ignore_ascii_case("timeline") {
        if search_uses_legacy_path(&payload) {
            return memory_store::search_with_semantics(&payload).await;
        }
        return context_assembly::search_timeline_graph(&payload).await;
    }

    if search_uses_legacy_path(&payload) {
        return memory_store::search_with_semantics(&payload).await;
    }

    let query = payload
        .get("query")
        .and_then(|q| q.as_str())
        .unwrap_or("")
        .trim();
    let limit = payload
        .get("limit")
        .and_then(|l| l.as_u64())
        .unwrap_or(20)
        .clamp(1, 200);
    let semantic = payload
        .get("semantic")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
        query,
        limit,
        semantic,
        excluded_provenances: None,
    })
    .await?;

    if search_payload_has_kinds_filter(&payload) {
        let kinds_want: Vec<String> = payload
            .get("kinds")
            .and_then(|k| k.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        hits = context_assembly::filter_assembled_hits_by_kinds(hits, &kinds_want)?;
    }

    let settings = settings_store::load().unwrap_or_else(|_| json!({}));
    let mode = context_assembly::read_path_mode(&settings);
    Ok(context_assembly::hits_to_search_response(
        &hits,
        &payload,
        mode,
        semantic && !query.is_empty(),
    ))
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
            doc.pointer("/sections/developer/memoryDebugger")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(false);
    Ok(serde_json::json!({
      "available": enabled,
      "reason": if enabled { "enabled" } else { "settings_disabled" },
    }))
}

#[cfg(test)]
mod memory_search_routing_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn graph_path_for_timeline_scope_by_default() {
        let _settings = settings_store::TestSettingsGuard::new("memory-route-timeline");
        assert!(!search_uses_legacy_path(&json!({ "scope": "timeline" })));
    }

    #[test]
    fn graph_path_when_kinds_filter_present() {
        let _settings = settings_store::TestSettingsGuard::new("memory-route-kinds");
        assert!(!search_uses_legacy_path(&json!({
          "query": "todo",
          "kinds": ["note", "audio"],
        })));
    }

    #[test]
    fn graph_path_when_no_kinds_and_default_settings() {
        let _settings = settings_store::TestSettingsGuard::new("memory-route-default");
        assert!(!search_uses_legacy_path(&json!({ "query": "launch" })));
    }

    #[test]
    fn legacy_path_for_meetings_only_scope() {
        assert!(search_uses_legacy_path(&json!({
          "scope": "meetings_only",
          "query": "x",
        })));
    }
}
