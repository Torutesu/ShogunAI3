# Memory Observability — Phase B-2: Developer Memory Debugger Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dev-only `Memory Debugger` screen to the Hi-Fi UI with four tabs (Query Tester / Recent Calls / Sync Health / DB Stats), backed by a Rust-side ring buffer of LLM call traces and four new IPC commands. The screen provides direct visibility into what the context layer is assembling, what flows to the LLM, and what state the sync pipelines are in.

**Architecture:** A new Rust module `src-tauri/src/memory_debug.rs` owns a `Mutex<VecDeque<CallTrace>>` ring buffer (cap 50) exposed via `tauri::State`. Each top-level LLM call (`chat_complete` with `memoryAssembly`, `brief_generate`, `draft_reply_for_brief`, `draft_from_payload` with `memoryAssembly`) pushes one `CallTrace` on completion. Four new `#[cfg(debug_assertions)]`-gated IPC commands return ring buffer snapshots, re-runnable query results, sync-health snapshots, and extended DB stats. Frontend adds a single new file `hifi/screens-memory-debug.jsx` with four tabs driven by local `useState`. Visibility is double-gated: `cfg(debug_assertions)` at compile time AND `settings.sections.developer.memoryDebugger === true` at runtime.

**Tech Stack:** Rust 2021 / Tauri v2 / React 18 (via Babel in-browser, matches existing screens-*.jsx pattern) / `log` + `testing_logger` (already from B-1) / no new runtime deps.

**Spec:** `docs/superpowers/specs/2026-04-23-memory-observability-design.md`
**Prerequisite:** `docs/superpowers/plans/2026-04-23-memory-observability-b1.md` — this plan assumes B-1 is merged (specifically, the `memory_obs` module and the emit call sites).

---

## Scope

This plan implements **B-2 only**. C (user-facing context badges) is a separate future plan.

## File Structure

**New files:**
- `src-tauri/src/memory_debug.rs` — ring buffer, CallTrace struct, snapshot helpers, dev-gate helper
- `hifi/screens-memory-debug.jsx` — the new screen with 4 tabs

**Modified files:**
- `src-tauri/src/lib.rs` — register module, manage ring buffer state, add 5 new command handlers (gated by `cfg(debug_assertions)`)
- `src-tauri/src/commands.rs` — add 5 new `#[tauri::command]` handlers
- `src-tauri/src/llm.rs` — after each B-1 emit, also push a `CallTrace` into the ring buffer (chat_complete / brief_generate / draft_reply_for_brief / draft_from_payload)
- `src-tauri/src/calendar_sync.rs` — extend `LAST_SYNC_MS` static to a `CalendarSyncState { last_sync_ms, last_ingested, last_error, last_duration_ms }` + snapshot fn
- `src-tauri/src/gmail.rs` — add module-level `GmailSyncState` + snapshot fn, updated at `sync_inbox_to_memory` start/end
- `src-tauri/src/memory_store.rs` — add `stats_extended()` returning source/provenance breakdown + FTS integrity + embedding coverage
- `hifi/lib/shogun-api.js` — add 5 new API wrappers
- `hifi/lib/ipc-client.js` — add passthrough for the new commands (mock branch returns empty / placeholder)
- `hifi/app.jsx` — register `memory_debug` in `NAV` (conditional on dev gate), add to `Screen` map, gate nav-item rendering
- `SHOGUN Hi-Fi UI.html` — add `<script type="text/babel" src="hifi/screens-memory-debug.jsx"></script>` tag

**No changes to:** `context_assembly.rs`, `memory_obs.rs` (both stay as-is from B-1).

---

## Task 1: Create `memory_debug` module with ring buffer

**Files:**
- Create: `src-tauri/src/memory_debug.rs`
- Modify: `src-tauri/src/lib.rs` (declare module + manage state)

### Step 1.1: Write the ring buffer struct and tests

- [ ] **Create `src-tauri/src/memory_debug.rs` with exactly:**

