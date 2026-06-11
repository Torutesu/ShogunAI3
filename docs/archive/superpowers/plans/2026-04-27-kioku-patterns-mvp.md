# KIOKU Patterns MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the KIOKU Patterns MVP loop: a daily background batch scans the last 14 days of `mem_captures`, detects temporal (`hour×dow×app`) and sequential (`prev_app→app within 30min`) patterns, UPSERTs them into a new `patterns` SQLite table, and surfaces the top-4 active patterns in the Morning Brief as a "YOUR USUAL" section.

**Architecture:** A new `patterns.rs` module owns the `patterns` table (CRUD + run_detection orchestration) and the detection helpers. A new `patterns_sync.rs` module owns the daily background scheduler, modeled after `rollup_sync.rs`. `brief.rs` gains a small `patterns` field built via `patterns::list_for_brief`. Frontend renders a single "YOUR USUAL" card on the Home Morning Brief. One new manual-trigger Tauri command for debug/Settings UI.

**Tech Stack:** Rust (rusqlite, tokio, chrono::Local, serde_json, uuid::Uuid), React 19 (in-browser babel), existing IPC plumbing pattern.

**Spec:** `docs/superpowers/specs/2026-04-27-kioku-patterns-mvp-design.md`

---

## File Map

**Created:**
- `src-tauri/src/patterns.rs` (~250 lines) — schema-aligned types, run_detection, list_for_brief, friendly_app_name, dow_label, formatters.
- `src-tauri/src/patterns_sync.rs` (~80 lines) — spawn_background_patterns_sync, snapshot_state, settings gate.

**Modified:**
- `src-tauri/src/kioku_graph_schema.rs` — patterns CREATE TABLE + 3 indexes.
- `src-tauri/src/lib.rs` — `mod patterns; mod patterns_sync;` + setup spawn call + 1 invoke_handler entry.
- `src-tauri/src/commands.rs` — `shogun_patterns_run_now` (~15 lines).
- `src-tauri/src/brief.rs` — add `patterns` field to v2 brief output.
- `hifi/lib/shogun-api.js` — `patternsRunNow` binding.
- `hifi/lib/action-registry.js` — `patterns.run_now` register.
- `hifi/action-map.md` — `patterns.run_now` entry.
- `hifi/screens-a.jsx` — "YOUR USUAL" section render.

**No tests in scope** (per spec § 7 — manual eye-test only). Verification = `npm run check:rust` + `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual UI walkthrough with optional synthetic capture seed.

---

## Task 1: Schema migration — `patterns` table

**Files:**
- Modify: `src-tauri/src/kioku_graph_schema.rs` — `ensure_phase2_tables` and `ensure_phase2_indexes`

- [ ] **Step 1: Add `patterns` CREATE TABLE inside `ensure_phase2_tables`**

Locate the closing `"#,` of the raw string in `ensure_phase2_tables` (the same anchor used by the lessons table commit). The lessons table is now at the bottom; insert patterns right after it, BEFORE the closing `"#,`.

Use Edit. `old_string`:

```
      CREATE TABLE IF NOT EXISTS lessons (
        id              TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        trigger_context TEXT NOT NULL,
        attempted       TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        rule            TEXT NOT NULL,
        scope           TEXT NOT NULL DEFAULT 'user',
        source          TEXT NOT NULL,
        embedding       BLOB,
        embedding_dim   INTEGER,
        created_at      INTEGER NOT NULL,
        applies_n       INTEGER NOT NULL DEFAULT 0,
        prevented_n     INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active'
      );
      "#,
    )
    .map_err(|e| format!("ensure_phase2_tables: {}", e))
}
```

`new_string`:

