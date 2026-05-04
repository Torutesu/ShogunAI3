# KIOKU Sub-spec E — `prevented_n` Verifier Design

**Status:** approved (2026-04-30)
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` § 3 (注入したら applies_n++ / 違反しなかったら prevented_n++), § 9 (成功指標)
**Predecessors:** Sub-spec A (Lessons MVP) · Sub-spec B (Patterns MVP) · Sub-spec C (Settings UI) · Sub-spec D (Supersession) — all shipped

---

## 1. Goal

Implement the missing half of the `lessons` lifecycle: when an injected lesson is **respected** by the assistant's reply (not violated), increment `prevented_n` so the user can see "SHOGUN learned X failures away from happening" — with real numbers, not the cumulative `applies_n` proxy currently shown.

Phase 1 (Sub-spec A) intentionally left `prevented_n` unimplemented. Sub-spec C surfaced `applies_n` as a stand-in (`Applied N times total`). This sub-spec replaces that proxy with the spec-original semantic.

## 2. Architecture

After every successful chat completion, an async LLM judge evaluates whether each injected lesson was **respected** by the assistant's reply. Respected lessons get `prevented_n++`. The verifier is fire-and-forget — it does not block the chat response and does not retry on failure. A new `lessons_verifier.rs` module owns the logic; `chat_complete` gains a single `tauri::async_runtime::spawn` call after `increment_applies`. The Settings UI's KIOKU Lessons pane gains a third stats line (`Prevented N failures`), conditional on `prevented_n > 0` so verifier-disabled environments don't display a misleading zero.

## 3. Decisions Locked During Brainstorm

| # | Decision | Choice |
|---|----------|--------|
| 1 | What counts as "not violated"? | **A** — LLM judge per turn (binary `respected: bool` per lesson). |
| 2 | When does the verifier run? | **A** — async fire-and-forget after `chat_complete` returns to the user. |
| 3 | Call shape | **A** — single batched LLM call per turn, structured tool output `judgments: [{lesson_id, respected}]`. |
| 4 | LLM failure behaviour | **A** — log + skip. No retry, no optimistic increment. |

## 4. Module Layout

### 4.1 `src-tauri/src/lessons_verifier.rs` (new, ~150 LOC)

Public surface (one entry point):

```rust
/// Async verifier triggered after every chat turn that injected lessons.
/// Fire-and-forget: never returns Err, never blocks the chat response.
pub async fn verify_and_increment(
  applied_lesson_ids: Vec<String>,
  user_msg: String,
  assistant_msg: String,
);
```

Internal helpers:

- `fetch_rules_for_ids(conn, ids) -> Result<Vec<(String /* id */, String /* rule */)>, String>`
  - `SELECT id, rule FROM lessons WHERE id IN (?, ?, ...) AND status='active'`
  - Skips archived/superseded lessons (defensive).
- `judge_tool() -> Value` — Anthropic tool definition.
- `build_user_prompt(user_msg, assistant_msg, lessons) -> String`
- `call_judge(...) -> Option<Vec<String> /* respected ids */>`
  - Calls `crate::llm::anthropic_tool_complete`, parses `judgments`, filters to `respected: true`, intersects with the input id set (drop hallucinations).
  - Returns `None` on transient failures (logged via `log::warn`).

### 4.2 Existing files modified

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/lessons.rs` | Add `pub fn increment_prevented(conn, ids)` (mirror of `increment_applies` with `prevented_n` column + `status='active'` guard) | +12 |
| `src-tauri/src/llm.rs:260-266` | Spawn `lessons_verifier::verify_and_increment(...)` after `increment_applies` | +12 |
| `src-tauri/src/lib.rs` | `mod lessons_verifier;` | +1 |
| `src-tauri/src/commands.rs` | `shogun_lessons_stats` returns extra field `prevented_total` | +5 |
| `hifi/settings-modal.jsx` | `PaneKiokuLessons` stats card adds 3rd line, conditional on `prevented_total > 0` | +8 |

No schema changes. No new Tauri command. No new IPC action. No new frontend file.

## 5. LLM Verifier Contract

**Model:** `claude-haiku-4-5-20251001` (same as Sub-spec A / D).
**Helper:** existing `crate::llm::anthropic_tool_complete`.

### 5.1 Tool

```json
{
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
}
```

### 5.2 System prompt

```
You are evaluating whether an AI assistant's reply respected a set of rules
the user previously accepted into their personal AI assistant.

For each rule, output:
- respected: true   — the assistant's reply did NOT violate the rule
                     (this includes rules that don't apply to the topic —
                     vacuous compliance counts as respected)
- respected: false  — the assistant's reply violated the rule

Only mark `false` when the reply visibly violates the rule's intent. When
unsure, prefer `true`.

Output the structured tool call only. Include EVERY input lesson_id in
your judgments array.
```

### 5.3 User message template

```
USER ASKED:
{user_msg}

ASSISTANT REPLIED:
{assistant_msg}

LESSONS TO EVALUATE:
- id: {lesson_id_1}
  rule: {lesson_rule_1}
- id: {lesson_id_2}
  rule: {lesson_rule_2}
...
```