```rust
//! Dev-only ring buffer of recent LLM call traces. Populated alongside
//! the B-1 `memory_obs` emits; exposed to the frontend via
//! `shogun_memory_debug_recent_calls` (debug builds only).

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;

pub const RING_CAPACITY: usize = 50;

#[derive(Clone, Debug, Serialize)]
pub enum CallStatus {
    Ok,
    Err(String),
}

#[derive(Clone, Debug, Serialize)]
pub struct CallTrace {
    pub ts_ms: u64,
    pub route: &'static str,
    pub query_preview: String,
    pub query_len: usize,
    pub limit: u64,
    pub semantic: bool,
    pub hits_count: usize,
    pub provenance_counts: ProvenanceCounts,
    pub block_chars: usize,
    pub elapsed_ms: u64,
    pub status: CallStatus,
    pub assembled_block: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ProvenanceCounts {
    pub screen: u32,
    pub connector: u32,
    pub meeting: u32,
    pub user: u32,
}

/// `tauri::State`-managed ring buffer. Cloned on snapshot.
#[derive(Default)]
pub struct RingBuffer {
    inner: Mutex<VecDeque<CallTrace>>,
}

impl RingBuffer {
    pub fn push(&self, trace: CallTrace) {
        if let Ok(mut q) = self.inner.lock() {
            if q.len() >= RING_CAPACITY {
                q.pop_front();
            }
            q.push_back(trace);
        }
    }

    pub fn snapshot(&self, limit: usize) -> Vec<CallTrace> {
        let Ok(q) = self.inner.lock() else {
            return Vec::new();
        };
        let n = limit.min(q.len());
        q.iter().rev().take(n).cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|q| q.len()).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_trace(route: &'static str, ts_ms: u64) -> CallTrace {
        CallTrace {
            ts_ms,
            route,
            query_preview: String::new(),
            query_len: 0,
            limit: 12,
            semantic: false,
            hits_count: 0,
            provenance_counts: ProvenanceCounts::default(),
            block_chars: 0,
            elapsed_ms: 0,
            status: CallStatus::Ok,
            assembled_block: None,
        }
    }

    #[test]
    fn push_stores_and_snapshot_returns_newest_first() {
        let rb = RingBuffer::default();
        rb.push(mk_trace("chat.complete", 1));
        rb.push(mk_trace("brief.get", 2));
        rb.push(mk_trace("draft_reply", 3));
        let snap = rb.snapshot(10);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].ts_ms, 3);
        assert_eq!(snap[1].ts_ms, 2);
        assert_eq!(snap[2].ts_ms, 1);
    }

    #[test]
    fn push_evicts_oldest_when_full() {
        let rb = RingBuffer::default();
        for i in 0..(RING_CAPACITY + 5) as u64 {
            rb.push(mk_trace("chat.complete", i));
        }
        assert_eq!(rb.len(), RING_CAPACITY);
        let snap = rb.snapshot(RING_CAPACITY);
        // Newest first; oldest surviving is `5` (since 0..4 were evicted).
        assert_eq!(snap[0].ts_ms, (RING_CAPACITY + 4) as u64);
        assert_eq!(snap[RING_CAPACITY - 1].ts_ms, 5);
    }

    #[test]
    fn snapshot_respects_limit_smaller_than_queue() {
        let rb = RingBuffer::default();
        for i in 0..10u64 {
            rb.push(mk_trace("chat.complete", i));
        }
        let snap = rb.snapshot(3);
        assert_eq!(snap.len(), 3);
        assert_eq!(snap[0].ts_ms, 9);
        assert_eq!(snap[2].ts_ms, 7);
    }

    #[test]
    fn snapshot_on_empty_returns_empty_vec() {
        let rb = RingBuffer::default();
        assert!(rb.snapshot(10).is_empty());
    }
}
```

- [ ] **Declare the module and register the state in `src-tauri/src/lib.rs`.**

Add near the other `mod <name>;` declarations (alphabetical order puts it near `memory_obs`):

```rust
mod memory_debug;
```

In the `tauri::Builder` chain, find the existing `.manage(...)` calls (around line 67-69). Add:

```rust
    .manage(memory_debug::RingBuffer::default())
```

### Step 1.2: Verify

- [ ] **Run:** `cd src-tauri && cargo test --lib memory_debug`
  **Expected:** All 4 tests pass.

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Commit:**

```bash
git add src-tauri/src/memory_debug.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): add ring buffer for recent LLM call traces"
```

---

## Task 2: Push `CallTrace` from LLM call sites

**Files:**
- Modify: `src-tauri/src/llm.rs` (`chat_complete`, `brief_generate`, `draft_reply_for_brief`, `draft_from_payload`)

### Step 2.1: Add helper to build ProvenanceCounts from hits

- [ ] **In `src-tauri/src/llm.rs`, at the top of the file (after the existing `use` statements), add:**

```rust
fn provenance_counts_from_hits(
  hits: &[context_assembly::Hit],
) -> crate::memory_debug::ProvenanceCounts {
  let mut c = crate::memory_debug::ProvenanceCounts::default();
  for h in hits {
    match h.provenance.as_str() {
      "screen" => c.screen += 1,
      "connector" => c.connector += 1,
      "meeting" => c.meeting += 1,
      _ => c.user += 1,
    }
  }
  c
}
```

### Step 2.2: Push trace from `chat_complete` memoryAssembly branch

- [ ] **Locate the `chat_complete` function's `memoryAssembly` branch (around lines 106-136 after B-1). After the `crate::memory_obs::emit("chat_memory_block", ...)` call, capture the inputs needed for the trace and push:**

Modify the block so it looks like this (showing the edit context):

```rust
      let block = context_assembly::format_hits_draft_context(&hits, 10_000);
      let manual_ctx = payload
        .get("memoryContext")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
      crate::memory_obs::emit(
        "chat_memory_block",
        &[
          ("block_chars", block.chars().count().to_string()),
          ("hits", hits.len().to_string()),
          ("manual_ctx", manual_ctx.to_string()),
          ("semantic", semantic.to_string()),
        ],
      );
      if let Some(ring) = chat_ring.as_ref() {
        ring.push(crate::memory_debug::CallTrace {
          ts_ms: now_ms(),
          route: "chat.complete",
          query_preview: crate::memory_obs::clip_preview(q),
          query_len: q.chars().count(),
          limit,
          semantic,
          hits_count: hits.len(),
          provenance_counts: provenance_counts_from_hits(&hits),
          block_chars: block.chars().count(),
          elapsed_ms: chat_start.elapsed().as_millis() as u64,
          status: crate::memory_debug::CallStatus::Ok,
          assembled_block: Some(block.clone()),
        });
      }
      if !block.is_empty() {
        // existing push into `messages` continues unchanged ...
```

To make this compile, we need to thread the ring buffer into `chat_complete`. Two options:

1. **(chosen)** Change `chat_complete` signature to accept `Option<&RingBuffer>`. Call sites pass `None` or `Some(ring)`.
2. Use a global `tauri::State` — requires lifting into a command wrapper.

**Apply option 1:**

- [ ] **Change the signature of `chat_complete`:**

```rust
pub async fn chat_complete(
  payload: &Value,
  chat_ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
  let chat_start = std::time::Instant::now();
  // ... existing body ...
```

