# SHOGUN Phase 2.1.3 — Mirror Server Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement the self-hostable Rust microservice per the Phase 2.1.3 design (PR #50 merged) and the Phase 2.1.1 protocol RFC. Operators can run their own Mirror server via `cargo run --bin shogun-mirror-server`.

**Architecture:**
- New crate `mirror-server/` at the repo root (separate Cargo.toml; not part of `src-tauri/` workspace)
- `axum 0.7` HTTP framework + `tokio` async runtime
- `BlobStore` trait + `LocalDiskStore` impl (file-per-blob + JSONL index per device)
- Bearer-token auth with Argon2id-hashed tokens
- 30-day tombstone retention via background reaper task
- All 9 RFC endpoints (devices: register, rename, delete; blobs: upload, list cursor, list time-range, fetch, tombstone; health)

**Tech Stack:** Rust (`axum`, `tokio`, `tower-http`, `serde`, `argon2`, `ulid`, `base64`, `chrono`, `parking_lot`, `tracing`, `tracing-subscriber`, `config`, `thiserror`, `async-trait`).

**Spec:** `docs/superpowers/specs/2026-05-07-mirror-server-reference-design.md`
**Protocol RFC:** `docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md`
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`

**Predecessors:** Phases 2.1.0 (encryption primitives), 2.1.1 (RFC), 2.1.2 (Mac client) all merged. The server is independent of the Mac client at the code level — they integrate only via the wire protocol.

---

## File Map

**Created:**
```
mirror-server/
├── Cargo.toml                            (~40 LOC)
├── README.md                             (~80 LOC, operator-facing quickstart)
├── mirror-server.example.toml            (~40 LOC, config sample)
├── src/
│   ├── main.rs                           (~60 LOC, entry: load config, start axum + reaper)
│   ├── lib.rs                            (~30 LOC, re-exports for integration tests)
│   ├── config.rs                         (~80 LOC, Config struct, file + env vars)
│   ├── error.rs                          (~70 LOC, ServerError enum + IntoResponse)
│   ├── auth.rs                           (~120 LOC, bearer middleware, Argon2id token hashing)
│   ├── ratelimit.rs                      (~90 LOC, in-memory token bucket per device)
│   ├── reaper.rs                         (~80 LOC, background tombstone purger)
│   ├── routes/
│   │   ├── mod.rs                        (~10 LOC, sub-mod declarations + Router builder)
│   │   ├── devices.rs                    (~150 LOC, POST/PUT/DELETE /v1/devices)
│   │   ├── blobs.rs                      (~250 LOC, POST/GET/POST tombstone endpoints)
│   │   ├── health.rs                     (~30 LOC, /v1/health)
│   │   └── metrics.rs                    (~50 LOC, /metrics on separate port)
│   └── storage/
│       ├── mod.rs                        (~120 LOC, BlobStore trait + StoreError)
│       └── local_disk.rs                 (~350 LOC, file-backed implementation + cursor mgmt)
└── tests/
    ├── http_integration.rs               (~400 LOC, axum_test against in-memory store)
    ├── storage.rs                        (~250 LOC, LocalDiskStore unit tests)
    └── e2e.rs                            (~200 LOC, spawn binary + test against it)
```

**Modified at repo root:**
- `Cargo.toml` (new workspace `[workspace] members = ["src-tauri", "mirror-server"]`) OR no workspace (separate crate, separate target dir). **Use separate crate** to avoid invasive changes to the existing `src-tauri/` build. Just add `mirror-server/` to the repo; `cargo build` from `mirror-server/` builds independently.

**No changes** to `src-tauri/` or `hifi/`. The Mac client interacts via HTTP only.

**Verification gates** (Task 8): `cd mirror-server && cargo test` (all unit + integration + e2e tests pass) + `cargo clippy` clean + `cargo build --release` produces a working binary.

---

## Task 1: Create `mirror-server/` crate skeleton

**Files:** all of `mirror-server/`

This task gives a compiling skeleton: empty modules, `Cargo.toml` with all deps, README explaining what this is. No logic yet.

- [ ] **Step 1: Create `mirror-server/Cargo.toml`**

```toml
[package]
name = "shogun-mirror-server"
version = "0.1.0"
edition = "2021"
license = "TBD"
publish = false

