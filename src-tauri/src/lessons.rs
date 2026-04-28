//! Lessons layer (KIOKU Sub-spec A). Append-only store of actionable rules
//! generated from user rejections and tool failures. Injected into chat
//! system prompts via `retrieve_for_chat`.
//!
//! Schema lives in `kioku_graph_schema::ensure_phase2_tables`. This module
//! owns CRUD + cosine similarity search.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewLesson {
  pub category: String,
  pub trigger_context: Value,
  pub attempted: Value,
  pub outcome: Value,
  pub rule: String,
  pub source: String,
  pub embedding: Option<Vec<f32>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lesson {
  pub id: String,
  pub category: String,
  pub trigger_context: Value,
  pub attempted: Value,
  pub outcome: Value,
  pub rule: String,
  pub scope: String,
  pub source: String,
  pub embedding: Option<Vec<f32>>,
  pub created_at: i64,
  pub applies_n: i64,
  pub prevented_n: i64,
  pub status: String,
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
  let mut out = Vec::with_capacity(v.len() * 4);
  for &x in v {
    out.extend_from_slice(&x.to_le_bytes());
  }
  out
}

fn blob_to_embedding(blob: &[u8]) -> Vec<f32> {
  let mut out = Vec::with_capacity(blob.len() / 4);
  for chunk in blob.chunks_exact(4) {
    let arr = [chunk[0], chunk[1], chunk[2], chunk[3]];
    out.push(f32::from_le_bytes(arr));
  }
  out
}

pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
  if a.len() != b.len() || a.is_empty() {
    return 0.0;
  }
  let mut dot = 0.0f32;
  let mut na = 0.0f32;
  let mut nb = 0.0f32;
  for i in 0..a.len() {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if na == 0.0 || nb == 0.0 {
    return 0.0;
  }
  dot / (na.sqrt() * nb.sqrt())
}

pub fn insert_lesson(conn: &Connection, n: &NewLesson) -> Result<String, String> {
  let id = Uuid::new_v4().to_string();
  let trigger_json = n.trigger_context.to_string();
  let attempted_json = n.attempted.to_string();
  let outcome_json = n.outcome.to_string();
  let (emb_blob, emb_dim) = match &n.embedding {
    Some(v) => (Some(embedding_to_blob(v)), Some(v.len() as i64)),
    None => (None, None),
  };

  conn
    .execute(
      r#"
      INSERT INTO lessons (
        id, category, trigger_context, attempted, outcome, rule,
        scope, source, embedding, embedding_dim, created_at,
        applies_n, prevented_n, status
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', ?7, ?8, ?9, ?10, 0, 0, 'active')
      "#,
      params![
        id,
        n.category,
        trigger_json,
        attempted_json,
        outcome_json,
        n.rule,
        n.source,
        emb_blob,
        emb_dim,
        now_ms(),
      ],
    )
    .map_err(|e| format!("lessons::insert_lesson: {}", e))?;
  Ok(id)
}

fn row_to_lesson(row: &rusqlite::Row) -> rusqlite::Result<Lesson> {
  let trigger_str: String = row.get("trigger_context")?;
  let attempted_str: String = row.get("attempted")?;
  let outcome_str: String = row.get("outcome")?;
  let emb_blob: Option<Vec<u8>> = row.get("embedding")?;
  let embedding = emb_blob.as_ref().map(|b| blob_to_embedding(b));
  Ok(Lesson {
    id: row.get("id")?,
    category: row.get("category")?,
    trigger_context: serde_json::from_str(&trigger_str).unwrap_or(Value::Null),
    attempted: serde_json::from_str(&attempted_str).unwrap_or(Value::Null),
    outcome: serde_json::from_str(&outcome_str).unwrap_or(Value::Null),
    rule: row.get("rule")?,
    scope: row.get("scope")?,
    source: row.get("source")?,
    embedding,
    created_at: row.get("created_at")?,
    applies_n: row.get("applies_n")?,
    prevented_n: row.get("prevented_n")?,
    status: row.get("status")?,
  })
}

pub fn search_by_similarity(
  conn: &Connection,
  query_embedding: &[f32],
  top_k: usize,
  min_similarity: f32,
) -> Result<Vec<Lesson>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT id, category, trigger_context, attempted, outcome, rule,
             scope, source, embedding, created_at, applies_n, prevented_n, status
      FROM lessons
      WHERE status = 'active' AND embedding IS NOT NULL
      "#,
    )
    .map_err(|e| format!("lessons::search prepare: {}", e))?;
  let rows = stmt
    .query_map([], row_to_lesson)
    .map_err(|e| format!("lessons::search query: {}", e))?;

  let mut scored: Vec<(f32, Lesson)> = Vec::new();
  for row in rows {
    let lesson = row.map_err(|e| format!("lessons::search row: {}", e))?;
    if let Some(emb) = &lesson.embedding {
      let sim = cosine_similarity(query_embedding, emb);
      if sim >= min_similarity {
        scored.push((sim, lesson));
      }
    }
  }
  scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
  Ok(scored.into_iter().take(top_k).map(|(_, l)| l).collect())
}

