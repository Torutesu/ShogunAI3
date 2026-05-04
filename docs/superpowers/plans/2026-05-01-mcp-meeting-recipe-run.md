# `shogun.meeting_recipe_run` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the previously-deferred `shogun.meeting_recipe_run` MCP tool by routing it through an async branch in `bin/shogun_mcp.rs::call_tool`, so external MCP clients can run any of the 6 builtin LLM recipes against a meeting. Final advertised tool count goes from 10 to 11.

**Architecture:** The binary's `call_tool` is already `async`; one async tool is handled at the binary boundary instead of asyncifying `mcp_server::dispatch`. Match arm at the top of `call_tool` on `request.name == "shogun.meeting_recipe_run"` invokes `meeting_recipes::run_recipe(args).await` directly and returns; everything else continues through the existing sync `mcp_server::dispatch` path. `mcp_server` is unchanged.

**Tech Stack:** Existing `rmcp 0.8.5` stdio server · existing `meeting_recipes::run_recipe` async function (calls a remote LLM) · `serde_json` for payload serialization. No new dependencies.

---

## File Structure

**Modify:**
- `src-tauri/src/lib.rs` — flip `mod meeting_recipes;` (line 33) to `pub mod meeting_recipes;` so the binary can import via `use app_lib::meeting_recipes;`. Same precedent as the public `meeting_mcp` / `memory_mcp` / `kioku_mcp` modules.
- `src-tauri/src/meeting_mcp.rs` — replace the existing thin `recipe_run` entry in `tool_definitions()` with a richer version (enum on `recipe_id`, cost/latency note, per-recipe purpose, `meeting_id` description).
- `src-tauri/src/bin/shogun_mcp.rs` — extend `use app_lib::{...}` to add `meeting_recipes`; add async branch at the top of `call_tool` for `shogun.meeting_recipe_run`; delete the `meeting_recipe_run` filter line in `list_tools` (currently line 61).
- `scripts/smoke_mcp_stdio.mjs` — bump expected tool count from 10 to 11; add `shogun.meeting_recipe_run` to the `EXPECTED_TOOLS` set; add 3 error-path frames.
- `docs/mcp-claude-desktop-setup.md` — move `shogun.meeting_recipe_run` from "Not available" to "Available" with a one-line cost-and-latency note.

**Do not touch:**
- `src-tauri/src/meeting_recipes.rs` — the async function we call. Its arg validation is the source of all the error strings the smoke test asserts on.
- `src-tauri/src/mcp_server/` — recipe_run never reaches `dispatch`. Existing 25 unit tests must stay green.
- `src-tauri/src/memory_mcp.rs`, `src-tauri/src/kioku_mcp.rs` — neither involves recipe_run.

---

### Task 1: Promote `meeting_recipes` to `pub mod`

Single one-line edit to `lib.rs` so `bin/shogun_mcp.rs` can `use app_lib::meeting_recipes;` in Task 3. Done first because Task 3's import won't compile otherwise.

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Read the line you're changing**

Run: `grep -n "^pub mod meeting_recipes;\|^mod meeting_recipes;" /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/src/lib.rs`
Expected: one line, `33:mod meeting_recipes;`. If it's already `pub mod`, this task is already complete — skip to Step 4.

- [ ] **Step 2: Flip the visibility**

In `src-tauri/src/lib.rs`, change line 33 from:

```rust
mod meeting_recipes;
```

to:

```rust
pub mod meeting_recipes;
```

No other line is touched.

- [ ] **Step 3: Verify the change**

Run: `grep -n "meeting_recipes" /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/src/lib.rs`
Expected: line 33 now reads `pub mod meeting_recipes;`. The other matches (in `commands::register_handler!` blocks) are unrelated.

