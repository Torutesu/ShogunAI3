# KIOKU Sub-spec E — `prevented_n` Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increment `lessons.prevented_n` after every chat turn where the assistant reply respected the injected lesson, surfacing the count as a third stats line in the KIOKU Lessons settings tab.

**Architecture:** A new `lessons_verifier.rs` module owns the LLM judge logic. After `chat_complete` calls `increment_applies`, it spawns the verifier via `tauri::async_runtime::spawn` (fire-and-forget). The verifier does one batched LLM call returning `[{lesson_id, respected}]`, then increments `prevented_n` for respected ids using a new `lessons::increment_prevented` helper. `shogun_lessons_stats` adds a `prevented_total` field; `PaneKiokuLessons` renders a third stats line guarded on `prevented_total > 0`.

**Tech Stack:** Rust (`tauri::async_runtime::spawn`, `crate::llm::anthropic_tool_complete`, rusqlite, serde_json), React 19 (existing `useStateS` / `useRuntimeActions` patterns).

**Spec:** `docs/superpowers/specs/2026-04-30-kioku-prevented-verifier-design.md`

---

## File Map

**Created:**
- `src-tauri/src/lessons_verifier.rs` (~150 LOC) — `verify_and_increment` async fn + helpers (`fetch_rules_for_ids`, `judge_tool`, `build_user_prompt`, `call_judge`).

**Modified:**
- `src-tauri/src/lessons.rs` — `increment_prevented(conn, ids)` (+12 LOC).
- `src-tauri/src/llm.rs` — spawn block after `increment_applies` (+12 LOC).
- `src-tauri/src/lib.rs` — `mod lessons_verifier;` (+1 LOC).
- `src-tauri/src/commands.rs` — `shogun_lessons_stats` adds `prevented_total` field (+5 LOC).
- `hifi/settings-modal.jsx` — `PaneKiokuLessons` stats card adds 3rd line + state (+8 LOC).

**No tests in scope** (per spec § 12 — manual eye-test only). Verification = `npm run check:rust` + `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual chat walkthrough.

---

## Task 1: `lessons::increment_prevented`

**Files:**
- Modify: `src-tauri/src/lessons.rs:178-192` — add `increment_prevented` immediately after `increment_applies`.

This task adds the SQL helper that the verifier (Task 2) will call. Mirror of `increment_applies` with two differences: column name `prevented_n` and `WHERE status='active'` guard (defensive — verifier runs async, lesson may have been archived in between).

- [ ] **Step 1: Add `increment_prevented` after `increment_applies`**

Locate `increment_applies` ending at line 192 (`Ok(())\n}`). Use Edit on `src-tauri/src/lessons.rs`. `old_string`:

```
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
```

`new_string`:

```
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

pub fn increment_prevented(conn: &Connection, ids: &[String]) -> Result<(), String> {
  if ids.is_empty() {
    return Ok(());
  }
  let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(", ");
  let sql = format!(
    "UPDATE lessons SET prevented_n = prevented_n + 1 WHERE status = 'active' AND id IN ({})",
    placeholders
  );
  let params: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
  conn
    .execute(&sql, &params[..])
    .map_err(|e| format!("lessons::increment_prevented: {}", e))?;
  Ok(())
}
```

- [ ] **Step 2: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. A `warning: function increment_prevented is never used` is EXPECTED (consumed in Task 2).

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/lessons.rs
git diff --cached --stat
git commit -m "feat(kioku): lessons::increment_prevented helper"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file (`src-tauri/src/lessons.rs`). Otherwise REVERT (`git reset HEAD~1 --soft`) and report BLOCKED.

---

## Task 2: `lessons_verifier.rs` module

**Files:**
- Create: `src-tauri/src/lessons_verifier.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod lessons_verifier;`

This is the largest task. Full file content below.

- [ ] **Step 1: Create `src-tauri/src/lessons_verifier.rs`**

Write this full file:

```rust
//! Lessons verifier (KIOKU Sub-spec E). Called fire-and-forget after every
//! chat completion that injected lessons. Asks an LLM judge whether the
//! assistant message respected each injected lesson; for those marked
//! respected, increments `prevented_n`.
//!
//! Schema: see `kioku_graph_schema::ensure_phase2_tables` (lessons table).
//! Wire site: `crate::llm::chat_complete` (after `increment_applies`).

use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};
use std::collections::HashSet;

const MODEL: &str = "claude-haiku-4-5-20251001";

const JUDGE_SYSTEM_PROMPT: &str = "You are evaluating whether an AI assistant's reply respected a set of rules the user previously accepted into their personal AI assistant.

For each rule, output:
- respected: true   — the assistant's reply did NOT violate the rule
                     (this includes rules that don't apply to the topic —
                     vacuous compliance counts as respected)