pub fn increment_applies(conn: &Connection, ids: &[String]) -> Result<(), String> {
  if ids.is_empty() {
    return Ok(());
  }
  let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(", ");
  let sql = format!(
    "UPDATE lessons SET applies_n = applies_n + 1 WHERE id IN ({})",
    placeholders
  );
  let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
  conn
    .execute(&sql, &params[..])
    .map_err(|e| format!("lessons::increment_applies: {}", e))?;
  Ok(())
}

pub fn list_active(conn: &Connection, limit: usize) -> Result<Vec<Lesson>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT id, category, trigger_context, attempted, outcome, rule,
             scope, source, embedding, created_at, applies_n, prevented_n, status
      FROM lessons
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT ?1
      "#,
    )
    .map_err(|e| format!("lessons::list_active prepare: {}", e))?;
  let rows = stmt
    .query_map(params![limit as i64], row_to_lesson)
    .map_err(|e| format!("lessons::list_active query: {}", e))?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| format!("lessons::list_active row: {}", e))?);
  }
  Ok(out)
}

pub fn archive(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute(
      "UPDATE lessons SET status = 'archived' WHERE id = ?1",
      params![id],
    )
    .map_err(|e| format!("lessons::archive: {}", e))?;
  Ok(())
}

/// Dedupe helper for tool_failure capture: returns Some(id) if a lesson with
/// the same (category, attempted, outcome) was inserted within `within_ms`.
pub fn recent_match(
  conn: &Connection,
  category: &str,
  attempted_json: &str,
  outcome_json: &str,
  within_ms: i64,
) -> Result<Option<String>, String> {
  let cutoff = now_ms() - within_ms;
  conn
    .query_row(
      r#"
      SELECT id FROM lessons
      WHERE status = 'active'
        AND category = ?1
        AND attempted = ?2
        AND outcome = ?3
        AND created_at >= ?4
      LIMIT 1
      "#,
      params![category, attempted_json, outcome_json, cutoff],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("lessons::recent_match: {}", e))
}

/// Build a "Lessons from past sessions" addendum for a chat system prompt.
/// Returns (addendum, ids) where ids is the list of lesson ids that contributed.
/// Caller increments applies_n on those ids after a successful chat response.
pub async fn retrieve_for_chat(user_message: &str) -> (String, Vec<String>) {
  let trimmed = user_message.trim();
  if trimmed.is_empty() {
    return (String::new(), vec![]);
  }
  let query_emb = match crate::embeddings::embed_one(trimmed).await {
    Ok(v) => v,
    Err(e) => {
      log::warn!("lessons::retrieve_for_chat embed failed: {}", e);
      return (String::new(), vec![]);
    }
  };
  let conn = match crate::memory_store::open_conn() {
    Ok(c) => c,
    Err(e) => {
      log::warn!("lessons::retrieve_for_chat conn failed: {}", e);
      return (String::new(), vec![]);
    }
  };
  let top = match search_by_similarity(&conn, &query_emb, 5, 0.75) {
    Ok(v) => v,
    Err(e) => {
      log::warn!("lessons::retrieve_for_chat search failed: {}", e);
      return (String::new(), vec![]);
    }
  };
  if top.is_empty() {
    return (String::new(), vec![]);
  }
  let mut seen = std::collections::HashSet::new();
  let mut ids = Vec::new();
  let mut lines = Vec::new();
  for l in &top {
    let key = l.rule.trim().to_lowercase();
    if !seen.insert(key) {
      continue;
    }
    lines.push(format!("- {}", l.rule));
    ids.push(l.id.clone());
  }
  let addendum = format!(
    "\n\n## Lessons from past sessions\n\nThe user has previously corrected or rejected responses; honor these:\n{}",
    lines.join("\n")
  );
  (addendum, ids)
}