- [ ] **Add a `now_ms` helper at the top of the file (after the `use` statements):**

```rust
fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}
```

- [ ] **Update all internal callers of `chat_complete` within `llm.rs`. The other three functions (`brief_generate`, `draft_reply_for_brief`, `draft_from_payload`) call `chat_complete(&synthetic)` — change each to `chat_complete(&synthetic, None)`. They each push their own CallTrace, so they pass `None` here to avoid double-counting.**

- [ ] **Update the IPC command entry `commands::shogun_chat_complete`. Open `src-tauri/src/commands.rs` around line 118-120:**

Before:
```rust
#[tauri::command]
pub async fn shogun_chat_complete(payload: Value) -> Result<Value, String> {
  llm::chat_complete(&payload).await
}
```

After:
```rust
#[tauri::command]
pub async fn shogun_chat_complete(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  llm::chat_complete(&payload, Some(&*ring)).await
}
```

### Step 2.3: Push trace from `brief_generate`

- [ ] **In `brief_generate`, after the existing `brief_generate_done` emit and before the final `Ok(json!({...}))`, add:**

We also need the ring buffer here. Apply the same signature pattern:

```rust
pub async fn brief_generate(
  payload: &Value,
  ring: Option<&crate::memory_debug::RingBuffer>,
) -> Result<Value, String> {
  // ... existing body up to the emit ...
  if let Some(r) = ring {
    let block_chars = block.chars().count();
    r.push(crate::memory_debug::CallTrace {
      ts_ms: now_ms(),
      route: "brief.get",
      query_preview: String::new(),
      query_len: 0,
      limit: 15,
      semantic: false,
      hits_count: hits_count,
      provenance_counts: provenance_counts_from_hits(&hits),
      block_chars,
      elapsed_ms: start.elapsed().as_millis() as u64,
      status: crate::memory_debug::CallStatus::Ok,
      assembled_block: Some(block.clone()),
    });
  }
  // existing Ok(json!(...)) returns
```

Update the internal `chat_complete` call to pass `None`.

- [ ] **Update `commands::shogun_brief_get` to pass the ring:**

```rust
#[tauri::command]
pub async fn shogun_brief_get(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  // keep existing brief v2 stub branch
  let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
  if brief::should_use_v2(&settings, &payload) {
    let user_tz = payload.get("user_tz").and_then(|v| v.as_str()).unwrap_or("UTC");
    let ms = ts();
    return Ok(brief::morning_brief_v2_stub(ms, user_tz, &payload));
  }
  llm::brief_generate(&payload, Some(&*ring)).await
}
```

### Step 2.4: Push trace from `draft_reply_for_brief`

- [ ] **Apply the same pattern: add `ring: Option<&RingBuffer>` to the signature, push a CallTrace after the existing `draft_reply_done` emit with `route: "draft_reply"`, `query_preview: clip_preview(&q)`, `query_len: q.chars().count()`, `limit: 12`, `semantic: true`. Update its `chat_complete` call to pass `None`.**

- [ ] **Update the command handler for draft_reply (it's in `commands.rs` — search for `draft_reply_for_brief`):**

```rust
#[tauri::command]
pub async fn shogun_draft_reply(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: Value,
) -> Result<Value, String> {
  llm::draft_reply_for_brief(&payload, Some(&*ring)).await
}
```

(If the actual command name differs, match the existing handler.)

### Step 2.5: Push trace from `draft_from_payload` (when memoryAssembly is used)

- [ ] **Apply the same signature change. Push a CallTrace only when the `memoryAssembly` branch ran (i.e., `memory_used == true` from B-1). `route: "draft_from_payload"`, with the query values from the `ma` object. Pass `None` to the internal `chat_complete` call.**

- [ ] **Update the command handler for `shogun_draft` similarly to pass the ring.**

### Step 2.6: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean. No warnings.

- [ ] **Run:** `cd src-tauri && cargo test --lib`
  **Expected:** All existing tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/llm.rs src-tauri/src/commands.rs
git commit -m "feat(memory-debug): push CallTrace on chat/brief/draft completions"
```

---

## Task 3: IPC command `shogun_memory_debug_recent_calls`

**Files:**
- Modify: `src-tauri/src/memory_debug.rs` (add the command function if we want it colocated; or keep in commands.rs)
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register handler)

### Step 3.1: Add the handler

- [ ] **In `src-tauri/src/commands.rs`, at the bottom, add:**

```rust
#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_recent_calls(
  ring: tauri::State<'_, crate::memory_debug::RingBuffer>,
  payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(50)
    .min(crate::memory_debug::RING_CAPACITY as u64) as usize;
  let calls = ring.snapshot(limit);
  Ok(serde_json::json!({
    "calls": calls,
    "capacity": crate::memory_debug::RING_CAPACITY,
  }))
}
```

- [ ] **Register the handler in `src-tauri/src/lib.rs`. Find the `tauri::generate_handler![...]` block (around line 102+). At the end of the list, add a conditional block:**

```rust
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_recent_calls,
```

Since `generate_handler!` is a macro with comma-separated items, `#[cfg(...)]` on an individual item works.