- respected: false  — the assistant's reply violated the rule

Only mark `false` when the reply visibly violates the rule's intent. When
unsure, prefer `true`.

Output the structured tool call only. Include EVERY input lesson_id in
your judgments array.";

fn judge_tool() -> Value {
  json!({
    "name": "judge_lesson_compliance",
    "description": "For each lesson, decide whether the assistant message respected (did not violate) the rule.",
    "input_schema": {
      "type": "object",
      "properties": {
        "judgments": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "lesson_id": { "type": "string" },
              "respected": { "type": "boolean" }
            },
            "required": ["lesson_id", "respected"]
          }
        }
      },
      "required": ["judgments"]
    }
  })
}

fn fetch_rules_for_ids(
  conn: &Connection,
  ids: &[String],
) -> Result<Vec<(String, String)>, String> {
  if ids.is_empty() {
    return Ok(Vec::new());
  }
  let placeholders = std::iter::repeat("?")
    .take(ids.len())
    .collect::<Vec<_>>()
    .join(", ");
  let sql = format!(
    "SELECT id, rule FROM lessons WHERE status = 'active' AND id IN ({})",
    placeholders
  );
  let mut stmt = conn
    .prepare(&sql)
    .map_err(|e| format!("verifier prepare: {}", e))?;
  let rows = stmt
    .query_map(params_from_iter(ids.iter()), |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })
    .map_err(|e| format!("verifier query: {}", e))?;
  let mut out = Vec::new();
  for r in rows {
    out.push(r.map_err(|e| format!("verifier row: {}", e))?);
  }
  Ok(out)
}

fn build_user_prompt(user_msg: &str, assistant_msg: &str, lessons: &[(String, String)]) -> String {
  let mut s = String::new();
  s.push_str("USER ASKED:\n");
  s.push_str(user_msg);
  s.push_str("\n\nASSISTANT REPLIED:\n");
  s.push_str(assistant_msg);
  s.push_str("\n\nLESSONS TO EVALUATE:\n");
  for (id, rule) in lessons {
    s.push_str("- id: ");
    s.push_str(id);
    s.push_str("\n  rule: ");
    s.push_str(rule);
    s.push('\n');
  }
  s
}

/// Calls the LLM judge. Returns `Some(respected_ids)` on success, `None` on
/// transient failure (already logged).
async fn call_judge(
  user_msg: &str,
  assistant_msg: &str,
  lessons: &[(String, String)],
) -> Option<Vec<String>> {
  let user_content = build_user_prompt(user_msg, assistant_msg, lessons);
  let tool = judge_tool();

  match crate::llm::anthropic_tool_complete(
    JUDGE_SYSTEM_PROMPT,
    &user_content,
    &tool,
    MODEL,
  )
  .await
  {
    Ok(input) => {
      let judgments = match input.get("judgments").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => {
          log::warn!("verifier: judgments missing in tool output");
          return None;
        }
      };
      let valid_ids: HashSet<&String> = lessons.iter().map(|(id, _)| id).collect();
      let respected: Vec<String> = judgments
        .iter()
        .filter_map(|j| {
          let id = j.get("lesson_id").and_then(|v| v.as_str())?.to_string();
          let respected = j.get("respected").and_then(|v| v.as_bool())?;
          if respected && valid_ids.contains(&id) {
            Some(id)
          } else {
            None
          }
        })
        .collect();
      Some(respected)
    }
    Err(e) => {
      log::warn!("verifier judge failed: {}", e);
      None
    }
  }
}

/// Async verifier triggered after every chat turn that injected lessons.
/// Fire-and-forget: never returns, never blocks the chat response.
pub async fn verify_and_increment(
  applied_lesson_ids: Vec<String>,
  user_msg: String,
  assistant_msg: String,
) {
  // 1. API key gate (silent no-op when unconfigured)
  let key_present = crate::secrets::get_llm_api_key()
    .ok()
    .flatten()
    .map(|k| !k.trim().is_empty())
    .unwrap_or(false);
  if !key_present {
    return;
  }

  if applied_lesson_ids.is_empty() {
    return;
  }

  // 2. Open DB + fetch rules for active lessons (skip archived/superseded)
  let conn = match crate::memory_store::open_conn() {
    Ok(c) => c,
    Err(e) => {
      log::warn!("verifier open_conn: {}", e);
      return;
    }
  };
  let lessons = match fetch_rules_for_ids(&conn, &applied_lesson_ids) {
    Ok(v) => v,
    Err(e) => {
      log::warn!("verifier fetch_rules: {}", e);
      return;
    }
  };
  if lessons.is_empty() {
    return;
  }

  // 3. Call LLM judge
  let respected_ids = match call_judge(&user_msg, &assistant_msg, &lessons).await {
    Some(ids) => ids,
    None => return,
  };

  // 4. Increment prevented_n for respected lessons
  if respected_ids.is_empty() {
    return;
  }
  if let Err(e) = crate::lessons::increment_prevented(&conn, &respected_ids) {
    log::warn!("verifier increment_prevented: {}", e);
    return;
  }

  crate::memory_obs::emit(
    "lesson_verifier_done",
    &[
      ("respected", respected_ids.len().to_string()),
      ("total", lessons.len().to_string()),
    ],
  );
}
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`**

Locate the existing `mod lessons;` line. Use Edit. `old_string`:

```
mod lessons;
```

`new_string`:

```
mod lessons;
mod lessons_verifier;
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -15
```

Expected: PASS. A `warning: function verify_and_increment is never used` is EXPECTED at this stage (consumed in Task 3). The `increment_prevented` warning from Task 1 should be GONE (consumed by `verify_and_increment`).

If you see a hard error related to `params_from_iter`, confirm the `use rusqlite::params_from_iter;` import is at the top of the file. `params_from_iter` is part of `rusqlite` and lets you pass a slice of `String` as bind parameters.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/lessons_verifier.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): lessons_verifier — async LLM judge for prevented_n"
git show HEAD --stat
```

