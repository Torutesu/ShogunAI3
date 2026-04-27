# KIOKU Lessons MVP — Sub-spec A

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` (§ 3 Lessons + § 7 tasks 1-4)

## Problem

The master KIOKU design proposes two new memory layers — Patterns and
Lessons — to make `memory` actually inform `execution`. The first slice
to ship is the **Lessons** loop in MVP form: capture user-rejected
chat responses and tool-failure events, generate an actionable rule
from each, store them locally, and inject the most semantically
relevant rules into future chat system prompts. Once the loop is in
place, "SHOGUN remembers what didn't work" stops being a slogan and
becomes a real feedback path.

Patterns and the Settings UI live in their own sub-specs (B and C);
this one focuses solely on Lessons capture + injection.

## Goals

- A new `lessons` table in the existing SQLite database (alongside
  `mem_items`, `mem_edges`, etc.).
- Two capture paths:
  - **user_rejection** — the existing "Bad response" button in chat
    becomes functional. Click → backend generates an actionable rule
    via LLM → INSERT.
  - **tool_failure** — the `runAgentNow` callback's failure branch
    (added in the previous Run-now/Pause work) emits a capture call
    on Run now errors. Backend generates a rule → INSERT.
- One injection path:
  - **shogun_chat_complete** — every chat turn embeds the user's
    latest message, finds top-5 lessons by cosine similarity (≥0.75),
    and appends them to the system prompt as a "Lessons from past
    sessions" section. Per-lesson `applies_n` increments on
    successful chat response.
- Silent fallback everywhere — if embeddings or LLM are unavailable,
  the lesson capture and injection both no-op without breaking chat.

## Non-Goals

- The Patterns layer (master spec § 2 / Sub-spec B).
- A Settings UI for browsing or pruning lessons (master spec § 6 /
  Sub-spec C). Captured lessons are inspectable only via SQL or
  future UI.
- The other two `category` values from the master spec
  (`wrong_assumption`, `policy_violation`) — out of scope this round.
- The other two `source` values (`inferred_from_undo`, `manual`) —
  out of scope.
- Supersession (master spec § 3 "昇華") — `status` column exists,
  values stay `'active'` for everything in MVP.
- `prevented_n` increment logic — column exists, stays at 0 in MVP.
  Requires a verifier we don't have yet.
- Schema for Patterns — separate table, separate sub-spec.
- A new `cost_ledger` row per lesson injection embedding. Cost is
  ~$0.00002/turn; logged via existing telemetry but not formally
  tracked yet.
- HNSW vector index. SQLite has no native vector index; the master
  spec's `pgvector` HNSW translates to "scan all `active` rows with
  cosine in Rust", which is fine until we have thousands of lessons
  per user (sub-spec follow-up if performance bites).

## § 1. Schema

### 1.1 Table

Created in `src-tauri/src/kioku_graph_schema.rs::init_schema()` as part
of the existing migration block, alongside `mem_items` and friends:

```sql
CREATE TABLE IF NOT EXISTS lessons (
  id              TEXT PRIMARY KEY,            -- UUID v4 string
  category        TEXT NOT NULL,               -- 'tool_failure' | 'user_rejection'
  trigger_context TEXT NOT NULL,               -- JSON encoded
  attempted       TEXT NOT NULL,               -- JSON encoded
  outcome         TEXT NOT NULL,               -- JSON encoded
  rule            TEXT NOT NULL,               -- LLM-generated, single sentence
  scope           TEXT NOT NULL DEFAULT 'user',
  source          TEXT NOT NULL,               -- 'explicit_feedback' | 'tool_error'
  embedding       BLOB,                        -- f32 little-endian, length = 4 * embedding_dim
  embedding_dim   INTEGER,                     -- nullable; null when embedding is null
  created_at      INTEGER NOT NULL,            -- epoch ms
  applies_n       INTEGER NOT NULL DEFAULT 0,
  prevented_n     INTEGER NOT NULL DEFAULT 0,  -- reserved; stays 0 in MVP
  status          TEXT NOT NULL DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
CREATE INDEX IF NOT EXISTS idx_lessons_active   ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_created  ON lessons(created_at);
```

### 1.2 Translation from master spec

| Master spec (PGLite/pgvector) | This spec (SQLite/rusqlite)                   |
|-------------------------------|-----------------------------------------------|
| `UUID PRIMARY KEY`            | `TEXT PRIMARY KEY` (Uuid::new_v4().to_string()) |
| `JSONB`                       | `TEXT` containing JSON                        |
| `TIMESTAMPTZ`                 | `INTEGER` (epoch ms, matches existing tables) |
| `VECTOR(768)`                 | `BLOB` (f32 little-endian) + `embedding_dim` companion |
| `WHERE status = 'active'` partial index | plain `(status)` index (SQLite supports partial but the simpler form is fine here) |
| `USING hnsw (embedding vector_cosine_ops)` | scan + cosine in Rust (`active` rows only) |

The data model is unchanged; only the storage primitives differ.

## § 2. New Rust module — `src-tauri/src/lessons.rs`

Public API (~250 lines total including helpers):

```rust
pub struct NewLesson {
  pub category: String,
  pub trigger_context: serde_json::Value,
  pub attempted: serde_json::Value,
  pub outcome: serde_json::Value,
  pub rule: String,
  pub source: String,
  pub embedding: Option<Vec<f32>>,
}

pub struct Lesson {
  pub id: String,
  pub category: String,
  pub trigger_context: serde_json::Value,
  pub attempted: serde_json::Value,
  pub outcome: serde_json::Value,
  pub rule: String,
  pub scope: String,
  pub source: String,
  pub embedding: Option<Vec<f32>>,
  pub created_at: i64,
  pub applies_n: i64,
  pub prevented_n: i64,
  pub status: String,
}

pub fn insert_lesson(conn: &Connection, n: &NewLesson) -> Result<String, String>;
pub fn search_by_similarity(
  conn: &Connection,
  query_embedding: &[f32],
  top_k: usize,
  min_similarity: f32,
) -> Result<Vec<Lesson>, String>;
pub fn increment_applies(conn: &Connection, ids: &[String]) -> Result<(), String>;
pub fn list_active(conn: &Connection, limit: usize) -> Result<Vec<Lesson>, String>;
pub fn archive(conn: &Connection, id: &str) -> Result<(), String>;
// dedupe helper for tool_failure capture (see § 3.2)
pub fn recent_match(
  conn: &Connection,
  category: &str,
  attempted_json: &str,
  outcome_json: &str,
  within_ms: i64,
) -> Result<Option<String>, String>;  // returns matching lesson id if found
```

`Vec<f32> ↔ BLOB` conversion uses little-endian f32 packing — independent of `memory_store.rs`'s implementation but matching its on-disk format so a future shared helper can absorb both.

`search_by_similarity` is a single SELECT scanning `WHERE status = 'active' AND embedding IS NOT NULL`, computing cosine similarity per row in Rust, sorting descending, filtering by `min_similarity`, and taking the top `top_k`. With dim=1536 (text-embedding-3-small) and ~500 lessons that's ~3ms — well under chat latency budget.

`recent_match` is used by tool_failure capture to skip duplicate INSERTs when the same `(category, attempted, outcome)` was captured within the last 24h.

## § 3. Capture — backend

### 3.1 user_rejection (`shogun_lesson_capture_rejection`)

New `#[tauri::command]` in `src-tauri/src/commands.rs`. Payload:

```ts
{
  userMsg: string,        // text of the user's prompt that produced the bad reply
  assistantMsg: string,   // text of the rejected assistant response
  chatId?: string,
}
```

Body:

1. Validate `userMsg` and `assistantMsg` are non-empty strings.
2. Build LLM prompt:
   - **system**: `"You generate a one-sentence actionable rule (English) explaining what the AI should NOT do, based on a rejected response. <= 140 chars. Be specific and concrete. Example: 'Don't use emojis in meeting notes.' Output via the emit_lesson_rule tool only."`
   - **user**: `"User asked: {userMsg}\n\nAI replied: {assistantMsg}\n\nUser flagged this reply as bad."`
   - **tool**: `{ name: "emit_lesson_rule", input_schema: { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] } }`
3. Call `llm::anthropic_tool_complete(system, user, tool, "claude-haiku-4-5-20251001")`. (Cheapest reasonable model — rule generation is light.)
4. On success → take `tool_input["rule"]`. On failure → fall back to `format!("Avoid replies similar to one rejected on {}", chrono::Local::now().format("%Y-%m-%d"))`.
5. `embeddings::embed_one(&rule).await.ok()` → `Option<Vec<f32>>`.
6. `lessons::insert_lesson(&conn, &NewLesson { category: "user_rejection", trigger_context: json!({"userMsg": userMsg, "chatId": chatId}), attempted: json!({"assistantMsg": assistantMsg}), outcome: json!({"feedback": "user_rejected"}), rule, source: "explicit_feedback", embedding })`.
7. Return `{ ok: true, data: { id, rule } }`.

### 3.2 tool_failure (`shogun_lesson_capture_tool_failure`)

Payload:

```ts
{
  agentId: string,
  agentName: string,
  action: string,         // e.g. 'gmail.sync'
  payload: object,        // payload sent
  errorMessage: string,
}
```

Body:

1. Validate fields.
2. Build the deduper inputs: `attempted_json = json!({"action": action, "payload": payload}).to_string()`, `outcome_json = json!({"errorMessage": errorMessage}).to_string()`.
3. `lessons::recent_match(&conn, "tool_failure", &attempted_json, &outcome_json, 24 * 60 * 60 * 1000)` — if Some, return `{ ok: true, data: { id, deduped: true } }` immediately, no LLM call.
4. Build LLM prompt (same `emit_lesson_rule` tool):
   - **system**: `"You generate a one-sentence actionable rule (English) explaining a precondition or constraint to check before invoking a tool, based on an observed failure. <= 140 chars. Output via the emit_lesson_rule tool only."`
   - **user**: `"Agent '{agentName}' invoked tool '{action}' with payload {payload_json} and got error: {errorMessage}.\nWhat rule should the AI follow next time?"`
5. Same LLM-or-fallback dance as 3.1. Fallback rule: `format!("{} failed with: {} — verify preconditions", action, errorMessage)`.
6. Embed, INSERT with `category: "tool_failure"`, `source: "tool_error"`.
7. Return `{ ok: true, data: { id, deduped: false } }`.

### 3.3 LLM model choice

Use `claude-haiku-4-5-20251001` for rule generation. Cheap, fast, sufficient for a one-sentence summary task. The existing `SUMMARIZER_MODEL` constant is `claude-haiku-4-5-20251001` (verified) — reuse it.

## § 4. Capture — frontend

### 4.1 user_rejection wiring (`hifi/app.jsx`)

The existing Bad response button at `hifi/app.jsx:3068` is a render-only stub flagged by `check-actions.py`. Add `onClick`:

```jsx
<button
  type="button"
  className="hummingbird-icon-btn"
  title="Bad response"
  aria-label="Bad response"
  onClick={() => {
    const lastUserMsg = /* nearest preceding user turn text in this thread */;
    const thisAssistantMsg = /* the assistant text this button is attached to */;
    if (!lastUserMsg || !thisAssistantMsg) return;
    runRuntimeAction('lesson.capture.rejection', {
      userMsg: lastUserMsg,
      assistantMsg: thisAssistantMsg,
      chatId: activeChatId,
    }, { silentError: true, successMessage: "Got it — won't do that again." });
  }}
>
```

The exact code to extract `lastUserMsg` and `thisAssistantMsg` depends on the existing chat message data structure in app.jsx; the implementation plan walks through this.

### 4.2 tool_failure wiring (`hifi/screens-agents.jsx`)

Extend the existing `runAgentNow` callback's `else` branch (added in the Run now/Pause work):

```js
} else {
  const errMsg = res?.error?.message || 'Run failed';
  window.SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
  // NEW: capture as lesson (silent — no toast, no UI feedback)
  runRuntimeActionA('lesson.capture.tool_failure', {
    agentId,
    agentName: agent.name,
    action: def.runNowAction,
    payload: def.runNowPayload(),
    errorMessage: errMsg,
  }, { silentError: true });
}
```

No user-visible feedback for tool_failure capture — the warn toast for the failure itself is enough. Lessons accumulate quietly in the background.

## § 5. Injection — backend

### 5.1 Modify `shogun_chat_complete`

The command is at `src-tauri/src/commands.rs:123`. Around the point where the system prompt is finalized and just before the Anthropic call, insert:

```rust
let (lessons_addendum, applied_lesson_ids) = lessons::retrieve_for_chat(
  &conn,
  &latest_user_message_text,
).await.unwrap_or_else(|e| {
  log::warn!("lessons::retrieve_for_chat failed: {}", e);
  (String::new(), vec![])
});
let final_system = format!("{}{}", base_system, lessons_addendum);
// ... existing Anthropic call using `final_system` ...

// After the Anthropic call returns successfully:
if !applied_lesson_ids.is_empty() {
  if let Err(e) = lessons::increment_applies(&conn, &applied_lesson_ids) {
    log::warn!("lessons::increment_applies failed: {}", e);
  }
}
```

### 5.2 `lessons::retrieve_for_chat` helper

```rust
pub async fn retrieve_for_chat(
  conn: &Connection,
  user_message: &str,
) -> Result<(String, Vec<String>), String> {
  let trimmed = user_message.trim();
  if trimmed.is_empty() {
    return Ok((String::new(), vec![]));
  }
  let query_emb = match crate::embeddings::embed_one(trimmed).await {
    Ok(v) => v,
    Err(e) => {
      log::warn!("lessons embed_one failed: {}", e);
      return Ok((String::new(), vec![]));
    }
  };
  let top = search_by_similarity(conn, &query_emb, 5, 0.75)?;
  if top.is_empty() {
    return Ok((String::new(), vec![]));
  }
  // Dedupe by case-insensitive rule text
  let mut seen = std::collections::HashSet::new();
  let mut ids = Vec::new();
  let mut lines = Vec::new();
  for l in &top {
    let key = l.rule.trim().to_lowercase();
    if !seen.insert(key) { continue; }
    lines.push(format!("- {}", l.rule));
    ids.push(l.id.clone());
  }
  let addendum = format!(
    "\n\n## Lessons from past sessions\n\nThe user has previously corrected or rejected responses; honor these:\n{}",
    lines.join("\n")
  );
  Ok((addendum, ids))
}
```

### 5.3 Failure modes

- **embeddings fail** (no API key, network down): return empty addendum. Chat continues normally.
- **search fails** (DB error): return empty addendum + log::warn.
- **increment_applies fails after a successful chat**: log::warn only. The chat response was already returned to the user; we don't undo it.

Every path is silent fallback. The user never sees a "lessons unavailable" error.

## § 6. IPC plumbing (frontend)

### 6.1 `hifi/lib/shogun-api.js` — add 2 method bindings

```js
lessonCaptureRejection: (input) => call("shogun_lesson_capture_rejection", input, WRITE),
lessonCaptureToolFailure: (input) => call("shogun_lesson_capture_tool_failure", input, WRITE),
```

### 6.2 `hifi/lib/action-registry.js` — register 2 actions

```js
register("lesson.capture.rejection", (payload) => api.lessonCaptureRejection(payload));
register("lesson.capture.tool_failure", (payload) => api.lessonCaptureToolFailure(payload));
```

### 6.3 `hifi/action-map.md` — add 2 entries

```
- `lesson.capture.rejection`
- `lesson.capture.tool_failure`
```

### 6.4 Tauri command registration in `src-tauri/src/lib.rs`

Two new entries in the `invoke_handler![…]` list:

```rust
commands::shogun_lesson_capture_rejection,
commands::shogun_lesson_capture_tool_failure,
```

Plus `mod lessons;` near the other module declarations.

## § 7. Implementation surface

| File | Change | Approx LOC |
|------|--------|-----------|
| `src-tauri/src/lessons.rs` | NEW | ~250 |
| `src-tauri/src/kioku_graph_schema.rs` | + lessons CREATE TABLE + indexes | ~15 |
| `src-tauri/src/lib.rs` | + `mod lessons;` + 2 invoke_handler entries | ~3 |
| `src-tauri/src/commands.rs` | + 2 capture commands + retrieve hook in shogun_chat_complete | ~80 |
| `hifi/lib/shogun-api.js` | + 2 method bindings | ~2 |
| `hifi/lib/action-registry.js` | + 2 register calls | ~2 |
| `hifi/action-map.md` | + 2 entries | ~2 |
| `hifi/app.jsx` | Bad response button onClick | ~10 |
| `hifi/screens-agents.jsx` | tool_failure capture call in runAgentNow else | ~10 |

Total ~370 lines / 9 files. Rust + JS, requires `cargo build`.

## § 8. Testing & verification

Static checks (no automated unit tests this round — the spec follows the project's existing pattern of relying on `npm run check:*` + `cargo check` + manual eye-test):

```bash
npm run check:rust       # cargo check
npm run check:ipc-mock   # ipc mock parity
python3 hifi/scripts/check-actions.py
```

Expected: all PASS (no new errors). The 2 new action keys must appear in `action-registry.js`, `shogun-api.js`, and `action-map.md`.

Manual eye-test (Tauri dev app, after rebuild):

1. Open Chat. Send "summarize this PR with emojis" → assistant replies.
2. Click Bad response (the right-thumbsdown icon). Toast: "Got it — won't do that again." Verify in DevTools console / SQL that a new row exists in `lessons` with `category = 'user_rejection'` and a sensible `rule` (e.g. "Don't include emojis in PR summaries.").
3. Send a follow-up similar query. Inspect the chat call's actual system prompt (via Anthropic dashboard or backend log) — the "Lessons from past sessions" section should be present with the captured rule.
4. Open Agents screen. Pause the agent's underlying integration so Run now will fail (e.g. revoke gmail credentials), then click `[▶ Run now]` on Inbox triage. Verify a `tool_failure` lesson is captured (no toast, but row appears in DB).
5. Click Run now again on the same failure within 24h. Verify NO duplicate row is added (dedupe).
6. Disconnect the embedding provider (clear OpenAI key in settings). Send a chat. Should succeed with no Lessons addendum and no error to the user.

## § 9. Rollout

Single change, no migration risks (lessons table is new), no flag.
The Bad response button was a no-op stub before this change; users
gain functionality silently. Tool failure capture only runs on Run
now invocations (no broad IPC instrumentation), so noise is bounded.

After this ships, Sub-spec B can build on top of `lessons.rs`'s
schema patterns without touching its data path.