[[bin]]
name = "shogun-mirror-server"
path = "src/main.rs"

[lib]
name = "shogun_mirror_server"
path = "src/lib.rs"

[dependencies]
tokio = { version = "1", features = ["full"] }
axum = { version = "0.7", features = ["json"] }
tower = "0.5"
tower-http = { version = "0.6", features = ["trace", "cors"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
config = "0.14"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["fmt", "env-filter", "json"] }
argon2 = "0.5"
ulid = "1"
base64 = "0.22"
chrono = { version = "0.4", features = ["serde"] }
thiserror = "1"
async-trait = "0.1"
parking_lot = "0.12"

[dev-dependencies]
axum-test = "16"
tempfile = "3"
proptest = "1"
reqwest = { version = "0.12", features = ["json", "rustls-tls"] }
```

- [ ] **Step 2: `src/lib.rs` skeleton**

```rust
//! SHOGUN Memory Mirror server — encrypted blob storage with cursor-based
//! delta sync. See spec docs/superpowers/specs/2026-05-07-mirror-server-reference-design.md
//! and RFC docs/superpowers/specs/2026-05-07-mirror-protocol-rfc.md.

#![allow(dead_code)]

pub mod auth;
pub mod config;
pub mod error;
pub mod ratelimit;
pub mod reaper;
pub mod routes;
pub mod storage;
```

- [ ] **Step 3: `src/main.rs` skeleton**

```rust
//! Entry point: load config, start tokio runtime, mount axum router.

use std::net::SocketAddr;
use std::sync::Arc;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // TODO: load config, init tracing, start axum + metrics + reaper
    Ok(())
}
```

- [ ] **Step 4: skeleton submodule files**

Each of `config.rs`, `error.rs`, `auth.rs`, `ratelimit.rs`, `reaper.rs`, `storage/mod.rs`, `storage/local_disk.rs`, `routes/mod.rs`, `routes/{devices,blobs,health,metrics}.rs` gets a doc-comment and an empty body.

- [ ] **Step 5: Verify compile**

```bash
cd mirror-server && cargo check 2>&1 | tail -3
```

Expected: clean compile. Set up the repo's gitignore if `mirror-server/target/` is missing.

---

## Task 2: Storage layer — `BlobStore` trait + `LocalDiskStore`

**Files:** `mirror-server/src/storage/{mod.rs,local_disk.rs}`

- [ ] **Step 1: Define `BlobStore` trait + `StoreError` (TDD: write trait first)**

```rust
// storage/mod.rs
use async_trait::async_trait;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found")]
    NotFound,
    #[error("gone (tombstoned)")]
    Gone,
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("internal: {0}")]
    Internal(String),
}

#[async_trait]
pub trait BlobStore: Send + Sync {
    async fn put(&self, env: &BlobEnvelope) -> Result<(), StoreError>;
    async fn get(&self, blob_id: &str) -> Result<Option<BlobEnvelope>, StoreError>;
    async fn list(&self, query: &ListQuery) -> Result<ListResult, StoreError>;
    async fn tombstone(&self, blob_id: &str) -> Result<(), StoreError>;
    async fn purge_tombstones_before(&self, before: chrono::DateTime<chrono::Utc>) -> Result<u64, StoreError>;
    async fn tombstone_device(&self, device_id: &str) -> Result<u64, StoreError>;
}

pub struct ListQuery {
    pub device_id: Option<String>,
    pub since: Option<chrono::DateTime<chrono::Utc>>,
    pub until: Option<chrono::DateTime<chrono::Utc>>,
    pub cursor: Option<String>,
    pub limit: usize,
}

