//! Patterns layer (KIOKU Sub-spec B). Daily-batch detection of temporal
//! and sequential behaviors from `mem_captures`. Surfaced in the Morning
//! Brief and (Sub-spec C) the Settings UI.
//!
//! Schema: see `kioku_graph_schema::ensure_phase2_tables`. This module
//! owns CRUD + detection orchestration.

use chrono::{Datelike, Local, TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewPattern {
  pub kind: String,
  pub trigger_json: Value,
  pub action_json: Value,
  pub confidence: f32,
  pub observed_n: i64,
  pub first_seen_at: i64,
  pub last_seen_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pattern {
  pub id: String,
  pub kind: String,
  pub trigger_json: Value,
  pub action_json: Value,
  pub confidence: f32,
  pub observed_n: i64,
  pub first_seen_at: i64,
  pub last_seen_at: i64,
  pub status: String,
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

const FRIENDLY_APP_NAMES: &[(&str, &str)] = &[
  ("com.tinyspeck.slackmacgap", "Slack"),
  ("notion.id", "Notion"),
  ("co.linear.linear", "Linear"),
  ("com.google.Chrome", "Chrome"),
  ("company.thebrowser.Browser", "Arc"),
  ("com.googlecode.iterm2", "iTerm"),
  ("com.apple.Terminal", "Terminal"),
  ("com.apple.mail", "Mail"),
  ("com.apple.MobileSMS", "Messages"),
  ("com.apple.iCal", "Calendar"),
  ("com.apple.Safari", "Safari"),
  ("com.microsoft.VSCode", "VS Code"),
  ("com.figma.Desktop", "Figma"),
  ("com.spotify.client", "Spotify"),
];

pub(crate) fn friendly_app_name(bundle: &str) -> String {
  for (k, v) in FRIENDLY_APP_NAMES {
    if *k == bundle {
      return v.to_string();
    }
  }
  bundle.to_string()
}

fn dow_label(dow: u8) -> &'static str {
  match dow {
    0 => "on Sundays",
    1 => "on Mondays",
    2 => "on Tuesdays",
    3 => "on Wednesdays",
    4 => "on Thursdays",
    5 => "on Fridays",
    6 => "on Saturdays",
    _ => "",
  }
}

fn format_temporal_label(hour: u8, dow: u8, app_label: &str) -> String {
  format!("You usually open {} around {:02}:00 {}.", app_label, hour, dow_label(dow))
}

fn format_sequential_label(prev_label: &str, action_label: &str) -> String {
  format!("After {}, you often switch to {} within 30 min.", prev_label, action_label)
}

#[derive(Debug, Clone)]
struct CaptureRow {
  app_bundle_id: String,
  captured_at: i64,
  spatial_context: Option<String>,
}

fn fetch_recent_captures(conn: &Connection, since_ms: i64) -> Result<Vec<CaptureRow>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT app_bundle_id, captured_at, spatial_context
      FROM mem_captures
      WHERE captured_at >= ?1 AND app_bundle_id IS NOT NULL
      ORDER BY captured_at ASC
      "#,
    )
    .map_err(|e| format!("patterns::fetch_recent_captures prepare: {}", e))?;
  let rows = stmt
    .query_map(params![since_ms], |row| {
      Ok(CaptureRow {
        app_bundle_id: row.get::<_, String>(0)?,
        captured_at: row.get::<_, i64>(1)?,
        spatial_context: row.get::<_, Option<String>>(2)?,
      })
    })
    .map_err(|e| format!("patterns::fetch_recent_captures query: {}", e))?;
  let mut out = Vec::new();
  for r in rows {
    out.push(r.map_err(|e| format!("patterns::fetch_recent_captures row: {}", e))?);
  }
  Ok(out)
}

