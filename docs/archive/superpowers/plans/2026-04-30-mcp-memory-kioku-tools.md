# Memory & Kioku MCP Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped `shogun-mcp` stdio server with 5 read-only MCP tools (3 memory, 2 kioku) so Claude Desktop and other MCP clients can search memory items, fetch their bodies, look up entities, traverse the kioku knowledge graph, and read subsystem health stats. Final advertised tool count goes from 5 to 10.

**Architecture:** First task restructures `src-tauri/src/mcp_server.rs` (single-file, 165 lines) into `mcp_server/{mod,meeting,memory,kioku}.rs` so domain handlers live next to each other and the file stays small. Each new handler is a thin `parse args → call existing `memory_store::*`/`kioku_*` function → wrap output via `content_text`` shape, identical to the meeting tools. Tool descriptors live in three sibling modules (`meeting_mcp.rs`, `memory_mcp.rs`, `kioku_mcp.rs`) aggregated by the binary's `list_tools`.

**Tech Stack:** Rust + existing `rmcp 0.8.5` stdio server · `memory_store::*` (already public) · `kioku_graph_traversal` + `kioku_debug_stats` (Connection-passing primitives) · `settings_store::load` + `chrono` for the debug-stats handler. No new dependencies.

**Spec correction baked into this plan (vs. `docs/superpowers/specs/2026-04-30-mcp-memory-kioku-tools-design.md`):**
The spec proposed `pick_entry_nodes(conn, query_string, k=5)` for the `query` arm of `kioku.related`. The actual `pick_entry_nodes` signature requires a `&[f32]` embedding, not a string. Computing the embedding from a query is async + needs an LLM/embedding API key, which would force `mcp_server::dispatch` to become async and break the current sync-handler contract. **Adjustment:** when `kioku.related` is called with `query`, the handler invokes `memory_store::search` (lexical FTS, sync, no key required) with `limit=5` and uses those hit IDs as `entry_node_ids` for `traverse_subgraph`. The `seed_ids` arm is unchanged. Trade-off: entry-point picking is lexical, not embedding-similarity-aware. This is acceptable for a sync MVP; semantic entry-picking can be added in a follow-up if the embedding-availability story is solved later. The spec's "active-graph only", "max_depth clamp [1, 3]", "inline bodies", and "empty result is not an error" decisions are all preserved.

---

## File Structure

**Create:**
- `src-tauri/src/mcp_server/mod.rs` — replaces the current `mcp_server.rs`. Holds `pub fn dispatch`, the `content_text` envelope helper, the existing `require_meeting_id` helper, and a new `require_string_field` helper. Plus tests for `unknown_tool_name_returns_error` and `require_string_field`.
- `src-tauri/src/mcp_server/meeting.rs` — receives the 5 meeting handlers (`handle_meetings_list`, `handle_meeting_get`, `handle_meeting_transcript`, `handle_meeting_notes`, `handle_meetings_search`), `MeetingsListArgs`, `parse_meetings_list_args`, and the 8 meeting-specific tests, all moved verbatim from the current `mcp_server.rs`.
- `src-tauri/src/mcp_server/memory.rs` — `handle_memory_search`, `handle_memory_fetch`, `handle_memory_entities`, plus their tests.
- `src-tauri/src/mcp_server/kioku.rs` — `handle_kioku_related`, `handle_kioku_debug_stats`, plus their tests.
- `src-tauri/src/memory_mcp.rs` — `pub fn tool_definitions() -> Value` for the 3 memory tools (mirrors the existing `meeting_mcp.rs` shape).
- `src-tauri/src/kioku_mcp.rs` — `pub fn tool_definitions() -> Value` for the 2 kioku tools.

**Modify:**
- `src-tauri/src/lib.rs` — change `pub mod mcp_server;` (currently a file) to keep working as a directory module; add `pub mod memory_mcp;` and `pub mod kioku_mcp;` (both must be `pub` because the binary imports them via `use app_lib::*`).
- `src-tauri/src/bin/shogun_mcp.rs` — `list_tools` aggregates from all 3 descriptor modules instead of just `meeting_mcp::tool_definitions()`. Existing `meeting_recipe_run` filter preserved.
- `scripts/smoke_mcp_stdio.mjs` — assert 10 tools (was 5); add per-tool calls for the new 5; bump expected hardcoded constants.
- `docs/mcp-claude-desktop-setup.md` — list the new 5 tools alongside the existing 5.

**Delete (replaced by `mcp_server/mod.rs`):**
- `src-tauri/src/mcp_server.rs` — entirely moved into `mcp_server/{mod,meeting}.rs` in Task 1. The file disappears.

---

### Task 1: Refactor `mcp_server.rs` into a directory module

This task is a pure code move — no behavior change, no new tests, no new functionality. The acceptance gate is "all 9 existing `mcp_server::tests` still pass after the move."

**Files:**
- Delete: `src-tauri/src/mcp_server.rs`
- Create: `src-tauri/src/mcp_server/mod.rs`
- Create: `src-tauri/src/mcp_server/meeting.rs`
- Modify: `src-tauri/src/lib.rs` (no line change — `pub mod mcp_server;` resolves to either a file or a directory transparently)

- [ ] **Step 1: Read the current `mcp_server.rs`**