### Step 3.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Commit:**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): expose recent_calls IPC command (debug builds)"
```

---

## Task 4: IPC command `shogun_memory_debug_query`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 4.1: Add the handler

- [ ] **In `commands.rs`, add below the previous handler:**

```rust
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn shogun_memory_debug_query(
  payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  use crate::context_assembly;
  let query = payload
    .get("query")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let limit = payload
    .get("limit")
    .and_then(|v| v.as_u64())
    .unwrap_or(12)
    .clamp(1, 80);
  let semantic = payload
    .get("semantic")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: &query,
    limit,
    semantic,
  })
  .await?;

  let draft_block = context_assembly::format_hits_draft_context(&hits, 10_000);
  let brief_block = context_assembly::format_hits_brief_json_prompt(&hits, 10_000);
  let reply_block = context_assembly::format_hits_reply_draft(&hits);

  let items: Vec<serde_json::Value> = hits
    .iter()
    .map(|h| {
      serde_json::json!({
        "id": h.id,
        "title": h.title,
        "snippet": h.snippet,
        "source": h.source,
        "provenance": h.provenance,
        "created_at": h.created_at,
      })
    })
    .collect();

  Ok(serde_json::json!({
    "hits": items,
    "draft_block": draft_block,
    "brief_block": brief_block,
    "reply_block": reply_block,
    "query": query,
    "limit": limit,
    "semantic": semantic,
  }))
}
```

- [ ] **Register in `lib.rs` inside `generate_handler!`:**

```rust
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_query,
```

### Step 4.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Commit:**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): expose query-tester IPC command (debug builds)"
```

---

## Task 5: Extended DB stats

**Files:**
- Modify: `src-tauri/src/memory_store.rs` (add `stats_extended`)
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 5.1: Add `stats_extended` to `memory_store`

- [ ] **Read `src-tauri/src/memory_store.rs` around line 1229 where `pub fn stats()` is defined to match its style. Add a new function immediately after:**

```rust
/// Extended stats for the Memory Debugger (B-2). Returns breakdown by source
/// and provenance, FTS integrity (base vs fts row count), and embedding
/// coverage by source. Read-only.
pub fn stats_extended() -> Result<Value, String> {
  let conn = open_conn()?;

  let total: i64 = conn
    .query_row("SELECT COUNT(*) FROM mem_items", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;

  let fts_total: i64 = conn
    .query_row("SELECT COUNT(*) FROM mem_items_fts", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;

  let mut by_source = Vec::new();
  {
    let mut stmt = conn
      .prepare(
        "SELECT source, COUNT(*), SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END)
         FROM mem_items GROUP BY source ORDER BY 2 DESC",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |r| {
        Ok((
          r.get::<_, String>(0)?,
          r.get::<_, i64>(1)?,
          r.get::<_, i64>(2).unwrap_or(0),
        ))
      })
      .map_err(|e| e.to_string())?;
    for row in rows {
      let (source, rows_n, with_embed) = row.map_err(|e| e.to_string())?;
      by_source.push(json!({
        "source": source,
        "rows": rows_n,
        "with_embed": with_embed,
      }));
    }
  }

  let mut by_provenance = Vec::new();
  {
    let mut stmt = conn
      .prepare(
        "SELECT COALESCE(provenance,''), COUNT(*) FROM mem_items GROUP BY provenance",
      )
      .map_err(|e| e.to_string())?;
    let rows = stmt
      .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
      .map_err(|e| e.to_string())?;
    for row in rows {
      let (prov, rows_n) = row.map_err(|e| e.to_string())?;
      by_provenance.push(json!({
        "provenance": if prov.is_empty() { "(null)".to_string() } else { prov },
        "rows": rows_n,
      }));
    }
  }

  let (earliest, latest): (Option<i64>, Option<i64>) = conn
    .query_row("SELECT MIN(created_at), MAX(created_at) FROM mem_items", [], |r| {
      Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<i64>>(1)?))
    })
    .map_err(|e| e.to_string())?;

  let db_bytes = db_path()
    .ok()
    .and_then(|p| std::fs::metadata(p).ok())
    .map(|m| m.len())
    .unwrap_or(0);

  Ok(json!({
    "total": total,
    "fts_total": fts_total,
    "fts_integrity": total == fts_total,
    "by_source": by_source,
    "by_provenance": by_provenance,
    "earliest_ms": earliest,
    "latest_ms": latest,
    "db_bytes": db_bytes,
  }))
}
```

### Step 5.2: Add command handler + register

- [ ] **In `commands.rs`, add:**

```rust
#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_stats() -> Result<serde_json::Value, String> {
  crate::memory_store::stats_extended()
}
```

- [ ] **In `lib.rs`, add to `generate_handler!`:**

```rust
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_stats,
```

### Step 5.3: Verify

- [ ] **Run:** `cd src-tauri && cargo build && cargo test --lib memory_store`
  **Expected:** Clean build, tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/memory_store.rs src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): extended DB stats with source/provenance breakdown"
```

---

## Task 6: Calendar + Gmail sync state snapshots

**Files:**
- Modify: `src-tauri/src/calendar_sync.rs` (expand state)
- Modify: `src-tauri/src/gmail.rs` (add state)

### Step 6.1: Expand `calendar_sync.rs` state

- [ ] **Replace the existing `static LAST_SYNC_MS: Mutex<Option<u64>> = Mutex::new(None);` (line 8) with:**

```rust
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CalendarSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<CalendarSyncState> = Mutex::new(CalendarSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> CalendarSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}
```

- [ ] **Update the loop body in `spawn_background_calendar_sync`. Wherever it previously accessed `LAST_SYNC_MS`, switch to `STATE`. Specifically:**

Replace:
```rust
      let last_ms = LAST_SYNC_MS.lock().ok().and_then(|g| *g);
```

With:
```rust
      let last_ms = STATE.lock().ok().and_then(|g| g.last_sync_ms);
```

Replace the success branch:
```rust
          if let Ok(mut last) = LAST_SYNC_MS.lock() {
            *last = Some(now_ms());
          }