### 5.4 Knobs

- `temperature: 0.0`
- `max_tokens: 256` (judgments array of ~5 items fits comfortably)

### 5.5 Cost ceiling

- Avg input ~600 tokens (system + user + 5 lessons), output ~80 tokens (judgments × 5).
- Assume 100 chat turns/month → 60K input + 8K output / month.
- claude-haiku-4-5 pricing → < USD 0.01 / month for typical usage.

## 6. Pair-Selection (no selection — all injected lessons judged)

Every lesson_id returned by `retrieve_for_chat` (used to add the addendum) is judged. There is no further filtering: the user asked for the lesson to apply via `retrieve_for_chat`'s top-K, so every injected lesson is in scope for verification.

Vacuous compliance counts (master spec § 3 implicit semantic). E.g., a lesson "Avoid emojis in formal replies" applied to the chat turn "What is 2+2?" → the reply "4" trivially does not use emojis → `respected: true` → `prevented_n++`. This is correct because the lesson_id was retrieved by similarity search; respecting it (even vacuously) is the metric we want to measure.

## 7. Wire Site

`src-tauri/src/llm.rs:260-266` — after `increment_applies`, before returning the response.

```rust
let content = crate::llm_providers::extract_chat_text(provider, &v)?;
if !applied_lesson_ids.is_empty() {
  if let Ok(conn) = crate::memory_store::open_conn() {
    if let Err(e) = crate::lessons::increment_applies(&conn, &applied_lesson_ids) {
      log::warn!("lessons::increment_applies failed: {}", e);
    }
  }

  // Sub-spec E: async verifier — fire-and-forget.
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
Ok(json!({ "message": content, "echo": payload, "stub": false }))
```

The spawn uses `tauri::async_runtime::spawn` (not `tokio::spawn`) — same correction landed in Sub-spec D fix `b9e8644`.

## 8. `lessons::increment_prevented`

```rust
pub fn increment_prevented(conn: &Connection, ids: &[String]) -> Result<(), String> {
  if ids.is_empty() { return Ok(()); }
  let placeholders = vec!["?"; ids.len()].join(",");
  let sql = format!(
    "UPDATE lessons SET prevented_n = prevented_n + 1 WHERE status = 'active' AND id IN ({})",
    placeholders
  );
  let params_vec: Vec<&dyn rusqlite::ToSql> = ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
  conn.execute(&sql, &params_vec[..])
    .map_err(|e| format!("lessons::increment_prevented: {}", e))?;
  Ok(())
}
```

The `status='active'` guard protects against race: a lesson archived between the chat completion and the verifier's `increment_prevented` call won't get its `prevented_n` updated.

(`increment_applies` lacks this guard but is called synchronously inside `chat_complete` before the user could archive a lesson, so the race window is negligible. The guard is added here because `verify_and_increment` runs async with potentially seconds-long latency.)

## 9. Lessons Stats UI Extension

### 9.1 Backend

`shogun_lessons_stats` adds one SUM:

```rust
let prevented: i64 = conn.query_row(
  "SELECT COALESCE(SUM(prevented_n), 0) FROM lessons WHERE status='active'",
  [], |r| r.get(0)
).map_err(|e| format!("lessons_stats sum prevented: {}", e))?;
Ok(serde_json::json!({
  "total_active": total,
  "applied_total": applied,
  "prevented_total": prevented,
}))
```

Backward compatible: existing clients ignoring the new key still work.

### 9.2 Frontend

`PaneKiokuLessons` (`hifi/settings-modal.jsx`):

```jsx
const [stats, setStats] = useStateS({ total_active: 0, applied_total: 0, prevented_total: 0 });

// in fetchStats:
setStats({
  total_active: Number(r.data.total_active || 0),
  applied_total: Number(r.data.applied_total || 0),
  prevented_total: Number(r.data.prevented_total || 0),
});

// in archive (preserve prevented_total since archive doesn't change it):
setStats({
  total_active: Math.max(0, stats.total_active - 1),
  applied_total: stats.applied_total,
  prevented_total: stats.prevented_total,
});
```

Stats card render:

```jsx
<div className="card" style={{padding:'var(--space-4) var(--space-5)', marginBottom:'var(--space-4)'}}>
  <div className="t-sm" style={{color:'var(--text)'}}>
    {statsLoaded ? `${stats.total_active} lessons learned` : '— lessons learned'}
  </div>
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

The `prevented_total > 0` guard is critical: it hides the line when verifier hasn't yet run (or has been failing due to API issues), avoiding a misleading "Applied 100, Prevented 0" display.

## 10. Error Handling

| Situation | Behaviour |
|-----------|-----------|
| API key not configured | `verify_and_increment` returns immediately at the gate (Phase 1 lesson pattern). |
| `applied_lesson_ids` empty | Verifier never spawned (`chat_complete` guards). |
| `fetch_rules_for_ids` SQL error | `log::warn`, return without increment. |
| LLM call fails (4xx / 5xx / network / parse) | `log::warn`, return without increment. |
| LLM omits a lesson_id from `judgments` | That lesson skipped; others processed normally. |
| LLM hallucinates extra lesson_id | Filtered out via input-id intersection. |
| `increment_prevented` SQL error | `log::warn`. User sees no error (chat already returned). |
| App killed before verifier completes | Result lost. Acceptable: cumulative counters are statistically robust to occasional drops. |
| Lesson archived between chat completion and verifier | Status guard in `increment_prevented` skips it cleanly. |

No retries. No queue persistence. No surface to user.

## 11. Privacy

The verifier sends to Anthropic (per turn):
- `user_msg` (already sent to LLM during chat completion — no additional exposure).
- `assistant_msg` (already sent to embeddings as context — no additional exposure).
- `lesson.rule` text for each injected lesson.

It does NOT send:
- `lesson.trigger_context` / `lesson.attempted` / `lesson.outcome` (raw event metadata) — master spec § 5 compliance.
- Other lessons not injected.
- Any patterns data.

BYOK: requests use the user's Anthropic key, no third-party transmission.

## 12. Verification

### 12.1 Static checks

```bash
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All PASS. Pre-existing warnings allowed.

### 12.2 Manual walkthrough

Prerequisite: at least one active lesson exists in `lessons` with non-null embedding (run Sub-spec A flows or seed one).

1. Settings → KIOKU Lessons → confirm stats `X lessons learned`, `Applied Y times total`. Third line should be **absent** (no `Prevented` line if `prevented_total == 0`).
2. Open Chat → ask anything. The lesson should be retrieved and injected (Sub-spec A behavior, observable in `event=lessons_addendum_built` log).
3. Wait ~3-5 seconds after the assistant reply. Check log for `event=lesson_verifier_done respected=N total=N`.
4. SQLite check:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT id, applies_n, prevented_n FROM lessons WHERE applies_n > 0 ORDER BY applies_n DESC LIMIT 5;"
   ```
   Expect `prevented_n` ≤ `applies_n`, and ≥ 0 (with at least one row showing prevented_n > 0 if verifier worked).
5. Settings → KIOKU Lessons (refresh modal or reopen) → third line `Prevented N failures` should now appear.
6. Negative test: temporarily set `ANTHROPIC_API_KEY=` env var (or unset Keychain key), chat again. Verify log shows verifier skipping due to missing key. `prevented_n` does not increase.

### 12.3 Cost sanity

After ~100 chat turns, sum `applies_n - prevented_n` to count "violation" cases. Compare to actual `user_rejection` lessons captured in same period. The two should be loosely correlated — a divergent ratio (e.g., verifier says 0 violations but user pressed "bad reply" 20 times) indicates LLM judge prompt needs revision.

## 13. Out of Scope (Explicit)

- **Monthly / windowed `prevented_n` counter** — cumulative only, matching Sub-spec C's `Applied X times total` decision.
- **Per-category breakdown of prevented** — spec § 6 says summary-only; current categories are 2 anyway.
- **Manual verifier trigger Tauri command** — verifier is intrinsically tied to chat lifecycle, no debug knob needed; DevTools can call `chat.complete` directly.
- **Per-turn persistence (queue table)** — Section 1 decision; cumulative semantics tolerate occasional drops.
- **Per-lesson `prevented_n` display in row UI** — only stats summary, not row-level.
- **`applies_n / prevented_n` ratio display** — internal metric (master spec § 9 success criterion), not surfaced to user.
- **Fine-grained verifier telemetry beyond `lesson_verifier_done`** — no cost_ledger integration, no per-turn ring-buffer entry.
- **Few-shot prompt tuning** — current zero-shot prompt for MVP; revisit after observing real data.
- **Retroactive verifier (catch up missed turns after restart)** — explicit non-goal.
- **Verifier on draft / brief LLM calls** — only `chat_complete` flow injects lessons; `draft.create` / `shogun.draft_reply` etc. are out of scope.

## 14. File Change Summary

| File | Created / Modified | LOC |
|------|--------------------|-----|
| `src-tauri/src/lessons_verifier.rs` | Created | ~150 |
| `src-tauri/src/lessons.rs` | Modified (`increment_prevented`) | +12 |
| `src-tauri/src/llm.rs` | Modified (spawn block) | +12 |
| `src-tauri/src/lib.rs` | Modified (`mod lessons_verifier;`) | +1 |
| `src-tauri/src/commands.rs` | Modified (`shogun_lessons_stats` field) | +5 |
| `hifi/settings-modal.jsx` | Modified (`PaneKiokuLessons` stats) | +8 |
| **Total** | 1 created, 5 modified | ~188 LOC |

## 15. Estimate

**~1 day** including:
- LLM prompt iteration / sanity check
- Manual chat walkthrough
- Cost sanity over real data

---

*Approved sections: § 1 / § 2 / § 3 / § 4 / § 5 / § 6 — all approved during brainstorm.*
