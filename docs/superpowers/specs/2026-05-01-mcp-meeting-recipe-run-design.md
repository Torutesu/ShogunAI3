# `shogun.meeting_recipe_run` MCP Tool — Design

## Goal

Wire the previously-deferred `shogun.meeting_recipe_run` MCP tool so external clients (Claude Desktop, etc.) can run any of the 6 builtin LLM recipes against a meeting and get the rendered output back. After this round, `shogun-mcp` advertises **11 tools total** (10 read-only + 1 LLM).

## Use Case

The 6 recipes operate over a meeting's transcript ± notes ± related memory hits and produce text outputs:

- `rec-coach-me` — 1:1 coaching feedback
- `rec-follow-up-email` — drafts a recap email
- `rec-action-items` — extracts TODOs with owners + due dates
- `rec-feature-digest` — pulls product implications
- `rec-prd-draft` — drafts a PRD section
- `rec-decision-log` — records decisions + rationale

The Tauri UI already exposes these via `shogun_meeting_recipe_run`. This round simply lets MCP clients invoke the same flow. Claude Desktop becomes another front-end for "summarize my meeting from the kitchen with this recipe."

## Architectural Decision: Async at the Binary Boundary (Approach C)

`meeting_recipes::run_recipe` is an `async fn` (it calls a remote LLM). The current `mcp_server::dispatch` is sync. Three options were considered:

- **A. Make `dispatch` async** — uniform interface, but every existing handler (10 sync) becomes `async fn` and every test (24) becomes `#[tokio::test]`. Heavy churn for one async tool.
- **B. Parallel `dispatch_async`** — middle ground; introduces a second top-level entry point that's only used for one tool. Awkward.
- **C. Special-case in the binary** ⭐ — `bin/shogun_mcp.rs::call_tool` is already `async`. It checks the tool name and routes `meeting_recipe_run` directly to `meeting_recipes::run_recipe(args).await`, bypassing `mcp_server::dispatch` entirely.

**Choice: C.** The binary already lives at the protocol-async ⇄ handler-sync boundary; one async tool is naturally handled there. `mcp_server` stays unchanged. Zero test churn for existing handlers. If async tools grow to 3+, the team revisits Approach A.

## Tool Catalogue Change

Single tool added:

### `shogun.meeting_recipe_run`

| Field | Type | Required | Notes |
|---|---|---|---|
| `recipe_id` | string (enum) | yes | One of: `rec-coach-me`, `rec-follow-up-email`, `rec-action-items`, `rec-feature-digest`, `rec-prd-draft`, `rec-decision-log`. Aliases (`coach`, `follow_up`, etc.) are kept inside `resolve_recipe_id` for the Tauri UI's free-text input but NOT advertised via MCP — canonical IDs only. |
| `meeting_id` | string | yes | From `shogun.meetings_list` or `shogun.meetings_search`. |

**Backing call:** `meeting_recipes::run_recipe(&args).await` — direct pass-through.

**Output:** raw `Value` from `run_recipe` (already shaped as `{rendered, recipe_id, meeting_id, ...}`), JSON-stringified into `Content::text`. No `mcp_server::content_text` wrapper because the binary handles this branch directly.

**Error paths (all bubble up from `run_recipe` as `is_error: true`):**
- Missing `meeting_id` — `"meeting_id is required"`.
- Missing/unknown `recipe_id` — `"unknown recipe_id"` (the empty string falls through `resolve_recipe_id`).
- LLM API key not configured — error from the LLM call layer.
- Network / API failure — error from the LLM call layer.

**Cost / latency disclosure:** the tool's `description` field explicitly states "Calls a remote LLM (uses configured API keys; costs billed to the user). Latency typically several seconds." — so an MCP client like Claude Desktop has signal to surface a confirmation prompt before the first call.

## Architecture

### `bin/shogun_mcp.rs` changes

Two surgical edits to the existing binary:

**1. Imports** — add `meeting_recipes` to the `use app_lib::{...}` line (alphabetical sort):

```rust
use app_lib::{kioku_mcp, mcp_server, meeting_mcp, meeting_recipes, memory_mcp};
```

`meeting_recipes` is currently `mod meeting_recipes;` (private) in `lib.rs`. Visibility flip to `pub mod meeting_recipes;` is required — same precedent as `meeting_mcp` / `memory_mcp` / `kioku_mcp` already-public modules.

**2. `call_tool` async branch** — at the top of the method body, before the existing `match mcp_server::dispatch(...)`:

```rust
let args = request
    .arguments
    .map(Value::Object)
    .unwrap_or(Value::Object(Default::default()));

// Async branch: meeting_recipe_run runs an LLM, must be awaited.
if request.name == "shogun.meeting_recipe_run" {
    return Ok(match meeting_recipes::run_recipe(&args).await {
        Ok(payload) => CallToolResult::success(vec![Content::text(
            serde_json::to_string(&payload)
                .unwrap_or_else(|e| format!("serialize error: {e}")),
        )]),
        Err(msg) => CallToolResult::error(vec![Content::text(msg)]),
    });
}

// Sync branch (unchanged): everything else goes through mcp_server::dispatch.
match mcp_server::dispatch(&request.name, &args) {
    /* existing body */
}
```

**3. `list_tools` filter removal** — delete the line:

```rust
.filter(|t: &Value| t.get("name").and_then(|n| n.as_str()) != Some("shogun.meeting_recipe_run"))
```

After this, `tools/list` returns 11 tools.

### `meeting_mcp.rs` change

Replace the existing thin `recipe_run` entry in `tool_definitions()` with the richer version:

```rust
{
    "name": "shogun.meeting_recipe_run",
    "description": "Run a builtin LLM recipe on a meeting and return the rendered output. Recipes operate over the meeting's transcript ± notes ± related memory hits depending on the recipe. Calls a remote LLM (uses configured API keys; costs billed to the user). Latency typically several seconds.",
    "input_schema": {
        "type": "object",
        "properties": {
            "recipe_id": {
                "type": "string",
                "enum": ["rec-coach-me", "rec-follow-up-email", "rec-action-items", "rec-feature-digest", "rec-prd-draft", "rec-decision-log"],
                "description": "Which recipe to run. coach-me: 1:1 coaching feedback. follow-up-email: drafts a recap email. action-items: extracts TODOs with owners + due dates. feature-digest: pulls product implications. prd-draft: drafts a PRD section. decision-log: records decisions + rationale."
            },
            "meeting_id": {
                "type": "string",
                "description": "Meeting ID (from shogun.meetings_list or shogun.meetings_search)."
            }
        },
        "required": ["recipe_id", "meeting_id"]
    }
}
```

The aliases handled by `resolve_recipe_id` (e.g. `"coach"` → `RecipeId::CoachMe`) are intentionally NOT in the JSON-Schema `enum`. They exist for the Tauri UI's free-text input; MCP clients should use canonical IDs.

### `lib.rs` change

One line: `mod meeting_recipes;` → `pub mod meeting_recipes;`. Required because `bin/shogun_mcp.rs` imports the module via `use app_lib::meeting_recipes;`.

## Testing

### Unit tests

**None added.** The binary's new branch is a pure routing decision; the validation logic lives entirely in `meeting_recipes::run_recipe` (existing module, not in scope for this round). `mcp_server::tests` is unaffected — recipe_run never reaches `dispatch`.

### Smoke test extensions

`scripts/smoke_mcp_stdio.mjs`:

1. Bump expected tool count from 10 → 11. Add `shogun.meeting_recipe_run` to the `EXPECTED_TOOLS` set.
2. Add 3 error-path frames:

```js
// Frame: missing meeting_id
await sendCall("shogun.meeting_recipe_run", { recipe_id: "rec-coach-me" });
// Expected: isError true; content[0].text contains "meeting_id"

// Frame: unknown recipe_id
await sendCall("shogun.meeting_recipe_run", { recipe_id: "nonexistent", meeting_id: "x" });
// Expected: isError true; content[0].text contains "unknown recipe_id"

// Frame: empty args
await sendCall("shogun.meeting_recipe_run", {});
// Expected: isError true; content[0].text contains either "recipe_id" or "meeting_id"
```

Happy-path testing (actual LLM call) is **not** in the smoke test:
- Requires configured API keys (the test environment may not have them).
- Costs money on every CI run.
- Adds multi-second latency to a fast smoke test.
- Manual verification via Claude Desktop is the cheaper path for happy-path validation.

### Documentation update

`docs/mcp-claude-desktop-setup.md`:

- Move `shogun.meeting_recipe_run` from "Not available" → "Available" (under a new "Recipe tools (LLM)" subsection or appended to "Meeting tools").
- Add a one-line cost-and-latency note: "Note: `shogun.meeting_recipe_run` calls a remote LLM, which incurs API cost and takes several seconds per call."
- Remove the `meeting_recipe_run — async + LLM-dependent, deferred to a follow-up.` bullet from "Not available."

## Out of Scope

- **Streaming responses.** rmcp supports streamed tool results, but recipe outputs are typically <2 KB and one-shot returns are simpler. Add streaming if a recipe's payload ever exceeds a comfortable single-message size; not now.
- **Recipe alias support over MCP.** `coach`, `follow_up`, `actions`, etc. are kept in `resolve_recipe_id` for the Tauri UI but not advertised in the JSON Schema enum. Canonical-IDs-only is cleaner for an external surface.
- **New recipes.** The 6 recipes are the existing set; no new ones added.
- **Cost guardrails / confirmation.** The Tauri UI calls `run_recipe` without a confirmation step; MCP doing the same is consistent. The descriptor's cost-and-latency description is the only hint surfaced to clients.
- **Async-ifying `mcp_server::dispatch`.** Approach A is deferred until 3+ async tools exist.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `meeting_recipes::run_recipe` signature changes between writing this spec and the implementation | Plan-writing step re-reads the function and locks the call shape. |
| Some other module already does `use app_lib::meeting_recipes` and the `pub mod` change conflicts | Check during plan-writing. The prior `pub mod meeting_mcp` flip in the previous round didn't conflict; same pattern. |
| `Content::text` payload too large (e.g., very long PRD draft) | Acceptable as long as it fits in a single MCP message. If a real user hits a size limit, follow-up plan introduces streaming. |
| `serde_json::to_string` of `run_recipe` output fails | Handled — fall back to `format!("serialize error: {e}")` inside the `unwrap_or_else`. The error reaches the client as plain text rather than crashing. |
| `meeting_recipe_run` filter accidentally re-introduced by a future edit to `list_tools` | The filter line is being deliberately deleted, not commented out. Re-introduction would require a deliberate edit. |

## Plan Hand-off

After spec approval, the implementation plan is generated by `superpowers:writing-plans` in this same worktree (`feat/mcp-meeting-recipe-run`). Expected task layout (4 tasks, small):

1. Update `meeting_mcp.rs` descriptor for `recipe_run` (richer description + enum on `recipe_id` + arg descriptions).
2. Wire async branch in `bin/shogun_mcp.rs` (`pub mod meeting_recipes` in lib.rs + import + match arm + filter removal).
3. Extend `scripts/smoke_mcp_stdio.mjs` (count 10→11, add 3 error-path frames).
4. Update `docs/mcp-claude-desktop-setup.md` (move recipe_run to "Available" + cost note).

Smaller than prior rounds because there's no new module structure or shared helper to introduce.
