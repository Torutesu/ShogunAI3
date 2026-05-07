# SHOGUN Phase 2.1.1 — Memory Mirror Protocol RFC

**Status:** draft (2026-05-07) — awaiting user review
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Predecessor:** Phase 2.1.0 (encryption primitives — PR #47)
**Successors:** Phase 2.1.2 (sync engine, Mac side) and 2.1.3 (Mirror server reference impl) — both consume this RFC

---

## 1. What this is and isn't

**Is**: an RFC that locks the wire protocol between SHOGUN's Mac client and the Memory Mirror server. After this is reviewed, Phase 2.1.2 (Mac client) and 2.1.3 (server reference) can be developed in parallel without integration risk.

**Isn't**: code. No implementation lands in 2.1.1. The RFC is reviewed, locked, and serves as the single source of truth that both sides implement against.

## 2. Design constraints (from architecture spec § 4)

These are **non-negotiable** invariants from the master spec (§ 0 + § 3) and the 2.1 architecture sub-spec (A1-A7):

- **A1**: Server cannot decrypt user data
- **A2**: Embeddings + structured metadata only — never raw a11y stream
- **A3**: Cloud features are opt-in
- **A6**: No raw text crosses the encryption boundary outbound
- **A7**: Per-device server-issued credentials (revocable)

Plus from 2.1.0:
- All encryption uses **XChaCha20-Poly1305 AEAD** with 24-byte nonces
- All keys are 32 bytes
- Master Key is in iCloud Keychain; **only MEK encrypts mem_items rows** (never Master Key)

## 3. Overview

```
Mac client                                     Mirror server
─────────                                      ─────────────
1. Encrypt mem_items row with MEK              ┌─────────────────┐
   → Ciphertext { nonce, ciphertext+tag }      │ encrypted blobs │
2. Wrap in BlobEnvelope (plaintext metadata    │ keyed by         │
   + encrypted payload)                         │ blob_id          │
3. POST /v1/blobs                              │                  │
4. Server stores blob, returns blob_id ────────│ no decryption    │
                                               │ ever             │
   (later, on read)                            │                  │
5. GET /v1/blobs?since=<ts>&until=<ts>         │ time-range query │
6. Server returns list of blob_ids + metadata──│                  │
7. Mac fetches each blob_id                    └─────────────────┘
8. Decrypts locally with MEK
9. Indexes / displays
```

The server is **dumb encrypted-blob storage**. Decryption, search, and ranking all happen on Mac. The only operations the server supports are upload, list-by-time-range, fetch, and tombstone-create.

## 4. Wire format

### 4.1 BlobEnvelope (JSON)

Each blob is a single JSON object posted as the request body. Total size budget: ~10KB typical, hard limit 1MB. Larger memories are not currently supported (no SHOGUN flow today produces them; if future capture types do, they'll need explicit chunking).

```json
{
  "version": 1,
  "blob_id": "01HVXXX...XXX",
  "device_id": "01HVDDD...DDD",
  "created_at": "2026-05-07T12:34:56.789Z",
  "schema": "mem_items.v1",
  "metadata": {
    "kinds": ["screen"],
    "provenance": "screen",
    "captured_at_minute": 28872034
  },
  "ciphertext": {
    "nonce": "VGhpcyBpcyAyNCBieXRlcyBleGFjdGx5",
    "data": "0Xn..."
  }
}
```

#### Field-by-field

| Field | Type | Constraint | Notes |
|-------|------|------------|-------|
| `version` | u8 | always `1` | bump for breaking changes; reject unknown |
| `blob_id` | string | ULID (Crockford base32, 26 chars) | client-generated; collision-free; sortable by time |
| `device_id` | string | ULID | per-device, generated at first Mirror enable |
| `created_at` | string | RFC 3339 with ms | server-side rounded to second precision; client value preserved on read |
| `schema` | string | enum `"mem_items.v1"` | locks the cleartext shape of the encrypted payload; future schemas get new values |
| `metadata` | object | see § 4.2 | NEVER includes raw text or PII — server reads this for indexing / billing |
| `ciphertext.nonce` | string | base64 of 24 bytes | from XChaCha20-Poly1305 envelope |
| `ciphertext.data` | string | base64 of (ciphertext ‖ tag) | the encrypted JSON-encoded mem_items row |

#### Decryption result

After decrypting `ciphertext.data` with MEK + nonce, the plaintext is a JSON object matching the `mem_items.v1` schema:

```json
{
  "id": "<original mem_items.id>",
  "title": "Window title",
  "snippet": "Short body excerpt",
  "source": "capture_sampler",
  "kinds_json": "[\"screen\"]",
  "created_at": 1714999100000,
  "embedding_b64": "0xXX...",
  "provenance": "screen",
  "entity_id": null,
  "confidence": null,
  "redaction": null,
  "sync_status": "synced",
  "sync_excluded_reason": null
}
```

This is the same shape `memory_store::row_to_item` produces, with `embedding` base64-encoded as `embedding_b64`.

### 4.2 Allowed plaintext metadata

The server reads metadata for indexing (time-range queries) and billing (per-device blob counts). It MUST NOT contain anything that allows the server to reconstruct user activity. Whitelist:

- `kinds`: `string[]` — values from `["screen", "connector", "meeting", "user"]` only. The high-level provenance category, never the specific app or URL.
- `provenance`: same enum value as `kinds[0]` (deduplicated for the indexer)
- `captured_at_minute`: `u64` — Unix minute (not seconds, not ms). Reduces server-side time resolution to whole minutes, capping the side-channel from "what time did this user open this app".

**Disallowed** (would violate A2 / A6 if added):
- `app_id`, `app_id_hash` (even hashed — short hash space + small app universe = trivial dictionary attack)
- `url`, `url_hash`
- `title`, `snippet`, any text excerpt
- `embedding` or `embedding_hash`
- `device_id_at_capture_time` beyond the device that uploaded
- `user_agent`, `ip_address`

The server MAY observe TLS-level metadata (timing, byte sizes, request frequency) — that's an architectural compromise mitigated by the request batching in 2.1.2 (uniform-size requests, deferred uploads).

### 4.3 Encryption / Authenticated-Data binding

The `ciphertext.data` is XChaCha20-Poly1305 AEAD output where the **associated data** (AD) is the canonical JSON encoding of `{ "version", "blob_id", "device_id", "schema", "metadata" }` — i.e., everything in the envelope except `created_at` and `ciphertext`.

Why bind these fields:
- A server that swaps a user's blob with another user's would need to forge AEAD with the other user's MEK — infeasible
- A server that strips `metadata` to reduce its storage cost would invalidate the tag
- `version` and `schema` binding mean a downgrade attack (server presents v1 envelope claiming to be v2 schema) fails decryption

`created_at` is excluded so the server can normalize timestamps without invalidating the AEAD. Excluding `ciphertext` is mechanical (it IS the ciphertext).

The canonical JSON encoding is **lexicographically sorted keys, no whitespace**, exactly per RFC 8785 (JSON Canonicalization Scheme). Both client and server must use a JCS-compliant serializer.

### 4.4 Ciphertext binary layout (alternative wire form)

For large rollouts where JSON overhead matters, the same logical envelope can be expressed as a binary protobuf-or-msgpack form. **2.1.1 punts on this**: JSON-only for MVP. Binary is a 2.1.5+ optimization once we have measured wire costs. The schema field would shift to `mem_items.v1.bin` if a binary variant ships later.

## 5. HTTP API

### 5.1 Base URL

`https://mirror.example.com/v1` — placeholder. The actual host is configured per-deployment:

- Self-hosted: user enters their own URL in `Settings → Cloud Mirror → Mirror server URL`
- SaaS (future, Phase 2.1.5+): defaults to `https://mirror.shogun.ai/v1`

All requests use HTTPS. Rejecting plaintext HTTP is enforced server-side.

### 5.2 Authentication

Every request carries `Authorization: Bearer <device_token>`. Tokens:
- Issued by the server's `POST /v1/devices` endpoint (one-time-use registration code → device_token)
- Per-device, never per-session
- Revocable via the user's account UI (server-side revocation list)
- Format: opaque to client; server defines (recommended: 32-byte URL-safe-base64 random secret)

The `device_id` in BlobEnvelope is **not** the auth token — it's a stable device identifier the user can see in Settings. The auth token rotates on revoke; the device_id is permanent for the device.

### 5.3 Endpoints

#### `POST /v1/devices`

Register a device. Called once during Mirror setup.

Request:
```json
{
  "registration_code": "XXXX-YYYY-ZZZZ",
  "device_name": "Toru's MacBook Pro"
}
```

Response (201):
```json
{
  "device_id": "01HVDDD...DDD",
  "device_token": "<opaque secret>"
}
```

Errors:
- `400` invalid registration code
- `409` device_id already in use (extremely unlikely with ULID)

The `registration_code` is acquired out-of-band (user pastes it from a "set up another device" page in their account UI). For the MVP self-hosted server, a single static admin-provisioned code is acceptable; SaaS Phase 2.1.5+ will improve the flow.

#### `PUT /v1/devices/<device_id>`

Rename a device. Per Q3 resolution, `device_name` is user-visible metadata (Phase 2.1.4 Settings → Devices list).

Request:
```json
{ "device_name": "Toru's Laptop" }
```

Response (200): the updated device record.

Errors:
- `400` invalid name (empty, > 64 chars, control chars)
- `401` token doesn't belong to this device's account
- `404` device_id not found

#### `DELETE /v1/devices/<device_id>`

Remove a device. Per Q2 resolution, this hard-purges (tombstones) every blob whose envelope had this `device_id`. Tombstones follow § 8.1 retention (30 days then hard-purge).

Auth: caller must be authenticated as the device's account. A device can self-revoke (caller token == this device's token).

Response (200):
```json
{ "device_id": "01HVDDD...", "tombstoned_blobs": 1234 }
```

`tombstoned_blobs` is the count of blobs marked for purge. The actual purge happens server-side asynchronously; clients should treat the response as "the request was accepted" not "all blobs are gone right now".

Errors:
- `401` unauthorized (token doesn't belong to this device's account)
- `404` device_id not found

#### `POST /v1/blobs`

Upload a blob.

Request: a single `BlobEnvelope` JSON object (§ 4.1).

Response (201):
```json
{ "blob_id": "01HVXXX...XXX", "stored_at": "2026-05-07T12:34:57Z" }
```

Errors:
- `400` invalid envelope (missing fields, version mismatch, oversize, schema unknown)
- `401` invalid or revoked token
- `409` `blob_id` already exists for this device (idempotent — return the existing record's `stored_at`)
- `413` payload exceeds 1MB
- `429` device-level rate limit exceeded

**Idempotency**: Re-POSTing the same `blob_id` with the same `ciphertext.data` returns 201 with the original `stored_at`. Different `ciphertext.data` for the same `blob_id` is a 409 (`error: "blob_id collision with different content"`).

#### `GET /v1/blobs?cursor=<opaque>&device_id=<id>` (delta sync — preferred)

List blob IDs that arrived strictly **after** the given cursor. Returns metadata only (no ciphertext) — the client uses this to decide which blobs to fetch. This is the canonical delta-sync entry point per Q1 resolution.

Query params:
- `cursor` (optional, opaque): server-issued cursor from a prior call. Omit on first call.
- `device_id` (optional): filter to one device. Omit for all devices in the account.
- `limit` (optional, default 100, max 1000)

Response (200):
```json
{
  "blobs": [
    {
      "blob_id": "01HVXXX...XXX",
      "device_id": "01HVDDD...DDD",
      "stored_at": "2026-05-07T12:34:57Z",
      "metadata": { "kinds": ["screen"], "provenance": "screen", "captured_at_minute": 28872034 }
    }
  ],
  "next_cursor": "BASE64..."
}
```

`next_cursor` is `null` when caught up. Cursors order by `(stored_at, blob_id)` lexicographically — server guarantees consistent ordering even under concurrent writes. Tombstoned blobs appear in the list with `tombstoned_at` and `metadata: null` (clients use this to drop their local copy).

#### `GET /v1/blobs?since=<RFC3339>&until=<RFC3339>&device_id=<id>` (time-range — historical)

Same response shape as the cursor variant. Used for "show memories from a specific time range" (e.g., last week's notes view in 2.1.4 search UI). Pagination via `cursor` is also accepted on this endpoint.

`device_id` filter is optional. Without it, returns all devices for the authenticated user. The user's account is implied by the auth token.

#### `GET /v1/blobs/<blob_id>`

Fetch a single blob's full envelope. Returns the same `BlobEnvelope` that was POSTed, byte-for-byte.

Errors:
- `401` invalid token
- `404` blob_id not found or not visible to this device's account

#### `POST /v1/blobs/<blob_id>/tombstone`

Mark a blob as deleted. **Soft delete**: the server keeps a tombstone record but removes the ciphertext.

Request body: empty.

Response (204).

After tombstone:
- `GET /v1/blobs/<blob_id>` returns 410 Gone
- `GET /v1/blobs?...` includes `{ "blob_id": "...", "tombstoned_at": "...", "metadata": null }` so the client can update its local index

Hard delete (purging tombstones) is operator-side only and out of API surface for MVP.

#### `GET /v1/health`

Server health. No auth. Returns:
```json
{ "ok": true, "version": "0.1.0", "uptime_seconds": 12345 }
```

Used by the Mac client's "Settings → Cloud Mirror → Status" pane to show server reachability.

### 5.4 Error envelope

All non-2xx responses return:
```json
{ "error": "<short_code>", "message": "<human readable>" }
```

`error` is a stable enum the client can switch on:
- `invalid_envelope`, `unsupported_version`, `unknown_schema`, `payload_too_large`
- `unauthorized`, `revoked_token`, `not_found`, `gone`
- `rate_limited`, `internal_server_error`

The `message` is locale-dependent (server may or may not localize); clients should match on `error`, not `message`.

## 6. Decisions Locked

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| P1 | Wire format | JSON envelope | Debuggable. Binary optimization deferred to 2.1.5+. |
| P2 | ID format | ULID (Crockford base32, 26 chars) | Time-sortable; collision-free; URL-safe. |
| P3 | Time resolution in metadata | Whole minutes (`captured_at_minute`) | Reduces server-side timing side-channel without losing usability. |
| P4 | Auth scheme | Bearer device_token | Simple; revocable; no session state. |
| P5 | Idempotency | Same blob_id + same ciphertext = 201; different ciphertext = 409 | Allows safe retries; prevents silent overwrite. |
| P6 | Soft delete | Tombstone returned in list query | Lets clients sync-delete without losing the audit trail. |
| P7 | AEAD associated data | Canonical JSON of `{version, blob_id, device_id, schema, metadata}` | Binds metadata to ciphertext; prevents server-side swaps and downgrade attacks. |
| P8 | Time range query | `since`/`until` on `stored_at` | Server-controlled timestamp; client trusts the order but not the absolute time. |
| P9 | Maximum blob size | 1MB | Covers worst-case mem_items row plus headroom. Larger needs explicit chunking. |
| P10 | Versioning | `version: u8` in envelope; reject unknown | Single source of versioning; downstream `schema` field independently versioned. |
| P11 | Self-hosted first | Reference Rust server in Phase 2.1.3 | Keeps the privacy story honest. SaaS optional. |
| P12 | TLS only | HTTPS enforced server-side | No plaintext on the wire ever. |

## 7. Threat Model and Mitigations

| Threat | Mitigation |
|--------|-----------|
| Server reads mem_items contents | XChaCha20-Poly1305 AEAD; server only sees ciphertext |
| Server fingerprints user activity via metadata | Whitelist § 4.2; minute-precision; no app/URL/title fields |
| Server swaps blobs between users | AEAD AD binding (§ 4.3); decryption fails for cross-user swap |
| Server downgrade attack (claim v1 → v2 schema) | `schema` field bound in AD |
| Replay attack (server replays old blob) | `blob_id` is ULID — client tracks seen IDs and ignores duplicates |
| Tampered metadata reaches client | AEAD AD binding fails decryption |
| Stolen device_token | User revokes via account UI; per-device tokens scope blast radius |
| Server compromise / data exfiltration | Encrypted blobs are useless without MEK (which never leaves Apple Keychain) |
| TLS downgrade / MITM | HTTPS-only + cert pinning (deferred to 2.1.5+ hardening) |
| Side-channel via TLS timing | Request batching + uniform-size queues in 2.1.2 |
| User loses passphrase | All synced data unrecoverable (zero-knowledge) — surfaced in onboarding per OQ2 |
| Quantum attack | Out of MVP scope; hybrid PQ encryption is a Phase 4+ revisit |

## 8. Operational concerns

### 8.1 Storage

A 50K-mem_items DB with 1KB/row average produces 50MB of encrypted blobs. Server should plan for:
- 5GB per active user per year (very rough bound)
- Per-device retention policy (default: indefinite; user-configurable in 2.1.5+)
- Tombstone retention: 30 days, then hard-purge

### 8.2 Rate limits

Server enforces (defaults; configurable per deployment):
- POST /v1/blobs: 100/minute per device, 10000/day per device
- GET /v1/blobs (list): 60/minute per device
- GET /v1/blobs/<id>: 600/minute per device

Client SHOULD batch uploads (sync engine in 2.1.2 will).

### 8.3 Logging

Server logs per § 7.2 of master spec — never logs:
- ciphertext, ciphertext.nonce, ciphertext.data
- decrypted plaintext (server can't decrypt anyway)
- request bodies that contain ciphertext

May log:
- request method / path / status code / response time
- device_id (it's pseudonymous)
- error codes (not error messages — those may contain raw input)
- aggregate metrics (blobs uploaded per hour)

## 9. Open questions — RESOLVED 2026-05-07

These were the open questions; their resolutions feed into 2.1.2 / 2.1.3 design.

- **Q1 — RESOLVED: Since-cursor mechanism for delta sync.** Add `cursor` query param to `GET /v1/blobs` that returns blobs strictly after that cursor in `(stored_at, blob_id)` lexicographic order. The cursor is opaque (server-generated, base64); the client stores the last-seen cursor in local state and passes it on next sync. This gives O(new-blobs) server-side work instead of O(time-range). Time-range query (`since`/`until`) is preserved for the *historical* use case — e.g. "show me memories from last week" — but is not the primary delta-sync mechanism.

  **Wire change**: `GET /v1/blobs?cursor=<opaque>` becomes the canonical delta-sync request. `since` / `until` remain optional for time-range queries. The cursor is null-terminating: a response with no `next_cursor` means caught up.

- **Q2 — RESOLVED: Device removal purges all blobs from that device.** Privacy-first: removing a device means the user no longer trusts it (or doesn't own it anymore). Soft-keep would leave residue across the account. Implementation: `DELETE /v1/devices/<device_id>` (admin or self-revoke endpoint) tombstones every `blob_id` whose envelope had that device_id. Other devices in the same account that still have those blobs cached locally retain them — the cloud copy is gone, but the user's local data is unaffected on devices they still own. Tombstone retention follows § 8.1 (30 days then hard-purge).

- **Q3 — RESOLVED: `PUT /v1/devices/<device_id>` renames.** Settings → Devices list is the user-visible surface for device names (Phase 2.1.4). The endpoint accepts `{ "device_name": "<new name>" }`, validates against the calling token's account, returns 200 with the updated record. `device_name` is plaintext metadata (not encrypted) and is itself not a privacy-sensitive field — users name their devices.

- **Q4 — RESOLVED: Expose server version in `/v1/health`.** The "version reveals CVEs" concern is real but weak — anyone testing the server can fingerprint the version from response headers, behavior, or error message shapes. Self-hosting users have a legitimate need to verify what's running. Operators who care can compile with a version-stripped build flag (TBD: provide a build option). Default behavior: full version string in `/v1/health`.

These resolutions are locked the same way the P1-P12 decisions in §6 are locked: changing them requires a fresh review.

## 10. What this enables

- **Phase 2.1.2** (Mac client sync engine): builds queue + uploader against `POST /v1/blobs`, list reader against `GET /v1/blobs`. Uses `Ciphertext` from 2.1.0 to construct `BlobEnvelope`. Wires retry / backoff against 429s.
- **Phase 2.1.3** (server reference): implements all 5 endpoints above, in Rust, with file-backed or S3-backed storage. Verifies the AEAD AD binding correctly via integration tests against the Mac client.
- **Phase 2.1.4** (split-arch search + UI): uses `GET /v1/blobs?since=...&until=...` to fetch a time range, decrypts each blob locally, runs vector similarity, merges with local-only results.

After 2.1.1 review locks the protocol, 2.1.2 and 2.1.3 can be developed in parallel by different agents / contributors. That's the whole point of doing the RFC as its own sub-phase.
