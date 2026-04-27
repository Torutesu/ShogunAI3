# KIOKU Lessons MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Lessons MVP loop: capture rejected chat replies and Run-now tool failures into a SQLite `lessons` table with LLM-generated rule text + embeddings, then inject the top-K relevant rules into every `shogun_chat_complete` system prompt.

**Architecture:** A new `lessons.rs` module owns the `lessons` table (CRUD + cosine similarity search), reusing the same `rusqlite::Connection` pattern as the rest of the KIOKU graph code. Two new Tauri commands wrap the capture paths (rejection from chat UI; tool_failure from `runAgentNow` failure branch). `llm::chat_complete` gains a single hook that calls `lessons::retrieve_for_chat`, appends the result as a leading system message in the message array, and bumps `applies_n` after a successful Anthropic response. Silent fallback throughout.

**Tech Stack:** Rust (rusqlite, serde_json, anthropic via existing `llm::anthropic_tool_complete`, embeddings via existing `embeddings::embed_one`, uuid::Uuid), React 19 (in-browser babel), existing IPC plumbing pattern.

**Spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-mvp-design.md`

---

## File Map

**Created:**
- `src-tauri/src/lessons.rs` (~250 lines) — schema-aligned types + CRUD + cosine search.

**Modified:**
- `src-tauri/src/kioku_graph_schema.rs` — add lessons CREATE TABLE + indexes inside `ensure_phase2_tables` and `ensure_phase2_indexes`.
- `src-tauri/src/lib.rs` — `mod lessons;` + 2 new Tauri command registrations.
- `src-tauri/src/commands.rs` — 2 new Tauri commands (`shogun_lesson_capture_rejection`, `shogun_lesson_capture_tool_failure`).
- `src-tauri/src/llm.rs` — `chat_complete` gains a Lessons retrieve hook and post-success applies_n increment.
- `hifi/lib/shogun-api.js` — 2 new method bindings.
- `hifi/lib/action-registry.js` — 2 new register calls.
- `hifi/action-map.md` — 2 new entries.
- `hifi/app.jsx` — Bad response button onClick.
- `hifi/screens-agents.jsx` — runAgentNow else-branch tool_failure capture.

**No tests in scope** (per spec § 8 — manual eye-test only). Verification = `npm run check:rust` + `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual UI walkthrough.

---

## Task 1: Schema migration — `lessons` table

**Files:**
- Modify: `src-tauri/src/kioku_graph_schema.rs` — `ensure_phase2_tables` (around line 77) and `ensure_phase2_indexes` (around line 156)

- [ ] **Step 1: Add `lessons` CREATE TABLE inside `ensure_phase2_tables`**

Locate the function `fn ensure_phase2_tables(conn: &Connection) -> Result<(), String>` (around line 77). Inside its `execute_batch` raw string, find the closing comment / last CREATE TABLE for `cost_ledger` (around line 140-155). Insert a new CREATE TABLE block IMMEDIATELY BEFORE the closing `"#,` of the raw string:

```sql
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
```

- [ ] **Step 2: Add lessons indexes inside `ensure_phase2_indexes`**

Locate `fn ensure_phase2_indexes(conn: &Connection)` (around line 156). Inside its `execute_batch` raw string, immediately BEFORE the closing `"#,`, insert:

```sql
      -- lessons
      CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
      CREATE INDEX IF NOT EXISTS idx_lessons_active   ON lessons(status);
      CREATE INDEX IF NOT EXISTS idx_lessons_created  ON lessons(created_at);
```

- [ ] **Step 3: Verify rust compiles**

Run from repo root:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS, no new errors. Existing warnings are fine.

If you see an error like "syntax error near 'lessons'" or "near ';'", you've placed the SQL outside the raw string boundary — re-check the closing `"#,`.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/kioku_graph_schema.rs
git diff --cached --stat
git commit -m "feat(kioku): add lessons table + indexes to Phase 2 schema"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file: `src-tauri/src/kioku_graph_schema.rs`. Otherwise REVERT and report BLOCKED.

---

## Task 2: `lessons.rs` module

**Files:**
- Create: `src-tauri/src/lessons.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod lessons;` declaration

- [ ] **Step 1: Create `src-tauri/src/lessons.rs`**

Write the entire file (~250 lines) with this content:

```rust
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

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
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
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`**