pub struct ListResult {
    pub blobs: Vec<BlobListEntry>,
    pub next_cursor: Option<String>,
}
```

Define the wire types `BlobEnvelope`, `BlobListEntry`, `BlobMetadata` matching RFC § 4.1 and § 5.3.

- [ ] **Step 2: TDD `LocalDiskStore::put` + `get`**

Write failing tests first:
- `put` writes the envelope to `<data_dir>/blobs/<device_id>/<blob_id>.json`
- `get` reads it back, returns `BlobEnvelope`
- `get` returns `None` for missing blob_id
- `put` of same `blob_id` with same content returns `Ok(())` (idempotent)
- `put` of same `blob_id` with different content returns `Err(StoreError::Conflict)`

Implement `LocalDiskStore::put` using `tokio::fs::write` (atomic via temp + rename). Implement `get` using `tokio::fs::read`.

- [ ] **Step 3: TDD cursor + list**

Write failing tests:
- 10 blobs inserted in random `created_at` order surface in `(stored_at, seq)` order via `list`
- `cursor` parameter resumes from where the prior call left off
- `limit` enforces page size

Implement the JSONL index pattern (see design § 5.3). Each `put` appends to `<data_dir>/index/<device_id>.jsonl`. List reads the JSONL file from the cursor position forward.

- [ ] **Step 4: TDD tombstone + retention**

- `tombstone(id)` removes the blob file but adds a tombstone marker to the index
- `list` includes tombstoned entries with `tombstoned_at` + `metadata: null`
- `get` of a tombstoned id returns `Err(StoreError::Gone)`
- `purge_tombstones_before` removes tombstone records older than the cutoff
- `tombstone_device` tombstones every blob for a device (per RFC Q2)

- [ ] **Step 5: Run all storage tests**

```bash
cd mirror-server && cargo test --lib storage 2>&1 | grep "^test result"
```

Expected: all storage tests green (~15 tests).

---

## Task 3: Auth middleware + device registry

**Files:** `mirror-server/src/auth.rs`, `mirror-server/src/storage/mod.rs` (extend with device entry persistence)

- [ ] **Step 1: Device registry storage**

Extend `LocalDiskStore` with `save_device`, `load_device`, `delete_device`, `list_devices` operating on `<data_dir>/devices/<device_id>.json` files:

```rust
pub struct DeviceRecord {
    pub device_id: String,
    pub account_id: String,  // per-server constant for single-account MVP
    pub device_name: String,
    pub token_hash: String,  // Argon2id-hashed bearer token
    pub registered_at: chrono::DateTime<chrono::Utc>,
}
```

- [ ] **Step 2: Token generation + verification**

```rust
pub fn generate_device_token() -> String {
    // 32-byte URL-safe-base64 random secret via getrandom
}

pub fn hash_token(token: &str) -> Result<String, String> {
    // Argon2id with default params (m=64MiB, t=3)
}

