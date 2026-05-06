# SHOGUN Phase 2.0d — Memory Export / Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `shogun_memory_export` / `shogun_memory_import` Tauri commands and Settings UI buttons so users have full memory data portability before any cloud feature ships.

**Architecture:** New `src-tauri/src/memory_export.rs` module owns the JSONL serialization and replace-mode import logic. Two new Tauri commands wrap it with `rfd` file dialogs. Settings UI gains an "Export memory…" / "Import memory…" pair under Privacy. The import path uses the existing typed-text-match confirmation modal pattern (REPLACE) before triggering a destructive replace.

**Tech Stack:** Rust (`rusqlite`, `rfd`, `serde_json`, `base64`), React 19 (existing modal + toast patterns), no new dependencies (`base64` may need to be added if not already present — check first; `rfd` is already used).

**Spec:** `docs/superpowers/specs/2026-05-04-memory-export-import-design.md`

**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 6 Phase 2.0 item 4

**Predecessors:** PR #32 (2.0a), PR #36 (2.0b). Independent of both technically.

---

## File Map

**Created:**
- `src-tauri/src/memory_export.rs` (~280 LOC) — `ExportHeader`, `MemItemRow`, `export_to_writer`, `import_from_reader`, `validate_header`, `row_to_json`, `json_to_row`, plus 10 unit tests (T1-T10)

**Modified:**
- `src-tauri/Cargo.toml` — verify `base64` dependency; add `base64 = "0.22"` if missing (~1 LOC)
- `src-tauri/src/lib.rs` — `mod memory_export;` + register `shogun_memory_export`, `shogun_memory_import` in `invoke_handler` (~3 LOC)
- `src-tauri/src/commands.rs` — add `shogun_memory_export` and `shogun_memory_import` Tauri command wrappers (~80 LOC)
- `hifi/lib/shogun-api.js` — add `memoryExport(input)` and `memoryImport(input)` API helpers (~6 LOC)
- `hifi/lib/action-registry.js` — register `memory.export` and `memory.import` actions (~4 LOC)
- `hifi/lib/ipc-client.js` — add mock cases for both commands (~12 LOC)
- `hifi/app.jsx` — mirror the mock cases in `mockIpcInvoke` to keep `check:ipc-mock` happy (~12 LOC)
- `hifi/settings-modal.jsx` — add "Memory data" sub-section under Privacy with two buttons + import-confirm modal wiring (~80 LOC)

**No changes:**
- `src-tauri/src/memory_store.rs` — no schema changes; export/import live in their own module
- `src-tauri/src/capture_sampler.rs` — unaffected

**Verification gates** (run after Task 5): `npm run check:rust` + `cargo test -p app` + `npm run check:actions` + `npm run check:ipc-mock` + `npm run test:e2e` (24 baseline) + manual smoke per spec § 8.

---

## Task 1: Create `memory_export.rs` with pure helpers + tests

**Files:**
- Create: `src-tauri/src/memory_export.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod memory_export;`)
- Modify: `src-tauri/Cargo.toml` (add `base64` if missing)

This task is platform-agnostic: the module + its full unit-test suite. Tauri command wiring is Task 2.

- [ ] **Step 1: Verify or add `base64`**

```bash
grep "^base64" src-tauri/Cargo.toml
```

If absent, add to `[dependencies]`: `base64 = "0.22"`. (As of writing, the project may already have it transitively; check first.)

- [ ] **Step 2: Create `memory_export.rs`**

