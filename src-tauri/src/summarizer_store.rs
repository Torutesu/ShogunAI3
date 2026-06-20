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
    pub priority: String, // LLM-assigned priority: 'high' | 'medium' | 'low'
    pub reason: Option<String>,
    pub model: String,
    pub schema_version: i64,
    pub generated_at: i64,
    pub raw_json: String,
    pub lang: String, // 'en' | 'jp' | 'bi' — matches tweaks.language at generation time
    pub user_priority: Option<String>, // Manual override from the user. None = no override.
    pub acknowledged_at: Option<i64>, // When the user marked this summary as read. None = unread.
    pub snooze_until: Option<i64>, // Hidden from highlights while > now_ms.
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
pub fn get_cached(
    target_kind: &str,
    target_id: &str,
    want_lang: &str,
) -> Result<Option<Summary>, String> {
    let conn = open_conn()?;
    let row = conn.query_row(
    "SELECT target_kind, target_id, title, key_points, source_type, priority,
            reason, model, schema_version, generated_at, raw_json, lang, user_priority, acknowledged_at, snooze_until
     FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
    params![target_kind, target_id],
    |r| {
      let kp_json: String = r.get(3)?;
      let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
      Ok(Summary {
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
      })
    },
  );
    match row {
        Ok(s) if s.lang == want_lang => Ok(Some(s)),
        Ok(_) => Ok(None), // language mismatch → treat as cache miss
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("mem_summaries read: {}", e)),
    }
}

pub fn get_cached_many(
    target_kind: &str,
    ids: &[String],
    want_lang: &str,
) -> Result<Vec<Summary>, String> {
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
    let rows = stmt
        .query_map(bound.as_slice(), |r| {
            let kp_json: String = r.get(3)?;
            let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
            Ok(Summary {
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
            })
        })
        .map_err(|e| format!("query: {}", e))?;

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
    let rows = stmt
        .query_map(params![want_lang, start_ms, end_ms], |r| {
            let kp_json: String = r.get(3)?;
            let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
            Ok(Summary {
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
            })
        })
        .map_err(|e| format!("query window: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("row: {}", e))?);
    }
    Ok(out)
}

pub fn upsert(s: &Summary) -> Result<(), String> {
    let conn = open_conn()?;
    let kp_json =
        serde_json::to_string(&s.key_points).map_err(|e| format!("key_points serialize: {}", e))?;
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
            s.target_kind,
            s.target_id,
            s.title,
            kp_json,
            s.source_type,
            s.priority,
            s.reason,
            s.model,
            s.schema_version,
            s.generated_at,
            s.raw_json,
            s.lang
        ],
    )
    .map_err(|e| format!("mem_summaries upsert: {}", e))?;
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
    let mut stmt = conn
        .prepare(
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
     LIMIT ?3",
        )
        .map_err(|e| format!("prepare entity: {}", e))?;
    let rows = stmt
        .query_map(params![want_lang, entity_id, limit as i64], |r| {
            let kp_json: String = r.get(3)?;
            let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
            Ok(Summary {
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
            })
        })
        .map_err(|e| format!("query entity: {}", e))?;
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
    let n = conn
        .execute(
            "UPDATE mem_summaries SET snooze_until = ?3 WHERE target_kind = ?1 AND target_id = ?2",
            params![target_kind, target_id, snooze_until_ms],
        )
        .map_err(|e| format!("mem_summaries set_snoozed: {}", e))?;
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
    let tx = conn
        .transaction()
        .map_err(|e| format!("acknowledge_many tx: {}", e))?;
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
    tx.commit()
        .map_err(|e| format!("acknowledge_many commit: {}", e))?;
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
    let n = conn
        .execute(
            "UPDATE mem_summaries SET user_priority = ?3 WHERE target_kind = ?1 AND target_id = ?2",
            params![target_kind, target_id, user_priority],
        )
        .map_err(|e| format!("mem_summaries set_user_priority: {}", e))?;
    Ok(n > 0)
}

pub fn delete(target_kind: &str, target_id: &str) -> Result<bool, String> {
    let conn = open_conn()?;
    let n = conn
        .execute(
            "DELETE FROM mem_summaries WHERE target_kind = ?1 AND target_id = ?2",
            params![target_kind, target_id],
        )
        .map_err(|e| format!("mem_summaries delete: {}", e))?;
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
}
