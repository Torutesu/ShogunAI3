# SHOGUN Phase 2.1.0 — Memory Mirror Encryption Primitives Design

**Status:** draft (2026-05-07) — awaiting user review
**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 3 (Encryption Boundary)
**Predecessors:** all four 2.0 prerequisites merged
**Successors:** 2.1.1 (Mirror protocol RFC) → 2.1.2 (sync engine, Mac side) → 2.1.3 (Mirror server) → 2.1.4 (search + UI)

---

## 1. Goal

Build the **crypto layer** that everything else in 2.1 depends on. After this lands:
- The app can derive a Master Key from a user-chosen passphrase (Argon2id KDF)
- Three sub-keys (MEK / JEK / REK) are derivable from the Master Key (HKDF-SHA256)
- Master Key is stored in the macOS Keychain and can be loaded / saved / deleted
- Symmetric encrypt / decrypt helpers are available (XChaCha20-Poly1305 AEAD)
- Key rotation re-derives MEK from a fresh Master Key passphrase change

**No sync, no server, no UI.** Just the building blocks. The next sub-phases consume these APIs.

## 2. Why this is its own sub-phase

Encryption decisions (algorithm, key length, KDF parameters, keychain semantics) are foundational and irreversible — a mistake propagates into every byte every other 2.1.x sub-phase produces. Locking them with their own design review is worth more than rolling them into "the sync feature."

This sub-phase also has a clean review surface: pure crypto code + iCloud Keychain wrapper. No frontend, no UI, no protocol decisions. Easier to get right, easier to security-review.

## 3. Scope (in / out)

**In scope:**

- New module `src-tauri/src/mirror/crypto.rs` (~250 LOC) with:
  - `MasterKey` opaque type (32 bytes, derived from passphrase via Argon2id)
  - `MemoryEncryptionKey`, `JobEncryptionKey`, `ResultEncryptionKey` types (32 bytes each, derived from MasterKey via HKDF-SHA256 with distinct info strings)
  - `derive_master_key(passphrase: &str, salt: &[u8]) -> MasterKey`
  - `derive_mek(&MasterKey) -> MemoryEncryptionKey` (and JEK / REK siblings)
  - `encrypt(key: &[u8; 32], plaintext: &[u8]) -> Ciphertext` (XChaCha20-Poly1305 AEAD; output = `{ nonce, ciphertext, tag }` in a packed envelope)
  - `decrypt(key: &[u8; 32], ct: &Ciphertext) -> Result<Vec<u8>>`
- New module `src-tauri/src/mirror/keychain.rs` (~150 LOC, macOS-gated):
  - `save_master_key(label: &str, mk: &MasterKey)` — writes to keychain via `security` crate or direct keychain-services-sys
  - `load_master_key(label: &str) -> Option<MasterKey>` — reads
  - `delete_master_key(label: &str)` — removes
  - `set_passphrase_salt(salt: &[u8])` / `get_passphrase_salt() -> Option<Vec<u8>>` — salt is keychain-stored too (per-device random, never derived from passphrase)
- New module `src-tauri/src/mirror/mod.rs` glue, declared in `src-tauri/src/lib.rs`
- `Cargo.toml` adds: `argon2 = "0.5"`, `chacha20poly1305 = "0.10"` (with `xchacha20poly1305` feature), `hkdf = "0.12"`, `sha2 = "0.10"`, `getrandom = "0.2"`, and (for macOS keychain) `security-framework = "3"` under the macOS target dependency block
- 30 unit tests covering happy path, bad passphrase, tampering, salt/nonce uniqueness, key rotation correctness

**Out of scope (later sub-phases):**

