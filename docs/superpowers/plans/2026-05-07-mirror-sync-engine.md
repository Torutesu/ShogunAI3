# SHOGUN Phase 2.1.2 — Mirror Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement the Mac-side sync engine per the Phase 2.1.2 design. Encrypts `mem_items` rows, uploads to a Mirror server endpoint per the protocol RFC, tracks state via two new schema columns, exposes 5 IPC commands.

**Architecture:**
- New `src-tauri/src/mirror/sync.rs` (~400 LOC) — SyncEngine, queue, scheduler, state machine
- New `src-tauri/src/mirror/http.rs` (~250 LOC) — HTTP client wrapping `reqwest`
- Schema migration in `memory_store.rs`: add `cloud_index_id`, `encrypted_at`
- 5 new Tauri commands in `commands.rs`
- Frontend mock + action registry scaffolding

**Tech Stack:** Rust (`reqwest`, `tokio`, existing crypto primitives from 2.1.0). No new deps for the Mac client (`reqwest` is already in deps for OAuth integration in master).

**Spec:** `docs/superpowers/specs/2026-05-07-mirror-sync-engine-design.md`
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Protocol RFC:** `docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md`

**Predecessors:** Phase 2.1.0 (encryption primitives, merged on main), Phase 2.1.1 (RFC, in review #48). The implementation depends on the RFC being locked but can start once Q1-Q4 resolve (which they have, 2026-05-07).

---

## File Map

**Created:**
- `src-tauri/src/mirror/sync.rs` (~400 LOC) — SyncEngine + scheduler + state machine + helpers + ~20 unit tests
- `src-tauri/src/mirror/http.rs` (~250 LOC) — Client + Error taxonomy + ~10 integration tests against `mockito`

**Modified:**
- `src-tauri/src/mirror/mod.rs` — add `sync` and `http` submodules
- `src-tauri/src/memory_store.rs` — `migrate_mirror_columns(conn)` helper called from `init_schema`; `row_to_item` extended to include `cloudIndexId` and `encryptedAt` JSON keys when non-null
- `src-tauri/src/commands.rs` — 5 new Tauri commands (`mirror_register`, `mirror_unlock`, `mirror_status`, `mirror_sync_now`, `mirror_disable`)
- `src-tauri/src/lib.rs` — register the 5 commands in `invoke_handler`; spawn the scheduler in the `setup` callback after `capture_sampler::start_background_sampler`
- `hifi/lib/shogun-api.js` — `mirror.{register,unlock,status,syncNow,disable}` API helpers
- `hifi/lib/action-registry.js` — register 5 runtime actions
- `hifi/lib/ipc-client.js` + `hifi/app.jsx::mockIpcInvoke` — mock cases for the 5 commands (`stub: true` returns)
- `hifi/action-map.md` — add 5 new entries

**No changes:**
- `src-tauri/src/mirror/crypto.rs` (Phase 2.1.0 — consumed as-is)
- `src-tauri/src/mirror/keychain.rs` (consumed as-is)
- `src-tauri/Cargo.toml` (no new deps; `reqwest` and `tokio` are already present)

**Verification gates** (Task 7): `cargo test --lib mirror` (~30 new) + `cargo test --lib` (full) + `npm run check:rust` + `npm run check:actions` + `npm run check:ipc-mock` + `npm run test:e2e` (30 baseline pass).

---

## Task 1: Schema migration + memory_store.rs read path

**Files:**
- Modify: `src-tauri/src/memory_store.rs`

- [ ] **Step 1: Add `migrate_mirror_columns(conn)` helper**

Mirror Phase 2.0b's `migrate_sync_status_columns` pattern: use `PRAGMA table_info(mem_items)` to detect which columns exist and `ALTER TABLE` only the missing ones. Add `cloud_index_id TEXT` (nullable, server-assigned blob_id) and `encrypted_at INTEGER` (nullable, Unix ms when uploaded).

- [ ] **Step 2: Call migration from `init_schema`**

Add `migrate_mirror_columns(conn)?;` after the existing `migrate_sync_status_columns` call.

- [ ] **Step 3: Extend `row_to_item` to surface the new columns**

The function takes positional `Option<String>` args. Add 2 more for `cloud_index_id` and `encrypted_at`. JSON output gains `cloudIndexId` (when non-null) and `encryptedAt` (when non-null). Apply consistently to all 4 SELECT call sites.

(Issue #43 tracks refactoring `row_to_item` to a struct, which would simplify this. If #43 has been completed by the time this lands, follow the struct pattern. Otherwise, mechanical positional addition.)

- [ ] **Step 4: Add unit tests**

T1: fresh DB has both new columns (NOT NULL? — both nullable per design). T2: legacy DB migration adds columns, existing rows have NULL values. T3: idempotent re-run. T4: round-trip via `fetch()` shows `cloudIndexId` only when populated.

- [ ] **Step 5: Verify**

```bash
cd src-tauri && cargo test --lib memory_store 2>&1 | grep "^test result"
```

Expected: existing 27 + 4 new = 31 pass.

---

## Task 2: HTTP client (`mirror/http.rs`)

**Files:**
- Create: `src-tauri/src/mirror/http.rs`
- Modify: `src-tauri/src/mirror/mod.rs` (add `pub(crate) mod http;`)

- [ ] **Step 1: Define error taxonomy**

```rust
#[derive(Debug, thiserror::Error)]
pub(crate) enum Error {
  #[error("network: {0}")]
  Network(String),
  #[error("server error: {0}")]
  ServerError(u16),
  #[error("unauthorized")]
  Unauthorized,
  #[error("rate limited; retry after {0:?}")]
  RateLimited(std::time::Duration),
  #[error("payload too large")]
  PayloadTooLarge,
  #[error("invalid envelope: {0}")]
  InvalidEnvelope(String),
  #[error("conflict: {0}")]
  Conflict(String),
  #[error("not found")]
  NotFound,
  #[error("gone")]
  Gone,
  #[error("unknown: {0}")]
  Unknown(String),
}
```

`thiserror` is already in deps. The taxonomy maps directly to RFC § 5.4 error envelope codes.

- [ ] **Step 2: Define request/response types**

`BlobEnvelope` matching RFC § 4.1 exactly. Use `serde` with `#[serde(rename_all = "snake_case")]` for the wire mapping. Include `serialize_with` / `deserialize_with` for the base64 nonce/data fields.

`ListBlobsResponse`, `UploadResponse`, `DeviceRegistration`, `HealthResponse`, etc.

- [ ] **Step 3: Build the `Client` struct**

Wraps `reqwest::Client` + `base_url` + `device_token`. Each public method (`upload_blob`, `list_blobs_cursor`, `list_blobs_time_range`, `fetch_blob`, `tombstone`, `register_device`, `rename_device`, `delete_device`, `health`) returns `Result<T, Error>`.

The `Authorization: Bearer <device_token>` header is set in a constructor closure on `reqwest::Client::default_headers`. `register_device` is the only method that doesn't carry the bearer (it acquires the token).

- [ ] **Step 4: Status code → `Error` mapping**

```rust
fn status_to_error(status: reqwest::StatusCode, body: &str) -> Error {
  match status.as_u16() {
    400 => Error::InvalidEnvelope(body.into()),
    401 => Error::Unauthorized,
    404 => Error::NotFound,
    409 => Error::Conflict(body.into()),
    410 => Error::Gone,
    413 => Error::PayloadTooLarge,
    429 => {
      // Parse Retry-After header
      let dur = std::time::Duration::from_secs(/* TODO */);
      Error::RateLimited(dur)
    }
    500..=599 => Error::ServerError(status.as_u16()),
    _ => Error::Unknown(format!("status {}", status)),
  }
}
```

- [ ] **Step 5: Integration tests against `mockito`**

`mockito` is already in dev-deps. Each test starts a mock server, configures responses, drives `Client` against it.

- I1: `register_device` — mock 201 with `device_id` + `device_token` → assertions
- I2: `upload_blob` happy path
- I3: `upload_blob` 409 → `Error::Conflict`
- I4: `upload_blob` 413 → `Error::PayloadTooLarge`
- I5: `upload_blob` 429 with Retry-After: 60 → `Error::RateLimited(60s)`
- I6: `upload_blob` 500 → `Error::ServerError(500)`
- I7: `list_blobs_cursor` happy path with pagination
- I8: `fetch_blob` 410 → `Error::Gone`
- I9: `fetch_blob` 404 → `Error::NotFound`
- I10: `health` — no auth, returns version

- [ ] **Step 6: Verify compile**

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

---

## Task 3: SyncEngine + state machine (`mirror/sync.rs`)

**Files:**
- Create: `src-tauri/src/mirror/sync.rs`
- Modify: `src-tauri/src/mirror/mod.rs` (add `pub(crate) mod sync;`)

- [ ] **Step 1: Define core types**

```rust
pub(crate) struct SyncEngine {
  master_key: parking_lot::Mutex<Option<crypto::MasterKey>>,
  stats: parking_lot::Mutex<SyncStats>,
  client: parking_lot::Mutex<Option<http::Client>>,
}

pub(crate) struct SyncStats {
  pub queue_depth: u64,
  pub last_sync_at: Option<i64>,
  pub last_error: Option<String>,
  pub synced_total: u64,
  pub locked: bool,  // true when master_key is None
}
```

(Use `parking_lot::Mutex` since the existing project already uses `std::sync::Mutex`; pick whichever convention is local. `parking_lot` is fine if added; `std` works too.)

- [ ] **Step 2: Implement `unlock()` / `lock()` / `stats()`**

`unlock(passphrase)`:
1. Load salt from keychain (`mirror::keychain::ensure_salt`)
2. Derive Master Key via `crypto::derive_master_key`
3. Verify against keychain-stored Master Key (load + compare bytes)
4. Cache in `master_key` mutex
5. Update `stats.locked = false`

`lock()`: clear `master_key` mutex, set `stats.locked = true`. Note: this is mid-process — does NOT delete the keychain entry. That's `mirror_disable`'s job.

`stats()`: clone `SyncStats`.

- [ ] **Step 3: Pure helpers (testable)**

```rust
fn select_pending_rows(conn: &Connection, batch_size: usize) -> Result<Vec<MemItemRow>, String>;
fn build_blob_envelope(row: &MemItemRow, mek: &MEK, device_id: &str) -> Result<BlobEnvelope, String>;
fn classify_error_for_retry(err: &http::Error) -> RetryDisposition;
fn apply_allowlist(row: &MemItemRow, settings: &Value) -> bool;
```

`build_blob_envelope` constructs the RFC § 4.1 wire shape. Plaintext metadata is the whitelist from RFC § 4.2 (kinds, provenance, captured_at_minute). AEAD AD is the canonical JSON of `{version, blob_id, device_id, schema, metadata}` per RFC § 4.3.

`classify_error_for_retry` returns:
- `Permanent` for 400/409/410/413/Unauthorized
- `Transient` for 5xx and Network
- `BackoffSpecific(Duration)` for RateLimited

- [ ] **Step 4: `run_cycle()` implementation**

Read current settings (Mirror enabled? Capture paused?). If not enabled or paused → return early.

Load up to `batch_size` rows via `select_pending_rows`. For each:
1. Apply allowlist; if rejected, mark `excluded` and continue
2. Build BlobEnvelope
3. Encrypt with cached MEK
4. POST via Client
5. On 201: update DB row to `synced` + `cloud_index_id` + `encrypted_at`
6. On Permanent error: mark `excluded`
7. On Transient or BackoffSpecific: increment attempt counter; if N attempts exceeded → mark "stuck" via in-process flag; otherwise leave as `pending_upload` for next cycle
8. Check pause state between rows — abort cleanly if paused mid-batch

Return count of successful uploads.

- [ ] **Step 5: Background scheduler**

```rust
pub(crate) fn spawn_scheduler(app: tauri::AppHandle) {
  std::thread::spawn(move || {
    let interval_secs = settings_interval_or_default();
    loop {
      std::thread::sleep(std::time::Duration::from_secs(interval_secs));
      let engine = SyncEngine::global();
      if let Err(e) = engine.run_cycle() {
        log::warn!("mirror sync: {}", e);
      }
    }
  });
}
```

Use a `std::thread` (not tokio task) for simplicity — the engine's `run_cycle` is sync. Inside `run_cycle`, the HTTP client is async; bridge via `tokio::runtime::Handle::current().block_on(...)` if Tauri's runtime is available, or set up a small per-cycle runtime if not. Validate at implementation time which is cleaner.

- [ ] **Step 6: Unit tests (~20)**

U1: `select_pending_rows` filter
U2: `select_pending_rows` LIMIT
U3-U4: `apply_allowlist` (true/false branches)
U5: `build_blob_envelope` shape
U6: AEAD AD canonical JSON binding
U7: payload > 1MB rejected
U8-U10: `classify_error_for_retry` for each error type
U11: Master Key cache lifecycle (unlock / lock / stats)
U12-U15: state machine transitions
U16-U20: edge cases (empty queue, paused mid-cycle, idempotent retry, master locked)

---

## Task 4: 5 Tauri commands

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: `mirror_register(payload) -> {device_id, server_url, ...}`**

```rust
#[tauri::command]
pub async fn mirror_register(payload: Value) -> Result<Value, String> {
  let server_url = payload.get("server_url").and_then(|v| v.as_str())
    .ok_or("server_url required")?;
  let registration_code = payload.get("registration_code").and_then(|v| v.as_str())
    .ok_or("registration_code required")?;
  let device_name = payload.get("device_name").and_then(|v| v.as_str())
    .unwrap_or("My Mac");

  let client = mirror::http::Client::new_unauthenticated(server_url.to_string())?;
  let registration = client.register_device(registration_code, device_name).await
    .map_err(|e| e.to_string())?;

  // Persist device_id + server_url to settings; device_token to keychain
  settings_store::save_patch(&json!({
    "section": "cloud_mirror",
    "enabled": true,
    "server_url": server_url,
    "device_id": registration.device_id,
  }))?;
  mirror::keychain::save_device_token(&registration.device_token)?;

  Ok(json!({ "device_id": registration.device_id, "stub": false }))
}
```

- [ ] **Step 2-5: `mirror_unlock`, `mirror_status`, `mirror_sync_now`, `mirror_disable`**

Per spec § 5.4. Each is a thin wrapper around `SyncEngine` methods + settings/keychain persistence.

- [ ] **Step 6: Register in `invoke_handler`**

In `lib.rs`, add the 5 commands alphabetically alongside other mirror_* / privacy_* / etc. commands.

---

## Task 5: Frontend wiring

**Files:**
- Modify: `hifi/lib/shogun-api.js` — `mirror.{register,unlock,status,syncNow,disable}` API helpers
- Modify: `hifi/lib/action-registry.js` — register `mirror.register`, `mirror.unlock`, `mirror.status`, `mirror.sync_now`, `mirror.disable` runtime actions
- Modify: `hifi/lib/ipc-client.js` `mockTransport` — 5 mock cases (`stub: true` returns)
- Modify: `hifi/app.jsx::mockIpcInvoke` — mirror the same 5 cases (`check:ipc-mock` parity enforced)
- Modify: `hifi/action-map.md` — 5 new registry entries

`mirror_unlock` mock takes `{ passphrase: string }` payload but never actually uses it in mock mode — returns `{ ok: true, data: { stub: true } }`. Same for `mirror_register` etc. Frontend Settings UI (Phase 2.1.4) consumes these.

Run `npm run check:actions` and `npm run check:ipc-mock` to confirm parity.

---

## Task 6: lib.rs wiring

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Register 5 new commands in `invoke_handler`**

- [ ] **Step 2: Spawn the scheduler in `setup` callback**

After `capture_sampler::start_background_sampler`:
```rust
mirror::sync::spawn_scheduler(app.handle().clone());
```

The scheduler is gated on `sections.cloud_mirror.enabled` — a no-op cycle if disabled. So spawning unconditionally is safe.

---

## Task 7: Verification gates

- [ ] **Step 1: `npm run check:rust`** exit 0
- [ ] **Step 2: `cargo test --lib mirror`** — existing 30 + ~30 new = 60 pass
- [ ] **Step 3: `cargo test --lib`** — existing baseline + 60 mirror = full pass (skip kioku_extraction if needed)
- [ ] **Step 4: `npm run check:actions`** PASS
- [ ] **Step 5: `npm run check:ipc-mock`** OK (5 new commands sync)
- [ ] **Step 6: `npm run test:e2e`** 30 pass (frontend untouched apart from mock entries)
- [ ] **Step 7: Manual smoke** (deferred — needs Phase 2.1.3 server running OR a mockito-backed test setup)

---

## Task 8: Commit + Draft PR

- [ ] **Step 1: Commit**

Either one cohesive commit `feat(cloud-mirror): Phase 2.1.2 — Mac sync engine` or split as Task 1+2 / Task 3 / Task 4-5 / Task 6.

- [ ] **Step 2: Push + open Draft PR**

```bash
git push -u origin feat/cloud-2-1-2-mac-sync-engine-impl
gh pr create --draft --title "feat(cloud-mirror): Phase 2.1.2 — Mac sync engine" --body "..."
```

PR body links the design + RFC + decisions S1-S12 + OQ1-OQ4 resolutions + the test matrix.

---

## Acceptance Criteria

| Criterion | Implemented in |
|----------------|---------------|
| Schema gains `cloud_index_id` + `encrypted_at` | Task 1 |
| `BlobEnvelope` matches RFC § 4.1 | Task 3 (Step 3) |
| AEAD AD bound per RFC § 4.3 | Task 3 (Step 3) + U6 |
| Retry-with-backoff per S4 | Task 3 (Step 4) + U8-U10 |
| Pause-safety per S9, S11 | Task 3 (Step 4) + U18 |
| 5 IPC commands per design § 5.4 | Task 4 |
| `cargo test -p app` green | Task 7 (Step 3) |
| `check:rust` / `check:actions` / `check:ipc-mock` green | Task 7 |
| No E2E regression | Task 7 (Step 6) |

---

## Self-Review Notes

- **Honest limitation**: e2e against a real server requires Phase 2.1.3 (server reference). Until 2.1.3 lands, integration tests use `mockito` only. This is documented in OQ1 resolution.
- **Background thread architecture**: `std::thread` + `block_on` for HTTP is the simplest pattern. If a future profile shows the sync thread holding up GC / scheduler, a dedicated tokio runtime can be slotted in. Defer.
- **Master Key cache**: lives in process memory until `mirror_disable` or app exit. Documented. `zeroize` Drop is a hardening sub-phase deferral (Phase 2.1.0 already opted out).
- **`row_to_item` 14 args**: at the time of writing, issue #43 (refactor to struct) is open. If #43 lands first, this plan benefits; if not, the mechanical addition still works. Either way, log for #43 reviewers that 2.1.2 is the second phase that touches this signature.