Run: `cat /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/src/mcp_server.rs`

You'll see ~165 lines containing: the module docstring, `use` lines (`serde_json::{json, Value}`, `crate::meeting_store`), `MeetingsListArgs` struct, `parse_meetings_list_args`, `handle_meetings_list`, `handle_meeting_get`, `handle_meeting_transcript`, `handle_meeting_notes`, `handle_meetings_search`, `require_meeting_id`, `content_text`, `pub fn dispatch`, and a `mod tests` block with 9 tests.

- [ ] **Step 2: Create `src-tauri/src/mcp_server/mod.rs`**

This file holds: dispatch, the shared helpers (`content_text`, `require_meeting_id`), submodule declarations, and tests for the dispatch-level behavior (`unknown_tool_name_returns_error`).

```rust
//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

mod meeting;

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => meeting::handle_meetings_list(args),
        "shogun.meeting_get" => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes" => meeting::handle_meeting_notes(args),
        "shogun.meetings_search" => meeting::handle_meetings_search(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn require_meeting_id(args: &Value) -> Result<String, String> {
    args.get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "meeting_id is required (string)".to_string())
}

/// Wrap a string payload in the MCP `content` shape.
fn content_text(s: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": s } ] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tool_name_returns_error() {
        let err = dispatch("shogun.does_not_exist", &json!({})).unwrap_err();
        assert!(err.contains("unknown tool"), "got: {err}");
    }
}
```

- [ ] **Step 3: Create `src-tauri/src/mcp_server/meeting.rs`**

This receives every meeting-specific item — handlers, struct, parser, all 8 meeting-specific tests — verbatim from the current `mcp_server.rs`, plus a `use super::{content_text, require_meeting_id};` and `use serde_json::{json, Value};`, plus `use crate::meeting_store;`.

```rust
//! Meeting tool handlers (5 tools). Moved verbatim from the prior single-file
//! `mcp_server.rs`. No behavior change.

use super::{content_text, require_meeting_id};
use crate::meeting_store;
use serde_json::{json, Value};

#[derive(Debug)]
struct MeetingsListArgs {
    from_ms: Option<u64>,
    to_ms: Option<u64>,
    limit: usize,
}

fn parse_meetings_list_args(args: &Value) -> Result<MeetingsListArgs, String> {
    Ok(MeetingsListArgs {
        from_ms: args.get("from_ms").and_then(|v| v.as_u64()),
        to_ms: args.get("to_ms").and_then(|v| v.as_u64()),
        limit: args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(25),
    })
}

pub(super) fn handle_meetings_list(args: &Value) -> Result<Value, String> {
    let p = parse_meetings_list_args(args)?;
    let rows = meeting_store::list_meetings(p.from_ms, p.to_ms, p.limit)?;
    Ok(content_text(&serde_json::to_string(&rows).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_get(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let detail = meeting_store::get_meeting_detail(&id)?;
    Ok(content_text(&serde_json::to_string(&detail).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_transcript(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let segments = meeting_store::list_transcript_final(&id)?;
    Ok(content_text(&serde_json::to_string(&segments).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_notes(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let blocks = meeting_store::list_note_blocks(&id)?;
    Ok(content_text(&serde_json::to_string(&blocks).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meetings_search(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "query is required (non-empty string)".to_string())?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(25);
    let hits = meeting_store::search_meetings_fts(query, limit)?;
    Ok(content_text(&serde_json::to_string(&hits).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn meetings_list_parses_valid_args() {
        let args = json!({ "from_ms": 1714435200000u64, "to_ms": 1714521600000u64, "limit": 10 });
        let parsed = super::parse_meetings_list_args(&args).expect("valid args");
        assert_eq!(parsed.from_ms, Some(1714435200000));
        assert_eq!(parsed.to_ms, Some(1714521600000));
        assert_eq!(parsed.limit, 10);
    }

    #[test]
    fn meetings_list_defaults_limit_when_missing() {
        let parsed = super::parse_meetings_list_args(&json!({})).expect("empty args ok");
        assert_eq!(parsed.from_ms, None);
        assert_eq!(parsed.to_ms, None);
        assert_eq!(parsed.limit, 25);
    }

    #[test]
    fn meeting_get_requires_meeting_id() {
        let err = dispatch("shogun.meeting_get", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meeting_get_rejects_non_string_meeting_id() {
        let err = dispatch("shogun.meeting_get", &json!({ "meeting_id": 42 })).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meeting_transcript_requires_meeting_id() {
        let err = dispatch("shogun.meeting_transcript", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meeting_notes_requires_meeting_id() {
        let err = dispatch("shogun.meeting_notes", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meetings_search_requires_query() {
        let err = dispatch("shogun.meetings_search", &json!({})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn meetings_search_rejects_empty_query() {
        let err = dispatch("shogun.meetings_search", &json!({ "query": "" })).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }
}
```