```rust
//! Memory export / import. JSONL format with a header line, base64-encoded
//! embeddings, no settings (provider keys excluded by design).
//! See spec docs/superpowers/specs/2026-05-04-memory-export-import-design.md.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};

pub const FORMAT: &str = "shogun-memory-export";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportHeader {
  pub format: String,
  pub version: u32,
  pub exported_at: String,
  pub row_count: u64,
  pub schema_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemItemRow {
  pub id: String,
  pub title: String,
  pub snippet: String,
  pub source: String,
  pub kinds_json: String,
  pub created_at: i64,
  pub embedding: Option<Vec<u8>>,
  pub provenance: Option<String>,
  pub entity_id: Option<String>,
  pub confidence: Option<f64>,
  pub redaction: Option<String>,
  pub sync_status: String,
  pub sync_excluded_reason: Option<String>,
}

const SCHEMA_COLUMNS: &[&str] = &[
  "id", "title", "snippet", "source", "kinds_json", "created_at",
  "embedding", "provenance", "entity_id", "confidence", "redaction",
  "sync_status", "sync_excluded_reason",
];

// Pure helpers — testable on any platform.

pub fn validate_header(line: &str) -> Result<ExportHeader, String> {
  let h: ExportHeader = serde_json::from_str(line.trim())
    .map_err(|e| format!("header parse: {}", e))?;
  if h.format != FORMAT {
    return Err(format!("unknown format: {}", h.format));
  }
  if h.version != VERSION {
    return Err(format!("unsupported version: {}", h.version));
  }
  Ok(h)
}

pub fn row_to_json(row: &MemItemRow) -> Value { /* base64 the BLOB, snake-case keys */ }

pub fn json_to_row(v: &Value) -> Result<MemItemRow, String> { /* parse + base64 decode */ }

// I/O — exercised by smaller-bore tests via in-memory readers/writers.

pub fn export_to_writer<W: Write>(
  conn: &rusqlite::Connection,
  out: &mut W,
) -> Result<u64, String> {
  // SELECT all columns, count rows, write header line, then loop writing rows.
  // Use BufWriter externally if writing to a file.
}

pub fn import_from_reader<R: BufRead>(
  conn: &rusqlite::Connection,
  reader: R,
) -> Result<u64, String> {
  // Read first line → validate_header. Then begin transaction, DELETE all
  // mem_items, INSERT each parsed row. Commit. Return count.
}

#[cfg(test)]
mod tests {
  use super::*;
  use rusqlite::Connection;

  fn fresh_conn() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory");
    crate::memory_store::init_schema(&conn).expect("init_schema");
    conn
  }

  #[test] fn t1_export_header_well_formed() { /* … */ }
  #[test] fn t2_round_trip_preserves_data() { /* … */ }
  #[test] fn t3_import_replace_semantics() { /* … */ }
  #[test] fn t4_unknown_format_rejected() { /* … */ }
  #[test] fn t5_unsupported_version_rejected() { /* … */ }
  #[test] fn t6_malformed_row_rolls_back() { /* … */ }
  #[test] fn t7_import_requires_replace() { /* covered at IPC layer; here we test that the public function still works without a confirm string */ }
  #[test] fn t8_embedding_blob_round_trip() { /* … */ }
  #[test] fn t9_header_line_first() { /* … */ }
  #[test] fn t10_empty_db_exports_cleanly() { /* … */ }
}
```

- [ ] **Step 3: Wire into `lib.rs`**

Add `mod memory_export;` near other module declarations. Don't yet add to `invoke_handler`.

- [ ] **Step 4: `cargo test -p app memory_export`**

