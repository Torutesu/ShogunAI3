# Memory Observability — Phase B-1: Structured Event Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add structured `event=name key=value` observability events to the context / LLM / ingest / sync hot paths so that `RUST_LOG=shogun::memory_obs=info cargo tauri dev` reveals what is (and isn't) being called at runtime, without surfacing sensitive query or snippet content.

**Architecture:** A new, tiny module `src-tauri/src/memory_obs.rs` exposes `format_event(event, fields) -> String` (pure) and `emit(event, fields)` (thin wrapper over `log::info!` with `target = "shogun::memory_obs"`). Every call site builds a small `&[(&'static str, String)]` slice and calls `memory_obs::emit`. No business logic changes. No new runtime dependencies — only a dev-dependency (`testing_logger`) for one integration test.

**Tech Stack:** Rust 2021 / Tauri v2 / `log` crate / `tauri-plugin-log` (already in place) / `testing_logger` (new dev-dep).

**Spec:** `docs/superpowers/specs/2026-04-23-memory-observability-design.md`

---

## Scope

This plan implements **B-1 only** from the spec. The dev-only `/memory-debugger` screen (B-2) is a separate plan that builds on top of B-1.

## File Structure

**New files:**
- `src-tauri/src/memory_obs.rs` — pure formatter + `emit` wrapper + unit tests

**Modified files:**
- `src-tauri/Cargo.toml` — add `[dev-dependencies]` section with `testing_logger = "0.1"`
- `src-tauri/src/lib.rs` — register the new module
- `src-tauri/src/context_assembly.rs` — emit `assemble_hits_begin` / `assemble_hits_done`
- `src-tauri/src/llm.rs` — emit `chat_memory_block` / `brief_generate_done` / `draft_reply_done` / `draft_from_payload_done`
- `src-tauri/src/memory_store.rs` — emit `search_with_semantics_done` / `ingest_done` (non-capture only)
- `src-tauri/src/calendar_sync.rs` — emit `calendar_tick` (each loop iteration) plus structured `calendar_sync_done` / `calendar_sync_error` alongside existing `log::info!` / `log::warn!` lines (existing lines stay)
- `src-tauri/src/gmail.rs` — emit `gmail_sync_done` at the end of `sync_inbox_to_memory`

**No UI changes.** B-1 is backend-only.

---

## Task 1: Create `memory_obs` module with formatter + emit

**Files:**
- Create: `src-tauri/src/memory_obs.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs:3-20` (module declaration area)

### Step 1.1: Add `testing_logger` dev-dependency

- [ ] **Open `src-tauri/Cargo.toml` and add a `[dev-dependencies]` section at the bottom (before `[target.*]` sections, or after the last regular dep). Locate the end of the main `[dependencies]` block (around line 39 after `base64 = "0.22"`) and insert before line 41 (`[target.'cfg(any(target_os = "macos"...`):**

```toml
[dev-dependencies]
testing_logger = "0.1"
```

- [ ] **Run:** `cd src-tauri && cargo fetch`
  **Expected:** Downloads `testing_logger` v0.1.x. No errors.

### Step 1.2: Write the failing formatter test

- [ ] **Create `src-tauri/src/memory_obs.rs` with exactly this content:**