Must show exactly 2 files. Otherwise REVERT.

---

## Task 3: Wire verifier into `chat_complete`

**Files:**
- Modify: `src-tauri/src/llm.rs:259-271` — add spawn block after `increment_applies`.

- [ ] **Step 1: Add the spawn block**

Locate the existing block in `src-tauri/src/llm.rs` (around lines 259-271). Use Edit. `old_string`:

```
  let content = crate::llm_providers::extract_chat_text(provider, &v)?;
  if !applied_lesson_ids.is_empty() {
    if let Ok(conn) = crate::memory_store::open_conn() {
      if let Err(e) = crate::lessons::increment_applies(&conn, &applied_lesson_ids) {
        log::warn!("lessons::increment_applies failed: {}", e);
      }
    }
  }
  Ok(json!({
    "message": content,
    "echo": payload,
    "stub": false,
  }))
```

`new_string`:

```
  let content = crate::llm_providers::extract_chat_text(provider, &v)?;
  if !applied_lesson_ids.is_empty() {
    if let Ok(conn) = crate::memory_store::open_conn() {
      if let Err(e) = crate::lessons::increment_applies(&conn, &applied_lesson_ids) {
        log::warn!("lessons::increment_applies failed: {}", e);
      }
    }

    // Sub-spec E: async verifier — fire-and-forget. Increments prevented_n
    // for lessons the assistant reply respected. Does not block this response.
    let applied_ids_for_verify = applied_lesson_ids.clone();
    let user_msg_for_verify = latest_user_text.clone();
    let assistant_msg_for_verify = content.clone();
    tauri::async_runtime::spawn(async move {
      crate::lessons_verifier::verify_and_increment(
        applied_ids_for_verify,
        user_msg_for_verify,
        assistant_msg_for_verify,
      )
      .await;
    });
  }
  Ok(json!({
    "message": content,
    "echo": payload,
    "stub": false,
  }))
```

- [ ] **Step 2: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `verify_and_increment` warning from Task 2 should be GONE (consumed here).

If you see "no field `latest_user_text` in scope" or similar — confirm that the existing code in `chat_complete` already has a local variable `latest_user_text: String` (defined around line 212-218). It does; the spawn block uses `.clone()` on it.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/llm.rs
git diff --cached --stat
git commit -m "feat(kioku): wire lessons_verifier into chat_complete (fire-and-forget)"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 4: `shogun_lessons_stats` returns `prevented_total`

**Files:**
- Modify: `src-tauri/src/commands.rs:2317-2336` — extend `shogun_lessons_stats`.

- [ ] **Step 1: Add `prevented` SUM and include in response**

Use Edit on `src-tauri/src/commands.rs`. `old_string`:

```
#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let total: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats count: {}", e))?;
  let applied: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(applies_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum: {}", e))?;
  Ok(serde_json::json!({ "total_active": total, "applied_total": applied }))
}
```

`new_string`:

```
#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let total: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats count: {}", e))?;
  let applied: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(applies_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum applies: {}", e))?;
  let prevented: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(prevented_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum prevented: {}", e))?;
  Ok(serde_json::json!({
    "total_active": total,
    "applied_total": applied,
    "prevented_total": prevented,
  }))
}
```

- [ ] **Step 2: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs
git diff --cached --stat
git commit -m "feat(kioku): shogun_lessons_stats returns prevented_total"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 5: `PaneKiokuLessons` renders `Prevented` line

**Files:**
- Modify: `hifi/settings-modal.jsx:3535-3594` — update `PaneKiokuLessons` state + stats card.

