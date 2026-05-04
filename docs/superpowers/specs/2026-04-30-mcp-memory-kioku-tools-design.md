# Memory & Kioku MCP Tools — Design

## Goal

Extend the shipped `shogun-mcp` stdio server with **5 additional read-only MCP tools** that expose ShogunAI3's memory store and kioku knowledge graph to external MCP clients (Claude Desktop, etc.). After this round, `shogun-mcp` will advertise **10 tools total** (5 meeting + 5 memory/kioku).

## Use Cases

The user picked option C — both writing/thinking aid and observability:

- **Writing aid:** Claude Desktop pulls relevant memories and entities while drafting documents, replies, decisions.
- **Observability:** Claude Desktop answers "how is my memory subsystem doing?" — queue lag, cost ledger, graph size — in one round-trip.

Sets the bar: tools must be useful from a chat context with no extra tool-chaining when avoidable. (E.g., `kioku.related` returns full item bodies inline so Claude doesn't need a follow-up `memory.fetch`.)

## Tool Catalogue

All 5 tools follow the existing `shogun.<name>` namespace convention. Read-only. Synchronous handlers.

### 1. `shogun.memory_search`

Lexical/FTS search across memory items.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | yes | — | Free-form search terms |
| `kinds` | string[] | no | — | Optional filter on item kind (e.g., `["note", "decision"]`) |
| `scope` | string | no | — | Optional scope filter (matches `memory_store::search` payload key) |
| `limit` | integer | no | 25 | Max hits returned |

**Backing call:** `memory_store::search(payload: &Value) -> Result<Value, String>` — pass-through after building the payload object.

**Output:** raw `Value` from `memory_store::search` (already shaped as `{hits, total, echo, stub}`), wrapped in MCP `content_text`.

**Error paths:** missing `query`, empty `query` after trim. Same pattern as `shogun.meetings_search`.

### 2. `shogun.memory_fetch`

Retrieve full content of memory items by ID — typically called after `shogun.memory_search` returns hit IDs.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `ids` | string[] | yes | — | Memory item IDs |

**Backing call:** `memory_store::fetch(payload: &Value) -> Result<Value, String>` — pass-through.

**Output:** `{items, echo, stub}` shape from `fetch`, wrapped in `content_text`.

**Error paths:** missing `ids`, empty `ids` array, non-array `ids`.

### 3. `shogun.memory_entities`

Search the entity catalog (people, organizations, projects extracted across memories).

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `q` | string | yes | — | Entity name or partial query |

**Backing call:** `memory_store::entities_from_catalog(payload: &Value) -> Result<Value, String>` — pass-through.

**Output:** `{entities, total, echo, stub}` shape, wrapped in `content_text`.

**Error paths:** missing `q`, empty `q` after trim.

### 4. `shogun.kioku_related`

Find memory items related to a seed via the kioku knowledge graph (decision-graph traversal + decay-aware ranking). Provide either a `query` (lexical entry-point pick) or `seed_ids` (explicit entry points).

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | one of {query, seed_ids} | — | Used to pick entry nodes via lexical match |
| `seed_ids` | string[] | one of {query, seed_ids} | — | Explicit memory item IDs as graph entry points |
| `limit` | integer | no | 10 | Max ranked hits returned |
| `max_depth` | integer | no | 2 | Graph traversal depth, clamped to [1, 3] |
| `kinds` | string[] | no | — | Optional node-kind filter applied between traversal and ranking |

**Composition algorithm:**

```text
1. resolve entry: Vec<NodeId>
   - if seed_ids: parse as NodeId[]
   - elif query: pick_entry_nodes(conn, query, k=5)
   - else: error("provide either query or seed_ids")
2. nodes = traverse_subgraph(conn, entry, max_depth)
3. if kinds: nodes = filter_node_ids_by_kind(conn, nodes, kinds)
4. ranked: Vec<(NodeId, f64)> = rank_subgraph_hits(conn, nodes)
5. top = ranked.into_iter().take(args.limit)
6. items = memory_store::fetch({ids: top_ids})  // inline body
7. zip scores onto items
8. return {hits: [{id, score, kind, body, ...}, ...]}
```

**Why inline bodies:** without it the client always needs a second `memory_fetch` call. Response payload is bounded by `limit × max_depth`, so this is safe.

**Why `max_depth` clamped to [1, 3]:** kioku convention; depth=4+ explodes for large graphs. Clamp transparently — don't error on out-of-range, just clamp.

**Edge case: empty entry set.** Return `{hits: []}` with `is_error: false`. Not finding anything is normal.

**Active-graph only.** `traverse_subgraph` is expected to default to active mem_items (not retired). The plan-writing step verifies this against the actual primitive signature; if the primitive doesn't filter by default, the handler passes an explicit "active only" parameter. Either way, retired items must NOT appear in results.

**Error paths:** neither `query` nor `seed_ids` provided; both empty after trim/array-check.

**Open questions for plan-writing (not for spec):**
- Exact signatures of `pick_entry_nodes` / `traverse_subgraph` / `rank_subgraph_hits` — they're known to exist (per the Explore-agent inventory) but the param lists weren't captured. The plan reads `src-tauri/src/kioku_graph_traversal.rs` and locks the call shape there.
- `NodeId` is expected to be `String` (= `mem_items.id`). Plan verifies.

### 5. `shogun.kioku_debug_stats`

One-shot snapshot of memory subsystem health.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| _(none)_ | — | — | — | No arguments |

**Backing call:** `kioku_debug_stats::assemble_debug_stats(...) -> Result<Value, String>` — direct call.

**Output:** combined object with queue counts, cost-ledger status, graph node/edge totals (whatever `assemble_debug_stats` returns; it's already shaped for UI consumption). Wrapped in `content_text`.

**Error paths:** none beyond what `assemble_debug_stats` itself surfaces (e.g., DB connection failure).

## Architecture

### File layout (Approach 2 — refactor into submodules)

The current `src-tauri/src/mcp_server.rs` (165 lines, all meeting handlers) is restructured into:

```
src-tauri/src/
├── mcp_server/
│   ├── mod.rs       — pub fn dispatch (the only pub item); shared helpers (content_text, require_meeting_id)
│   ├── meeting.rs   — existing meeting handlers, moved verbatim
│   ├── memory.rs    — new: memory_search, memory_fetch, memory_entities handlers
│   └── kioku.rs     — new: kioku_related, kioku_debug_stats handlers
├── meeting_mcp.rs   — unchanged (existing meeting tool descriptors)
├── memory_mcp.rs    — new: pub fn tool_definitions() for the 3 memory tools
└── kioku_mcp.rs     — new: pub fn tool_definitions() for the 2 kioku tools
```

**No public-API breakage.** `pub fn dispatch(name: &str, args: &Value) -> Result<Value, String>` keeps the same signature in `mcp_server::mod.rs`. Binary's `use app_lib::mcp_server` still resolves (a module-as-directory is interchangeable with module-as-file from the consumer's perspective).

### Dispatch table

```rust
// src-tauri/src/mcp_server/mod.rs
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        // meetings
        "shogun.meetings_list"      => meeting::handle_meetings_list(args),
        "shogun.meeting_get"        => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes"      => meeting::handle_meeting_notes(args),
        "shogun.meetings_search"    => meeting::handle_meetings_search(args),
        // memory
        "shogun.memory_search"      => memory::handle_search(args),
        "shogun.memory_fetch"       => memory::handle_fetch(args),
        "shogun.memory_entities"    => memory::handle_entities(args),
        // kioku
        "shogun.kioku_related"      => kioku::handle_related(args),
        "shogun.kioku_debug_stats"  => kioku::handle_debug_stats(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}
```

### Tool descriptor aggregation in the binary

`src-tauri/src/bin/shogun_mcp.rs` `list_tools()` is updated to merge descriptors from all 3 source modules. The existing `meeting_recipe_run` filter is preserved.

```rust
let mut all_defs: Vec<Value> = Vec::new();
for getter in [meeting_mcp::tool_definitions, memory_mcp::tool_definitions, kioku_mcp::tool_definitions] {
    if let Some(arr) = getter().as_array() {
        all_defs.extend(arr.iter().cloned());
    }
}
let tools: Vec<Tool> = all_defs.into_iter()
    .filter(|t: &Value| t.get("name").and_then(|n| n.as_str()) != Some("shogun.meeting_recipe_run"))
    .filter_map(|t: Value| { /* same Tool construction as before */ })
    .collect();
```

### Shared helpers in `mcp_server/mod.rs`

The submodules `meeting.rs`, `memory.rs`, `kioku.rs` reach back to shared helpers via `use super::*;`:

- `content_text(s: &str) -> Value` — the existing MCP envelope wrapper.
- `require_meeting_id(args: &Value) -> Result<String, String>` — existing helper, only used by `meeting.rs` after the refactor (kept in `mod.rs` so it's discoverable for any future tool that needs the same shape).

A new shared helper is added in `mod.rs` for the common "required non-empty string field" pattern that recurs in `memory_search`, `memory_entities`, and `kioku_related` (when given `query`):

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

This generalizes the existing inlined pattern in `meetings_search`. Existing meeting code is NOT refactored to use it (would create churn); new code uses the helper.

### Connection management

Each handler opens a fresh connection via `memory_store::open_conn()` — same pattern as the meeting handlers. WAL-mode safe under concurrent reads with the running Tauri app. `kioku.related` will need to share one connection across `pick_entry_nodes` / `traverse_subgraph` / `filter_node_ids_by_kind` / `rank_subgraph_hits` / `fetch_decay_scores`, so the handler opens the connection once at the top and passes it explicitly.

## Testing

### Unit tests (per handler, TDD pattern from Tasks 3–6 of the prior plan)

Each new handler gets 1–2 tests focused on argument validation and dispatch routing. DB-touching paths are not unit-tested (no fixture infrastructure; same line drawn in the prior plan).

| Tool | Tests |
|---|---|
| `memory_search` | `requires_query`, `rejects_empty_query` |
| `memory_fetch` | `requires_ids`, `rejects_empty_ids` |
| `memory_entities` | `requires_q` |
| `kioku_related` | `requires_query_or_seed_ids` |
| `kioku_debug_stats` | _(no input args; covered by smoke test)_ |

Plus: tests for `require_string_field` covering the trim-then-filter behavior, since this helper is now shared and worth pinning down.

Total: **~9 new unit tests** on top of the existing 9. After the refactor, the existing 9 must still pass — that's the gate that proves the move was clean.

**Test placement after refactor:** tests for shared dispatch behavior (`unknown_tool_name_returns_error`, `require_string_field` cases) live in `mcp_server/mod.rs`. Tests for tool-specific arg parsing live alongside their handler — meeting tests in `meeting.rs`, memory tests in `memory.rs`, kioku tests in `kioku.rs`. Test names stay byte-for-byte identical so existing `cargo test mcp_server::` filters keep matching.

### Integration / smoke tests

Extend `scripts/smoke_mcp_stdio.mjs` to exercise the new tools end-to-end:

- `tools/list` should now return **10 tools** (was 5). Add the 5 new names to the expected set.
- `tools/call shogun.kioku_debug_stats` with `{}` — assert `is_error: false` and content has top-level keys for queue/cost/graph (key set verified against `assemble_debug_stats` output).
- `tools/call shogun.memory_search` with `{query: "x"}` — assert `is_error: false` and content includes a `hits` array (may be empty against a fresh DB).
- `tools/call shogun.memory_fetch` with `{ids: []}` — assert `is_error: true` (rejects empty array).
- `tools/call shogun.kioku_related` with `{}` — assert `is_error: true` and message contains "query or seed_ids".
- `tools/call shogun.kioku_related` with `{query: "x"}` — assert `is_error: false` and content has a `hits` array.

Smoke-test extensions are committed in the same task as the relevant handler.

### Refactor safety check

The first task in the implementation plan is the file restructure (move meeting handlers to `mcp_server/meeting.rs`). The acceptance gate for that task is:

```
cargo test --manifest-path src-tauri/Cargo.toml --locked --lib
→ all 9 existing mcp_server::tests pass, no new tests, no behavior changes
```

If the existing tests don't pass after the move, the move was wrong — fix before adding new code.

## Out of Scope

- **Async tools.** Same line as the prior plan. `meeting_recipe_run` was deferred for being async + LLM-dependent; nothing in this round changes that.
- **Memory-write tools.** No `memory.ingest` / `memory.update` — single-user app, writes happen through the Tauri UI, exposing them via MCP creates audit/safety wrinkles for a marginal use case.
- **Edge-type browsing / graph schema introspection.** `kioku_edge_types` and `kioku_graph_schema` are internal-only. Not user-facing.
- **Eval framework / extraction worker control.** `kioku_eval`, `kioku_extraction` are operational internals.
- **Backup / restore tools.** `kioku_backup` is a state-mutating admin operation; not appropriate over MCP.
- **Per-area observability tools.** The user explicitly chose the combined `kioku_debug_stats` over splitting into `memory_stats` / `queue_stats` / `cost_stats` / `graph_stats`. If finer granularity is needed later, the combined tool's output already carries all the data — clients can pluck what they need.
- **Hitting "11 tools" exactly.** The `agents-screen-redesign` UI subtitle is a placeholder. The right number is whatever serves the use cases; it's 10.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `kioku.related` composes 3–5 primitives whose signatures aren't fully captured here | Plan-writing step reads `kioku_graph_traversal.rs` and locks the call shape before TDD starts. If a primitive is missing or shaped differently than expected, the plan handles it (one-off composition is preferred over inventing new primitives). |
| `assemble_debug_stats` may have parameters the spec didn't capture | Plan reads `kioku_debug_stats.rs` and confirms the no-arg invocation. If it requires args, the plan adapts the handler. |
| Refactor of existing `mcp_server.rs` could introduce subtle test breakage | The "first task is the refactor; gate is existing tests still passing" pattern catches this. |
| 10 tools is many — Claude may pick the wrong one | Tool descriptions are written tightly with concrete trigger examples. Smoke test verifies all 10 names round-trip. Beyond that, this is an MCP-client concern, not ours. |
| `memory.search`'s output shape may include `stub: true` flags that look weird to external clients | Pass-through — current `search` already returns `stub: false` for the real implementation. If the stub flag is confusing, a follow-up cleans it up; not blocking. |

## Plan Hand-off

After spec approval, the implementation plan is generated by `superpowers:writing-plans` in this same worktree (`feat/mcp-memory-kioku-tools`). Expected task layout:

1. Refactor — move meeting handlers into `mcp_server/meeting.rs`. Existing tests stay green. (Gate task.)
2. Add `require_string_field` helper + unit tests.
3. Implement `memory_search` (descriptor + handler + tests).
4. Implement `memory_fetch` (descriptor + handler + tests).
5. Implement `memory_entities` (descriptor + handler + tests).
6. Implement `kioku_debug_stats` (descriptor + handler).
7. Implement `kioku_related` (descriptor + handler + tests; the only design-judgment task).
8. Wire descriptor aggregation in `bin/shogun_mcp.rs` `list_tools`.
9. Extend `scripts/smoke_mcp_stdio.mjs` with 10-tool assertions and the per-tool tests above.
10. Update `docs/mcp-claude-desktop-setup.md` to list the new tools.

Approximate scope: ~10 tasks, similar to the prior plan.