```
      CREATE TABLE IF NOT EXISTS lessons (
        id              TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        trigger_context TEXT NOT NULL,
        attempted       TEXT NOT NULL,
        outcome         TEXT NOT NULL,
        rule            TEXT NOT NULL,
        scope           TEXT NOT NULL DEFAULT 'user',
        source          TEXT NOT NULL,
        embedding       BLOB,
        embedding_dim   INTEGER,
        created_at      INTEGER NOT NULL,
        applies_n       INTEGER NOT NULL DEFAULT 0,
        prevented_n     INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE IF NOT EXISTS patterns (
        id              TEXT PRIMARY KEY,
        kind            TEXT NOT NULL,
        trigger_json    TEXT NOT NULL,
        action_json     TEXT NOT NULL,
        outcome_json    TEXT,
        confidence      REAL NOT NULL,
        observed_n      INTEGER NOT NULL,
        first_seen_at   INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        embedding       BLOB,
        embedding_dim   INTEGER,
        status          TEXT NOT NULL DEFAULT 'active'
      );
      "#,
    )
    .map_err(|e| format!("ensure_phase2_tables: {}", e))
}
```

If the lessons table block has shifted (e.g. someone reformatted), use a smaller anchor: the closing `"#,` of the raw string PLUS `.map_err(|e| format!("ensure_phase2_tables: {}", e))`. Insert the `CREATE TABLE patterns` block before that closing `"#,`.

- [ ] **Step 2: Add patterns indexes inside `ensure_phase2_indexes`**

Locate the existing lessons index group at the bottom of `ensure_phase2_indexes`. Use Edit. `old_string`:

```
      -- lessons
      CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
      CREATE INDEX IF NOT EXISTS idx_lessons_active   ON lessons(status);
      CREATE INDEX IF NOT EXISTS idx_lessons_created  ON lessons(created_at);
      "#,
    )
    .map_err(|e| format!("ensure_phase2_indexes: {}", e))
}
```

`new_string`:

```
      -- lessons
      CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
      CREATE INDEX IF NOT EXISTS idx_lessons_active   ON lessons(status);
      CREATE INDEX IF NOT EXISTS idx_lessons_created  ON lessons(created_at);

      -- patterns
      CREATE INDEX IF NOT EXISTS idx_patterns_kind      ON patterns(kind);
      CREATE INDEX IF NOT EXISTS idx_patterns_active    ON patterns(status);
      CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON patterns(last_seen_at);
      "#,
    )
    .map_err(|e| format!("ensure_phase2_indexes: {}", e))
}
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS, no new errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/kioku_graph_schema.rs
git diff --cached --stat
git commit -m "feat(kioku): add patterns table + indexes to Phase 2 schema"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file: `src-tauri/src/kioku_graph_schema.rs`. Otherwise REVERT and report BLOCKED.

---

## Task 2: `patterns.rs` module — types + CRUD + detection

**Files:**
- Create: `src-tauri/src/patterns.rs`
- Modify: `src-tauri/src/lib.rs` — `mod patterns;` declaration

This is the largest task in the plan (~250 lines of new Rust). The full file content is below — it bundles all the helpers (friendly_app_name, dow_label, formatters), the upsert primitives (upsert_temporal, upsert_sequential), the stale sweep, and the orchestrator (run_detection + list_for_brief).

- [ ] **Step 1: Create `src-tauri/src/patterns.rs`**

Write this entire file:

```rust
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

fn friendly_app_name(bundle: &str) -> String {
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
  format!(
    "You usually open {} around {:02}:00 {}.",
    app_label,
    hour,
    dow_label(dow)
  )
}

fn format_sequential_label(prev_label: &str, action_label: &str) -> String {
  format!(
    "After {}, you often switch to {} within 30 min.",
    prev_label, action_label
  )
}

#[derive(Debug, Clone)]
struct CaptureRow {
  app_bundle_id: String,
  captured_at: i64,
}

