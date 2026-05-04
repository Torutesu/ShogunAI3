# SHOGUN Phase 2.0b — `sync_status` Column Design

**Status:** draft (2026-05-04) — awaiting user review
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.1 (Memory Layer ローカルスキーマ拡張)
**Predecessor:** Phase 2.0a — `2026-04-30-sensitive-filter-extensions-design.md` (PR #32)
**Successors:**
- Phase 2.0c — emergency capture stop tray UI (separate spec)
- Phase 2.0d — Memory export/import (separate spec)
- Phase 2.1 — Memory Mirror MVP (will use the columns introduced here)

---

## 1. Goal

Add the schema columns Memory Mirror needs to distinguish "stored locally only" from "ready/excluded from cloud sync", so that when Phase 2.1 ships the encryption boundary and sync engine, every row already carries the metadata required to make a sync decision per-item.

Specifically, add **two** columns to `mem_items`:

- `sync_status TEXT NOT NULL DEFAULT 'local_only'`
  Allowed values today: `'local_only' | 'excluded'`. (Phase 2.1 introduces `'pending_upload'` and `'synced'`.)
- `sync_excluded_reason TEXT`
  Nullable. Set only when `sync_status = 'excluded'`. Allowed values mirror `ExclusionReason` from `sensitive_filter.rs`: `'password_field' | 'app_blocklist' | 'url_blocklist' | 'payment_screen' | 'incognito_window' | 'time_block'`.

The two cloud-only columns from the master spec (`cloud_index_id UUID`, `encrypted_at TIMESTAMPTZ`) are **deferred to Phase 2.1**, where the cloud-id assignment and encryption operations actually occur. Adding them now would amount to dead schema.

## 2. Why this is its own phase

The Phase 2.0a filter (PR #32) currently treats payment / incognito / time-block hits as **drop-entirely** — the `continue` in the sampler loop means no `mem_items` row is ever created. That matches existing `app_blocklist` / `url_blocklist` semantics and is the safer default while there is no cloud sync.

When Phase 2.1 ships, users will want a third option: **store the row for local recall, but mark it `excluded` so the sync engine never uploads it**. That third option requires the schema column to exist *first* and be populated correctly on new ingests. Phase 2.0b's job is exactly that — schema + ingest path, no behavior change visible to the user yet.

After 2.0b lands, a follow-up (2.0c or 2.1.x) can flip selected exclusion reasons from "drop" to "store-but-mark-excluded" without another schema migration.

## 3. Scope (in / out)

**In scope:**
- SQLite migration: `ALTER TABLE mem_items ADD COLUMN sync_status …` + `ALTER TABLE mem_items ADD COLUMN sync_excluded_reason …`. Idempotent — guard against re-running on schemas that already have the column.
- `init_schema` (`memory_store.rs`) updated so fresh DBs include both columns from the `CREATE TABLE` form.
- `ingest()` writes `sync_status='local_only'` for the normal path. No filter integration — that stays in `capture_sampler.rs`'s drop-entirely flow.
- `kinds_json`-style readback: `mem_items` rows returned by `search()` / `fetch()` / `entities_from_catalog()` include `sync_status` (plus `sync_excluded_reason` when non-null) in the JSON output, so future UI / Mirror code can read it without schema queries.
- Unit tests for migration on (a) fresh DB, (b) pre-existing DB without the columns, (c) DB that already has the columns (re-run idempotency).

**Out of scope (deferred):**
- `cloud_index_id`, `encrypted_at` columns — Phase 2.1.
- Filter integration / "store-but-mark-excluded" mode — separate follow-up after 2.0b lands.
- UI to display "X captures excluded from cloud" — Phase 2.1 (Settings → Cloud Mirror panel).
- Bulk back-fill of `sync_excluded_reason` for old rows — pointless, the column starts NULL on every existing row by SQL default.

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Columns added | `sync_status` + `sync_excluded_reason` only | `cloud_index_id` / `encrypted_at` are populated by Phase 2.1; adding them now is dead schema. |
| D2 | 2.0a filter semantics | **Unchanged** — drop-entirely stays | Behavior parity. Storing-but-marking is a deliberate user-visible change deferred to a later phase. |
| D3 | SQLite migration form | `ALTER TABLE` with `NOT NULL DEFAULT 'local_only'` for `sync_status`; nullable for `sync_excluded_reason` | SQLite back-fills existing rows with the default in one statement. Nullable reason matches "no exclusion = NULL" semantics. |
| D4 | Reason string mapping | Reuse `ExclusionReason::serialize` (snake_case) | Single source of truth in `sensitive_filter.rs`; DB stores the same strings the Rust code already produces. |
| D5 | UI in 2.0b | None | Pure schema/API plumbing. UI lands when Mirror lands. |
| D6 | Test scopes | (a) fresh-DB schema, (b) ALTER on legacy DB, (c) idempotent re-run, (d) ingest writes default, (e) reason round-trip via JSON | Minimum to prove the column behaves correctly under all upgrade paths. |
| D7 | Naming | branch `feat/cloud-2-0b-sync-status`; spec `2026-05-04-sync-status-column-design.md`; plan `2026-05-04-sync-status-column.md` | Mirrors 2.0a's convention. |

## 5. Module Layout

### 5.1 `src-tauri/src/memory_store.rs` (modify, ~80 LOC delta)

Add three things:

1. **`init_schema` change**: extend the inline `CREATE TABLE IF NOT EXISTS mem_items (…)` to include the two new columns from the start. Fresh installs get them automatically.

2. **`migrate_sync_status_columns(conn)` helper**: idempotent ALTER TABLE for existing DBs. Uses `PRAGMA table_info(mem_items)` to detect whether the column already exists; skip the ALTER if so. Called from `init_schema` after the `CREATE TABLE` block.

3. **`ingest()` write path**: include `sync_status` in the INSERT statement. For now, the value is always the constant `'local_only'`. The `sync_excluded_reason` column stays NULL on this path. Filter-driven `'excluded'` writes are out of scope.

4. **`search()` / `fetch()` / `entities_from_catalog()` read path**: SELECT now includes `sync_status` and `sync_excluded_reason`. Output JSON gains `syncStatus` (camelCase, matching existing field naming) and conditionally `syncExcludedReason`. The serializer omits `syncExcludedReason` when NULL to keep JSON output stable for current consumers.

### 5.2 `src-tauri/src/sensitive_filter.rs` (no change)

The existing `ExclusionReason` enum already has the right serde rename. No new variants. No new functions. The filter's drop-entirely behavior is preserved.

### 5.3 No frontend / TypeScript / IPC changes

`hifi/lib/shogun-api.js` and `hifi/app.jsx`'s mock IPC simply pass JSON through. Adding `syncStatus` to the response payload is a forward-compatible addition — existing consumers ignore unknown fields. No spec / mock case changes needed.

## 6. Test Strategy

Unit tests in `memory_store.rs`'s test module (or a new `tests/sync_status.rs` integration file if it grows beyond ~5 cases).

| ID | Case | Setup | Assertion |
|----|------|-------|-----------|
| T1 | Fresh DB has columns | `init_schema` on empty DB | `PRAGMA table_info(mem_items)` includes `sync_status` (NOT NULL, default `'local_only'`) and `sync_excluded_reason` (nullable) |
| T2 | Legacy DB gets columns | Create `mem_items` without new columns, insert 5 rows, run `init_schema` | After: `PRAGMA table_info` shows both columns; existing 5 rows have `sync_status='local_only'`, `sync_excluded_reason IS NULL` |
| T3 | Idempotent re-run | Run `init_schema` twice in succession | No error; column count stable; data unchanged |
| T4 | Ingest writes default | Call `ingest()` with normal payload | Inserted row has `sync_status='local_only'`, reason NULL |
| T5 | Round-trip via JSON | Insert row, call `fetch()` | Output JSON has `syncStatus: "local_only"`; no `syncExcludedReason` key |
| T6 | Excluded round-trip | Direct INSERT with `sync_status='excluded'`, `sync_excluded_reason='payment_screen'` | `fetch()` output has `syncStatus: "excluded"`, `syncExcludedReason: "payment_screen"` |

T6 is preparatory for the future "store-but-mark-excluded" mode; it verifies the read path handles non-default values even though no production code writes them yet.

## 7. Risks and Mitigations

- **SQLite ALTER TABLE on a large `mem_items`**: `ALTER ADD COLUMN` is O(1) on SQLite (metadata-only) regardless of row count. No table rewrite. Safe even for users with months of capture history.
- **Mid-write crash during migration**: `init_schema` runs at startup before the sampler thread is spawned. If the process dies mid-ALTER, the next launch's idempotency check (D6/T3) re-runs cleanly. SQLite's WAL handles atomic commit of the ALTER itself.
- **JSON output changes leaking into snapshot tests**: the read-path JSON gains a new `syncStatus` key. Search snapshot tests in this repo (if any compare entire JSON blobs) need updating. Surveyed: `mem_items_fts` smoke + `search()` tests at `memory_store.rs:1830-1920` — none use `assert_eq!` on full JSON; all field-pick. Should be safe.
- **Forward compatibility with Phase 2.1**: when Mirror lands, the sync engine reads `sync_status`. The 2.0b column lets it run on day one without any schema migration of its own. `cloud_index_id` / `encrypted_at` get added by 2.1's migration when they're actually written.

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| Fresh install schema has both columns | T1 |
| Existing user upgrade path preserves all rows | T2 + manual smoke (start dev build over an existing `~/Library/Application Support/.../shogun.db`) |
| `ingest()` round-trips correctly | T4, T5 |
| Read path JSON exposes `syncStatus` to frontend | T5, T6 |
| `cargo test -p app` passes | full Rust suite |
| `npm run check:rust` passes | clippy + fmt |
| No frontend test breakage | `npm run test:e2e` (24/24 baseline) |

## 9. Open Questions for Reviewer

- Should T6 actually live in 2.0b, or is verifying the unused read-path branch premature? Defaulting to **yes, include T6** — it's 6 lines and pins the behavior so the next phase doesn't accidentally break the read shape.
- Is `'local_only'` the right default literal, or should it be `'pending'` to encourage Mirror to scan everything by default later? Defaulting to **`'local_only'`** — explicit and matches the master spec verbatim.

Both can be flipped at plan-review time without re-doing the design.