```

With:
```rust
          if let Ok(mut s) = STATE.lock() {
            s.last_sync_ms = Some(now_ms());
            s.last_ingested = Some(n);
            s.last_error = None;
            s.last_duration_ms = Some(sync_start.elapsed().as_millis() as u64);
          }
```

Add an error-path update immediately after the `log::warn!("calendar auto-sync failed: {}", e);` line:

```rust
          if let Ok(mut s) = STATE.lock() {
            s.last_error = Some(e.clone());
            s.last_duration_ms = Some(sync_start.elapsed().as_millis() as u64);
          }
```

(The `log::warn!` and the `memory_obs::emit` lines from B-1 remain unchanged.)

### Step 6.2: Add state to `gmail.rs`

- [ ] **At the top of `gmail.rs` (after the existing `use` statements), add:**

```rust
use std::sync::Mutex;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct GmailSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<GmailSyncState> = Mutex::new(GmailSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> GmailSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}
```

- [ ] **Update `sync_inbox_to_memory` to write into `STATE` at success and error paths. Find the final `Ok(json!({...}))` (around line 156) and add just before it:**

```rust
  if let Ok(mut s) = STATE.lock() {
    s.last_sync_ms = Some(now_ms());
    s.last_ingested = Some(ingested as u64);
    s.last_error = None;
    s.last_duration_ms = Some(start.elapsed().as_millis() as u64);
  }
```

Find the `return Err(err);` line from B-1 task 7 (around line 120) and add before it:

```rust
  if let Ok(mut s) = STATE.lock() {
    s.last_error = Some(err.clone());
    s.last_duration_ms = Some(start.elapsed().as_millis() as u64);
  }
```

### Step 6.3: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib`
  **Expected:** Existing tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/calendar_sync.rs src-tauri/src/gmail.rs
git commit -m "feat(memory-debug): track calendar + gmail sync state for snapshot"
```

---

## Task 7: IPC command `shogun_memory_debug_sync_status`

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

### Step 7.1: Add the handler

- [ ] **In `commands.rs`:**

```rust
#[cfg(debug_assertions)]
#[tauri::command]
pub fn shogun_memory_debug_sync_status() -> Result<serde_json::Value, String> {
  use crate::integration_secrets;
  use crate::settings_store;

  let cal_snap = crate::calendar_sync::snapshot_state();
  let gmail_snap = crate::gmail::snapshot_state();
  let doc = settings_store::load().unwrap_or_else(|_| serde_json::json!({ "sections": {} }));
  let auto_cal = doc
    .pointer("/sections/integrations/googleCalendarAutoSync")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let cal_creds = integration_secrets::get_credentials("google_calendar")
    .ok()
    .flatten()
    .is_some();
  let gmail_creds = integration_secrets::get_credentials("gmail")
    .ok()
    .flatten()
    .is_some();

  Ok(serde_json::json!({
    "google_calendar": {
      "last_sync_ms": cal_snap.last_sync_ms,
      "last_ingested": cal_snap.last_ingested,
      "last_error": cal_snap.last_error,
      "last_duration_ms": cal_snap.last_duration_ms,
      "credentials_present": cal_creds,
      "auto_enabled": auto_cal,
    },
    "gmail": {
      "last_sync_ms": gmail_snap.last_sync_ms,
      "last_ingested": gmail_snap.last_ingested,
      "last_error": gmail_snap.last_error,
      "last_duration_ms": gmail_snap.last_duration_ms,
      "credentials_present": gmail_creds,
      "auto_enabled": false,
    }
  }))
}
```

- [ ] **Register in `lib.rs`:**

```rust
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_sync_status,
```

### Step 7.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Commit:**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): expose sync_status IPC command (debug builds)"
```

---

## Task 8: Dev-gate IPC command

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

The frontend needs to know whether to show the nav entry. One source of truth:

### Step 8.1: Handler

- [ ] **In `commands.rs`:**

```rust
#[tauri::command]
pub fn shogun_memory_debug_gate() -> Result<serde_json::Value, String> {
  // `cfg!` evaluates at compile time to a bool — safe to use inside
  // the function body (unlike `#[cfg(...)]` on expression blocks).
  if !cfg!(debug_assertions) {
    return Ok(serde_json::json!({
      "available": false,
      "reason": "release_build",
    }));
  }
  let enabled = settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/developer/memoryDebugger")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(false);
  Ok(serde_json::json!({
    "available": enabled,
    "reason": if enabled { "enabled" } else { "settings_disabled" },
  }))
}
```

Note: this command is registered in **all** builds, so the frontend can always call it. Only the `available: true` case yields a visible nav entry.

- [ ] **Register in `lib.rs` (not behind cfg):**

```rust
      commands::shogun_memory_debug_gate,
```

### Step 8.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build && cargo test --lib`
  **Expected:** Clean build, tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(memory-debug): add dev-gate IPC command"
```

---

## Task 9: Frontend API wrappers

**Files:**
- Modify: `hifi/lib/shogun-api.js`
- Modify: `hifi/lib/ipc-client.js`

### Step 9.1: API wrappers

- [ ] **Open `hifi/lib/shogun-api.js` and find the main API object (around line 30-40). Add these entries alongside the existing `memorySearch`, `memoryFetch`, etc.:**

```javascript
      memoryDebugRecentCalls: (input) => call("shogun_memory_debug_recent_calls", input || { limit: 50 }, READ),
      memoryDebugQuery: (input) => call("shogun_memory_debug_query", input, READ),
      memoryDebugStats: () => call("shogun_memory_debug_stats", {}, READ),
      memoryDebugSyncStatus: () => call("shogun_memory_debug_sync_status", {}, READ),
      memoryDebugGate: () => call("shogun_memory_debug_gate", {}, READ),
