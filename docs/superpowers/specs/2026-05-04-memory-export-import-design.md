# SHOGUN Phase 2.0d — Memory Export / Import Design

**Status:** draft (2026-05-04) — awaiting user review
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 6 Phase 2.0 item 4 ("Memory export/import — ユーザーが自分のデータを完全に手元に持てる手段の保証")
**Predecessor phases:** 2.0a (#32), 2.0b (#36), 2.0c (separate plan)
**Successors:** Phase 2.1 (Memory Mirror MVP)

---

## 1. Goal

Give users full data portability **before** any cloud sync feature ships:

1. **Export** — write the entire local memory database to a single file the user picks (native Save dialog), in a format readable without SHOGUN
2. **Import** — load such a file back into a fresh DB, replacing any existing memories

This is the master spec's core promise — *"ユーザーが自分のデータを完全に手元に持てる手段の保証"* — and it's a prerequisite for cloud features. A user who can't get their data out has no real choice when they decide to leave or change machines.

## 2. Why this is its own phase

Each prior 2.0 phase removed a barrier to safely shipping cloud features:
- 2.0a strengthened the privacy filter (don't capture sensitive things)
- 2.0b added the schema column to track which rows are excluded from cloud sync
- 2.0c added the menu-bar tray (one-click stop)
- **2.0d adds the escape hatch** — even if cloud goes wrong, you can take your memories with you.

After 2.0d ships, all four 2.0 prerequisites are complete and 2.1 (Memory Mirror MVP) can start.

## 3. Scope (in / out)

**In scope:**

- New Tauri commands `shogun_memory_export(payload)` and `shogun_memory_import(payload)` — both writes (require the user to confirm via existing WRITE-action confirm flow)
- Native macOS file picker via `rfd` (already a dependency, used in 5 existing commands)
- Export format: JSON Lines (`.jsonl`, one row per line) — first line is a metadata header, subsequent lines are individual `mem_items` rows
- Import: **replace mode only** — wipes existing `mem_items` (and FTS), repopulates from the file. The user must confirm via a typed-text-match modal ("type REPLACE to confirm") because this is destructive.
- Frontend: two buttons in `Settings → Privacy → Memory data`:
  - "Export memory…" — opens save dialog, writes file, shows count toast
  - "Import memory…" — opens open dialog, shows confirmation modal with file row count, executes on confirm
- Mock IPC support: in browser preview, both commands return `{ ok: true, stub: true, ... }` so the Settings UI is testable without Tauri

**Out of scope (deferred):**

- **Merge import** — combining an imported file with existing memories. Conflict resolution (same `id` collision, FTS rebuild, `entity_id` deduplication) is non-trivial and a separate phase (2.0d.1).
- `mem_summaries`, `mem_clusters`, `kioku_*` tables — exported only in a later phase. 2.0d covers the source-of-truth `mem_items` table.
- `settings.json` — deliberately excluded. Settings contain provider API keys, private webhook URLs, integration tokens, etc. The user can copy their settings file manually if they want; bundling it into "memory export" is a footgun.
- Encryption of the export file — the encryption boundary is 2.1 (Memory Mirror). Plain JSON makes 2.0d trivial to inspect / debug, and the user can encrypt the resulting file themselves with any tool. Future cloud-aware export may add an encrypted variant.
- Streaming / chunked export for huge databases — JSON Lines is naturally streamable; the implementation reads/writes line-at-a-time. No special chunking logic needed for 2.0d's row counts.
- Progress bar / cancel during export — both operations are bounded by disk I/O on the local SQLite file, fast enough that a single toast at the end is sufficient for the row counts SHOGUN sees today.

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Export format | JSON Lines (`.jsonl`) — header line + one row per line | Streamable, human-readable, SQLite-independent. Other tools (jq, Python, Node) can read it directly. |
| D2 | `embedding` BLOB representation | base64-encoded string in the JSON | Lossless, text-only, decoder-friendly. `embedding` may be NULL for older rows; round-trips correctly. |
| D3 | Tables included | `mem_items` only | MVP. Other tables can be rebuilt from `mem_items` (FTS index) or are derived (`mem_summaries`). |
| D4 | Settings included | **No** | Provider API keys are in settings; bundling them risks accidental sharing. Settings have their own user-managed backup path (the file is on disk). |
| D5 | Import semantics | Replace mode only | Merge requires conflict resolution that's a separate design problem. 2.0d.1 can add a merge mode if users ask. |
| D6 | Header line schema | `{"format":"shogun-memory-export","version":1,"exported_at":"<ISO 8601>","row_count":N,"schema_columns":[…]}` | Forward-compatible: import refuses unknown `format` or `version` ranges; `schema_columns` lets future imports know which columns to expect. |
| D7 | UI placement | `Settings → Privacy → Memory data` (new sub-section) with two buttons | Privacy pane already exists; this is logically privacy-adjacent (data ownership). |
| D8 | Progress display | Export: silent then toast on completion. Import: confirmation modal showing row count, then toast on completion | Bounded operations; no need for progress bar at SHOGUN's row counts. |
| D9 | File extension | `.shogun-memory.jsonl` | Self-describing: `jsonl` extension is recognized by editors / tools, `shogun-memory` prefix scopes it. |
| D10 | Encryption | None — plain JSON | Defer to 2.1 (Memory Mirror) which owns the encryption boundary. Plain export is debuggable + tool-friendly. |
| D11 | Replace-confirm UX | Typed-text confirmation modal: "Type REPLACE to confirm" + cancel button | Same pattern as the existing data-controls "delete last hour" flow. Destructive operation, deserves friction. |
| D12 | Naming | spec `2026-05-04-memory-export-import-design.md`; plan `2026-05-04-memory-export-import.md`; branch `feat/cloud-2-0d-memory-export-import` | Mirrors 2.0a/2.0b/2.0c convention. |
| D13 | Tauri command names | `shogun_memory_export`, `shogun_memory_import` (snake_case, matches existing IPC naming) | Frontend dispatches via existing runtime action registry. |

## 5. Module Layout

### 5.1 `src-tauri/src/memory_export.rs` (new, ~280 LOC)

Owns the export/import logic. Pure where possible:

```rust
//! Memory export / import. JSONL format with a header line, base64-encoded
//! embeddings, no settings (provider keys excluded by design).
//! See spec docs/superpowers/specs/2026-05-04-memory-export-import-design.md.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

/// Stream all `mem_items` rows to the writer in JSONL form (header + one
/// row per line). Returns the number of rows written.
pub fn export_to_writer<W: std::io::Write>(
  conn: &rusqlite::Connection,
  out: &mut W,
) -> Result<u64, String>;

/// Read JSONL from the reader, validate the header, and replace `mem_items`.
/// Returns the number of rows imported. Wraps in a transaction so a partial
/// import is rolled back on error.
pub fn import_from_reader<R: std::io::BufRead>(
  conn: &rusqlite::Connection,
  reader: R,
) -> Result<u64, String>;

// Pure helpers — testable on any platform.
pub fn validate_header(line: &str) -> Result<ExportHeader, String>;
pub fn row_to_json(row: &MemItemRow) -> Value;
pub fn json_to_row(v: &Value) -> Result<MemItemRow, String>;
```

### 5.2 `src-tauri/src/commands.rs` (modify, ~80 LOC)

Two new Tauri commands wrapping `memory_export.rs`:

```rust
#[tauri::command]
pub fn shogun_memory_export(payload: Value) -> Result<Value, String> {
  let path = rfd::FileDialog::new()
    .set_file_name("memory.shogun-memory.jsonl")
    .add_filter("SHOGUN Memory Export", &["jsonl"])
    .save_file();
  let Some(path) = path else { return Ok(json!({ "cancelled": true, "echo": payload })); };
  let conn = memory_store::open_conn()?;
  let mut out = std::fs::File::create(&path).map_err(|e| e.to_string())?;
  let n = memory_export::export_to_writer(&conn, &mut out)?;
  Ok(json!({
    "exported": n,
    "path": path.to_string_lossy(),
    "echo": payload,
  }))
}

#[tauri::command]
pub fn shogun_memory_import(payload: Value) -> Result<Value, String> {
  // payload includes { "confirm": "REPLACE" } from the frontend modal.
  let confirm = payload.get("confirm").and_then(|v| v.as_str()).unwrap_or("");
  if confirm != "REPLACE" {
    return Err("import requires explicit REPLACE confirmation".into());
  }
  let path = rfd::FileDialog::new()
    .add_filter("SHOGUN Memory Export", &["jsonl"])
    .pick_file();
  let Some(path) = path else { return Ok(json!({ "cancelled": true, "echo": payload })); };
  let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
  let reader = std::io::BufReader::new(file);
  let conn = memory_store::open_conn()?;
  let n = memory_export::import_from_reader(&conn, reader)?;
  Ok(json!({
    "imported": n,
    "path": path.to_string_lossy(),
    "echo": payload,
  }))
}
```

### 5.3 `src-tauri/src/lib.rs` (modify, ~3 LOC)

Add `mod memory_export;` and register the two commands in `invoke_handler`.

### 5.4 `hifi/lib/shogun-api.js` and `hifi/lib/action-registry.js` (modify, ~10 LOC)

Add `memoryExport: …`, `memoryImport: …` API helpers and register `memory.export` / `memory.import` runtime actions.

### 5.5 `hifi/settings-modal.jsx` (modify, ~80 LOC)

Add a new card under Privacy:

- "Memory data" header
- Description: "Export your memories to a file you control, or import a previously-exported file."
- Two buttons: **Export memory…** and **Import memory…**
- Export button: dispatch `memory.export` action; on success, show toast "Exported N memories to <filename>"
- Import button: open existing typed-text-match confirmation modal ("Type REPLACE to confirm. This will delete all existing memories."), then dispatch `memory.import` with `{ confirm: "REPLACE" }`; on success, show toast "Imported N memories"

### 5.6 IPC mocks (`hifi/lib/ipc-client.js` + `hifi/app.jsx::mockIpcInvoke`)

Add `shogun_memory_export` and `shogun_memory_import` cases returning `{ ok: true, data: { exported: 0, stub: true, ... } }` / `{ ok: true, data: { imported: 0, stub: true, ... } }`. The Settings UI buttons stay clickable in browser preview / E2E for visual smoke; no real file I/O happens.

## 6. Test Strategy

| ID | Case | Setup | Assertion |
|----|------|-------|-----------|
| T1 | Export header is well-formed | Insert 3 rows, call `export_to_writer`, parse first line | `format == "shogun-memory-export"`, `version == 1`, `row_count == 3`, `schema_columns` matches expected list |
| T2 | Round-trip preserves data | Insert N rows with various combinations of NULLs (embedding NULL, entity_id present, sync_status='excluded'), export then import to a fresh DB | All rows exist with identical column values |
| T3 | Replace semantics | Pre-populate with 2 rows, import a file with 5 rows | After import: `SELECT COUNT(*) FROM mem_items` returns 5 (the original 2 are gone) |
| T4 | Validation: unknown format | Construct header with `format: "wrong"`, attempt import | Returns error containing "format" / "unknown" |
| T5 | Validation: unsupported version | Construct header with `version: 99`, attempt import | Returns error containing "version" |
| T6 | Validation: malformed line | Header valid, second line is `{not-json}` | Returns error; transaction rolled back; original DB intact |
| T7 | Import requires REPLACE confirm | Call `shogun_memory_import` IPC with `{}` (no confirm) | Returns error "requires explicit REPLACE confirmation" |
| T8 | Embedding base64 round-trip | Row with non-trivial `embedding` BLOB, export then import | After import: `embedding` BLOB matches the original byte-for-byte |
| T9 | Header line written before rows | Capture output bytes, verify first byte sequence is `{"format":` | Header is line 1, rows start line 2+ |
| T10 | Empty DB exports cleanly | Export from empty `mem_items` | Header line + zero data lines; `row_count: 0` |

T1-T10 are unit tests in `memory_export.rs::tests`. The IPC commands themselves (file picker integration) are smoked manually:

- **Manual smoke 1**: Click "Export memory…" → file picker opens → save → toast shows correct count → file exists on disk → file's first line is a valid header
- **Manual smoke 2**: Click "Import memory…" → confirm modal → type REPLACE → file picker → import → toast shows count → DB reflects the file

## 7. Risks and Mitigations

- **Replace mode wipes user data on misclick**: mitigated by typed-text confirmation modal (D11) — user must literally type "REPLACE". Cancel preserves DB.
- **Mid-import crash leaves DB half-written**: import wraps the row-write loop in a single `unchecked_transaction`. Any error during read or write rolls back. The user's DB remains the pre-import state.
- **Provider key leaks via export**: settings excluded by design (D4). Exported files contain only memory data — no API keys, no webhook URLs, no integration tokens.
- **Format drift between versions**: header includes `version: 1`. Future code refuses unknown versions with a clear error. Future export readers can ship as a separate `2026-XX-memory-import-v2` migration when the format changes.
- **Huge databases**: JSON Lines is line-streamable. The implementation uses `BufReader` / `Write` line-at-a-time so a 1M-row export works in O(rows) memory. Manual smoke targets typical SHOGUN row counts; users with massive DBs can verify themselves.
- **Encoding issues**: All strings are UTF-8. JSON serialization handles escaping. Embedding BLOBs base64-encoded. No locale-dependent number formatting (numbers are emitted via `serde_json` which uses `.` as decimal separator).

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| Export writes a parseable JSONL file | T1, T9, T10 + manual |
| Round-trip preserves all column data including NULLs and BLOBs | T2, T8 |
| Replace mode wipes pre-existing rows | T3 |
| Format / version validation rejects bad files | T4, T5 |
| Malformed file rolls back the transaction | T6 |
| Settings are NOT included in the export | code review (no settings_store call in export path) |
| Import without REPLACE confirm fails | T7 |
| Settings UI buttons trigger the flows | manual smoke 1, 2 |
| `cargo test -p app` green | full Rust suite |
| `npm run check:rust` / `check:actions` / `check:ipc-mock` green | gates |

## 9. Open Questions for Reviewer

- **Replace-only vs offer merge as a follow-up**: 2.0d ships replace mode only. If users immediately ask for "merge into existing", we'll do 2.0d.1. Defaulting to replace-only because (a) merge has hard conflict-resolution questions, and (b) the primary use case (move to a new machine) is a clean replace.
- **Should the import dialog show a preview** (first row, total count) before confirming? Defaulting to **NO** for 2.0d — the typed-text modal is enough friction. A preview pane is ~50 LOC of UI work that adds value but isn't essential.
- **Should export include a SHA256 checksum** alongside the file? Defaulting to **NO** for 2.0d — the user can compute one themselves; bundling it doesn't add cryptographic guarantees without a signing key.

All three can be revisited at plan-review without re-doing the design.
