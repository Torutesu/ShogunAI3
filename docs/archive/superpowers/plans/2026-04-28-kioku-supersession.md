# KIOKU Sub-spec D — Supersession Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 30-day background batch that uses an LLM judge to mark older `lessons` as `status='superseded'` when a newer lesson in the same category directly contradicts them.

**Architecture:** New `supersession.rs` module (orchestrator + pair selection + LLM judge + DB update) plus a new `supersession_sync.rs` background scheduler modeled on `patterns_sync.rs`. One thin Tauri command (`shogun_supersession_run_now`) for DevTools. Existing `lessons::cosine_similarity` is exposed `pub(crate)` for reuse. No schema changes, no frontend Settings UI.

**Tech Stack:** Rust (rusqlite, tokio, serde_json, uuid, chrono), existing helpers `crate::llm::anthropic_tool_complete`, `crate::lessons::list_active`, `crate::memory_store::open_conn`.

**Spec:** `docs/superpowers/specs/2026-04-28-kioku-supersession-design.md`

---

## File Map

**Created:**
- `src-tauri/src/supersession.rs` (~210 LOC) — `run_supersession` async fn + helpers (fetch / top-K / judge / mark).
- `src-tauri/src/supersession_sync.rs` (~80 LOC) — `spawn_background_supersession_sync` 30-day scheduler.

**Modified:**
- `src-tauri/src/lessons.rs` — `cosine_similarity` → `pub(crate)` (1 keyword change).
- `src-tauri/src/lib.rs` — `mod supersession;` + `mod supersession_sync;` + 1 `setup()` spawn call + 1 invoke_handler entry.
- `src-tauri/src/commands.rs` — `shogun_supersession_run_now` async command (~6 lines).
- `hifi/lib/shogun-api.js` — `supersessionRunNow` binding.
- `hifi/lib/action-registry.js` — `supersession.run_now` register call.
- `hifi/action-map.md` — `supersession.run_now` entry.

**No tests in scope** (per spec § 10 — manual eye-test only). Verification = `npm run check:rust` + `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual SQLite seed walkthrough.

---

## Task 1: `supersession.rs` module + cosine helper exposure

**Files:**
- Modify: `src-tauri/src/lessons.rs:66` — `fn cosine_similarity` → `pub(crate) fn cosine_similarity`
- Create: `src-tauri/src/supersession.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod supersession;`

This is the largest task. The full file content for `supersession.rs` is below.

- [ ] **Step 1: Expose `cosine_similarity` to crate**

Use Edit on `src-tauri/src/lessons.rs`. `old_string`:

```
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
```

`new_string`:

```
pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
```

- [ ] **Step 2: Create `src-tauri/src/supersession.rs`**

Write this full file:

```rust
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

const JUDGE_SYSTEM_PROMPT: &str = "You are evaluating two rules a user has accepted into their personal AI assistant.
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
    Ok(input) => input
      .get("contradicts")
      .and_then(|v| v.as_bool()),
    Err(e) => {
      log::warn!("supersession judge failed: {}", e);
      None
    }
  }
}

fn mark_superseded(conn: &Connection, id: &str) -> Result<(), String> {
  conn
    .execute(
      "UPDATE lessons SET status='superseded' WHERE id = ?1 AND status='active'",
      params![id],
    )
    .map_err(|e| format!("supersession::mark_superseded: {}", e))?;
  Ok(())
}

/// Sort `candidates` by cosine similarity to `target` (DESC), return top K.
fn top_k_by_cosine<'a>(
  target: &[f32],
  candidates: Vec<&'a Lesson>,
  k: usize,
) -> Vec<&'a Lesson> {
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
        .map(|older| (older.id.clone(), older.rule.clone(), active[newer_idx].rule.clone()))
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
```

- [ ] **Step 3: Register the module in `src-tauri/src/lib.rs`**

Locate the existing `mod patterns_sync;` line. Use Edit. `old_string`:

```
mod patterns_sync;
```

`new_string`:

```
mod patterns_sync;
mod supersession;
```

(Note: `supersession_sync` will be added in Task 2.)

- [ ] **Step 4: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -15
```

Expected: PASS. Several `warning: function ... is never used` warnings on `run_supersession`, `judge_contradiction`, etc. are EXPECTED at this stage (they'll be consumed in Task 2 / 3).

If you see hard errors:
- "no function or associated item named `cosine_similarity`" → confirm Step 1 changed `fn` to `pub(crate) fn` in `lessons.rs:66`.
- "no method `clone` on `Vec<f32>`" → `Vec<f32>` clone is built-in, this should not happen. Check imports.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/lessons.rs src-tauri/src/supersession.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): supersession.rs — pair selection + LLM judge + mark"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 3 files: `lessons.rs`, `supersession.rs`, `lib.rs`. Otherwise REVERT (`git reset HEAD~1 --soft` then unstage extras) and report BLOCKED.

---

## Task 2: `supersession_sync.rs` background scheduler

**Files:**
- Create: `src-tauri/src/supersession_sync.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod supersession_sync;` + spawn call

