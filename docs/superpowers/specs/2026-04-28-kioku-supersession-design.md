# KIOKU Sub-spec D — Supersession Automation Design

**Status:** approved (2026-04-28)
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` § 3 (昇華), § 4 Phase 2
**Predecessors:** Sub-spec A (Lessons MVP) · Sub-spec B (Patterns MVP) · Sub-spec C (Settings UI) — all shipped Phase 1

---

## 1. Goal

Keep the user's `lessons` table free of stale, contradicting rules. A monthly LLM-driven batch compares newer lessons against semantically-similar older ones in the same category. When the LLM judges that a new lesson directly contradicts an older one, the older lesson is marked `status='superseded'`. The user is not asked — this is automatic hygiene, not a workflow surface.

## 2. Architecture

A new `src-tauri/src/supersession.rs` module owns the detection logic and orchestration. A new `src-tauri/src/supersession_sync.rs` module wraps it in a 30-day background scheduler, modeled after the existing `patterns_sync.rs`. One Tauri command (`shogun_supersession_run_now`) is exposed for DevTools / debug — there is no Settings UI surface, consistent with the Sub-spec C "no buttons" decision. Schema is unchanged: this sub-spec only writes the existing `lessons.status` column with the value `'superseded'`.

## 3. Decisions Locked During Brainstorm

| # | Decision | Choice |
|---|----------|--------|
| 1 | Scope of supersession | **A** — lessons only. Patterns have their own `mark_stale_sweep` (time-based). |
| 2 | Authority | **A** — fully automatic. No proposal queue, no user approval step. |
| 3 | Comparison strategy | **A** — same category × embedding cosine top-K=3. |
| 4 | Trigger cadence | **A** — pure 30-day batch. No event-driven, no manual UI button. |
| 5 | Judge semantics | **A** — strict direct contradiction only (LLM outputs `yes`/`no`). |

## 4. Module Layout

### 4.1 `src-tauri/src/supersession.rs` (new, ~200 LOC)

Public surface (one function):

```rust
/// Run the monthly supersession detection batch. Returns count of lessons
/// newly marked `status='superseded'`.
pub async fn run_supersession() -> Result<usize, String>;
```

Internal helpers:

- `fetch_active_lessons_with_embeddings(conn) -> Result<Vec<Lesson>, String>`
  - SELECT id, category, rule, embedding, created_at FROM lessons
    WHERE status='active' AND embedding IS NOT NULL
    ORDER BY created_at DESC
- `top_k_older_by_cosine(newer, candidates, k=3) -> Vec<&Lesson>`
  - Filters candidates to `created_at < newer.created_at` AND status still `'active'` (in-memory updated view), computes cosine similarity, returns top K.
- `judge_contradiction(older_rule, newer_rule) -> Result<Option<bool>, String>`
  - Builds Anthropic tool-use call (model `claude-haiku-4-5-20251001`, temperature 0.0, max_tokens 64).
  - Returns `Ok(Some(true))` on contradiction, `Ok(Some(false))` on no contradiction, `Ok(None)` on parse failure or transient API error (caller skips the pair).
- `mark_superseded(conn, id) -> Result<(), String>`
  - `UPDATE lessons SET status='superseded' WHERE id=?1 AND status='active'` (double-check guard).

### 4.2 `src-tauri/src/supersession_sync.rs` (new, ~80 LOC)

Mirror of `patterns_sync.rs`:

```rust
pub struct SupersessionSyncState {
  pub last_run_ms: Option<i64>,
  pub last_marked_count: usize,
  pub last_error: Option<String>,
}

pub fn snapshot_state() -> SupersessionSyncState;
pub fn spawn_background_supersession_sync();
```

Behaviour:
- Cold-start delay: 60 s.
- Wake interval: 6 hours (the 30-day gate keeps actual work rare).
- Settings gate: `/sections/kioku_graph/supersession_enabled` (default `true`).
- 30-day gate: `should_run()` returns true if no prior run OR `now_ms - last_run_ms >= 30 * 24 * 3600 * 1000`.
- `last_run_ms` is process-memory only; restart resets to "first run", which is acceptable (the requirement is "at least every 30 days", not "exactly").

### 4.3 Modifications

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/lib.rs` | `mod supersession;` + `mod supersession_sync;` + 1 spawn call in `setup()` + 1 invoke_handler entry | +4 |
| `src-tauri/src/commands.rs` | `shogun_supersession_run_now` async command | +6 |
| `hifi/lib/shogun-api.js` | `supersessionRunNow` binding | +1 |
| `hifi/lib/action-registry.js` | `supersession.run_now` register | +1 |
| `hifi/action-map.md` | `supersession.run_now` entry | +1 |

No changes to: `lessons.rs`, `patterns.rs`, `kioku_graph_schema.rs`, frontend Settings panes.

## 5. LLM Judge Contract

**Model:** `claude-haiku-4-5-20251001` (existing helper `crate::llm::anthropic_tool_complete`).

**Tool definition:** A single tool `judge_contradiction` whose input schema is:

```json
{
  "type": "object",
  "properties": {
    "contradicts": { "type": "boolean" }
  },
  "required": ["contradicts"]
}
```

