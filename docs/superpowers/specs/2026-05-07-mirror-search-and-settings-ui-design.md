# SHOGUN Phase 2.1.4 — Split-Architecture Search + Settings UI Design

**Status:** draft (2026-05-07) — awaiting user review
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Predecessors:**
- Phase 2.1.0 — encryption primitives (merged)
- Phase 2.1.1 — Mirror protocol RFC (merged)
- Phase 2.1.2 — Mac sync engine (merged)
- Phase 2.1.3 — server reference impl (in review #56)
**Successors:** None — 2.1.4 closes the Memory Mirror MVP loop. Phase 2.2 (iPhone client Phase A) follows.

---

## 1. Goal

Close the Memory Mirror MVP loop on the Mac side. After this lands:

- Users can **enable/disable Mirror, manage devices, set passphrase** via Settings → Cloud Mirror
- Memory **search reads from BOTH local and cloud** — local hits the local `mem_items` index, cloud hits encrypted blobs from the Mirror server, decrypted locally, ranked together
- The user can **see what's happening**: queue depth, last sync time, errors, per-device blob counts
- **No more CLI/manual ops** — every Mirror operation reachable from the GUI

This is the visible payoff for the user. Everything before 2.1.4 was infrastructure.

## 2. Why this is its own sub-phase

The split-architecture search is a non-trivial algorithm in its own right (fetch encrypted blobs by time range, decrypt locally, run vector similarity, merge with local results, dedupe). Bundling it with Settings UI would conflate a search-quality concern with a UX concern. Each gets its own review surface.

The Settings UI is also where **all four 2.1.x sub-phase IPC commands surface** to the user for the first time:
- 2.1.2's `mirror_register` / `mirror_unlock` / `mirror_status` / `mirror_sync_now` / `mirror_disable` / `mirror_reset_stuck`
- 2.1.4 adds `mirror_search_blobs` / `mirror_list_devices` / `mirror_rename_device` / `mirror_delete_device`

That's ~9 user-facing operations. The UI shape needs care — too cluttered and the privacy model becomes opaque.

## 3. Scope (in / out)

**In scope:**

### Settings UI (~600 LOC across `hifi/settings-modal.jsx` + new pane)
- New pane: `Settings → Cloud Mirror` (top-level pane per design D7 from architecture spec)
- **Onboarding state** (Mirror disabled): single "Enable Mirror" button → modal that walks through:
  - Server URL entry (default empty; user pastes their self-hosted URL)
  - Registration code entry (acquired out-of-band per RFC § 5.3)
  - Device name (default: `<hostname>` from `os::hostname`)
  - **Passphrase setup** — strength meter (zxcvbn-style; 4 levels), 2 entries to confirm, **typed-text-match warning**: "this passphrase is the only key — if you forget it, every synced memory is unrecoverable"
  - Submit → `mirror_register` → `mirror_unlock` → status flips to "Active"
- **Active state**: shows status row (last sync, queue depth, error if any), three cards:
  - **Sync controls** — toggle "Sync paused", "Sync interval" dropdown, "Sync now" button
  - **Devices** — list of devices in the account (this device + others), each with rename + delete buttons
  - **Privacy filters** — app/URL allowlist editors (mirroring Phase 2.0a's pattern)
- **Locked state** (Mirror enabled but Master Key not loaded): shows "Unlock Mirror" button → passphrase modal → `mirror_unlock`
- **Disable** flow: confirmation modal "type DISABLE to confirm" → `mirror_disable({ wipe_keys: true })` (Q3 resolution)

### Search (~400 LOC across `hifi/lib/memory-search.js` + `src-tauri/src/mirror/search.rs`)
- New `memory.search` runtime action gains a Mirror-aware path. When `sections.cloud_mirror.enabled && !locked`, the search runs in two parallel paths:
  - **Local path** (existing): hits `mem_items` FTS + vector index
  - **Cloud path** (new): `mirror_search_blobs(query, time_range)` — fetches blobs from the Mirror server in the time range, decrypts each, runs vector similarity locally, returns top-K from the cloud
- **Merge step**: combine both result sets, dedupe by `id` (local row wins if both have the same id), re-rank by similarity score, return top-K
- **Provenance markers** in results: each item carries `source: "local" | "mirror"` so the UI can show a "synced" indicator
- **Cache**: cloud blobs fetched in this session are memoized in-process (per blob_id) to avoid re-fetching on every search
- **Time-range default**: last 30 days. User can extend via a dropdown (1 day / 7 days / 30 days / 90 days / "all time"). Wider ranges are slower (more blobs to fetch + decrypt); UI surfaces this.

### New IPC commands (~60 LOC in `src-tauri/src/commands.rs`)
- `mirror_search_blobs(payload: { query, since, until }) -> { hits: [...] }` — calls `mirror::search::search_cloud_blobs`. The hits include decrypted plaintext.
- `mirror_list_devices() -> { devices: [...] }` — calls `mirror::http::Client::list_devices` (new endpoint, RFC § 5.3 future, OR derived from `list_blobs` device_id grouping for MVP)
- `mirror_rename_device(payload: { device_id, new_name }) -> {}` — calls `Client::rename_device` (RFC Q3 endpoint)
- `mirror_delete_device(payload: { device_id, confirm: "DELETE" }) -> { tombstoned_blobs: count }` — calls `Client::delete_device` (RFC Q2 endpoint), requires typed-text confirmation per the same pattern as `mirror_disable`

### Frontend wiring (~100 LOC across the existing 5 mock files)

5 new actions: `mirror.search_blobs`, `mirror.list_devices`, `mirror.rename_device`, `mirror.delete_device`, plus mock IPC entries for each.

**Out of scope (deferred):**

- **Multi-device Master Key sync via iCloud Keychain** — already supported by Phase 2.1.0 (`save_master_key` uses `kSecAttrSynchronizable: true`). 2.1.4 doesn't add UI for cross-device unlock; the user enters their passphrase once per device that needs it.
- **Recap / digest UI** that shows synced memories from a 2nd device — the search merge already surfaces them, but a dedicated "Memories from your other devices" panel is Phase 2.1.5+.
- **Per-app/URL allowlist editor in the new Cloud Mirror pane** — the existing privacy filter UI from Phase 2.0a is reused; the Mirror pane links to it.
- **Server-side full-text search on metadata** — out of scope; metadata fields don't include text per RFC § 4.2 whitelist.
- **iPhone client** — Phase 2.2.

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| U1 | Settings pane location | New top-level pane "Cloud Mirror" (design D7 confirmation) | Important enough to surface; matches "Privacy" / "Capture" / "Integrations" peers. |
| U2 | Onboarding flow | 4-step modal (URL → registration code → device name → passphrase) | Privacy decisions get deliberate friction; one-shot form would feel pressured. |
| U3 | Passphrase strength validation | Client-side zxcvbn-style with min level 3 (out of 4); server doesn't see it (zero-knowledge) | Must be strong since it's the only key. |
| U4 | Disable confirmation | Typed-text "DISABLE" match (mirrors 2.0d "REPLACE" pattern) | Destructive irreversibility — passphrase wipe means all synced data is unrecoverable. |
| U5 | Device delete confirmation | Typed-text "DELETE" + per-device confirmation (the user must type the device's actual name) | Cross-device action; deleting another device tombstones its blobs server-side — high blast radius. |
| U6 | Search merge strategy | Local + cloud results merged, deduped by `id`, re-ranked by similarity | Single ranked list; user shouldn't have to mentally filter "is this local or cloud." Provenance shown as a badge. |
| U7 | Default time range for cloud search | 30 days | Balances coverage vs speed for typical usage; user can extend. |
| U8 | Cloud-search blob cache | In-process `LruCache<blob_id, decrypted_bytes>` capped at 64MB | Avoids re-fetching blobs across multiple searches in one session; bounded memory. |
| U9 | Device list source | Derive from `GET /v1/blobs?device_id=*` aggregation in MVP; add dedicated `GET /v1/devices` server endpoint as a 2.1.4.1 follow-up if needed | Avoids server-side schema work for MVP. |
| U10 | Sync interval dropdown | Options: 30s / 5min (default) / 30min / 6h / "manual only" | Matches RFC § 8.2 + design S6 cadence options. |
| U11 | Locked state UX | Settings pane shows "Unlock Mirror" prompt; sync engine returns `Mirror locked` errors. NO automatic unlock prompts on app start. | Per OQ4 resolution from 2.1.2 + privacy: don't surprise the user with a passphrase prompt at unexpected times. |
| U12 | Mirror enable/disable toggle | The "Disable Mirror" button is in the Settings pane, gated behind the typed-text confirmation. There's no quick toggle. | Same reasoning as U4: destructive. |
| U13 | Search result provenance | Badge on each hit: "Local", "Synced (this device)", or "Synced (other device: <name>)" | Privacy transparency: the user always knows where a result came from. |
| U14 | Naming | spec `2026-05-07-mirror-search-and-settings-ui-design.md`; plan to follow as `2026-05-07-mirror-search-and-settings-ui.md`; branch `feat/cloud-2-1-4-search-and-settings-ui` | Mirrors 2.1.x cadence. |

## 5. Module Layout

### 5.1 `src-tauri/src/mirror/search.rs` (new, ~250 LOC)

```rust
//! Split-architecture search: fetch encrypted blobs from the Mirror server
//! in a time range, decrypt locally with MEK, run vector similarity in-process,
//! merge with local results, return ranked hits.
//! See spec docs/superpowers/specs/2026-05-07-mirror-search-and-settings-ui-design.md.

pub(crate) struct CloudSearchHit {
  pub blob_id: String,
  pub device_id: String,
  pub mem_item: MemItemPlaintext,  // matches the wire format (RFC § 4.1)
  pub similarity: f32,
  pub source: HitSource,  // "synced" with sub-tags
}

pub(crate) async fn search_cloud_blobs(
  query: &str,
  since: i64,  // unix ms
  until: i64,  // unix ms
  client: &http::Client,
  mek: &MEK,
  embedding_model: &dyn EmbeddingFn,  // local model that embeds the query
) -> Result<Vec<CloudSearchHit>, String>;

// Pure helpers — testable without a real client.
fn build_query_embedding(query: &str, model: &dyn EmbeddingFn) -> Vec<f32>;
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32;
fn rank_and_truncate(hits: Vec<CloudSearchHit>, k: usize) -> Vec<CloudSearchHit>;
```

The cache is a separate global:

```rust
static BLOB_CACHE: OnceLock<Mutex<LruCache<String, Vec<u8>>>> = OnceLock::new();
fn blob_cache() -> &'static Mutex<LruCache<String, Vec<u8>>>;
```

64MB cap. Evicts least-recently-used.

### 5.2 `src-tauri/src/commands.rs` additions (~60 LOC, 4 new commands)

`mirror_search_blobs`, `mirror_list_devices`, `mirror_rename_device`, `mirror_delete_device`. Each is async, calls into `mirror::http::Client` or `mirror::search`, returns the standard `{ ok, data }` shape.

### 5.3 `src-tauri/src/mirror/http.rs` additions (~80 LOC)

3 new methods on `Client`:
- `rename_device(id, new_name) -> DeviceRecord` (RFC Q3 endpoint)
- `delete_device(id) -> { tombstoned_blobs: u64 }` (RFC Q2 endpoint)
- `list_blobs_grouped_by_device(...)` helper (or call `list_blobs_cursor` and group client-side)

The `list_devices` IPC may be backed by a future `GET /v1/devices` endpoint (Phase 2.1.4.1), or by aggregating `list_blobs_cursor` responses for MVP (U9 resolution).

### 5.4 `hifi/settings-modal.jsx` modifications (~600 LOC)

New pane `PaneCloudMirror`. State machine:
- `Disabled` → onboarding modal
- `Locked` → unlock modal
- `Active` → status + cards (sync controls / devices / privacy filters link)

Each card uses existing modal patterns from 2.0d (REPLACE confirm) and consent-modal (multi-step flow).

### 5.5 `hifi/lib/memory-search.js` modifications (~150 LOC)

`runSearch(query, opts)` checks `cloud_mirror.enabled && !locked`. If yes, dispatches BOTH `memory.search` (local) and `memory.search_blobs` (cloud) in parallel. On both resolved (or one rejected with timeout), merges and dedupes results.

Local-only fallback if cloud search times out or errors — never block the UI on cloud.

### 5.6 Frontend mocks (`hifi/lib/{shogun-api,action-registry,ipc-client}.js` + `hifi/app.jsx::mockIpcInvoke` + `hifi/action-map.md`)

Add 4 new mock cases for `mirror_search_blobs`, `mirror_list_devices`, `mirror_rename_device`, `mirror_delete_device`. Each returns `{ stub: true, ... }`.

## 6. Test Strategy

### 6.1 Unit tests (Rust, ~25)

- Cloud search: query embedding determinism (3 tests)
- Cosine similarity correctness (4 tests)
- Rank-and-truncate (3 tests)
- LruCache eviction (3 tests)
- `search_cloud_blobs` against a mockito-backed Mirror server (8 tests)
- New http.rs methods (4 tests for rename / delete / list)

### 6.2 Frontend unit tests (Playwright, ~10)

- Settings → Cloud Mirror pane renders correctly in each state (Disabled / Locked / Active)
- Onboarding modal validates passphrase strength
- DISABLE typed-text confirmation works
- Device delete typed-text confirmation works
- Search returns merged local + cloud results in mock mode

### 6.3 Manual smoke (user-driven)

- End-to-end: launch app → enable Mirror with self-hosted server (PR #56's binary) → set passphrase → sync some memories → search → see provenance badges
- Multi-device: use the same passphrase on a 2nd Mac → see synced memories from device 1 in search results, with "Synced (other device: <Mac1 name>)" badge
- Disable: type DISABLE → all local data preserved, Mirror sync stops, master key wiped from Keychain

## 7. Risks and Mitigations

- **Cloud search latency**: fetching N blobs from the Mirror + decrypting takes time. Default time range is 30 days; user can dial down. The local-first merge means results trickle in: local hits show immediately, cloud hits append as they arrive. Document the streaming behavior.
- **Cache memory**: 64MB cap is conservative. Embeddings + plaintext for ~10K blobs at ~6KB each = 60MB. Cap protects against runaway memory if blobs are larger than expected.
- **Multi-device search dedupe**: if device A and device B both have the same `mem_items.id` (theoretically possible if they both ingested the same row), the merge should pick the one with the latest `created_at`. Document the tiebreaker.
- **Typed-text confirmation fatigue**: 3 separate "type X" modals (Disable, Delete, Reset Stuck). Document each clearly. Consider a single confirm-component that takes a target word as a prop.
- **Embedding model availability**: cloud search requires the embedding model to be loaded. If model load fails, fall back to FTS-only on the local path and skip cloud entirely (cloud blobs have no FTS server-side).

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| `Settings → Cloud Mirror` pane appears for all users (regardless of Mirror state) | manual smoke + frontend test |
| Onboarding flow completes register + unlock | E2E |
| Locked state shows unlock prompt; sync stops | E2E + status check |
| Search returns merged local + cloud results | unit + E2E with mock |
| DISABLE confirmation wipes Master Key | E2E |
| `cargo test -p app` green | full suite |
| `npm run check:rust` / `check:actions` / `check:ipc-mock` green | gates |
| `npm run test:e2e` 30 baseline + new tests pass | full suite |

## 9. Open Questions for Reviewer

These don't block design review but inform implementation:

- **OQ1**: Server-side `GET /v1/devices` endpoint (Phase 2.1.4.1 if needed) vs client-side aggregation of blob-list responses? Defaulting to **client-side aggregation** for MVP simplicity; add server endpoint when device count exceeds the threshold where pagination matters (~50+).
- **OQ2**: Should the Cloud Mirror pane include a Settings → Privacy → app/URL allowlist link or duplicate the editor? Defaulting to **link** to avoid divergent state. The privacy filter is shared with Phase 2.0a's capture filter (a row excluded from capture is also excluded from sync).
- **OQ3**: How does the user discover the Mirror feature? A first-launch nudge? A link in the existing Privacy pane? Defaulting to **link in Privacy pane + a dedicated top-level pane**. No first-launch nudge — Mirror is opt-in and shouldn't surprise users.
- **OQ4**: For multi-device search, when device A is offline (server-side unreachable), should device B's search show A's blobs? Currently A's blobs are CACHED on the server, so yes — but the user might be surprised that "synced from offline device" works. Defaulting to **yes** (it's the whole point of Mirror; it stays accurate even when devices are offline).

These can be flipped at plan-review without re-doing the design.

## 10. What this enables

After 2.1.4 lands, Phase 2.1 is **complete**:

- All four 2.1 sub-phases shipping a working Memory Mirror MVP
- User has full lifecycle control via GUI
- Search is split-architecture with local-first fallback
- The "Memory Mirror MVP" promise is delivered end-to-end

After 2.1 closes, **Phase 2.2 (iPhone client Phase A)** can start. The iPhone client reads from the Mirror via the same HTTP API (RFC), uses iCloud Keychain to unlock the same Master Key, and renders memories with the same provenance badges.
