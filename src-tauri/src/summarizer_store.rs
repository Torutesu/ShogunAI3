//! mem_summaries テーブルの CRUD。target_kind/target_id による統一管理。
//! Phase 1 では target_kind="item" のみ使用 (session/week_rollup は Phase 2/3)。

use crate::memory_store::open_conn;
use rusqlite::params;
use serde_json::{json, Value};

pub const SCHEMA_VERSION: i64 = 1;

/// 1 件の要約を表す Rust 構造体。DB 行と 1:1 対応。
#[derive(Debug, Clone)]
pub struct Summary {
  pub target_kind: String,
  pub target_id: String,
  pub title: String,
  pub key_points: Vec<String>,
  pub source_type: String,
  pub priority: String,            // LLM-assigned priority: 'high' | 'medium' | 'low'
  pub reason: Option<String>,
  pub model: String,
  pub schema_version: i64,
  pub generated_at: i64,
  pub raw_json: String,
  pub lang: String,                // 'en' | 'jp' | 'bi' — matches tweaks.language at generation time
  pub user_priority: Option<String>, // Manual override from the user. None = no override.
  pub acknowledged_at: Option<i64>,  // When the user marked this summary as read. None = unread.
  pub snooze_until: Option<i64>,     // Hidden from highlights while > now_ms.
}

/// Apply `raw_json.user_edits[]` overrides to the in-struct LLM-baseline
/// fields. Mutates `s` in place. Each entry has shape:
///   { "field": "title" | "keyPoints" | "reason",
///     "from": <prev value>, "to": <new value>,
///     "at": ms_epoch, "source_raw": str, "entity_id": str|null,
///     "schema": 1 }
/// Entries with `schema != 1` are ignored (forward-compat). Within the
/// supported schema, the latest entry per field wins.
pub(crate) fn apply_user_edits(s: &mut Summary) {
  let parsed: serde_json::Value = match serde_json::from_str(&s.raw_json) {
    Ok(v) => v,
    Err(_) => return, // malformed raw_json → leave struct as-is
  };
  let edits = match parsed.get("user_edits").and_then(|v| v.as_array()) {
    Some(arr) => arr,
    None => return,
  };
  for entry in edits {
    let schema = entry.get("schema").and_then(|v| v.as_i64()).unwrap_or(0);
    if schema != 1 {
      continue;
    }
    let field = match entry.get("field").and_then(|v| v.as_str()) {
      Some(f) => f,
      None => continue,
    };
    let to = match entry.get("to") {
      Some(v) => v,
      None => continue,
    };
    match field {
      "title" => {
        if let Some(t) = to.as_str() {
          s.title = t.to_string();
        }
      }
      "keyPoints" => {
        if let Some(arr) = to.as_array() {
          // Only string elements survive — the writer side (edit_field) is
          // responsible for storing strings; any non-string here would
          // indicate corruption and is dropped rather than panicking.
          let kp: Vec<String> = arr
            .iter()
            .filter_map(|v| v.as_str().map(String::from))
            .collect();
          s.key_points = kp;
        }
      }
      "reason" => {
        s.reason = match to {
          serde_json::Value::Null => None,
          serde_json::Value::String(t) => Some(t.clone()),
          _ => continue,
        };
      }
      _ => {} // unknown field → ignore (forward-compat for new editable fields)
    }
  }
}

impl Summary {
  /// UI / IPC で返すための JSON 表現。
  pub fn to_json(&self) -> Value {
    json!({
      "targetKind": self.target_kind,
      "targetId": self.target_id,
      "title": self.title,
      "keyPoints": self.key_points,
      "sourceType": self.source_type,
      "priority": self.priority,
      "reason": self.reason,
      "model": self.model,
      "schemaVersion": self.schema_version,
      "generatedAt": self.generated_at,
      "lang": self.lang,
      "userPriority": self.user_priority,
      "acknowledgedAt": self.acknowledged_at,
      "snoozeUntil": self.snooze_until,
    })
  }
}