fn fetch_recent_captures(conn: &Connection, since_ms: i64) -> Result<Vec<CaptureRow>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT app_bundle_id, captured_at
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
  conn: &Connection,
  hour: u8,
  dow: u8,
  app_bundle: &str,
  app_label: &str,
  observed_n: i64,
  first_seen_at: i64,
  last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({"hour": hour, "dow": dow}).to_string();
  let action_json = json!({"app": app_bundle, "label": app_label}).to_string();

  // Identity-key SELECT first
  let existing: Option<String> = conn
    .query_row(
      r#"
      SELECT id FROM patterns
      WHERE kind = 'temporal'
        AND trigger_json = ?1
        AND action_json = ?2
      LIMIT 1
      "#,
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("patterns::upsert_temporal select: {}", e))?;

  if let Some(id) = existing {
    conn
      .execute(
        r#"
        UPDATE patterns
        SET observed_n = ?1, confidence = ?2, last_seen_at = ?3, status = 'active'
        WHERE id = ?4
        "#,
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("patterns::upsert_temporal update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        r#"
        INSERT INTO patterns (
          id, kind, trigger_json, action_json, confidence, observed_n,
          first_seen_at, last_seen_at, status
        )
        VALUES (?1, 'temporal', ?2, ?3, ?4, ?5, ?6, ?7, 'active')
        "#,
        params![
          id,
          trigger_json,
          action_json,
          confidence,
          observed_n,
          first_seen_at,
          last_seen_at,
        ],
      )
      .map_err(|e| format!("patterns::upsert_temporal insert: {}", e))?;
  }
  Ok(())
}

fn upsert_sequential(
  conn: &Connection,
  prev_app: &str,
  prev_label: &str,
  app_bundle: &str,
  app_label: &str,
  observed_n: i64,
  first_seen_at: i64,
  last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({"prev_app": prev_app, "prev_label": prev_label}).to_string();
  let action_json = json!({"app": app_bundle, "label": app_label}).to_string();

  let existing: Option<String> = conn
    .query_row(
      r#"
      SELECT id FROM patterns
      WHERE kind = 'sequential'
        AND trigger_json = ?1
        AND action_json = ?2
      LIMIT 1
      "#,
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("patterns::upsert_sequential select: {}", e))?;

  if let Some(id) = existing {
    conn
      .execute(
        r#"
        UPDATE patterns
        SET observed_n = ?1, confidence = ?2, last_seen_at = ?3, status = 'active'
        WHERE id = ?4
        "#,
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("patterns::upsert_sequential update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        r#"
        INSERT INTO patterns (
          id, kind, trigger_json, action_json, confidence, observed_n,
          first_seen_at, last_seen_at, status
        )
        VALUES (?1, 'sequential', ?2, ?3, ?4, ?5, ?6, ?7, 'active')
        "#,
        params![
          id,
          trigger_json,
          action_json,
          confidence,
          observed_n,
          first_seen_at,
          last_seen_at,
        ],
      )
      .map_err(|e| format!("patterns::upsert_sequential insert: {}", e))?;
  }
  Ok(())
}

fn mark_stale_sweep(conn: &Connection) -> Result<(), String> {
  let now = now_ms();
  let cutoff_30d = now - (30 * 24 * 60 * 60 * 1000);
  let cutoff_60d = now - (60 * 24 * 60 * 60 * 1000);

  // Cohort 1: observed_n < 10 → stale at 30 days
  conn
    .execute(
      r#"
      UPDATE patterns
      SET status = 'stale'
      WHERE status = 'active' AND observed_n < 10 AND last_seen_at < ?1
      "#,
      params![cutoff_30d],
    )
    .map_err(|e| format!("patterns::mark_stale_sweep <10: {}", e))?;

  // Cohort 2: observed_n >= 10 → stale at 60 days
  conn
    .execute(
      r#"
      UPDATE patterns
      SET status = 'stale'
      WHERE status = 'active' AND observed_n >= 10 AND last_seen_at < ?1
      "#,
      params![cutoff_60d],
    )
    .map_err(|e| format!("patterns::mark_stale_sweep >=10: {}", e))?;

  Ok(())
}

/// Run the daily detection batch. Returns the count of UPSERTed
/// active patterns (across both kinds).
pub async fn run_detection() -> Result<usize, String> {
  let conn = crate::memory_store::open_conn()?;
  let since_ms = now_ms() - (14 * 24 * 60 * 60 * 1000);
  let captures = fetch_recent_captures(&conn, since_ms)?;
  if captures.is_empty() {
    return Ok(0);
  }

  let mut emitted = 0usize;

  // ---- Temporal pass ----
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
    let entry = t_first_last
      .entry(key)
      .or_insert((cap.captured_at, cap.captured_at));
    if cap.captured_at < entry.0 {
      entry.0 = cap.captured_at;
    }
    if cap.captured_at > entry.1 {
      entry.1 = cap.captured_at;
    }
  }
  for ((hour, dow, app), days) in t_buckets {
    if days.len() >= 3 {
      let observed_n = days.len() as i64;
      let label = friendly_app_name(&app);
      let (first_seen_at, last_seen_at) = t_first_last
        .get(&(hour, dow, app.clone()))
        .copied()
        .unwrap_or((now_ms(), now_ms()));
      upsert_temporal(
        &conn,
        hour,
        dow,
        &app,
        &label,
        observed_n,
        first_seen_at,
        last_seen_at,
      )?;
      emitted += 1;
    }
  }

  // ---- Sequential pass ----
  // Step 1: compress to app sessions.
  #[derive(Clone)]
  struct Session {
    app: String,
    t_start: i64,
    t_end: i64,
  }
  let mut sessions: Vec<Session> = Vec::new();
  for cap in &captures {
    if let Some(last) = sessions.last_mut() {
      if last.app == cap.app_bundle_id {
        last.t_end = cap.captured_at;
        continue;
      }
    }
    sessions.push(Session {
      app: cap.app_bundle_id.clone(),
      t_start: cap.captured_at,
      t_end: cap.captured_at,
    });
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
    prev_app_days
      .entry(prev.app.clone())
      .or_default()
      .insert(prev_date);
    let gap_ms = curr.t_start - prev.t_end;
    if gap_ms <= 30 * 60 * 1000 && prev.app != curr.app {
      let key = (prev.app.clone(), curr.app.clone());
      transitions.entry(key.clone()).or_default().insert(prev_date);
      let entry = s_first_last
        .entry(key)
        .or_insert((prev.t_end, prev.t_end));
      if prev.t_end < entry.0 {
        entry.0 = prev.t_end;
      }
      if prev.t_end > entry.1 {
        entry.1 = prev.t_end;
      }
    }
  }
  for ((prev, curr), trans_days) in transitions {
    let prev_total_days = prev_app_days
      .get(&prev)
      .map(|s| s.len())
      .unwrap_or(0);
    if trans_days.len() >= 3 && prev_total_days >= 1 {
      let ratio = (trans_days.len() as f32) / (prev_total_days as f32);
      if ratio >= 0.30 {
        let observed_n = trans_days.len() as i64;
        let prev_label = friendly_app_name(&prev);
        let curr_label = friendly_app_name(&curr);
        let (first_seen_at, last_seen_at) = s_first_last
          .get(&(prev.clone(), curr.clone()))
          .copied()
          .unwrap_or((now_ms(), now_ms()));
        upsert_sequential(
          &conn,
          &prev,
          &prev_label,
          &curr,
          &curr_label,
          observed_n,
          first_seen_at,
          last_seen_at,
        )?;
        emitted += 1;
      }
    }
  }

  // ---- Stale sweep ----
  mark_stale_sweep(&conn)?;

  Ok(emitted)
}

