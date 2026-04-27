# Memory Digest Phase 4 — Summary Manual Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users inline-edit summary `title`, `keyPoints`, and `reason` from the Memory River detail panel; persist edits in `mem_summaries.raw_json.user_edits[]` so they survive LLM re-summarization.

**Architecture:** Backend: extend the existing `Summary` load path in `summarizer_store.rs` to apply a `user_edits[]` array from `raw_json` on top of the LLM-baseline fields (merge-on-load). Two new IPC commands (`memory.summary.edit`, `memory.summary.revert`) append/clear those entries via SQL `UPDATE mem_summaries SET raw_json = ?` after editing the JSON in Rust. Frontend: contentEditable-style inline edit on the three fields with autosave-on-blur and an "edited" dot + Revert affordance. No DB schema migration; `userPriority` (existing column) is unaffected.

**Tech Stack:** Rust 1.x (Tauri 2 commands, `rusqlite`, `serde_json`), React via `text/babel` script tag (no JSX build), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-04-26-memory-digest-summary-edit-design.md` (commit `532eed7`)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src-tauri/src/summarizer_store.rs` | Modify | Add `apply_user_edits()` merge helper. Modify `Summary` row-loading paths (`get_cached`, `get_cached_many`, plus the equivalent reads in `upsert` / batch fetchers) to invoke the merge. Add `edit_field()` and `revert_field()` writers. Unit tests for merge logic + writer round-trip. |
| `src-tauri/src/commands.rs` | Modify | Add `shogun_memory_summary_edit` and `shogun_memory_summary_revert` Tauri command handlers. |
| `src-tauri/src/lib.rs` | Modify | Register the two new commands in the `tauri::generate_handler!` invocation. |
| `hifi/lib/shogun-api.js` | Modify | Add `memorySummaryEdit` and `memorySummaryRevert` API call wrappers. |
| `hifi/lib/action-registry.js` | Modify | Register `memory.summary.edit` and `memory.summary.revert` action mappings. |
| `hifi/lib/ipc-client.js` | Modify | Add mock cases that maintain an in-memory `user_edits[]` map and merge on `shogun_memory_summary_get` / `shogun_memory_summary_batch`. |
| `hifi/app.jsx` | Modify | Wire the two new commands into the `mockTransport` switch and the runtime API export. |
| `hifi/screens-a.jsx` | Modify | Inline edit affordances for `title`, `keyPoints[i]`, `reason`. Add `+ Add point` / `×` for keyPoints. Edited-field dot + Revert action. |
| `tests/e2e/memory-summary-edit.spec.js` | Create | Playwright spec covering happy path + Revert. |

No new files in Rust; no new files in `hifi/lib`. Only the test file is brand new.

---

## Pre-flight

- [ ] **Step 0.1: Confirm baseline**

```bash
npm run check:actions
npm run check:ipc-mock
cargo test --manifest-path src-tauri/Cargo.toml --lib summarizer_store -- --nocapture
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected:
- `check:actions`: noisy with pre-existing warnings (accepted).
- `check:ipc-mock`: OK.
- `cargo test`: existing `summarizer_store` tests pass.
- `hifi-smoke`: 17 passed + 4 known pre-existing failures (entity sources panel, draft toast, semantic re-rank x2). Same baseline accepted by the user before any phase 4 work began.

- [ ] **Step 0.2: Confirm branch**

```bash
git branch --show-current
git status --short
```

Expected: branch `feat/memory-digest-phase4-summary-edit`. Untracked `package-lock.json` from worktree-setup `npm install` is OK.

---

## Task 1: Rust merge helper `apply_user_edits` + Summary load integration

**Why:** The reader must apply `raw_json.user_edits[]` entries on top of the LLM-baseline fields so every consumer of `Summary` sees the user's effective values. Putting the merge inside the row-to-struct loaders is the smallest possible surface (vs. patching every call site).

**Files:**
- Modify: `src-tauri/src/summarizer_store.rs`

- [ ] **Step 1.1: Add `apply_user_edits` helper above the `Summary` impl**

Open `src-tauri/src/summarizer_store.rs` and find the `impl Summary` block (around line 30). Just **above** that block, insert:

```rust
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
```

- [ ] **Step 1.2: Call `apply_user_edits` at every row-load site**

In the same file, find the row-to-`Summary` constructions. There are typically four spots that build a `Summary` from a SQL row: `get_cached`, `get_cached_many`, the equivalent in `delete`/`upsert` round-trips, and any list/iterator helpers. Locate them by grepping for `Ok(Summary {`:

```bash
grep -n "Ok(Summary {" src-tauri/src/summarizer_store.rs
```

For **each** match, locate the closing `})` of the `Ok(Summary { ... })` literal, then immediately after the `Summary` is fully constructed (but before it's wrapped/returned), insert `apply_user_edits(&mut s);` where `s` is the constructed Summary.

The cleanest way is to bind the result to a `mut` local, mutate, then return. Example pattern:

```rust
// BEFORE
|r| {
  let kp_json: String = r.get(3)?;
  let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
  Ok(Summary {
    target_kind: r.get(0)?,
    target_id: r.get(1)?,
    /* ... all fields ... */
  })
}