fn upsert_temporal(
  conn: &Connection, hour: u8, dow: u8, app_bundle: &str, app_label: &str,
  observed_n: i64, first_seen_at: i64, last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({"hour": hour, "dow": dow}).to_string();
  let action_json = json!({"app": app_bundle, "label": app_label}).to_string();
  let existing: Option<String> = conn
    .query_row(
      "SELECT id FROM patterns WHERE kind = 'temporal' AND trigger_json = ?1 AND action_json = ?2 LIMIT 1",
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("patterns::upsert_temporal select: {}", e))?;
  if let Some(id) = existing {
    conn
      .execute(
        "UPDATE patterns SET observed_n = ?1, confidence = ?2, last_seen_at = ?3, status = 'active' WHERE id = ?4",
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("patterns::upsert_temporal update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        "INSERT INTO patterns (id, kind, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at, status) VALUES (?1, 'temporal', ?2, ?3, ?4, ?5, ?6, ?7, 'active')",
        params![id, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at],
      )
      .map_err(|e| format!("patterns::upsert_temporal insert: {}", e))?;
  }
  Ok(())
}

fn upsert_sequential(
  conn: &Connection, prev_app: &str, prev_label: &str, app_bundle: &str, app_label: &str,
  observed_n: i64, first_seen_at: i64, last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({"prev_app": prev_app, "prev_label": prev_label}).to_string();
  let action_json = json!({"app": app_bundle, "label": app_label}).to_string();
  let existing: Option<String> = conn
    .query_row(
      "SELECT id FROM patterns WHERE kind = 'sequential' AND trigger_json = ?1 AND action_json = ?2 LIMIT 1",
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("patterns::upsert_sequential select: {}", e))?;
  if let Some(id) = existing {
    conn
      .execute(
        "UPDATE patterns SET observed_n = ?1, confidence = ?2, last_seen_at = ?3, status = 'active' WHERE id = ?4",
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("patterns::upsert_sequential update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        "INSERT INTO patterns (id, kind, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at, status) VALUES (?1, 'sequential', ?2, ?3, ?4, ?5, ?6, ?7, 'active')",
        params![id, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at],
      )
      .map_err(|e| format!("patterns::upsert_sequential insert: {}", e))?;
  }
  Ok(())
}

fn mark_stale_sweep(conn: &Connection) -> Result<(), String> {
  let now = now_ms();
  let cutoff_30d = now - (30 * 24 * 60 * 60 * 1000);
  let cutoff_60d = now - (60 * 24 * 60 * 60 * 1000);
  conn
    .execute(
      "UPDATE patterns SET status = 'stale' WHERE status = 'active' AND observed_n < 10 AND last_seen_at < ?1",
      params![cutoff_30d],
    )
    .map_err(|e| format!("patterns::mark_stale_sweep <10: {}", e))?;
  conn
    .execute(
      "UPDATE patterns SET status = 'stale' WHERE status = 'active' AND observed_n >= 10 AND last_seen_at < ?1",
      params![cutoff_60d],
    )
    .map_err(|e| format!("patterns::mark_stale_sweep >=10: {}", e))?;
  Ok(())
}

pub async fn run_detection() -> Result<usize, String> {
  let conn = crate::memory_store::open_conn()?;
  let since_ms = now_ms() - (14 * 24 * 60 * 60 * 1000);
  let captures = fetch_recent_captures(&conn, since_ms)?;
  if captures.is_empty() { return Ok(0); }

  let mut emitted = 0usize;

  // Temporal pass
  let mut t_buckets: HashMap<(u8, u8, String), HashSet<chrono::NaiveDate>> = HashMap::new();
  let mut t_first_last: HashMap<(u8, u8, String), (i64, i64)> = HashMap::new();
  for cap in &captures {
    let dt = match Local.timestamp_millis_opt(cap.captured_at).single() {
      Some(d) => d,
      None => continue,
    };
    let hour = dt.hour() as u8;
    let dow = dt.weekday().num_days_from_sunday() as u8;
    let app = cap.app_bundle_id.clone();
    let date_only = dt.date_naive();
    let key = (hour, dow, app);
    t_buckets.entry(key.clone()).or_default().insert(date_only);
    let entry = t_first_last.entry(key).or_insert((cap.captured_at, cap.captured_at));
    if cap.captured_at < entry.0 { entry.0 = cap.captured_at; }
    if cap.captured_at > entry.1 { entry.1 = cap.captured_at; }
  }
  for ((hour, dow, app), days) in t_buckets {
    if days.len() >= 3 {
      let observed_n = days.len() as i64;
      let label = friendly_app_name(&app);
      let (first_seen_at, last_seen_at) = t_first_last.get(&(hour, dow, app.clone())).copied().unwrap_or((now_ms(), now_ms()));
      upsert_temporal(&conn, hour, dow, &app, &label, observed_n, first_seen_at, last_seen_at)?;
      emitted += 1;
    }
  }

  // Sequential pass: compress to sessions, count cross-app transitions
  #[derive(Clone)]
  struct Session { app: String, t_start: i64, t_end: i64 }
  let mut sessions: Vec<Session> = Vec::new();
  for cap in &captures {
    if let Some(last) = sessions.last_mut() {
      if last.app == cap.app_bundle_id {
        last.t_end = cap.captured_at;
        continue;
      }
    }
    sessions.push(Session { app: cap.app_bundle_id.clone(), t_start: cap.captured_at, t_end: cap.captured_at });
  }
  let mut transitions: HashMap<(String, String), HashSet<chrono::NaiveDate>> = HashMap::new();
  let mut prev_app_days: HashMap<String, HashSet<chrono::NaiveDate>> = HashMap::new();
  let mut s_first_last: HashMap<(String, String), (i64, i64)> = HashMap::new();
  for w in sessions.windows(2) {
    let prev = &w[0];
    let curr = &w[1];
    let prev_date = match Local.timestamp_millis_opt(prev.t_end).single() {
      Some(d) => d.date_naive(),
      None => continue,
    };
    prev_app_days.entry(prev.app.clone()).or_default().insert(prev_date);
    let gap_ms = curr.t_start - prev.t_end;
    if gap_ms <= 30 * 60 * 1000 && prev.app != curr.app {
      let key = (prev.app.clone(), curr.app.clone());
      transitions.entry(key.clone()).or_default().insert(prev_date);
      let entry = s_first_last.entry(key).or_insert((prev.t_end, prev.t_end));
      if prev.t_end < entry.0 { entry.0 = prev.t_end; }
      if prev.t_end > entry.1 { entry.1 = prev.t_end; }
    }
  }
  for ((prev, curr), trans_days) in transitions {
    let prev_total_days = prev_app_days.get(&prev).map(|s| s.len()).unwrap_or(0);
    if trans_days.len() >= 3 && prev_total_days >= 1 {
      let ratio = (trans_days.len() as f32) / (prev_total_days as f32);
      if ratio >= 0.30 {
        let observed_n = trans_days.len() as i64;
        let prev_label = friendly_app_name(&prev);
        let curr_label = friendly_app_name(&curr);
        let (first_seen_at, last_seen_at) = s_first_last.get(&(prev.clone(), curr.clone())).copied().unwrap_or((now_ms(), now_ms()));
        upsert_sequential(&conn, &prev, &prev_label, &curr, &curr_label, observed_n, first_seen_at, last_seen_at)?;
        emitted += 1;
      }
    }
  }

  mark_stale_sweep(&conn)?;

  // ---- Spatial pass (Sub-spec F) ----
  let spatial_rows: Vec<crate::spatial_patterns::SpatialCaptureRow> = captures
    .iter()
    .filter_map(|cap| {
      let raw = cap.spatial_context.as_deref()?;
      let ctx: Value = serde_json::from_str(raw).ok()?;
      Some(crate::spatial_patterns::SpatialCaptureRow {
        app_bundle_id: cap.app_bundle_id.clone(),
        captured_at: cap.captured_at,
        spatial_context: ctx,
      })
    })
    .collect();
  emitted += crate::spatial_patterns::detect_spatial(&conn, &spatial_rows)?;

  Ok(emitted)
}

pub fn list_for_brief(top_n: usize, include_spatial: bool) -> Result<Vec<Value>, String> {
  let conn = crate::memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      if include_spatial {
        "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' ORDER BY confidence DESC, observed_n DESC LIMIT ?1"
      } else {
        "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' AND kind != 'spatial' ORDER BY confidence DESC, observed_n DESC LIMIT ?1"
      },
    )
    .map_err(|e| format!("patterns::list_for_brief prepare: {}", e))?;
  let rows = stmt
    .query_map(params![top_n as i64], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, f32>(4)?, row.get::<_, i64>(5)?))
    })
    .map_err(|e| format!("patterns::list_for_brief query: {}", e))?;
  let mut out = Vec::new();
  for r in rows {
    let (id, kind, trigger_str, action_str, confidence, observed_n) = r.map_err(|e| format!("patterns::list_for_brief row: {}", e))?;
    let trigger: Value = serde_json::from_str(&trigger_str).unwrap_or(Value::Null);
    let action: Value = serde_json::from_str(&action_str).unwrap_or(Value::Null);
    let label = match kind.as_str() {
      "temporal" => {
        let hour = trigger.get("hour").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let dow = trigger.get("dow").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let app_label = action.get("label").and_then(|v| v.as_str()).unwrap_or("an app");
        format_temporal_label(hour, dow, app_label)
      }
      "sequential" => {
        let prev_label = trigger.get("prev_label").and_then(|v| v.as_str()).unwrap_or("an app");
        let action_label = action.get("label").and_then(|v| v.as_str()).unwrap_or("another app");
        format_sequential_label(prev_label, action_label)
      }
      "spatial" => {
        let display_label = trigger
          .get("display_label")
          .and_then(|v| v.as_str())
          .unwrap_or("a display");
        let quadrant = trigger
          .get("quadrant")
          .and_then(|v| v.as_str())
          .unwrap_or("");
        let app_label = action
          .get("label")
          .and_then(|v| v.as_str())
          .unwrap_or("an app");
        format!(
          "You usually keep {} in the {} quadrant of {}.",
          app_label, quadrant, display_label
        )
      }
      _ => "Unknown pattern.".to_string(),
    };
    out.push(json!({
      "id": id, "kind": kind, "label": label, "trigger": trigger, "action": action,
      "confidence": confidence, "observed_n": observed_n,
    }));
  }
  Ok(out)
}