/// Fetch cached summary. Returns None if no row exists OR if the cached row's
/// `lang` differs from the requested `want_lang` (cache miss — triggers
/// regeneration in the requested language).
pub fn get_cached(target_kind: &str, target_id: &str, want_lang: &str) -> Result<Option<Summary>, String> {
  let conn = open_conn()?;
  let row = conn.query_row(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json, lang, user_priority, acknowledged_at, snooze_until
     FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id],
    |r| {
      let kp_json: String = r.get(3)?;
      let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
      let mut s = Summary {
        target_kind: r.get(0)?,
        target_id: r.get(1)?,
        title: r.get(2)?,
        key_points,
        source_type: r.get(4)?,
        priority: r.get(5)?,
        reason: r.get(6)?,
        model: r.get(7)?,
        schema_version: r.get(8)?,
        generated_at: r.get(9)?,
        raw_json: r.get(10)?,
        lang: r.get(11)?,
        user_priority: r.get(12)?,
        acknowledged_at: r.get(13)?,
        snooze_until: r.get(14)?,
      };
      // Apply user edits inline so callers see effective values; LLM baseline
      // remains in s.raw_json for callers that need it (e.g. revert_field).
      apply_user_edits(&mut s);
      Ok(s)
    },
  );
  match row {
    Ok(s) if s.lang == want_lang => Ok(Some(s)),
    Ok(_) => Ok(None), // language mismatch → treat as cache miss
    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
    Err(e) => Err(format!("mem_summaries read: {}", e)),
  }
}

pub fn get_cached_many(target_kind: &str, ids: &[String], want_lang: &str) -> Result<Vec<Summary>, String> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let conn = open_conn()?;
  let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("?{}", i + 1)).collect();
  let sql = format!(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json, lang, user_priority, acknowledged_at, snooze_until
     FROM mem_summaries
     WHERE target_kind = ?1 AND target_id IN ({}) AND lang = ?{}",
    placeholders.join(","),
    ids.len() + 2
  );
  let mut stmt = conn.prepare(&sql).map_err(|e| format!("prepare: {}", e))?;
  let mut bound: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(ids.len() + 2);
  bound.push(&target_kind);
  for id in ids {
    bound.push(id);
  }
  bound.push(&want_lang);
  let rows = stmt.query_map(bound.as_slice(), |r| {
    let kp_json: String = r.get(3)?;
    let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
    let mut s = Summary {
      target_kind: r.get(0)?,
      target_id: r.get(1)?,
      title: r.get(2)?,
      key_points,
      source_type: r.get(4)?,
      priority: r.get(5)?,
      reason: r.get(6)?,
      model: r.get(7)?,
      schema_version: r.get(8)?,
      generated_at: r.get(9)?,
      raw_json: r.get(10)?,
      lang: r.get(11)?,
      user_priority: r.get(12)?,
      acknowledged_at: r.get(13)?,
      snooze_until: r.get(14)?,
    };
    // Apply user edits inline so callers see effective values; LLM baseline
    // remains in s.raw_json for callers that need it (e.g. revert_field).
    apply_user_edits(&mut s);
    Ok(s)
  }).map_err(|e| format!("query: {}", e))?;

  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| format!("row: {}", e))?);
  }
  Ok(out)
}

/// Fetch item-level summaries generated within a time window.
/// Used by the week-rollup generator to synthesize a higher-order digest.
pub fn get_summaries_in_window(
  start_ms: i64,
  end_ms: i64,
  want_lang: &str,
) -> Result<Vec<Summary>, String> {
  let conn = open_conn()?;
  let mut stmt = conn.prepare(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json, lang, user_priority, acknowledged_at, snooze_until
     FROM mem_summaries
     WHERE target_kind = 'item'
       AND lang = ?1
       AND generated_at >= ?2
       AND generated_at <  ?3
     ORDER BY
       CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       generated_at DESC"
  ).map_err(|e| format!("prepare window: {}", e))?;
  let rows = stmt.query_map(params![want_lang, start_ms, end_ms], |r| {
    let kp_json: String = r.get(3)?;
    let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
    let mut s = Summary {
      target_kind: r.get(0)?,
      target_id: r.get(1)?,
      title: r.get(2)?,
      key_points,
      source_type: r.get(4)?,
      priority: r.get(5)?,
      reason: r.get(6)?,
      model: r.get(7)?,
      schema_version: r.get(8)?,
      generated_at: r.get(9)?,
      raw_json: r.get(10)?,
      lang: r.get(11)?,
      user_priority: r.get(12)?,
      acknowledged_at: r.get(13)?,
      snooze_until: r.get(14)?,
    };
    // Apply user edits inline so callers see effective values; LLM baseline
    // remains in s.raw_json for callers that need it (e.g. revert_field).
    apply_user_edits(&mut s);
    Ok(s)
  }).map_err(|e| format!("query window: {}", e))?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| format!("row: {}", e))?);
  }
  Ok(out)
}