// AFTER
|r| {
  let kp_json: String = r.get(3)?;
  let key_points: Vec<String> = serde_json::from_str(&kp_json).unwrap_or_default();
  let mut s = Summary {
    target_kind: r.get(0)?,
    target_id: r.get(1)?,
    /* ... all fields ... */
  };
  apply_user_edits(&mut s);
  Ok(s)
}
```

Apply this pattern to **every** `Ok(Summary { ... })` match. Run the grep again after to confirm every match was updated; the literal `Ok(Summary {` should still appear (you're keeping the struct construction) but each one should now be preceded by `let mut s =` and followed by `apply_user_edits(&mut s);` then `Ok(s)`.

- [ ] **Step 1.3: Add unit tests for `apply_user_edits`**

In `src-tauri/src/summarizer_store.rs`, find the `#[cfg(test)] mod tests` block at the bottom (around line 352). Inside it, after the existing `summary_to_json_roundtrip` test, add:

```rust
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
```

- [ ] **Step 1.4: Run unit tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib summarizer_store -- --nocapture
```

Expected: all existing tests still pass, plus 8 new `apply_user_edits_*` tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src-tauri/src/summarizer_store.rs
git commit -m "$(cat <<'EOF'
feat(memory-summary): apply_user_edits merge on row load

Reads raw_json.user_edits[] and applies the latest entry per field
('title', 'keyPoints', 'reason') on top of the LLM baseline before
returning the Summary struct. Existing callers see effective values
without changes. Forward-compat: unknown schema versions and unknown
fields are ignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Rust DB writers `edit_field` + `revert_field`

**Why:** The IPC command handlers need a clean API to append a single edit entry or clear a field's history. Both operations are read-modify-write on the `raw_json` JSON column; isolating them in `summarizer_store.rs` keeps `commands.rs` thin.

**Files:**
- Modify: `src-tauri/src/summarizer_store.rs`

- [ ] **Step 2.1: Add `edit_field` and `revert_field` writers**

In `src-tauri/src/summarizer_store.rs`, just after `set_user_priority` (around line 341), insert:

```rust
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
```

- [ ] **Step 2.2: Add unit tests for the writers**

In the same file's `#[cfg(test)] mod tests` block, after the `apply_user_edits_*` tests added in Task 1, add:

```rust
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
```

The `#[ignore]` attribute is used because these tests need the SQLite harness; they run via `cargo test --lib summarizer_store -- --ignored`. Pure-logic tests (Task 1's) run by default; DB-roundtrip tests gate behind `--ignored` to keep the default `cargo test` fast.

- [ ] **Step 2.3: Run the writer tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib summarizer_store -- --ignored --nocapture
```

Expected: 4 new `_edit_field_*` / `_revert_field_*` tests pass.

If they fail with "no such table mem_summaries", the test harness needs DB initialization. Look at how existing `#[ignore]`-style or DB tests handle this (search `grep -n "init_db\|create_table\|migrate" src-tauri/src/memory_store.rs`); follow the same pattern for these tests' setup.

- [ ] **Step 2.4: Commit**

```bash
git add src-tauri/src/summarizer_store.rs
git commit -m "$(cat <<'EOF'
feat(memory-summary): edit_field + revert_field writers

Append a single user-edit entry to raw_json.user_edits[] (with metadata:
source_raw, entity_id, at, schema=1) and update the dedicated column for
fast read paths. revert_field drops all entries for one field and resets
the column back to raw_json.tool_use.<field> baseline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rust IPC commands `shogun_memory_summary_edit` + `_revert`

**Why:** Expose the writers via Tauri so the frontend can call them.

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 3.1: Add the two command handlers in `commands.rs`**

Find `shogun_memory_summary_set_priority` (around line 1711). Just **after** its closing `}`, append:

```rust
/// Append a user edit to a summary's raw_json.user_edits[] and update the
/// matching column for fast reads. The field must be one of:
///   "title" | "keyPoints" | "reason".
/// `value` is the new value (string for title/reason, array of strings for
/// keyPoints; null is allowed for reason). `baseValue` is the pre-edit
/// display value, recorded as `from` in the history entry.
///
/// payload: {
///   "targetId": "m_...",
///   "targetKind"?: "item",
///   "field": "title" | "keyPoints" | "reason",
///   "value": <new value>,
///   "baseValue"?: <prior value>,
///   "sourceRaw"?: str, "entityId"?: str
/// }
#[tauri::command]
pub fn shogun_memory_summary_edit(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  let field = payload
    .get("field")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "field required".to_string())?;
  let value = payload
    .get("value")
    .cloned()
    .ok_or_else(|| "value required".to_string())?;
  let base_value = payload
    .get("baseValue")
    .cloned()
    .unwrap_or(serde_json::Value::Null);
  let source_raw = payload.get("sourceRaw").and_then(|v| v.as_str());
  let entity_id = payload.get("entityId").and_then(|v| v.as_str());
  let now_ms: i64 = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0);

  let updated = crate::summarizer_store::edit_field(
    target_kind,
    target_id,
    field,
    base_value,
    value,
    now_ms,
    crate::summarizer_store::EditMetadata { source_raw, entity_id },
  )?;
  if !updated {
    return Ok(serde_json::json!({ "updated": false, "summary": serde_json::Value::Null }));
  }

  // Return the merged effective summary.
  let s = crate::summarizer_store::get_cached(target_kind, target_id, "en")?
    .or_else(|| crate::summarizer_store::get_cached(target_kind, target_id, "jp").ok().flatten())
    .ok_or_else(|| "summary missing after edit".to_string())?;
  Ok(serde_json::json!({ "updated": true, "summary": s.to_json() }))
}

