# SHOGUN Phase 2.1 — Memory Mirror MVP Architecture

**Status:** draft (2026-05-06) — awaiting user review
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 3 (Encryption Boundary), § 1 (Cloud Mirror in the diagram), § 6 Phase 2.1
**Predecessors:** all four 2.0 prerequisites (sensitive filter, sync_status column, emergency stop tray, memory export/import) are merged or in flight

---

## 1. Why this is a sub-architecture spec (not a single plan)

Phase 2.1 in the master spec is **five distinct components**:

1. Encryption boundary (Master Key, MEK/JEK/REK, iCloud Keychain)
2. Cloud Mirror server backend (encrypted blob storage)
3. Sync engine (Mac → Cloud Mirror diff)
4. Search via split architecture (client-side ANN over encrypted blobs)
5. Settings UI (Mirror enable/disable, app/URL allowlist)

That's far too much for one "phase" in the way 2.0a/2.0b/2.0c/2.0d were. Each piece has its own design questions, its own dependencies, and its own failure modes. Bundling them would mean either an unreviewable PR or a months-long branch.

This document **decomposes 2.1 into sub-phases** (2.1.0 through 2.1.4) and decides the order. Detailed design + implementation plan for each sub-phase will be drafted as it becomes time to start that sub-phase, mirroring how the 2.0 prerequisites were handled.

## 2. Decomposition

Five sub-phases, each ~1–3 PRs, sequenced by dependency:

### Phase 2.1.0 — Encryption primitives (foundation)

The crypto layer that everything else depends on. **No sync, no server, no UI.** Just the building blocks.

- **Master Key derivation** — Argon2id from a user-chosen passphrase (10+ chars, with strength meter). Output: 32-byte key.
- **Key hierarchy** — MEK (Memory Encryption Key), JEK (Job Encryption Key), REK (Result Encryption Key). All derived from Master Key via HKDF-SHA256 with distinct info strings. Master Key never leaves keychain.
- **iCloud Keychain integration** — store / retrieve / delete the Master Key entry. macOS-only first; cross-device sync handled by the OS.
- **Symmetric encrypt / decrypt helpers** — XChaCha20-Poly1305 (AEAD) with random 24-byte nonces. Helper functions take key + plaintext, return `{ ciphertext, nonce, tag }`.
- **Key rotation primitives** — re-derive MEK from a fresh Master Key passphrase change. Old MEK retained until re-encrypt completes.
- **No new IPC commands** — entirely an internal Rust module exposing safe APIs to later phases.
- **Tests** — round-trip, bad passphrase, keychain read/write, key rotation correctness.

**Why first**: nothing else in 2.1 can be designed concretely without these primitives. Encryption decisions (algorithm, key length, KDF parameters) should be locked before sync code is written.

**Estimated size**: ~1 PR, ~600 LOC + 30 tests.

### Phase 2.1.1 — Cloud Mirror protocol RFC (no implementation)

A design-only sub-phase: **document the wire format** for encrypted blobs and the HTTP API the Mac client will use to upload / list / fetch. No code yet.

- **Blob format** — `version`, `nonce`, `ciphertext`, `tag` packed in a binary envelope (or JSON if simpler — TBD). Metadata that can stay plaintext: `created_at`, `app_id_hash`, `provenance`. Everything else encrypted.
- **HTTP API** — `POST /blobs` (upload one), `GET /blobs?after=<ts>&before=<ts>` (list IDs in time range), `GET /blobs/<id>` (fetch single). No `DELETE` MVP — soft-delete via tombstone blobs.
- **Auth** — bearer token from a per-device registration flow. Token rotation (TBD: per-session or per-device).
- **Server-side guarantees** — what the server CANNOT do (decrypt, search content, observe non-metadata). Documented as security invariants.
- **Failure modes** — partial upload, dup keys, time-skew, replay attack mitigations.

**Why second**: locks the protocol so Phase 2.1.2 (sync engine) and Phase 2.1.3 (server backend) can be developed in parallel without blocking each other.

**Estimated size**: design doc only, ~1500 lines. No code.

### Phase 2.1.2 — Sync engine (Mac side)

The client-side queue + uploader that turns local `mem_items` rows into encrypted blobs and pushes them to a Cloud Mirror endpoint.