**System prompt:**

```
You are evaluating two rules a user has accepted into their personal AI assistant.
Decide if the NEWER rule directly contradicts the OLDER rule.

Direct contradiction means: following one rule would violate the other.

Examples of contradiction:
  OLDER: "Avoid emojis in formal replies."
  NEWER: "Use emojis in formal replies to feel friendly."
  → contradicts: true

Examples of NOT contradiction (different scopes / additive / unrelated):
  OLDER: "Avoid emojis in formal replies."
  NEWER: "Use plain text in legal correspondence."
  → contradicts: false  (different scope; both can hold)

  OLDER: "Keep slack messages under 3 lines."
  NEWER: "Use bullet points in long emails."
  → contradicts: false  (unrelated)

Output the structured tool call only.
```

**User message template:**

```
OLDER: {older.rule}
NEWER: {newer.rule}
```

**Knobs:** `temperature=0.0`, `max_tokens=64`.

**Cost estimate:** input ~200 tokens × N×K = 50 × 3 = 150 calls / month; output < 32 tokens × 150. With claude-haiku-4-5 pricing this is well under USD 0.10 / month for typical N.

## 6. Pair-Selection Algorithm

```
fn run_supersession() -> Result<usize, String>:
  let conn = memory_store::open_conn()?
  let mut active = fetch_active_lessons_with_embeddings(conn)?  // sorted DESC by created_at

  // Group by category
  let mut by_cat: HashMap<String, Vec<Lesson>> = group_by(active, |l| l.category.clone())

  let mut marked = 0usize

  for (cat, mut lessons) in by_cat:
    for i in 0..lessons.len():
      // `newer` is the i-th lesson; `lessons[j]` for j > i are older
      let newer = lessons[i].clone()
      let candidates = lessons[(i+1)..]
        .iter()
        .filter(|l| l.status == "active")  // local view, may have been mutated below
        .collect()

      let top_k = top_k_older_by_cosine(&newer, candidates, K=3)

      for older in top_k:
        match judge_contradiction(&older.rule, &newer.rule).await:
          Ok(Some(true)) =>
            mark_superseded(&conn, &older.id)?
            // Update local view so subsequent iterations skip this lesson
            if let Some(idx) = lessons.iter().position(|l| l.id == older.id):
              lessons[idx].status = "superseded".into()
            marked += 1
          Ok(Some(false)) | Ok(None) | Err(_) =>
            continue  // log warning on Err only
  Ok(marked)
```

**Invariants & justifications:**

- Newer always wins. Direction comes from `created_at`, not from the LLM.
- One LLM call per (newer, older) pair. Deterministic prompt + `temperature=0.0` makes results stable across reruns.
- A lesson can be marked superseded multiple times in one batch only if it appears as `older` for multiple `newer` lessons — but the SQL guard `WHERE id=? AND status='active'` makes the second update a no-op.
- Lessons without `embedding` are skipped at SELECT time. They are not punished for being old — they simply don't participate. (Future: backfill embeddings, but out of scope here.)
- K=3 is hard-coded. No setting, no user-tunable. (Future: revisit if N grows past 200 active lessons per category.)

## 7. Background Scheduler

`supersession_sync.rs` follows the same shape as `patterns_sync.rs`:

```rust
pub fn spawn_background_supersession_sync() {
  tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(60)).await; // cold-start delay
    loop {
      if supersession_enabled() && should_run() {
        match crate::supersession::run_supersession().await {
          Ok(marked) => {
            if let Ok(mut s) = STATE.lock() {
              s.last_run_ms = Some(now_ms());
              s.last_marked_count = marked;
              s.last_error = None;
            }
            crate::memory_obs::emit("supersession_done", &[("marked", marked.to_string())]);
          }
          Err(e) => {
            log::warn!("supersession failed: {}", e);
            if let Ok(mut s) = STATE.lock() { s.last_error = Some(e.clone()); }
            crate::memory_obs::emit("supersession_error", &[("error", e)]);
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
    }
  });
}
```

**Spawn site:** `lib.rs` `setup()`, immediately after `patterns_sync::spawn_background_patterns_sync();`.

## 8. Manual Trigger Command

```rust
// src-tauri/src/commands.rs (insert after shogun_patterns_run_now)
#[tauri::command]
pub async fn shogun_supersession_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let marked = crate::supersession::run_supersession().await?;
  Ok(serde_json::json!({ "marked": marked }))
}
```

Invoked from DevTools as:

```js
await window.SHOGUN_RUNTIME?.runAction?.('supersession.run_now', {})
// → { ok: true, data: { marked: N } }
```

No Settings UI button. Consistent with Sub-spec C and Sub-spec B precedents.

## 9. Error Handling

| Situation | Behaviour |
|-----------|-----------|
| `memory_store::open_conn()` fails | `run_supersession` returns `Err(...)`, sync stores in `last_error`, emits `supersession_error` |
| LLM API key not set | `run_supersession` returns `Ok(0)` immediately (mirrors Phase 1 pattern in lessons.rs) |
| LLM call fails for one pair (network / 429 / 5xx / parse) | `log::warn!` only; pair skipped; loop continues; no emit |
| `mark_superseded` UPDATE fails | Bubble as `Err`; entire batch fails; emit `supersession_error` |
| Lesson archived elsewhere mid-batch | UPDATE guard `WHERE status='active'` makes mark a no-op; loop continues |
| Lesson without `embedding` | Excluded at SELECT; silently skipped |