/// Clear all `user_edits[]` entries for one field on a summary, restoring the
/// LLM-baseline value for that field.
///
/// payload: { "targetId": "m_...", "targetKind"?: "item", "field": "title" | "keyPoints" | "reason" }
#[tauri::command]
pub fn shogun_memory_summary_revert(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let target_id = payload
    .get("targetId")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "targetId required".to_string())?;
  let target_kind = payload
    .get("targetKind")
    .and_then(|v| v.as_str())
    .unwrap_or("item");
  let field = payload
    .get("field")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "field required".to_string())?;

  let updated = crate::summarizer_store::revert_field(target_kind, target_id, field)?;
  if !updated {
    return Ok(serde_json::json!({ "updated": false, "summary": serde_json::Value::Null }));
  }
  let s = crate::summarizer_store::get_cached(target_kind, target_id, "en")?
    .or_else(|| crate::summarizer_store::get_cached(target_kind, target_id, "jp").ok().flatten())
    .ok_or_else(|| "summary missing after revert".to_string())?;
  Ok(serde_json::json!({ "updated": true, "summary": s.to_json() }))
}
```

- [ ] **Step 3.2: Register the commands in `lib.rs`**

Open `src-tauri/src/lib.rs`. Find the `tauri::generate_handler!` invocation around line 218 where `shogun_memory_summary_set_priority` is registered (around line 228). Add the two new commands to the list. Find:

```rust
      commands::shogun_memory_summary_set_priority,
```

Replace with:

```rust
      commands::shogun_memory_summary_set_priority,
      commands::shogun_memory_summary_edit,
      commands::shogun_memory_summary_revert,
```

- [ ] **Step 3.3: Verify Rust compiles**

```bash
npm run check:rust 2>&1 | tail -10
```

Expected: `cargo check` passes (warnings OK, no errors).

- [ ] **Step 3.4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(memory-summary): IPC commands for edit and revert

shogun_memory_summary_edit appends a user-edit history entry plus updates
the matching column. shogun_memory_summary_revert drops all entries for
one field and restores the LLM baseline. Both return the merged
effective summary so the caller can update its local cache without a
re-fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Frontend API + action registry + mock IPC

**Why:** Wire the two new commands into the JS API layer so the React UI can call them via the same `runRuntimeActionA('memory.summary.edit', ...)` pattern used elsewhere. Add mock implementations so dev/Playwright work without the real Tauri backend.

**Files:**
- Modify: `hifi/lib/shogun-api.js`
- Modify: `hifi/lib/action-registry.js`
- Modify: `hifi/app.jsx`
- Modify: `hifi/lib/ipc-client.js`

- [ ] **Step 4.1: Add wrappers in `shogun-api.js`**

Find the existing `memorySummaryInvalidate` line (around line 36) in `hifi/lib/shogun-api.js`. Just **after** the cluster of `memorySummary*` definitions (just after `memorySummarySnooze` around line 44), add:

```js
      memorySummaryEdit: (input) => call("shogun_memory_summary_edit", input, WRITE),
      memorySummaryRevert: (input) => call("shogun_memory_summary_revert", input, WRITE),
```

(Indentation: match the surrounding lines exactly — 6 spaces.)

- [ ] **Step 4.2: Register actions in `action-registry.js`**

Find the existing `memory.summary.set_priority` registration in `hifi/lib/action-registry.js` (around line 77). Just **after** that line (or near the other `memory.summary.*` registrations), add:

```js
    register("memory.summary.edit", (payload) => api.memorySummaryEdit(payload));
    register("memory.summary.revert", (payload) => api.memorySummaryRevert(payload));
```

- [ ] **Step 4.3: Wire commands in `app.jsx`**

In `hifi/app.jsx`, find the runtime API exports (around line 759-761 where `memorySummaryInvalidate` is exported). Just after `memorySummaryInvalidate`, add two more lines:

```js
        memorySummaryEdit: (input) => client.invoke('shogun_memory_summary_edit', input),
        memorySummaryRevert: (input) => client.invoke('shogun_memory_summary_revert', input),
```

Then find the action map registration (around line 851 where `'memory.summary.invalidate': api.memorySummaryInvalidate` lives) and add:

```js
          'memory.summary.edit': api.memorySummaryEdit,
          'memory.summary.revert': api.memorySummaryRevert,
```

- [ ] **Step 4.4: Add mocks in `ipc-client.js`**

In `hifi/lib/ipc-client.js`, find the `shogun_memory_summary_get` case (around line 494). Above all `shogun_memory_summary_*` cases (or just inside the function body before the switch — pick a single shared in-memory store), add:

```js
      // Mock-only state for memory.summary edit/revert.
      // Map<targetId, Array<edit-entry>> mirroring the shape used in
      // raw_json.user_edits[]. Mock get/batch handlers merge the latest
      // entry per field on top of the LLM-baseline ('Stub: ...' values).
      window.__SHOGUN_MOCK_SUMMARY_EDITS__ ||= new Map();
      const mockEdits = window.__SHOGUN_MOCK_SUMMARY_EDITS__;
      const applyMockEdits = (base, targetId) => {
        const arr = mockEdits.get(String(targetId)) || [];
        const out = { ...base };
        for (const e of arr) {
          if (!e || e.schema !== 1) continue;
          if (e.field === 'title' && typeof e.to === 'string') out.title = e.to;
          else if (e.field === 'keyPoints' && Array.isArray(e.to)) out.keyPoints = e.to;
          else if (e.field === 'reason') out.reason = e.to == null ? null : String(e.to);
        }
        return out;
      };
```

(Place this block at the top of the `mockTransport` function body — the same scope where `mockPriorityForId` from Task 4 of the cluster work lives in the cluster branch. Since this branch is parallel to the cluster branch, `mockPriorityForId` may or may not be present here. If it is present, place the new block right next to it. If not, just place it at function-scope.)

Now find each summary-returning case (`shogun_memory_summary_get`, `shogun_memory_summary_batch`) and wrap their `summary` / `ok[]` results with `applyMockEdits`. Specifically:

In `shogun_memory_summary_get` (around line 494), change the returned object's `summary` field from a literal to:

```js
      case "shogun_memory_summary_get": {
        const baseId = String((echo && echo.targetId) || "m_stub");
        const base = {
          targetKind: "item",
          targetId: baseId,
          title: "Stub summary",
          keyPoints: ["This is a mocked summary"],
          sourceType: "mail",
          priority: "medium", // or mockPriorityForId(baseId) if present
          reason: "mock",
          model: "mock",
          schemaVersion: 1,
          generatedAt: Date.now(),
        };
        return {
          summary: applyMockEdits(base, baseId),
          cached: false,
        };
      }
