# KIOKU Sub-spec H — LLM Cost Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every Anthropic API call driven by KIOKU Sub-spec A / D / E into `cost_ledger`, and surface the monthly total + per-purpose breakdown in Settings → KIOKU Graph.

**Architecture:** Migrate four `anthropic_tool_complete` callsites to `anthropic_tool_complete_with_usage` (existing fn used by kioku_extraction) and emit `cost_ledger::record` per call. Add three new PURPOSE constants + one aggregator fn `sum_cost_in_window_by_purpose` + one new Tauri command `shogun_kioku_cost_summary`. PaneKiokuGraph renders a `Cost This Month` card. No schema changes.

**Tech Stack:** Rust (rusqlite, std::collections::HashMap, serde_json), React 19 (useStateS / useRuntimeActions). Existing `crate::llm::anthropic_tool_complete_with_usage` returns `AnthropicToolResult { input, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, resolved_model }`.

**Spec:** `docs/superpowers/specs/2026-04-30-kioku-cost-visibility-design.md`

---

## File Map

**Modified:**
- `src-tauri/src/cost_ledger.rs` — `+3` PURPOSE constants + `sum_cost_in_window_by_purpose` fn (~30 LOC).
- `src-tauri/src/commands.rs` — migrate 2 callsites (`shogun_lesson_capture_rejection`, `shogun_lesson_capture_tool_failure`) + add `shogun_kioku_cost_summary` (~80 LOC).
- `src-tauri/src/supersession.rs` — migrate `judge_contradiction` callsite (~20 LOC).
- `src-tauri/src/lessons_verifier.rs` — migrate `call_judge` callsite (~20 LOC).
- `src-tauri/src/lib.rs` — register `commands::shogun_kioku_cost_summary` in invoke_handler (1 LOC).
- `hifi/lib/shogun-api.js` — `kiokuCostSummary` binding (1 LOC).
- `hifi/lib/action-registry.js` — `kioku.cost_summary` register (1 LOC).
- `hifi/action-map.md` — entry (1 LOC).
- `hifi/settings-modal.jsx` — `PaneKiokuGraph` Cost This Month section + state + fetch (~50 LOC).

**Created:** none.

**No tests in scope** (per spec § 11 — manual eye-test only). Verification = `npm run check:rust` + `check:ipc-mock` + `check-actions` + manual SQLite + UI walkthrough.

---

## Task 1: `cost_ledger.rs` PURPOSE constants + `sum_cost_in_window_by_purpose`

**Files:**
- Modify: `src-tauri/src/cost_ledger.rs:30-34` — add 3 new PURPOSE constants.
- Modify: `src-tauri/src/cost_ledger.rs` — add `sum_cost_in_window_by_purpose` fn after `sum_cost_in_window`.

- [ ] **Step 1: Add 3 new PURPOSE constants**

Use Edit on `src-tauri/src/cost_ledger.rs`. `old_string`:

```rust
pub const PURPOSE_EXTRACTION: &str = "extraction";
pub const PURPOSE_SUMMARIZE: &str = "summarize";
pub const PURPOSE_EMBED: &str = "embed";
```

`new_string`:

```rust
pub const PURPOSE_EXTRACTION: &str = "extraction";
pub const PURPOSE_SUMMARIZE: &str = "summarize";
pub const PURPOSE_EMBED: &str = "embed";
pub const PURPOSE_LESSON_GENERATION: &str = "lesson_generation";
pub const PURPOSE_LESSON_SUPERSESSION: &str = "lesson_supersession";
pub const PURPOSE_LESSON_VERIFIER: &str = "lesson_verifier";
```

- [ ] **Step 2: Add `sum_cost_in_window_by_purpose` fn**

Locate the existing `sum_cost_in_window` fn (around line 190-203). Use Edit to add the new fn AFTER it. Read 5 lines around the closing brace to find the exact end.

`old_string` (the closing of `sum_cost_in_window` — pick the last 4 lines that are unique):

```rust
    .map_err(|e| format!("cost_ledger::sum_cost_in_window: {}", e))?;
  Ok(sum)
}
```

`new_string`:

