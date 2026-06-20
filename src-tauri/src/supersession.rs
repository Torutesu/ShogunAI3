//! Supersession layer (KIOKU Sub-spec D). 30-day batch that asks an LLM
//! whether a newer lesson directly contradicts a semantically-similar
//! older lesson in the same category. Older side is marked
//! `status='superseded'` when the LLM says yes.
//!
//! Schema: see `kioku_graph_schema::ensure_phase2_tables` (lessons table).
//! This module owns detection orchestration only.

use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::lessons::{cosine_similarity, list_active, Lesson};

const MODEL: &str = "claude-haiku-4-5-20251001";
const TOP_K: usize = 3;
const FETCH_LIMIT: usize = 1000;

const JUDGE_SYSTEM_PROMPT: &str =
    "You are evaluating two rules a user has accepted into their personal AI assistant.
Decide if the NEWER rule directly contradicts the OLDER rule.

Direct contradiction means: following one rule would violate the other.

Examples of contradiction:
  OLDER: \"Avoid emojis in formal replies.\"
  NEWER: \"Use emojis in formal replies to feel friendly.\"
  -> contradicts: true

Examples of NOT contradiction (different scopes / additive / unrelated):
  OLDER: \"Avoid emojis in formal replies.\"
  NEWER: \"Use plain text in legal correspondence.\"
  -> contradicts: false  (different scope; both can hold)

  OLDER: \"Keep slack messages under 3 lines.\"
  NEWER: \"Use bullet points in long emails.\"
  -> contradicts: false  (unrelated)

Output the structured tool call only.";

fn judge_tool() -> Value {
    json!({
      "name": "judge_contradiction",
      "description": "Return whether NEWER rule directly contradicts OLDER rule.",
      "input_schema": {
        "type": "object",
        "properties": {
          "contradicts": { "type": "boolean" }
        },
        "required": ["contradicts"]
      }
    })
}

/// LLM judge for one pair. Returns:
/// - Ok(Some(true))  — contradicts
/// - Ok(Some(false)) — does not contradict
/// - Ok(None)        — transient error / parse failure (caller skips pair)
async fn judge_contradiction(older_rule: &str, newer_rule: &str) -> Option<bool> {
    let user_msg = format!("OLDER: {}\nNEWER: {}", older_rule, newer_rule);
    let tool = judge_tool();
    match crate::llm::anthropic_tool_complete(JUDGE_SYSTEM_PROMPT, &user_msg, &tool, MODEL).await {
        Ok(input) => input.get("contradicts").and_then(|v| v.as_bool()),
        Err(e) => {
            log::warn!("supersession judge failed: {}", e);
            None
        }
    }
}

fn mark_superseded(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE lessons SET status='superseded' WHERE id = ?1 AND status='active'",
        params![id],
    )
    .map_err(|e| format!("supersession::mark_superseded: {}", e))?;
    Ok(())
}

/// Sort `candidates` by cosine similarity to `target` (DESC), return top K.
fn top_k_by_cosine<'a>(target: &[f32], candidates: Vec<&'a Lesson>, k: usize) -> Vec<&'a Lesson> {
    let mut scored: Vec<(f32, &'a Lesson)> = candidates
        .into_iter()
        .filter_map(|l| {
            l.embedding.as_ref().map(|emb| {
                let score = cosine_similarity(target, emb);
                (score, l)
            })
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().take(k).map(|(_, l)| l).collect()
}

/// Run the monthly supersession detection batch. Returns count of lessons
/// newly marked `status='superseded'`.
///
/// Returns Ok(0) early if the LLM API key is not configured (mirrors the
/// Phase 1 lessons pattern — supersession is a hygiene function, not a
/// blocking dependency).
pub async fn run_supersession() -> Result<usize, String> {
    // Probe API key before doing any DB work
    if crate::secrets::get_llm_api_key()?.is_none() {
        log::info!("supersession skipped: no LLM API key configured");
        return Ok(0);
    }

    let conn = crate::memory_store::open_conn()?;
    let all_active = list_active(&conn, FETCH_LIMIT)?;

    // Keep only lessons with embeddings (others can't participate)
    let mut active: Vec<Lesson> = all_active
        .into_iter()
        .filter(|l| l.embedding.is_some())
        .collect();
    if active.is_empty() {
        return Ok(0);
    }

    // list_active is already ORDER BY created_at DESC, so newer comes first.
    // Group by category while preserving the DESC order within each group.
    let mut by_cat: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, l) in active.iter().enumerate() {
        by_cat.entry(l.category.clone()).or_default().push(idx);
    }

    let mut marked = 0usize;

    for (_cat, indices) in by_cat {
        // indices are already in DESC order (newest first)
        for i in 0..indices.len() {
            let newer_idx = indices[i];
            // Snapshot the embedding so the borrow-of-active doesn't conflict
            // with the local-status mutation in the inner loop below.
            let newer_embedding = match active[newer_idx].embedding.clone() {
                Some(v) => v,
                None => continue,
            };

            // candidates = all OLDER lessons in this category that are still
            // 'active' in our local view
            let candidates: Vec<&Lesson> = indices[(i + 1)..]
                .iter()
                .map(|&j| &active[j])
                .filter(|l| l.status == "active")
                .collect();

            let top_k = top_k_by_cosine(&newer_embedding, candidates, TOP_K);
            // Snapshot ids+rules so we can free the borrow before mutating active
            let pairs: Vec<(String, String, String)> = top_k
                .into_iter()
                .map(|older| {
                    (
                        older.id.clone(),
                        older.rule.clone(),
                        active[newer_idx].rule.clone(),
                    )
                })
                .collect();

            for (older_id, older_rule, newer_rule) in pairs {
                match judge_contradiction(&older_rule, &newer_rule).await {
                    Some(true) => {
                        mark_superseded(&conn, &older_id)?;
                        // Update local view so subsequent iterations skip this lesson
                        if let Some(pos) = active.iter().position(|l| l.id == older_id) {
                            active[pos].status = "superseded".to_string();
                        }
                        marked += 1;
                    }
                    Some(false) | None => continue,
                }
            }
        }
    }

    Ok(marked)
}