- **Queue** — uses the new `sync_status` column from 2.0b. New ingest writes `local_only`; sync engine flips eligible rows to `pending_upload` based on user opt-in.
- **Diff computation** — track which rows have been synced via `cloud_index_id` column (added here, not in 2.0b — deliberate D1 deferral from that phase). Re-syncs are id-stable.
- **Encrypted upload** — for each eligible row, encrypt with MEK, build the blob envelope, POST to the Mirror URL configured in Settings. On 200, set `sync_status='synced'` and `cloud_index_id`. On 4xx/5xx, retry with exponential backoff.
- **Background scheduler** — runs every N minutes (configurable), batches up to M rows per cycle. Pause-safe: if `sections.capture.paused`, sync also pauses.
- **No search yet** — only upload. Read-back lands in 2.1.4.

**Estimated size**: ~2 PRs. First PR: queue + scheduler skeleton + tests against a mock server. Second PR: real HTTP integration + retry logic + observability.

### Phase 2.1.3 — Cloud Mirror server reference implementation

A small Rust microservice (or Tauri-side server, or hosted backend — TBD) that implements the protocol from 2.1.1.

- **Storage** — initially flat-file backed by S3/R2/local-disk depending on deployment. The encryption boundary means the server NEVER sees plaintext, so the storage primitive is dumb.
- **Auth** — verify bearer tokens against a device registry. TODO: how does device registration work? (Out of scope for this architecture spec; revisit in 2.1.3 detailed design.)
- **Operational** — logging (no content), metrics, rate limits.

**Why parallel with 2.1.2**: per the protocol locked in 2.1.1, they can be developed independently. Either the Mac client uses a public dev backend or runs the server locally for testing.

**Estimated size**: ~2 PRs. Could be the same project as the Mac code or a separate repo.

### Phase 2.1.4 — Search via split architecture + Settings UI

Closes the Memory Mirror loop: lets the user actually use synced memories from the Mac.