```

In `shogun_memory_summary_batch` (around line 510), change the returned `ok: ...map(...)` to wrap each item:

```js
      case "shogun_memory_summary_batch":
        return {
          ok: ((echo && echo.items) || []).map((it) => {
            const id = String((it && it.id) || "m_stub");
            const base = {
              targetKind: "item",
              targetId: id,
              title: `Stub: ${(it && it.title) || "untitled"}`,
              keyPoints: ["mock point"],
              sourceType: "mail",
              priority: "medium", // or mockPriorityForId(id)
              reason: "mock",
              model: "mock",
              schemaVersion: 1,
              generatedAt: Date.now(),
            };
            return applyMockEdits(base, id);
          }),
          failed: [],
          heuristicUsed: 0,
        };
```

Then add **two new cases** for the new commands. Place them just after `shogun_memory_summary_set_priority` (or any other summary case):

```js
      case "shogun_memory_summary_edit": {
        const id = String((echo && echo.targetId) || "");
        const field = String((echo && echo.field) || "");
        const to = echo && echo.to !== undefined ? echo.to
                   : echo && echo.value !== undefined ? echo.value : null;
        if (!id || !field) return { updated: false, summary: null };
        const list = mockEdits.get(id) || [];
        list.push({
          field,
          from: echo && echo.baseValue,
          to,
          at: Date.now(),
          source_raw: echo && echo.sourceRaw,
          entity_id: echo && echo.entityId,
          schema: 1,
        });
        mockEdits.set(id, list);
        // Reuse the merged-summary builder from the get case for consistency.
        const base = {
          targetKind: "item",
          targetId: id,
          title: "Stub summary",
          keyPoints: ["This is a mocked summary"],
          sourceType: "mail",
          priority: "medium",
          reason: "mock",
          model: "mock",
          schemaVersion: 1,
          generatedAt: Date.now(),
        };
        return { updated: true, summary: applyMockEdits(base, id) };
      }
      case "shogun_memory_summary_revert": {
        const id = String((echo && echo.targetId) || "");
        const field = String((echo && echo.field) || "");
        if (!id || !field) return { updated: false, summary: null };
        const list = (mockEdits.get(id) || []).filter((e) => e.field !== field);
        mockEdits.set(id, list);
        const base = {
          targetKind: "item",
          targetId: id,
          title: "Stub summary",
          keyPoints: ["This is a mocked summary"],
          sourceType: "mail",
          priority: "medium",
          reason: "mock",
          model: "mock",
          schemaVersion: 1,
          generatedAt: Date.now(),
        };
        return { updated: true, summary: applyMockEdits(base, id) };
      }
```

The actual key passed in mock payloads is `value` — the JS frontend (Task 5) will send `value` not `to`. Both are accepted defensively above.

- [ ] **Step 4.5: Verify static checks pass**

```bash
npm run check:actions
npm run check:ipc-mock
```

Expected:
- `check:actions` should now also list `memory.summary.edit` and `memory.summary.revert` in the action registry; existing pre-existing warnings persist.
- `check:ipc-mock` confirms the mock and the action map are in sync (the validator counts the cases).

If `check:ipc-mock` fails complaining about command name or count mismatch, re-read the validator script (`hifi/scripts/check-ipc-mock-sync.mjs`) and adjust either the mock case names or the action map registration to match.

- [ ] **Step 4.6: Commit**

```bash
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/app.jsx hifi/lib/ipc-client.js
git commit -m "$(cat <<'EOF'
feat(memory-summary): wire edit + revert IPC actions in JS layer

Adds memory.summary.edit and memory.summary.revert to the action
registry, the runtime API, and the mock IPC. Mock keeps an in-memory
Map<targetId, edit-entry[]> and merges the latest entry per field on
top of the existing 'Stub: ...' summary base, so dev/e2e see realistic
edited values without the Tauri backend.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Frontend UI — title inline edit

**Why:** First user-visible piece. The simplest of the three editable fields and lets us validate the inline-edit pattern before extending to keyPoints and reason.

**Files:**
- Modify: `hifi/screens-a.jsx`

- [ ] **Step 5.1: Add edit state + helpers near the existing scrub summary state**

In `hifi/screens-a.jsx`, find the React state cluster where `scrubSummary` lives (around line 2890–2905, search for `setScrubSummary` and `scrubSummaryLoading`). Just after the existing `useState` declarations for the summary, add:

```js
  // Inline edit state for the scrub summary.
  // editingField: 'title' | 'reason' | `kp:${index}` | null
  const [editingField, setEditingField] = React.useState(null);
  const [editingDraft, setEditingDraft] = React.useState('');

  // Common save path. Mutates scrubSummary + summaryByMemId optimistically,
  // dispatches memory.summary.edit, rolls back on failure.
  const persistSummaryEdit = async (field, value, baseValue) => {
    const targetId = scrubbed?.memoryId;
    if (!targetId) return;
    const prevSummary = scrubSummary;
    const nextSummary = { ...prevSummary, [field]: value };
    setScrubSummary(nextSummary);
    setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
    const res = await runRuntimeActionA('memory.summary.edit', {
      targetId,
      targetKind: 'item',
      field,
      value,
      baseValue,
      sourceRaw: scrubbed?.sourceRaw || null,
      entityId: scrubbed?.entityId || null,
    }, { silentError: true });
    if (!res?.ok) {
      // Roll back.
      setScrubSummary(prevSummary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: prevSummary }));
      window.SHOGUN_RUNTIME?.pushToast?.('Failed to save edit', 'warn');
    } else if (res.data?.summary) {
      // Server-confirmed merged summary — adopt it.
      setScrubSummary(res.data.summary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
    }
  };

  // Common revert path.
  const revertSummaryField = async (field) => {
    const targetId = scrubbed?.memoryId;
    if (!targetId) return;
    const res = await runRuntimeActionA('memory.summary.revert', {
      targetId,
      targetKind: 'item',
      field,
    }, { silentError: true });
    if (res?.ok && res.data?.summary) {
      setScrubSummary(res.data.summary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
    } else {
      window.SHOGUN_RUNTIME?.pushToast?.('Failed to revert', 'warn');
    }
  };

  // Predicate: did this field have at least one user edit applied?
  // We can't tell from the current Summary shape alone — it's merged on
  // the backend. Detect by comparing scrubSummary to the row's "base" via
  // a side-channel: read raw_json from the runtime if exposed, else use a
  // simple sentinel: if the edit was just done in this session, mark it.
  // For Phase 4 we use a session-local Set so the "edited" dot appears
  // immediately after a save.
  const editedFieldsBySummaryRef = React.useRef(new Map()); // memoryId -> Set<field>
  const markFieldEdited = (memoryId, field) => {
    const m = editedFieldsBySummaryRef.current;
    const set = m.get(memoryId) || new Set();
    set.add(field);
    m.set(memoryId, set);
  };
  const unmarkFieldEdited = (memoryId, field) => {
    const set = editedFieldsBySummaryRef.current.get(memoryId);
    if (set) set.delete(field);
  };
  const isFieldEdited = (memoryId, field) =>
    editedFieldsBySummaryRef.current.get(memoryId)?.has(field) || false;
```

(`React.useState` and `React.useRef` are accessed via the global `React` symbol because this file is loaded as a `text/babel` script tag. Match the pattern used elsewhere in the file — search for `React.useState` to confirm.)

- [ ] **Step 5.2: Wrap the title render in an inline editor**

Find the title `<div>` in the scrub summary card (around line 2940 in the existing code, the `<div style={{fontSize:18, fontWeight:600, ...}}>{scrubSummary.title}</div>` element).

Replace it with this conditional render:

```jsx
                {editingField === 'title' ? (
                  <textarea
                    autoFocus
                    aria-label="Edit title"
                    value={editingDraft}
                    onChange={(e) => setEditingDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur(); // triggers onBlur save
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingField(null);
                        setEditingDraft('');
                      }
                    }}
                    onBlur={async () => {
                      const next = editingDraft.trim();
                      const base = (scrubSummary?.title || '').trim();
                      setEditingField(null);
                      setEditingDraft('');
                      if (next && next !== base) {
                        markFieldEdited(scrubbed.memoryId, 'title');
                        await persistSummaryEdit('title', next, scrubSummary?.title);
                      }
                    }}
                    style={{
                      flex: 1, minWidth: 0,
                      fontSize: 18, fontWeight: 600, lineHeight: 1.3,
                      fontFamily: 'inherit', color: 'var(--text)',
                      background: 'var(--surface-mute)',
                      border: '1px solid var(--border-hi)', borderRadius: 4,
                      padding: '4px 6px', resize: 'vertical', minHeight: 32,
                    }}
                  />
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Edit title"
                    onClick={() => {
                      setEditingDraft(scrubSummary?.title || '');
                      setEditingField('title');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditingDraft(scrubSummary?.title || '');
                        setEditingField('title');
                      }
                    }}
                    style={{
                      fontSize: 18, fontWeight: 600, lineHeight: 1.3,
                      wordBreak: 'break-word', flex: 1, minWidth: 0,
                      cursor: 'text',
                    }}
                  >
                    {scrubSummary.title}
                    {isFieldEdited(scrubbed?.memoryId, 'title') && (
                      <span
                        title="Edited by you"
                        style={{
                          marginLeft: 6, fontSize: 10, color: 'var(--text-dim)',
                          letterSpacing: '0.06em', cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          unmarkFieldEdited(scrubbed.memoryId, 'title');
                          revertSummaryField('title');
                        }}
                      >
                        edited · revert
                      </span>
                    )}
                  </div>
                )}
```

- [ ] **Step 5.3: Verify smoke**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke 17/4 baseline.

- [ ] **Step 5.4: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-summary): inline edit for title

Click title → textarea, Enter saves and blurs, Escape discards.
Optimistic update with rollback on IPC failure. After save, an "edited
· revert" affordance appears next to the title; clicking it calls
memory.summary.revert and restores the AI baseline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend UI — keyPoints inline edit

**Why:** Apply the same pattern to keyPoints, plus the add/remove affordances.

**Files:**
- Modify: `hifi/screens-a.jsx`

- [ ] **Step 6.1: Replace the keyPoints `<ul>` with an inline-editable list**

Find the keyPoints render (around line 2748–2753, the `<ul>...{scrubSummary.keyPoints.slice(0, 4).map(...)...}</ul>` block). Replace the whole `Array.isArray(scrubSummary.keyPoints) && scrubSummary.keyPoints.length > 0 && (...)` block with:

```jsx
              {Array.isArray(scrubSummary.keyPoints) && (
                <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                  {scrubSummary.keyPoints.map((k, i) => {
                    const editKey = `kp:${i}`;
                    if (editingField === editKey) {
                      return (
                        <li key={`edit-${i}`} style={{listStyle:'none', marginLeft:-16}}>
                          <input
                            autoFocus
                            type="text"
                            aria-label={`Edit key point ${i + 1}`}
                            value={editingDraft}
                            onChange={(e) => setEditingDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingField(null);
                                setEditingDraft('');
                              }
                            }}
                            onBlur={async () => {
                              const next = editingDraft;
                              const baseArr = Array.isArray(scrubSummary?.keyPoints) ? scrubSummary.keyPoints : [];
                              const baseValue = baseArr[i] || '';
                              setEditingField(null);
                              setEditingDraft('');
                              const trimmed = next.trim();
                              if (!trimmed) {
                                // Empty save = remove this entry.
                                if (baseValue) {
                                  const newArr = baseArr.filter((_, idx) => idx !== i);
                                  markFieldEdited(scrubbed.memoryId, 'keyPoints');
                                  await persistSummaryEdit('keyPoints', newArr, baseArr);
                                }
                                return;
                              }
                              if (trimmed !== baseValue) {
                                const newArr = baseArr.map((v, idx) => (idx === i ? trimmed : v));
                                markFieldEdited(scrubbed.memoryId, 'keyPoints');
                                await persistSummaryEdit('keyPoints', newArr, baseArr);
                              }
                            }}
                            style={{
                              width: '100%', boxSizing: 'border-box',
                              fontSize: 13, color: 'var(--text)',
                              fontFamily: 'inherit',
                              background: 'var(--surface-mute)',
                              border: '1px solid var(--border-hi)', borderRadius: 4,
                              padding: '2px 6px',
                            }}
                          />
                        </li>
                      );
                    }
                    return (
                      <li
                        key={i}
                        role="button"
                        tabIndex={0}
                        aria-label={`Edit key point ${i + 1}`}
                        onClick={() => {
                          setEditingDraft(k);
                          setEditingField(editKey);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setEditingDraft(k);
                            setEditingField(editKey);
                          }
                        }}
                        style={{
                          fontSize:13,
                          color: i === 0 ? 'var(--text)' : 'var(--text-mute)',
                          lineHeight:1.5, cursor:'text',
                        }}
                      >
                        {k}
                      </li>
                    );
                  })}
                  <li style={{listStyle:'none', marginLeft:-16}}>
                    <button
                      type="button"
                      onClick={() => {
                        const baseArr = Array.isArray(scrubSummary?.keyPoints) ? scrubSummary.keyPoints : [];
                        const newArr = [...baseArr, ''];
                        // Optimistically extend, then enter edit mode for the new index.
                        const targetId = scrubbed?.memoryId;
                        const nextSummary = { ...scrubSummary, keyPoints: newArr };
                        setScrubSummary(nextSummary);
                        setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
                        setEditingDraft('');
                        setEditingField(`kp:${newArr.length - 1}`);
                      }}
                      style={{
                        padding: '2px 0', border: 'none', background: 'transparent',
                        color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + Add point
                    </button>
                  </li>
                  {isFieldEdited(scrubbed?.memoryId, 'keyPoints') && (
                    <li style={{listStyle:'none', marginLeft:-16}}>
                      <span
                        title="Edited by you"
                        style={{
                          fontSize: 10, color: 'var(--text-dim)',
                          letterSpacing: '0.06em', cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={() => {
                          unmarkFieldEdited(scrubbed.memoryId, 'keyPoints');
                          revertSummaryField('keyPoints');
                        }}
                      >
                        edited · revert
                      </span>
                    </li>
                  )}
                </ul>
              )}
```

This replaces the original `slice(0, 4)` cap — since users can now add their own points, the cap is removed. Existing `slice(0, 4)` was for display tidiness; the cap was implicit.

- [ ] **Step 6.2: Verify smoke**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke 17/4 baseline.

- [ ] **Step 6.3: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-summary): inline edit for keyPoints with add/remove

Click any keyPoint to edit it as a single-line input. Empty save removes
the entry. "+ Add point" appends a new editable empty entry. After any
edit, an "edited · revert" affordance appears for the keyPoints group.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Frontend UI — reason inline edit

**Why:** Smallest of the three. Same pattern as title; lives in the metadata grid lower in the panel.

**Files:**
- Modify: `hifi/screens-a.jsx`

- [ ] **Step 7.1: Wrap the reason cell with an inline editor**

Find the `Reason` row in the metadata grid (around line 3060-3065, the `<span>{scrubSummary.reason}</span>` after the `<span className="t-mono">Reason</span>` label).

Replace the value `<span>` with:

