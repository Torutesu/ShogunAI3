# KIOKU Sub-spec H — LLM Cost Visibility Design

**Status:** approved (2026-04-30)
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` (referenced for the LLM-driven layers it added; cost discipline is implied by the BYOK posture stated in § 5)
**Predecessors:** Sub-spec A (Lessons MVP, on main) · Sub-spec B (Patterns MVP, on main) · Sub-spec C (Settings UI, PR #28) · Sub-spec D (Supersession, PR #29) · Sub-spec E (`prevented_n` verifier, PR #29) · Sub-spec F (Spatial Patterns, PR #30)

---

## 1. Goal

Make every Anthropic API call that KIOKU drives recordable in `cost_ledger` and surface the monthly total + per-purpose breakdown in Settings → KIOKU Graph. Today the existing infra records `extraction` / `summarize` / `embed` purposes from the kioku_extraction worker, but Sub-spec A / D / E call `anthropic_tool_complete` directly without recording, so the user has no idea what KIOKU's hygiene + verifier loops cost. With BYOK, that's a continuation-of-use risk.

## 2. Architecture

Migrate four `anthropic_tool_complete` callsites in Sub-spec A / D / E to `anthropic_tool_complete_with_usage` (already exists, used by `kioku_extraction`) and emit `cost_ledger::record` per call. Add three new PURPOSE constants for the new categories. Add one new aggregator fn `sum_cost_in_window_by_purpose` and one new Tauri command `shogun_kioku_cost_summary` that returns total + breakdown + cap settings. Settings → KIOKU Graph pane renders a `Cost This Month` card immediately below the existing cap settings.

## 3. Decisions Locked During Brainstorm

| # | Decision | Choice |
|---|----------|--------|
| 1 | Recording scope | **A** — all 4 KIOKU callsites (Sub-spec A rejection + tool_failure, Sub-spec D supersession, Sub-spec E verifier). Embeddings out of scope. |
| 2 | Purpose taxonomy | **A** — 3 new purposes: `lesson_generation` (rejection + tool_failure), `lesson_supersession`, `lesson_verifier`. |
| 3 | UI display granularity | **B** — total + per-purpose breakdown (~5 rows in KIOKU Graph pane). |
| 4 | Monthly window | **A** — UTC, reuse existing `cost_ledger::month_start_ms_utc` (matches cap evaluation logic). |

## 4. Backend — `cost_ledger.rs` extensions

### 4.1 New PURPOSE constants

In `src-tauri/src/cost_ledger.rs`, add to the existing taxonomy block (around line 30-33, after `PURPOSE_EMBED`):

```rust
pub const PURPOSE_LESSON_GENERATION: &str = "lesson_generation";
pub const PURPOSE_LESSON_SUPERSESSION: &str = "lesson_supersession";
pub const PURPOSE_LESSON_VERIFIER: &str = "lesson_verifier";
```

### 4.2 `sum_cost_in_window_by_purpose`

New helper that aggregates `cost_usd` per purpose across a window. Mirrors `sum_cost_in_window` shape:

```rust
pub fn sum_cost_in_window_by_purpose(
  conn: &Connection,
  since_ms: i64,
  until_ms: i64,
) -> Result<HashMap<String, f64>, String> {
  let mut stmt = conn
    .prepare(
      "SELECT purpose, COALESCE(SUM(cost_usd), 0.0)
       FROM cost_ledger
       WHERE recorded_at >= ?1 AND recorded_at < ?2
       GROUP BY purpose",
    )
    .map_err(|e| format!("sum_cost_in_window_by_purpose prepare: {}", e))?;
  let rows = stmt
    .query_map(params![since_ms, until_ms], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    })
    .map_err(|e| format!("sum_cost_in_window_by_purpose query: {}", e))?;
  let mut out: HashMap<String, f64> = HashMap::new();
  for r in rows {
    let (purpose, sum) =
      r.map_err(|e| format!("sum_cost_in_window_by_purpose row: {}", e))?;
    out.insert(purpose, sum);
  }
  Ok(out)
}
```

Return is `HashMap<String, f64>`, not a fixed struct, so the JSON output includes any future PURPOSE without code changes downstream.

## 5. Backend — Callsite Migrations

Each migration follows the same shape: switch `anthropic_tool_complete` to `anthropic_tool_complete_with_usage`, then record cost best-effort (failure of recording must NOT fail the calling op). Use `result.input` where the old call returned `input` directly.

### 5.1 Common pattern (inlined per callsite, no new helper)

```rust
match crate::llm::anthropic_tool_complete_with_usage(SYSTEM, &user_msg, &tool, MODEL).await {
  Ok(result) => {
    if let Ok(conn) = crate::memory_store::open_conn() {
      let cost = crate::cost_ledger::calc_cost_with_cache(
        &result.resolved_model,
        result.input_tokens,
        result.output_tokens,
        result.cache_creation_input_tokens,
        result.cache_read_input_tokens,
      ).unwrap_or(0.0);
      let entry = crate::cost_ledger::LedgerEntry {
        recorded_at_ms: now_ms_i64(),
        model: result.resolved_model.clone(),
        purpose: crate::cost_ledger::PURPOSE_X.to_string(),
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        cost_usd: cost,
        job_id: None,
        meta_json: None,
      };
      let _ = crate::cost_ledger::record(&entry, &conn);
    }
    // Use result.input as drop-in replacement for the old `input` value
    ...
  }
  Err(e) => { log::warn!(...); fallback }
}
```

`now_ms_i64()` is the existing `std::time::SystemTime::now()...` pattern already used elsewhere in each file (or inline that 3-line snippet).

### 5.2 The four callsites

| File | Function | Purpose constant |
|------|----------|------------------|
| `src-tauri/src/commands.rs` | `shogun_lesson_capture_rejection` (~line 2114) | `PURPOSE_LESSON_GENERATION` |
| `src-tauri/src/commands.rs` | `shogun_lesson_capture_tool_failure` (similar shape) | `PURPOSE_LESSON_GENERATION` |
| `src-tauri/src/supersession.rs` | `judge_contradiction` | `PURPOSE_LESSON_SUPERSESSION` |
| `src-tauri/src/lessons_verifier.rs` | `call_judge` | `PURPOSE_LESSON_VERIFIER` |

Why no helper:
- Each callsite has different `meta_json` semantics if/when added later, different fallback shapes, different ownership patterns for `tool` (some build inline, some via separate fn). A helper either grows arguments or hides too much.
- 4 callsites × 5 lines added = 20 lines total. Helper would itself be ~20 lines plus call-site adapters. Net wash.

## 6. Backend — `shogun_kioku_cost_summary` command

```rust
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
```

Placement: `src-tauri/src/commands.rs`, near other KIOKU read commands (e.g., `shogun_lessons_stats`).

## 7. Frontend — IPC Plumbing

### 7.1 `hifi/lib/shogun-api.js`

```js
kiokuCostSummary: (input) => call("shogun_kioku_cost_summary", input || {}, READ),
```

### 7.2 `hifi/lib/action-registry.js`

```js
register("kioku.cost_summary", (payload) => api.kiokuCostSummary(payload));
```

### 7.3 `hifi/action-map.md`

```
- `kioku.cost_summary`
```

### 7.4 `src-tauri/src/lib.rs` invoke_handler

Add `commands::shogun_kioku_cost_summary,` to the existing handler list.

## 8. Frontend — `PaneKiokuGraph` Cost This Month section

### 8.1 New state

```js
const [costSummary, setCostSummary] = useStateS(null);
```

### 8.2 Fetch helper

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

### 8.3 PURPOSE → label map

```js
const PURPOSE_LABELS = {
  extraction: 'Extraction',
  summarize: 'Summarize',
  embed: 'Embed',
  lesson_generation: 'Lesson generation',
  lesson_supersession: 'Lesson supersession',
  lesson_verifier: 'Lesson verifier',
};
```

Unknown purposes fall back to the raw string.

### 8.4 JSX (placed immediately after the existing `Cost cap` Row)

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
          const label = PURPOSE_LABELS[purpose] || purpose;
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

### 8.5 Display rules

- `costSummary === null` (initial load or fetch failed) → entire section hidden.
- `total_usd === 0` with non-null `costSummary` → renders `Total: $0.00` and no breakdown rows (empty state acknowledged by header).
- `by_purpose` empty object → only Total row visible.
- Per-purpose rows under `$0.01` show as `$0.00`. Acceptable: spec § 11 keeps small-value rendering trivial.
- No refresh button — useEffect re-runs on tab open (settings modal mount).

## 9. Error Handling

| Situation | Behaviour |
|-----------|-----------|
| `cost_ledger::record` fails | `let _ =` ignores the error; LLM result still used. The op continues. |
| `sum_cost_in_window` / `sum_cost_in_window_by_purpose` fails | `shogun_kioku_cost_summary` returns Err(...); UI hides section (`costSummary` stays null). |
| `settings_store::load()` fails | Defaults applied (`DEFAULT_MONTHLY_CAP_USD = 10.0`, `CAP_ACTION_PAUSE_EXTRACTION`). |
| `anthropic_tool_complete_with_usage` API fails | Existing fallback per callsite (rule = "Avoid replies similar to ...", supersession skip, verifier `None`). No cost recorded. |
| Anthropic response without `usage` field | `parse_anthropic_tool_response` defaults all token counts to `0` via `unwrap_or(0)`; record happens with `cost_usd = 0`. |
| `calc_cost_with_cache` returns None (model not in pricing table) | `unwrap_or(0.0)` records 0; row preserved for future re-pricing. |
| Cost ledger has no rows yet | UI shows `Total: $0.00`, no breakdown rows. |
| Month boundary mid-render | `month_start_ms_utc(now_ms)` reflects current month; users may briefly see a fresh $0.00 total. |
| Multiple Anthropic responses written to single ledger row | Cannot happen — each API call → 1 record. |
| Prompt-cache pricing | Already handled by `calc_cost_with_cache` (`docs/kioku-cost-budget.md` § 2). |
| Non-Anthropic provider used | Out of scope. `calc_cost*` is claude-* model-only.

## 10. Privacy & Security

The cost ledger records:
- `model` (e.g., `claude-haiku-4-5-20251001`)
- `purpose` (taxonomy enum strings)
- `input_tokens` / `output_tokens` (integer counts)
- `cost_usd` (float)
- `job_id` (Option, not used in Sub-spec H)
- `meta_json` (Option, not used in Sub-spec H — explicitly null for these recordings)

It does NOT record:
- Prompt content (system / user / tool definition / response text)
- Lesson rules being verified or judged
- User messages / assistant replies
- Display ids / spatial context

The Settings UI surfaces only money values + purpose names. Pure local visibility, no third-party transmission. BYOK posture preserved.

## 11. Verification

### 11.1 Static checks

```bash
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All must PASS. Pre-existing warnings allowed.