/// Top-N active patterns ordered by confidence, formatted for the
/// Morning Brief consumer. Each entry is a JSON value with kind,
/// label, trigger, action, confidence, observed_n.
pub fn list_for_brief(top_n: usize) -> Result<Vec<Value>, String> {
  let conn = crate::memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      r#"
      SELECT kind, trigger_json, action_json, confidence, observed_n
      FROM patterns
      WHERE status = 'active'
      ORDER BY confidence DESC, observed_n DESC
      LIMIT ?1
      "#,
    )
    .map_err(|e| format!("patterns::list_for_brief prepare: {}", e))?;
  let rows = stmt
    .query_map(params![top_n as i64], |row| {
      let kind: String = row.get(0)?;
      let trigger_str: String = row.get(1)?;
      let action_str: String = row.get(2)?;
      let confidence: f32 = row.get(3)?;
      let observed_n: i64 = row.get(4)?;
      Ok((kind, trigger_str, action_str, confidence, observed_n))
    })
    .map_err(|e| format!("patterns::list_for_brief query: {}", e))?;

  let mut out = Vec::new();
  for r in rows {
    let (kind, trigger_str, action_str, confidence, observed_n) =
      r.map_err(|e| format!("patterns::list_for_brief row: {}", e))?;
    let trigger: Value = serde_json::from_str(&trigger_str).unwrap_or(Value::Null);
    let action: Value = serde_json::from_str(&action_str).unwrap_or(Value::Null);
    let label = match kind.as_str() {
      "temporal" => {
        let hour = trigger.get("hour").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let dow = trigger.get("dow").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let app_label = action
          .get("label")
          .and_then(|v| v.as_str())
          .unwrap_or("an app");
        format_temporal_label(hour, dow, app_label)
      }
      "sequential" => {
        let prev_label = trigger
          .get("prev_label")
          .and_then(|v| v.as_str())
          .unwrap_or("an app");
        let action_label = action
          .get("label")
          .and_then(|v| v.as_str())
          .unwrap_or("another app");
        format_sequential_label(prev_label, action_label)
      }
      _ => "Unknown pattern.".to_string(),
    };
    out.push(json!({
      "kind": kind,
      "label": label,
      "trigger": trigger,
      "action": action,
      "confidence": confidence,
      "observed_n": observed_n,
    }));
  }
  Ok(out)
}