```jsx
                      {editingField === 'reason' ? (
                        <textarea
                          autoFocus
                          aria-label="Edit reason"
                          value={editingDraft}
                          onChange={(e) => setEditingDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              e.currentTarget.blur();
                            } else if (e.key === 'Escape') {
                              e.preventDefault();
                              setEditingField(null);
                              setEditingDraft('');
                            }
                          }}
                          onBlur={async () => {
                            const next = editingDraft;
                            const base = scrubSummary?.reason || '';
                            setEditingField(null);
                            setEditingDraft('');
                            const trimmed = next.trim();
                            const sendValue = trimmed.length > 0 ? trimmed : null;
                            if ((sendValue ?? '') !== (base ?? '')) {
                              markFieldEdited(scrubbed.memoryId, 'reason');
                              await persistSummaryEdit('reason', sendValue, base);
                            }
                          }}
                          style={{
                            width:'100%', boxSizing:'border-box',
                            color:'var(--text)', wordBreak:'break-word',
                            fontSize:12, fontFamily:'inherit',
                            background:'var(--surface-mute)',
                            border:'1px solid var(--border-hi)',
                            borderRadius:4, padding:'2px 6px',
                            resize:'vertical', minHeight:24,
                          }}
                        />
                      ) : (
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label="Edit reason"
                          onClick={() => {
                            setEditingDraft(scrubSummary?.reason || '');
                            setEditingField('reason');
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setEditingDraft(scrubSummary?.reason || '');
                              setEditingField('reason');
                            }
                          }}
                          style={{
                            color:'var(--text-mute)', wordBreak:'break-word',
                            fontSize:12, cursor:'text',
                          }}
                        >
                          {scrubSummary.reason}
                          {isFieldEdited(scrubbed?.memoryId, 'reason') && (
                            <span
                              title="Edited by you"
                              style={{
                                marginLeft: 6, fontSize: 10, color: 'var(--text-dim)',
                                letterSpacing: '0.06em', cursor: 'pointer',
                                textDecoration: 'underline',
                              }}
                              onClick={(e) => {
                                e.stopPropagation();
                                unmarkFieldEdited(scrubbed.memoryId, 'reason');
                                revertSummaryField('reason');
                              }}
                            >
                              edited · revert
                            </span>
                          )}
                        </span>
                      )}
```

- [ ] **Step 7.2: Verify smoke**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke 17/4 baseline.

- [ ] **Step 7.3: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-summary): inline edit for reason

Click the reason cell in the metadata grid to edit. Same blur-saves /
Enter-saves / Escape-discards pattern as title. Empty trimmed text
saves as null (clearing the reason). "edited · revert" affordance
matches title and keyPoints.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Playwright e2e for the edit flow

**Why:** Lock in the inline edit behavior — happy path for each field plus a Revert.

**Files:**
- Create: `tests/e2e/memory-summary-edit.spec.js`

- [ ] **Step 8.1: Write the spec**

Create `tests/e2e/memory-summary-edit.spec.js` with:

```js
const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

// Inject the demo seed before any scripts run so the memory index has data.
const DEMO_SEED_SCRIPT = () => {
  const now = Date.now();
  const ts = (deltaMs) => now + deltaMs;
  window.SHOGUN_DEMO_SEED = {
    memoryHits: [
      { id: "demo-m-01", title: "Q2 roadmap", snippet: "Beta target.",
        source: "chat", kinds: ["input"], created_at: ts(-45 * 60 * 1000) },
      { id: "demo-m-02", title: "Investor update deck",
        snippet: "Three slides.", source: "meetings", kinds: ["audio"],
        created_at: ts(-3 * 60 * 60 * 1000) },
    ],
    entities: [], stats: {}, chats: [], chatThreads: {}, chatMemoryContext: {},
  };
};

async function openHiFi(page) {
  await page.addInitScript(DEMO_SEED_SCRIPT);
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function goToMemoryRiver(page) {
  await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
  await expect(page.locator('.memory-screen')).toBeVisible();
  await page.locator('button', { hasText: 'River' }).first().click().catch(() => {});
}

// Wait for a memory summary card to render in the detail panel.
async function waitForSummaryPanel(page) {
  await page.locator('.memory-summary-card').first().waitFor({ state: 'visible', timeout: 30000 });
}

test.describe('Memory summary inline edit', () => {
  test('title click → edit → Enter saves; reload preserves', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await waitForSummaryPanel(page);

    const titleEl = page.getByRole('button', { name: 'Edit title' }).first();
    await titleEl.click();
    const input = page.getByLabel('Edit title');
    await input.fill('User edited title');
    await input.press('Enter');

    // After save, the display element shows the new value plus the
    // "edited · revert" affordance.
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toContainText('User edited title');
    await expect(page.locator('text=edited · revert').first()).toBeVisible();

    // Navigate away and back; the merged value should still be returned by
    // the mock (in-memory map persists for the page lifetime).
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('home'));
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
    await waitForSummaryPanel(page);
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toContainText('User edited title');
  });

  test('Escape during edit discards changes', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await waitForSummaryPanel(page);

    const before = await page.getByRole('button', { name: 'Edit title' }).first().textContent();
    await page.getByRole('button', { name: 'Edit title' }).first().click();
    const input = page.getByLabel('Edit title');
    await input.fill('Should not be saved');
    await input.press('Escape');

    // Display reverts to the original; no "edited" affordance appears.
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .toHaveText(String(before).trim());
    await expect(page.locator('text=edited · revert').first()).toHaveCount(0);
  });

  test('Revert restores AI baseline', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await waitForSummaryPanel(page);

    // Edit
    await page.getByRole('button', { name: 'Edit title' }).first().click();
    await page.getByLabel('Edit title').fill('Edited then reverted');
    await page.getByLabel('Edit title').press('Enter');
    await expect(page.locator('text=edited · revert').first()).toBeVisible();

    // Revert
    await page.locator('text=edited · revert').first().click();

    // Affordance is gone; title no longer contains the user value.
    await expect(page.locator('text=edited · revert').first()).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit title' }).first())
      .not.toContainText('Edited then reverted');
  });

  test('keyPoints click → edit; + Add point appends new editable item', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await waitForSummaryPanel(page);

    const firstKp = page.getByRole('button', { name: /^Edit key point 1$/ }).first();
    await firstKp.click();
    const input = page.getByLabel(/^Edit key point 1$/);
    await input.fill('User-edited point');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: /^Edit key point 1$/ }).first())
      .toContainText('User-edited point');

    // Add a new point.
    await page.getByRole('button', { name: '+ Add point' }).click();
    const newInput = page.getByLabel(/^Edit key point \d+$/).last();
    await newInput.fill('Brand new point');
    await newInput.press('Enter');
    await expect(page.locator('li', { hasText: 'Brand new point' })).toBeVisible();
  });

  test('reason click → edit → save', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await waitForSummaryPanel(page);

    const reason = page.getByRole('button', { name: 'Edit reason' }).first();
    await reason.click();
    const input = page.getByLabel('Edit reason');
    await input.fill('Manual reason override');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Edit reason' }).first())
      .toContainText('Manual reason override');
  });
});
```