Note the visibility change: handlers go from `fn` (private to old `mcp_server.rs`) to `pub(super) fn` (callable from the parent module's `dispatch`). `parse_meetings_list_args` stays `fn` (used only inside `meeting.rs` itself + tests in this file).

- [ ] **Step 4: Delete the old single file**

Run: `rm /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/src/mcp_server.rs`

The directory `src-tauri/src/mcp_server/` now exists with `mod.rs` and `meeting.rs`. Rust treats `pub mod mcp_server;` in `lib.rs` as a directory module automatically — no `lib.rs` edit required.

- [ ] **Step 5: Verify all 9 existing tests still pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 9 passed; 0 failed`. If any test fails, the move is wrong — fix and re-run before committing.

The 9 tests should be: `unknown_tool_name_returns_error` (in `mod.rs`) plus 8 meeting tests (in `meeting.rs`). The total count is preserved.

- [ ] **Step 6: Verify the binary still builds**

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --bin shogun-mcp --locked`

Expected: success. The binary's `use app_lib::mcp_server` call still resolves (a directory module is interchangeable with a file module from the consumer's perspective).

- [ ] **Step 7: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add -A src-tauri/src/mcp_server.rs src-tauri/src/mcp_server/
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "refactor(mcp): split mcp_server.rs into directory module"
```

The `-A` flag with the deleted-file path stages the deletion. Verify with `git status` before commit that the staged diff shows: deleted `mcp_server.rs`, created `mcp_server/mod.rs`, created `mcp_server/meeting.rs`.

---

### Task 2: Add `require_string_field` helper (TDD)

A shared helper that generalizes the inline arg-extraction pattern used in `meetings_search`. Will be reused in `memory_search`, `memory_entities`, and the `query` arm of `kioku_related`.

**Files:**
- Modify: `src-tauri/src/mcp_server/mod.rs`

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/mcp_server/mod.rs`, replace the `mod tests` block with:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tool_name_returns_error() {
        let err = dispatch("shogun.does_not_exist", &json!({})).unwrap_err();
        assert!(err.contains("unknown tool"), "got: {err}");
    }

    #[test]
    fn require_string_field_returns_value_when_present() {
        let v = require_string_field(&json!({"q": "hello"}), "q").unwrap();
        assert_eq!(v, "hello");
    }

    #[test]
    fn require_string_field_trims_whitespace() {
        let v = require_string_field(&json!({"q": "  hello  "}), "q").unwrap();
        assert_eq!(v, "hello");
    }

    #[test]
    fn require_string_field_rejects_missing() {
        let err = require_string_field(&json!({}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_empty() {
        let err = require_string_field(&json!({"q": ""}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_whitespace_only() {
        let err = require_string_field(&json!({"q": "   "}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_non_string() {
        let err = require_string_field(&json!({"q": 42}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::tests`

Expected: FAIL — `cannot find function require_string_field in this scope` for the 6 new tests. The existing `unknown_tool_name_returns_error` still passes.

- [ ] **Step 3: Implement the helper**

In `src-tauri/src/mcp_server/mod.rs`, between `require_meeting_id` and `content_text`, add:

```rust
fn require_string_field(args: &Value, field: &str) -> Result<String, String> {
    args.get(field)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{field} is required (non-empty string)"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 15 passed; 0 failed` (9 from Task 1 + 6 new).

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): add require_string_field helper"
```

---

### Task 3: Wire descriptor aggregation in `bin/shogun_mcp.rs`

The current binary reads tool descriptors from `meeting_mcp::tool_definitions()` only. This task extends it to merge from `memory_mcp::tool_definitions()` and `kioku_mcp::tool_definitions()` as well. We create both new descriptor modules as empty stubs (returning `json!([])`) so the binary builds; later tasks fill them in incrementally and the new tools surface in `tools/list` automatically.

**Files:**
- Create: `src-tauri/src/memory_mcp.rs`
- Create: `src-tauri/src/kioku_mcp.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod memory_mcp;` and `pub mod kioku_mcp;`)
- Modify: `src-tauri/src/bin/shogun_mcp.rs` (extend `list_tools`)

- [ ] **Step 1: Create the descriptor stubs**

Create `src-tauri/src/memory_mcp.rs`:

```rust
//! JSON tool descriptors for memory tools exposed via shogun-mcp.

use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([])
}
```

Create `src-tauri/src/kioku_mcp.rs`:

```rust
//! JSON tool descriptors for kioku tools exposed via shogun-mcp.

use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([])
}
```

- [ ] **Step 2: Wire the modules into `lib.rs`**

Find the line `pub mod meeting_mcp;` in `src-tauri/src/lib.rs`. Immediately after it, add:

```rust
pub mod memory_mcp;
pub mod kioku_mcp;
```

Both are `pub mod` because the binary imports them via `use app_lib::*`. Same pattern as `meeting_mcp` and `mcp_server`.

- [ ] **Step 3: Update binary aggregation**

In `src-tauri/src/bin/shogun_mcp.rs`, find the import block and replace:

```rust
use app_lib::{mcp_server, meeting_mcp};
```

with:

```rust
use app_lib::{kioku_mcp, mcp_server, meeting_mcp, memory_mcp};
```

Then find the `list_tools` method body. Replace the line:

```rust
let defs: Value = meeting_mcp::tool_definitions();
let arr = defs.as_array().cloned().unwrap_or_default();
```

with:

```rust
let mut arr: Vec<Value> = Vec::new();
for getter in [
    meeting_mcp::tool_definitions,
    memory_mcp::tool_definitions,
    kioku_mcp::tool_definitions,
] {
    if let Some(items) = getter().as_array() {
        arr.extend(items.iter().cloned());
    }
}
```

Leave the rest of `list_tools` unchanged (the `meeting_recipe_run` filter, the `Tool` construction, and the return).

- [ ] **Step 4: Build and confirm**

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --bin shogun-mcp --locked`

Expected: success. `tools/list` will continue to return only the 5 meeting tools (the new descriptor modules return empty arrays for now).

- [ ] **Step 5: Run unit tests**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 15 passed; 0 failed`. No regressions.

- [ ] **Step 6: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/memory_mcp.rs src-tauri/src/kioku_mcp.rs src-tauri/src/lib.rs src-tauri/src/bin/shogun_mcp.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): wire descriptor aggregation for memory and kioku tools"
```

---

### Task 4: `shogun.memory_search` handler (TDD)

**Files:**
- Create: `src-tauri/src/mcp_server/memory.rs`
- Modify: `src-tauri/src/mcp_server/mod.rs` (declare submodule, route in dispatch)
- Modify: `src-tauri/src/memory_mcp.rs` (add tool descriptor)

- [ ] **Step 1: Add the descriptor first**

Replace the body of `src-tauri/src/memory_mcp.rs`'s `tool_definitions` with:

```rust
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "shogun.memory_search",
            "description": "Lexical search across memory items (notes, decisions, facts the user has captured). Returns ranked hits with snippets.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-form search terms" },
                    "kinds": { "type": "array", "items": { "type": "string" }, "description": "Optional filter on item kind" },
                    "scope": { "type": "string", "description": "Optional scope filter" },
                    "limit": { "type": "integer", "default": 25 }
                },
                "required": ["query"]
            }
        }
    ])
}
```

- [ ] **Step 2: Create `mcp_server/memory.rs` with a failing test**

Create `src-tauri/src/mcp_server/memory.rs`:

```rust
//! Memory tool handlers. Each handler is a thin pass-through to the
//! corresponding `memory_store::*` function, with arg validation up front
//! and the MCP `content` envelope on the way out.

use super::{content_text, require_string_field};
use crate::memory_store;
use serde_json::Value;

pub(super) fn handle_search(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "query")?;
    let result = memory_store::search(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn memory_search_requires_query() {
        let err = dispatch("shogun.memory_search", &json!({})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn memory_search_rejects_empty_query() {
        let err = dispatch("shogun.memory_search", &json!({"query": ""})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }
}
```

- [ ] **Step 3: Wire the submodule and dispatch arm**

In `src-tauri/src/mcp_server/mod.rs`:

Add `mod memory;` immediately after `mod meeting;`.

Update `dispatch` to add the new arm:

```rust
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => meeting::handle_meetings_list(args),
        "shogun.meeting_get" => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes" => meeting::handle_meeting_notes(args),
        "shogun.meetings_search" => meeting::handle_meetings_search(args),
        "shogun.memory_search" => memory::handle_search(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 17 passed; 0 failed` (15 prior + 2 new). The 2 new tests pass because `require_string_field` rejects missing/empty `query` before reaching `memory_store::search`.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/memory_mcp.rs src-tauri/src/mcp_server/memory.rs src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): handle shogun.memory_search"
```

---

### Task 5: `shogun.memory_fetch` handler (TDD)

**Files:**
- Modify: `src-tauri/src/mcp_server/memory.rs` (add handler + tests)
- Modify: `src-tauri/src/mcp_server/mod.rs` (route in dispatch)
- Modify: `src-tauri/src/memory_mcp.rs` (add descriptor)

- [ ] **Step 1: Extend the descriptor**

In `src-tauri/src/memory_mcp.rs`, append a new tool inside the `json!([ ... ])` array (after the existing `memory_search` entry):

```rust
{
    "name": "shogun.memory_fetch",
    "description": "Retrieve full content of memory items by ID. Typically called after `shogun.memory_search` returns hits.",
    "input_schema": {
        "type": "object",
        "properties": {
            "ids": { "type": "array", "items": { "type": "string" }, "description": "Memory item IDs" }
        },
        "required": ["ids"]
    }
}
```

The full file should now have a 2-element JSON array.

- [ ] **Step 2: Write the failing tests**

In `src-tauri/src/mcp_server/memory.rs`, add to the `mod tests` block:

```rust
    #[test]
    fn memory_fetch_requires_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }

    #[test]
    fn memory_fetch_rejects_empty_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({"ids": []})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }

    #[test]
    fn memory_fetch_rejects_non_array_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({"ids": "abc"})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::tests::memory_fetch mcp_server::memory::tests::memory_fetch`

Expected: 3 FAILs — `dispatch` returns `unknown tool: shogun.memory_fetch`.

- [ ] **Step 4: Add the handler**

In `src-tauri/src/mcp_server/memory.rs`, add after `handle_search`:

```rust
pub(super) fn handle_fetch(args: &Value) -> Result<Value, String> {
    let ids = args
        .get("ids")
        .and_then(|v| v.as_array())
        .filter(|arr| !arr.is_empty())
        .ok_or_else(|| "ids is required (non-empty array)".to_string())?;
    // Confirm every element is a string for a clearer error than what
    // memory_store::fetch would surface.
    for v in ids {
        if !v.is_string() {
            return Err("ids must be an array of strings".to_string());
        }
    }
    let result = memory_store::fetch(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}
```

- [ ] **Step 5: Route the new tool in `dispatch`**

In `src-tauri/src/mcp_server/mod.rs`, add the new arm to `dispatch`:

```rust
        "shogun.memory_search" => memory::handle_search(args),
        "shogun.memory_fetch" => memory::handle_fetch(args),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 20 passed; 0 failed` (17 prior + 3 new).

- [ ] **Step 7: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/memory_mcp.rs src-tauri/src/mcp_server/memory.rs src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): handle shogun.memory_fetch"
```

---

### Task 6: `shogun.memory_entities` handler (TDD)

**Files:**
- Modify: `src-tauri/src/mcp_server/memory.rs`
- Modify: `src-tauri/src/mcp_server/mod.rs`
- Modify: `src-tauri/src/memory_mcp.rs`

- [ ] **Step 1: Add the descriptor**

In `src-tauri/src/memory_mcp.rs`, append a 3rd tool to the array:

```rust
{
    "name": "shogun.memory_entities",
    "description": "Search the entity catalog (people, organizations, projects extracted across memories). Returns matched entities with their occurrence counts.",
    "input_schema": {
        "type": "object",
        "properties": {
            "q": { "type": "string", "description": "Entity name or partial query" }
        },
        "required": ["q"]
    }
}
```

- [ ] **Step 2: Write the failing test**

In `src-tauri/src/mcp_server/memory.rs` `mod tests`, add:

```rust
    #[test]
    fn memory_entities_requires_q() {
        let err = dispatch("shogun.memory_entities", &json!({})).unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::memory::tests::memory_entities_requires_q`

Expected: FAIL — `dispatch` returns `unknown tool: shogun.memory_entities`.

- [ ] **Step 4: Add the handler**

In `src-tauri/src/mcp_server/memory.rs`, add:

```rust
pub(super) fn handle_entities(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "q")?;
    let result = memory_store::entities_from_catalog(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}
```

- [ ] **Step 5: Route in `dispatch`**

In `src-tauri/src/mcp_server/mod.rs`:

```rust
        "shogun.memory_fetch" => memory::handle_fetch(args),
        "shogun.memory_entities" => memory::handle_entities(args),
```

- [ ] **Step 6: Run all tests**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 21 passed; 0 failed` (20 prior + 1 new).

- [ ] **Step 7: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/memory_mcp.rs src-tauri/src/mcp_server/memory.rs src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): handle shogun.memory_entities"
```

---

### Task 7: `shogun.kioku_debug_stats` handler (TDD-light)

This handler takes no input args, so the only unit-testable behavior is "dispatch routes to the handler"; the substance (the actual stats payload) is exercised in Task 9's smoke test. We still write one test to lock in the dispatch arm.

**Files:**
- Create: `src-tauri/src/mcp_server/kioku.rs`
- Modify: `src-tauri/src/mcp_server/mod.rs`
- Modify: `src-tauri/src/kioku_mcp.rs`

- [ ] **Step 1: Add the descriptor**

Replace `src-tauri/src/kioku_mcp.rs`'s `tool_definitions` body with:

```rust
pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "shogun.kioku_debug_stats",
            "description": "One-shot snapshot of the memory subsystem health: capture/extraction queue, monthly cost ledger, graph node/edge totals, active rules, and feature flags.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        }
    ])
}
```

- [ ] **Step 2: Create the kioku submodule with a failing test**

Create `src-tauri/src/mcp_server/kioku.rs`:

```rust
//! Kioku tool handlers. `kioku_debug_stats` (no args) and `kioku_related`
//! (graph traversal — Task 8).

use super::content_text;
use crate::{kioku_debug_stats, memory_store, settings_store};
use serde_json::Value;

pub(super) fn handle_debug_stats(_args: &Value) -> Result<Value, String> {
    let conn = memory_store::open_conn()?;
    let settings = settings_store::load()?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let stats = kioku_debug_stats::assemble_debug_stats(&conn, &settings, now_ms)?;
    Ok(content_text(&serde_json::to_string(&stats).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn kioku_debug_stats_dispatch_routes_to_handler() {
        // We don't call the handler (it would touch the prod DB).
        // Just confirm the tool name is routed and not an "unknown tool" error.
        let result = dispatch("shogun.kioku_debug_stats", &json!({}));
        // Two acceptable outcomes:
        //   Ok(_)  → the handler ran end-to-end (DB available, settings loaded).
        //   Err(e) → an error came from the handler itself, NOT from dispatch.
        // The forbidden outcome is `Err("unknown tool: …")`.
        if let Err(e) = result {
            assert!(
                !e.starts_with("unknown tool"),
                "dispatch must route shogun.kioku_debug_stats; got: {e}"
            );
        }
    }
}
```

- [ ] **Step 3: Note the access of `memory_store::open_conn`**

`open_conn` is declared `pub(crate) fn` in `src-tauri/src/memory_store.rs:41`. The kioku handler is part of the `app_lib` crate, so `pub(crate)` is reachable. No visibility change needed.

If a future consumer outside the crate ever needs this connection (none today), the visibility can be widened then; don't change it now.

- [ ] **Step 4: Wire the submodule and dispatch arm**

In `src-tauri/src/mcp_server/mod.rs`:

Add `mod kioku;` after `mod memory;`.

Update `dispatch`:

```rust
        "shogun.memory_entities" => memory::handle_entities(args),
        "shogun.kioku_debug_stats" => kioku::handle_debug_stats(args),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 22 passed; 0 failed` (21 prior + 1 new).

The dispatch-routing test passes whether the prod DB is reachable or not, because the assertion only fails on `unknown tool:` prefix.

- [ ] **Step 6: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/kioku_mcp.rs src-tauri/src/mcp_server/kioku.rs src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): handle shogun.kioku_debug_stats"
```

---

### Task 8: `shogun.kioku_related` handler (TDD)

The most substantial handler. Composes `memory_store::search` (for the `query` arm), `kioku_graph_traversal::{traverse_subgraph, fetch_decay_scores, rank_subgraph_hits, filter_node_ids_by_kind}`, and `memory_store::fetch`. All synchronous.

**Files:**
- Modify: `src-tauri/src/mcp_server/kioku.rs`
- Modify: `src-tauri/src/mcp_server/mod.rs`
- Modify: `src-tauri/src/kioku_mcp.rs`

- [ ] **Step 1: Add the descriptor**

In `src-tauri/src/kioku_mcp.rs`, append a 2nd tool to the array:

```rust
{
    "name": "shogun.kioku_related",
    "description": "Find memory items related to a seed via the kioku knowledge graph (decision-graph traversal + decay-aware ranking). Provide either a `query` (lexical entry-point pick) or `seed_ids` (explicit entry points). Returns ranked items with bodies inlined so no follow-up `memory_fetch` is needed.",
    "input_schema": {
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Search query — entry nodes are picked via lexical match (top 5 hits)" },
            "seed_ids": { "type": "array", "items": { "type": "string" }, "description": "Memory item IDs to use as graph entry points" },
            "limit": { "type": "integer", "default": 10, "description": "Max ranked hits returned" },
            "max_depth": { "type": "integer", "default": 2, "description": "Graph traversal depth (clamped to 1..=3)" },
            "kinds": { "type": "array", "items": { "type": "string" }, "description": "Optional node-kind filter applied between traversal and ranking" }
        }
    }
}
```

- [ ] **Step 2: Write the failing test**

In `src-tauri/src/mcp_server/kioku.rs` `mod tests`, add:

```rust
    #[test]
    fn kioku_related_requires_query_or_seed_ids() {
        let err = dispatch("shogun.kioku_related", &json!({})).unwrap_err();
        assert!(
            err.contains("query") && err.contains("seed_ids"),
            "got: {err}"
        );
    }

    #[test]
    fn kioku_related_rejects_empty_seed_ids_with_no_query() {
        let err = dispatch("shogun.kioku_related", &json!({"seed_ids": []})).unwrap_err();
        assert!(
            err.contains("query") && err.contains("seed_ids"),
            "got: {err}"
        );
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::kioku::tests::kioku_related`

Expected: 2 FAILs — `dispatch` returns `unknown tool: shogun.kioku_related`.

- [ ] **Step 4: Add the handler**

In `src-tauri/src/mcp_server/kioku.rs`, add the handler. Note the imports that need to be extended at the top of the file:

```rust
use super::content_text;
use crate::{kioku_debug_stats, kioku_edge_types, kioku_graph_traversal, memory_store, settings_store};
use serde_json::{json, Value};
use std::collections::HashMap;
```

(Replace the existing `use serde_json::Value;` line with `use serde_json::{json, Value};` and the existing `use crate::{...}` line with the expanded one.)

Then add the handler after `handle_debug_stats`:

```rust
pub(super) fn handle_related(args: &Value) -> Result<Value, String> {
    // Extract args.
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let seed_ids: Vec<String> = args
        .get("seed_ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if query.is_none() && seed_ids.is_empty() {
        return Err("either query or seed_ids is required".to_string());
    }
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(10);
    let max_depth_raw = args
        .get("max_depth")
        .and_then(|v| v.as_u64())
        .unwrap_or(2);
    let max_depth = max_depth_raw.clamp(1, 3) as u32;
    let kinds_owned: Vec<String> = args
        .get("kinds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let conn = memory_store::open_conn()?;

    // Resolve entry node IDs.
    let entry_ids: Vec<String> = if !seed_ids.is_empty() {
        seed_ids
    } else {
        // Lexical-search-as-entry-pick (sync; avoids the embedding requirement
        // of `kioku_graph_traversal::pick_entry_nodes`).
        let q = query.expect("checked above");
        let search_args = json!({"query": q, "limit": 5});
        let search_result = memory_store::search(&search_args)?;
        search_result
            .get("hits")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    };

    if entry_ids.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Traverse.
    let nodes = kioku_graph_traversal::traverse_subgraph(
        &conn,
        &entry_ids,
        max_depth,
        kioku_edge_types::CANONICAL_EDGE_TYPES,
    )?;

    // Optional kind filter (returns a HashSet — reduce nodes to those whose
    // ids appear in the allowed set).
    let nodes = if !kinds_owned.is_empty() {
        let kinds_ref: Vec<&str> = kinds_owned.iter().map(String::as_str).collect();
        let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
        let allowed = kioku_graph_traversal::filter_node_ids_by_kind(&conn, &node_ids, &kinds_ref)?;
        nodes
            .into_iter()
            .filter(|n| allowed.contains(&n.id))
            .collect()
    } else {
        nodes
    };

    if nodes.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Decay lookup for ranking. Similarity is empty (we don't compute
    // embeddings synchronously); the ranker uses RANKER_FLOOR for both
    // missing similarity and missing decay.
    let node_ids: Vec<String> = nodes.iter().map(|n| n.id.clone()).collect();
    let decay_lookup = kioku_graph_traversal::fetch_decay_scores(&conn, &node_ids)?;
    let similarity_lookup: HashMap<String, f64> = HashMap::new();
    let ranked = kioku_graph_traversal::rank_subgraph_hits(&nodes, &decay_lookup, &similarity_lookup);

    // Take top N.
    let top_ids: Vec<String> = ranked.iter().take(limit).map(|r| r.id.clone()).collect();
    if top_ids.is_empty() {
        return Ok(content_text(&serde_json::to_string(&json!({"hits": []})).map_err(|e| e.to_string())?));
    }

    // Inline bodies. memory_store::fetch takes a payload {"ids": [...]}.
    let fetch_args = json!({"ids": top_ids});
    let fetch_result = memory_store::fetch(&fetch_args)?;
    let items = fetch_result
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    // Index ranked-hit metadata by id so we can zip score + depth onto items.
    let meta: HashMap<String, (f64, u32)> = ranked
        .iter()
        .take(limit)
        .map(|r| (r.id.clone(), (r.score, r.depth)))
        .collect();
    let hits: Vec<Value> = items
        .into_iter()
        .map(|mut item| {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                if let Some((score, depth)) = meta.get(&id) {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("score".to_string(), json!(*score));
                        obj.insert("depth".to_string(), json!(*depth));
                    }
                }
            }
            item
        })
        .collect();

    Ok(content_text(&serde_json::to_string(&json!({"hits": hits})).map_err(|e| e.to_string())?))
}
```

- [ ] **Step 5: Route in `dispatch`**

In `src-tauri/src/mcp_server/mod.rs`:

```rust
        "shogun.kioku_debug_stats" => kioku::handle_debug_stats(args),
        "shogun.kioku_related" => kioku::handle_related(args),
```

- [ ] **Step 6: Confirm `kioku_edge_types::CANONICAL_EDGE_TYPES` is reachable**

Run: `grep -n "pub const CANONICAL_EDGE_TYPES" /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/src/kioku_edge_types.rs`

Expected: 1 line. The const is `pub` and lives in a `pub mod` (`kioku_edge_types` is declared `pub mod` in `lib.rs` already). If not, fix the visibility before continuing.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --locked --lib mcp_server::`

Expected: `test result: ok. 24 passed; 0 failed` (22 prior + 2 new).

- [ ] **Step 8: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add src-tauri/src/kioku_mcp.rs src-tauri/src/mcp_server/kioku.rs src-tauri/src/mcp_server/mod.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "feat(mcp): handle shogun.kioku_related"
```

---

### Task 9: Extend stdio smoke test for the 5 new tools

**Files:**
- Modify: `scripts/smoke_mcp_stdio.mjs`

The current smoke test checks 5 meeting tools. After the binary aggregation in Task 3 + the handlers in Tasks 4–8, the binary advertises 10 tools. Update the assertions and add per-tool exercises.

- [ ] **Step 1: Bump the expected tool count and name set**

In `scripts/smoke_mcp_stdio.mjs`, find the section that asserts `tools/list` returned exactly 5 tools. Update:

- The expected count from `5` to `10`.
- The expected name set to include all 10 names: `shogun.meetings_list`, `shogun.meeting_get`, `shogun.meeting_transcript`, `shogun.meeting_notes`, `shogun.meetings_search`, `shogun.memory_search`, `shogun.memory_fetch`, `shogun.memory_entities`, `shogun.kioku_debug_stats`, `shogun.kioku_related`.

If the current implementation hardcodes the list inline, just add the 5 new names to it. If it stores them in a constant, add to the constant.

- [ ] **Step 2: Add per-tool exercises**

After the existing meeting-tool exercises (or alongside them — keep frame ordering deterministic), add:

```js
// Frame: shogun.memory_search with non-empty query
await sendCall("shogun.memory_search", { query: "x", limit: 3 });
// Expected: isError absent or false; content[0].text is JSON with `hits` array.

// Frame: shogun.memory_fetch with empty ids
await sendCall("shogun.memory_fetch", { ids: [] });
// Expected: isError true; content[0].text contains "ids".

// Frame: shogun.memory_entities with valid q
await sendCall("shogun.memory_entities", { q: "test" });
// Expected: isError absent or false; content[0].text is JSON with `entities` array.

// Frame: shogun.kioku_debug_stats with no args
await sendCall("shogun.kioku_debug_stats", {});
// Expected: isError absent or false; content[0].text is JSON with top-level `queue`, `cost`, `graph`, `flags`, `now_ms` keys.

// Frame: shogun.kioku_related with no entry input
await sendCall("shogun.kioku_related", {});
// Expected: isError true; content[0].text contains "query" and "seed_ids".

// Frame: shogun.kioku_related with a query
await sendCall("shogun.kioku_related", { query: "x" });
// Expected: isError absent or false; content[0].text is JSON with `hits` array (may be empty).
```

`sendCall` is the existing helper; reuse it. The exact test-runner shape (e.g. an `assertions` array, a tap-style harness, etc.) follows whatever pattern the existing meeting-tool tests use in this file. Don't change the harness shape — just add frames consistent with it.

- [ ] **Step 3: Run the smoke test against a built binary**

Run:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools
cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp --locked
SHOGUN_MCP_BIN=$(pwd)/src-tauri/target/debug/shogun-mcp node scripts/smoke_mcp_stdio.mjs || true
```

(If `SHOGUN_MCP_BIN` env-var support wasn't added yet, just run `node scripts/smoke_mcp_stdio.mjs`. The existing script hardcodes the debug path.)

Expected: assertions for the 10 tools all run; `is_error` checks per the comments above. Some assertions may legitimately skip (e.g., kioku_related with no graph data → empty hits is acceptable, not a fail).

If a per-tool call fails unexpectedly, capture the binary's stderr (`2> /tmp/shogun-mcp-stderr.log`) for diagnosis.

- [ ] **Step 4: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add scripts/smoke_mcp_stdio.mjs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "test(mcp): extend stdio smoke test to cover 10 tools"
```

---

### Task 10: Update Claude Desktop setup doc

**Files:**
- Modify: `docs/mcp-claude-desktop-setup.md`

- [ ] **Step 1: Update the "Available now" tool list**

Find the section starting with `**Available now (read-only):**`. Replace the 5-item list with this 10-item list:

```markdown
**Available now (read-only):**

Meeting tools:
- `shogun.meetings_list` — list saved meetings, optional time range
- `shogun.meeting_get` — meeting metadata + transcript + note blocks
- `shogun.meeting_transcript` — final transcript segments
- `shogun.meeting_notes` — note blocks (user / ai / ai_edited)
- `shogun.meetings_search` — keyword FTS across titles, transcripts, notes

Memory tools:
- `shogun.memory_search` — lexical search across memory items (notes, decisions, facts)
- `shogun.memory_fetch` — retrieve full content of memory items by ID
- `shogun.memory_entities` — search the entity catalog (people, organizations, projects)

Kioku tools:
- `shogun.kioku_debug_stats` — snapshot of memory subsystem health (queue, cost, graph, flags)
- `shogun.kioku_related` — find related memory items via graph traversal (give a query or seed_ids)
```

- [ ] **Step 2: Update the "Not available" list**

Find `**Not available:**`. Leave `shogun.meeting_recipe_run` in. Remove the bullet "`Memory / kioku tools — separate plan.`" since they're now available.

- [ ] **Step 3: Build the release binary to confirm the doc-stated path**

Run:

```bash
cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/Cargo.toml --bin shogun-mcp --release --locked
ls /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools/src-tauri/target/release/shogun-mcp
```

Expected: success, binary exists. The doc tells users to build the same way; sanity-check that the path is correct.

- [ ] **Step 4: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools add docs/mcp-claude-desktop-setup.md
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-memory-kioku-tools commit -m "docs(mcp): list memory and kioku tools in Claude Desktop guide"
```

---

## Self-Review Notes

**Spec coverage:** 5 tools in the catalogue → 5 handler tasks (4–8). Refactor section → Task 1. Tool descriptor aggregation → Task 3. Tests section → tests embedded in each handler task plus smoke test extension in Task 9. Out-of-scope items (async/write/eval/backup/per-area stats) are not included as tasks. The single spec-correction (`kioku.related` query path uses lexical search instead of embedding-similarity) is documented in the plan header and implemented in Task 8.

**Placeholder scan:** every step has either complete code, exact paths, or exact commands. Task 9 Step 2 is the softest spot — it says "the exact test-runner shape follows whatever pattern the existing meeting-tool tests use in this file." That's load-bearing because the smoke test script wasn't fully captured here; the implementer reads `scripts/smoke_mcp_stdio.mjs` to match the existing pattern. This is preferable to inventing a parallel harness.

**Type consistency:**
- `MeetingsListArgs`, `parse_meetings_list_args`, `require_meeting_id`, `require_string_field`, `content_text`, `dispatch` — used consistently across Tasks 1–8.
- `kioku_graph_traversal::TraversalNode` (with `id, depth, path_score`), `RankedHit` (with `id, score, depth`), `EntryNode` (unused — we skip `pick_entry_nodes`) — verified against actual source.
- `memory_store` functions: `search(payload) -> Value`, `fetch(payload) -> Value`, `entities_from_catalog(payload) -> Value`, `open_conn() -> Connection` — verified.
- `kioku_debug_stats::assemble_debug_stats(conn, settings, now_ms) -> Value` — verified.
- `kioku_edge_types::CANONICAL_EDGE_TYPES: &[&str]` — verified.
- `settings_store::load() -> Result<Value, String>` — verified.

**Risk:** Task 8's handler is ~80 lines of composition, the densest single edit in the plan. The TDD-only safety net is the "either query or seed_ids required" arg-validation test; the actual graph traversal is exercised in the smoke test (Task 9). If a future reader finds the `kioku_related` body unmaintainable, splitting into `resolve_entry_ids`, `traverse_with_filter`, `rank_and_inline` private helpers is the natural follow-up — but doing it preemptively before the second consumer exists would be premature.
