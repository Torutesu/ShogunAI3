# SHOGUN Phase 2.1.3 — Memory Mirror Server Reference Implementation

**Status:** draft (2026-05-07) — awaiting user review
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Predecessors:**
- Phase 2.1.0 — encryption primitives (merged, #47)
- Phase 2.1.1 — Mirror protocol RFC (in review #48; Q1-Q4 resolved 2026-05-07)
**Successors:** Phase 2.1.4 (split-arch search + Settings UI) consumes the running server via the Mac client (2.1.2).

---

## 1. Goal

Build the **self-hostable Rust microservice** that implements the protocol RFC. After this lands:

- Users can run their own Mirror server (`cargo install shogun-mirror-server` or `docker run shogun/mirror-server`)
- The Mac client (Phase 2.1.2) has a real backend to validate against
- All 7 endpoints from RFC § 5.3 are implemented, conforming byte-for-byte to the spec
- Server is **dumb encrypted-blob storage**: no decryption, no content inspection, no analysis
- Per-deployment configuration: storage backend, port, TLS cert paths, rate-limit overrides

This sub-phase is the **server-side counterpart of Phase 2.1.2** (Mac sync engine). Both can be developed in parallel against the locked RFC; integration testing happens once both are ready.

## 2. Why this is its own sub-phase

The Mac client and the server have independent failure modes, performance profiles, and review surfaces. Bundling them would mean:
- A reviewer has to understand both Tauri + Rust async server architecture in one PR
- A change to the wire protocol requires touching two repos / branches
- Operations concerns (rate limiting, storage tiers) get tangled with client-side concerns (queue management, retry logic)

Splitting lets the Mac client iterate against `mockito` (per OQ1 in 2.1.2) and the server iterate against integration tests, with the protocol RFC as the contract.

## 3. Scope (in / out)

**In scope:**

- New repository OR new top-level directory in this repo: `mirror-server/` — undecided, see § 9 OQ1
- Rust binary `shogun-mirror-server` built with `axum` (or `actix-web` — TBD § 9 OQ2):
  - All 7 RFC endpoints (RFC § 5.3 + new endpoints from Q1/Q2/Q3 resolutions): `POST /v1/devices`, `PUT /v1/devices/<id>`, `DELETE /v1/devices/<id>`, `POST /v1/blobs`, `GET /v1/blobs?cursor=...`, `GET /v1/blobs?since=...&until=...`, `GET /v1/blobs/<id>`, `POST /v1/blobs/<id>/tombstone`, `GET /v1/health`
  - Bearer-token auth middleware (per § 5.2 of RFC)
  - Idempotency key check on `POST /v1/blobs` (per P5)
  - AEAD AD validation: server **does not** verify the AD (it can't decrypt) but stores the envelope byte-for-byte so the client can verify on read
  - Per-device rate limiting (token-bucket, in-memory for MVP, persisted optional)
- Storage backend abstraction (`trait BlobStore`):
  - `LocalDiskStore` — file-per-blob under `<data_dir>/blobs/<device_id>/<blob_id>`, JSON metadata in `<data_dir>/index/<device_id>.jsonl`
  - `S3Store` — bucket-backed (object-per-blob, separate index object per device); deferred to a follow-up if local-disk MVP is sufficient
- Cursor implementation: monotonic per-device sequence number assigned at insert time. Cursor is `(device_id, seq)` base64-encoded.
- Tombstone retention: 30-day soft-delete, then hard-purge via a background reaper task (cron in cargo binary or systemd timer).
- Operator concerns (§ 7):
  - HTTPS via `rustls`-based `axum_server::tls_rustls` or behind reverse proxy
  - Configuration via `config` crate (file + env vars)
  - Structured JSON logging via `tracing` + `tracing-subscriber`
  - Prometheus-style `/metrics` endpoint (separate port; no auth; aggregate counters only)
- Tests (~30):
  - Unit tests on the `BlobStore` trait + `LocalDiskStore` impl
  - HTTP integration tests against an in-memory store + an `axum_test::TestServer`
  - End-to-end test that starts the server in a child process and runs the Mac client's HTTP client (Phase 2.1.2's `mirror::http::Client`) against it

**Out of scope (deferred):**

- **SaaS hosting**: Phase 2.1.5+ (this MVP is self-hostable only per OQ3 resolution)
- **Multi-tenant accounts**: each server instance assumes a single account / multiple devices. Multi-account support is hosting concern (deferred)
- **Web UI**: server is API-only. Operators inspect via `curl` + log tail.
- **CDN / edge caching**: an obvious S3-backed scale-out path, but deferred until SaaS phase
- **Quota / billing**: deferred to SaaS phase
- **Backup / disaster recovery**: operators bring their own (rsync, restic, ZFS snapshots)
- **Cross-region replication**: deferred
- **WebSocket / SSE notifications**: deferred. Mac client polls (sync interval) until a real-time channel is justified by use cases (e.g., iPhone phase B notifications in 2.4)

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| R1 | Repo / location | New top-level directory `mirror-server/` in the SHOGUN monorepo | Single repo simplifies version-locking client + server. Independent crate (own Cargo.toml). Future split to dedicated repo is mechanical if monorepo overhead bites. |
| R2 | Web framework | `axum 0.7` | Tower-based, async-friendly, mature, official tokio team. `actix-web` is also fine but axum's ergonomics fit the small surface here. |
| R3 | TLS termination | **Behind reverse proxy** for production (nginx, Caddy, Cloudflare); **rustls direct** for dev / local self-host | Most users hosting on a VPS will use a reverse proxy anyway. Direct rustls is for the "I just want to try it on my LAN" path. |
| R4 | Storage MVP | `LocalDiskStore` (file per blob + JSONL index per device) | Simplest correct implementation. S3-backed is a follow-up once the local-disk shape is validated. |
| R5 | Cursor format | Base64 of `{ "device_id": "...", "seq": 12345 }` JSON | Opaque to client; trivially decodable server-side. Per-device monotonic seq, assigned at insert. |
| R6 | Per-device rate limit | Token bucket: 100 req / minute, 10000 req / day on POST blobs; 60 req / minute on GET list; 600 req / minute on GET blob. In-memory for MVP. | Per RFC § 8.2. In-memory is fine for single-instance MVP; multi-instance would need a shared store (Redis), deferred. |
| R7 | Background reaper | Tokio task that runs every hour, hard-purges tombstones older than 30 days | Simple. Configurable interval and retention via config file. |
| R8 | Auth tokens | 32-byte URL-safe-base64 random secrets, stored hashed (Argon2id) in the device registry. Token validation does Argon2id-on-input each request. | Industry standard. Argon2id slowdown is acceptable for a once-per-request check; if it becomes a bottleneck, switch to a faster cost (or to constant-time hash + per-process cache of accepted tokens). |
| R9 | Registration code | Single static admin-provisioned code in env / config for MVP self-hosted | Phase 2.1.5+ SaaS will introduce one-time codes tied to user accounts. |
| R10 | Logging | `tracing` + `tracing-subscriber` JSON formatter, default INFO level | Standard. Operators can override to DEBUG via env var. Master spec § 7.2 forbids logging ciphertext / nonces / decoded JSON bodies. |
| R11 | Metrics | Prometheus-style counters on a separate `:9090/metrics` port (no auth) | Standard ops practice. Counters only — no histograms of request sizes (would leak metadata). |
| R12 | Configuration | `config` crate: file (`mirror-server.toml`) + env vars (`SHOGUN_MIRROR_*` prefix) | Standard. Defaults work for `cargo run` dev mode. |
| R13 | Naming | spec `2026-05-07-mirror-server-reference-design.md`; plan `2026-05-07-mirror-server-reference.md` (later); branch `feat/cloud-2-1-3-mirror-server-reference` | Mirrors 2.1.x cadence. |
| R14 | Versioning of binary | Server returns its version in `/v1/health` per Q4 resolution. Build-time strip flag for operators who want it hidden. | Follows Q4 resolution. |

## 5. Module Layout

The server is a **separate crate** at `mirror-server/`:

```
mirror-server/
├── Cargo.toml               (crate-type = "bin")
├── src/
│   ├── main.rs              # entry: parse config, start axum + tokio
│   ├── config.rs            # Config struct, file + env loading
│   ├── auth.rs              # bearer token middleware, registration code check
│   ├── routes/
│   │   ├── devices.rs       # POST/PUT/DELETE /v1/devices
│   │   ├── blobs.rs         # POST/GET/DELETE blob endpoints
│   │   ├── health.rs        # GET /v1/health
│   │   └── metrics.rs       # GET /metrics (separate port)
│   ├── storage/
│   │   ├── mod.rs           # BlobStore trait
│   │   └── local_disk.rs    # file-backed implementation
│   ├── ratelimit.rs         # in-memory token bucket per device
│   ├── reaper.rs            # background tombstone purger
│   ├── error.rs             # ServerError enum, IntoResponse impl
│   └── lib.rs               # re-exports for integration tests
└── tests/
    ├── http_integration.rs  # axum_test against in-memory store
    ├── storage.rs           # LocalDiskStore unit tests
    └── e2e.rs               # spawn binary + run Mac client HTTP module
```

### 5.1 `mirror-server/Cargo.toml` (new)

```toml
[package]
name = "shogun-mirror-server"
version = "0.1.0"
edition = "2021"
license = "TBD"

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
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }  # for tests
uuid = { version = "1", features = ["v4"] }
parking_lot = "0.12"

[dev-dependencies]
axum-test = "16"
tempfile = "3"
proptest = "1"
```

### 5.2 `BlobStore` trait

```rust
#[async_trait]
pub(crate) trait BlobStore: Send + Sync {
  /// Store a blob; returns Err(StoreError::Conflict) if blob_id exists with different content.
  async fn put(&self, env: &BlobEnvelope) -> Result<(), StoreError>;
  /// Fetch a blob by id; returns the original envelope byte-for-byte.
  async fn get(&self, blob_id: &str) -> Result<Option<BlobEnvelope>, StoreError>;
  /// List blobs in cursor order; returns (envelopes, next_cursor).
  async fn list(&self, query: &ListQuery) -> Result<(Vec<BlobEnvelope>, Option<String>), StoreError>;
  /// Tombstone a blob: remove ciphertext, retain metadata + tombstone marker.
  async fn tombstone(&self, blob_id: &str) -> Result<(), StoreError>;
  /// Hard-purge tombstones older than `before`. Used by the reaper.
  async fn purge_tombstones_before(&self, before: chrono::DateTime<chrono::Utc>) -> Result<u64, StoreError>;
  /// Tombstone all blobs for a device (used by DELETE /v1/devices/<id>).
  async fn tombstone_device(&self, device_id: &str) -> Result<u64, StoreError>;
}
```

`StoreError` carries `Conflict`, `NotFound`, `Gone`, `IO(io::Error)`, etc. — mapped to HTTP status by the route layer.

### 5.3 `LocalDiskStore` implementation

```
data_dir/
├── devices/
│   └── <device_id>.json     # { device_id, account_id, name, token_hash, registered_at }
├── blobs/
│   └── <device_id>/
│       └── <blob_id>.json   # full BlobEnvelope JSON
└── index/
    └── <device_id>.jsonl    # one line per blob: { seq, blob_id, stored_at, tombstoned_at }
```

The JSONL index is the cursor source: server reads from `seq + 1` to fulfill `cursor=<base64>` queries. Append-only writes (with `O_APPEND`) make concurrent ingest safe without locking the whole file.

### 5.4 Auth middleware

```rust
async fn require_device_token<B>(
  State(state): State<AppState>,
  req: Request<B>,
  next: Next,
) -> Result<Response, ServerError>
```

Extracts `Authorization: Bearer <token>`, hashes via Argon2id, looks up in device registry. On match, attaches `(device_id, account_id)` to request extensions. On miss → 401.

### 5.5 Configuration

```toml
# mirror-server.toml
[server]
listen_addr = "127.0.0.1:8443"
metrics_addr = "127.0.0.1:9090"

[storage]
backend = "local_disk"
data_dir = "/var/lib/shogun-mirror"

[auth]
registration_code = "supersecret"  # or via SHOGUN_MIRROR_REGISTRATION_CODE env

[tls]
cert_path = "/etc/letsencrypt/live/example.com/fullchain.pem"  # optional, for direct rustls
key_path = "/etc/letsencrypt/live/example.com/privkey.pem"

[reaper]
interval_seconds = 3600
tombstone_retention_days = 30

[ratelimit]
post_blobs_per_minute = 100
post_blobs_per_day = 10000
get_list_per_minute = 60
get_blob_per_minute = 600
```

Sensible defaults so `cargo run` works without a config file.

### 5.6 `mirror-server/src/lib.rs`

Re-exports types used by integration tests in `tests/`. The Mac client's `mirror::http::Client` is *not* a dependency of the server — they communicate only via HTTP.

## 6. Test Strategy

### 6.1 Unit tests (~15)

- `LocalDiskStore` put / get / list / tombstone / purge round-trips
- Cursor encoding / decoding round-trip
- Cursor ordering: blobs inserted in arbitrary order surface in `(stored_at, seq)` order
- Idempotency: same blob_id + same content → 201 with original `stored_at`; different content → 409
- Tombstone retention: `purge_tombstones_before` removes only entries older than the cutoff
- Auth token: Argon2id round-trip; wrong token rejected; revoked token rejected
- Rate limiter: bucket exhaustion produces 429 with Retry-After

### 6.2 HTTP integration tests (~10)

Use `axum_test::TestServer` against an in-memory `BlobStore` mock.

- Full happy path: register device → POST blob → GET cursor list → GET blob → matches what was POSTed
- 401 on missing / invalid token
- 401 on revoked token (tombstone in device registry)
- 413 on > 1MB blob
- 400 on malformed envelope (missing required fields, version unknown, schema unknown)
- 409 on conflicting blob_id with different content
- Cursor pagination: 250 blobs, limit=100 → 3 pages including empty next
- Time-range query: `since`/`until` filters by `stored_at`
- Tombstone visibility: tombstoned blob in list with `tombstoned_at` + `metadata: null`; GET blob returns 410
- Health endpoint: returns version + uptime; no auth required

### 6.3 End-to-end test (~5)

Spawn the binary in a child process, run the Mac client's HTTP module against it.

- Register → upload → list → fetch → tombstone → list (sees tombstone) → purge (after time-warp)
- Delete device → all blobs from that device are tombstoned
- Rename device → new name visible in subsequent device-list response (if implemented; otherwise via direct file inspection in `data_dir/devices/`)
- Rate limit triggers 429 + Retry-After
- Server crash mid-write → restart → no corrupt indices (rely on append-only JSONL recovery)

### 6.4 Manual smoke (operator)

- `cargo run` with default config → server reachable at `localhost:8443`, `localhost:9090/metrics` exposed
- Self-hosted dev: point Mac client (2.1.2) at the server, sync 100 memories, verify on disk and via metrics
- TLS: `axum-server::tls-rustls` direct mode with self-signed cert, Mac client honors

## 7. Operational Concerns

### 7.1 Logging

Per master spec § 7.2:
- Log: HTTP method, path, status code, response time, device_id, error code (not message — error messages may contain raw input)
- DO NOT log: ciphertext, nonces, request bodies, decoded JSON content
- INFO default; DEBUG via `RUST_LOG=shogun_mirror=debug`
- JSON-formatted output for ingest into ELK / Loki / etc.

### 7.2 Metrics

Prometheus-format on `:9090/metrics` (separate port, no auth — assumes operator-network-only access). Counters only:

- `shogun_mirror_blobs_uploaded_total{device_id="..."}`
- `shogun_mirror_blobs_fetched_total{device_id="..."}`
- `shogun_mirror_tombstones_total`
- `shogun_mirror_rate_limited_total{endpoint="..."}`
- `shogun_mirror_active_devices` (gauge)

No request-size histograms or content distributions — those would leak metadata.

### 7.3 Storage growth

Per master spec § 8.1 estimate: 5GB / active user / year. Operators should:
- Monitor `data_dir` disk usage
- Plan retention (default: indefinite for live blobs, 30 days for tombstones)
- Backup `data_dir` (rsync, restic, ZFS snapshots — operator's choice)

### 7.4 Disaster recovery

- All state is in `data_dir` — back it up periodically
- Server restart on the same `data_dir` resumes correctly (append-only indices, deterministic naming)
- Server-side keys (TLS cert, registration code) are operator-managed — separate concern from blob storage
- The server holds no decryptable user data — even a complete server compromise gives the attacker only opaque ciphertext

### 7.5 Failure modes

| Failure | Behavior |
|---------|----------|
| Disk full | POST returns 500 with `error: "internal_server_error"`; logs error |
| Corrupt JSONL index | Server rebuilds from `blobs/<device_id>/*.json` on next startup (slow but deterministic) |
| Registration code leaked | Operator rotates `registration_code` in config; existing device tokens unaffected |
| TLS cert expired | Server refuses to start; operator must renew |
| Database migration (future) | Schema version on startup; refuse to run if version mismatch + no migration available |

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| All 7+ RFC endpoints implemented | HTTP integration tests |
| `BlobStore` trait abstracts the persistence layer | unit tests |
| `LocalDiskStore` round-trips blobs correctly | unit tests |
| Cursor pagination works | HTTP integration test |
| Tombstone + retention + reaper functions | unit + e2e tests |
| Rate limiter enforces RFC § 8.2 defaults | unit test |
| Bearer token auth works | HTTP integration test |
| `/v1/health` returns version + uptime | HTTP integration test |
| `/metrics` exposes counters | manual + curl |
| Mac client (Phase 2.1.2) successfully syncs against this server | e2e test |
| `cargo test` (in `mirror-server/`) green | full suite |
| `cargo clippy` clean | gates |

## 9. Open Questions for Reviewer

These don't block design review but inform implementation:

- **OQ1**: Co-locate in monorepo (`mirror-server/`) or split to a new repo? Defaulting to **monorepo** for MVP — easier version-locking with the Mac client and simpler PR review. Split is mechanical later.
- **OQ2**: `axum` vs `actix-web` vs others? Defaulting to **axum 0.7** — tokio-team-maintained, ergonomic for this surface size, well-documented.
- **OQ3**: Built-in TLS via `rustls` direct, or assume reverse-proxy (nginx / Caddy / Cloudflare)? Defaulting to **both supported** — direct for dev / LAN, reverse-proxy for production.
- **OQ4**: Single-account or multi-account from day 1? Defaulting to **single-account** for self-hosted MVP — multi-tenant is a SaaS concern (Phase 2.1.5+).

These can be flipped at plan-review without re-doing the design.

## 10. What this enables

After 2.1.3 lands:
- **Phase 2.1.2** (Mac client sync engine) has a real backend to integrate-test against, instead of `mockito` only
- **Phase 2.1.4** (split-arch search + UI) can validate the cursor + time-range queries against the reference impl
- Self-hosting users get a runnable backend on day 1 of Mirror's release
- The "Memory Mirror" promise — encrypted cloud sync that the user controls end-to-end — is fully deliverable on the open-source path
