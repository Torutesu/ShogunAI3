# SHOGUN Phase 2.0b — `sync_status` Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sync_status` and `sync_excluded_reason` columns to `mem_items` so future Phase 2.1 (Memory Mirror) can decide per-row whether to upload, with no behavior change for current users.

**Architecture:** Schema migration in `memory_store::init_schema` (idempotent ALTER for legacy DBs, inline column for fresh installs). Ingest path writes the default `'local_only'`. Read path emits `syncStatus` (and optionally `syncExcludedReason`) in the JSON output. No frontend changes; no filter integration. The Phase 2.0a `sensitive_filter` keeps its drop-entirely semantics.

**Tech Stack:** Rust, SQLite (rusqlite), `serde_json::Value`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-04-sync-status-column-design.md`

**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.1

**Predecessor:** PR #32 (Phase 2.0a — sensitive filter extensions). 2.0b assumes `ExclusionReason` and `serde(rename_all = "snake_case")` from `sensitive_filter.rs` are in place.

---

## File Map

**Modified:**
- `src-tauri/src/memory_store.rs` (~80 LOC delta) — extended `init_schema`, new `migrate_sync_status_columns` helper, `ingest()` insert column list, `search()` / `fetch()` / `entities_from_catalog()` SELECT + JSON serialization.

**No changes:**
- `src-tauri/src/sensitive_filter.rs` — preserved as-is.
- `src-tauri/src/capture_sampler.rs` — drop-entirely behavior preserved.
- `src-tauri/Cargo.toml` — no new deps.
- Frontend (`hifi/`) — JSON output adds a forward-compatible field; existing consumers ignore it.
- IPC mock (`hifi/lib/ipc-client.js` + `hifi/app.jsx::mockIpcInvoke`) — no changes; the mock returns the same shape it always did. The new field appears only on the Rust path.

**Verification gates** (run after Task 6): `npm run check:rust` + `cargo test -p app` + `npm run test:e2e` (24/24 baseline).

---

## Task 1: Extend fresh-DB `CREATE TABLE` and add migration helper

**Files:**
- Modify: `src-tauri/src/memory_store.rs` (around line 346 — `init_schema`)

This task gives fresh installs the new columns from the start, and adds (but does not yet wire) the idempotent ALTER helper for legacy DBs. Wiring is Task 2.

- [ ] **Step 1: Extend the inline `CREATE TABLE IF NOT EXISTS mem_items` block**

In `init_schema`, locate:

```rust
CREATE TABLE IF NOT EXISTS mem_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  source TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Replace with:

```rust
CREATE TABLE IF NOT EXISTS mem_items (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  snippet TEXT NOT NULL,
  source TEXT NOT NULL,
  kinds_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'local_only',
  sync_excluded_reason TEXT
);
```

Note: `IF NOT EXISTS` means existing DBs are not affected by this change — they need the migration helper from Step 2.

- [ ] **Step 2: Add `migrate_sync_status_columns(conn)` helper**

Above `init_schema`, add:

```rust
/// Idempotent migration: add `sync_status` / `sync_excluded_reason` columns
/// to `mem_items` if they don't yet exist. Safe to call on any schema
/// version, including those that already have the columns. Uses
/// `PRAGMA table_info` so we don't need a separate version table.
fn migrate_sync_status_columns(conn: &Connection) -> Result<(), String> {
  let mut stmt = conn
    .prepare("PRAGMA table_info(mem_items)")
    .map_err(|e| e.to_string())?;
  let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
  let mut has_status = false;
  let mut has_reason = false;
  while let Some(row) = rows.next().map_err(|e| e.to_string())? {
    let name: String = row.get(1).map_err(|e| e.to_string())?;
    if name == "sync_status" { has_status = true; }
    if name == "sync_excluded_reason" { has_reason = true; }
  }
  drop(rows);
  drop(stmt);

  if !has_status {
    conn
      .execute(
        "ALTER TABLE mem_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only'",
        [],
      )
      .map_err(|e| e.to_string())?;
  }
  if !has_reason {
    conn
      .execute(
        "ALTER TABLE mem_items ADD COLUMN sync_excluded_reason TEXT",
        [],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}
```

- [ ] **Step 3: Call the helper from `init_schema` after the `CREATE TABLE` block**

After the existing `execute_batch` for `mem_items` + `mem_items_fts`, before the trigger creation, insert:

```rust
migrate_sync_status_columns(conn)?;
```

