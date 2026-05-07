# SHOGUN Phase 2.1.2 — Memory Mirror Sync Engine (Mac Side)

**Status:** draft (2026-05-07) — awaiting user review
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Predecessors:**
- Phase 2.1.0 — encryption primitives (PR #47, merged)
- Phase 2.1.1 — Mirror protocol RFC (PR #48, in review)
**Successors:** Phase 2.1.4 (split-architecture search + Settings UI) — consumes the schema columns this phase introduces (`cloud_index_id`, `encrypted_at`)

---

## 1. Goal

Build the **Mac-side queue + uploader** that turns local `mem_items` rows into encrypted blobs and pushes them to a Mirror server endpoint per the protocol RFC. After this lands:

- A user who has set up Mirror (Master Key in Keychain, server URL in Settings) sees their new captures incrementally synced
- The local DB tracks which rows are synced via the Phase 2.0b `sync_status` column plus two new columns (`cloud_index_id`, `encrypted_at`) added here
- Sync is paused-safe: if `sections.capture.paused` is true, sync also pauses
- Failed uploads retry with exponential backoff; persistent failures surface in Settings → Cloud Mirror → Status
- Re-syncs are id-stable (a row is uploaded at most once unless explicitly re-encrypted via Master Key rotation in a later sub-phase)

**No search yet** (that's 2.1.4). **No server reference impl** (that's 2.1.3 — developed in parallel against this RFC). Just the Mac-side queue + uploader.

## 2. Why this is its own sub-phase

The encryption (2.1.0) and the protocol (2.1.1) are foundational primitives. The sync engine is where they meet **production memory state** — a real `mem_items` table with thousands of rows, a real settings store, a real background scheduler thread. Bundling this with the protocol RFC would conflate "what's the wire format" with "how does the Mac client actually use it" — two different review surfaces.

This sub-phase also introduces the first **Mirror IPC commands** that Settings UI consumes (`mirror_register`, `mirror_unlock`, `mirror_status`, `mirror_sync_now`, `mirror_disable`). The IPC surface is intentionally narrow — Mirror cannot leak keys to the frontend, but the frontend needs to drive the lifecycle.

## 3. Scope (in / out)

**In scope:**

- New `src-tauri/src/mirror/sync.rs` (~400 LOC) with:
  - `SyncQueue` — reads `mem_items` rows where `sync_status='pending_upload'`, batches, encrypts with MEK, builds `BlobEnvelope` per RFC § 4.1, posts to server
  - `SyncScheduler` — background thread (tokio runtime piggybacked on existing app runtime), wakes every N minutes, runs queue cycle
  - Per-row state machine: `local_only` → `pending_upload` → `synced` (or back to `local_only` on persistent failure with user notification)
- New `src-tauri/src/mirror/http.rs` (~250 LOC) — HTTP client for the protocol's 5 endpoints, using `reqwest` (already a dependency)
- Schema migration: add `cloud_index_id TEXT` (server-assigned blob_id) and `encrypted_at INTEGER` (Unix ms) columns to `mem_items`. Both nullable; populated on successful upload.
- Settings: new `sections.cloud_mirror.{enabled, server_url, app_allowlist, url_allowlist, sync_interval_minutes}` keys
- New IPC commands (in `commands.rs`):
  - `mirror_register(payload: { registration_code, device_name, server_url })` — calls `POST /v1/devices`, stores token in Keychain, persists `device_id` + `server_url` to settings
  - `mirror_unlock(payload: { passphrase })` — derives Master Key via Argon2id, stores in Keychain
  - `mirror_status() -> { enabled, queue_depth, last_sync_at, last_error, device_id }`
  - `mirror_sync_now()` — kicks off an immediate sync cycle outside the schedule
  - `mirror_disable()` — pauses sync, optionally wipes local Master Key (toggle in payload)
- Mac client opt-in flag: `sections.cloud_mirror.enabled = false` by default
- Mac client allowlist filter: rows whose source matches `app_allowlist` / `url_allowlist` are eligible for sync; others stay `local_only`
- Tests: unit (state machine, allowlist matching, retry logic) + integration (against a mock HTTP server fixture)

**Out of scope (deferred):**

- **Server reference implementation** — Phase 2.1.3 (parallel)
- **Search via split architecture** — Phase 2.1.4 (uses the synced blobs read-side)
- **Settings UI** — Phase 2.1.4 (visual surface for the IPC commands added here)
- **Master Key rotation** — primitives exist in 2.1.0; the actual re-encrypt-all-blobs flow is hardening sub-phase
- **Tombstone propagation** — when a user deletes a local row, sync engine marks it for tombstone via `POST /v1/blobs/<id>/tombstone`. Implementation here covers upload + status; tombstone may slip to 2.1.2.1 if the diff gets too big.
- **Multi-device blob discovery** — the "fetch blobs from a 2nd device" flow is for Phase 2.1.4's split-architecture search

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| S1 | Schema migration | Add `cloud_index_id TEXT` + `encrypted_at INTEGER` to `mem_items`, nullable, via idempotent ALTER (mirror Phase 2.0b's pattern) | Both populated only on successful upload; NULL means "not yet synced". |
| S2 | Eligible-for-sync predicate | `sync_status = 'local_only'` AND `source` allowlisted AND row's URL/app not in user's blocklist | Avoids syncing transient internal rows (e.g. `kioku_*`); honors existing privacy filters from 2.0a. |
| S3 | Status transitions | `local_only` → `pending_upload` (during cycle) → `synced` (success) OR back to `local_only` (transient error) OR `excluded` (permanent server reject) | Permanent reject is rare; mostly used for size/schema errors that won't fix on retry. |
| S4 | Retry policy | Exponential backoff: 30s, 60s, 5m, 30m, 2h, then "stuck" status + user notification. Per-row attempt counter. | Standard. Per-row counter so a single bad row doesn't block the queue. |
| S5 | Batch size | 50 rows per cycle, 1 row per HTTP request | Bounded memory; idempotent on partial-batch failure; simple. Future optimization: batch endpoint. |
| S6 | Scheduler cadence | 5min default, configurable 30s-1d | Settings → Cloud Mirror → "Sync interval". Honors `paused` flag. |
| S7 | Master Key load | Lazy: load from Keychain on first sync attempt, cache in process memory until `mirror_disable` or app exit | Avoid keychain prompts on every sync cycle. Acceptable from a security standpoint because the process is the user's app. |
| S8 | Per-row encryption | Encrypt `mem_items` row JSON (matching `row_to_item` shape) with MEK + random nonce; embed in `BlobEnvelope.ciphertext` | Per RFC § 4. |
| S9 | Sync engine pause | Honor `sections.capture.paused` AND `sections.cloud_mirror.enabled` — both must be true (well, `paused=false`) for sync to run | Emergency stop tray (2.0c) takes precedence over Mirror config. |
| S10 | HTTP client | `reqwest` (already in deps) with `rustls-tls` | No additional crate. |
| S11 | Cancellation | Sync cycle is interruptible — checks paused state between rows, aborts cleanly | UX: clicking Pause from tray must take effect within seconds, even mid-sync. |
| S12 | Naming | spec `2026-05-07-mirror-sync-engine-design.md`; plan to follow as `2026-05-07-mirror-sync-engine.md`; branch `feat/cloud-2-1-2-mac-sync-engine` | Mirrors 2.0/2.1.0/2.1.1 cadence. |

## 5. Module Layout

### 5.1 `src-tauri/src/mirror/sync.rs` (new, ~400 LOC)

```rust
//! Mac-side sync engine: turns local mem_items rows into encrypted blobs
//! and uploads them to the configured Mirror server. Background-thread driven,
//! pause-safe, retry-with-backoff. See spec
//! `docs/superpowers/specs/2026-05-07-mirror-sync-engine-design.md`.

use crate::mirror::{crypto, http};

#[derive(Clone, Debug)]
pub(crate) struct SyncStats {
  pub queue_depth: u64,
  pub last_sync_at: Option<i64>,
  pub last_error: Option<String>,
  pub synced_total: u64,
}

pub(crate) struct SyncEngine {
  // Holds a clone of the master key in process memory (loaded on demand).
  // None means "Mirror not unlocked"; we don't prompt the user automatically.
  master_key: std::sync::Mutex<Option<crypto::MasterKey>>,
  stats: std::sync::Mutex<SyncStats>,
}

impl SyncEngine {
  pub(crate) fn global() -> &'static Self { /* OnceCell */ }
  pub(crate) fn unlock(&self, passphrase: &str) -> Result<(), String>;
  pub(crate) fn lock(&self);  // wipes the cached MasterKey from memory
  pub(crate) fn stats(&self) -> SyncStats;
  pub(crate) fn run_cycle(&self) -> Result<u64, String>;  // returns rows synced this cycle
  pub(crate) fn spawn_scheduler(&self, app: &tauri::AppHandle);
}

// Pure helpers — testable
fn select_pending_rows(conn: &rusqlite::Connection, batch_size: usize) -> Result<Vec<MemItemRow>, String>;
fn build_blob_envelope(row: &MemItemRow, mek: &MEK, device_id: &str) -> Result<BlobEnvelope, String>;
fn classify_error_for_retry(http_err: &http::Error) -> RetryDisposition;
fn apply_allowlist(row: &MemItemRow, settings: &Value) -> bool;
```

### 5.2 `src-tauri/src/mirror/http.rs` (new, ~250 LOC)

```rust
//! HTTP client for the Mirror protocol (RFC at
//! `docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md`).
//! Wraps `reqwest` with structured request/response types and a
//! retry-aware error taxonomy.

#[derive(Debug)]
pub(crate) enum Error {
  Network(String),       // connection refused, DNS, timeout
  ServerError(u16),      // 5xx — retry
  Unauthorized,          // 401 — token revoked, surface to user
  RateLimited(Duration), // 429 with Retry-After
  PayloadTooLarge,       // 413 — permanent reject
  InvalidEnvelope(String), // 400 — permanent reject
  Conflict(String),      // 409 — permanent reject (idempotency violated)
  Gone,                  // 410 — server tombstoned
  NotFound,              // 404 — not visible to this device
  Unknown(String),
}

pub(crate) struct Client {
  base_url: String,
  http: reqwest::Client,
  device_token: String,
}

impl Client {
  pub(crate) fn new(base_url: String, device_token: String) -> Result<Self, Error>;
  pub(crate) async fn register_device(&self, code: &str, name: &str) -> Result<DeviceRegistration, Error>;
  pub(crate) async fn upload_blob(&self, env: &BlobEnvelope) -> Result<UploadResult, Error>;
  pub(crate) async fn list_blobs(&self, since: i64, until: i64, cursor: Option<&str>) -> Result<ListBlobsResult, Error>;
  pub(crate) async fn fetch_blob(&self, blob_id: &str) -> Result<BlobEnvelope, Error>;
  pub(crate) async fn tombstone(&self, blob_id: &str) -> Result<(), Error>;
  pub(crate) async fn health(&self) -> Result<HealthResponse, Error>;
}
```

### 5.3 `src-tauri/src/memory_store.rs` (modify, ~30 LOC)

Add to `init_schema` / migration helpers:
```rust
fn migrate_mirror_columns(conn: &Connection) -> Result<(), String> {
  // Idempotent: PRAGMA table_info, ALTER if missing
  // - cloud_index_id TEXT (server-assigned blob_id; NULL until synced)
  // - encrypted_at INTEGER (Unix ms; NULL until synced)
}
```

Update `row_to_item` (per issue #43, this might be refactored into a struct first; if not, add 2 more positional params). The JSON output gets:
- `cloudIndexId` (string, when non-null)
- `encryptedAt` (number, when non-null)

### 5.4 `src-tauri/src/commands.rs` (modify, ~120 LOC)

Five new Tauri commands. Each returns `{ ok: true, data: {...} }` shape per the existing IPC convention.

```rust
#[tauri::command]
pub async fn mirror_register(payload: Value) -> Result<Value, String>;

#[tauri::command]
pub async fn mirror_unlock(payload: Value) -> Result<Value, String>;

#[tauri::command]
pub async fn mirror_status(payload: Value) -> Result<Value, String>;

#[tauri::command]
pub async fn mirror_sync_now(payload: Value) -> Result<Value, String>;

#[tauri::command]
pub async fn mirror_disable(payload: Value) -> Result<Value, String>;
```

`mirror_unlock`'s payload contains the user's passphrase. The plaintext passphrase is held only in the Tauri command's stack frame, derived to MasterKey via Argon2id, stored in Keychain (already on the previous device) + cached in `SyncEngine::master_key`. The plaintext is discarded as soon as the function returns.

### 5.5 `src-tauri/src/lib.rs` (modify, ~5 LOC)

Register the 5 new commands in `invoke_handler`. Spawn the scheduler in the `setup` callback after `capture_sampler::start_background_sampler` (so it benefits from the same runtime).

### 5.6 Frontend mirrors (`hifi/lib/{shogun-api,action-registry,ipc-client}.js` + `hifi/app.jsx::mockIpcInvoke` + `hifi/action-map.md`) (~30 LOC each)

Add `mirror.{register,unlock,status,sync_now,disable}` API helpers, registry entries, mock cases. Settings UI is 2.1.4 — these are scaffolding for that.

## 6. State Machine

```
                   ingest()
                       ↓
                 ┌──────────┐
                 │local_only│ ◄────────── (failure → next cycle retries)
                 └─────┬────┘                           ↑
                       │ (allowlist match, sync enabled)│
                       │                                │
                       ↓                                │
                 ┌──────────────┐  upload_blob   ┌──────────────┐
                 │pending_upload│ ────────────►  │ http error   │
                 └─────┬────────┘                │  taxonomy    │
                       │ 201                    └────┬─────────┘
                       ↓                             │
                 ┌──────┐                            │
                 │synced│                            │
                 └──────┘                            │
                                                    │
                       ┌───── 4xx permanent ────────┤
                       │      (413, 400, 409)       │
                       │                            │
                       ↓                            │
                 ┌────────┐                         │
                 │excluded│                         │
                 └────────┘                         │
                                                    │
                       ┌───── 5xx, network, 429 ────┘
                       │      (transient)
                       ↓ (after N retries)
                 ┌────────────┐
                 │stuck       │  → Settings notification
                 └────────────┘    "<count> rows failed sync, see logs"
```

Note: `stuck` is not a `sync_status` value — it's an in-process flag the SyncEngine tracks. The DB row stays `pending_upload` with an attempt counter. On the next successful unlock + cycle, retries resume from where they left off.

## 7. Test Strategy

### 7.1 Unit tests (~20)

In `src-tauri/src/mirror/sync.rs::tests`:

- **U1**: `select_pending_rows` returns only rows with `sync_status='local_only'`
- **U2**: `select_pending_rows` honors `LIMIT batch_size`
- **U3**: `apply_allowlist` true when `source='capture_sampler'` and `app_allowlist=['*']`
- **U4**: `apply_allowlist` false when row's URL matches `excludedSites`
- **U5**: `build_blob_envelope` produces RFC § 4.1-shaped JSON
- **U6**: `build_blob_envelope` AEAD AD binding includes version + blob_id + device_id + schema + metadata, excludes ciphertext + created_at
- **U7**: `build_blob_envelope` rejects rows whose JSON exceeds 1MB ciphertext
- **U8**: `classify_error_for_retry` for 5xx → Transient
- **U9**: `classify_error_for_retry` for 401 → PermanentUnauthorized
- **U10**: `classify_error_for_retry` for 429 with Retry-After → BackoffSpecific(seconds)
- **U11**: Master Key cache lifecycle: `unlock` populates, `lock` clears, `stats` reads without affecting cache
- **U12-U15**: state machine transitions match § 6
- **U16-U20**: edge cases (empty queue, 1MB row, paused mid-cycle, simultaneous mirror_sync_now, etc.)

### 7.2 Integration tests (~10)

Use `mockito` (already in dev-deps for Phase 2.0d's HTTP work). Each test starts a mock server, drives `Client` + `SyncEngine` against it.

- **I1**: full happy path — register device, unlock, ingest 5 rows, run cycle, observe 5 successful uploads + DB rows updated to `synced`
- **I2**: server returns 401 → SyncEngine pauses, surfaces `last_error` in stats
- **I3**: server returns 5xx for first attempt, 201 on retry → row eventually synced after backoff
- **I4**: server returns 429 with Retry-After → cycle waits, retries on schedule
- **I5**: 100 rows queued, batch_size=50 → 2 cycles fully drain queue
- **I6**: row exceeds 1MB → marked `excluded`, queue continues
- **I7**: capture pause mid-cycle → cycle aborts cleanly, no partial uploads
- **I8**: malformed `BlobEnvelope` (intentional bug injection) → server returns 400 → marked `excluded`
- **I9**: idempotent re-upload — re-running `run_cycle` after a row is `synced` does nothing
- **I10**: `mirror_disable` clears Master Key from cache, future sync cycles fail with "Mirror locked"

### 7.3 Manual smoke (user-driven)

- Enable Mirror in Settings → Cloud Mirror, point at a self-hosted dev server (or once 2.1.3 ships, the reference impl)
- Capture a few memories → wait 5 min → check the Mirror dashboard / logs to confirm blob_ids appeared
- Disable Mirror, re-enable with same passphrase → existing rows stay `synced`, new rows sync as normal
- Pause capture from tray → sync stops within one cycle
- Force a server outage (firewall the URL) → status shows error within one cycle, retries continue

## 8. Risks and Mitigations

- **Master Key cached in process memory**: required for unattended sync. Cleared on `mirror_disable` and on app exit. `zeroize::Zeroize` Drop on the cache itself is a hardening sub-phase deferral.
- **Server URL trust**: the user picks the URL. A malicious URL can observe metadata + ciphertext (cannot decrypt). Settings warns about this; Q3 in 2.1.1 RFC discusses cert pinning for the SaaS variant.
- **Background thread crash**: Tauri runtime should restart it on next app launch. Sync engine resumes from the `sync_status` column — durable.
- **Ingest blocking on encryption**: `mem_items::ingest()` currently writes synchronously. The sync engine reads the table on its own schedule; ingest stays unaffected. Encryption happens on the sync thread, not the ingest thread.
- **Allowlist drift**: a row that was eligible at ingest time but excluded by an updated allowlist remains in `local_only` state and is never synced. Acceptable — user-changed-their-mind semantic. To re-evaluate, user can manually trigger a re-sync (separate UI action, deferred).
- **Encrypted_at vs created_at**: the DB has `created_at` (when the memory was captured) and now `encrypted_at` (when it was sent to cloud). Document the distinction in the schema comments.

## 9. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| `mem_items` schema gains `cloud_index_id` + `encrypted_at` | T1-equivalent migration test |
| Eligible rows uploaded; ineligible rows stay local_only | I1 + U3-U4 |
| `BlobEnvelope` matches RFC § 4 byte-for-byte | U5-U7 |
| Retry policy correctly classifies HTTP errors | U8-U10 |
| Capture pause stops sync mid-cycle | I7 |
| Idempotent re-runs don't double-upload | I9 |
| `mirror_unlock` + `mirror_disable` lifecycle | I10 |
| `cargo test -p app` green (existing 581+ + ~30 new = 610+) | full suite |
| `npm run check:rust` / `check:actions` / `check:ipc-mock` green | gates |
| `npm run test:e2e` 30 pass (no regression — 2.1.4 will exercise UI) | full suite |
| Manual smoke against a Mirror server | user-driven |

## 10. Open Questions — RESOLVED 2026-05-07

These were the open questions; their resolutions feed into the implementation plan.

- **OQ1 — RESOLVED: `mockito` for HTTP integration tests.** Already in dev-deps from Phase 2.0d. Well-understood by the team. Sufficient for the integration test surface this sub-phase requires (mock 5xx, 401, 429-with-Retry-After, 201 happy path). A lighter custom fixture was considered but offers no measurable benefit at this scale.

- **OQ2 — RESOLVED: Single-row HTTP requests.** Per-row idempotency, simpler retry semantics, and a clean 1:1 mapping between `mem_items` rows and `BlobEnvelope` posts. Throughput is bounded by the user's typical capture rate (~1 row / minute), not request rate. A batched endpoint becomes worthwhile only when measurements show wire overhead matters; defer to Phase 2.1.5+ optimization with empirical data.

- **OQ3 — RESOLVED: `mirror_disable` always wipes the cached Master Key.** "Soft pause" retains the key in process memory so re-enable is instant — but that's exactly the footgun: a user who disables Mirror and then re-enables expects a deliberate unlock step, not silent resumption. Consistency with the security model: disabled means locked; locked means re-unlock required. Per-call decision is removed.

- **OQ4 — RESOLVED: 2.1.2 only exposes status strings via `mirror_status`.** Visual surfaces (toast / persistent banner / status indicator) are Phase 2.1.4's responsibility. This keeps 2.1.2 a self-contained backend phase and lets 2.1.4 design the UX holistically once the Settings → Cloud Mirror pane lands. Concretely, `mirror_status` returns `{ enabled, queue_depth, last_sync_at, last_error, locked, device_id }`; the `locked` boolean is the signal 2.1.4 binds to.

These resolutions are locked the same way decisions S1-S12 in §4 are locked.

## 11. What this enables

After 2.1.2 lands:
- **Phase 2.1.3** (server reference impl) has a real client to test against — mockito coverage in 2.1.2 + real client integration in 2.1.3
- **Phase 2.1.4** (split-architecture search + Settings UI) has the schema columns (`cloud_index_id`, `encrypted_at`) needed to mark which rows are mirrored, and the IPC commands needed to drive the UX
- The full Phase 2.1 promise — "encrypted cloud sync of memory metadata, opt-in, user-controlled" — is delivered on the Mac side after 2.1.4 merges