Find the existing line `mod kioku_capture;` (around line 40 of lib.rs). IMMEDIATELY AFTER it, add `mod lessons;`. Final order doesn't strictly matter — alphabetical-ish is fine.

Use Edit with `old_string` of `mod kioku_capture;` (single line) replaced by `mod kioku_capture;\nmod lessons;`. (Add a newline.)

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -15
```

Expected: PASS. New warnings about unused public functions (`insert_lesson`, `search_by_similarity`, `increment_applies`, `list_active`, `archive`, `recent_match`, `retrieve_for_chat`) are EXPECTED at this stage — they'll be consumed by Tasks 3-5.

If you see a hard error (e.g., "Uuid not in scope" — the `uuid` crate may not be in Cargo.toml yet), fix before continuing. Add to `[dependencies]`:

```toml
uuid = { version = "1", features = ["v4"] }
```

…then re-run check:rust.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/lessons.rs src-tauri/src/lib.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git diff --cached --stat
git commit -m "feat(kioku): lessons.rs — types + CRUD + cosine similarity + retrieve_for_chat"
git show HEAD --stat
```

The commit may include `Cargo.toml` and `Cargo.lock` if you had to add the `uuid` dep. Otherwise just the 2 files.

---

## Task 3: Tauri command — `shogun_lesson_capture_rejection`

**Files:**
- Modify: `src-tauri/src/commands.rs` — append new command (around the existing rollup commands, after line ~1900)
- Modify: `src-tauri/src/lib.rs` — register in `invoke_handler!`

- [ ] **Step 1: Add the command to `commands.rs`**

Find a stable insertion anchor — the end of `shogun_memory_year_rollup_get` (added in earlier Memory rollup work) is a fine place. Append AFTER its closing `}` and the trailing blank line:

```rust
/// Capture a user-rejected chat reply as a Lesson. Frontend calls this from
/// the "Bad response" button click.
///
/// payload: { "userMsg": string, "assistantMsg": string, "chatId"?: string }
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
```

- [ ] **Step 2: Register the command in `lib.rs`**

Find the existing `commands::shogun_memory_year_rollup_get,` line in the `invoke_handler![…]` list. IMMEDIATELY AFTER it, add:

```rust
      commands::shogun_lesson_capture_rejection,
```

Use Edit. Old:
```
      commands::shogun_memory_year_rollup_get,
      commands::shogun_memory_summary_set_priority,
```

New:
```
      commands::shogun_memory_year_rollup_get,
      commands::shogun_lesson_capture_rejection,
      commands::shogun_memory_summary_set_priority,
```

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `lessons::insert_lesson` warning should be gone (now consumed). Other lessons module warnings (`search_by_similarity`, `increment_applies`, etc.) remain — Tasks 4-5 consume them.

If `chrono::Local` is not in scope: add `use chrono::TimeZone;` at the top of commands.rs OR rely on the existing chrono import (likely already there — search). If absent, add a use line.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): shogun_lesson_capture_rejection — LLM rule + embed + insert"
git show HEAD --stat
```

Must show exactly 2 files: `commands.rs` and `lib.rs`. If anything else, REVERT.

---

## Task 4: Tauri command — `shogun_lesson_capture_tool_failure`

**Files:**
- Modify: `src-tauri/src/commands.rs` — append after `shogun_lesson_capture_rejection`
- Modify: `src-tauri/src/lib.rs` — register in `invoke_handler!`

- [ ] **Step 1: Add the command to `commands.rs`**

Find the closing `}` of `shogun_lesson_capture_rejection` (added in Task 3). Immediately AFTER it, append:

```rust
/// Capture an agent Run-now tool failure as a Lesson. Frontend calls this from
/// the runAgentNow callback's failure branch in screens-agents.jsx.
///
/// payload: { "agentId": string, "agentName": string, "action": string, "payload": object, "errorMessage": string }
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
```

- [ ] **Step 2: Register in `lib.rs`**

Find the line `commands::shogun_lesson_capture_rejection,` (added in Task 3). Immediately AFTER it, add:

```rust
      commands::shogun_lesson_capture_tool_failure,