- **Split-architecture search** — when a search runs and the local `mem_items` index is incomplete (e.g., recent memories purged for storage reasons, or this is a fresh device that hasn't synced everything), fetch a time-range of blobs from the Mirror, decrypt locally, run vector similarity, return merged top-K.
- **Settings UI** — `Settings → Cloud Mirror`:
  - Toggle: enable Mirror (off by default)
  - Master passphrase entry (set / change)
  - Per-app / per-URL allowlist (which captures opt into sync, mirroring the existing 2.0a privacy filter UI)
  - Status indicator: last successful sync, queue depth, errors
- **Manual ops** — "Sync now" button, "View what's in the cloud" pane, "Wipe Mirror" button (asks for passphrase confirm)

**Estimated size**: ~3 PRs (search, settings UI, manual ops separately).

## 3. Total scope estimate

- **Sub-phases**: 5
- **PRs**: 8–10 across all sub-phases
- **LOC**: ~5,000 net additions across Rust + TS
- **Calendar time** (rough, single-developer): 6–10 weeks
- **Critical path**: 2.1.0 → 2.1.1 → (2.1.2 + 2.1.3 in parallel) → 2.1.4

Compare to Phase 2.0 (4 sub-phases, all merged or in flight): 2.0 was scoped to "prerequisites" — schema + UX + portability. 2.1 is the actual cloud feature, materially larger.

## 4. Locked architectural decisions

These come from the master spec and are NOT up for re-debate in 2.1.0 onwards:

| # | Decision | Source | Rationale |
|---|----------|--------|-----------|
| A1 | Server **cannot decrypt** user data | Master § 0 principle 2 | Hard guarantee. Any change to this is a privacy-policy change, not a tech change. |
| A2 | **Embeddings + structured metadata only** in cloud — never raw a11y stream | Master § 0 principle 3 | Compromise for searchability; raw text stays local. |
| A3 | Cloud features are **opt-in** | Master § 0 principle 4 | Default-off. The 2.0c emergency stop is a hard kill switch. |
| A4 | Master Key from **passphrase via Argon2id**, stored in **iCloud Keychain** | Master § 3.1 | Apple-ecosystem-first MVP; non-Apple is a Phase 4 concern. |
| A5 | **Searchable encryption** via encrypted-ANN with client-side query encryption (or HE-lite — TBD in 2.1.4) | Master § 3.2 | Embedding-based search is the core UX; pure E2EE without searchability is unacceptable. |
| A6 | **No raw text** crosses the encryption boundary outbound | Master § 7.1 | Even encrypted. Raw text → embedding happens locally before any blob is built. |
| A7 | Each Mirror operation has **per-device server-issued** credentials | Master § 7 | Token rotation; revocable per device. |

## 5. Decisions deferred to per-sub-phase design

These are real choices but don't block decomposition:

- **D1**: KDF parameters (Argon2id memory / iterations) — locked in 2.1.0 design. Recommendation: 64MB / 3 iterations as a starting point, calibrated against macOS dev hardware.
- **D2**: Encryption algorithm (XChaCha20-Poly1305 vs AES-GCM) — 2.1.0 design. Recommendation: XChaCha20-Poly1305 (24-byte nonces remove birthday-attack worry without nonce coordination).
- **D3**: Blob envelope format (binary vs JSON) — 2.1.1 design. Recommendation: JSON with base64 ciphertext for debuggability; revisit only if size matters.
- **D4**: Server transport (REST vs gRPC) — 2.1.1 design. Recommendation: REST + JSON for MVP simplicity.
- **D5**: Sync scheduler cadence — 2.1.2 design. Recommendation: 5min default, user-configurable down to 30s.
- **D6**: Backend hosting (self-hosted vs SaaS) — 2.1.3 design. Recommendation: ship a self-hostable Rust binary; offer hosted as a follow-up.
- **D7**: Settings UI surface (new top-level pane vs nested under Privacy) — 2.1.4 design. Recommendation: new top-level pane "Cloud Mirror" — important enough to surface.
- **D8**: Search-merge ranking (local-only vs unified) — 2.1.4 design. Recommendation: unified, with provenance markers in result metadata.

## 6. Open questions — RESOLVED 2026-05-07

These were the open questions; their resolutions feed into 2.1.0+ design.

- **OQ1 — RESOLVED: Apple-only for the 2.1.x cycle.** No Linux/Windows keychain abstraction in 2.1.0. Cross-platform key storage moves to Phase 4. Implication for 2.1.0: the keychain wrapper is `#[cfg(target_os = "macos")]`-gated; pure crypto helpers stay platform-agnostic. Rust apps on other platforms compile but the Mirror feature is hard-gated off.
- **OQ2 — RESOLVED: Surface the risk explicitly. No backdoor.** Mirror onboarding MUST include an unmissable "this passphrase is the only key — if you forget it, every synced memory is unrecoverable" screen with a typed-text confirmation (similar to the 2.0d REPLACE pattern). The zero-knowledge property is the entire point; we do not weaken it for recovery.
- **OQ3 — RESOLVED: Self-hostable Rust binary first.** Phase 2.1.3 ships a Rust microservice the user can run on their own machine / VPS. Public hosted SaaS is a follow-up (Phase 2.1.5+). This keeps the cloud component honest — if the user doesn't trust SHOGUN's hosted Mirror, they can run their own; the only thing the hosted version adds is convenience.
- **OQ4 — RESOLVED: No non-Mirror telemetry.** Sync stats are surfaced LOCALLY only — visible in `Settings → Cloud Mirror → Status`, never reported to anyone. Keep the outbound channel story clean: one Mirror endpoint, zero side-channels.

These resolutions are locked the same way the A1-A7 decisions in §4 are locked: changing them is a privacy-policy decision, not a tech decision.

## 7. What this document IS and ISN'T

**Is**:
- A roadmap with sub-phase boundaries and dependency ordering
- A list of locked architectural decisions
- A list of open questions and deferred decisions

**Isn't**:
- A detailed implementation plan for any sub-phase (those come later, one per sub-phase)
- A commitment to specific dates / sprint allocations
- A final word on protocol or storage details (those get nailed down in 2.1.1)

## 8. Suggested next step

Once this architecture spec is reviewed and OQ1–OQ4 are answered, draft `docs/superpowers/specs/2026-XX-XX-memory-mirror-encryption-design.md` (Phase 2.1.0) — the first detailed design, mirroring the 2.0a/b/c/d cadence. That sub-spec gets a Decisions table, Module Layout, Test Strategy, Risks, and an associated implementation plan, then implementation kicks off.
