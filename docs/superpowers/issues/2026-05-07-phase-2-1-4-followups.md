# Phase 2.1.4 Follow-ups

Items intentionally deferred from the Cloud Mirror MVP. None block the T5 PR.

## 1. Device-name default = hostname (was IMP-1 from T5 review)

**Current**: every newly onboarded device defaults to "My Mac".
**Spec**: design § 3 wanted `<hostname>` from `os::hostname`.
**Why deferred**: requires a new IPC (`system_hostname`) or extending `mirror_status`'s response shape. Out of T5's purely-frontend scope.
**Next step**: small backend task to add the IPC, then plumb into MirrorOnboardingModal step 3 placeholder.

## 2. Real zxcvbn-style passphrase strength meter (was IMP-2 from T5 review)

**Current**: heuristic length × charset variety scoring. Scores `Password1234!` as Strong (4/4).
**Spec**: U3 calls for client-side zxcvbn-style with min level 3.
**Why deferred**: vendoring zxcvbn-ts adds ~12KB and a build dep; would change the script-load profile.
**Next step**: either vendor zxcvbn-ts under `hifi/vendor/`, or add a deny-list of top-200 common patterns inline.

## 3. Sync-interval dropdown (was IMP-6 from T5 review)

**Current**: fixed 5-minute interval; UI says "configurable in 2.1.5+".
**Spec**: U10 enumerates 30s / 5min / 30min / 6h / manual only.
**Why deferred**: requires a new `mirror_set_sync_interval` IPC + sync-engine config persistence + scheduler reload. Multi-file backend work.
**Next step**: small backend ticket; the UI dropdown is already sketched in the design doc § 5.4.

## 4. `mirror_search_blobs` should run CPU-bound work on `spawn_blocking` (final review IMP-1)

**Current**: `commands.rs::mirror_search_blobs` does decrypt + JSON parse + base64 + cosine inline on the Tauri async runtime. For ~500 blobs in a 30-day window the per-call CPU cost can wedge other IPC for hundreds of ms. The frontend's 5s `CLOUD_TIMEOUT_MS` rescues UX but doesn't prevent runtime starvation.
**Reference**: `mirror_sync_now` and `mirror_reset_stuck` already use the `spawn_blocking` pattern.
**Next step**: split `search_cloud_blobs` into list-async (network) + decrypt-blocking (CPU), or wrap the whole call once the inner loop is `Send`-friendly. Audit the cloud-search path under realistic blob counts (use the smoke script + a 500-blob seed).

## 5. Merge-layer automated coverage gap (final review nit 7)

**Current**: `memory-search.js` exposes `_internals` (dedupeById, rankBySimilarity, normalizeLocalHit, normalizeCloudHit, filterCloudHitsByKinds, withTimeout) for tests, but no Playwright/Vitest spec consumes them. Spec § 8 acceptance criterion "Search returns merged local + cloud results | unit + E2E with mock" is partly verified (Rust path covers cloud, Playwright covers UI), but the merge logic itself (dedupe by id, tie-break, rank, kinds-filter) is verified only by manual inspection / inline smoke during T4 implementation.
**Why deferred**: not blocking for MVP; the merge logic is small and well-commented.
**Next step**: add a Playwright spec under `tests/e2e/cloud-mirror.spec.js` (or a new file) that mocks both `memory.search` and `mirror.search_blobs`, drives the action-registry path, and asserts the merged + deduped result shape. ~30 LOC.