```

- [ ] **Step 3: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. `lessons::recent_match` warning should be gone (now consumed).

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): shogun_lesson_capture_tool_failure — dedupe + LLM rule + insert"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 5: Inject lessons into `llm::chat_complete`

**Files:**
- Modify: `src-tauri/src/llm.rs` — `chat_complete` (around line 78-)

- [ ] **Step 1: Locate the user-message extraction site**

In `llm::chat_complete`, the messages array is built starting around line 114. The user's latest message is the last element with `role == "user"` in `messages_in`. We need to (a) extract that text, (b) call `lessons::retrieve_for_chat` BEFORE the API call, (c) push the addendum as a system message into `messages`, (d) keep the returned `applied_lesson_ids` for use after the API call.

Use `grep -n "fn chat_complete" src-tauri/src/llm.rs` to confirm the location, then read around line 130-150 to find the existing `kioku_rules::leading_system_message()` push and the `memoryContext` system message push. Insert AFTER both of those.

- [ ] **Step 2: Add lessons addendum push**

Find this block in chat_complete (around line 134-end of the memoryAssembly handling block). The exact insertion point is BEFORE the user/assistant turns from `messages_in` are pushed into `messages` (the relevant downstream loop will be visible nearby; look for `for msg in messages_in.iter()` or similar). Just BEFORE that loop, add:

```rust
  // Lessons retrieval (KIOKU Sub-spec A): top-K rules embedded against
  // the user's latest message, appended as a leading system message so
  // the model honors past corrections. Silent fallback throughout.
  let latest_user_text = messages_in
    .iter()
    .rev()
    .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
    .and_then(|m| m.get("content").and_then(|c| c.as_str()))
    .unwrap_or("")
    .to_string();
  let (lessons_addendum, applied_lesson_ids) =
    crate::lessons::retrieve_for_chat(&latest_user_text).await;
  if !lessons_addendum.is_empty() {
    messages.push(serde_json::json!({
      "role": "system",
      "content": lessons_addendum,
    }));
  }