```

### Step 9.2: Mock IPC branch (so non-Tauri previews don't crash)

- [ ] **In `hifi/lib/ipc-client.js`, find the `switch (command)` block (around line 278+) where other commands route. Add cases that return placeholders (for browser-only preview without Tauri):**

```javascript
      case "shogun_memory_debug_gate":
        return { available: false, reason: "mock_browser" };
      case "shogun_memory_debug_recent_calls":
        return { calls: [], capacity: 50 };
      case "shogun_memory_debug_query":
        return {
          hits: [],
          draft_block: "",
          brief_block: "",
          reply_block: "",
          query: (input && input.query) || "",
          limit: (input && input.limit) || 12,
          semantic: !!(input && input.semantic),
        };
      case "shogun_memory_debug_stats":
        return {
          total: 0,
          fts_total: 0,
          fts_integrity: true,
          by_source: [],
          by_provenance: [],
          earliest_ms: null,
          latest_ms: null,
          db_bytes: 0,
        };
      case "shogun_memory_debug_sync_status":
        return {
          google_calendar: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
          gmail: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
        };
```

### Step 9.3: Verify

- [ ] **Run:** `cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run check:ipc-mock`
  **Expected:** Command name check passes (existing script). If it doesn't recognize the new names, update the allow-list or extend the check per the script's conventions.

- [ ] **Commit:**

```bash
git add hifi/lib/shogun-api.js hifi/lib/ipc-client.js
git commit -m "feat(memory-debug): add frontend API wrappers + mock passthrough"
```

---

## Task 10: Memory Debugger screen — scaffolding + Query Tester tab

**Files:**
- Create: `hifi/screens-memory-debug.jsx`
- Modify: `SHOGUN Hi-Fi UI.html` (add script tag)
- Modify: `hifi/app.jsx` (NAV + Screen map + global hint comment)

### Step 10.1: Create the screen file

- [ ] **Create `hifi/screens-memory-debug.jsx` with:**

```jsx
/* global React */
const { useState, useEffect, useCallback } = React;

function msToLocal(ms) {
  if (!ms) return "—";
  try {
    return new Date(Number(ms)).toLocaleString();
  } catch (_) {
    return "—";
  }
}

function humanBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function TabQueryTester() {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [semantic, setSemantic] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const api = window.ShogunAPI;
      if (!api || !api.memoryDebugQuery) {
        throw new Error("API unavailable");
      }
      const out = await api.memoryDebugQuery({ query, limit, semantic });
      setResult(out);
    } catch (e) {
      setErr(String(e && e.message ? e.message : e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }, [query, limit, semantic]);

  return (
    <div className="mdbg-tab mdbg-query">
      <div className="mdbg-form">
        <input
          type="text"
          placeholder="クエリ（空欄で最新 N 件）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          type="number"
          min="1"
          max="80"
          value={limit}
          onChange={(e) => setLimit(Math.max(1, Math.min(80, Number(e.target.value) || 12)))}
        />
        <label>
          <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} />
          semantic
        </label>
        <button onClick={run} disabled={busy}>{busy ? "…" : "Run"}</button>
      </div>
      {err && <div className="mdbg-err">Error: {err}</div>}
      {result && (
        <div className="mdbg-result">
          <h3>Hits ({result.hits.length})</h3>
          <ol>
            {result.hits.map((h) => (
              <li key={h.id}>
                <strong>[{h.provenance}]</strong> {h.title || "(no title)"} — <code>{h.id}</code>
                <div className="mdbg-snip">{(h.snippet || "").slice(0, 200)}</div>
              </li>
            ))}
          </ol>
          <h3>draft_block ({result.draft_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.draft_block}</pre>
          <h3>brief_block ({result.brief_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.brief_block}</pre>
          <h3>reply_block ({result.reply_block.length} chars)</h3>
          <pre className="mdbg-pre">{result.reply_block}</pre>
        </div>
      )}
    </div>
  );
}

function TabRecentCalls() {
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const out = await window.ShogunAPI.memoryDebugRecentCalls({ limit: 50 });
      setItems(out.calls || []);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="mdbg-tab mdbg-recent">
      {err && <div className="mdbg-err">Error: {err}</div>}
      <table className="mdbg-table">
        <thead>
          <tr>
            <th>time</th>
            <th>route</th>
            <th>query</th>
            <th>hits</th>
            <th>elapsed</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={`${c.ts_ms}_${i}`} onClick={() => setSelected(c)} className={selected === c ? "sel" : ""}>
              <td>{msToLocal(c.ts_ms)}</td>
              <td>{c.route}</td>
              <td className="mdbg-q">{c.query_preview || "(empty)"}</td>
              <td>{c.hits_count}</td>
              <td>{c.elapsed_ms} ms</td>
              <td>{typeof c.status === "string" ? c.status : (c.status && c.status.Err ? "err" : "ok")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selected && (
        <div className="mdbg-detail">
          <h3>Detail</h3>
          <div>provenance: screen={selected.provenance_counts.screen} connector={selected.provenance_counts.connector} meeting={selected.provenance_counts.meeting} user={selected.provenance_counts.user}</div>
          <div>block: {selected.block_chars} chars / limit: {selected.limit} / semantic: {String(selected.semantic)}</div>
          {selected.assembled_block && (
            <pre className="mdbg-pre">{selected.assembled_block}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function TabSyncHealth() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const out = await window.ShogunAPI.memoryDebugSyncStatus();
      setData(out);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  if (err) return <div className="mdbg-err">Error: {err}</div>;
  if (!data) return <div>Loading…</div>;

  const row = (name, d) => (
    <tr key={name}>
      <td>{name}</td>
      <td>{msToLocal(d.last_sync_ms)}</td>
      <td>{d.last_ingested ?? "—"}</td>
      <td className={d.last_error ? "mdbg-err-cell" : ""}>{d.last_error || "—"}</td>
      <td>{d.last_duration_ms ? `${d.last_duration_ms} ms` : "—"}</td>
      <td>{d.credentials_present ? "✓" : "—"}</td>
      <td>{d.auto_enabled ? "✓" : "—"}</td>
    </tr>
  );

  return (
    <table className="mdbg-table">
      <thead>
        <tr>
          <th>source</th>
          <th>last_sync</th>
          <th>ingested</th>
          <th>error</th>
          <th>duration</th>
          <th>creds</th>
          <th>auto</th>
        </tr>
      </thead>
      <tbody>
        {row("google_calendar", data.google_calendar)}
        {row("gmail", data.gmail)}
      </tbody>
    </table>
  );
}

function TabDbStats() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const out = await window.ShogunAPI.memoryDebugStats();
      setData(out);
    } catch (e) {
      setErr(String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (err) return <div className="mdbg-err">Error: {err}</div>;
  if (!data) return <div>Loading…</div>;

  return (
    <div className="mdbg-tab mdbg-stats">
      <div>
        total rows: <strong>{data.total}</strong> / FTS rows: <strong>{data.fts_total}</strong>
        {" "}<span className={data.fts_integrity ? "mdbg-ok" : "mdbg-err-cell"}>
          {data.fts_integrity ? "FTS ✓" : "FTS MISMATCH"}
        </span>
        {" — "}db size: <strong>{humanBytes(data.db_bytes)}</strong>
        {" — "}earliest: {msToLocal(data.earliest_ms)} / latest: {msToLocal(data.latest_ms)}
      </div>
      <h3>By source</h3>
      <table className="mdbg-table">
        <thead>
          <tr><th>source</th><th>rows</th><th>with_embed</th><th>coverage</th></tr>
        </thead>
        <tbody>
          {data.by_source.map((s) => (
            <tr key={s.source}>
              <td>{s.source}</td>
              <td>{s.rows}</td>
              <td>{s.with_embed}</td>
              <td>{s.rows ? Math.round((s.with_embed / s.rows) * 100) : 0}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>By provenance</h3>
      <table className="mdbg-table">
        <thead><tr><th>provenance</th><th>rows</th></tr></thead>
        <tbody>
          {data.by_provenance.map((p) => (
            <tr key={p.provenance}><td>{p.provenance}</td><td>{p.rows}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScreenMemoryDebug() {
  const [tab, setTab] = useState("query");
  return (
    <div className="content-memory-debug">
      <div className="mdbg-header">
        <h1>Memory Debugger (dev)</h1>
        <div className="mdbg-tabs">
          {["query", "recent", "sync", "stats"].map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {t === "query" ? "Query Tester" : t === "recent" ? "Recent Calls" : t === "sync" ? "Sync Health" : "DB Stats"}
            </button>
          ))}
        </div>
      </div>
      {tab === "query" && <TabQueryTester />}
      {tab === "recent" && <TabRecentCalls />}
      {tab === "sync" && <TabSyncHealth />}
      {tab === "stats" && <TabDbStats />}
    </div>
  );
}
```

### Step 10.2: Add basic CSS

- [ ] **Append to `hifi/app.css` (at the bottom):**

```css
.content-memory-debug { padding: 16px 24px; }
.mdbg-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.mdbg-tabs { display: flex; gap: 4px; }
.mdbg-tabs button { padding: 4px 10px; font-size: 12px; background: transparent; border: 1px solid #444; color: #ccc; cursor: pointer; }
.mdbg-tabs button.active { background: #222; color: #fff; }
.mdbg-form { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; font-size: 12px; }
.mdbg-form input[type="text"] { flex: 1; padding: 4px 6px; }
.mdbg-form input[type="number"] { width: 64px; padding: 4px 6px; }
.mdbg-form button { padding: 4px 12px; }
.mdbg-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.mdbg-table th, .mdbg-table td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #222; }
.mdbg-table tr { cursor: pointer; }
.mdbg-table tr.sel { background: #1a1a1a; }
.mdbg-table td.mdbg-q { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mdbg-err { color: #d44; padding: 8px; }
.mdbg-err-cell { color: #d44; }
.mdbg-ok { color: #4a4; }
.mdbg-pre { background: #0e0e0e; padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 240px; overflow: auto; }
.mdbg-snip { color: #aaa; font-size: 11px; margin-top: 2px; }
.mdbg-detail { margin-top: 16px; padding-top: 12px; border-top: 1px solid #222; }
```

### Step 10.3: Register the screen

- [ ] **In `SHOGUN Hi-Fi UI.html`, add a new script tag after `screens-meetings.jsx`:**

```html
<script type="text/babel" src="hifi/screens-memory-debug.jsx"></script>
```

- [ ] **In `hifi/app.jsx`:**

1. Update the `/* global ... */` comment on line 1 to add `ScreenMemoryDebug`:

```javascript
/* global Icon, Kamon, React, ReactDOM, ScreenHome, ScreenMemory, ScreenChat, ScreenAgents, ScreenWork, ScreenMeetings, ScreenMemoryDebug, SettingsModal, ConfirmWriteModal, ShogunIpcClient, ShogunAPI, ShogunActionRegistry, ShogunKeyboardShortcuts */
```

2. Update the `Screen` map at line 1954-1962:

```javascript
  const Screen = {
    home: ScreenHome,
    memory: ScreenMemory,
    chat: ScreenChat,
    agents: ScreenAgents,
    work: ScreenWork,
    tasks: ScreenTasks,
    meetings: ScreenMeetings,
    memory_debug: ScreenMemoryDebug,
  }[active] || ScreenHome;
```

3. Add a dev-gate state. Near the top of the main `App` component (right after other `useState` declarations, around line 852-890), add:

```javascript
  const [devGate, setDevGate] = useState({ available: false });
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const out = await (window.ShogunAPI && window.ShogunAPI.memoryDebugGate && window.ShogunAPI.memoryDebugGate());
        if (!cancel && out) setDevGate(out);
      } catch (_) { /* ignore */ }
    })();
    return () => { cancel = true; };
  }, []);
```

4. Update the `NAV` array (line 11-19) — keep the core items as-is. Then in the sidebar rendering, filter by gate. Find where NAV is mapped into sidebar items (search for `NAV.map` or similar) and add a filter:

```javascript
  // Include memory_debug only when the gate returns available.
  const effectiveNav = devGate.available
    ? [...NAV, { id: "memory_debug", label: "Memory DBG", jp: "DBG", icon: "memory", section: "workspace" }]
    : NAV;
```

Then use `effectiveNav` wherever `NAV` was being mapped for the sidebar. (If the exact mapping is done inline with `NAV.map`, change to `effectiveNav.map`.)

### Step 10.4: Verify (manual)

- [ ] **Enable the dev flag. Edit `~/Library/Application Support/ai.Shogun.ShogunAI3/settings.json` and add:**

```json
{
  "sections": {
    "developer": { "memoryDebugger": true },
    /* ... existing sections ... */
  }
}
```

- [ ] **Start the app:**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3 && npm run tauri dev
```

- [ ] **Verify:**
  - The sidebar shows a new "Memory DBG" entry
  - Click it → 4 tabs render
  - Query Tester: enter a real memory term (e.g., `AXTextArea`) → hits appear, blocks render
  - Recent Calls: opening Brief or sending a chat with memoryAssembly populates a row within 2 seconds (auto-refresh)
  - Sync Health: shows both rows; if no credentials, everything is "—" which is correct
  - DB Stats: matches Phase A's sqlite3 findings (2326 rows, FTS ✓)

### Step 10.5: Commit

```bash
git add hifi/screens-memory-debug.jsx hifi/app.css hifi/app.jsx "SHOGUN Hi-Fi UI.html"
git commit -m "feat(memory-debug): add dev-gated Memory Debugger screen with 4 tabs"
```

---

## Task 11: Release-build guard verification

**Files:**
- None modified — this is a verification task.

### Step 11.1: Verify release build excludes debug-only commands

- [ ] **Run:**

```bash
cd src-tauri && cargo build --release 2>&1 | tail -5
```

**Expected:** Builds clean.

- [ ] **Extract the list of registered commands from the release binary:**

```bash
cd src-tauri && grep -c "shogun_memory_debug" target/release/build/app-*/*.rs 2>/dev/null || echo "no matches (expected)"
```

(If that target path doesn't exist, the build artifacts live elsewhere — just confirm the binary compiles.)

- [ ] **Verify by code inspection:** Open `src-tauri/src/lib.rs` in the `generate_handler!` block and confirm every `shogun_memory_debug_*` line (except `shogun_memory_debug_gate`) has `#[cfg(debug_assertions)]` immediately above. Count:

```bash
grep -B1 "shogun_memory_debug_" src/lib.rs | grep "cfg(debug_assertions)" | wc -l
```

**Expected:** ≥ 4 (recent_calls, query, stats, sync_status). `memory_debug_gate` intentionally has no cfg guard.

- [ ] **Manual test of the dev gate when `settings.developer.memoryDebugger` is absent or false:**

Edit `~/Library/Application Support/ai.Shogun.ShogunAI3/settings.json` to either remove the `developer` section or set `memoryDebugger: false`. Restart the app. Confirm:
  - The sidebar no longer shows "Memory DBG"
  - Direct URL hack (if any) doesn't work

- [ ] **No commit needed** — this is verification only.

---

## Coverage Check (self-review)

Against the spec's B-2 Completion Criteria:

- [x] `memory_debug.rs` exists, dev-build only (the module compiles unconditionally; only the command handlers are cfg-gated — see Task 8 note)
- [x] 4 new IPC commands — recent_calls, query, sync_status, stats (plus gate)
- [x] `hifi/screens-memory-debug.jsx` renders 4 tabs
- [x] Query Tester returns FTS hits + 3 assembled blocks
- [x] Recent Calls shows ring buffer time series
- [x] Sync Health shows both sources
- [x] DB Stats matches Phase A findings
- [x] Release build excludes the 4 debug-only commands
- [x] Settings flag requirement documented and enforced
- [x] E2E tests — preserved; no existing test should break because the new screen only renders when gated

## Non-goals (confirmation)

- No user-facing "Used context" badges (that's Phase C)
- No retrieval improvements (reranking / chunking / query rewriting)
- No new sources / connectors
- No production surfacing of any debug info

## Scope Descoping Options

If time runs short, these can be cut with minimal harm:

- **Drop the Sync Health tab** if calendar_sync state expansion (Task 6) proves invasive. Phase A's sqlite3 checks still exist as a fallback.
- **Drop auto-refresh in Recent Calls** (change `setInterval(refresh, 2000)` to manual "Refresh" button). Same data visible, just requires a click.
- **Drop the provenance counts on Recent Calls detail** — the information is available in Query Tester anyway.

Do **not** drop: Query Tester (core value), DB Stats (quick health check), the dev-gate.
