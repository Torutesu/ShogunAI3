# Shogun MCP stdio Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone `shogun-mcp` binary that speaks Model Context Protocol over stdio and exposes the 5 read-only meeting tools already declared in `meeting_mcp::tool_definitions()`, so Claude Desktop (and any other MCP client) can read ShogunAI3's local data.

**Architecture:** Add a new `[[bin]]` target inside `src-tauri/` that reuses the existing `app_lib` library and calls `meeting_store::*` functions directly. SQLite is opened via the existing `memory_store::open_conn()` helper, which already enables WAL mode — that gives us safe concurrent reads alongside a running Tauri app. No auth: this is a single-user desktop app, the MCP client is launched as a stdio subprocess on the same machine, OS process boundary is the trust boundary. The 6th tool (`meeting_recipe_run`) is async + LLM-dependent and is deferred to a follow-up plan.

**Tech Stack:** Rust + `rmcp = "0.8"` (official MCP SDK, features `server` + `transport-io`) · `tokio` (already in Cargo.toml) · `serde_json` (already in Cargo.toml) · `tracing-subscriber` (new, stderr-only — stdout is the MCP transport so any println would corrupt it).

**Out of scope for this plan:**
- `shogun.meeting_recipe_run` (async + needs LLM keys; follow-up).
- Memory / kioku tools (the agents-screen mentions "11 MCP tools"; that's a separate plan).
- HTTP / SSE transport. stdio only.
- Auth. Single-user app, local subprocess only.

---

## File Structure

**Create:**
- `src-tauri/src/mcp_server.rs` — pure-Rust handler module: input parsing, dispatch by tool name, output shaping into MCP `content` blocks. Reuses `meeting_mcp::tool_definitions()` for the advertised tool list. Unit-testable without the DB.
- `src-tauri/src/bin/shogun_mcp.rs` — thin binary entrypoint. Wires `mcp_server::dispatch` into an `rmcp` `ServerHandler` and runs the stdio transport loop.
- `docs/mcp-claude-desktop-setup.md` — copy-pasteable Claude Desktop config snippet.

**Modify:**
- `src-tauri/Cargo.toml` — add `rmcp` and `tracing-subscriber` deps; declare `[[bin]] name = "shogun-mcp"`.
- `src-tauri/src/lib.rs` — add `pub mod mcp_server;` so the new binary can `use app_lib::mcp_server`.

**Do not touch:**
- `src-tauri/src/meeting_mcp.rs` — keep as-is; we import `tool_definitions()` from it.
- `src-tauri/src/meeting_commands.rs::shogun_meeting_mcp_tools` — keep the Tauri command; it's an in-app introspection endpoint, unrelated to the new stdio binary.
- `src-tauri/src/auth.rs`, `hifi/lib/clerk-auth.js` — Clerk is for the WebView UI, not the MCP layer.

---

### Task 1: Dependencies & binary target

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add rmcp and tracing-subscriber to `[dependencies]`**

In `src-tauri/Cargo.toml`, add these lines to the `[dependencies]` block (alphabetical placement is fine; put them near the other top-level deps):

```toml
rmcp = { version = "0.8", features = ["server", "transport-io", "macros"] }
tracing-subscriber = { version = "0.3", default-features = false, features = ["fmt", "env-filter"] }
```

- [ ] **Step 2: Declare the binary target**

Append to the very end of `src-tauri/Cargo.toml`:

```toml
[[bin]]
name = "shogun-mcp"
path = "src/bin/shogun_mcp.rs"
```

- [ ] **Step 3: Create a stub binary so `cargo check` passes**

Create `src-tauri/src/bin/shogun_mcp.rs` with this content (replaced fully in Task 7):

```rust
fn main() {
    eprintln!("shogun-mcp: stub — implement in Task 7");
}
```

- [ ] **Step 4: Run cargo check**

Run: `cargo check --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml`
Expected: success (only warnings allowed; no errors). The new deps download and compile.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/bin/shogun_mcp.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): scaffold shogun-mcp binary target with rmcp dep"
```

---

### Task 2: `mcp_server` module skeleton + dispatch error path (TDD)

**Files:**
- Create: `src-tauri/src/mcp_server.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/mcp_server.rs` with this content:

```rust
//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, _args: &Value) -> Result<Value, String> {
    Err(format!("unknown tool: {name}"))
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