- [ ] **Step 1: Create `src-tauri/src/supersession_sync.rs`**

Write this full file:

```rust
//! Supersession 30-day background sync (KIOKU Sub-spec D). Modeled after
//! `patterns_sync.rs`. Wakes every 6 hours, runs detection if 30 days have
//! elapsed since the last successful run.

use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct SupersessionSyncState {
  pub last_run_ms: Option<i64>,
  pub last_marked_count: usize,
  pub last_error: Option<String>,
}

static STATE: Mutex<SupersessionSyncState> = Mutex::new(SupersessionSyncState {
  last_run_ms: None,
  last_marked_count: 0,
  last_error: None,
});

pub fn snapshot_state() -> SupersessionSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn supersession_enabled() -> bool {
  crate::settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/kioku_graph/supersession_enabled")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true) // default ON
}

fn should_run() -> bool {
  let last = STATE.lock().ok().and_then(|s| s.last_run_ms);
  match last {
    None => true,
    Some(t) => (now_ms() - t) >= 30 * 24 * 60 * 60 * 1000,
  }
}

pub fn spawn_background_supersession_sync() {
  tokio::spawn(async move {
    // Cold-start delay so app boot isn't competing with detection.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
      if supersession_enabled() && should_run() {
        match crate::supersession::run_supersession().await {
          Ok(marked) => {
            if let Ok(mut s) = STATE.lock() {
              s.last_run_ms = Some(now_ms());
              s.last_marked_count = marked;
              s.last_error = None;
            }
            crate::memory_obs::emit(
              "supersession_done",
              &[("marked", marked.to_string())],
            );
          }
          Err(e) => {
            log::warn!("supersession failed: {}", e);
            if let Ok(mut s) = STATE.lock() {
              s.last_error = Some(e.clone());
            }
            crate::memory_obs::emit("supersession_error", &[("error", e)]);
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
    }
  });
}
```

- [ ] **Step 2: Register the module + add the spawn call in `lib.rs`**

Two edits in `src-tauri/src/lib.rs`.

(a) Add the mod declaration. Use Edit. `old_string`:

```
mod supersession;
```

`new_string`:

```
mod supersession;
mod supersession_sync;
```

(b) Add the setup spawn call. Find the existing `patterns_sync::spawn_background_patterns_sync();` line. Use Edit. `old_string`:

```
      patterns_sync::spawn_background_patterns_sync();
```

`new_string`:

```
      patterns_sync::spawn_background_patterns_sync();
      supersession_sync::spawn_background_supersession_sync();
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `run_supersession` warning from Task 1 should be GONE (consumed here). Other warnings on supersession_sync internals (`snapshot_state`) are EXPECTED.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/supersession_sync.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): supersession_sync background scheduler — 30-day gate"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 3: Manual trigger Tauri command

**Files:**
- Modify: `src-tauri/src/commands.rs` — add `shogun_supersession_run_now`
- Modify: `src-tauri/src/lib.rs` — register in invoke_handler

- [ ] **Step 1: Add the command to `commands.rs`**

Locate the existing `shogun_patterns_run_now` function. Use Edit. `old_string`:

```rust
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}
```

`new_string`:

```rust
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}

/// Manually trigger Supersession detection (KIOKU Sub-spec D). Useful for
/// the Memory DBG hooks. 30-day background sync covers production cadence.
#[tauri::command]
pub async fn shogun_supersession_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let marked = crate::supersession::run_supersession().await?;
  Ok(serde_json::json!({ "marked": marked }))
}
```

- [ ] **Step 2: Register in `lib.rs` invoke_handler**

Locate the existing `commands::shogun_patterns_run_now,` line. Use Edit. `old_string`:

```
      commands::shogun_patterns_run_now,
```

`new_string`:

```
      commands::shogun_patterns_run_now,
      commands::shogun_supersession_run_now,
```

- [ ] **Step 3: Verify rust compiles**

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
git commit -m "feat(kioku): shogun_supersession_run_now manual trigger command"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 4: Frontend IPC plumbing

**Files:**
- Modify: `hifi/lib/shogun-api.js` — add `supersessionRunNow` after `patternsRunNow`
- Modify: `hifi/lib/action-registry.js` — add `supersession.run_now` register
- Modify: `hifi/action-map.md` — add `supersession.run_now` entry

- [ ] **Step 1: Add API binding in `hifi/lib/shogun-api.js`**

Locate the existing `patternsRunNow` line. Use Edit. `old_string`:

```
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
```

`new_string`:

```
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
      supersessionRunNow: (input) => call("shogun_supersession_run_now", input || {}, WRITE),
```

- [ ] **Step 2: Register action in `hifi/lib/action-registry.js`**

Locate the existing `patterns.run_now` register call. Use Edit. `old_string`:

```
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
```

`new_string`:

```
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
    register("supersession.run_now", (payload) => api.supersessionRunNow(payload));