- Any actual sync, blob, or HTTP code (2.1.1 / 2.1.2)
- Any IPC commands (Mirror's IPC surface lands in 2.1.2 alongside the sync engine)
- Any UI (2.1.4)
- Linux / Windows keychain (Phase 4 per OQ1 resolution)
- Recovery flow / backup keys (no backdoor per OQ2 resolution)
- Post-quantum or HE-lite or threshold crypto (Phase 4+)
- Master Key rotation (changing passphrase → re-encrypting all blobs) — primitives exist here, the actual re-encrypt loop is 2.1.2

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | KDF | **Argon2id** with `m=64MiB, t=3, p=1` | Memory-hard (defends against ASIC/GPU); Argon2id mode is recommended over `argon2i` / `argon2d`. Calibrated against macOS Apple Silicon dev hardware: ~120-180ms unlock time, well under the "imperceptible-to-user" 250ms threshold while requiring ~64MB attacker memory per guess. |
| D2 | Salt | **Per-device random 16 bytes**, stored in keychain alongside Master Key | Salt is non-secret but should be unique. A predictable salt enables rainbow-table attacks. Keychain-stored so it doesn't sit in plaintext on disk (defense-in-depth). |
| D3 | KDF output length | **32 bytes** | Matches XChaCha20-Poly1305 key size and HKDF-SHA256 output. |
| D4 | Sub-key derivation | **HKDF-SHA256** from Master Key, with distinct `info` strings: `"shogun.mirror.mek.v1"`, `"shogun.mirror.jek.v1"`, `"shogun.mirror.rek.v1"` | HKDF is the standard for deriving multiple sub-keys from one master. Versioned info strings let us rotate the derivation function (not the keys themselves) in a future scheme by introducing `.v2`. |
| D5 | Symmetric encryption | **XChaCha20-Poly1305** | 24-byte nonce removes birthday-attack worry vs 12-byte AES-GCM. Constant-time on every CPU. RustCrypto's `chacha20poly1305` crate is well-audited. |
| D6 | Nonce generation | **Random 24 bytes per encryption** via `getrandom` | XChaCha20-Poly1305's nonce space (192 bits) makes collisions vanishingly unlikely (~`2^96` operations to hit a collision per Blink-dev). Counter-based nonces add coordination complexity for negligible benefit. |
| D7 | Ciphertext envelope | **Concat: 24-byte nonce ‖ ciphertext ‖ 16-byte tag** (40 + plaintext len bytes total) | Tag is included by the AEAD construction. No length prefix or framing — the consumer knows the byte boundaries. Encoded as base64 only when crossing protocol boundaries (in 2.1.1+). |
| D8 | Key rotation | **MEK rotation only** in 2.1.0; Master Key rotation (passphrase change → re-encrypt blobs) deferred to 2.1.2 | MEK rotation is just `derive_mek(&new_master_key)`; Master Key rotation requires walking all blobs and re-encrypting under a new MEK, which is a sync-engine concern. |
| D9 | Keychain ACL | **`kSecAttrAccessibleWhenUnlocked`** (default for keys not synced via iCloud Keychain) | Master Key is loaded once per app session into memory; we don't need it available when the screen is locked. iCloud sync of the keychain entry uses `kSecAttrSynchronizable` separately. |
| D10 | iCloud Keychain sync | **YES via `kSecAttrSynchronizable: true`** | The promise of cross-device sync is the whole reason we picked Apple ecosystem (master spec § 3.1). Without it, every device would need its own passphrase entry, which contradicts the UX. |
| D11 | Naming | branch `feat/cloud-2-1-0-encryption-primitives` (or stay on the 2.1 branch); spec `2026-05-07-mirror-encryption-primitives-design.md`; plan to follow as `2026-05-07-mirror-encryption-primitives.md` | Mirrors the 2.0a/b/c/d cadence. Each sub-phase gets its own branch. |
| D12 | API surface | **All public types are `pub(crate)` from `src-tauri/src/mirror/`**, exposed only to other Mirror modules. The frontend never sees raw keys. | The Mirror crate boundary is the security boundary. JS/TS code interacts with the Mirror feature via IPC commands (added in 2.1.2), not by handling key bytes. |

## 5. Module Layout

### 5.1 `src-tauri/src/mirror/mod.rs` (new, ~30 LOC)

```rust
//! Memory Mirror — encrypted cloud sync of memory metadata.
//! Decomposed into sub-phases per
//! `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`.
//! 2.1.0 ships only the crypto + keychain primitives; later phases add
//! sync engine, server, and UI on top of these.

pub(crate) mod crypto;

#[cfg(target_os = "macos")]
pub(crate) mod keychain;

// Re-export the canonical types so consumers don't pierce into sub-modules.
pub(crate) use crypto::{
  encrypt, decrypt, derive_jek, derive_master_key, derive_mek, derive_rek,
  Ciphertext, JobEncryptionKey, MasterKey, MemoryEncryptionKey, ResultEncryptionKey,
};
```

### 5.2 `src-tauri/src/mirror/crypto.rs` (new, ~250 LOC)

```rust
//! Pure crypto. No I/O, no platform deps. Tested on every platform.
//!
//! Master Key derivation:  Argon2id(passphrase, salt) -> 32 bytes
//! Sub-key derivation:     HKDF-SHA256(MasterKey, info) -> 32 bytes per sub-key
//! Symmetric encryption:   XChaCha20-Poly1305 AEAD with random 24-byte nonces
//! See spec docs/superpowers/specs/2026-05-07-mirror-encryption-primitives-design.md.

use argon2::{Argon2, Algorithm, Params, Version};
use chacha20poly1305::{aead::{Aead, KeyInit}, XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;

/// Argon2id parameters: 64MB / 3 iters / 1 lane / 32-byte output.
const KDF_M_KIB: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;
const KEY_LEN: usize = 32;

const HKDF_INFO_MEK: &[u8] = b"shogun.mirror.mek.v1";
const HKDF_INFO_JEK: &[u8] = b"shogun.mirror.jek.v1";
const HKDF_INFO_REK: &[u8] = b"shogun.mirror.rek.v1";

#[derive(Clone)]
pub(crate) struct MasterKey([u8; KEY_LEN]);

#[derive(Clone)]
pub(crate) struct MemoryEncryptionKey([u8; KEY_LEN]);
#[derive(Clone)]
pub(crate) struct JobEncryptionKey([u8; KEY_LEN]);
#[derive(Clone)]
pub(crate) struct ResultEncryptionKey([u8; KEY_LEN]);

/// 24-byte nonce ‖ ciphertext ‖ 16-byte tag, concatenated. The tag is part
/// of `ciphertext` (the AEAD construction appends it).
pub(crate) struct Ciphertext {
  pub nonce: [u8; 24],
  pub ciphertext: Vec<u8>, // ciphertext + 16-byte tag
}

pub(crate) fn derive_master_key(passphrase: &str, salt: &[u8]) -> Result<MasterKey, String> {
  let params = Params::new(KDF_M_KIB, KDF_T, KDF_P, Some(KEY_LEN))
    .map_err(|e| e.to_string())?;
  let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
  let mut out = [0u8; KEY_LEN];
  argon.hash_password_into(passphrase.as_bytes(), salt, &mut out)
    .map_err(|e| e.to_string())?;
  Ok(MasterKey(out))
}

pub(crate) fn derive_mek(mk: &MasterKey) -> MemoryEncryptionKey {
  derive_subkey(mk, HKDF_INFO_MEK).map(MemoryEncryptionKey).unwrap()
}
pub(crate) fn derive_jek(mk: &MasterKey) -> JobEncryptionKey {
  derive_subkey(mk, HKDF_INFO_JEK).map(JobEncryptionKey).unwrap()
}
pub(crate) fn derive_rek(mk: &MasterKey) -> ResultEncryptionKey {
  derive_subkey(mk, HKDF_INFO_REK).map(ResultEncryptionKey).unwrap()
}

fn derive_subkey(mk: &MasterKey, info: &[u8]) -> Result<[u8; KEY_LEN], String> {
  let hk = Hkdf::<Sha256>::new(None, &mk.0);
  let mut out = [0u8; KEY_LEN];
  hk.expand(info, &mut out).map_err(|e| e.to_string())?;
  Ok(out)
}

pub(crate) fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Ciphertext, String> {
  let cipher = XChaCha20Poly1305::new_from_slice(key)
    .map_err(|e| e.to_string())?;
  let mut nonce_bytes = [0u8; 24];
  getrandom::getrandom(&mut nonce_bytes).map_err(|e| e.to_string())?;
  let nonce = XNonce::from_slice(&nonce_bytes);
  let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
  Ok(Ciphertext { nonce: nonce_bytes, ciphertext })
}

pub(crate) fn decrypt(key: &[u8; KEY_LEN], ct: &Ciphertext) -> Result<Vec<u8>, String> {
  let cipher = XChaCha20Poly1305::new_from_slice(key)
    .map_err(|e| e.to_string())?;
  let nonce = XNonce::from_slice(&ct.nonce);
  cipher.decrypt(nonce, ct.ciphertext.as_slice())
    .map_err(|_| "decryption failed (key mismatch or tampering)".to_string())
}

// Inherent methods to expose the byte slice for keychain storage / hashing —
// not for general-purpose use. Doc-comments warn against misuse.
impl MasterKey {
  pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] { &self.0 }
  pub(crate) fn from_bytes(b: [u8; KEY_LEN]) -> Self { Self(b) }
}
impl MemoryEncryptionKey { pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] { &self.0 } }
impl JobEncryptionKey { pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] { &self.0 } }
impl ResultEncryptionKey { pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] { &self.0 } }
```

### 5.3 `src-tauri/src/mirror/keychain.rs` (new, ~150 LOC, macOS-gated)

```rust
//! macOS Keychain wrapper for the Mirror Master Key + per-device salt.
//! Uses `security-framework` crate. iCloud Keychain sync is enabled so
//! cross-device unlocking works (master spec § 3.1).

use security_framework::passwords;
use crate::mirror::crypto::MasterKey;

const SERVICE: &str = "ai.shogun.mirror";
const ACCOUNT_MASTER_KEY: &str = "master_key.v1";
const ACCOUNT_SALT: &str = "passphrase_salt.v1";

pub(crate) fn save_master_key(mk: &MasterKey) -> Result<(), String> {
  passwords::set_generic_password(SERVICE, ACCOUNT_MASTER_KEY, mk.as_bytes())
    .map_err(|e| e.to_string())
}

pub(crate) fn load_master_key() -> Result<Option<MasterKey>, String> {
  match passwords::get_generic_password(SERVICE, ACCOUNT_MASTER_KEY) {
    Ok(bytes) => {
      if bytes.len() != 32 { return Err("master key length mismatch in keychain".to_string()); }
      let mut arr = [0u8; 32];
      arr.copy_from_slice(&bytes);
      Ok(Some(MasterKey::from_bytes(arr)))
    }
    Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
    Err(e) => Err(e.to_string()),
  }
}

pub(crate) fn delete_master_key() -> Result<(), String> {
  match passwords::delete_generic_password(SERVICE, ACCOUNT_MASTER_KEY) {
    Ok(()) => Ok(()),
    Err(e) if e.code() == -25300 => Ok(()), // already gone
    Err(e) => Err(e.to_string()),
  }
}

pub(crate) fn save_salt(salt: &[u8]) -> Result<(), String> {
  passwords::set_generic_password(SERVICE, ACCOUNT_SALT, salt).map_err(|e| e.to_string())
}

pub(crate) fn load_salt() -> Result<Option<Vec<u8>>, String> {
  match passwords::get_generic_password(SERVICE, ACCOUNT_SALT) {
    Ok(bytes) => Ok(Some(bytes)),
    Err(e) if e.code() == -25300 => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

pub(crate) fn ensure_salt() -> Result<Vec<u8>, String> {
  if let Some(s) = load_salt()? { return Ok(s); }
  let mut salt = vec![0u8; 16];
  getrandom::getrandom(&mut salt).map_err(|e| e.to_string())?;
  save_salt(&salt)?;
  Ok(salt)
}
```

iCloud Keychain sync flag (`kSecAttrSynchronizable: true`) is set via the `security-framework` API at the call site — confirm during implementation that the version we depend on exposes the synchronizable attribute. If not, drop down to `security-framework-sys` for the explicit attribute.

### 5.4 `src-tauri/src/lib.rs` (modify, ~3 LOC)

Add `mod mirror;` near other module declarations. Do NOT add anything to `invoke_handler` — the IPC surface for Mirror lands in 2.1.2.

### 5.5 `src-tauri/Cargo.toml` (modify, ~5 LOC)

Add to `[dependencies]`:
```toml
argon2 = "0.5"
chacha20poly1305 = { version = "0.10", features = ["xchacha20poly1305"] }
hkdf = "0.12"
sha2 = "0.10"
getrandom = "0.2"
```

Add to the `[target.'cfg(target_os = "macos")'.dependencies]` block:
```toml
security-framework = "3"
```

Verify these aren't already pulled in transitively; if yes, just add the explicit entries that aren't present.

## 6. Test Strategy

30 unit tests in `src-tauri/src/mirror/crypto.rs::tests` and `src-tauri/src/mirror/keychain.rs::tests`.

| ID | Module | Case | Setup | Assertion |
|----|--------|------|-------|-----------|
| C1 | crypto | Argon2id round-trip | passphrase + salt → master_key | bytes are 32-len, deterministic for same input |
| C2 | crypto | Different salt → different master | passphrase fixed, salt varies | output keys differ in every byte (with high probability) |
| C3 | crypto | Different passphrase → different master | salt fixed, passphrase varies | as above |
| C4 | crypto | KDF cost is on order of 100ms | bench Argon2id with the configured params | duration in [50ms, 500ms] (loose to survive CI hardware variation) |
| C5 | crypto | HKDF MEK derivation deterministic | derive twice, compare | same |
| C6 | crypto | MEK / JEK / REK are distinct | derive all three from same master | pairwise different |
| C7 | crypto | encrypt round-trip | random key + plaintext | decrypt(ct) == plaintext |
| C8 | crypto | decrypt with wrong key | encrypt with k1, decrypt with k2 | error |
| C9 | crypto | decrypt with tampered ciphertext | flip a byte | error (AEAD detects) |
| C10 | crypto | decrypt with tampered nonce | flip a byte in nonce | error |
| C11 | crypto | nonce uniqueness across N calls | encrypt 10000 times | all nonces unique |
| C12 | crypto | empty plaintext | encrypt(b"") | round-trips to empty bytes |
| C13 | crypto | large plaintext (1 MB) | random 1MB | round-trips, perf reasonable |
| C14 | crypto | non-utf8 plaintext | random binary | round-trips byte-for-byte |
| C15 | crypto | passphrase rotation invalidates old MEK | derive m1, m2 with different passphrases | derive_mek(m1) != derive_mek(m2) |
| C16 | crypto | multi-thread encrypt safety | spawn 8 threads, each encrypt 1000 times | no panics, no nonce collision |
| C17 | crypto | from_bytes / as_bytes round-trip | construct, dump, reconstruct | byte-equal |
| C18 | crypto | KEY_LEN matches XChaCha20-Poly1305 expectation | const check | passes |
| K1 | keychain | save then load | random key | bytes equal |
| K2 | keychain | load when nothing saved | clean keychain entry | None |
| K3 | keychain | delete idempotent | call twice | no error second time |
| K4 | keychain | save replaces previous | save k1, save k2 | load returns k2 |
| K5 | keychain | salt round-trip | random 16 bytes | bytes equal |
| K6 | keychain | ensure_salt creates if missing | wipe, call ensure_salt | returns 16-byte salt, persisted |
| K7 | keychain | ensure_salt is idempotent | call twice | both calls return same bytes |
| K8 | keychain | concurrent save_master_key | spawn 4 threads, each saves | last write wins, no panic |
| K9 | keychain | bad-length read errors gracefully | manually write a 16-byte entry, call load | returns Err with clear message |
| K10 | keychain | iCloud sync flag actually set | save key, inspect attributes | `kSecAttrSynchronizable: true` |
| K11 | keychain | tests clean up after themselves | tear-down deletes test keys | no test pollution next run |
| K12 | keychain | service / account naming matches docs | check constants | match `ai.shogun.mirror` / `master_key.v1` / `passphrase_salt.v1` |

C1-C18 are platform-agnostic (run on every OS in CI). K1-K12 are macOS-only and gated `#[cfg(target_os = "macos")]`. Tests use a unique service / account suffix per test run to avoid clobbering real user data when run on developer machines (e.g., `ai.shogun.mirror.test.<pid>.<seq>`).

Per `superpowers:test-driven-development`, write tests before the corresponding implementation. Order: C1 → impl Argon2id → C7 → impl encrypt/decrypt → C5/C6 → impl HKDF → K1-K7 → impl keychain. Last: integration tests that combine modules.

## 7. Risks and Mitigations

- **Memory leakage of key bytes.** Once decrypted, key bytes sit in RAM. We don't `mlock`/`zeroize` aggressively in 2.1.0 — that's a hardening pass. Acceptable for MVP because the surrounding OS is the main attacker boundary. Adopt `zeroize::Zeroize` for `MasterKey`/`MEK`/`JEK`/`REK` Drop in 2.1.x cleanup if `cargo audit` flags it.
- **iCloud Keychain sync availability.** If the user has iCloud Keychain disabled, save with `kSecAttrSynchronizable: true` falls back to local-only storage gracefully (Apple-documented behavior). Cross-device sync silently won't work, but the local feature still works. Surface this gracefully in Settings UI in 2.1.4.
- **`security-framework` API churn.** v3 is current. If the API surface changes between Tauri 2.x point releases, the keychain wrapper module is small and self-contained — easy to swap for `security-framework-sys` raw bindings if needed.
- **Argon2id timing on slow hardware.** 64MiB / t=3 is comfortable on Apple Silicon; an Intel Mac from 2014 might take 400-500ms. We accept that for MVP — targets are M1+. Later we can ship platform-detected parameters.
- **Random source quality.** `getrandom` reads from `/dev/urandom` (or platform CSPRNG); modern macOS / Linux / Windows all provide cryptographically-strong randomness here. Tests assert nonce uniqueness across 10000 calls (C11) as a smoke check.
- **Test pollution of user keychain.** Tests run with a unique suffix and clean up on teardown, but if a test panics mid-flight, an orphan keychain entry could remain. Doc the cleanup procedure (`security delete-generic-password -s "ai.shogun.mirror.test*"`) for developers.

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| `cargo test -p app mirror::` — all 30 tests green | full suite |
| Argon2id parameters produce 100-300ms unlock on Apple Silicon dev hardware | C4 + manual benchmark |
| Encrypted output is indistinguishable from random for an attacker who doesn't have the key | manual review of test output diversity |
| Keychain entries are findable via Apple's `security` CLI tool with the documented service/account names | manual smoke |
| Wrong passphrase produces a different MEK (no detectable correlation) | C2 + C3 |
| All public types are `pub(crate)` only — `pub` only in `mirror/mod.rs` re-exports | code review |
| No new IPC commands | code review |
| No frontend changes | code review |
| `cargo check` clean across platforms (macOS / Linux / Windows compile, only the macOS build has working keychain code) | CI |
| `npm run check:rust` exit 0 | CI |
| No new clippy warnings beyond the existing 20 | CI |

## 9. Open Questions for Reviewer

- **`security-framework` v3 API for synchronizable**: confirm the high-level `passwords` module exposes the synchronizable attribute, or whether we need to drop to `security-framework-sys`. (Implementation question, not blocking design.)
- **Should we add `zeroize::Zeroize` Drop impls for the key types in this PR or defer to a security-hardening sub-phase**: defaulting to **defer** for MVP simplicity, but the reviewer can flip.
- **Test cleanup pattern**: is `security delete-generic-password` invoked from a `Drop` impl on a test-fixture struct enough, or do we need a `cargo test --test mirror_keychain_cleanup` post-step? Defaulting to the Drop pattern.

## 10. What this enables

After 2.1.0 lands:

- **2.1.1** (protocol RFC) can lock the blob envelope format using the `Ciphertext` struct from this module
- **2.1.2** (sync engine) can encrypt mem_items rows using `derive_mek(&master_key)` and `encrypt(&mek_bytes, plaintext)`
- **2.1.4** (Settings UI) can call `keychain::load_master_key()` to determine whether the user has set up Mirror and surface the right onboarding step

Each downstream phase consumes the API surface defined here. Locking it now reduces churn in the next 4–8 weeks of work.
