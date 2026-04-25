//! Dead-letter queue for ingest failures.
//!
//! When a connector pulls an item but `memory_store::ingest` (or the upstream
//! transcribe/fetch step) fails, we stash the original payload here so the
//! user can retry later instead of losing the item silently.
//!
//! Schema is simple and append-only-ish: re-recording the same `(source,
//! entity_id)` updates `attempts` + `last_failed_at` rather than creating a
//! new row.

use crate::memory_store;
use rusqlite::params;
use serde_json::{json, Value};

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn ensure_schema() -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute_batch(
      r#"
      CREATE TABLE IF NOT EXISTS mem_dead_letter (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        source          TEXT NOT NULL,
        entity_id       TEXT,
        payload_json    TEXT NOT NULL,
        error_message   TEXT NOT NULL,
        attempts        INTEGER NOT NULL DEFAULT 1,
        first_failed_at INTEGER NOT NULL,
        last_failed_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mem_dead_letter_unique
        ON mem_dead_letter(source, entity_id)
        WHERE entity_id IS NOT NULL AND entity_id != '';
      CREATE INDEX IF NOT EXISTS idx_mem_dead_letter_recent
        ON mem_dead_letter(last_failed_at DESC);
      "#,
    )
    .map_err(|e| format!("dead_letter DDL: {}", e))?;
  Ok(())
}

/// Record (or upsert) a failed ingest. `entity_id` is read from the payload
/// so connectors can call `record(source, &payload, err)` without unpacking.
pub fn record(source: &str, payload: &Value, err: &str) -> Result<(), String> {
  ensure_schema()?;
  let conn = memory_store::open_conn()?;
  let entity_id = payload
    .get("entity_id")
    .and_then(|v| v.as_str())
    .map(|s| s.to_string())
    .unwrap_or_default();
  let payload_json = serde_json::to_string(payload).map_err(|e| e.to_string())?;
  let now = now_ms() as i64;

  // Try update first (matches the unique index on non-empty entity_id).
  let updated = if !entity_id.is_empty() {
    conn
      .execute(
        "UPDATE mem_dead_letter \
         SET payload_json = ?1, error_message = ?2, attempts = attempts + 1, last_failed_at = ?3 \
         WHERE source = ?4 AND entity_id = ?5",
        params![payload_json, err, now, source, entity_id],
      )
      .map_err(|e| e.to_string())?
  } else {
    0
  };
  if updated == 0 {
    conn
      .execute(
        "INSERT INTO mem_dead_letter \
         (source, entity_id, payload_json, error_message, attempts, first_failed_at, last_failed_at) \
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
        params![
          source,
          if entity_id.is_empty() { None } else { Some(entity_id) },
          payload_json,
          err,
          now,
        ],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

pub fn list(limit: i64, source_filter: Option<&str>) -> Result<Vec<Value>, String> {
  ensure_schema()?;
  let conn = memory_store::open_conn()?;
  let lim = limit.clamp(1, 1000);
  let mut out = Vec::new();
  if let Some(filter) = source_filter {
    let mut stmt = conn
      .prepare(
        "SELECT id, source, entity_id, payload_json, error_message, attempts, first_failed_at, last_failed_at \
         FROM mem_dead_letter WHERE source = ?1 ORDER BY last_failed_at DESC LIMIT ?2",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map(params![filter, lim], row_to_json)
      .map_err(|e| e.to_string())?;
    for r in rows {
      out.push(r.map_err(|e| e.to_string())?);
    }
  } else {
    let mut stmt = conn
      .prepare(
        "SELECT id, source, entity_id, payload_json, error_message, attempts, first_failed_at, last_failed_at \
         FROM mem_dead_letter ORDER BY last_failed_at DESC LIMIT ?1",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map(params![lim], row_to_json)
      .map_err(|e| e.to_string())?;
    for r in rows {
      out.push(r.map_err(|e| e.to_string())?);
    }
  }
  Ok(out)
}

fn row_to_json(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
  let id: i64 = r.get(0)?;
  let source: String = r.get(1)?;
  let entity_id: Option<String> = r.get(2)?;
  let payload_json: String = r.get(3)?;
  let error_message: String = r.get(4)?;
  let attempts: i64 = r.get(5)?;
  let first_failed_at: i64 = r.get(6)?;
  let last_failed_at: i64 = r.get(7)?;
  let payload: Value = serde_json::from_str(&payload_json).unwrap_or(json!({}));
  Ok(json!({
    "id": id,
    "source": source,
    "entityId": entity_id,
    "payload": payload,
    "errorMessage": error_message,
    "attempts": attempts,
    "firstFailedAt": first_failed_at,
    "lastFailedAt": last_failed_at,
  }))
}

/// Counts grouped by `source`, plus a `total`. Used by the Integrations UI to
/// surface backlog size at a glance.
pub fn counts() -> Result<Value, String> {
  ensure_schema()?;
  let conn = memory_store::open_conn()?;
  let mut stmt = conn
    .prepare("SELECT source, COUNT(*) FROM mem_dead_letter GROUP BY source")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
    .map_err(|e| e.to_string())?;
  let mut by_source = serde_json::Map::new();
  let mut total: i64 = 0;
  for row in rows {
    let (s, n) = row.map_err(|e| e.to_string())?;
    total += n;
    by_source.insert(s, json!(n));
  }
  Ok(json!({
    "total": total,
    "bySource": Value::Object(by_source),
  }))
}

/// Replay each pending row through `memory_store::ingest`. Successful rows are
/// removed from the queue. Failures stay (and bump `attempts`).
pub fn retry_all(limit: i64, source_filter: Option<&str>) -> Result<Value, String> {
  let pending = list(limit, source_filter)?;
  let mut succeeded = 0u32;
  let mut failed = 0u32;
  for row in pending.iter() {
    let id = row.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let source = row.get("source").and_then(|v| v.as_str()).unwrap_or("");
    let payload = row.get("payload").cloned().unwrap_or(json!({}));
    match memory_store::ingest(&payload) {
      Ok(_) => {
        delete_by_id(id)?;
        succeeded += 1;
      }
      Err(e) => {
        // Bump attempts + update error.
        let _ = record(source, &payload, &e);
        failed += 1;
      }
    }
  }
  Ok(json!({
    "succeeded": succeeded,
    "failed": failed,
  }))
}

pub fn delete_by_id(id: i64) -> Result<(), String> {
  let conn = memory_store::open_conn()?;
  conn
    .execute("DELETE FROM mem_dead_letter WHERE id = ?1", params![id])
    .map_err(|e| e.to_string())?;
  Ok(())
}

pub fn clear(source_filter: Option<&str>) -> Result<u64, String> {
  ensure_schema()?;
  let conn = memory_store::open_conn()?;
  let n = if let Some(filter) = source_filter {
    conn
      .execute("DELETE FROM mem_dead_letter WHERE source = ?1", params![filter])
      .map_err(|e| e.to_string())?
  } else {
    conn
      .execute("DELETE FROM mem_dead_letter", [])
      .map_err(|e| e.to_string())?
  };
  Ok(n as u64)
}