pub fn upsert(s: &Summary) -> Result<(), String> {
  let conn = open_conn()?;
  let kp_json = serde_json::to_string(&s.key_points)
    .map_err(|e| format!("key_points serialize: {}", e))?;
  conn.execute(
    "INSERT INTO mem_summaries
       (target_kind, target_id, title, key_points, source_type, priority,
        reason, model, schema_version, generated_at, raw_json, lang)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(target_kind, target_id) DO UPDATE SET
       title = excluded.title,
       key_points = excluded.key_points,
       source_type = excluded.source_type,
       priority = excluded.priority,
       reason = excluded.reason,
       model = excluded.model,
       schema_version = excluded.schema_version,
       generated_at = excluded.generated_at,
       raw_json = excluded.raw_json,
       lang = excluded.lang",
    params![
      s.target_kind, s.target_id, s.title, kp_json, s.source_type,
      s.priority, s.reason, s.model, s.schema_version, s.generated_at, s.raw_json, s.lang
    ],
  ).map_err(|e| format!("mem_summaries upsert: {}", e))?;
  Ok(())
}

/// Fetch item-level summaries for a single entity (joins mem_summaries
/// against mem_items by id). Used by the entity-rollup generator.
/// Sorted HIGH → MED → LOW, then by recency. Caps at `limit` rows.
pub fn get_summaries_for_entity(
  entity_id: &str,
  want_lang: &str,
  limit: usize,
) -> Result<Vec<Summary>, String> {
  let conn = open_conn()?;
  let mut stmt = conn.prepare(
    "SELECT s.target_kind, s.target_id, s.title, s.key_points, s.source_type, s.priority,
            s.reason, s.model, s.schema_version, s.generated_at, s.raw_json, s.lang,
            s.user_priority, s.acknowledged_at
     FROM mem_summaries s
     INNER JOIN mem_items i ON i.id = s.target_id
     WHERE s.target_kind = 'item'
       AND s.lang = ?1
       AND i.entity_id = ?2
     ORDER BY
       CASE s.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       s.generated_at DESC
     LIMIT ?3"
  ).map_err(|e| format!("prepare entity: {}", e))?;
  let rows = stmt.query_map(params![want_lang, entity_id, limit as i64], |r| {
    let kp_json: String = r.get(3)?;
    let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
    let mut s = Summary {
      target_kind: r.get(0)?,
      target_id: r.get(1)?,
      title: r.get(2)?,
      key_points,
      source_type: r.get(4)?,
      priority: r.get(5)?,
      reason: r.get(6)?,
      model: r.get(7)?,
      schema_version: r.get(8)?,
      generated_at: r.get(9)?,
      raw_json: r.get(10)?,
      lang: r.get(11)?,
      user_priority: r.get(12)?,
      acknowledged_at: r.get(13)?,
      snooze_until: r.get(14)?,
    };
    // Apply user edits inline so callers see effective values; LLM baseline
    // remains in s.raw_json for callers that need it (e.g. revert_field).
    apply_user_edits(&mut s);
    Ok(s)
  }).map_err(|e| format!("query entity: {}", e))?;
  let mut out = Vec::new();
  for row in rows {
    out.push(row.map_err(|e| format!("row: {}", e))?);
  }
  Ok(out)
}

/// Snooze a summary until `snooze_until_ms` (None clears the snooze).
/// Returns true if a row was updated.
pub fn set_snoozed(
  target_kind: &str,
  target_id: &str,
  snooze_until_ms: Option<i64>,
) -> Result<bool, String> {
  let conn = open_conn()?;
  let n = conn.execute(
    "UPDATE mem_summaries SET snooze_until = ?3 WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id, snooze_until_ms],
  ).map_err(|e| format!("mem_summaries set_snoozed: {}", e))?;
  Ok(n > 0)
}