/// Sub-spec C will use this for the Settings UI list view.
pub fn list_active(limit: usize) -> Result<Vec<Pattern>, String> {
  let conn = crate::memory_store::open_conn()?;
  let mut stmt = conn
    .prepare(
      r#"
      SELECT id, kind, trigger_json, action_json, confidence, observed_n,
             first_seen_at, last_seen_at, status
      FROM patterns
      WHERE status = 'active'
      ORDER BY last_seen_at DESC
      LIMIT ?1
      "#,
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

/// Sub-spec C will use this for "this isn't right" → invalidate.
pub fn invalidate(id: &str) -> Result<(), String> {
  let conn = crate::memory_store::open_conn()?;
  conn
    .execute(
      "UPDATE patterns SET status = 'stale' WHERE id = ?1",
      params![id],
    )
    .map_err(|e| format!("patterns::invalidate: {}", e))?;
  Ok(())
}
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`**

Find the existing `mod lessons;` line (added in Sub-spec A). Use Edit. `old_string`:

```
mod lessons;
```

`new_string`:

```
mod lessons;
mod patterns;
```

(Order doesn't strictly matter; alphabetical-ish keeps things tidy.)

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -20
```

Expected: PASS. Several `warning: function ... is never used` warnings on the new public functions (`run_detection`, `list_for_brief`, `list_active`, `invalidate`) are EXPECTED at this stage — they'll be consumed by Tasks 3-7.

If you see hard errors, STOP and report BLOCKED. Common issue: `chrono` import paths — the module uses `chrono::Local`, `Datelike`, `TimeZone`, `Timelike` which should all resolve via the `chrono` crate already in Cargo.toml.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/patterns.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): patterns.rs — types + detection + UPSERT + stale sweep"
git show HEAD --stat
```

Must show exactly 2 files. Otherwise REVERT.

---

## Task 3: `patterns_sync.rs` background scheduler

**Files:**
- Create: `src-tauri/src/patterns_sync.rs`
- Modify: `src-tauri/src/lib.rs` — `mod patterns_sync;` + setup spawn call

- [ ] **Step 1: Create `src-tauri/src/patterns_sync.rs`**

Write this entire file (~80 lines):

```rust
//! Patterns daily background sync (KIOKU Sub-spec B). Modeled after
//! `rollup_sync.rs`. Wakes every 30 min, runs detection if 24h+ has
//! elapsed since the last successful run.

use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct PatternsSyncState {
  pub last_run_ms: Option<i64>,
  pub last_error: Option<String>,
  pub last_emitted_count: usize,
}

static STATE: Mutex<PatternsSyncState> = Mutex::new(PatternsSyncState {
  last_run_ms: None,
  last_error: None,
  last_emitted_count: 0,
});

pub fn snapshot_state() -> PatternsSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn patterns_enabled() -> bool {
  crate::settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/kioku_graph/patterns_enabled")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true) // default ON
}

fn should_run() -> bool {
  let last = STATE.lock().ok().and_then(|s| s.last_run_ms);
  let now = crate::memory_store::now_ms() as i64;
  match last {
    None => true,
    Some(t) => (now - t) >= 24 * 60 * 60 * 1000,
  }
}

pub fn spawn_background_patterns_sync() {
  tokio::spawn(async move {
    // Cold-start delay so app boot isn't competing with detection.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
      if patterns_enabled() && should_run() {
        match crate::patterns::run_detection().await {
          Ok(emitted) => {
            if let Ok(mut s) = STATE.lock() {
              s.last_run_ms = Some(crate::memory_store::now_ms() as i64);
              s.last_emitted_count = emitted;
              s.last_error = None;
            }
            crate::memory_obs::emit(
              "patterns_sync_done",
              &[("emitted", emitted.to_string())],
            );
          }
          Err(e) => {
            log::warn!("patterns_sync failed: {}", e);
            if let Ok(mut s) = STATE.lock() {
              s.last_error = Some(e.clone());
            }
            crate::memory_obs::emit("patterns_sync_error", &[("error", e)]);
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
    }
  });
}
```

- [ ] **Step 2: Register the module + add the spawn call in lib.rs**

Two edits in `src-tauri/src/lib.rs`:

(a) Add the mod declaration. Find:

```
mod patterns;
```

(added in Task 2). Use Edit. `old_string`:

```
mod patterns;
```

`new_string`:

```
mod patterns;
mod patterns_sync;
```

(b) Add the setup spawn call. Find the existing `rollup_sync::spawn_background_rollup_sync();` line in the `setup()` block. Use Edit. `old_string`:

```
      rollup_sync::spawn_background_rollup_sync();
```

`new_string`:

```
      rollup_sync::spawn_background_rollup_sync();
      patterns_sync::spawn_background_patterns_sync();
```

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `run_detection` warning from Task 2 should now be gone (consumed here).

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/patterns_sync.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): patterns_sync background scheduler — daily 24h gate"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 4: Manual trigger Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs` — add `shogun_patterns_run_now`
- Modify: `src-tauri/src/lib.rs` — register in invoke_handler

- [ ] **Step 1: Add the command to `commands.rs`**

Find a stable insertion anchor — the end of `shogun_lesson_capture_tool_failure` (added in Sub-spec A's Task 4) is a fine place. Append AFTER its closing `}`:

```rust

/// Manually trigger Patterns detection (KIOKU Sub-spec B). Useful for
/// the Settings UI / Memory DBG hooks. Daily background sync covers
/// the production cadence.
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}
```

(Use Edit with the closing of `shogun_lesson_capture_tool_failure` as anchor. The cleanest is the line `Ok(serde_json::json!({ "id": id, "deduped": false, "rule": rule }))` plus the next line `}` — that 2-line block is unique enough.)

- [ ] **Step 2: Register in `lib.rs` invoke_handler**

Find the line `commands::shogun_lesson_capture_tool_failure,` (added in Sub-spec A). Use Edit. `old_string`:

```
      commands::shogun_lesson_capture_tool_failure,
```

`new_string`:

```
      commands::shogun_lesson_capture_tool_failure,
      commands::shogun_patterns_run_now,
```

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): shogun_patterns_run_now manual trigger command"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 5: Wire patterns into Morning Brief

**Files:**
- Modify: `src-tauri/src/brief.rs` — add `patterns` field to v2 brief

- [ ] **Step 1: Locate the v2 brief builder**

```bash
grep -n "morning_brief_v2_stub\|\"items\":" src-tauri/src/brief.rs | head -10
```

Read enough of `morning_brief_v2_stub` (around line 109+) to see the existing `json!({...})` body that returns the brief. The function builds an `out: Value` and returns it.

- [ ] **Step 2: Add the patterns field**

Find the line in `morning_brief_v2_stub` that opens the main `let mut out = json!({` block (around line 133). Read down to its closing `});` to see the field list.

The cleanest insertion is to compute `patterns_for_brief` BEFORE the `json!` macro, then either:
- (a) Insert `"patterns": patterns_for_brief,` inside the `json!({})` body, OR
- (b) After the `let mut out = json!({...});` block, mutate `out["patterns"] = patterns_for_brief.into();`

Approach (b) is less risky (no need to find the exact comma/brace placement inside the macro). Use Edit.

Find the closing `});` of the `let mut out = json!({...});` block in `morning_brief_v2_stub`. Read 5 lines around it to confirm the exact closing punctuation.

Use Edit. `old_string` (the closing of the `let mut out = json!` block — pick a unique 3-line anchor; the exact closing `});` plus the next 2 lines should be unique):

For example, if the block ends like:

```
    "items": [
      ...
    ]
  });
  out
}
```

Then the anchor is the closing `});` plus `  out` + `}`. Adapt to actual structure.

Replace with the same anchor PLUS the patterns insertion BEFORE `out`:

```
    "items": [
      ...
    ]
  });
  let patterns_for_brief = crate::patterns::list_for_brief(4).unwrap_or_default();
  if !patterns_for_brief.is_empty() {
    out["patterns"] = serde_json::Value::Array(patterns_for_brief);
  }
  out
}
```

If you can't safely identify the closing `});` by anchor, use a different strategy: `grep -n` to find `out` returned bare (likely just before `}` ending the function), then read 10 lines around it to find the right insertion point.

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `list_for_brief` warning from Task 2 should now be gone.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/brief.rs
git diff --cached --stat
git commit -m "feat(kioku): inject Patterns into Morning Brief v2 output"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 6: Frontend IPC plumbing for `patterns.run_now`

**Files:**
- Modify: `hifi/lib/shogun-api.js`
- Modify: `hifi/lib/action-registry.js`
- Modify: `hifi/action-map.md`

- [ ] **Step 1: Add API binding in `hifi/lib/shogun-api.js`**

Find existing `lessonCaptureToolFailure` line (added in Sub-spec A's Task 6). Use Edit. `old_string`:

```
      lessonCaptureToolFailure: (input) => call("shogun_lesson_capture_tool_failure", input, WRITE),
```

`new_string`:

```
      lessonCaptureToolFailure: (input) => call("shogun_lesson_capture_tool_failure", input, WRITE),
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
```

- [ ] **Step 2: Register action in `hifi/lib/action-registry.js`**

Find the `lesson.capture.tool_failure` register call. Use Edit. `old_string`:

```
    register("lesson.capture.tool_failure", (payload) => api.lessonCaptureToolFailure(payload));
```

`new_string`:

```
    register("lesson.capture.tool_failure", (payload) => api.lessonCaptureToolFailure(payload));
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
```

- [ ] **Step 3: Add to `hifi/action-map.md`**

Find the `lesson.capture.tool_failure` entry. Use Edit. `old_string`:

```
- `lesson.capture.tool_failure`
```

`new_string`:

```
- `lesson.capture.tool_failure`
- `patterns.run_now`
```

- [ ] **Step 4: Verify**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS
- `check-actions.py`: PASS — `patterns.run_now` should NOT appear in the missing list

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git diff --cached --stat
git commit -m "feat(kioku): wire patterns.run_now IPC action"
git show HEAD --stat
```

Must show exactly 3 files.

---

## Task 7: Render "YOUR USUAL" section on Home

**Files:**
- Modify: `hifi/screens-a.jsx`

- [ ] **Step 1: Locate the Morning Brief render block**

```bash
grep -n "morningBrief\|setMorningBrief" hifi/screens-a.jsx | head -10
```

Around line 369: `const [morningBrief, setMorningBrief] = useState(null);`. Around line 555: `setMorningBrief(inner.brief);` (where the brief is fetched and stored).

The brief render JSX lives elsewhere in the file — find a section that reads `morningBrief?.items` or `morningBrief?.summary` to identify where the brief content is rendered. Read 30 lines around it to find the right place to add a new section AFTER existing items.

```bash
grep -n "morningBrief\?.items\|morningBrief\?\\.summary\|YOUR USUAL" hifi/screens-a.jsx | head -10
```

If `YOUR USUAL` already appears, abort and report — the section was already added (this would mean a partial rerun).

- [ ] **Step 2: Add the YOUR USUAL section**

Insert this JSX block IMMEDIATELY AFTER the existing brief items render block, BEFORE any container closing div (look for the parent `</div>` or fragment close that wraps the brief content):

```jsx
{Array.isArray(morningBrief?.patterns) && morningBrief.patterns.length > 0 && (
  <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginTop:'var(--space-4)'}}>
    <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>
      YOUR USUAL
    </div>
    <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
      {morningBrief.patterns.slice(0, 4).map((p, i) => (
        <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
          • <span style={{color:'var(--text)'}}>{p.label}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

Use Edit. The `old_string` should be the END of the existing brief items render — pick a unique 3-5 line anchor that captures the closing of the items map and the next thing after it. Then the `new_string` is the anchor plus the YOUR USUAL block inserted between.

If the brief items render ends with something like:

```jsx
        ))}
      </div>
    </div>
  )}
```

…use that as the anchor and insert the new block after the matching closing.

If you can't safely identify the right anchor in 10 minutes of reading, STOP and report NEEDS_CONTEXT with:
- The line numbers around `morningBrief?.items` rendering
- A snippet of 30 lines showing the surrounding container

- [ ] **Step 3: Manual smoke test**

The Tauri app should already be running. Refresh with Cmd+R.

If patterns table is empty (no synthetic seed yet, fewer than 14 days of mem_captures, etc.), the YOUR USUAL section should NOT appear (the Array.isArray check filters it out). That's the correct empty-state.

To force-test: open DevTools console and run:

```js
await window.SHOGUN_RUNTIME?.runAction?.('patterns.run_now', {})
```

Then refresh. If your `mem_captures` has data spanning 3+ distinct days with the same (hour, dow, app), you should see the YOUR USUAL section appear with up to 4 bullets.

If the section appears with bullets, success. If it appears empty (no bullets), the `morningBrief.patterns` data shape is wrong — STOP and report.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-a.jsx
git diff --cached --stat
git commit -m "feat(kioku): render YOUR USUAL section on Home Morning Brief"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 8: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All should PASS. Pre-existing warnings allowed.

- [ ] **Step 2: Spec § 7 manual run-through**

Walk through every numbered item in spec § 7:

1. Refresh Tauri. Wait for `patterns_sync_done` log entry in `/tmp/shogun3-app.log` (or trigger manually via DevTools `runAction('patterns.run_now')`). Cold start has a 60s warmup; the first run can take ~1 min after boot.
2. Inspect the patterns table:
   ```bash
   sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
     "SELECT kind, substr(action_json,1,80), confidence, observed_n FROM patterns WHERE status='active' ORDER BY confidence DESC LIMIT 10;"
   ```
   Expect 0+ rows depending on real `mem_captures` history.
3. Open Home → if patterns rows exist, YOUR USUAL section should render at the bottom of the Morning Brief.
4. Manual trigger via DevTools:
   ```js
   await window.SHOGUN_RUNTIME?.runAction?.('patterns.run_now', {})
   // → returns { ok: true, data: { emitted: N } }
   ```

- [ ] **Step 3: Synthetic capture seed (if no real data)**

If `patterns` table is empty after running `run_now`, seed synthetic captures via SQL:

```bash
DB=~/Library/Application\ Support/ai.shogun.desktop/memory.db
sqlite3 "$DB" <<'SQL'
INSERT INTO mem_captures (type, app_bundle_id, captured_at, ttl_expires_at)
WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n<7)
SELECT
  'app',
  'com.tinyspeck.slackmacgap',
  ((unixepoch() - (n*86400)) * 1000 + (9*3600*1000)),
  ((unixepoch() + (90*86400)) * 1000)
FROM cnt;
SQL
```

This inserts 7 synthetic 9:00am Slack events on the past 7 days. Then re-run `patterns.run_now` and verify a temporal pattern appears: `"You usually open Slack around 09:00 on Mondays."` (or whichever weekday today is — the specific dow value depends on the seeded date).

After verifying, optionally clean up the synthetic rows:
```bash
sqlite3 "$DB" "DELETE FROM mem_captures WHERE app_bundle_id = 'com.tinyspeck.slackmacgap' AND raw_path IS NULL AND raw_text IS NULL;"
```

(Adjust the WHERE clause to match exactly what was inserted; the synthetic rows have NULL raw_path/raw_text which distinguishes them.)

- [ ] **Step 4: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*pattern|FIXME.*pattern" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits.

- [ ] **Step 5: No commit (verification only)**

If all steps pass, the Patterns MVP is complete. Report DONE with the SHA range from Tasks 1-7 (`git log --oneline HEAD~7..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
