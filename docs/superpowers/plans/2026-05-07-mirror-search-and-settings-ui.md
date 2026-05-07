# Phase 2.1.4 — Split-Architecture Search + Settings UI Implementation Plan

**Status:** ready (2026-05-07)
**Design:** `docs/superpowers/specs/2026-05-07-mirror-search-and-settings-ui-design.md` (merged on main)
**Branch:** `feat/cloud-2-1-4-search-and-settings-ui` (to be created from main)
**Predecessors merged:** Phase 2.1.0 (encryption), 2.1.1 (RFC), 2.1.2 (sync engine), 2.1.3 (server) all on main as of this plan.
**OQ resolutions:** OQ1–OQ4 confirmed at the design defaults — client-side device aggregation; Privacy pane link (no duplicate editor); Privacy + dedicated top-level pane (no first-launch nudge); offline-device blob visibility = yes.

---

## 1. Pre-flight verification (controller, before T1)

Run all gates on a fresh `feat/cloud-2-1-4-search-and-settings-ui` branch off `main` to confirm the baseline is green:

```
cargo fmt --all -- --check
cargo build -p app
cargo test -p app --tests --skip kioku_extraction --no-fail-fast
cargo build --release --manifest-path mirror-server/Cargo.toml
npm run check:rust
npm run check:actions
npm run check:ipc-mock
npm run typecheck:hifi
```

If any fails, **stop and fix on a separate branch first.** This plan assumes a green baseline.

Also confirm:
- `src-tauri/src/embeddings.rs::embed_one(text: &str) -> Result<Vec<f32>, String>` exists (verified — used at `memory_store.rs:1287`).
- Server endpoints `PUT /v1/devices/:id` (rename) and `DELETE /v1/devices/:id` (delete) exist (verified at `mirror-server/src/routes/mod.rs:25-27`).
- No `GET /v1/devices` exists (confirmed — design U9 mandates client-side aggregation from `list_blobs_cursor`).

---

## 2. Tasks (subagent-driven-development)

Each task gets a fresh implementer subagent → spec compliance review → code quality review. Tasks are mostly sequential; T4 + T5 can run after T3 in either order (both depend on the IPC commands existing).

---

### T1 — backend: `mirror::search` module (cloud search engine)

**Files:**
- New: `src-tauri/src/mirror/search.rs` (~250 LOC)
- `src-tauri/src/mirror/mod.rs` — add `pub(crate) mod search;`
- `src-tauri/Cargo.toml` — add `lru = "0.12"`

**Implementation:**