Then add to `src-tauri/src/lib.rs`. Find the `mod meeting_mcp;` line and add `pub mod mcp_server;` immediately after it (alphabetical placement is approximate — exact neighbor doesn't matter as long as it's in the top-level module block).

- [ ] **Step 2: Run test to verify it fails to compile (or fails)**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests::unknown_tool_name_returns_error`
Expected: PASS (we wrote it to pass on the stub `Err(...)` immediately — the assertion just checks the error string format).

The point of this task is to lock in the dispatch signature and module wiring, not to find a real failure. If the test errors out with "module not found" or similar, fix the `lib.rs` insertion.

- [ ] **Step 3: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/mcp_server.rs src-tauri/src/lib.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): add mcp_server dispatch skeleton"
```

---

### Task 3: `shogun.meetings_list` handler (TDD)

**Files:**
- Modify: `src-tauri/src/mcp_server.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/mcp_server.rs`, replace the `mod tests` block with:

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
    fn meetings_list_parses_valid_args() {
        let args = json!({ "from_ms": 1714435200000u64, "to_ms": 1714521600000u64, "limit": 10 });
        let parsed = parse_meetings_list_args(&args).expect("valid args");
        assert_eq!(parsed.from_ms, Some(1714435200000));
        assert_eq!(parsed.to_ms, Some(1714521600000));
        assert_eq!(parsed.limit, 10);
    }

    #[test]
    fn meetings_list_defaults_limit_when_missing() {
        let parsed = parse_meetings_list_args(&json!({})).expect("empty args ok");
        assert_eq!(parsed.from_ms, None);
        assert_eq!(parsed.to_ms, None);
        assert_eq!(parsed.limit, 25);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests`
Expected: FAIL — `parse_meetings_list_args` is not defined.

- [ ] **Step 3: Implement minimal arg parser + handler**

In `src-tauri/src/mcp_server.rs`, between the module docstring and `pub fn dispatch`, add:

```rust
use crate::meeting_store;

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

fn handle_meetings_list(args: &Value) -> Result<Value, String> {
    let p = parse_meetings_list_args(args)?;
    let rows = meeting_store::list_meetings(p.from_ms, p.to_ms, p.limit)?;
    Ok(content_text(&serde_json::to_string(&rows).map_err(|e| e.to_string())?))
}

/// Wrap a string payload in the MCP `content` shape.
fn content_text(s: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": s } ] })
}
```

Then update `dispatch` to route the new tool:

```rust
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => handle_meetings_list(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/mcp_server.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): handle shogun.meetings_list"
```

---

### Task 4: `shogun.meeting_get` handler (TDD)

**Files:**
- Modify: `src-tauri/src/mcp_server.rs`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/mcp_server.rs`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests::meeting_get`
Expected: FAIL — `dispatch` returns `unknown tool: shogun.meeting_get`.

- [ ] **Step 3: Implement the handler**

In `src-tauri/src/mcp_server.rs`, add a helper for the `meeting_id` extraction and the handler:

```rust
fn require_meeting_id(args: &Value) -> Result<String, String> {
    args.get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "meeting_id is required (string)".to_string())
}

fn handle_meeting_get(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let detail = meeting_store::get_meeting_detail(&id)?;
    Ok(content_text(&serde_json::to_string(&detail).map_err(|e| e.to_string())?))
}
```

Add the route in `dispatch`:

```rust
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => handle_meetings_list(args),
        "shogun.meeting_get" => handle_meeting_get(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/mcp_server.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): handle shogun.meeting_get"
```

---

### Task 5: `shogun.meeting_transcript` and `shogun.meeting_notes` handlers (TDD)

These two share the same arg shape as `meeting_get` (just `meeting_id`), so they're paired in one task.

**Files:**
- Modify: `src-tauri/src/mcp_server.rs`

- [ ] **Step 1: Write the failing tests**

Add to `mod tests` in `src-tauri/src/mcp_server.rs`:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests::meeting_transcript_requires_meeting_id mcp_server::tests::meeting_notes_requires_meeting_id`
Expected: FAIL — `dispatch` returns `unknown tool` for both names.

- [ ] **Step 3: Implement the handlers**

In `src-tauri/src/mcp_server.rs`, add:

```rust
fn handle_meeting_transcript(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let segments = meeting_store::list_transcript_final(&id)?;
    Ok(content_text(&serde_json::to_string(&segments).map_err(|e| e.to_string())?))
}

fn handle_meeting_notes(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let blocks = meeting_store::list_note_blocks(&id)?;
    Ok(content_text(&serde_json::to_string(&blocks).map_err(|e| e.to_string())?))
}
```

Replace `dispatch` with the routes added:

```rust
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => handle_meetings_list(args),
        "shogun.meeting_get" => handle_meeting_get(args),
        "shogun.meeting_transcript" => handle_meeting_transcript(args),
        "shogun.meeting_notes" => handle_meeting_notes(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/mcp_server.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): handle meeting_transcript and meeting_notes"
```

---

### Task 6: `shogun.meetings_search` handler (TDD)

**Files:**
- Modify: `src-tauri/src/mcp_server.rs`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `src-tauri/src/mcp_server.rs`:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests::meetings_search`
Expected: FAIL — `dispatch` returns `unknown tool`.

- [ ] **Step 3: Implement the handler**

In `src-tauri/src/mcp_server.rs`, add:

```rust
fn handle_meetings_search(args: &Value) -> Result<Value, String> {
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
```

Add the route in `dispatch`:

```rust
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => handle_meetings_list(args),
        "shogun.meeting_get" => handle_meeting_get(args),
        "shogun.meeting_transcript" => handle_meeting_transcript(args),
        "shogun.meeting_notes" => handle_meeting_notes(args),
        "shogun.meetings_search" => handle_meetings_search(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked mcp_server::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/mcp_server.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): handle shogun.meetings_search"
```

---

### Task 7: rmcp stdio binary entrypoint

This task replaces the stub binary with the real rmcp service. There is no unit test for this task — the verification is the manual smoke test in Task 8 (rmcp's stdio loop is what we're invoking, and `cargo test` can't drive a stdio child process cleanly without infrastructure we don't need).

**Files:**
- Modify: `src-tauri/src/bin/shogun_mcp.rs`

- [ ] **Step 1: Replace the stub binary**

Replace the entire contents of `src-tauri/src/bin/shogun_mcp.rs` with:

```rust
//! shogun-mcp: Model Context Protocol stdio server exposing ShogunAI3
//! meeting tools to external MCP clients (Claude Desktop, etc.).
//!
//! Stdout is the MCP transport — never println!. All logs go to stderr.

use app_lib::{mcp_server, meeting_mcp};
use rmcp::{
    handler::server::ServerHandler,
    model::{
        CallToolRequestParam, CallToolResult, Content, ListToolsResult, ProtocolVersion,
        ServerCapabilities, ServerInfo, Tool,
    },
    service::{RequestContext, RoleServer},
    transport::stdio,
    Error as McpError, ServiceExt,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone)]
struct ShogunService;