```rust
    .map_err(|e| format!("cost_ledger::sum_cost_in_window: {}", e))?;
  Ok(sum)
}

/// Sum `cost_usd` per purpose for rows in `[since_ms, until_ms)`. Used by
/// the KIOKU Graph cost summary view to render a per-category breakdown.
pub fn sum_cost_in_window_by_purpose(
  conn: &Connection,
  since_ms: i64,
  until_ms: i64,
) -> Result<std::collections::HashMap<String, f64>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT purpose, COALESCE(SUM(cost_usd), 0.0)
       FROM cost_ledger
       WHERE recorded_at >= ?1 AND recorded_at < ?2
       GROUP BY purpose",
    )
    .map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose prepare: {}", e))?;
  let rows = stmt
    .query_map(rusqlite::params![since_ms, until_ms], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })
    .map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose query: {}", e))?;
  let mut out: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
  for r in rows {
    let (purpose, sum) =
      r.map_err(|e| format!("cost_ledger::sum_cost_in_window_by_purpose row: {}", e))?;
    out.insert(purpose, sum);
  }
  Ok(out)
}
```

NOTE: this fn uses fully-qualified `rusqlite::params!` and `std::collections::HashMap` to avoid touching imports at the top of the file. If those imports are already present, fully-qualified usage still works.

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. Warnings on `PURPOSE_LESSON_*` constants and `sum_cost_in_window_by_purpose` are EXPECTED (consumed in Tasks 2-5).

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/cost_ledger.rs
git diff --cached --stat
git commit -m "feat(kioku): cost_ledger — 3 PURPOSE constants + sum_cost_in_window_by_purpose"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file. Otherwise REVERT (`git reset HEAD~1 --soft`) and report BLOCKED.

---

## Task 2: Migrate `commands.rs::shogun_lesson_capture_rejection`

**Files:**
- Modify: `src-tauri/src/commands.rs:2180` — switch `anthropic_tool_complete` to `_with_usage` + record cost.

The existing match expression assigns `rule` from the unwrapped `input` value. We need to keep the same overall control flow (assign `rule` from the result) while adding cost recording inside the `Ok` arm.

- [ ] **Step 1: Migrate the callsite**

Use Edit on `src-tauri/src/commands.rs`. `old_string`:

```rust
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
```

`new_string`:

```rust
  let rule = match crate::llm::anthropic_tool_complete_with_usage(system, &user_content, &tool, "claude-haiku-4-5-20251001").await {
    Ok(result) => {
      // Sub-spec H: record cost (best-effort, never fails this op)
      if let Ok(conn) = crate::memory_store::open_conn() {
        let cost = crate::cost_ledger::calc_cost_with_cache(
          &result.resolved_model,
          result.input_tokens,
          result.cache_creation_input_tokens,
          result.cache_read_input_tokens,
          result.output_tokens,
        )
        .unwrap_or(0.0);
        let now_ms = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_millis() as i64)
          .unwrap_or(0);
        let entry = crate::cost_ledger::LedgerEntry {
          recorded_at_ms: now_ms,
          model: result.resolved_model.clone(),
          purpose: crate::cost_ledger::PURPOSE_LESSON_GENERATION.to_string(),
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_usd: cost,
          job_id: None,
          meta_json: None,
        };
        let _ = crate::cost_ledger::record(&entry, &conn);
      }
      result.input
        .get("rule")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
          let date = chrono::Local::now().format("%Y-%m-%d");
          format!("Avoid replies similar to one rejected on {}", date)
        })
    }
    Err(e) => {
      log::warn!("lesson rejection rule LLM error: {}", e);
      let date = chrono::Local::now().format("%Y-%m-%d");
      format!("Avoid replies similar to one rejected on {}", date)
    }
```

NOTE: `calc_cost_with_cache` signature is `(model, input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens)` — verify by reading `src-tauri/src/cost_ledger.rs:122` before applying. Adjust argument order if needed.

- [ ] **Step 2: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS.

If you see `calc_cost_with_cache: argument count mismatch`, re-check the signature. The fn in cost_ledger.rs line 122 takes 5 args. Read those lines and align the call.

If you see `LedgerEntry: missing field`, the struct shape changed; read its definition (around line 148-159) and align fields.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs
git diff --cached --stat
git commit -m "feat(kioku): record lesson_generation cost in shogun_lesson_capture_rejection"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 3: Migrate `commands.rs::shogun_lesson_capture_tool_failure`

**Files:**
- Modify: `src-tauri/src/commands.rs:2284` — same pattern as Task 2.

The function `shogun_lesson_capture_tool_failure` (around line 2220) has a parallel structure. The `anthropic_tool_complete` call is around line 2284.

- [ ] **Step 1: Read the existing block**

```bash
sed -n '2280,2310p' src-tauri/src/commands.rs
```

The block has the same shape as Task 2 (same `Ok(input) => input.get("rule")...` plus `Err(e) =>` fallback) but with a different log message and different fallback text.

