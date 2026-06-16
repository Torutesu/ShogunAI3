use crate::{brief, brief_actions, llm, schedule_queue, settings_store};
use serde_json::{json, Value};

#[tauri::command]
pub async fn shogun_brief_get(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  let user_tz = payload
    .get("user_tz")
    .and_then(|v| v.as_str())
    .unwrap_or("UTC");
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en");
  let mut memory_digest = brief::build_memory_digest(lang);
  brief::enrich_memory_digest_with_graph(&mut memory_digest).await;
  let use_v2 = brief::should_use_v2(&settings, &payload);
  let has_llm = crate::secrets::get_llm_api_key()
    .ok()
    .flatten()
    .map(|k| !k.trim().is_empty())
    .unwrap_or(false);

  let raw_brief = if use_v2 || has_llm {
    if has_llm {
      match brief::morning_brief_v2_generate(user_tz, &payload, Some(&memory_digest)).await {
        Ok(v) => v,
        Err(e) => {
          log::warn!("brief v2 LLM failed, using heuristic: {}", e);
          brief::morning_brief_v2_heuristic(user_tz, &payload, Some(&memory_digest))
        }
      }
    } else {
      brief::morning_brief_v2_heuristic(user_tz, &payload, Some(&memory_digest))
    }
  } else {
    let v1 = llm::brief_generate(&payload, Some(&*ring)).await?;
    let sections = v1.get("sections").cloned().unwrap_or_else(|| json!([]));
    let items: Vec<Value> = sections
      .as_array()
      .unwrap_or(&vec![])
      .iter()
      .enumerate()
      .map(|(i, s)| {
        json!({
          "id": format!("sec_{}", i + 1),
          "priority": i + 1,
          "category": "memory",
          "what": s.get("title").and_then(|v| v.as_str()).unwrap_or("Section"),
          "why_now": s.get("body").and_then(|v| v.as_str()).unwrap_or(""),
          "related_context": [],
          "next_action": { "type": "ignore" },
          "confidence": 0.7
        })
      })
      .collect();
    json!({
      "version": "2.0",
      "generated_at": chrono::Utc::now().to_rfc3339(),
      "summary": {
        "headline": if items.is_empty() { "Memory brief" } else { "From your recent Memory" },
        "posture": "focus"
      },
      "items": items,
      "deferred": [],
      "memory_digest": memory_digest.clone(),
      "stub": false
    })
  };

  let digest = raw_brief
    .get("memory_digest")
    .cloned()
    .unwrap_or(memory_digest);
  let items = raw_brief.get("items").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
  let skipped = items == 0
    && digest
      .get("highlights")
      .and_then(|h| h.as_array())
      .map(|a| a.is_empty())
      .unwrap_or(true);
  let ui = brief::normalize_brief_for_ui(&raw_brief);
  Ok(brief::wrap_brief_get_response(ui, digest, skipped))
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