pub fn verify_token(token: &str, hash: &str) -> Result<bool, String> {
    // Argon2id verify
}
```

- [ ] **Step 3: `require_device_token` middleware**

```rust
pub async fn require_device_token<B>(
    State(state): State<AppState>,
    mut req: Request<B>,
    next: Next,
) -> Result<Response, ServerError>
where B: ...
{
    let token = extract_bearer(req.headers())?;
    let device = state.store.find_device_by_token(&token).await?
        .ok_or(ServerError::Unauthorized)?;
    req.extensions_mut().insert(device);
    Ok(next.run(req).await)
}
```

`find_device_by_token` iterates devices, calls `verify_token` against each `token_hash`. For MVP this is fine; Phase 2.1.5+ optimizes with a token → device_id lookup table.

- [ ] **Step 4: TDD auth tests**

- Generate token, hash, verify round-trip
- Wrong token rejected
- Missing `Authorization` header → 401
- Malformed bearer (e.g., not `Bearer <x>`) → 401
- Revoked token (deleted device record) → 401

- [ ] **Step 5: Run auth tests**

```bash
cd mirror-server && cargo test --lib auth 2>&1 | grep "^test result"
```

---

## Task 4: Routes — `devices.rs`, `blobs.rs`, `health.rs`

**Files:** `mirror-server/src/routes/{devices,blobs,health,mod}.rs`

- [ ] **Step 1: `routes::devices`**

Implement:
- `POST /v1/devices` — accepts `{ registration_code, device_name }`. Validates code against config. Generates token, hashes it, stores DeviceRecord, returns `{ device_id, device_token }`.
- `PUT /v1/devices/<id>` — accepts `{ device_name }`. Auth required; caller must own the device. Updates name in DeviceRecord, returns updated record.
- `DELETE /v1/devices/<id>` — auth required. Calls `tombstone_device`, then `delete_device`. Returns `{ device_id, tombstoned_blobs }`.

Use `axum::Json<T>` for both request and response bodies.

- [ ] **Step 2: `routes::blobs`**

Implement (all auth-required):
- `POST /v1/blobs` — accepts a `BlobEnvelope`. Validates against schema (size ≤ 1MB, version == 1, schema is known). Calls `store.put`. Returns `{ blob_id, stored_at }`.
- `GET /v1/blobs?cursor=...&device_id=...&limit=...` — delta sync per RFC § 5.3 Q1 resolution.
- `GET /v1/blobs?since=...&until=...` — time-range historical query.
- `GET /v1/blobs/<id>` — returns the full envelope.
- `POST /v1/blobs/<id>/tombstone` — calls `store.tombstone`. Returns 204.

- [ ] **Step 3: `routes::health`**

```rust
pub async fn health() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "uptime_seconds": ... // since process start
    }))
}
```

No auth.

- [ ] **Step 4: `routes::mod` Router builder**

```rust
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/v1/devices", post(devices::register))
        .route("/v1/devices/:id", put(devices::rename).delete(devices::delete))
        .route("/v1/blobs", post(blobs::upload).get(blobs::list))
        .route("/v1/blobs/:id", get(blobs::fetch))
        .route("/v1/blobs/:id/tombstone", post(blobs::tombstone))
        .route("/v1/health", get(health::health))
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_device_token))
        // Note: /v1/devices (POST) and /v1/health are exempt from auth — apply
        // the layer only to authenticated routes via .nest() if axum supports it.
        .with_state(state)
}
```

Be careful: the `require_device_token` middleware applies to ALL routes by default. `POST /v1/devices` and `GET /v1/health` need exemptions — split into two `Router`s and merge.

- [ ] **Step 5: HTTP integration tests**

Use `axum_test::TestServer`. Tests:
- I1: register → POST blob → GET cursor list → GET blob — happy path
- I2: 401 on missing/invalid token
- I3: 401 on revoked token
- I4: 413 on > 1MB blob
- I5: 400 on malformed envelope (missing fields, unknown version, unknown schema)
- I6: 409 on conflicting blob_id
- I7: cursor pagination — 250 blobs, limit=100 → 3 pages
- I8: time-range query
- I9: tombstone visibility in list + 410 on GET
- I10: device delete tombstones all device's blobs
- I11: device rename
- I12: health endpoint

- [ ] **Step 6: Run route tests**

```bash
cd mirror-server && cargo test --lib routes 2>&1 | grep "^test result"
cd mirror-server && cargo test --test http_integration 2>&1 | grep "^test result"
```

---

## Task 5: Rate limiting + reaper

**Files:** `mirror-server/src/ratelimit.rs`, `mirror-server/src/reaper.rs`

- [ ] **Step 1: In-memory token bucket per device**

```rust
pub struct RateLimiter {
    buckets: parking_lot::Mutex<HashMap<String, Bucket>>,
    config: RateLimitConfig,
}

pub struct RateLimitConfig {
    pub post_blobs_per_minute: u32,    // 100
    pub post_blobs_per_day: u32,        // 10000
    pub get_list_per_minute: u32,       // 60
    pub get_blob_per_minute: u32,       // 600
}