/// Mark the summary as read (ack = now_ms) or unread (ack = None).
/// Returns true if a row was updated.
pub fn set_acknowledged(
  target_kind: &str,
  target_id: &str,
  acknowledged_ms: Option<i64>,
) -> Result<bool, String> {
  let conn = open_conn()?;
  let n = conn.execute(
    "UPDATE mem_summaries SET acknowledged_at = ?3 WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id, acknowledged_ms],
  ).map_err(|e| format!("mem_summaries set_acknowledged: {}", e))?;
  Ok(n > 0)
}

/// Bulk mark as read for a set of (target_kind, target_id) pairs, all at once.
pub fn acknowledge_many(pairs: &[(&str, &str)], acknowledged_ms: i64) -> Result<u64, String> {
  if pairs.is_empty() {
    return Ok(0);
  }
  let mut conn = open_conn()?;
  let tx = conn.transaction().map_err(|e| format!("acknowledge_many tx: {}", e))?;
  let mut total: u64 = 0;
  {
    let mut stmt = tx.prepare(
      "UPDATE mem_summaries SET acknowledged_at = ?3 WHERE target_kind = ?1 AND target_id = ?2"
    ).map_err(|e| format!("acknowledge_many prepare: {}", e))?;
    for (kind, id) in pairs {
      let n = stmt
        .execute(params![kind, id, acknowledged_ms])
        .map_err(|e| format!("acknowledge_many exec: {}", e))?;
      total += n as u64;
    }
  }
  tx.commit().map_err(|e| format!("acknowledge_many commit: {}", e))?;
  Ok(total)
}

/// Set or clear the user's manual priority override on an existing summary.
/// Pass Some("high"|"medium"|"low") to override the LLM priority, or None
/// to clear the override. Errors if the row doesn't exist.
pub fn set_user_priority(
  target_kind: &str,
  target_id: &str,
  user_priority: Option<&str>,
) -> Result<bool, String> {
  if let Some(p) = user_priority {
    if !matches!(p, "high" | "medium" | "low") {
      return Err(format!("invalid user_priority: {}", p));
    }
  }
  let conn = open_conn()?;
  let n = conn.execute(
    "UPDATE mem_summaries SET user_priority = ?3 WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id, user_priority],
  ).map_err(|e| format!("mem_summaries set_user_priority: {}", e))?;
  Ok(n > 0)
}

/// Metadata for a single user-edit entry written to `raw_json.user_edits[]`.
#[derive(Debug, Clone)]
pub struct EditMetadata<'a> {
  pub source_raw: Option<&'a str>,
  pub entity_id: Option<&'a str>,
}

/// Append a single user-edit entry to `raw_json.user_edits[]` for one field.
/// `field` must be one of "title" | "keyPoints" | "reason". `from` and `to`
/// are stored verbatim as JSON values (use `Value::Null` for None reason etc).
/// Returns `false` if no row exists for this target.
pub fn edit_field(
  target_kind: &str,
  target_id: &str,
  field: &str,
  from: serde_json::Value,
  to: serde_json::Value,
  at_ms: i64,
  meta: EditMetadata<'_>,
) -> Result<bool, String> {
  if !matches!(field, "title" | "keyPoints" | "reason") {
    return Err(format!("invalid edit field: {}", field));
  }
  let conn = open_conn()?;

  // 1. Read current raw_json.
  let raw_now: Option<String> = conn
    .query_row(
      "SELECT raw_json FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
      params![target_kind, target_id],
      |r| r.get::<_, String>(0),
    )
    .ok();
  let raw_now = match raw_now {
    Some(s) => s,
    None => return Ok(false),
  };

  // 2. Parse → object (reset to empty {} if malformed).
  let mut parsed: serde_json::Value =
    serde_json::from_str(&raw_now).unwrap_or_else(|_| serde_json::json!({}));
  if !parsed.is_object() {
    parsed = serde_json::json!({});
  }

  // 3. Append entry to user_edits[].
  let new_entry = serde_json::json!({
    "field": field,
    "from": from,
    "to": to,
    "at": at_ms,
    "source_raw": meta.source_raw,
    "entity_id": meta.entity_id,
    "schema": 1
  });
  let edits = parsed
    .as_object_mut()
    .unwrap()
    .entry("user_edits".to_string())
    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
  if !edits.is_array() {
    *edits = serde_json::Value::Array(Vec::new());
  }
  edits.as_array_mut().unwrap().push(new_entry);

  // 4. Re-serialize and write back. Also update the dedicated columns so
  //    downstream callers that read columns directly (rather than via the
  //    Summary loader) see the new effective value.
  let new_raw = serde_json::to_string(&parsed)
    .map_err(|e| format!("re-serialize raw_json: {}", e))?;

  // Build the column update for the edited field.
  match field {
    "title" => {
      let new_title = to.as_str().unwrap_or("");
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, title = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, new_title],
      )
    }
    "keyPoints" => {
      let kp_json = serde_json::to_string(&to)
        .unwrap_or_else(|_| "[]".to_string());
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, key_points = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, kp_json],
      )
    }
    "reason" => {
      let new_reason: Option<&str> = to.as_str();
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, reason = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, new_reason],
      )
    }
    _ => unreachable!(), // guarded above
  }
  .map_err(|e| format!("mem_summaries edit_field write: {}", e))?;
  Ok(true)
}