- [ ] **Step 1: Extend the `stats` initial state with `prevented_total: 0`**

Use Edit on `hifi/settings-modal.jsx`. `old_string`:

```
  const [stats, setStats] = useStateS({ total_active: 0, applied_total: 0 });
```

`new_string`:

```
  const [stats, setStats] = useStateS({ total_active: 0, applied_total: 0, prevented_total: 0 });
```

- [ ] **Step 2: Update `fetchStats` to capture `prevented_total`**

Use Edit. `old_string`:

```
      setStats({
        total_active: Number(r.data.total_active || 0),
        applied_total: Number(r.data.applied_total || 0),
      });
```

`new_string`:

```
      setStats({
        total_active: Number(r.data.total_active || 0),
        applied_total: Number(r.data.applied_total || 0),
        prevented_total: Number(r.data.prevented_total || 0),
      });
```

- [ ] **Step 3: Update optimistic `setStats` in `archive` to preserve `prevented_total`**

Use Edit. `old_string`:

```
    setStats({ ...stats, total_active: Math.max(0, stats.total_active - 1) });
```

`new_string`:

```
    setStats({
      total_active: Math.max(0, stats.total_active - 1),
      applied_total: stats.applied_total,
      prevented_total: stats.prevented_total,
    });
```

- [ ] **Step 4: Add the conditional `Prevented N failures` line**

Use Edit. `old_string`:

```
        <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
          {statsLoaded ? `Applied ${stats.applied_total} times total` : 'Applied — times total'}
        </div>
      </div>
```

`new_string`:

```
        <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
          {statsLoaded ? `Applied ${stats.applied_total} times total` : 'Applied — times total'}
        </div>
        {statsLoaded && stats.prevented_total > 0 && (
          <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
            Prevented {stats.prevented_total} failures
          </div>
        )}
      </div>
```

- [ ] **Step 5: Verify static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -3
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/settings-modal.jsx
git diff --cached --stat
git commit -m "feat(kioku): KIOKU Lessons — Prevented N failures stats line"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All should PASS. Pre-existing warnings allowed.

- [ ] **Step 2: Spec § 12.2 manual walkthrough**

Prerequisite: at least one active lesson exists with non-null embedding. If you have none, seed via the Sub-spec D synthetic seed (or capture one via the "Bad response" button on a Hummingbird reply).

Steps:

1. Tauri app should be running (kill stale + relaunch new binary if any backend Rust code changed since last run):
   ```bash
   cd /Users/torutano/ShogunAI3/ShogunAI3
   pgrep -f "target/debug/app" | xargs -r kill 2>&1
   sleep 2
   bash scripts/tauri-dev-static-server.sh > /tmp/shogun-static-server.log 2>&1 &
   sleep 2
   nohup ./src-tauri/target/debug/app > /tmp/shogun3-app.log 2>&1 &
   sleep 4
   pgrep -fla "target/debug/app" | head -3
   ```
2. Open Settings → KIOKU Lessons → confirm:
   - `X lessons learned`
   - `Applied Y times total`
   - **No third line** (provided no lesson has `prevented_n > 0` yet)
3. Open Chat → ask anything that should retrieve at least one lesson (something semantically related to a lesson rule).
4. Wait ~3-5 seconds for the assistant reply, then continue waiting another ~3-5s for the verifier.
5. Inspect log:
   ```bash
   tail -50 /tmp/shogun3-app.log | grep -E "lesson_verifier_done|verifier" | tail -5
   ```
   Expect: `event=lesson_verifier_done respected=N total=N`. If you see only `verifier judge failed: ...` warnings, check if the Anthropic API key is configured / has credit.
6. SQLite check:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT id, applies_n, prevented_n FROM lessons WHERE applies_n > 0 ORDER BY applies_n DESC LIMIT 5;"
   ```
   Expect at least one row with `prevented_n > 0`.
7. Settings → KIOKU Lessons (close + reopen the settings modal to refresh stats) → third line `Prevented N failures` should now appear.

- [ ] **Step 3: Negative test (API key missing)**

Temporarily clear the env var (or set an invalid key in Keychain) and chat once. The verifier should silently no-op:

```bash
tail -50 /tmp/shogun3-app.log | grep -E "verifier|lesson"
```

Expect: no `lesson_verifier_done` event, no `verifier judge failed` warning (the API-key gate returns early before any LLM call). `prevented_n` does not increase. UI behavior unchanged.

After the negative test, restore the API key (re-set `ANTHROPIC_API_KEY` env var, or restore the Keychain entry).

- [ ] **Step 4: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*verifier|FIXME.*verifier|TODO.*prevented_n" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits.

- [ ] **Step 5: No commit (verification only)**

If all steps pass, Sub-spec E is complete. Report DONE with the SHA range from Tasks 1-5 (`git log --oneline HEAD~5..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