```

- [ ] **Step 3: Add to `hifi/action-map.md`**

Locate the existing `patterns.run_now` entry. Use Edit. `old_string`:

```
- `patterns.run_now`
```

`new_string`:

```
- `patterns.run_now`
- `supersession.run_now`
```

- [ ] **Step 4: Verify**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS
- `check-actions.py`: PASS, `supersession.run_now` should NOT appear in any missing list

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git diff --cached --stat
git commit -m "feat(kioku): wire supersession.run_now IPC action"
git show HEAD --stat
```

Must show exactly 3 files.

---

## Task 5: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All should PASS. Pre-existing warnings allowed.

- [ ] **Step 2: Spec § 10.2 manual walkthrough**

The Tauri app should be running. Refresh with Cmd+R, then in DevTools console:

```js
// Trigger detection on existing data (returns 0 if no contradictions found,
// or no embeddings, or no API key configured)
await window.SHOGUN_RUNTIME?.runAction?.('supersession.run_now', {})
// Expected shape: { ok: true, data: { marked: N } }
```

If `marked: 0` and no real contradictions exist in your data, that's the correct result. Use Step 3 below to seed synthetic data and verify with `marked: 1`.

- [ ] **Step 3: Synthetic seed + LLM judge end-to-end**

Spec § 10.3 has the seed SQL. Important caveat: the seed inserts NULL embeddings, but `run_supersession` filters those out. To exercise the full path, embeddings must be populated. Two options:

(a) Use the `memory.embed_backfill` action to populate embeddings on the seed rows. (Caveat: that action targets `mem_items`, not `lessons` — check its scope before relying on it.)

(b) Hand-craft identical embeddings via SQLite BLOB binding (bypass embed pipeline):

```bash
DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"

# Insert seed pair (no embeddings yet)
sqlite3 "$DB" <<'SQL'
INSERT INTO lessons (id, category, trigger_context, attempted, outcome, rule, scope, source, embedding, embedding_dim, created_at, applies_n, prevented_n, status)
VALUES (
  'super_test_old', 'user_rejection', '{}', '{}', '{}',
  'Avoid emojis in formal replies.', 'user', 'manual_test',
  NULL, NULL,
  (unixepoch() - 60*86400) * 1000,
  0, 0, 'active'
);
INSERT INTO lessons (id, category, trigger_context, attempted, outcome, rule, scope, source, embedding, embedding_dim, created_at, applies_n, prevented_n, status)
VALUES (
  'super_test_new', 'user_rejection', '{}', '{}', '{}',
  'Use emojis in formal replies to feel friendly.', 'user', 'manual_test',
  NULL, NULL,
  unixepoch() * 1000,
  0, 0, 'active'
);
SQL

# Inject identical small embeddings (8 floats = 32 bytes) via Python
python3 - <<'PY'
import sqlite3, struct, os
db = os.path.expanduser('~/Library/Application Support/ai.shogun.desktop/memory.db')
emb = struct.pack('<8f', *([0.5] * 8))
con = sqlite3.connect(db)
cur = con.cursor()
for lid in ('super_test_old', 'super_test_new'):
    cur.execute("UPDATE lessons SET embedding=?, embedding_dim=8 WHERE id=?", (emb, lid))
con.commit()
con.close()
print("seeded embeddings on 2 rows")
PY
```

Now refresh the app and run from DevTools:

```js
await window.SHOGUN_RUNTIME?.runAction?.('supersession.run_now', {})
// Expected: { ok: true, data: { marked: 1 } }
```

Verify in SQLite:

```bash
sqlite3 "$DB" "SELECT id, status FROM lessons WHERE id IN ('super_test_old','super_test_new');"
```

Expected:
- `super_test_old | superseded`
- `super_test_new | active`

Open Settings → KIOKU Lessons → confirm `super_test_old` no longer appears in the list (Sub-spec C `lessons.list` returns active only).

- [ ] **Step 4: Cleanup synthetic seed**

```bash
DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"
sqlite3 "$DB" "DELETE FROM lessons WHERE source='manual_test';"
```

- [ ] **Step 5: Idempotency check**

Run again on the cleaned DB:

```js
await window.SHOGUN_RUNTIME?.runAction?.('supersession.run_now', {})
// Expected: { ok: true, data: { marked: 0 } } if no real contradictions
```

The detection should be safe to re-run any number of times — already-superseded lessons don't reappear in the active set.

- [ ] **Step 6: Cost ledger check (informational)**

If `cost_ledger.rs` is wired to record Anthropic API calls, the synthetic test above should log entries for the LLM judge calls (one call per pair tested in your synthetic data).

```bash
sqlite3 "$DB" "SELECT count(*), max(created_at) FROM cost_ledger WHERE created_at > (unixepoch() - 600) * 1000;" 2>/dev/null || echo "cost_ledger table not present"
```

Not a hard failure if not wired — `anthropic_tool_complete` doesn't currently record by itself; ledger integration would require additional hooks.

- [ ] **Step 7: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*supersession|FIXME.*supersession" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits.

- [ ] **Step 8: No commit (verification only)**

If all steps pass, Sub-spec D is complete. Report DONE with the SHA range from Tasks 1-4 (`git log --oneline HEAD~4..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