- [ ] **Step 4: Build and run tests**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --locked --lib mcp_server::`
Expected: `test result: ok. 25 passed; 0 failed`. The visibility flip is not behavior-affecting; existing tests stay green.

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --bin shogun-mcp --locked`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run add src-tauri/src/lib.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run commit -m "refactor(mcp): make meeting_recipes module pub for binary import"
```

---

### Task 2: Strengthen the `meeting_recipe_run` descriptor

Replace the existing thin descriptor with a richer version that enumerates the 6 canonical recipe IDs, surfaces cost/latency in the description, and documents per-recipe purpose. The descriptor lives in `meeting_mcp.rs`'s `tool_definitions()` — currently filtered out from `list_tools`, so updating it here doesn't yet surface a new tool to clients (Task 3 removes the filter).

**Files:**
- Modify: `src-tauri/src/meeting_mcp.rs`

- [ ] **Step 1: Read the existing descriptor**

Run: `cat /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/src/meeting_mcp.rs`
You should see 6 tool entries; the last one is `shogun.meeting_recipe_run` with a thin schema:

```rust
{
  "name": "shogun.meeting_recipe_run",
  "description": "Run a builtin recipe (LLM) on a meeting.",
  "input_schema": {
    "type": "object",
    "properties": {
      "recipe_id": { "type": "string" },
      "meeting_id": { "type": "string" }
    },
    "required": ["recipe_id", "meeting_id"]
  }
}
```

- [ ] **Step 2: Replace it with the richer version**

In `src-tauri/src/meeting_mcp.rs`, replace the entire `shogun.meeting_recipe_run` JSON object (within the `json!([...])` array) with:

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

The aliases handled by `resolve_recipe_id` (`coach`, `follow_up`, `actions`, etc.) are intentionally NOT in the JSON-Schema `enum` — they're for the Tauri UI's free-text input, not MCP.

- [ ] **Step 3: Build and run unit tests**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --locked --lib`
Expected: all tests pass. There is no descriptor-shape unit test — this is a JSON change, not a code change.

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --bin shogun-mcp --locked`
Expected: success. The binary still filters `meeting_recipe_run` out of `list_tools` (filter removed in Task 3), so external clients see no change yet.

- [ ] **Step 4: Spot-check the change**

Run: `grep -n "rec-coach-me\|enum.*rec-" /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/src/meeting_mcp.rs | head -5`
Expected: at least one line containing `rec-coach-me`. Confirms the new descriptor landed.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run add src-tauri/src/meeting_mcp.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run commit -m "feat(mcp): strengthen meeting_recipe_run descriptor"
```

---

### Task 3: Wire async branch in `bin/shogun_mcp.rs`

Three edits to the binary, all in one commit: add the `meeting_recipes` import, add the async branch at the top of `call_tool`, and delete the filter line in `list_tools`. After this commit, `shogun-mcp` advertises 11 tools and routes the new one correctly.

**Files:**
- Modify: `src-tauri/src/bin/shogun_mcp.rs`

- [ ] **Step 1: Extend the import line**

In `src-tauri/src/bin/shogun_mcp.rs`, line 6 currently reads:

```rust
use app_lib::{kioku_mcp, mcp_server, meeting_mcp, memory_mcp};
```

Replace with (alphabetical sort):

```rust
use app_lib::{kioku_mcp, mcp_server, meeting_mcp, meeting_recipes, memory_mcp};
```

- [ ] **Step 2: Remove the `list_tools` filter line**

In the same file, find the filter line (currently at line 61):

```rust
            // Skip meeting_recipe_run for this MVP — async + LLM-dependent.
            .filter(|t: &Value| t.get("name").and_then(|n| n.as_str()) != Some("shogun.meeting_recipe_run"))
```

Delete BOTH lines (the comment and the `.filter(...)` call). The result: `arr.into_iter()` chains directly into `.filter_map(|t: Value| { ... })`.

- [ ] **Step 3: Add the async branch in `call_tool`**

In `call_tool`, after the `let args = ...` block (currently lines 86–89) and BEFORE the `match mcp_server::dispatch(...)` (line 90), insert:

```rust
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

```

The blank line at the end matters — it visually separates the async branch from the existing sync `match`.

- [ ] **Step 4: Build the binary**

Run: `cargo build --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --bin shogun-mcp --locked`
Expected: success. Pre-existing warnings unrelated to this change are acceptable.

If the build fails:
- "cannot find module `meeting_recipes`" → Task 1 wasn't done, or `lib.rs` is wrong.
- "expected one of `,`, `}`" in the import block → check the comma between `meeting_mcp,` and `meeting_recipes`.
- "unexpected `return`" or similar control-flow error → check that the async branch is inside `call_tool`, not at module scope.

- [ ] **Step 5: Run the existing unit-test suite**