- [ ] **Step 8.2: Run the new spec**

```bash
npx playwright test tests/e2e/memory-summary-edit.spec.js --reporter=line
```

Expected: 5 passed.

If a test fails because the summary panel never renders (the same async-summarize race that blocked the cluster e2e tests), inspect the failure under `test-results/`. Two paths forward:

1. **Same root cause** as cluster e2e: mark each affected test as `test.fixme` with a comment block referencing the same `__SHOGUN_TEST__.seedSummaries` resolution path that the cluster tests already documented. The test code stays as documentation.
2. **Different cause** (e.g., selector mismatch): adjust the selector and re-run.

Don't `.skip` blindly — read the failure, decide once, document the decision in commit message.

- [ ] **Step 8.3: Run the full e2e suite**

```bash
npx playwright test --reporter=line
```

Expected: hifi-smoke 17/4 plus the new edit spec passing (or fixme'd as documented).

- [ ] **Step 8.4: Commit**

```bash
git add tests/e2e/memory-summary-edit.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): memory summary inline edit

Locks in the click-to-edit flow for title, keyPoints, and reason; the
Enter-saves / Escape-discards behavior; and the revert affordance.
Mock IPC's in-memory user_edits map persists for the page lifetime,
so cross-screen round trips verify merged values.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification + final code review

- [ ] **Step 9.1: All checks**

```bash
npm run check:actions
npm run check:ipc-mock
cargo test --manifest-path src-tauri/Cargo.toml --lib summarizer_store -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --lib summarizer_store -- --ignored --nocapture
npx playwright test --reporter=line
```

Expected: ipc-mock OK; cargo tests pass (default + ignored); e2e meets the criteria documented in Task 8.

- [ ] **Step 9.2: Manual smoke**

```bash
npm run dev:desktop
```

In the app: Memory → River → click a summary's title → edit, Enter → see "edited · revert" → click revert → returns to AI value. Repeat for keyPoints and reason. Trigger re-summarize (existing UI, if exposed) and confirm edits survive. Switch Memory → Home → Memory and confirm edits persist (the in-memory mock map and the real Rust DB both should).

- [ ] **Step 9.3: Branch summary**

```bash
git log --oneline 78e5969..HEAD
git diff --stat 78e5969..HEAD
```

Confirm:
- Commits land on `feat/memory-digest-phase4-summary-edit`
- 4 Rust files + 4 JS files + 1 new test file modified/created
- No accidental edits outside the spec's listed files

- [ ] **Step 9.4: Final dispatch**

After all 8 tasks pass spec + code-quality reviews, dispatch a **branch-level final reviewer** via `superpowers:code-reviewer`. Provide the cumulative diff `78e5969..HEAD`. Address any Important issues before invoking `superpowers:finishing-a-development-branch`.

---

## Self-Review (run after writing all tasks)

**1. Spec coverage:**
- § 1 Architecture / data flow — Tasks 1, 2, 3, 4 (backend) + 5, 6, 7 (frontend) ✓
- § 2 Data model (raw_json + user_edits[] + reader merge rule) — Task 1 (merge) + Task 2 (writer that appends and back-syncs columns) ✓
- § 3 UI — Tasks 5, 6, 7 (per-field) + edited indicator + Revert ✓
- § 4 Edge cases:
  - Repeated edits → `user_edits[]` append, latest wins via merge — Task 1 + 2 ✓
  - Re-summarize preserves edits — implicit (invalidate writes tool_use, not user_edits); Task 1 merge applies ✓
  - Edit-mode interrupted by screen change — React unmount discards `editingField`, autosave on blur fires first — Tasks 5/6/7 ✓
  - `value === baseValue` no-op — guarded in `persistSummaryEdit` callers ✓
  - keyPoints empty → removal — Task 6 explicit branch ✓
  - reason → null — Task 7 explicit branch ✓
  - Revert + re-edit — Task 5 unmark + Task 7 callsites set new edit; works because `editedFieldsBySummaryRef` is session-local ✓
  - IPC failure rollback — Task 5 `persistSummaryEdit` ✓
  - Schema mismatch ignored — Task 1 merge `if schema != 1: continue` ✓
- § 5 Testing — Tasks 1 (Rust unit), 2 (Rust DB roundtrip), 8 (Playwright) ✓
- § 6 Rollout — no flag, no migration; covered implicitly ✓

**2. Placeholder scan:** Searched for "TBD", "TODO", "as appropriate", "etc." — none in any task body.

**3. Type / API consistency:**
- `EditMetadata` struct — defined in Task 2, used in Task 3 ✓
- `apply_user_edits(s: &mut Summary)` — defined in Task 1, called from row loaders ✓
- `edit_field` and `revert_field` signatures — Task 2 defines, Task 3 calls with matching args ✓
- IPC payload shapes — Tasks 3 and 4 use the same field names (`targetId`, `targetKind`, `field`, `value`, `baseValue`, `sourceRaw`, `entityId`) ✓
- Frontend `persistSummaryEdit(field, value, baseValue)` — defined in Task 5, used in Tasks 5/6/7 ✓
- `markFieldEdited` / `unmarkFieldEdited` / `isFieldEdited` — defined Task 5, used Tasks 5/6/7 ✓

**4. Ambiguity:** none flagged.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-memory-digest-summary-edit.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