/// Remove all `user_edits[]` entries for one field from `raw_json`. Also
/// resets the dedicated column for that field back to whatever the LLM
/// baseline was — recovered by replaying the remaining edits onto the
/// `raw_json.tool_use.<field>` value.
/// Returns `false` if no row exists for this target.
pub fn revert_field(
  target_kind: &str,
  target_id: &str,
  field: &str,
) -> Result<bool, String> {
  if !matches!(field, "title" | "keyPoints" | "reason") {
    return Err(format!("invalid revert field: {}", field));
  }
  let conn = open_conn()?;

  let raw_now: Option<String> = conn
    .query_row(
      "SELECT raw_json FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
      params![target_kind, target_id],
      |r| r.get::<_, String>(0),
    )
    .ok();
  let raw_now = match raw_now {
    Some(s) => s,
    None => return Ok(false),
  };

  let mut parsed: serde_json::Value =
    serde_json::from_str(&raw_now).unwrap_or_else(|_| serde_json::json!({}));
  if !parsed.is_object() {
    parsed = serde_json::json!({});
  }

  // Drop matching entries from user_edits[].
  if let Some(edits) = parsed
    .as_object_mut()
    .unwrap()
    .get_mut("user_edits")
    .and_then(|v| v.as_array_mut())
  {
    edits.retain(|e| e.get("field").and_then(|v| v.as_str()) != Some(field));
  }

  // Compute the baseline value for the dedicated column.
  // Baseline = raw_json.tool_use.<field> if present, else fallback string.
  let baseline = parsed
    .get("tool_use")
    .and_then(|tu| tu.get(field))
    .cloned();

  // Re-apply any remaining edits for this field (defensive — there should be
  // none after retain). Then write back raw_json AND the column.
  let new_raw = serde_json::to_string(&parsed)
    .map_err(|e| format!("re-serialize raw_json: {}", e))?;

  match field {
    "title" => {
      let title_str = baseline.as_ref().and_then(|v| v.as_str()).unwrap_or("");
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, title = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, title_str],
      )
    }
    "keyPoints" => {
      let kp_json = baseline
        .as_ref()
        .and_then(|v| serde_json::to_string(v).ok())
        .unwrap_or_else(|| "[]".to_string());
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, key_points = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, kp_json],
      )
    }
    "reason" => {
      let reason_str: Option<&str> = baseline.as_ref().and_then(|v| v.as_str());
      conn.execute(
        "UPDATE mem_summaries SET raw_json = ?3, reason = ?4
         WHERE target_kind = ?1 AND target_id = ?2",
        params![target_kind, target_id, new_raw, reason_str],
      )
    }
    _ => unreachable!(),
  }
  .map_err(|e| format!("mem_summaries revert_field write: {}", e))?;
  Ok(true)
}