This ordering matters: we want the columns present *before* any subsequent code (including the FTS triggers, which don't reference the new columns but might be inspected during debugging) runs.

- [ ] **Step 4: Verify compile**

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

Expected: clean compile (existing 20 warnings unchanged).

---

## Task 2: Update `ingest()` to write `sync_status` default

**Files:**
- Modify: `src-tauri/src/memory_store.rs::ingest` (around line 876)

- [ ] **Step 1: Locate the INSERT statement**

Inside `ingest()` find the `INSERT INTO mem_items (...) VALUES (...)` SQL. It currently lists 6 columns: `id, title, snippet, source, kinds_json, created_at`.

- [ ] **Step 2: Add `sync_status` to the column list**

Append `, sync_status` to the column list and `, ?7` (or whichever `?N` matches) to the VALUES list. Bind the literal `"local_only"` in the parameter slot.

`sync_excluded_reason` is **NOT** added to the INSERT — it stays NULL by default for the normal ingest path. The future filter integration that flips this to `'excluded'` is out of scope for 2.0b.

- [ ] **Step 3: Add a unit test (T4 from spec)**

In the existing `#[cfg(test)] mod tests { ... }` block in `memory_store.rs`, add:

```rust
#[test]
fn ingest_writes_sync_status_default() {
  let dir = tempfile::tempdir().unwrap();
  // Use the existing test harness pattern from neighboring tests.
  // After ingest_with_dir(...), open a fresh connection and SELECT.
  // Assert: sync_status == "local_only", sync_excluded_reason IS NULL.
}
```

Match the harness style of existing tests in this file (look at `ingest_*` tests; copy whichever pattern they use to set `MEM_DIR` / `Connection`).

---

## Task 3: Update read path to surface `syncStatus` in JSON

**Files:**
- Modify: `src-tauri/src/memory_store.rs::search` (around line 992)
- Modify: `src-tauri/src/memory_store.rs::fetch` (around line 1261)
- Modify: `src-tauri/src/memory_store.rs::entities_from_catalog` (around line 1506)

The output of these functions is `serde_json::Value` consumed by the runtime / frontend. We add a `syncStatus` field always, and `syncExcludedReason` only when non-null.

- [ ] **Step 1: Identify the row → JSON helper(s)**

These functions likely share a row-to-JSON conversion (look for `json!({...})` or a `row_to_json` helper). Update **once** at the shared point if possible; otherwise apply to all three call sites.

- [ ] **Step 2: SELECT new columns**

Each function's `SELECT` needs `sync_status, sync_excluded_reason` appended. Adjust the index of subsequent `row.get(N)` calls accordingly — these are positional.

- [ ] **Step 3: JSON projection**

Inside the row-to-JSON conversion, append:

```rust
let sync_status: String = row.get("sync_status_idx").unwrap_or("local_only".to_string());
let sync_excluded_reason: Option<String> = row.get("sync_excluded_reason_idx").ok();

let mut obj = json!({
  // existing fields…
  "syncStatus": sync_status,
});
if let Some(reason) = sync_excluded_reason {
  obj["syncExcludedReason"] = json!(reason);
}
```

(Use the actual indices / column names from the surrounding code; the snippet shows shape.)

- [ ] **Step 4: Add round-trip tests (T5, T6 from spec)**

```rust
#[test]
fn fetch_includes_sync_status_in_json() {
  // Ingest a normal row, fetch by id, assert: data["syncStatus"] == "local_only",
  // and data does NOT have a "syncExcludedReason" key.
}

#[test]
fn fetch_excluded_row_includes_reason() {
  // Direct INSERT with sync_status='excluded', sync_excluded_reason='payment_screen',
  // then fetch. Assert: syncStatus="excluded", syncExcludedReason="payment_screen".
}
```

T6 ensures the future "store-but-mark-excluded" mode reads correctly even though no production code writes it yet.

---

## Task 4: Migration tests on legacy DBs (T2, T3 from spec)

**Files:**
- Modify: `src-tauri/src/memory_store.rs` test module (or new `tests/sync_status_migration.rs` if it exceeds ~3 cases)

- [ ] **Step 1: Test legacy DB (T2)**

Build a `mem_items` table without the new columns by hand (raw `CREATE TABLE` + INSERT a few rows), then call `init_schema`. Assert:
- `PRAGMA table_info(mem_items)` reports both new columns present.
- The pre-existing rows survived: `SELECT COUNT(*) FROM mem_items` matches.
- Pre-existing rows have `sync_status='local_only'` (the default), `sync_excluded_reason IS NULL`.

- [ ] **Step 2: Test idempotent re-run (T3)**

After Step 1's setup, call `init_schema` a *second* time. Assert no error and column count unchanged.

- [ ] **Step 3: Test fresh DB (T1)**

Open a brand-new connection, call `init_schema`, query `PRAGMA table_info(mem_items)`. Assert both columns present from the start.

---

## Task 5: Final verification gates

- [ ] **Step 1: `npm run check:rust`**

```bash
npm run check:rust 2>&1 | tail -10
```

Expected: clippy clean, rustfmt clean.

- [ ] **Step 2: `cargo test -p app`**

```bash
cd src-tauri && cargo test -p app 2>&1 | tail -10
```

Expected: all existing tests + the 5 new tests (T1-T5; T6 is in Task 3) pass.

- [ ] **Step 3: `npm run test:e2e`**

```bash
npm run test:e2e 2>&1 | grep -E "passed|failed" | tail -3
```

Expected: 24 passed (no regression from baseline — frontend untouched).

- [ ] **Step 4: Manual smoke on existing dev DB**

```bash
# In dev mode, point at an existing user DB if available, or run cold.
npm run tauri:dev
# Capture a memory, then SELECT from mem_items in a separate sqlite3 shell:
# sqlite3 "<path>/shogun.db" "SELECT id, sync_status, sync_excluded_reason FROM mem_items LIMIT 5"
# Expected: every row has sync_status='local_only', reason NULL.
```

---

## Task 6: Commit + Draft PR

- [ ] **Step 1: Commit on `feat/cloud-2-0b-sync-status`**

Single commit (or split into Task 1 / 2-3 / 4 if review prefers granular):

```
feat(cloud-mirror): Phase 2.0b — sync_status schema column

Add `sync_status` and `sync_excluded_reason` columns to `mem_items` so
Phase 2.1 (Memory Mirror) has per-row metadata to decide what to upload.

- Idempotent migration covers fresh installs and existing user DBs
- ingest() writes the default 'local_only'
- read path (search/fetch/entities) surfaces syncStatus in JSON output
- 6 unit tests cover schema, ingest, and read round-trip

No behavior change for users today: 2.0a's drop-entirely filter is
preserved. The "store-but-mark-excluded" mode lands when 2.1 ships.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 2: Push and open Draft PR**

```bash
git push -u origin feat/cloud-2-0b-sync-status
gh pr create --draft --title "feat(cloud-mirror): Phase 2.0b — sync_status schema column" \
  --body "<see template below>"
```

PR body should:
- Link the spec doc
- List the 6 columns / 6 tests
- Note "depends on / sequenced after #32 (2.0a)"
- Include the 4-step verification checklist as `## Test plan`

---

## Acceptance Criteria (Spec Coverage Check)

| Spec criterion | Implemented in |
|----------------|----------------|
| Fresh install schema has both columns | Task 1 (Step 1) + T1 |
| Legacy DB upgrade path preserves rows | Task 1 (Step 2) + T2 |
| Idempotent re-run of `init_schema` | Task 1 (Step 2) + T3 |
| `ingest()` writes `'local_only'` default | Task 2 + T4 |
| Read path JSON exposes `syncStatus` | Task 3 + T5 |
| Read path handles `'excluded'` correctly | Task 3 + T6 |
| `cargo test -p app` green | Task 5 (Step 2) |
| `npm run check:rust` green | Task 5 (Step 1) |
| No E2E regression | Task 5 (Step 3) |
| Manual smoke on existing dev DB | Task 5 (Step 4) |

---

## Self-Review Notes

- The plan is **deliberately small**. Phase 2.0b is plumbing; the visible behavior change comes when 2.1 (Memory Mirror) lands and writes `'pending_upload'` / `'synced'`. Resist the urge to bundle in the filter integration ("store-but-mark-excluded") — that is its own user-visible decision and deserves a separate phase / brainstorm.
- The migration helper uses `PRAGMA table_info` rather than a `schema_version` table because no such table exists today and adding one is outsized for a 2-column addition. If the project picks up a real migration framework later, this helper folds into it cleanly.
- **Honest limitation:** Task 5 Step 4 (manual smoke on a real existing DB) cannot be scripted from CI; it needs a human running on a Mac with an existing capture history. The plan flags this rather than pretending automated coverage replaces it.