impl RateLimiter {
    pub fn try_acquire(&self, device_id: &str, endpoint: Endpoint) -> Result<(), Duration>;
}
```

Returns the duration the caller should wait if rate-limited. Endpoint is an enum.

- [ ] **Step 2: Wire into routes**

In `routes::blobs::upload`, before calling `store.put`, call `rate_limiter.try_acquire(&device.device_id, Endpoint::PostBlob)`. On `Err(retry_after)`, return 429 with `Retry-After: <secs>` header.

- [ ] **Step 3: Reaper task**

```rust
pub async fn run_reaper(store: Arc<dyn BlobStore>, config: ReaperConfig) {
    let mut interval = tokio::time::interval(Duration::from_secs(config.interval_seconds));
    loop {
        interval.tick().await;
        let cutoff = chrono::Utc::now() - chrono::Duration::days(config.tombstone_retention_days as i64);
        match store.purge_tombstones_before(cutoff).await {
            Ok(purged) => log::info!("reaper purged {} tombstones", purged),
            Err(e) => log::warn!("reaper error: {}", e),
        }
    }
}
```

Spawned from `main.rs` as a `tokio::spawn`.

- [ ] **Step 4: Tests**

- `try_acquire` 100 times in 60s on PostBlob → all succeed
- `try_acquire` 101st time within 60s → `Err(retry_after > 0)`
- After waiting full bucket window, `try_acquire` succeeds again
- Reaper test: insert 5 tombstones with `tombstoned_at` 31 days ago, run `purge_tombstones_before(now - 30 days)`, verify all 5 removed

---

## Task 6: Configuration + main.rs entry

**Files:** `mirror-server/src/config.rs`, `mirror-server/src/main.rs`, `mirror-server/mirror-server.example.toml`

- [ ] **Step 1: `Config` struct with `config` crate**

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub storage: StorageConfig,
    pub auth: AuthConfig,
    pub ratelimit: RateLimitConfig,
    pub reaper: ReaperConfig,
    pub tls: Option<TlsConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    pub listen_addr: String,    // "127.0.0.1:8443"
    pub metrics_addr: String,    // "127.0.0.1:9090"
}

#[derive(Debug, Clone, Deserialize)]
pub struct StorageConfig {
    pub backend: StorageBackend,
    pub data_dir: PathBuf,
}
// etc.

impl Config {
    pub fn load() -> Result<Self, config::ConfigError> {
        config::Config::builder()
            .add_source(config::File::with_name("mirror-server").required(false))
            .add_source(config::Environment::with_prefix("SHOGUN_MIRROR").separator("__"))
            .build()?
            .try_deserialize()
    }
}
```

- [ ] **Step 2: `main.rs` startup**

```rust
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = config::Config::load()?;

    tracing_subscriber::fmt()
        .json()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    let store: Arc<dyn BlobStore> = match config.storage.backend {
        StorageBackend::LocalDisk => Arc::new(LocalDiskStore::new(&config.storage.data_dir).await?),
    };

    let rate_limiter = Arc::new(RateLimiter::new(config.ratelimit.clone()));
    let app_state = AppState { store: store.clone(), rate_limiter, config: config.clone() };

    // Spawn reaper
    tokio::spawn(reaper::run_reaper(store.clone(), config.reaper.clone()));

    // Spawn metrics server on separate port
    tokio::spawn(routes::metrics::serve(config.server.metrics_addr.clone()));

    // Main HTTP server
    let app = routes::build_router(app_state);
    let listener = tokio::net::TcpListener::bind(&config.server.listen_addr).await?;
    log::info!("shogun-mirror-server listening on {}", config.server.listen_addr);
    axum::serve(listener, app).await?;

    Ok(())
}
```

If `config.tls` is Some, use `axum_server::tls_rustls` instead of plain `axum::serve`.

- [ ] **Step 3: Example config file**

`mirror-server/mirror-server.example.toml` — sensible defaults so `cargo run` works without a config file.

- [ ] **Step 4: Run smoke**

```bash
cd mirror-server && cargo run --release &
sleep 2
curl http://127.0.0.1:8443/v1/health
# expect: { "ok": true, "version": "0.1.0", ... }
```

---

## Task 7: e2e test (spawn binary, run client against it)

**Files:** `mirror-server/tests/e2e.rs`

- [ ] **Step 1: Spawn binary in test fixture**

```rust
// Each test starts the server in a child process bound to a random localhost port.
// Uses tempfile for the data_dir.
struct TestServer { ... }

impl TestServer {
    async fn start() -> Self { ... }
    async fn stop(&mut self) { ... }
    fn url(&self) -> &str { ... }
}
```