pub fn list_active(limit: usize) -> Result<Vec<Pattern>, String> {
  let conn = crate::memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      "SELECT id, kind, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at, status FROM patterns WHERE status = 'active' ORDER BY last_seen_at DESC LIMIT ?1",
    )
    .map_err(|e| format!("patterns::list_active prepare: {}", e))?;
  let rows = stmt
    .query_map(params![limit as i64], |row| {
      let trigger_str: String = row.get(2)?;
      let action_str: String = row.get(3)?;
      Ok(Pattern {
        id: row.get(0)?,
        kind: row.get(1)?,
        trigger_json: serde_json::from_str(&trigger_str).unwrap_or(Value::Null),
        action_json: serde_json::from_str(&action_str).unwrap_or(Value::Null),
        confidence: row.get(4)?,
        observed_n: row.get(5)?,
        first_seen_at: row.get(6)?,
        last_seen_at: row.get(7)?,
        status: row.get(8)?,
      })
    })
    .map_err(|e| format!("patterns::list_active query: {}", e))?;
  let mut out = Vec::new();
  for r in rows {
    out.push(r.map_err(|e| format!("patterns::list_active row: {}", e))?);
  }
  Ok(out)
}

pub fn invalidate(id: &str) -> Result<(), String> {
  let conn = crate::memory_store::open_conn()?;
  conn
    .execute("UPDATE patterns SET status = 'stale' WHERE id = ?1", params![id])
    .map_err(|e| format!("patterns::invalidate: {}", e))?;
  Ok(())
}