```rust
//! Structured observability events for the context / LLM / ingest / sync hot
//! paths. Every event is a single line with `target = "shogun::memory_obs"`,
//! formatted as `event=<name> key1=value1 key2=value2 ...`. Sensitive text
//! (raw queries, snippets, titles) is never emitted — only lengths, counts,
//! and optional `*_preview` fields clipped to 40 characters.

/// Format a single event line. Values that contain a space, `=`, or `"` are
/// wrapped in double quotes; embedded quotes inside such values are escaped
/// as `\"`. Fields are emitted in the order given.
pub fn format_event(event: &str, fields: &[(&'static str, String)]) -> String {
    let mut out = format!("event={}", event);
    for (k, v) in fields {
        out.push(' ');
        out.push_str(k);
        out.push('=');
        if v.contains(' ') || v.contains('=') || v.contains('"') {
            out.push('"');
            out.push_str(&v.replace('"', "\\\""));
            out.push('"');
        } else {
            out.push_str(v);
        }
    }
    out
}

/// Emit an event at INFO level under `target = "shogun::memory_obs"`.
pub fn emit(event: &str, fields: &[(&'static str, String)]) {
    let msg = format_event(event, fields);
    log::info!(target: "shogun::memory_obs", "{}", msg);
}

/// Clip a string for a `*_preview` field: take the first 40 **characters**
/// (not bytes) and collapse newlines so one event is one line.
pub fn clip_preview(s: &str) -> String {
    s.chars()
        .take(40)
        .collect::<String>()
        .replace('\n', " ")
        .replace('\r', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_event_emits_event_key_first() {
        let out = format_event("assemble_hits_begin", &[]);
        assert_eq!(out, "event=assemble_hits_begin");
    }

    #[test]
    fn format_event_appends_fields_in_order() {
        let out = format_event(
            "assemble_hits_done",
            &[
                ("hits", "7".to_string()),
                ("elapsed_ms", "14".to_string()),
            ],
        );
        assert_eq!(out, "event=assemble_hits_done hits=7 elapsed_ms=14");
    }

    #[test]
    fn format_event_quotes_values_with_spaces() {
        let out = format_event("probe", &[("error", "bad request".to_string())]);
        assert_eq!(out, "event=probe error=\"bad request\"");
    }

    #[test]
    fn format_event_quotes_values_with_equals() {
        let out = format_event("probe", &[("k", "a=b".to_string())]);
        assert_eq!(out, "event=probe k=\"a=b\"");
    }

    #[test]
    fn format_event_escapes_embedded_quotes() {
        let out = format_event("probe", &[("msg", "he said \"hi\"".to_string())]);
        assert_eq!(out, "event=probe msg=\"he said \\\"hi\\\"\"");
    }

    #[test]
    fn clip_preview_caps_at_40_chars_and_drops_newlines() {
        let long = "a".repeat(100);
        assert_eq!(clip_preview(&long).chars().count(), 40);
        let multi = "line1\nline2\rline3";
        assert_eq!(clip_preview(multi), "line1 line2 line3");
    }

    #[test]
    fn clip_preview_counts_chars_not_bytes() {
        // 3 Japanese chars = 9 bytes in UTF-8, but we cap by char count.
        let s = "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん";
        let out = clip_preview(s);
        assert_eq!(out.chars().count(), 40);
    }

    #[test]
    fn emit_routes_to_log_with_memory_obs_target() {
        testing_logger::setup();
        emit("unit_probe", &[("k", "v".to_string())]);
        testing_logger::validate(|logs| {
            let found = logs
                .iter()
                .find(|l| l.target == "shogun::memory_obs");
            let f = found.expect("no shogun::memory_obs event captured");
            assert_eq!(f.body, "event=unit_probe k=v");
            assert_eq!(f.level, log::Level::Info);
        });
    }
}
```

- [ ] **Declare the module in `src-tauri/src/lib.rs`. Find the block of `mod <name>;` declarations near the top (they start around line 3). Insert a new line alphabetically:**

```rust
mod memory_obs;
```

Place it between `mod memory_mcp;` (or similar) and `mod meeting_commands;` — alphabetical order. If exact neighbor differs, just add it anywhere in the `mod` block before `pub fn run`.

- [ ] **Run the tests:** `cd src-tauri && cargo test --lib memory_obs`
  **Expected:** All 8 tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/Cargo.toml src-tauri/src/memory_obs.rs src-tauri/src/lib.rs
git commit -m "feat(memory-obs): add structured event formatter and emit helper"
```

---

## Task 2: Emit `assemble_hits_begin` / `assemble_hits_done` in `context_assembly`

**Files:**
- Modify: `src-tauri/src/context_assembly.rs:77-92` (the `assemble_memory_hits` function body)

### Step 2.1: Wrap `assemble_memory_hits` with begin/done emits

- [ ] **Read `src-tauri/src/context_assembly.rs` around lines 77-92. Replace the body of `assemble_memory_hits` with:**

```rust
pub async fn assemble_memory_hits(
  params: AssembleParams<'_>,
) -> Result<Vec<Hit>, String> {
  let start = std::time::Instant::now();
  crate::memory_obs::emit(
    "assemble_hits_begin",
    &[
      ("query_len", params.query.chars().count().to_string()),
      ("limit", params.limit.to_string()),
      ("semantic", params.semantic.to_string()),
    ],
  );
  let payload = json!({
    "query": params.query,
    "limit": params.limit,
    "semantic": params.semantic,
  });
  let result = memory_store::search_with_semantics(&payload).await?;
  let arr = result
    .get("hits")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  let hits: Vec<Hit> = arr.iter().filter_map(hit_from_value).collect();
  let elapsed_ms = start.elapsed().as_millis() as u64;
  let (screen, connector, meeting, user) = provenance_counts(&hits);
  crate::memory_obs::emit(
    "assemble_hits_done",
    &[
      ("hits", hits.len().to_string()),
      ("elapsed_ms", elapsed_ms.to_string()),
      ("screen", screen.to_string()),
      ("connector", connector.to_string()),
      ("meeting", meeting.to_string()),
      ("user", user.to_string()),
    ],
  );
  Ok(hits)
}

fn provenance_counts(hits: &[Hit]) -> (u32, u32, u32, u32) {
  let mut screen = 0u32;
  let mut connector = 0u32;
  let mut meeting = 0u32;
  let mut user = 0u32;
  for h in hits {
    match h.provenance.as_str() {
      "screen" => screen += 1,
      "connector" => connector += 1,
      "meeting" => meeting += 1,
      _ => user += 1,
    }
  }
  (screen, connector, meeting, user)
}
```

- [ ] **Add a unit test for `provenance_counts`. Inside the existing `mod tests` in `context_assembly.rs`, after the last `fn` in the tests block, add:**

```rust
  #[test]
  fn provenance_counts_tallies_by_category() {
    let hits = vec![
      mk_hit("m1", "A", "x", "google_calendar"),
      mk_hit("m2", "B", "y", "capture_ax"),
      mk_hit("m3", "C", "z", "capture_sampler"),
      mk_hit("m4", "D", "w", "meeting"),
      mk_hit("m5", "E", "v", "user_note"),
    ];
    let (screen, connector, meeting, user) = provenance_counts(&hits);
    assert_eq!(screen, 2);
    assert_eq!(connector, 1);
    assert_eq!(meeting, 1);
    assert_eq!(user, 1);
  }
```

- [ ] **Run:** `cd src-tauri && cargo test --lib context_assembly`
  **Expected:** All existing context_assembly tests still pass + new `provenance_counts_tallies_by_category` passes.

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean. No warnings from the new code.

- [ ] **Commit:**

```bash
git add src-tauri/src/context_assembly.rs
git commit -m "feat(memory-obs): emit assemble_hits begin/done with provenance counts"
```

---

## Task 3: Emit `chat_memory_block` in `llm::chat_complete`

**Files:**
- Modify: `src-tauri/src/llm.rs:106-136` (the `memoryAssembly` branch inside `chat_complete`)

### Step 3.1: Add emit right after the memory block is assembled

- [ ] **Read `src-tauri/src/llm.rs` around line 125 (where `block` is computed from `format_hits_draft_context`). Replace lines 125-135 (the `if !block.is_empty() { ... }` block and its surroundings) with:**

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
      if !block.is_empty() {
        messages.push(json!({
          "role": "system",
          "content": format!(
            "Additional context assembled from the local memory index (provenance tags in brackets):\n\n{}\n\nUse when helpful.",
            block
          ),
        }));
      }
```

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib`
  **Expected:** All existing tests still pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/llm.rs
git commit -m "feat(memory-obs): emit chat_memory_block when memoryAssembly is used"
```

---

## Task 4: Emit `brief_generate_done` / `draft_reply_done` / `draft_from_payload_done`

**Files:**
- Modify: `src-tauri/src/llm.rs:271-303` (`brief_generate`)
- Modify: `src-tauri/src/llm.rs:306-373` (`draft_reply_for_brief`)
- Modify: `src-tauri/src/llm.rs:195-269` (`draft_from_payload`)

### Step 4.1: `brief_generate_done`

- [ ] **Locate `pub async fn brief_generate` (around line 271). Wrap its body with timing and emit at the end. Replace the function body with:**

```rust
pub async fn brief_generate(payload: &Value) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: "",
    limit: 15,
    semantic: false,
  })
  .await?;
  let hits_count = hits.len();
  let block = context_assembly::format_hits_brief_json_prompt(&hits, 10_000);
  let user_prompt = format!(
    "From these local memory items, output ONLY valid JSON with shape {{\"sections\":[{{\"title\":string,\"body\":string}}]}}. No markdown code fences. If there are no items, use {{\"sections\":[]}}.\n\nMemories:\n{}",
    block
  );
  let synthetic = json!({
    "messages": [{ "role": "user", "content": user_prompt }],
  });
  let out = chat_complete(&synthetic).await?;
  let message = out.get("message").and_then(|m| m.as_str()).unwrap_or("{}");
  let sections_val: Value = serde_json::from_str(message).unwrap_or(json!({ "sections": [] }));
  let sections = sections_val
    .get("sections")
    .cloned()
    .unwrap_or(json!([]));
  let sections_count = sections.as_array().map(|a| a.len()).unwrap_or(0);
  let generated = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  crate::memory_obs::emit(
    "brief_generate_done",
    &[
      ("hits_used", hits_count.to_string()),
      ("sections", sections_count.to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
  Ok(json!({
    "sections": sections,
    "generatedAt": generated,
    "echo": payload,
    "stub": false,
  }))
}
```

### Step 4.2: `draft_reply_done`

- [ ] **Locate `pub async fn draft_reply_for_brief` (around line 306). Add timing + emit before the final `Ok(json!(...))`. Find the two lines that compute `content` and `title`, and insert the emit between them and the `Ok(json!(...))`:**

At the start of the function body (immediately after `let item = payload.get("brief_item");`), add:

```rust
  let start = std::time::Instant::now();
```

Immediately before the final `Ok(json!({ "content": content, ... }))`, add:

```rust
  crate::memory_obs::emit(
    "draft_reply_done",
    &[
      ("hits_used", hits.len().to_string()),
      ("content_len", content.chars().count().to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
```

### Step 4.3: `draft_from_payload_done`

- [ ] **Locate `pub async fn draft_from_payload` (around line 195). Add timing at the top of the function and emit before the final `Ok(json!(...))`.**

At the top of the function body (immediately after `let target = payload.get("target")...`), add:

```rust
  let start = std::time::Instant::now();
```

Immediately before the final `Ok(json!({ "content": content, "title": title, ... }))`, add:

```rust
  let memory_used = !memory_block.is_empty();
  let block_chars = memory_block.chars().count();
  crate::memory_obs::emit(
    "draft_from_payload_done",
    &[
      ("memory_used", memory_used.to_string()),
      ("block_chars", block_chars.to_string()),
      ("content_len", content.chars().count().to_string()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
```

### Step 4.4: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib`
  **Expected:** All existing tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/llm.rs
git commit -m "feat(memory-obs): emit done events for brief/draft_reply/draft_from_payload"
```

---

## Task 5: Emit `search_with_semantics_done` and `ingest_done` in `memory_store`

**Files:**
- Modify: `src-tauri/src/memory_store.rs:933-1017` (`search_with_semantics`)
- Modify: `src-tauri/src/memory_store.rs:756-857` (`ingest`)

### Step 5.1: `search_with_semantics_done`

- [ ] **Read `search_with_semantics` around line 933. At the top of the function body, start timing. At every `return Ok(...)` or natural end, emit an event. The simplest approach: wrap the existing body by capturing the final result in a local and emitting before returning.**

Locate the end of `search_with_semantics`. Replace the final lines that produce the result `Ok(json!({ "hits": ..., "total": ..., ... }))` with:

```rust
  let elapsed_ms = start.elapsed().as_millis() as u64;
  let result = json!({ /* the existing shape of the return value — preserve exactly */ });
  let returned = result.get("hits").and_then(|h| h.as_array()).map(|a| a.len()).unwrap_or(0);
  let total = result.get("total").and_then(|t| t.as_u64()).unwrap_or(0);
  crate::memory_obs::emit(
    "search_with_semantics_done",
    &[
      ("returned", returned.to_string()),
      ("total", total.to_string()),
      ("semantic_applied", semantic_applied.to_string()),
      ("elapsed_ms", elapsed_ms.to_string()),
    ],
  );
  Ok(result)
```

**Reality check before editing:** `search_with_semantics` is ~85 lines with branches. Do NOT rewrite it wholesale. Instead:

1. At the top of the function (after the first let-binding), add `let start = std::time::Instant::now();`
2. Add a local `let mut semantic_applied = false;` near the top
3. Inside the branch where semantic re-ranking actually runs (cosine sort over embeddings), set `semantic_applied = true;`
4. At the `Ok(...)` return, capture the value in a `let result = ...;`, run the emit, then `return Ok(result);`

- [ ] **Open `src-tauri/src/memory_store.rs` and find `pub async fn search_with_semantics` (line 933). Apply the four edits above inline. If the function has multiple early returns or error paths, emit on the success path only (errors bubble to the caller; we don't need to log them separately here).**

### Step 5.2: `ingest_done`

- [ ] **Locate `pub fn ingest` (line 756). Immediately before the final `Ok(out)` (near line 856), and only when the source is NOT a capture source, emit. Insert:**

```rust
  if source != "capture_sampler" && source != "capture_ax" {
    crate::memory_obs::emit(
      "ingest_done",
      &[
        ("source", source.to_string()),
        ("provenance", provenance.clone()),
        ("embedding_queued", (!skip_embed).to_string()),
      ],
    );
  }
  Ok(out)
```

(`skip_embed` is already computed at line 846.)

### Step 5.3: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib memory_store`
  **Expected:** All existing tests pass.

- [ ] **Commit:**

```bash
git add src-tauri/src/memory_store.rs
git commit -m "feat(memory-obs): emit search_with_semantics_done and ingest_done"
```

---

## Task 6: Emit `calendar_tick` / `calendar_sync_done` / `calendar_sync_error` in `calendar_sync`

**Files:**
- Modify: `src-tauri/src/calendar_sync.rs:33-73` (the `spawn_background_calendar_sync` loop)

### Step 6.1: Add structured emits alongside existing log lines

- [ ] **Replace the body of the `spawn_background_calendar_sync` loop (lines 34-72) with:**

```rust
pub fn spawn_background_calendar_sync() {
  spawn(async move {
    loop {
      tokio::time::sleep(std::time::Duration::from_secs(60)).await;
      let (enabled, mins) = auto_sync_settings();
      let credentials_present = integration_secrets::get_credentials("google_calendar")
        .ok()
        .flatten()
        .is_some();
      let now = now_ms();
      let period_ms = mins.saturating_mul(60_000);
      let last_ms = LAST_SYNC_MS.lock().ok().and_then(|g| *g);
      let due = last_ms
        .map(|t| now.saturating_sub(t) >= period_ms)
        .unwrap_or(true);
      crate::memory_obs::emit(
        "calendar_tick",
        &[
          ("enabled", enabled.to_string()),
          ("credentials", credentials_present.to_string()),
          ("due", due.to_string()),
          (
            "last_sync_ms",
            last_ms.map(|t| t.to_string()).unwrap_or_else(|| "0".to_string()),
          ),
        ],
      );
      if !enabled {
        continue;
      }
      if !credentials_present {
        continue;
      }
      if !due {
        continue;
      }
      let sync_start = std::time::Instant::now();
      match google_calendar::sync_events_to_memory("primary", 25).await {
        Ok(out) => {
          let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
          log::info!("calendar auto-sync: ingested {} event(s)", n);
          crate::memory_obs::emit(
            "calendar_sync_done",
            &[
              ("ingested", n.to_string()),
              (
                "elapsed_ms",
                (sync_start.elapsed().as_millis() as u64).to_string(),
              ),
            ],
          );
          if let Ok(mut last) = LAST_SYNC_MS.lock() {
            *last = Some(now_ms());
          }
        }
        Err(e) => {
          log::warn!("calendar auto-sync failed: {}", e);
          crate::memory_obs::emit(
            "calendar_sync_error",
            &[
              ("error", e.clone()),
              (
                "elapsed_ms",
                (sync_start.elapsed().as_millis() as u64).to_string(),
              ),
            ],
          );
        }
      }
    }
  });
}
```

**Key points:**
- Existing `log::info!("calendar auto-sync: ingested {} event(s)", n)` and `log::warn!("calendar auto-sync failed: {}", e)` are **preserved** (do not remove). The new `memory_obs::emit` calls run in parallel.
- The `credentials_present` check was previously only done via the `is_none()` early-return; it is now computed earlier so it can be emitted on every tick.
- The `enabled` / `credentials_present` / `due` early-returns now run **after** the tick emit, so tick visibility is retained even when the sync does not proceed.

### Step 6.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib calendar_sync 2>&1 | tail -5`
  **Expected:** No calendar_sync-specific tests exist, so the output is "0 tests run". That's fine — nothing should have broken.

- [ ] **Commit:**

```bash
git add src-tauri/src/calendar_sync.rs
git commit -m "feat(memory-obs): emit calendar_tick/done/error alongside existing logs"
```

---

## Task 7: Emit `gmail_sync_done` / `gmail_sync_error` in `gmail::sync_inbox_to_memory`

**Files:**
- Modify: `src-tauri/src/gmail.rs:100-159` (`sync_inbox_to_memory`)

### Step 7.1: Add emits at the function boundaries

- [ ] **Locate `sync_inbox_to_memory` (line 100). At the very top, add timing:**

```rust
pub async fn sync_inbox_to_memory(max_results: usize) -> Result<Value, String> {
  let start = std::time::Instant::now();
```

- [ ] **At the final `Ok(json!({ "ingested": ingested, "stub": false }))` (around line 156), wrap the return value with an emit:**

```rust
  let elapsed_ms = start.elapsed().as_millis() as u64;
  crate::memory_obs::emit(
    "gmail_sync_done",
    &[
      ("ingested", ingested.to_string()),
      ("max_results", max_results.to_string()),
      ("elapsed_ms", elapsed_ms.to_string()),
    ],
  );
  Ok(json!({
    "ingested": ingested,
    "stub": false,
  }))
```

- [ ] **At each early `Err(...)` return in this function (there are error paths for `!status.is_success()` and for JSON parse failures), emit a sync_error event before returning. Find each error return and replace it with an emit + the same error. Example pattern — apply to every error-return in this function:**

```rust
// BEFORE:
//   return Err(format!("Gmail API {}: {}", status, snippet));
// AFTER:
  let err = format!("Gmail API {}: {}", status, snippet);
  crate::memory_obs::emit(
    "gmail_sync_error",
    &[
      ("error", err.clone()),
      ("elapsed_ms", (start.elapsed().as_millis() as u64).to_string()),
    ],
  );
  return Err(err);
```

There is exactly **one** sync-level early error return in this function, at line ~120 (`return Err(format!("Gmail API {}: {}", status, snippet));` after the list call). Apply the emit there.

Do **not** emit for:
- The `log::warn!("Skipping message {}: ...")` branch at line ~148 (per-message skip, not sync-level failure)
- `?`-propagated errors from `refresh_and_persist_creds` / `gmail_get_message_metadata` / `ingest_gmail_message` — these bubble without an explicit `return Err` and the caller's own error handling takes over.

### Step 7.2: Verify

- [ ] **Run:** `cd src-tauri && cargo build`
  **Expected:** Builds clean.

- [ ] **Run:** `cd src-tauri && cargo test --lib gmail 2>&1 | tail -5`
  **Expected:** No gmail-specific tests exist — 0 tests run is fine.

- [ ] **Commit:**

```bash
git add src-tauri/src/gmail.rs
git commit -m "feat(memory-obs): emit gmail_sync_done/error in sync_inbox_to_memory"
```

---

## Task 8: Final build + full test suite + manual smoke verification

### Step 8.1: Full build with warnings as errors

- [ ] **Run:** `cd src-tauri && cargo build --all-targets 2>&1 | tail -20`
  **Expected:** Builds clean. No new warnings.

### Step 8.2: Full test suite

- [ ] **Run:** `cd src-tauri && cargo test --lib 2>&1 | tail -10`
  **Expected:** All tests pass (including the 8 new `memory_obs` tests and the 1 new `provenance_counts` test in `context_assembly`). Count should be previous total + 9.

### Step 8.3: No sensitive-text leak guard

- [ ] **Run:**

```bash
cd src-tauri && grep -rn "memory_obs::emit" src/ | wc -l
```

**Expected:** At least 11 occurrences across context_assembly.rs, llm.rs, memory_store.rs, calendar_sync.rs, gmail.rs.

- [ ] **Run:**

```bash
cd src-tauri && grep -rn "memory_obs::emit" src/ | grep -i -E "snippet|title|\bquery\b" | grep -v "query_len\|query_preview"
```

**Expected:** Zero results. No emit site passes a raw `snippet`, `title`, or un-clipped `query` as a field value. (`query_len` / `query_preview` are allowed.)

If any result appears, that emit site needs to switch to `_len` or `_preview` form. Fix and re-run.

### Step 8.4: Manual smoke test (requires desktop)

- [ ] **Start the app in dev mode with filter:**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
RUST_LOG=shogun::memory_obs=info npm run tauri dev
```

- [ ] **In the app, open Morning Brief (triggers `brief.get`).**

- [ ] **In the terminal, verify the following event classes appear at least once:**

```
event=assemble_hits_begin ...
event=assemble_hits_done ...
event=search_with_semantics_done ...
event=brief_generate_done ...
```

Use `grep` in another terminal:

```bash
# Assuming stderr is going to a file or visible in terminal scrollback:
# Just eyeball — all four prefixes should be present within ~3 seconds of opening Brief.
```

- [ ] **In the app, start a chat that passes `memoryAssembly` (e.g., use the existing `screens-c.jsx` flow that sets `memoryAssembly` — see `hifi/screens-c.jsx:59`).**

- [ ] **Verify `event=chat_memory_block ...` appears.**

- [ ] **Wait 60 seconds for at least one calendar tick (if `googleCalendarAutoSync` is not enabled, the tick still fires with `enabled=false`). Verify `event=calendar_tick ...` appears.**

### Step 8.5: Rollback check

- [ ] **Verify the entire B-1 change is cleanly revertible:**

```bash
git log --oneline -10
```

You should see 7 commits (one per task). Each commit touches a single module (or the module + its test). No commit mixes concerns.

### Step 8.6: Final commit tag (optional)

- [ ] **If you want a clean anchor for B-2 to branch from, tag the current HEAD:**

```bash
git tag phase-b1-complete
```

No push required (local tag only).

---

## Coverage Check (self-review)

Against the spec's B-1 Completion Criteria in `docs/superpowers/specs/2026-04-23-memory-observability-design.md`:

- [x] **11 events added:** assemble_hits_begin/done (2), chat_memory_block (1), brief_generate_done (1), draft_reply_done (1), draft_from_payload_done (1), search_with_semantics_done (1), ingest_done (1), calendar_tick (1), calendar_sync_done/error (2), gmail_sync_done/error (2). **= 13 events, slightly above the spec's 11** — the extras are the dedicated *_error variants, which are a small improvement over folding errors into the *_done events.
- [x] `cargo build` / `cargo test` pass — Task 8.1, 8.2
- [x] Existing log lines preserved — verified in Task 6 (calendar_sync) and enforced by not deleting any `log::info!`/`log::warn!` in edits
- [x] Brief smoke test produces `brief_generate_done` — Task 8.4
- [x] Chat with `memoryAssembly` produces the 3-line trio — Task 8.4
- [x] No raw query / snippet / title in event fields — Task 8.3

## Non-goals (confirmation)

- No UI changes — B-1 is backend-only.
- No new dependencies other than `testing_logger` as dev-dep.
- No changes to log destinations (`tauri-plugin-log` stays as is).
- No new IPC commands. Those come in B-2.