```

If you can't precisely locate the "before user/assistant push loop" line, the safe location is RIGHT AFTER the `memoryAssembly` block closes (look for the closing `}` that matches the `if privacy_allows_chat_server_memory_assembly() {` block opening around line 134).

Read the file structure if needed:
```bash
sed -n '180,260p' src-tauri/src/llm.rs
```

- [ ] **Step 3: Add applies_n increment after successful Anthropic response**

`chat_complete` ends with returning the API response. Find the success path — it's the `Ok(...)` arm of the response parsing (search for `serde_json::from_str` or the final `Ok(json!({...}))`). IMMEDIATELY BEFORE the final `Ok(...)` return, add:

```rust
  if !applied_lesson_ids.is_empty() {
    if let Ok(conn) = crate::memory_store::open_conn() {
      if let Err(e) = crate::lessons::increment_applies(&conn, &applied_lesson_ids) {
        log::warn!("lessons::increment_applies failed: {}", e);
      }
    }
  }
```

If `chat_complete` has multiple early-return points, this only needs to fire on the **success** path (the user got a real response). On error returns, applies_n shouldn't bump.

If the success/error branching is complex and you can't cleanly insert at one point, an acceptable alternative is to wrap the API call in a small block that captures success, then run the increment, then return — but the simpler "before final Ok" placement is preferred when feasible.

- [ ] **Step 4: Verify compile**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. `lessons::retrieve_for_chat` and `lessons::increment_applies` warnings should both be gone now.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/llm.rs
git diff --cached --stat
git commit -m "feat(kioku): inject lessons addendum into chat system prompt"
git show HEAD --stat
```

Must show exactly 1 file: `src-tauri/src/llm.rs`.

---

## Task 6: Frontend IPC plumbing

**Files:**
- Modify: `hifi/lib/shogun-api.js` — add 2 method bindings
- Modify: `hifi/lib/action-registry.js` — register 2 new actions
- Modify: `hifi/action-map.md` — add 2 entries to the registry list

- [ ] **Step 1: Add API bindings (`hifi/lib/shogun-api.js`)**

Find an existing memory-related entry in the api object — `memoryDayRollupGet` is a fine anchor. Replace this 2-line block:

```js
      memoryRollupGet: (input) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input) => call("shogun_memory_day_rollup_get", input, READ),
```

With:

```js
      memoryRollupGet: (input) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input) => call("shogun_memory_day_rollup_get", input, READ),
      lessonCaptureRejection: (input) => call("shogun_lesson_capture_rejection", input, WRITE),
      lessonCaptureToolFailure: (input) => call("shogun_lesson_capture_tool_failure", input, WRITE),
```

- [ ] **Step 2: Register actions (`hifi/lib/action-registry.js`)**

Find an existing memory.rollup register call. Replace this 2-line block:

```js
    register("memory.rollup.get", (payload) => api.memoryRollupGet(payload));
    register("memory.rollup.day.get", (payload) => api.memoryDayRollupGet(payload));
```

With:

```js
    register("memory.rollup.get", (payload) => api.memoryRollupGet(payload));
    register("memory.rollup.day.get", (payload) => api.memoryDayRollupGet(payload));
    register("lesson.capture.rejection", (payload) => api.lessonCaptureRejection(payload));
    register("lesson.capture.tool_failure", (payload) => api.lessonCaptureToolFailure(payload));
```

- [ ] **Step 3: Add to `hifi/action-map.md`**

Find the registry list section (search `memory.embed_backfill_cancel` for the typical insertion zone — the bottom registry list near line 137). After the line:

```
- `memory.rollup.year.get`
```

Add:

```
- `lesson.capture.rejection`
- `lesson.capture.tool_failure`
```

If `memory.rollup.year.get` isn't there yet (the file may not have been updated for previous specs), insert after `memory.rollup.month.get` instead, or any nearby memory-related line.

- [ ] **Step 4: Verify**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS (the new commands aren't in the mock files, consistent with existing capture commands).
- `check-actions.py`: pre-existing failures only. The 2 new keys (`lesson.capture.rejection`, `lesson.capture.tool_failure`) must NOT appear in the missing list — they're now in action-map.md.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git diff --cached --stat
git commit -m "feat(kioku): wire lesson capture IPC actions"
git show HEAD --stat
```

Must show exactly 3 files.

---

## Task 7: Wire Bad response button (`hifi/app.jsx`)

**Files:**
- Modify: `hifi/app.jsx` — Bad response button at line ~3068

- [ ] **Step 1: Read the chat message data structure**

The Bad response button currently lives inside a chat-message render block. The challenge is extracting (a) the most recent preceding user-message text and (b) this assistant message's text. The exact code depends on the surrounding render scope.

Run:
```bash
grep -n "Bad response\|hummingbird-icon-btn" hifi/app.jsx | head -10
sed -n '3055,3080p' hifi/app.jsx
```

You'll see the two thumbs-up/down buttons in a row. Read enough surrounding context (e.g., 3030-3090) to identify the parent variable holding the assistant message text and the chat thread data.

- [ ] **Step 2: Add onClick to the Bad response button**

The current button:

```jsx
              <button type="button" className="hummingbird-icon-btn" title="Bad response" aria-label="Bad response">
```

Replace with (where `assistantMsgText`, `lastUserMsgText`, `currentChatId` are the appropriate variable names from the surrounding scope — adjust to match what's actually in scope):

```jsx
              <button
                type="button"
                className="hummingbird-icon-btn"
                title="Bad response"
                aria-label="Bad response"
                onClick={() => {
                  // Pull the assistant text and the nearest preceding user text
                  // from the surrounding scope. Variable names below are
                  // examples — replace with whatever the chat-render code
                  // already has in scope.
                  const assistantText = /* assistant message text here */ '';
                  const userText = /* preceding user message text here */ '';
                  const chatId = /* current chat id here */ undefined;
                  if (!assistantText.trim() || !userText.trim()) return;
                  if (typeof window.SHOGUN_RUNTIME?.runAction === 'function') {
                    window.SHOGUN_RUNTIME.runAction('lesson.capture.rejection', {
                      userMsg: userText,
                      assistantMsg: assistantText,
                      chatId,
                    }, { silentError: true, successMessage: "Got it — won't do that again." });
                  } else if (typeof runRuntimeAction === 'function') {
                    runRuntimeAction('lesson.capture.rejection', {
                      userMsg: userText,
                      assistantMsg: assistantText,
                      chatId,
                    }, { silentError: true, successMessage: "Got it — won't do that again." });
                  }
                }}
              >
```

This task requires looking at the actual chat message render scope. If there's no clear `assistantText` / `userText` in scope, the button render may need to be moved or the surrounding map's iteration variable used. **If you cannot identify the right variables in 10 minutes of reading**, STOP and report NEEDS_CONTEXT with a snippet of the surrounding code (lines 3030-3090) so the controller can advise.

- [ ] **Step 3: Manual smoke test**

Refresh Tauri (`Cmd+R`). Send a chat message. When the response arrives, click the Bad response (right thumb-down) icon. Expected: toast "Got it — won't do that again." appears. (If toast doesn't appear: console error → STOP and report.)

Verify the row was inserted via DevTools console:
```js
// (No direct DB access from JS — verify via Memory DBG tab if exposed,
// or check the Tauri stderr log for `[INFO]` lines from the lesson commands.)
```

Or inspect the actual SQLite DB via shell:
```bash
sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
  "SELECT id, category, substr(rule,1,80), datetime(created_at/1000,'unixepoch','localtime') FROM lessons ORDER BY created_at DESC LIMIT 5;"
```

(Path may differ — check existing memory.db location for your machine via `lsof -p $(pgrep app) 2>/dev/null | grep memory.db | head -1`.)

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/app.jsx
git diff --cached --stat
git commit -m "feat(kioku): wire Bad response button to lesson capture"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/app.jsx`.

---

## Task 8: Wire tool_failure capture in `screens-agents.jsx`

**Files:**
- Modify: `hifi/screens-agents.jsx` — `runAgentNow` callback's else branch

- [ ] **Step 1: Locate the `runAgentNow` callback**

```bash
grep -n "const runAgentNow = React.useCallback" hifi/screens-agents.jsx
```

Read 30 lines from there. The `else` branch currently looks like:

```js
      } else {
        const errMsg = res?.error?.message || 'Run failed';
        window.SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
      }
```

- [ ] **Step 2: Append the lesson capture call**

Use Edit. Replace the above block with:

```js
      } else {
        const errMsg = res?.error?.message || 'Run failed';
        window.SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
        // Capture this failure as a Lesson (silent — no toast, no UI feedback)
        runRuntimeActionA('lesson.capture.tool_failure', {
          agentId,
          agentName: agent.name,
          action: def.runNowAction,
          payload: def.runNowPayload(),
          errorMessage: errMsg,
        }, { silentError: true });
      }
```

- [ ] **Step 3: Verify (no automated test — visual smoke)**

Refresh Tauri. To trigger a tool_failure: revoke Gmail credentials in Settings (or rename your gmail OAuth refresh token in Keychain), then click `[▶ Run now]` on Inbox triage in the Agents screen. The Run now will fail (warn toast). No second toast appears for the lesson capture (silent by design).

Check the DB the same way as Task 7 step 3 — a new row with `category = 'tool_failure'` should appear.

If you can't easily revoke credentials, a synthetic test: temporarily change `runNowAction` in AGENT_RUNTIME to a non-existent action like `'gmail.sync_nope'` and click Run now. Revert the AGENT_RUNTIME change after testing.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(kioku): runAgentNow else-branch captures tool_failure lesson"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 9: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:rust`: PASS, no new errors. Some warnings about unused fns may remain if only the public ones are used — that's fine.
- `check:ipc-mock`: PASS.
- `check-actions.py`: only pre-existing failures. The 2 new keys (`lesson.capture.rejection`, `lesson.capture.tool_failure`) must NOT appear as missing.

- [ ] **Step 2: Spec § 8 manual run-through**

Walk through every numbered item in spec § 8 (1 through 6). All must pass. The hardest one is verifying the system prompt actually contains the addendum — check the Tauri stderr log or print the `final_system` string temporarily to confirm.

To temporarily print the final system prompt for verification: in `llm::chat_complete`, just before the API call, add a one-line `log::info!("chat system prompt (lessons addendum chars: {})", lessons_addendum.len());`. Verify in `/tmp/shogun3-app.log` that the count goes from 0 (no lessons matched) to >0 (lessons applied) once you have lessons in the DB. **REVERT this debug line before finalizing.**

- [ ] **Step 3: DB inspection**

```bash
DB=~/Library/Application\ Support/ai.shogun.desktop/memory.db
sqlite3 "$DB" "SELECT category, substr(rule,1,100) AS rule, applies_n, prevented_n FROM lessons ORDER BY created_at DESC LIMIT 10;"
```

Expected output: rows with sensible rule text, applies_n = 0 initially, growing as you chat with lessons in scope.

- [ ] **Step 4: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -n "TODO.*lesson\|FIXME.*lesson" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits. (If any debug `log::info!` lines were added in Step 2, ensure they're reverted before finalizing.)

- [ ] **Step 5: No commit (verification only)**

If all steps pass, the Lessons MVP is complete. Report DONE with the SHA range from Tasks 1-8 (`git log --oneline HEAD~8..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