### 11.2 Manual walkthrough

Prerequisite: Anthropic API key configured (env var or Keychain), and at least one Sub-spec A / D / E LLM call has occurred since the start of the current UTC calendar month.

1. Trigger one of each KIOKU LLM call:
   - Lesson generation: open Hummingbird, send a prompt, click `Bad response` (Sub-spec A rejection).
   - Lesson supersession: DevTools `await window.SHOGUN_RUNTIME.executeAction('supersession.run_now', {})` after seeding contradicting lessons (spec § 10.3 of Sub-spec D).
   - Lesson verifier: chat once with injected lessons; verifier fires async after response.

2. Inspect raw ledger:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT purpose, model, input_tokens, output_tokens, cost_usd FROM cost_ledger WHERE purpose LIKE 'lesson_%' ORDER BY recorded_at DESC LIMIT 10;"
   ```
   Expect rows with one of `lesson_generation`, `lesson_supersession`, `lesson_verifier` purposes.

3. Open Settings → KIOKU Graph → scroll to **Cost This Month** card.
   - Confirm `Total: $X.XX / cap $10.00`.
   - Confirm at least 3 breakdown rows for the categories with activity.

4. Negative test: clear `ANTHROPIC_API_KEY` env var and Keychain entry, restart app, repeat trigger steps. No new cost rows recorded; UI total unchanged.

### 11.3 Idempotency / replay

Re-fetch the cost summary multiple times (close + reopen Settings):

```js
await window.SHOGUN_RUNTIME.executeAction('kioku.cost_summary', {})
```

Each call returns identical numbers (within a single calendar month, no state drift).

## 12. Out of Scope (Explicit)

- **Historical month browsing** (graph / past 6 months UI) — current UTC month only.
- **Cap-reach UI warning color or paused-state indication** — display-only this round.
- **Per-model breakdown** (`haiku` vs `sonnet` cost compare) — purpose-only.
- **Per-day / per-hour granularity** — monthly only.
- **CSV export / billing reconciliation tools** — separate sub-spec.
- **Embeddings cost recording** (`embed_one` callsites in lessons / patterns) — Section 1 decision; separate sub-spec covering the broader memory pipeline.
- **`chat_complete` body LLM cost recording** — Sub-spec H is KIOKU hygiene/verification only.
- **Cap auto-adjust / suggestion** — display-only.
- **Approaching-cap notification / toast** — separate sub-spec; users manually open Settings.
- **Cost ledger archiving / VACUUM** — separate operational concern.

## 13. File Change Summary

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/cost_ledger.rs` | +3 PURPOSE constants + `sum_cost_in_window_by_purpose` fn | +30 |
| `src-tauri/src/commands.rs` | Migrate 2 callsites + add `shogun_kioku_cost_summary` (~50 lines) | +80 |
| `src-tauri/src/supersession.rs` | Migrate `judge_contradiction` callsite | +20 |
| `src-tauri/src/lessons_verifier.rs` | Migrate `call_judge` callsite | +20 |
| `src-tauri/src/lib.rs` | invoke_handler entry for `shogun_kioku_cost_summary` | +1 |
| `hifi/lib/shogun-api.js` | binding | +1 |
| `hifi/lib/action-registry.js` | register | +1 |
| `hifi/action-map.md` | entry | +1 |
| `hifi/settings-modal.jsx` | `PaneKiokuGraph` Cost This Month section + state + fetch | +50 |
| **Total** | 0 created, 9 modified | ~204 LOC |

## 14. Estimate

**~1.5 days** including:
- Four callsite migrations and verifying response unwrap behavior.
- New aggregator SQL fn + Tauri command.
- Settings UI section + state plumbing.
- Manual walkthrough of all three KIOKU callsite categories.

---

*Approved sections: § 1 / § 2 / § 3 / § 4 / § 5 — all approved during brainstorm.*