Run: `cargo test --manifest-path /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/src-tauri/Cargo.toml --locked --lib mcp_server::`
Expected: `test result: ok. 25 passed; 0 failed`. recipe_run never reaches `mcp_server::dispatch`, so the existing tests cover the unchanged sync path.

- [ ] **Step 6: Quick stdio sanity check (no LLM call)**

Run a manual stdio handshake to confirm `tools/list` now returns 11:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' ; sleep 1 ) | ./src-tauri/target/debug/shogun-mcp 2>/dev/null | grep -o '"name":"shogun\.[^"]*"' | sort -u | wc -l
```

Expected: `11`. (You may also see this number reported as 11 by the Task 4 smoke test.) If you see 10, the filter wasn't removed; if you see <10, an earlier descriptor module was broken.

- [ ] **Step 7: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run add src-tauri/src/bin/shogun_mcp.rs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run commit -m "feat(mcp): wire async branch for meeting_recipe_run"
```

---

### Task 4: Extend the stdio smoke test

Update `scripts/smoke_mcp_stdio.mjs`: bump expected tool count from 10 to 11, add the new tool name to the expected set, and add 3 error-path frames. Happy-path testing is intentionally skipped (LLM cost + API key dependency).

**Files:**
- Modify: `scripts/smoke_mcp_stdio.mjs`

- [ ] **Step 1: Read the existing smoke test**

Run: `cat /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/scripts/smoke_mcp_stdio.mjs | head -60`
Look for: the `EXPECTED_TOOLS` constant (or equivalent — may be a `Set` or array) and the assertion that compares the returned tool count to 10. Note the harness shape (likely a `sendCall` helper plus per-frame assertions).

- [ ] **Step 2: Update tool count and name set**

Find the line that asserts `tools.length === 10` (or `tools.size === 10`, or similar). Change `10` to `11`.

Find the `EXPECTED_TOOLS` set. Add `"shogun.meeting_recipe_run"` to it. Match the existing style (Set vs array, single vs double quotes).

- [ ] **Step 3: Add 3 error-path frames**

Append the following frames after the existing `kioku_related` frames (or wherever the existing meeting/memory/kioku frames are grouped — match the existing harness pattern):

```js
// Frame: meeting_recipe_run with missing meeting_id
await sendCall("shogun.meeting_recipe_run", { recipe_id: "rec-coach-me" });
// Expected: isError true; content[0].text contains "meeting_id"

// Frame: meeting_recipe_run with unknown recipe_id
await sendCall("shogun.meeting_recipe_run", { recipe_id: "nonexistent", meeting_id: "x" });
// Expected: isError true; content[0].text contains "unknown recipe_id"

// Frame: meeting_recipe_run with empty args
await sendCall("shogun.meeting_recipe_run", {});
// Expected: isError true; content[0].text contains either "recipe_id" or "meeting_id"
```

`sendCall` is the existing helper — reuse it. Match the existing assertion style; if other frames use a `expectError(/regex/)` helper or compare specific substrings, do the same.

The error strings come from `meeting_recipes::run_recipe` itself:
- Missing `meeting_id` → `"meeting_id is required"` (line 53 of meeting_recipes.rs).
- Missing or unknown `recipe_id` (including empty string) → `"unknown recipe_id"` (line 54).

Empty-args case is interesting because `meeting_id` is checked with `?` BEFORE `recipe_id`'s resolution, so the error message will be `"meeting_id is required"` even though both are missing. The test asserts containment of either substring to be robust.

- [ ] **Step 4: Run the smoke test against a built binary**

Run:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run
cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp --locked
SHOGUN_MCP_BIN=$(pwd)/src-tauri/target/debug/shogun-mcp node scripts/smoke_mcp_stdio.mjs
```

Expected: all assertions pass, including the 3 new frames. The harness should report 11 tools in `tools/list` and `is_error: true` for each of the 3 new frames with the expected error substrings.

If a frame reports `is_error: false` unexpectedly:
- It means `meeting_recipes::run_recipe` accepted the input and tried to call the LLM. Capture the response and the binary's stderr (`2> /tmp/shogun-mcp-stderr.log`) for diagnosis.
- Most likely cause: a typo in the test args — e.g., `recipe_id: "rec-coach-me"` IS a valid recipe and `meeting_id: ""` would proceed to the LLM call. Check that the test args match the spec.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run add scripts/smoke_mcp_stdio.mjs
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run commit -m "test(mcp): cover meeting_recipe_run error paths in stdio smoke"
```