## 10. Verification

### 10.1 Static checks

```bash
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All must PASS. Pre-existing warnings allowed.

### 10.2 Manual walkthrough

1. Insert two synthetic contradicting lessons via SQLite (same category, different `created_at`, both with embeddings — embeddings can be hand-crafted mirror vectors for testing):
   ```bash
   DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"
   # see synthetic seed in 10.3
   ```
2. From DevTools console: `await window.SHOGUN_RUNTIME?.runAction?.('supersession.run_now', {})`.
3. Expect `{ ok: true, data: { marked: 1 } }`.
4. SQLite check: `SELECT id, status FROM lessons WHERE id='<older-id>'` → `status='superseded'`.
5. Open Settings → KIOKU Lessons → confirm older lesson no longer in list (Sub-spec C `lessons.list` returns active only).
6. Restart app → re-run → `marked: 0` (idempotent: older is no longer active).

### 10.3 Synthetic seed (manual eye-test)

```bash
DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"
sqlite3 "$DB" <<'SQL'
-- Older lesson: avoid emojis
INSERT INTO lessons (id, category, trigger_context, attempted, outcome, rule, scope, source, embedding, embedding_dim, created_at, applies_n, prevented_n, status)
VALUES (
  'super_test_old', 'user_rejection', '{}', '{}', '{}',
  'Avoid emojis in formal replies.', 'user', 'manual_test',
  NULL, NULL,
  (unixepoch() - 60*86400) * 1000,
  0, 0, 'active'
);
-- Newer lesson: use emojis (direct contradiction)
INSERT INTO lessons (id, category, trigger_context, attempted, outcome, rule, scope, source, embedding, embedding_dim, created_at, applies_n, prevented_n, status)
VALUES (
  'super_test_new', 'user_rejection', '{}', '{}', '{}',
  'Use emojis in formal replies to feel friendly.', 'user', 'manual_test',
  NULL, NULL,
  unixepoch() * 1000,
  0, 0, 'active'
);
SQL
```

Note: this seed leaves embeddings NULL. The detection algorithm requires non-null embeddings, so for the eye-test you must ALSO populate embeddings (run `memory.embed_backfill` after insert, or set both rows to identical pre-computed embedding vectors via SQLite BLOB binding).

Cleanup after testing:

```bash
sqlite3 "$DB" "DELETE FROM lessons WHERE source='manual_test';"
```

### 10.4 Cost ceiling sanity

- Confirm `crate::memory_obs::emit("supersession_done", ...)` is emitted with sensible `marked` count.
- Confirm cost ledger (`src-tauri/src/cost_ledger.rs`) records the LLM calls if it is wired to anthropic_tool_complete usage outputs (it should be).

## 11. Out of Scope (Explicit)

These belong to later sub-specs or never:

- **Patterns supersession** — patterns have `mark_stale_sweep`; merging the two hygiene mechanisms is wrong (different semantics).
- **Scope-subsumption / range-absorption judgment** — strict contradiction only for MVP. Looser semantics are a future iteration.
- **Deduplication (same intent, different wording)** — separate problem; not addressed here.
- **Proposal-based UI / approval queue** — explicit decision in § 3 #2.
- **Restoration UI** — `status='superseded'` rows are still in the DB; restoration is via SQL direct-edit if needed. Not worth a Settings surface for an automated hygiene function.
- **`prevented_n` verifier** — Sub-spec E.
- **Per-category K override / settings UI for K** — YAGNI. K=3 is a deliberate hard-coded constant.
- **Cache of judged pairs** — deterministic prompt makes re-judgment cheap; caching adds complexity for negligible gain.
- **Cross-category supersession** — current categories are semantically distinct (`user_rejection` ≠ `tool_failure`); cross-category judgment would only confuse the LLM.

## 12. File Change Summary

| File | Created / Modified | LOC |
|------|--------------------|-----|
| `src-tauri/src/supersession.rs` | Created | ~200 |
| `src-tauri/src/supersession_sync.rs` | Created | ~80 |
| `src-tauri/src/lib.rs` | Modified (mod, spawn, invoke_handler) | +4 |
| `src-tauri/src/commands.rs` | Modified (1 new command) | +6 |
| `hifi/lib/shogun-api.js` | Modified | +1 |
| `hifi/lib/action-registry.js` | Modified | +1 |
| `hifi/action-map.md` | Modified | +1 |
| **Total** | 2 created, 5 modified | ~293 LOC |

## 13. Estimate

**~2 days** including:
- LLM prompt iteration with synthetic data
- Manual eye-test setup (synthetic seed, embedding hand-crafting if needed)
- Verification of `cost_ledger` integration

---

*Approved sections: § 1 / § 2 / § 3 / § 4 / § 5 / § 6 — all approved during brainstorm.*