1. **`MemItemPlaintext`** — Serde-deserialize struct matching the wire format the Mac client uploads (per RFC § 4.1's `mem_items.v1` schema). Fields: `id: String`, `kind: String`, `text: String`, `created_at: i64`, `device_id: String`, optional `embedding: Option<Vec<f32>>`. The encryption envelope's plaintext is JSON-deserialized into this struct.

2. **`CloudSearchHit`**:
   ```rust
   pub(crate) struct CloudSearchHit {
       pub blob_id: String,
       pub device_id: String,
       pub mem_item: MemItemPlaintext,
       pub similarity: f32,
       pub source: HitSource,
   }
   pub(crate) enum HitSource {
       Local,
       MirrorThisDevice,
       MirrorOtherDevice { device_name: String },
   }
   ```

3. **Pure helpers (testable without real client):**
   - `cosine_similarity(a: &[f32], b: &[f32]) -> f32` — returns 0.0 if either is empty or differing lengths.
   - `rank_and_truncate(hits: Vec<CloudSearchHit>, k: usize) -> Vec<CloudSearchHit>` — sorts desc by similarity, truncates to k.

4. **`search_cloud_blobs(query, since, until, client, mek, this_device_id, device_name_lookup) -> Result<Vec<CloudSearchHit>, String>`:**
   - Embed query: `embeddings::embed_one(query).await`. On error, propagate with prefix `cloud-search: embed failed: <e>` so the merge layer can fall back to local-only.
   - Call `client.list_blobs_time_range(since, until)` to get blob list.
   - For each blob_id (excluding tombstoned): check cache; if miss, `client.fetch_blob(blob_id)` → decrypt with `crypto::decrypt_with_ad(mek, ...)` → cache the plaintext bytes.
   - Deserialize plaintext as `MemItemPlaintext`. If the blob has no `embedding`, skip (cannot rank).
   - Compute cosine similarity between query embedding and stored embedding.
   - Build `CloudSearchHit` with `source = HitSource::MirrorThisDevice` if `mem_item.device_id == this_device_id`, else `HitSource::MirrorOtherDevice { device_name: device_name_lookup(mem_item.device_id) }`.
   - Return all hits unranked — caller (T5 frontend merge) handles truncation.

5. **Blob cache (LRU, 64 MB):**
   ```rust
   static BLOB_CACHE: OnceLock<Mutex<LruCache<String, Vec<u8>>>> = OnceLock::new();
   fn blob_cache() -> &'static Mutex<LruCache<String, Vec<u8>>>;
   ```
   Cap by entry count: 64 MB ÷ avg 6 KB plaintext = ~10K entries. Use `LruCache::new(NonZeroUsize::new(10_000).unwrap())`. The 64 MB cap is documented in a comment but enforced indirectly via entry count; this is intentional simplicity per design U8.

6. **AD construction for decrypt:** must match exactly what the sync engine wrote (sorted_json_for_ad over `{ blob_id, device_id, schema, version, kinds, captured_at_minute, provenance }`). Reuse `mirror::sync::sorted_json_for_ad` if it's `pub(crate)`, else lift it to `mirror::crypto` and re-export.

**Tests (in `#[cfg(test)] mod tests`):** ~17 tests
- 3 cosine_similarity (orthogonal, parallel, mismatched length)
- 3 rank_and_truncate (k=0, k=N, k>N)
- 4 LRU cache (hit, miss, eviction, get-promotes-to-most-recent)
- 4 search_cloud_blobs end-to-end via mockito mocking the server (single hit, multiple hits with re-rank, tombstoned-skipped, no-embedding-skipped)
- 3 source classification (this device, other device, fallback when name lookup returns None)

**Gates after T1:**
```
cargo build -p app
cargo test -p app --tests --skip kioku_extraction mirror::search
cargo fmt --all -- --check
```

**DoD:** All tests green. `mirror::search::search_cloud_blobs` is `pub(crate)`. No `unwrap()` in non-test code.

---

### T2 — backend: `mirror::http::Client` device methods

**Files:**
- `src-tauri/src/mirror/http.rs` — add 3 methods + types

**Implementation:**

1. **`DeviceRecord`** struct (Serde): `device_id: String`, `device_name: String`, `created_at: i64`. Used by `rename_device` response and `list_devices` aggregation.

2. **`async fn rename_device(&self, device_id: &str, new_name: &str) -> Result<DeviceRecord, String>`**
   - PUT `/v1/devices/{device_id}` with body `{ "device_name": new_name }`, Bearer auth.
   - Map 404 → `Err("device-not-found")`, 403 → `Err("forbidden")`, others → `Err(format!("rename: HTTP {status}"))`.

3. **`async fn delete_device(&self, device_id: &str) -> Result<u64, String>`**
   - DELETE `/v1/devices/{device_id}`, Bearer auth.
   - Returns the `tombstoned_blobs: u64` count from the response body (server already returns this per `mirror-server/src/routes/devices.rs:152`).
   - Map errors as above.

4. **`async fn list_devices_by_aggregation(&self, since_days: u32) -> Result<Vec<DeviceSummary>, String>`** (per design U9 — derive client-side):
   - Calls `list_blobs_time_range(now - since_days, now)` exhaustively (drain cursor).
   - Groups by `envelope.device_id`, counts blobs per device.
   - Returns `Vec<DeviceSummary { device_id, blob_count, latest_created_at }>`. Note: this can NOT return `device_name` (server doesn't expose names except on register response). The frontend either caches names from the `mirror_register` response, or shows `device_id[..8]` until rename. Document this trade-off in the docstring.

**Tests (mockito):** 4 tests
- rename_device 200 → DeviceRecord
- rename_device 404 → "device-not-found"
- delete_device 200 → tombstoned count
- list_devices_by_aggregation groups multi-device blobs correctly

**Gates after T2:**
```
cargo build -p app
cargo test -p app --tests --skip kioku_extraction mirror::http
```

**DoD:** All tests green. Methods follow existing `Client` style (timeout, error mapping).

---

### T3 — backend: 4 IPC commands + mock JSON

**Files:**
- `src-tauri/src/commands.rs` (or wherever `mirror_*` IPC commands live — locate by grepping for existing `mirror_register`)
- `src-tauri/src/lib.rs` — register the new commands in `tauri::generate_handler![...]`
- `hifi/lib/ipc-mock.json` — add 4 mock entries
- `hifi/action-map.md` — document the 4 new actions

**Implementation:**

1. **`mirror_search_blobs(payload: { query: String, since_ms: i64, until_ms: i64 }) -> { hits: Vec<CloudSearchHitDto> }`**
   - Loads MEK (returns `{ ok: false, code: "locked" }` if unlocked is false).
   - Loads HTTP client + this device's id from sync engine state.
   - Calls `mirror::search::search_cloud_blobs(...)`.
   - Maps `CloudSearchHit` → DTO that the frontend can render: `{ id, kind, text, created_at, device_id, source: "local"|"mirror-self"|"mirror-other", device_name? }`.
   - Returns `{ ok: true, data: { hits } }`.

2. **`mirror_list_devices() -> { devices: Vec<DeviceDto> }`**
   - Calls `Client::list_devices_by_aggregation(30)`.
   - Returns `{ devices: [{ device_id, blob_count, latest_created_at, is_this_device: bool }] }`.
   - The this-device flag is computed against the local `device_id` from sync state.

3. **`mirror_rename_device(payload: { device_id: String, new_name: String }) -> { device: DeviceRecord }`**
   - Validates `new_name.len() <= 64` and is non-empty (server-side will also validate; this is defensive UX).
   - Calls `Client::rename_device`.

4. **`mirror_delete_device(payload: { device_id: String, confirm: String }) -> { tombstoned_blobs: u64 }`**
   - Server-side `confirm` check: `confirm == "DELETE"` (typed-text per U5). Reject with `code: "confirm-mismatch"` otherwise.
   - Calls `Client::delete_device`.

**`ipc-mock.json` entries:**
- `mirror_search_blobs` → `{ ok: true, data: { hits: [ { id: "stub-1", kind: "screen", text: "Stub mirror hit", created_at: 1715000000000, device_id: "stub-mac-2", source: "mirror-other", device_name: "Stub Mac 2" } ] } }`
- `mirror_list_devices` → 2 devices (this + 1 other) with stub counts
- `mirror_rename_device` → success with renamed DeviceRecord
- `mirror_delete_device` → `{ tombstoned_blobs: 5 }`

**Tests:** Rust unit tests are covered by T1+T2; T3 is mostly wiring. Add 1 smoke test per command verifying error paths (locked, validation rejection).

**Gates after T3:**
```
cargo build -p app
cargo test -p app --tests --skip kioku_extraction mirror_
npm run check:ipc-mock
npm run check:actions
```

**DoD:** All gates green. The 4 commands appear in `tauri::generate_handler!`. ipc-mock matches command signatures.

---

### T4 — frontend: `memory-search.js` merge logic + frontend mocks for new actions

**Files:**
- `hifi/lib/memory-search.js` (~150 LOC modifications)
- `hifi/lib/action-registry.js` — register 4 new actions
- `hifi/lib/ipc-client.js` — add IPC bindings
- `hifi/lib/shogun-api.js` — public façade wrapping the IPC commands
- `hifi/app.jsx::mockIpcInvoke` — mock dispatch entries

**Implementation:**

1. **Action registrations** in `action-registry.js`:
   - `mirror.search_blobs` → IPC `mirror_search_blobs`
   - `mirror.list_devices` → IPC `mirror_list_devices`
   - `mirror.rename_device` → IPC `mirror_rename_device`
   - `mirror.delete_device` → IPC `mirror_delete_device`
   - All four require `cloud_mirror.enabled === true` precondition (registry preconditions per existing pattern in 2.1.2).

2. **`memory-search.js` enhancement:**
   - Existing function (probably `runMemorySearch(query, opts)`) gains a `cloudEnabled` check (read from `mirror_status`).
   - When cloud is enabled & not locked: dispatch BOTH `memory.search` (local) and `mirror.search_blobs` (cloud) via `Promise.allSettled`.
   - Cloud has a 5-second timeout (overrides the IPC default if longer); on timeout or cloud rejection, log warning and fall back to local-only.
   - Merge step:
     - Combine both result arrays.
     - Dedupe by `id`: if same id appears local + cloud, prefer the one with the larger `created_at` (per Risks tiebreaker in design § 7).
     - Sort by similarity desc; if missing similarity (local FTS-only result), use 0.0 so cloud-ranked wins ties.
     - Truncate to existing `top_k` (default unchanged).
   - Return shape: same as before but each hit gets `source: "local" | "mirror-self" | "mirror-other"` and `device_name?`.

3. **Mock IPC entries** in `mockIpcInvoke` — copy `ipc-mock.json` entries.

**Tests:**
- Vitest/Playwright unit tests for the merge function: same-id dedupe picks newer, score-based ranking, cloud-timeout falls back to local-only, cloud-disabled skips cloud entirely.

**Gates after T4:**
```
npm run typecheck:hifi
npm run check:actions
npm run check:ipc-mock
npm run test:hifi   # if exists; else verified by T6 Playwright pass
```

**DoD:** All registered actions are reachable. Merge is deterministic. Cloud failure never blocks local results.

---

### T5 — frontend: `Settings → Cloud Mirror` pane (Disabled / Locked / Active)

**Files:**
- `hifi/settings-modal.jsx` — add new `PaneCloudMirror` component (~600 LOC)
- `hifi/settings-modal.css` (or inline) — styles per existing tokens
- `hifi/lib/zxcvbn-strength.js` (new, ~30 LOC) — minimal local strength estimator (no network dep). Can be a lookup-table proxy: length × variety → 0..4.

**Implementation outline:**

1. **State machine derivation:**
   - On pane mount: call `mirror_status`. Read `enabled`, `locked`, `last_sync_at`, `queue_depth`, `last_error`.
   - 3 sub-views: `Disabled` (enabled=false), `Locked` (enabled=true, locked=true), `Active` (enabled=true, locked=false).

2. **`Disabled` view:**
   - Single primary CTA: "Enable Cloud Mirror". Subtext explaining what it does.
   - Click → opens `MirrorOnboardingModal` (4-step wizard: Server URL → Registration code → Device name → Passphrase + confirm).
   - Each step has Back/Next; Next disabled until validation passes.
   - Passphrase step: 2 inputs + zxcvbn strength bar. Min strength 3 to proceed.
   - Final step: "Set up Mirror" → `mirror_register` → `mirror_unlock` → on success, refresh the pane state.

3. **`Locked` view:**
   - Status banner: "Mirror enabled but locked. Enter your passphrase to resume sync."
   - Passphrase input + "Unlock" button → `mirror_unlock`.

4. **`Active` view:**
   - **Status row** at top: last sync time (relative), queue depth badge, last error if any (with retry button via `mirror_reset_stuck`).
   - **Sync controls card:**
     - Toggle: "Sync paused" (calls `mirror_pause` if exists, else `mirror_disable`-with-keep-keys; if neither, defer with TODO comment).
     - Dropdown: "Sync interval" — 30s / 5min / 30min / 6h / Manual only (per U10). Value persisted to settings.
     - Button: "Sync now" → `mirror_sync_now`.
   - **Devices card:**
     - Calls `mirror.list_devices` on mount + on rename/delete.
     - Each row: device name (or `device_id[..8]` if no name cached), blob count, latest sync time, "Rename" button, "Delete" button.
     - This-device row gets a "(this device)" marker and Delete is disabled (or shows "Use Disable Mirror instead").
     - Rename modal: input + Save → `mirror.rename_device`.
     - Delete modal: typed-text confirmation matching the device's actual name (per U5); reject if mismatch.
   - **Privacy filters link:** read-only summary of allowlist counts + "Edit in Privacy pane" button (per U2).
   - **Disable Mirror button** at the bottom in a danger-styled section: opens DISABLE typed-text confirmation modal → `mirror_disable({ wipe_keys: true })`.

5. **Reusable confirmation component:**
   - `<ConfirmTypedText word="DISABLE" onConfirm={...} description={...} />`. Used by Disable + Delete Device flows (avoids 2x duplication of typed-text logic).

**Acceptance:** Each of the 3 views renders without errors in mock mode. Flows transition correctly when mock IPC returns success.

**Gates after T5:**
```
npm run typecheck:hifi
npm run lint:hifi   # if exists
npm run test:e2e -- --headed=false settings-cloud-mirror   # T6 covers this
```

**DoD:** Pane renders in mock mode. All buttons reachable. No console errors.

---

### T6 — frontend: Playwright E2E tests

**Files:**
- `tests/e2e/settings-cloud-mirror.spec.js` (new) — ~10 tests

**Test list:**
1. Settings → Cloud Mirror pane visible to all users (disabled state)
2. Onboarding wizard step 1: server URL validation (empty rejected, http rejected outside localhost, https accepted)
3. Onboarding wizard step 4: passphrase confirm-mismatch rejected
4. Onboarding wizard step 4: weak passphrase rejected (zxcvbn level <3)
5. Onboarding success → pane shows Active state
6. Locked state shows unlock prompt; submit unlocks
7. Active state shows status row + 3 cards
8. Devices list renders 2 devices in mock mode
9. Device delete typed-text confirmation: wrong word disables button, correct word enables it
10. DISABLE typed-text confirmation: "DISABLE" exactly required (case-sensitive)

**Gates after T6:**
```
npm run test:e2e
```

All 30 baseline + 10 new tests pass.

**DoD:** test:e2e green. No flakes (each new spec passes 3 consecutive runs locally).

---

### T7 — manual smoke verification (controller, before final review)

After T1–T6 are merged into the feature branch, run end-to-end verification (per design § 6.3):

1. Build mirror-server: `cargo build --release --manifest-path mirror-server/Cargo.toml`
2. Start it: `mirror-server/target/release/shogun-mirror-server` with a test config (account_id, registration_code).
3. Launch the Mac app (`npm run tauri dev`).
4. Settings → Cloud Mirror → Enable. Walk the onboarding wizard. Confirm sync starts.
5. Trigger a memory capture; verify it appears in the server's data dir within ~30s.
6. Run a search query. Confirm the result list includes a "Synced (this device)" badge on the just-uploaded item.
7. Edit `~/Library/Application Support/com.shogun.app/settings.json` and corrupt the master_key marker — confirm the pane shifts to Locked. Unlock via passphrase.
8. Click DISABLE → type DISABLE → confirm. Verify the master_key entry is removed from Keychain (use `security find-generic-password -s 'shogun.mirror.master_key'`).

If any step fails, file a follow-up issue and decide whether to block the PR or ship with a known issue documented.

**DoD:** All 8 steps pass without unexpected errors or data loss. Findings documented in the PR description.

---

## 3. Final review (controller, after T7)

Dispatch the `superpowers:code-reviewer` subagent for the entire branch:
- Diff: `git log main..HEAD --stat`
- Spec compliance: every § 8 acceptance criterion verified
- Code quality: cohesion, error handling, no dead code, no over-engineering
- Test coverage: ~25 Rust unit + 10 frontend = baseline met

Address all blocking issues; non-blocking suggestions become follow-up issues.

---

## 4. PR creation

Title: `feat(cloud-mirror): Phase 2.1.4 — split-arch search + Settings UI (Memory Mirror MVP completion)`
Body sections:
- **Summary:** what 2.1.4 delivers (close the MVP loop)
- **Tasks T1–T7:** brief outcome per task with commit refs
- **Test plan:** the verification matrix from § 8
- **Manual smoke results:** outcome of T7
- **OQ resolutions:** OQ1–OQ4 confirmed at design defaults
- **Follow-ups filed:** any deferred issues

Mark Ready immediately if verify is green; otherwise wait.

---

## 5. Out-of-scope reminders (do not implement in this PR)

These are deferred to 2.1.4.1+ or 2.1.5:
- Server-side `GET /v1/devices` endpoint (OQ1 deferred).
- "Memories from your other devices" dedicated panel (recap-style UI).
- Per-app/URL allowlist editor inside Cloud Mirror pane (linked, not duplicated, per OQ2).
- iCloud Keychain cross-device unlock UI (already supported by 2.1.0; UI deferred).
- Server-side metadata FTS (RFC § 4.2 whitelist forbids text fields; design § 3 marks out-of-scope).

If during implementation a subagent flags one of these as needed for the MVP loop, escalate to controller before expanding scope.

---

## 6. Estimated effort

- T1: ~3 hours (spec → impl → review iterations)
- T2: ~1.5 hours
- T3: ~1.5 hours
- T4: ~2 hours
- T5: ~5 hours (UI is the largest single unit)
- T6: ~2 hours
- T7: ~1 hour controller-driven manual smoke
- Final review + PR: ~1 hour

Total ~17 hours of subagent work for an MVP-quality slice. Compaction-resistant: each task commits a discrete unit reviewable in isolation.
