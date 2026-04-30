//! Spatial pattern detection (KIOKU Sub-spec F).
//! Groups recent captures by (display_id, app_bundle_id, quadrant) and
//! UPSERTs into `patterns` with kind='spatial' when observed across 3+
//! distinct days in the last 14 days.

use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct SpatialCaptureRow {
  pub app_bundle_id: String,
  pub captured_at: i64,
  pub spatial_context: Value, // pre-parsed JSON
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn upsert_spatial(
  conn: &Connection,
  display_id: u32,
  display_label: &str,
  app_bundle: &str,
  app_label: &str,
  quadrant: &str,
  observed_n: i64,
  first_seen_at: i64,
  last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({
    "display_id": display_id,
    "display_label": display_label,
    "quadrant": quadrant,
  })
  .to_string();
  let action_json = json!({
    "app": app_bundle,
    "label": app_label,
  })
  .to_string();

  let existing: Option<String> = conn
    .query_row(
      "SELECT id FROM patterns WHERE kind='spatial' AND trigger_json=?1 AND action_json=?2 LIMIT 1",
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("spatial_patterns::upsert_spatial select: {}", e))?;

  if let Some(id) = existing {
    conn
      .execute(
        "UPDATE patterns SET observed_n=?1, confidence=?2, last_seen_at=?3, status='active' WHERE id=?4",
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("spatial_patterns::upsert_spatial update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        "INSERT INTO patterns (id, kind, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at, status) VALUES (?1, 'spatial', ?2, ?3, ?4, ?5, ?6, ?7, 'active')",
        params![id, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at],
      )
      .map_err(|e| format!("spatial_patterns::upsert_spatial insert: {}", e))?;
  }
  Ok(())
}

/// Detect spatial patterns from recent captures. Returns the count of
/// patterns UPSERTed.
pub(crate) fn detect_spatial(
  conn: &Connection,
  captures: &[SpatialCaptureRow],
) -> Result<usize, String> {
  if captures.is_empty() {
    return Ok(0);
  }

  type Key = (u32, String, String);
  let mut buckets: HashMap<Key, HashSet<chrono::NaiveDate>> = HashMap::new();
  let mut display_labels: HashMap<u32, String> = HashMap::new();
  let mut first_last: HashMap<Key, (i64, i64)> = HashMap::new();

  for cap in captures {
    let ctx = match cap.spatial_context.as_object() {
      Some(o) => o,
      None => continue,
    };
    let display_id = match ctx.get("display_id").and_then(|v| v.as_u64()) {
      Some(n) => n as u32,
      None => continue,
    };
    let display_label = ctx
      .get("display_label")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string();
    let quadrant = match ctx.get("quadrant").and_then(|v| v.as_str()) {
      Some(s) => s.to_string(),
      None => continue,
    };
    let app = cap.app_bundle_id.clone();
    let dt = match Local.timestamp_millis_opt(cap.captured_at).single() {
      Some(d) => d,
      None => continue,
    };
    let key = (display_id, app, quadrant);
    buckets.entry(key.clone()).or_default().insert(dt.date_naive());
    display_labels.entry(display_id).or_insert(display_label);
    let entry = first_last
      .entry(key)
      .or_insert((cap.captured_at, cap.captured_at));
    if cap.captured_at < entry.0 {
      entry.0 = cap.captured_at;
    }
    if cap.captured_at > entry.1 {
      entry.1 = cap.captured_at;
    }
  }

  let mut emitted = 0usize;
  for ((display_id, app, quadrant), days) in buckets {
    if days.len() >= 3 {
      let observed_n = days.len() as i64;
      let app_label = crate::patterns::friendly_app_name(&app);
      let display_label = display_labels
        .get(&display_id)
        .cloned()
        .unwrap_or_else(|| format!("Display {}", display_id));
      let (first_seen_at, last_seen_at) = first_last
        .get(&(display_id, app.clone(), quadrant.clone()))
        .copied()
        .unwrap_or((now_ms(), now_ms()));
      upsert_spatial(
        conn,
        display_id,
        &display_label,
        &app,
        &app_label,
        &quadrant,
        observed_n,
        first_seen_at,
        last_seen_at,
      )?;
      emitted += 1;
    }
  }
  Ok(emitted)
}