---

### Task 5: Update Claude Desktop setup doc

Move `shogun.meeting_recipe_run` from "Not available" to "Available" with a one-line cost-and-latency note.

**Files:**
- Modify: `docs/mcp-claude-desktop-setup.md`

- [ ] **Step 1: Read the current doc**

Run: `cat /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/docs/mcp-claude-desktop-setup.md`
Look for: the "Available now (read-only):" section (with grouped Meeting / Memory / Kioku tools) and the "Not available:" section (which currently includes `shogun.meeting_recipe_run`).

- [ ] **Step 2: Update the "Available" list**

In the "Meeting tools:" subsection of "Available now", append a new bullet AFTER the existing 5 meeting bullets:

```markdown
- `shogun.meeting_recipe_run` — run a builtin LLM recipe on a meeting (coach-me, follow-up-email, action-items, feature-digest, prd-draft, decision-log). **Calls a remote LLM — costs API budget + adds several seconds of latency per call.**
```

The bold cost-and-latency note is the user-visible signal that this tool is different from the read-only ones. The 6 recipe slugs are listed inline so a setup-doc reader sees them without having to query `tools/list`.

Also adjust the section header from `**Available now (read-only):**` to `**Available now:**` (drop the "(read-only)" qualifier since `meeting_recipe_run` is read-meeting-then-LLM-roundtrip, not strictly read-only). Or keep the header and add a separate "Recipe tools (LLM):" subsection — pick whichever reads better in context. Default: drop "(read-only)" from the header and keep the recipe tool in the Meeting subsection.

- [ ] **Step 3: Update the "Not available" list**

In the "Not available:" section, find and delete the bullet:

```markdown
- `shogun.meeting_recipe_run` — async + LLM-dependent, deferred to a follow-up.
```

The remaining "Not available" bullet (memory/kioku as separate plan) was already removed in the prior plan — confirm only `meeting_recipe_run` is being deleted here.

- [ ] **Step 4: Sanity-check the rendered doc**

Run: `grep -c "shogun\." /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/docs/mcp-claude-desktop-setup.md`
Expected: 11 occurrences (10 existing + 1 new). If it's still 10, the new bullet didn't land. If it's 12, the old "Not available" bullet wasn't removed.

Run: `grep -n "Not available" /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run/docs/mcp-claude-desktop-setup.md`
Expected: 1 line. The "Not available" section may now be empty or contain only out-of-scope notes (memory/kioku separate-plan bullet was already removed in the prior round). If the section is empty after this task, leave the header in place — it documents the deliberate decision to expose only specific tools.

- [ ] **Step 5: Commit**

```bash
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run add docs/mcp-claude-desktop-setup.md
git -C /Users/torutano/ShogunAI3/ShogunAI3/.worktrees/mcp-meeting-recipe-run commit -m "docs(mcp): mark meeting_recipe_run available with cost/latency note"
```

---

## Self-Review Notes

**Spec coverage:** 5 tasks cover the 4 spec sections cleanly:
- Spec "Tool Catalogue Change" (descriptor) → Task 2.
- Spec "Architecture / `bin/shogun_mcp.rs` changes" → Task 3.
- Spec "Architecture / `lib.rs` change" → Task 1.
- Spec "Testing / Smoke test extensions" → Task 4.
- Spec "Documentation update" → Task 5.

The plan adds Task 1 as a separate commit (vs lumping it into Task 3) because the visibility flip is logically distinct from the binary changes and isolates a likely failure point — the import in Task 3 won't compile if Task 1 didn't land. Cheaper to bisect.

**Placeholder scan:** every step has either complete code, an exact path, or an exact command with expected output. Task 4 Step 3 has the softest spot — it says "Match the existing style; if other frames use a `expectError(/regex/)` helper or compare specific substrings, do the same." This is load-bearing because the smoke test's harness shape wasn't fully captured here; the implementer reads the file to match the existing pattern. Preferable to inventing a parallel harness.

**Type consistency:** the descriptor enum in Task 2, the recipe_id resolver in `meeting_recipes.rs`, and the smoke test's error-path arg payloads all use `rec-coach-me` (canonical form). No naming drift across tasks.
