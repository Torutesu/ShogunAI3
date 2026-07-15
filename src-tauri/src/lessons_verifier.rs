//! Lessons verifier (KIOKU Sub-spec E). Called fire-and-forget after every
//! chat completion that injected lessons. Asks an LLM judge whether the
//! assistant message respected each injected lesson; for those marked
//! respected, increments `prevented_n`.
//!
//! Schema: see `kioku_graph_schema::ensure_phase2_tables` (lessons table).
//! Wire site: `crate::llm::chat_complete` (after `increment_applies`).

use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;

const MODEL: &str = "claude-haiku-4-5-20251001";

const JUDGE_SYSTEM_PROMPT: &str = "You are evaluating whether an AI assistant's reply respected a set of rules the user previously accepted into their personal AI assistant.

For each rule, output:
- respected: true   — the assistant's reply did NOT violate the rule
                     (this includes rules that don't apply to the topic —
                     vacuous compliance counts as respected)
- respected: false  — the assistant's reply violated the rule

Only mark `false` when the reply visibly violates the rule's intent. When
unsure, prefer `true`.

Output the structured tool call only. Include EVERY input lesson_id in
your judgments array.";

fn judge_tool() -> Value {
    json!({
      "name": "judge_lesson_compliance",
      "description": "For each lesson, decide whether the assistant message respected (did not violate) the rule.",
      "input_schema": {
        "type": "object",
        "properties": {
          "judgments": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "lesson_id": { "type": "string" },
                "respected": { "type": "boolean" }
              },
              "required": ["lesson_id", "respected"]
            }
          }
        },
        "required": ["judgments"]
      }
    })
}

fn fetch_rules_for_ids(conn: &Connection, ids: &[String]) -> Result<Vec<(String, String)>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = std::iter::repeat("?")
        .take(ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, rule FROM lessons WHERE status = 'active' AND id IN ({})",
        placeholders
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("verifier prepare: {}", e))?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("verifier query: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("verifier row: {}", e))?);
    }
    Ok(out)
}

fn build_user_prompt(user_msg: &str, assistant_msg: &str, lessons: &[(String, String)]) -> String {
    let mut s = String::new();
    s.push_str("USER ASKED:\n");
    s.push_str(user_msg);
    s.push_str("\n\nASSISTANT REPLIED:\n");
    s.push_str(assistant_msg);
    s.push_str("\n\nLESSONS TO EVALUATE:\n");
    for (id, rule) in lessons {
        s.push_str("- id: ");
        s.push_str(id);
        s.push_str("\n  rule: ");
        s.push_str(rule);
        s.push('\n');
    }
    s
}

/// Calls the LLM judge. Returns `Some(respected_ids)` on success, `None` on
/// transient failure (already logged).
async fn call_judge(
    user_msg: &str,
    assistant_msg: &str,
    lessons: &[(String, String)],
) -> Option<Vec<String>> {
    let user_content = build_user_prompt(user_msg, assistant_msg, lessons);
    let tool = judge_tool();

    match crate::llm::anthropic_tool_complete_with_usage(
        JUDGE_SYSTEM_PROMPT,
        &user_content,
        &tool,
        MODEL,
    )
    .await
    {
        Ok(res) => {
            // Audit F-11: record judge spend against the BYOK cost ledger.
            crate::cost_ledger::record_llm_cost(
                &res.resolved_model,
                res.input_tokens,
                res.output_tokens,
                res.cache_creation_input_tokens,
                res.cache_read_input_tokens,
                crate::cost_ledger::PURPOSE_JUDGE,
            );
            let input = res.input;
            let judgments = match input.get("judgments").and_then(|v| v.as_array()) {
                Some(arr) => arr,
                None => {
                    log::warn!("verifier: judgments missing in tool output");
                    return None;
                }
            };
            let valid_ids: HashSet<&String> = lessons.iter().map(|(id, _)| id).collect();
            let respected: Vec<String> = judgments
                .iter()
                .filter_map(|j| {
                    let id = j.get("lesson_id").and_then(|v| v.as_str())?.to_string();
                    let respected = j.get("respected").and_then(|v| v.as_bool())?;
                    if respected && valid_ids.contains(&id) {
                        Some(id)
                    } else {
                        None
                    }
                })
                .collect();
            Some(respected)
        }
        Err(e) => {
            log::warn!("verifier judge failed: {}", e);
            None
        }
    }
}

/// Async verifier triggered after every chat turn that injected lessons.
/// Fire-and-forget: never returns, never blocks the chat response.
pub async fn verify_and_increment(
    applied_lesson_ids: Vec<String>,
    user_msg: String,
    assistant_msg: String,
) {
    // 1. API key gate (silent no-op when unconfigured)
    let key_present = crate::secrets::get_llm_api_key()
        .ok()
        .flatten()
        .map(|k| !k.trim().is_empty())
        .unwrap_or(false);
    if !key_present {
        return;
    }

    if applied_lesson_ids.is_empty() {
        return;
    }

    // 2. Open DB + fetch rules for active lessons (skip archived/superseded)
    let conn = match crate::memory_store::open_conn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("verifier open_conn: {}", e);
            return;
        }
    };
    let lessons = match fetch_rules_for_ids(&conn, &applied_lesson_ids) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("verifier fetch_rules: {}", e);
            return;
        }
    };
    if lessons.is_empty() {
        return;
    }

    // 3. Call LLM judge
    let respected_ids = match call_judge(&user_msg, &assistant_msg, &lessons).await {
        Some(ids) => ids,
        None => return,
    };

    // 4. Increment prevented_n for respected lessons
    if respected_ids.is_empty() {
        return;
    }
    if let Err(e) = crate::lessons::increment_prevented(&conn, &respected_ids) {
        log::warn!("verifier increment_prevented: {}", e);
        return;
    }

    crate::memory_obs::emit(
        "lesson_verifier_done",
        &[
            ("respected", respected_ids.len().to_string()),
            ("total", lessons.len().to_string()),
        ],
    );
}