impl ServerHandler for ShogunService {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: ProtocolVersion::default(),
            capabilities: ServerCapabilities::builder().enable_tools().build(),
            server_info: rmcp::model::Implementation {
                name: "shogun-mcp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            instructions: Some(
                "ShogunAI3 meeting tools. All tools are read-only against the local SQLite DB."
                    .to_string(),
            ),
        }
    }

    async fn list_tools(
        &self,
        _request: Option<rmcp::model::PaginatedRequestParam>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let defs: Value = meeting_mcp::tool_definitions();
        let arr = defs.as_array().cloned().unwrap_or_default();
        let tools: Vec<Tool> = arr
            .into_iter()
            // Skip meeting_recipe_run for this MVP — async + LLM-dependent.
            .filter(|t| t.get("name").and_then(|n| n.as_str()) != Some("shogun.meeting_recipe_run"))
            .filter_map(|t| {
                let name = t.get("name")?.as_str()?.to_string();
                let description = t.get("description")?.as_str()?.to_string();
                let schema = t.get("input_schema")?.clone();
                let schema_obj = schema.as_object()?.clone();
                Some(Tool {
                    name: name.into(),
                    description: Some(description.into()),
                    input_schema: Arc::new(schema_obj),
                    annotations: None,
                })
            })
            .collect();
        Ok(ListToolsResult { tools, next_cursor: None })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParam,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = request
            .arguments
            .map(Value::Object)
            .unwrap_or(Value::Object(Default::default()));
        match mcp_server::dispatch(&request.name, &args) {
            Ok(payload) => {
                // dispatch returns { "content": [ { "type":"text", "text":"..." } ] }
                let texts = payload
                    .get("content")
                    .and_then(|c| c.as_array())
                    .cloned()
                    .unwrap_or_default();
                let content: Vec<Content> = texts
                    .into_iter()
                    .filter_map(|t| t.get("text").and_then(|x| x.as_str()).map(|s| Content::text(s.to_string())))
                    .collect();
                Ok(CallToolResult { content, is_error: Some(false) })
            }
            Err(msg) => Ok(CallToolResult {
                content: vec![Content::text(msg)],
                is_error: Some(true),
            }),
        }
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let service = ShogunService.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
```

- [ ] **Step 2: Add `anyhow` to Cargo.toml if not present**

Check `src-tauri/Cargo.toml` `[dependencies]` for `anyhow`. If missing, add:

```toml
anyhow = "1"
```

Run: `grep '^anyhow' /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml`
Expected: one line starting with `anyhow = `.

- [ ] **Step 3: Build the binary**

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --bin shogun-mcp --locked`
Expected: success. Binary produced at `src-tauri/target/debug/shogun-mcp`.

If the build fails because `rmcp` 0.8 API names differ from what's in this snippet (the SDK is young and surface names move between minor versions), fix the imports/types to match the version that resolved in `Cargo.lock`. The shape of the work doesn't change: a `ServerHandler` impl with `list_tools` and `call_tool`, served over `stdio()`. Use `cargo doc --open -p rmcp` to inspect the actual types.

- [ ] **Step 4: Run unit tests one more time**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/Cargo.toml --locked --bin shogun-mcp --lib`
Expected: PASS (all `mcp_server::tests::*`).

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add src-tauri/src/bin/shogun_mcp.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "feat(mcp): wire rmcp stdio server for shogun-mcp"
```

---

### Task 8: End-to-end smoke test with MCP Inspector

This is a manual verification step. There is no unit test — we run the actual binary and drive it with the MCP Inspector tool to confirm the protocol round-trips work and the data flowing out matches what's in the local SQLite.

**Files:** none modified.

- [ ] **Step 1: Confirm the local DB has at least one meeting**

Run the desktop app once via `npm run dev:desktop` and either start a brief meeting (any audio is fine) or let an existing meeting be present. Quit the app afterward to release any exclusive locks (WAL allows concurrent readers, but cleaner to test in isolation first).

Verify a row exists:

Run: `sqlite3 "$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.sqlite" "SELECT id, title FROM meetings LIMIT 3;"`
Expected: at least one row printed. Capture one `meeting_id` for Step 4.

If the file path differs (e.g. the schema isn't in `memory.sqlite`), find it: `ls "$HOME/Library/Application Support/ai.Shogun.ShogunAI3/"` and identify the .sqlite file then re-run the query.

- [ ] **Step 2: Launch MCP Inspector pointed at the binary**

Run (in a fresh terminal):

```bash
npx @modelcontextprotocol/inspector \
  /Users/torutano/ShogunAI3/ShogunAI3/src-tauri/target/debug/shogun-mcp
```

Expected: a browser tab opens at `http://localhost:6274` (or similar port) showing the inspector UI. The "Server" panel shows `shogun-mcp` connected.

- [ ] **Step 3: Verify tools list**

In the inspector UI, click "List Tools".
Expected: 5 tools listed — `shogun.meetings_list`, `shogun.meeting_get`, `shogun.meeting_transcript`, `shogun.meeting_notes`, `shogun.meetings_search`. (`shogun.meeting_recipe_run` is intentionally filtered out.)

- [ ] **Step 4: Call `shogun.meetings_list`**

In the inspector, select `shogun.meetings_list`, leave args empty (`{}`), click Run.
Expected: `is_error: false`, `content[0].text` is a JSON array of meetings.

- [ ] **Step 5: Call `shogun.meeting_get` with the captured meeting_id**

Args: `{ "meeting_id": "<id from Step 1>" }`. Click Run.
Expected: `is_error: false`, `content[0].text` is a JSON object with the meeting metadata.

- [ ] **Step 6: Call `shogun.meeting_get` with a bogus id**

Args: `{ "meeting_id": "does-not-exist" }`. Click Run.
Expected: `is_error: false`, `content[0].text` is `null` (the underlying `get_meeting_detail` returns `Option<Value>` which serializes to `null` when missing).

- [ ] **Step 7: Call `shogun.meeting_get` with no args**

Args: `{}`. Click Run.
Expected: `is_error: true`, `content[0].text` contains "meeting_id is required".

- [ ] **Step 8: Stop the inspector and commit**

Ctrl+C the inspector. No code changed in this task, so commit only if the prior task's commit hasn't been pushed yet (no-op otherwise).

---

### Task 9: Claude Desktop config doc

**Files:**
- Create: `docs/mcp-claude-desktop-setup.md`

- [ ] **Step 1: Write the doc**

Create `docs/mcp-claude-desktop-setup.md` with this content:

```markdown
# Connecting ShogunAI3 to Claude Desktop via MCP

The `shogun-mcp` binary is a Model Context Protocol stdio server that exposes
ShogunAI3's meeting data to Claude Desktop. It reads the same local SQLite DB
the Tauri app writes to (WAL mode → safe to run with the app open).

## Build

From the repo root:

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp --release
```

The binary lands at `src-tauri/target/release/shogun-mcp`.

## Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` and add:

```json
{
  "mcpServers": {
    "shogun": {
      "command": "/Users/<you>/path/to/ShogunAI3/src-tauri/target/release/shogun-mcp"
    }
  }
}
```

Replace the path with your absolute path to the built binary. Restart Claude
Desktop. In a new chat, the 🛠 icon should show `shogun.meetings_list`,
`shogun.meeting_get`, `shogun.meeting_transcript`, `shogun.meeting_notes`,
`shogun.meetings_search`.

## What's exposed (and what isn't)

**Available now (read-only):**
- `shogun.meetings_list` — list saved meetings, optional time range
- `shogun.meeting_get` — meeting metadata + transcript + note blocks
- `shogun.meeting_transcript` — final transcript segments
- `shogun.meeting_notes` — note blocks (user / ai / ai_edited)
- `shogun.meetings_search` — keyword FTS across titles, transcripts, notes

**Not available:**
- `shogun.meeting_recipe_run` — async + LLM-dependent, deferred to a follow-up.
- Memory / kioku tools — separate plan.

## Auth

None. ShogunAI3 is a single-user desktop app and `shogun-mcp` is launched as a
stdio subprocess of Claude Desktop on the same machine. The OS process boundary
is the trust boundary; no Clerk, no OAuth, no tokens.

## Logs

`shogun-mcp` writes logs to **stderr** (stdout is the MCP transport). To see
them, launch the binary directly:

```bash
RUST_LOG=debug ./src-tauri/target/release/shogun-mcp
```

Then either pipe MCP frames manually or run via `npx @modelcontextprotocol/inspector`.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3 add docs/mcp-claude-desktop-setup.md
git -C /Users/torutano/ShogunAI3/ShogunAI3 commit -m "docs(mcp): add Claude Desktop setup guide"
```

---

## Self-Review Notes

**Spec coverage:** 5 of 6 tools from `meeting_mcp::tool_definitions()` covered (Tasks 3–6). The 6th, `meeting_recipe_run`, is explicitly deferred and called out in the doc — single recipe tool requires async + LLM keys + a different test strategy, so it belongs in a follow-up plan.

**Auth:** explicitly addressed in the architecture summary and Task 9 doc — none required, OS process boundary is the trust boundary.

**No placeholders:** every step has either complete code, an exact command, or an exact expected outcome. The only soft spot is Task 7 Step 3, which acknowledges `rmcp` 0.8 API names may move and points the engineer at `cargo doc -p rmcp`. That's load-bearing because the SDK is pre-1.0; pinning to "find the equivalent in the resolved version" is more honest than guessing.

**Type consistency:** `MeetingsListArgs`, `parse_meetings_list_args`, `require_meeting_id`, `content_text`, `dispatch` — names used consistently across Tasks 3–6. `meeting_store::*` function names verified against `src-tauri/src/meeting_store.rs` (`list_meetings`, `get_meeting_detail`, `list_transcript_final`, `list_note_blocks`, `search_meetings_fts`).