- [ ] **Step 2: e2e tests using `reqwest`**

- E1: register device → POST blob → GET cursor list → GET blob (full happy path against running binary)
- E2: 100 concurrent uploads → all succeed within rate limit
- E3: 101st upload within minute → 429 with Retry-After
- E4: tombstone → purge after time-warp (set retention_days=0 in the test config) → blob fully removed
- E5: server restart on the same data_dir → all previously-uploaded blobs survive
- E6: `DELETE /v1/devices/<id>` tombstones all device's blobs

- [ ] **Step 3: Run e2e tests**

```bash
cd mirror-server && cargo test --test e2e 2>&1 | grep "^test result"
```

Expected: 6 tests pass. Each takes a few seconds (binary startup + HTTP round-trips).

---

## Task 8: Verification gates + commit + Draft PR

- [ ] **Step 1: Full test suite**

```bash
cd mirror-server && cargo test 2>&1 | grep "^test result"
```

Expected: ~50 tests total (storage 15 + auth 5 + routes 15 + ratelimit 5 + reaper 3 + e2e 6).

- [ ] **Step 2: Clippy + fmt**

```bash
cd mirror-server && cargo clippy --all-targets -- -D warnings
cd mirror-server && cargo fmt --check
```

- [ ] **Step 3: Release build**

```bash
cd mirror-server && cargo build --release 2>&1 | tail -3
ls -la mirror-server/target/release/shogun-mirror-server
```

Expected: a working binary at `target/release/shogun-mirror-server`.

- [ ] **Step 4: README**

`mirror-server/README.md` — operator-facing quickstart:
1. Build (`cargo build --release` or `cargo install --path .`)
2. Configure (`cp mirror-server.example.toml mirror-server.toml`, edit)
3. Run (`./shogun-mirror-server` or via systemd unit)
4. Mac client setup (point Settings → Cloud Mirror at the server URL with the registration code)

- [ ] **Step 5: Commit + push**

```bash
git add mirror-server/
git commit -m "feat(mirror-server): Phase 2.1.3 — server reference implementation"
git push -u origin feat/cloud-2-1-3-mirror-server-impl
```

- [ ] **Step 6: Open Draft PR**

```bash
gh pr create --draft --title "feat(mirror-server): Phase 2.1.3 — server reference implementation" --body "..."
```

PR body links the design + RFC + decisions R1-R14 + the test matrix.

---

## Acceptance Criteria

| Criterion | Implemented in |
|-----------|---------------|
| All 9 RFC endpoints functional | Tasks 4 + 7 |
| `BlobStore` trait abstracts persistence | Task 2 |
| `LocalDiskStore` round-trips blobs | Task 2 + ~15 tests |
| Cursor pagination works | Task 2 + tests |
| Tombstone retention via reaper | Task 5 + tests |
| Rate limiter enforces RFC § 8.2 defaults | Task 5 + tests |
| Bearer token auth with Argon2id hash | Task 3 + tests |
| Health endpoint with version + uptime | Task 4 |
| Cargo binary builds and starts | Task 6 + manual smoke |
| e2e tests against running binary | Task 7 |
| Release binary built | Task 8 (Step 3) |

---

## Self-Review Notes

- **Honest limitation**: TLS direct mode (`rustls`) is supported in config but not exercised by tests in this PR. Operators using reverse-proxy mode are the primary target for production. Direct TLS smoke is a manual verification step.
- **Single-account MVP**: per OQ4 resolution, this server assumes a single account per instance. Multi-tenant accounts are a SaaS hosting concern (Phase 2.1.5+).
- **Token rotation**: not implemented in 2.1.3. A revoked device's token is invalidated by deleting the DeviceRecord; rotating a still-valid token requires the user to re-register the device. Acceptable for self-hosted MVP.
- **Storage backend**: only `LocalDisk` in this phase. `S3Store` is a follow-up.
- **Mac client integration**: not exercised in 2.1.3's tests. After this PR lands, a separate integration test branch will cross-test 2.1.2's `mirror::http::Client` against this server.
