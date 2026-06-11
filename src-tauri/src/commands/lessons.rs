use crate::{embeddings, lessons, llm, memory_store, patterns, supersession};
use rusqlite::params;
use serde_json::{json, Value};

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


#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}


#[tauri::command]
pub async fn shogun_supersession_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let marked = crate::supersession::run_supersession().await?;
  Ok(serde_json::json!({ "marked": marked }))
}


#[tauri::command]
pub fn shogun_patterns_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = crate::patterns::list_for_brief(50, true)?;
  Ok(serde_json::json!({ "items": items }))
}


#[tauri::command]
pub fn shogun_patterns_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload
    .get("id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  crate::patterns::invalidate(id)?;
  Ok(serde_json::json!({ "ok": true }))
}


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