Expected: 10/10 tests pass. (T7 is light — it just verifies the public function doesn't panic without a confirm string; the real REPLACE check lives in the IPC wrapper, Task 2.)

---

## Task 2: Tauri commands + invoke_handler

**Files:**
- Modify: `src-tauri/src/commands.rs` (add `shogun_memory_export`, `shogun_memory_import`)
- Modify: `src-tauri/src/lib.rs` (register both commands)

- [ ] **Step 1: Add `shogun_memory_export`**

In `commands.rs`, near other `rfd::FileDialog`-using commands, add the export command (see spec § 5.2 for full body). Key points:
- Open save dialog with `set_file_name("memory.shogun-memory.jsonl")`
- Add filter `"SHOGUN Memory Export" / *.jsonl`
- If user cancels → return `{ "cancelled": true, "echo": payload }`
- On success → return `{ "exported": N, "path": "...", "echo": payload }`

- [ ] **Step 2: Add `shogun_memory_import`**

Same file, mirror the open-dialog pattern. Required: `payload.confirm == "REPLACE"`. If absent, return error `"import requires explicit REPLACE confirmation"` (T7 enforces this).

- [ ] **Step 3: Register both in `lib.rs`'s `invoke_handler`**

Add `commands::shogun_memory_export, commands::shogun_memory_import,` in alphabetical order alongside other commands.

- [ ] **Step 4: Compile**

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

Expected: clean.

---

## Task 3: Frontend wiring (API + action registry + IPC mocks)

**Files:**
- Modify: `hifi/lib/shogun-api.js` (add memoryExport, memoryImport)
- Modify: `hifi/lib/action-registry.js` (register `memory.export`, `memory.import`)
- Modify: `hifi/lib/ipc-client.js` (mock cases)
- Modify: `hifi/app.jsx` (mirror mock cases — `check:ipc-mock` enforces parity)

- [ ] **Step 1: API helpers**

In `shogun-api.js`, near other `memorySearch` / `memoryFetch` entries:

```js
memoryExport: (input) => call("shogun_memory_export", input, WRITE),
memoryImport: (input) => call("shogun_memory_import", input, WRITE),
```

Both are WRITE actions — the existing WRITE-action confirm flow won't fire for these because Settings explicitly bypasses it (or it does fire — verify by reading the existing button paths; both are acceptable as long as the confirmation is consistent).

- [ ] **Step 2: Register actions**

In `action-registry.js`, add:

```js
register("memory.export", (payload) => api.memoryExport(payload));
register("memory.import", (payload) => api.memoryImport(payload));
```

- [ ] **Step 3: Mock IPC cases (both files)**

In `hifi/lib/ipc-client.js`'s `mockTransport`:

```js
case "shogun_memory_export":
  return { exported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
case "shogun_memory_import":
  if ((echo && echo.confirm) !== "REPLACE") {
    throw createError("INVALID_INPUT", "import requires explicit REPLACE confirmation");
  }
  return { imported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
```

In `hifi/app.jsx::mockIpcInvoke`, mirror the same two cases (camelCase response keys consistent with surrounding code).

- [ ] **Step 4: Run gates**

```bash
npm run check:actions 2>&1 | tail -3
npm run check:ipc-mock 2>&1 | tail -3
```

Expected: both PASS.

---

## Task 4: Settings UI

**Files:**
- Modify: `hifi/settings-modal.jsx` (add Memory data sub-section under Privacy)

- [ ] **Step 1: Add the sub-section**

Inside `PanePrivacy`, after the existing privacy cards, add a new card:

```jsx
<div className="s-card">
  <div className="s-card-head">
    <div className="s-card-title">Memory data</div>
    <div className="s-card-sub">
      Export your memories to a file you control, or import a previously-exported file.
    </div>
  </div>
  <div className="s-card-body">
    <div className="row" style={{ gap: 8 }}>
      <button
        type="button"
        className="btn btn-primary"
        onClick={handleExport}
        disabled={busyExport}
      >
        {busyExport ? "Exporting…" : "Export memory…"}
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={handleImport}
        disabled={busyImport}
      >
        {busyImport ? "Importing…" : "Import memory…"}
      </button>
    </div>
  </div>
</div>
```

`handleExport` dispatches `memory.export`, awaits result, shows toast `"Exported N memories to <filename>"` (or `"Export cancelled"` if `cancelled`).

`handleImport` opens the existing typed-text confirmation modal (search for `useConfirmText` or a `RequireType` component already in `confirm-write-modal.jsx` / `settings-modal.jsx`; if no such helper exists, use a simple controlled-input modal). The modal requires the user to type "REPLACE" exactly. On confirm, dispatch `memory.import` with `{ confirm: "REPLACE" }`; show toast `"Imported N memories"`.

- [ ] **Step 2: Verify compile + visual**

```bash
npm run test:e2e -- hifi-smoke 2>&1 | grep -E "passed|failed" | tail -3
```

Expected: 24 pass (no regression). The new buttons are mockable but a deeper smoke verifies the click handlers don't crash.

---

## Task 5: Verification gates

- [ ] **Step 1: `npm run check:rust`**

```bash
npm run check:rust 2>&1 | tail -5
```

- [ ] **Step 2: `cargo test -p app`**

```bash
cd src-tauri && cargo test -p app 2>&1 | tail -5
```

Expected: existing 535 + 10 new memory_export tests = 545 pass.

- [ ] **Step 3: `npm run check:actions`**

```bash
npm run check:actions 2>&1 | tail -3
```

Expected: PASS (registry now includes `memory.export` and `memory.import`; action-map.md needs to mirror or it'll fail — update the doc accordingly).

- [ ] **Step 4: `npm run check:ipc-mock`**

```bash
npm run check:ipc-mock 2>&1 | tail -3
```

Expected: OK with 66 commands sync (was 64 + 2 new).

- [ ] **Step 5: `npm run test:e2e`**

```bash
npm run test:e2e 2>&1 | grep -E "passed|failed" | tail -3
```

Expected: 24 pass.

- [ ] **Step 6: Manual smoke**

1. Run `npm run tauri:dev`
2. Open Settings → Privacy → Memory data
3. Click "Export memory…" → save dialog → save → toast shows count → file appears on disk
4. Open the file in a text editor → first line is a JSON header with `format: "shogun-memory-export"`, `version: 1`, `row_count: <N>`
5. Click "Import memory…" → open dialog → select the just-exported file → confirmation modal → type REPLACE → confirm → toast shows count → SHOGUN window reloads memories
6. Verify the round-trip is lossless: spot-check a few memories appear unchanged after import

---

## Task 6: Commit + Draft PR

- [ ] **Step 1: Commit**

Either one cohesive commit or split:

```
feat(memory): Phase 2.0d — JSONL memory export / import

Implements the master spec § 6 Phase 2.0 item 4 ("Memory export/import
— ユーザーが自分のデータを完全に手元に持てる手段の保証"), the last of
the four 2.0 prerequisites. After this lands, Phase 2.1 (Memory
Mirror MVP) can start.

- New `memory_export` module: JSONL format with a header line and one
  base64-embedded mem_items row per line. Pure functions tested on
  any platform.
- New Tauri commands `shogun_memory_export` / `shogun_memory_import`
  wrap rfd file dialogs around the module. Replace-mode import only;
  requires explicit { confirm: "REPLACE" } payload.
- Settings → Privacy gains a Memory data card with Export / Import
  buttons. Import shows a typed-text-match modal ("type REPLACE")
  before triggering the destructive replace.
- Settings are deliberately NOT included in the export to avoid
  leaking provider API keys. Encryption is deferred to Phase 2.1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 2: Push + open Draft PR**

```bash
git push -u origin feat/cloud-2-0d-memory-export-import
gh pr create --draft --title "feat(memory): Phase 2.0d — JSONL memory export / import" --body "..."
```

PR body:
- Link the spec
- List the 10 unit tests + 6 manual smoke steps
- Acknowledge deferred items (merge mode, settings export, encryption, summaries)

---

## Acceptance Criteria (Spec Coverage Check)

| Spec criterion | Implemented in |
|----------------|----------------|
| Export writes parseable JSONL | Task 1 (export_to_writer) + T1, T9, T10 |
| Round-trip preserves data including BLOBs and NULLs | Task 1 + T2, T8 |
| Replace mode wipes pre-existing rows | Task 1 (import_from_reader) + T3 |
| Format / version validation | Task 1 (validate_header) + T4, T5 |
| Malformed file rolls back the transaction | Task 1 + T6 |
| Settings excluded from export | code review (no settings_store call in export path) |
| Import requires REPLACE confirm | Task 2 + T7 |
| Settings UI buttons functional | Task 4 + manual smoke |
| `cargo test -p app` green | Task 5 (Step 2) |
| All check:* gates green | Task 5 (Steps 1, 3, 4) |
| No E2E regression | Task 5 (Step 5) |

---

## Self-Review Notes

- The plan splits a destructive operation (replace-import) behind two layers of friction: the typed-text modal AND the IPC-level REPLACE check. Both are required because the IPC layer can be reached from outside the Settings UI (e.g., a future automation script) and the modal can be bypassed.
- **Honest limitation:** Manual smoke (Task 5 Step 6) is the only end-to-end test of the rfd file picker integration. Tauri's file dialog cannot be driven from headless tests today. Unit tests at Task 1 cover everything below the dialog layer.
- **Why JSONL over a SQLite file copy**: JSONL is human-readable, debuggable, scriptable with `jq`, and survives schema migrations cleanly. A `.db` file copy would be faster but ties the export to the exact internal SQLite schema. JSONL with explicit `schema_columns` in the header lets future imports translate column changes.
- **Why no merge mode in 2.0d**: merge raises hard questions (same `id` collision, FTS rebuild, `entity_id` deduplication ordering, partial-import recovery). All of those deserve a separate brainstorm. Replace mode covers the dominant use case (move to a new machine).
- **Settings exclusion is load-bearing**: this is the entire safety reason 2.0d is shippable as plain JSON. If the user demands "export everything", the right path is a separate, encrypted, opt-in flow — not silently expanding the scope here.