- [ ] **Step 2: Migrate the callsite**

Apply the same transformation as Task 2 Step 1:
- Change `anthropic_tool_complete` to `anthropic_tool_complete_with_usage`.
- Wrap the `Ok` arm in a block that:
  - Records cost via the same 25-line snippet from Task 2 Step 1.
  - Uses `result.input` instead of `input` for the rule extraction.
  - Uses `crate::cost_ledger::PURPOSE_LESSON_GENERATION` (same purpose — both rejection and tool_failure are "lesson rule generation").
- Leave the `Err` arm untouched (its fallback text and log message stay).

The exact `old_string` is the parallel block in `shogun_lesson_capture_tool_failure`:

```bash
sed -n '2284,2308p' src-tauri/src/commands.rs
```

Construct the Edit with the EXACT block from sed output as `old_string` and the same Task 2 Step 1 transformation as `new_string`.

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs
git diff --cached --stat
git commit -m "feat(kioku): record lesson_generation cost in shogun_lesson_capture_tool_failure"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 4: Migrate `supersession.rs::judge_contradiction`

**Files:**
- Modify: `src-tauri/src/supersession.rs:58-70` — switch `anthropic_tool_complete` to `_with_usage` + record cost.

- [ ] **Step 1: Migrate the callsite**

Use Edit on `src-tauri/src/supersession.rs`. `old_string`:

```rust
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
```

`new_string`:

```rust
async fn judge_contradiction(older_rule: &str, newer_rule: &str) -> Option<bool> {
  let user_msg = format!("OLDER: {}\nNEWER: {}", older_rule, newer_rule);
  let tool = judge_tool();
  match crate::llm::anthropic_tool_complete_with_usage(JUDGE_SYSTEM_PROMPT, &user_msg, &tool, MODEL).await {
    Ok(result) => {
      // Sub-spec H: record cost (best-effort, never fails this op)
      if let Ok(conn) = crate::memory_store::open_conn() {
        let cost = crate::cost_ledger::calc_cost_with_cache(
          &result.resolved_model,
          result.input_tokens,
          result.cache_creation_input_tokens,
          result.cache_read_input_tokens,
          result.output_tokens,
        )
        .unwrap_or(0.0);
        let now_ms = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_millis() as i64)
          .unwrap_or(0);
        let entry = crate::cost_ledger::LedgerEntry {
          recorded_at_ms: now_ms,
          model: result.resolved_model.clone(),
          purpose: crate::cost_ledger::PURPOSE_LESSON_SUPERSESSION.to_string(),
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_usd: cost,
          job_id: None,
          meta_json: None,
        };
        let _ = crate::cost_ledger::record(&entry, &conn);
      }
      result.input
        .get("contradicts")
        .and_then(|v| v.as_bool())
    }
    Err(e) => {
      log::warn!("supersession judge failed: {}", e);
      None
    }
  }
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
git add src-tauri/src/supersession.rs
git diff --cached --stat
git commit -m "feat(kioku): record lesson_supersession cost in judge_contradiction"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 5: Migrate `lessons_verifier.rs::call_judge`

**Files:**
- Modify: `src-tauri/src/lessons_verifier.rs:102-145` — switch `anthropic_tool_complete` to `_with_usage` + record cost.

- [ ] **Step 1: Migrate the callsite**

Use Edit on `src-tauri/src/lessons_verifier.rs`. `old_string`:

```rust
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
```

`new_string`:

```rust
  match crate::llm::anthropic_tool_complete_with_usage(
    JUDGE_SYSTEM_PROMPT,
    &user_content,
    &tool,
    MODEL,
  )
  .await
  {
    Ok(result) => {
      // Sub-spec H: record cost (best-effort, never fails this op)
      if let Ok(conn) = crate::memory_store::open_conn() {
        let cost = crate::cost_ledger::calc_cost_with_cache(
          &result.resolved_model,
          result.input_tokens,
          result.cache_creation_input_tokens,
          result.cache_read_input_tokens,
          result.output_tokens,
        )
        .unwrap_or(0.0);
        let now_ms = std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_millis() as i64)
          .unwrap_or(0);
        let entry = crate::cost_ledger::LedgerEntry {
          recorded_at_ms: now_ms,
          model: result.resolved_model.clone(),
          purpose: crate::cost_ledger::PURPOSE_LESSON_VERIFIER.to_string(),
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cost_usd: cost,
          job_id: None,
          meta_json: None,
        };
        let _ = crate::cost_ledger::record(&entry, &conn);
      }
      let judgments = match result.input.get("judgments").and_then(|v| v.as_array()) {
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
```

NOTE: in this callsite, `judgments` was previously a borrow into `input`. Now it borrows from `result.input`, but the cost recording block above creates a `result` value that lives for the entire match arm — so the borrow chain stays valid. If the borrow checker complains about lifetime, hoist the cost recording to BEFORE the `let judgments = ...` line within the same arm.

- [ ] **Step 2: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/lessons_verifier.rs
git diff --cached --stat
git commit -m "feat(kioku): record lesson_verifier cost in call_judge"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 6: `shogun_kioku_cost_summary` command + IPC plumbing

**Files:**
- Modify: `src-tauri/src/commands.rs` — add `shogun_kioku_cost_summary` near other KIOKU read commands.
- Modify: `src-tauri/src/lib.rs` — register in invoke_handler.
- Modify: `hifi/lib/shogun-api.js` — `kiokuCostSummary` binding.
- Modify: `hifi/lib/action-registry.js` — `kioku.cost_summary` register.
- Modify: `hifi/action-map.md` — entry.

- [ ] **Step 1: Add `shogun_kioku_cost_summary` command**

Locate `shogun_lessons_stats` (around line 2385). Insert the new command BEFORE it. Use Edit. `old_string`:

```rust
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
```

`new_string`:

```rust
/// Sub-spec H: monthly cost breakdown for the KIOKU Graph settings panel.
/// Returns total + per-purpose USD spent in the current UTC calendar month,
/// plus configured cap.
#[tauri::command]
pub fn shogun_kioku_cost_summary(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let now_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0);
  let month_start = crate::cost_ledger::month_start_ms_utc(now_ms);

  let total = crate::cost_ledger::sum_cost_in_window(&conn, month_start, now_ms)?;
  let by_purpose =
    crate::cost_ledger::sum_cost_in_window_by_purpose(&conn, month_start, now_ms)?;

  let (cap_usd, cap_action) = match crate::settings_store::load() {
    Ok(doc) => {
      let cap = doc
        .pointer("/sections/kioku_cost/monthly_cap_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD);
      let action = doc
        .pointer("/sections/kioku_cost/cap_action")
        .and_then(|v| v.as_str())
        .unwrap_or(crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION)
        .to_string();
      (cap, action)
    }
    Err(_) => (
      crate::cost_ledger::DEFAULT_MONTHLY_CAP_USD,
      crate::cost_ledger::CAP_ACTION_PAUSE_EXTRACTION.to_string(),
    ),
  };

  Ok(serde_json::json!({
    "month_start_ms": month_start,
    "total_usd": total,
    "by_purpose": by_purpose,
    "cap_usd": cap_usd,
    "cap_action": cap_action,
  }))
}

#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
```

NOTE: `shogun_lessons_stats` already has `#[tauri::command]` above it. The `new_string` re-emits that attribute. Read the lines BEFORE `pub fn shogun_lessons_stats(...)` first to see if there's a doc comment + `#[tauri::command]` macro that needs to be preserved. If yes, the `old_string` should include those lines and `new_string` should preserve them at the bottom of the new content.

- [ ] **Step 2: Register in `lib.rs` invoke_handler**

Locate `commands::shogun_lessons_stats,` (line 277). Use Edit. `old_string`:

```
      commands::shogun_lessons_stats,
```

`new_string`:

```
      commands::shogun_kioku_cost_summary,
      commands::shogun_lessons_stats,
```

- [ ] **Step 3: Add API binding in `hifi/lib/shogun-api.js`**

Locate the existing `kiokuDebugStats` line. Use Edit. `old_string`:

```
      kiokuDebugStats: () => call("shogun_kioku_debug_stats", {}, READ),
```

`new_string`:

```
      kiokuDebugStats: () => call("shogun_kioku_debug_stats", {}, READ),
      kiokuCostSummary: (input) => call("shogun_kioku_cost_summary", input || {}, READ),
```

- [ ] **Step 4: Add register in `hifi/lib/action-registry.js`**

Locate `register("kioku.edge_type_review", ...)`. Use Edit. `old_string`:

```
    register("kioku.edge_type_review", (payload) => api.kiokuEdgeTypeReview(payload));
```

`new_string`:

```
    register("kioku.edge_type_review", (payload) => api.kiokuEdgeTypeReview(payload));
    register("kioku.cost_summary", (payload) => api.kiokuCostSummary(payload));
```

- [ ] **Step 5: Add entry in `hifi/action-map.md`**

Locate the existing `kioku.edge_type_review` entry in the action key list (search for line `- \`kioku.edge_type_review\``). Use Edit. `old_string`:

```
- `kioku.edge_type_review`
```

`new_string`:

```
- `kioku.edge_type_review`
- `kioku.cost_summary`
```

- [ ] **Step 6: Verify static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -3
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All must PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git diff --cached --stat
git commit -m "feat(kioku): shogun_kioku_cost_summary IPC command + plumbing"
git show HEAD --stat
```

Must show exactly 5 files.

---

## Task 7: `PaneKiokuGraph` Cost This Month section

**Files:**
- Modify: `hifi/settings-modal.jsx::PaneKiokuGraph` — add state + fetch + JSX section.

- [ ] **Step 1: Inspect existing PaneKiokuGraph state declarations**

```bash
grep -n "function PaneKiokuGraph\|const \[.*setStateS\]" hifi/settings-modal.jsx | head -25
```

Find a clean spot near the top of `PaneKiokuGraph` to add the new `costSummary` state. Existing state declarations are around lines 2952-3000.

- [ ] **Step 2: Add `costSummary` state declaration**

Locate an existing state declaration near the top of `PaneKiokuGraph`. Pick the LAST `const [..., setStateS] = useStateS(...);` line in the cluster as the anchor and add the new line after it.

For example, if the last existing state is `const [proposalsBusy, setProposalsBusy] = useStateS(false);`, use Edit. `old_string`:

```
  const [proposalsBusy, setProposalsBusy] = useStateS(false);
```

`new_string`:

```
  const [proposalsBusy, setProposalsBusy] = useStateS(false);

  // Sub-spec H: monthly cost summary
  const [costSummary, setCostSummary] = useStateS(null);
```

If that anchor isn't unique, pick a different anchor that IS unique within `PaneKiokuGraph` (e.g., an `useStateS` call paired with a comment that only appears once).

- [ ] **Step 3: Add fetch helper inside PaneKiokuGraph**

Find an existing `React.useCallback(async () => { ... }, [run])` or similar pattern in `PaneKiokuGraph`. Add the cost summary fetch helper near it:

```js
  const refreshCostSummary = React.useCallback(async () => {
    const r = await run('kioku.cost_summary', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data === 'object') {
      setCostSummary(r.data);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshCostSummary();
  }, [refreshCostSummary]);
```

The exact location: paste this block right after the existing `proposalsBusy` state declaration cluster, BEFORE the existing `React.useEffect(() => { void refreshProposals(); }, [refreshProposals]);` (or whichever existing useEffect is first). The fetch + useEffect pair is self-contained.

- [ ] **Step 4: Add PURPOSE_LABELS const**

Add this const at module-top scope in `hifi/settings-modal.jsx` (NOT inside a function). Pick a clean spot near the existing `PRODUCT` / `EMPTY_SETTINGS_SECURITY` constants (around line 32-92).

For example, after `const EMPTY_SETTINGS_SECURITY = {};` (line 92), use Edit. `old_string`:

```
const EMPTY_SETTINGS_SECURITY = {};
```

`new_string`:

```
const EMPTY_SETTINGS_SECURITY = {};

// Sub-spec H: PURPOSE → label for KIOKU cost breakdown
const KIOKU_COST_PURPOSE_LABELS = {
  extraction: 'Extraction',
  summarize: 'Summarize',
  embed: 'Embed',
  lesson_generation: 'Lesson generation',
  lesson_supersession: 'Lesson supersession',
  lesson_verifier: 'Lesson verifier',
};
```

- [ ] **Step 5: Add Cost This Month JSX**

Inside `PaneKiokuGraph`'s render block, find the existing `Cost cap` related JSX (search for `monthly_cap_usd` or the text `Cost cap`). The `Cost This Month` section goes immediately AFTER the `Cost cap` Row.

Read 30 lines around the cost cap area first:

```bash
grep -n "monthly_cap_usd\|Cost cap\|fallback_model" hifi/settings-modal.jsx | head -10
```

Identify the closing `</Row>` (or equivalent) of the cap settings UI. Use Edit. The `old_string` should be a unique anchor — typically the closing `</Row>` plus the next 1-2 lines. The `new_string` is the same anchor PLUS the new JSX block:

```jsx
      {costSummary && (
        <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginTop:'var(--space-3)'}}>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>
            COST THIS MONTH
          </div>
          <div className="t-sm" style={{color:'var(--text)', marginBottom:'var(--space-2)'}}>
            Total: ${(Number(costSummary.total_usd) || 0).toFixed(2)}
            {Number(costSummary.cap_usd) > 0 && (
              <span style={{color:'var(--text-mute)', marginLeft:'var(--space-2)'}}>
                / cap ${Number(costSummary.cap_usd).toFixed(2)}
              </span>
            )}
          </div>
          {costSummary.by_purpose && Object.keys(costSummary.by_purpose).length > 0 && (
            <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
              {Object.entries(costSummary.by_purpose).map(([purpose, usd]) => {
                const label = KIOKU_COST_PURPOSE_LABELS[purpose] || purpose;
                return (
                  <div key={purpose} className="t-sm" style={{color:'var(--text-mute)'}}>
                    · {label}: ${(Number(usd) || 0).toFixed(2)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
```

If you can't safely identify the cap settings anchor, STOP and report NEEDS_CONTEXT with line numbers around the cost cap UI.

- [ ] **Step 6: Verify static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -3
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

Both must PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/settings-modal.jsx
git diff --cached --stat
git commit -m "feat(kioku): KIOKU Graph — Cost This Month section"
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

- [ ] **Step 2: Spec § 11.2 manual walkthrough**

Prerequisite: Anthropic API key configured (env var or Keychain).

1. Rebuild and launch:
   ```bash
   cd /Users/torutano/ShogunAI3/ShogunAI3
   pgrep -f "target/debug/app" | xargs -r kill 2>&1
   sleep 2
   cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3
   bash scripts/tauri-dev-static-server.sh > /tmp/shogun-static-server.log 2>&1 &
   sleep 2
   nohup ./src-tauri/target/debug/app > /tmp/shogun3-app.log 2>&1 &
   sleep 4
   pgrep -fla "target/debug/app" | head -3
   ```

2. Trigger one of each KIOKU LLM call:
   - **Lesson generation**: Open Hummingbird, send a prompt, click `Bad response`. (Will trigger `shogun_lesson_capture_rejection` → records `lesson_generation`.)
   - **Lesson supersession**: From DevTools console:
     ```js
     await window.SHOGUN_RUNTIME.executeAction('supersession.run_now', {})
     ```
     (Requires at least 2 lessons in the table for the LLM judge to actually fire. Use synthetic seed from Sub-spec D § 10.3 if needed.)
   - **Lesson verifier**: Chat once with injected lessons (any normal chat with lessons in the active table fires the verifier async).

3. Inspect raw cost ledger:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT purpose, model, input_tokens, output_tokens, ROUND(cost_usd, 6) FROM cost_ledger WHERE purpose LIKE 'lesson_%' ORDER BY recorded_at DESC LIMIT 10;"
   ```
   Expect rows with at least one of `lesson_generation`, `lesson_supersession`, `lesson_verifier`.

4. Open Settings → KIOKU Graph → scroll to the **Cost This Month** card.
   - Confirm `Total: $X.XX / cap $10.00` appears.
   - Confirm at least 1 breakdown row for the categories with activity (e.g., `Lesson generation: $0.0001` after a single rejection).

- [ ] **Step 3: Negative test (API key missing)**

Temporarily clear `ANTHROPIC_API_KEY` and Keychain entry. Restart app. Repeat trigger steps from Step 2.

```bash
DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
COUNT_BEFORE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM cost_ledger WHERE purpose LIKE 'lesson_%';")
# ... trigger Sub-spec A / D / E flows that should now fail at API key gate ...
COUNT_AFTER=$(sqlite3 "$DB" "SELECT COUNT(*) FROM cost_ledger WHERE purpose LIKE 'lesson_%';")
echo "Before: $COUNT_BEFORE, After: $COUNT_AFTER"
```

Expect `Before == After` (no new rows when API fails). UI total unchanged.

After the negative test, restore the API key.

- [ ] **Step 4: Idempotency check**

Re-fetch the cost summary multiple times via DevTools:
```js
await window.SHOGUN_RUNTIME.executeAction('kioku.cost_summary', {})
await window.SHOGUN_RUNTIME.executeAction('kioku.cost_summary', {})
```
Both calls should return identical numbers (no state drift within a single calendar month).

- [ ] **Step 5: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*cost|FIXME.*cost|TODO.*ledger" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits introduced by this work.

- [ ] **Step 6: No commit (verification only)**

If all steps pass, Sub-spec H is complete. Report DONE with the SHA range from Tasks 1-7 (`git log --oneline HEAD~7..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