pub fn delete(target_kind: &str, target_id: &str) -> Result<bool, String> {
  let conn = open_conn()?;
  let n = conn.execute(
    "DELETE FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id],
  ).map_err(|e| format!("mem_summaries delete: {}", e))?;
  Ok(n > 0)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(target_id: &str, priority: &str) -> Summary {
    Summary {
      target_kind: "item".into(),
      target_id: target_id.into(),
      title: "Test".into(),
      key_points: vec!["point 1".into(), "point 2".into()],
      source_type: "mail".into(),
      priority: priority.into(),
      reason: Some("because".into()),
      model: "test".into(),
      schema_version: 1,
      generated_at: 1700000000,
      raw_json: "{\"x\":1}".into(),
      lang: "en".into(),
      user_priority: None,
      acknowledged_at: None,
      snooze_until: None,
    }
  }

  #[test]
  fn summary_to_json_roundtrip() {
    // Purely struct logic, no DB.
    let s = sample("m_1", "high");
    let v = s.to_json();
    assert_eq!(v["targetKind"], "item");
    assert_eq!(v["targetId"], "m_1");
    assert_eq!(v["priority"], "high");
    assert_eq!(v["keyPoints"][0], "point 1");
    assert_eq!(v["schemaVersion"], 1);
  }

  fn sample_with_raw(raw: &str) -> Summary {
    Summary {
      target_kind: "item".into(),
      target_id: "m_e".into(),
      title: "AI base title".into(),
      key_points: vec!["base 1".into(), "base 2".into()],
      source_type: "mail".into(),
      priority: "medium".into(),
      reason: Some("AI base reason".into()),
      model: "test".into(),
      schema_version: 1,
      generated_at: 1700000000,
      raw_json: raw.to_string(),
      lang: "en".into(),
      user_priority: None,
      acknowledged_at: None,
      snooze_until: None,
    }
  }

  #[test]
  fn apply_user_edits_no_edits() {
    let mut s = sample_with_raw(r#"{"tool_use":{},"stop_reason":"tool_use"}"#);
    apply_user_edits(&mut s);
    assert_eq!(s.title, "AI base title");
    assert_eq!(s.key_points, vec!["base 1".to_string(), "base 2".into()]);
    assert_eq!(s.reason.as_deref(), Some("AI base reason"));
  }

  #[test]
  fn apply_user_edits_empty_array() {
    let mut s = sample_with_raw(r#"{"tool_use":{},"user_edits":[]}"#);
    apply_user_edits(&mut s);
    assert_eq!(s.title, "AI base title");
    assert_eq!(s.key_points, vec!["base 1".to_string(), "base 2".into()]);
    assert_eq!(s.reason.as_deref(), Some("AI base reason"));
  }

  #[test]
  fn apply_user_edits_title_override() {
    let raw = r#"{
      "tool_use": {},
      "user_edits": [
        {"field":"title","from":"AI base title","to":"User title v1","at":1,"source_raw":"chat","entity_id":null,"schema":1}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert_eq!(s.title, "User title v1");
    assert_eq!(s.key_points, vec!["base 1".to_string(), "base 2".into()]);
    assert_eq!(s.reason.as_deref(), Some("AI base reason"));
  }

  #[test]
  fn apply_user_edits_latest_wins_per_field() {
    let raw = r#"{
      "user_edits": [
        {"field":"title","to":"first","at":1,"schema":1},
        {"field":"title","to":"second","at":2,"schema":1},
        {"field":"reason","to":"new reason","at":3,"schema":1}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert_eq!(s.title, "second");
    assert_eq!(s.reason.as_deref(), Some("new reason"));
  }

  #[test]
  fn apply_user_edits_keypoints_replaces_array() {
    let raw = r#"{
      "user_edits": [
        {"field":"keyPoints","to":["x","y","z"],"at":1,"schema":1}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert_eq!(s.key_points, vec!["x".to_string(), "y".into(), "z".into()]);
  }

  #[test]
  fn apply_user_edits_reason_to_null_clears() {
    let raw = r#"{
      "user_edits": [
        {"field":"reason","to":null,"at":1,"schema":1}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert!(s.reason.is_none());
  }

  #[test]
  fn apply_user_edits_unknown_schema_ignored() {
    let raw = r#"{
      "user_edits": [
        {"field":"title","to":"future","at":1,"schema":99}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert_eq!(s.title, "AI base title"); // schema mismatch → ignored
  }

  #[test]
  fn apply_user_edits_malformed_raw_json_safe() {
    let mut s = sample_with_raw("not json at all");
    apply_user_edits(&mut s);
    assert_eq!(s.title, "AI base title"); // graceful no-op
  }

  #[test]
  fn apply_user_edits_unknown_field_ignored() {
    let raw = r#"{
      "user_edits": [
        {"field":"sourceType","to":"override","at":1,"schema":1}
      ]
    }"#;
    let mut s = sample_with_raw(raw);
    apply_user_edits(&mut s);
    assert_eq!(s.source_type, "mail"); // not editable; ignored
  }

  use serde_json::json;

  // Helper to set up an in-memory test DB with one upserted summary.
  // Uses crate::memory_store::open_conn() which the existing tests rely on.
  fn fresh_db_with_summary(target_id: &str) -> Summary {
    let s = sample(target_id, "medium");
    upsert(&s).expect("upsert");
    get_cached("item", target_id, "en").expect("read").expect("present")
  }

  #[test]
  #[ignore] // requires DB harness — run via `cargo test -- --ignored`
  fn edit_field_title_writes_history_and_column() {
    let _ = fresh_db_with_summary("m_edit_t");
    let ok = edit_field(
      "item",
      "m_edit_t",
      "title",
      json!("Test"),
      json!("Edited title"),
      1700000001,
      EditMetadata { source_raw: Some("chat"), entity_id: None },
    )
    .expect("edit_field");
    assert!(ok);

    let s = get_cached("item", "m_edit_t", "en").expect("read").expect("present");
    assert_eq!(s.title, "Edited title", "merged on load via apply_user_edits");

    let parsed: serde_json::Value =
      serde_json::from_str(&s.raw_json).expect("parse");
    let edits = parsed.get("user_edits").and_then(|v| v.as_array()).unwrap();
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].get("field").and_then(|v| v.as_str()), Some("title"));
    assert_eq!(edits[0].get("schema").and_then(|v| v.as_i64()), Some(1));
    assert_eq!(edits[0].get("source_raw").and_then(|v| v.as_str()), Some("chat"));
  }

  #[test]
  #[ignore]
  fn edit_field_keypoints_replaces_array() {
    let _ = fresh_db_with_summary("m_edit_kp");
    edit_field(
      "item",
      "m_edit_kp",
      "keyPoints",
      json!(["point 1", "point 2"]),
      json!(["new 1", "new 2", "new 3"]),
      1700000002,
      EditMetadata { source_raw: None, entity_id: None },
    )
    .expect("edit_field");

    let s = get_cached("item", "m_edit_kp", "en").expect("read").expect("present");
    assert_eq!(s.key_points, vec!["new 1".to_string(), "new 2".into(), "new 3".into()]);
  }

  #[test]
  #[ignore]
  fn revert_field_clears_edits_and_restores_baseline() {
    let _ = fresh_db_with_summary("m_revert");
    edit_field("item", "m_revert", "title", json!("Test"), json!("Edited"), 1, EditMetadata { source_raw: None, entity_id: None }).unwrap();
    edit_field("item", "m_revert", "title", json!("Edited"), json!("Edited 2"), 2, EditMetadata { source_raw: None, entity_id: None }).unwrap();

    // Confirm edited.
    let edited = get_cached("item", "m_revert", "en").unwrap().unwrap();
    assert_eq!(edited.title, "Edited 2");

    // Revert.
    revert_field("item", "m_revert", "title").unwrap();
    let after = get_cached("item", "m_revert", "en").unwrap().unwrap();
    // Baseline title comes from `raw_json.tool_use.title`. The sample row's
    // initial raw_json is `{"x":1}`, so tool_use.title is missing → empty.
    // The point of this test is "edits cleared", not "baseline arbitrary".
    assert_eq!(after.title, "");

    let parsed: serde_json::Value = serde_json::from_str(&after.raw_json).unwrap();
    let edits = parsed.get("user_edits").and_then(|v| v.as_array()).unwrap();
    assert!(edits.iter().all(|e| e.get("field").and_then(|v| v.as_str()) != Some("title")));
  }

  #[test]
  #[ignore]
  fn edit_field_invalid_field_errors() {
    let r = edit_field(
      "item",
      "m_x",
      "sourceType",
      json!(null),
      json!("hack"),
      1,
      EditMetadata { source_raw: None, entity_id: None },
    );
    assert!(r.is_err(), "non-allowlisted field must error");
  }
}
