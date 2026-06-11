# SHOGUN Phase 2.1.0 — Encryption Primitives Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the crypto + macOS-Keychain layer that all later 2.1.x sub-phases will consume. No sync, no server, no UI — just primitives + tests.

**Architecture:** Two new modules under `src-tauri/src/mirror/`:
- `crypto.rs` (platform-agnostic): Argon2id KDF, HKDF-SHA256 sub-key derivation, XChaCha20-Poly1305 AEAD
- `keychain.rs` (`#[cfg(target_os = "macos")]`-gated): macOS Keychain wrapper for Master Key + per-device salt with iCloud Keychain sync enabled

**Tech Stack:** Rust (`argon2`, `chacha20poly1305`, `hkdf`, `sha2`, `getrandom`, `security-framework`). All new crates well-audited and from RustCrypto / Apple maintainers.

**Spec:** `docs/superpowers/specs/2026-05-07-mirror-encryption-primitives-design.md`

**Architecture sub-spec:** `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`

**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 3

**Predecessors:** All four 2.0 prerequisites merged. No code dependencies — this is a fresh module under a new directory.

---

## File Map

**Created:**
- `src-tauri/src/mirror/mod.rs` (~30 LOC) — module declaration + re-exports
- `src-tauri/src/mirror/crypto.rs` (~250 LOC) — Master / sub-keys / encrypt / decrypt + 18 unit tests (C1-C18)
- `src-tauri/src/mirror/keychain.rs` (~150 LOC, macOS-gated) — keychain wrapper + 12 unit tests (K1-K12)

**Modified:**
- `src-tauri/src/lib.rs` (~3 LOC) — `mod mirror;` declaration. Do NOT add to `invoke_handler` (the IPC surface lands in 2.1.2).
- `src-tauri/Cargo.toml` (~6 LOC) — new dependencies in `[dependencies]` (cross-platform crypto crates) and the macOS-only `[target.'cfg(target_os = "macos")'.dependencies]` block (`security-framework`).

**No changes:**
- Frontend (`hifi/`) — no IPC commands, no UI in 2.1.0.
- `memory_store.rs`, `commands.rs`, etc. — encryption is consumed in 2.1.2+; nothing here yet.
- Existing tests — purely additive.

**Verification gates** (run after Task 5): `npm run check:rust` + `cargo test --lib mirror` (30 new tests) + `cargo test --lib` (no regression on the existing 581).

---

## Task 1: Add Cargo dependencies and skeleton modules

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/mirror/mod.rs`
- Create: `src-tauri/src/mirror/crypto.rs` (skeleton + tests file)
- Create: `src-tauri/src/mirror/keychain.rs` (skeleton + tests file, macOS-gated)
- Modify: `src-tauri/src/lib.rs`

This task gives a compiling skeleton: empty modules with type declarations and `unimplemented!()` stubs. Subsequent tasks fill in the bodies test-first per `superpowers:test-driven-development`.

- [ ] **Step 1: Cargo.toml dependencies**

In `[dependencies]`:
```toml
argon2 = "0.5"
chacha20poly1305 = { version = "0.10", features = ["xchacha20poly1305"] }
hkdf = "0.12"
sha2 = "0.10"
getrandom = "0.2"
```

In `[target.'cfg(target_os = "macos")'.dependencies]`:
```toml
security-framework = "3"
```

Run `cargo check` to confirm the deps resolve.

- [ ] **Step 2: `mirror/mod.rs`**

Per spec § 5.1 — declare submodules + re-export the canonical types. Use `pub(crate)` everywhere; only the parent crate sees Mirror internals. The IPC boundary that exposes Mirror to the frontend lands in 2.1.2.

- [ ] **Step 3: `mirror/crypto.rs` skeleton**

Type declarations + `unimplemented!()` function bodies for `derive_master_key`, `derive_mek`, `derive_jek`, `derive_rek`, `encrypt`, `decrypt`. Empty `#[cfg(test)] mod tests {}` block ready for the C1-C18 tests in Task 2.

- [ ] **Step 4: `mirror/keychain.rs` skeleton**

Type declarations + `unimplemented!()` for `save_master_key`, `load_master_key`, `delete_master_key`, `save_salt`, `load_salt`, `ensure_salt`. Empty `#[cfg(test)] mod tests {}` ready for K1-K12 in Task 4.

- [ ] **Step 5: Wire into `lib.rs`**

Add `mod mirror;` near other module declarations (alphabetical between `meeting_recipes` and `oauth_flow` or wherever it fits).

- [ ] **Step 6: Verify compile**

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

Expected: clean (only existing 20 warnings).

---

## Task 2: Implement crypto.rs Argon2id + HKDF (test-first)

**Files:**
- Modify: `src-tauri/src/mirror/crypto.rs`

Implement Master Key derivation and the three sub-key derivations. TDD: write each test first, watch it fail, then implement.

- [ ] **Step 1: Test C1 (Argon2id round-trip)**

Test that `derive_master_key("hunter2", &salt_16)` returns 32 bytes deterministic for the same input. Implement `derive_master_key` to make it pass. Use `argon2::Argon2::new(Algorithm::Argon2id, Version::V0x13, params)` with `m=64MiB / t=3 / p=1 / out=32`.

- [ ] **Step 2: Tests C2 + C3 (input variation)**

Different salt with same passphrase → different master. Different passphrase with same salt → different master. Both should pass with the implementation from Step 1.

- [ ] **Step 3: Test C4 (KDF cost)**

Bench `derive_master_key` at the configured params; assert duration in [50ms, 500ms]. Loose bounds tolerate CI hardware variation. If it's outside the range, the params need tuning before this lands.

- [ ] **Step 4: Tests C5 + C6 + C15 (HKDF sub-keys)**

`derive_mek` / `derive_jek` / `derive_rek` from a single Master Key. C5: deterministic. C6: pairwise distinct. C15: rotating Master Key invalidates the old MEK.

Implement `derive_subkey(mk, info)` using `hkdf::Hkdf::<Sha256>::new(None, mk_bytes).expand(info, &mut out)`. Wrap in the three public helpers with the documented info strings.

- [ ] **Step 5: Compile + tests**

```bash
cargo test --lib mirror::crypto 2>&1 | tail -10
```

Expected: 5/18 pass (C1, C2, C3, C5, C6, C15 — the rest land in Task 3).

---

## Task 3: Implement crypto.rs encrypt / decrypt (test-first)

**Files:**
- Modify: `src-tauri/src/mirror/crypto.rs`

Implement the symmetric AEAD layer.

- [ ] **Step 1: Tests C7 + C8 + C9 + C10 (encrypt / decrypt / tamper detection)**

C7: `encrypt(key, "hello").decrypt(key) == "hello"`. C8: decrypt with wrong key errors. C9: flip a byte in ciphertext, decrypt errors. C10: flip a byte in nonce, decrypt errors.

Implement `encrypt` using `XChaCha20Poly1305::new_from_slice(key).encrypt(nonce, plaintext)` with a random 24-byte nonce from `getrandom`. The output struct holds the nonce and ciphertext+tag.

Implement `decrypt` using `cipher.decrypt(nonce, ciphertext.as_slice())`. Map errors to `"decryption failed (key mismatch or tampering)"` so callers can't distinguish the cause (anti-oracle hardening).

- [ ] **Step 2: Tests C11 + C12 + C13 + C14 (edge cases)**

C11: 10000 nonces are all unique. C12: empty plaintext round-trips. C13: 1MB plaintext round-trips. C14: random binary (non-UTF-8) round-trips byte-for-byte.

- [ ] **Step 3: Test C16 (multi-thread safety)**

Spawn 8 threads, each does 1000 encrypt calls. Aggregate nonces; assert no duplicates and no panics.

- [ ] **Step 4: Tests C17 + C18 (key bytes accessor + KEY_LEN sanity)**

`MasterKey::from_bytes(arr).as_bytes() == arr`. `KEY_LEN == 32` (compile-time const sanity).

- [ ] **Step 5: Compile + tests**

```bash
cargo test --lib mirror::crypto 2>&1 | grep -E "test result"
```

Expected: 18/18 pass.

---

## Task 4: Implement keychain.rs (macOS, test-first)

**Files:**
- Modify: `src-tauri/src/mirror/keychain.rs`

Implement the macOS Keychain wrapper. All tests gated to `#[cfg(target_os = "macos")]` — Linux/Windows compile but skip these tests.

- [ ] **Step 1: Tests K1 + K2 + K4 (basic round-trip + replace)**

K1: save then load returns same bytes. K2: load when nothing saved returns None. K4: save replaces previous.

Implement `save_master_key`, `load_master_key` using `security_framework::passwords::set_generic_password` / `get_generic_password`. Use unique service / account suffix per test invocation: `format!("ai.shogun.mirror.test.{}.{}", pid, seq)` so concurrent test runs don't collide.

- [ ] **Step 2: Tests K3 + K11 (delete idempotent + cleanup)**

K3: calling `delete_master_key` twice produces no error on second call (use `errSecItemNotFound` recovery). K11: tests clean up after themselves via a `Drop` impl on a test-fixture that calls delete.

- [ ] **Step 3: Tests K5 + K6 + K7 (salt management)**

K5: `save_salt(&[u8;16]).load_salt() == Some([u8;16])`. K6: `ensure_salt` creates if missing (returns 16-byte salt, persisted). K7: `ensure_salt` is idempotent (two calls return same bytes).

Implement `save_salt`, `load_salt`, `ensure_salt`. Use `getrandom` for the 16-byte initial salt.

- [ ] **Step 4: Tests K8 + K9 + K10 (concurrency / error / iCloud sync)**

K8: 4 concurrent threads each save → no panic, last write wins. K9: write a 16-byte entry manually, call `load_master_key`, expect `Err` with clear length-mismatch message. K10: after `save_master_key`, the keychain entry has `kSecAttrSynchronizable: true`.

K10 is the tricky one — `security-framework`'s high-level `passwords` module may not expose the synchronizable attribute directly. If it doesn't, drop down to `security-framework-sys` raw bindings and set the attribute explicitly. Document which path was taken in a comment above the `save_*` functions.

- [ ] **Step 5: Test K12 (naming sanity)**

Constants `SERVICE`, `ACCOUNT_MASTER_KEY`, `ACCOUNT_SALT` match the documented values in spec § 5.3. Pure compile-time check.

- [ ] **Step 6: Compile + tests**

```bash
cargo test --lib mirror::keychain 2>&1 | grep -E "test result"
```

Expected: 12/12 pass on macOS, 0 on other platforms (the module is empty there).

---

## Task 5: Verification gates

- [ ] **Step 1: `npm run check:rust`**

```bash
npm run check:rust 2>&1 | tail -5
```

Expected: exit 0. No new clippy warnings beyond the existing 20.

- [ ] **Step 2: Full `cargo test -p app`**

```bash
cd src-tauri && cargo test -p app 2>&1 | grep "^test result" | head -3
```

Expected: existing 581 + 18 new crypto + 12 new keychain = 611 pass / 0 fail / 1 ignored.

If the kioku_extraction module's tests cause a hang in a re-used shell (known environmental issue from prior session), run with `--skip kioku_extraction` and then `cargo test --lib kioku_extraction` separately.

- [ ] **Step 3: Cross-platform compile**

```bash
cd src-tauri && cargo check --target x86_64-unknown-linux-gnu 2>&1 | tail -5
```

If the Linux target isn't installed locally: a heuristic alternative is to confirm the file compiles by toggling `#[cfg(target_os = "macos")]` to `#[cfg(any())]` temporarily and running `cargo check`. Revert before commit. The point is to verify Linux/Windows builds don't break.

- [ ] **Step 4: Manual benchmark** (optional but recommended)

```bash
cd src-tauri && cargo test --lib mirror::crypto::tests::c4 -- --nocapture 2>&1 | tail -5
```

Inspect the printed duration. Should be in the 100-300ms range on Apple Silicon. If significantly higher or lower, file a follow-up to retune Argon2id params before 2.1.2 ships.

- [ ] **Step 5: Frontend untouched**

```bash
npm run test:e2e 2>&1 | grep -E "passed|failed" | tail -3
```

Expected: 30 pass (no regression — frontend unaware of Mirror).

---

## Task 6: Commit + Draft PR

- [ ] **Step 1: Commit**

Either one cohesive commit or split per task. Suggested split:

- Commit 1 (Task 1+2): `feat(cloud-mirror): Phase 2.1.0 — Argon2id KDF + HKDF sub-keys`
- Commit 2 (Task 3): `feat(cloud-mirror): Phase 2.1.0 — XChaCha20-Poly1305 AEAD`
- Commit 3 (Task 4): `feat(cloud-mirror): Phase 2.1.0 — macOS Keychain wrapper`

Or a single commit `feat(cloud-mirror): Phase 2.1.0 — encryption primitives` with all three.

- [ ] **Step 2: Push + open Draft PR**

```bash
git push -u origin feat/cloud-2-1-0-encryption-primitives
gh pr create --draft --title "feat(cloud-mirror): Phase 2.1.0 — encryption primitives" --body "..."
```

PR body should:
- Link the spec + architecture sub-spec
- List the 30 unit tests (C1-C18 + K1-K12) and what each covers
- Confirm no IPC commands / no UI / no frontend changes
- Acknowledge that 2.1.1 (protocol RFC) is the immediate next sub-phase

---

## Acceptance Criteria (Spec Coverage Check)

| Spec criterion | Implemented in |
|----------------|----------------|
| Argon2id KDF with documented params | Task 2 + C1, C4 |
| HKDF sub-key derivation (MEK / JEK / REK) | Task 2 + C5, C6, C15 |
| XChaCha20-Poly1305 AEAD round-trip | Task 3 + C7 |
| Tamper detection (wrong key / corrupted ct / corrupted nonce) | Task 3 + C8, C9, C10 |
| Random 24-byte nonces, no collision | Task 3 + C11, C16 |
| Edge cases (empty / 1MB / binary) | Task 3 + C12, C13, C14 |
| `MasterKey::from_bytes` / `as_bytes` round-trip | Task 3 + C17 |
| `KEY_LEN == 32` compile constant | Task 3 + C18 |
| Keychain save/load/delete | Task 4 + K1, K2, K3, K4 |
| Per-device salt management | Task 4 + K5, K6, K7 |
| Concurrent save safety | Task 4 + K8 |
| Bad-length read errors gracefully | Task 4 + K9 |
| `kSecAttrSynchronizable: true` set | Task 4 + K10 |
| Test cleanup hygiene | Task 4 + K11 |
| Service/account naming matches docs | Task 4 + K12 |
| `cargo test -p app` green | Task 5 (Step 2) |
| `cargo check --target linux` green | Task 5 (Step 3) |
| `npm run check:rust` green | Task 5 (Step 1) |
| No frontend regression | Task 5 (Step 5) |

---

## Self-Review Notes

- **Honest limitation:** Tests run on macOS in CI; cross-platform gating is verified by compile-only checks (Step 3 of Task 5). A real Linux/Windows runtime smoke is deferred to whenever those platforms get the iCloud-equivalent abstraction (Phase 4).
- **Why no `zeroize::Zeroize` Drop impls:** flagged in spec § 9; deferred to a security-hardening sub-phase. Acceptable for MVP — the surrounding OS is the primary attacker boundary, not RAM-level data exfil.
- **Why no IPC commands here:** the Mirror crate is the security boundary. Exposing keys over IPC would defeat the design. JS/TS code interacts via high-level commands added in 2.1.2 (e.g. `mirror_register`, `mirror_unlock`, `mirror_status`).
- **`security-framework` synchronizable test (K10):** if the high-level `passwords` API doesn't expose the attribute, the implementation drops to `security-framework-sys`. The test reads back the entry's attributes via the SDK to confirm the flag — purely a sanity check that the implementation chose the right code path.
- **Argon2id parameter calibration (D1):** 64MiB / t=3 / p=1 is the recommended starting point. Calibrate against the dev hardware in Task 5 Step 4. If the unlock takes >500ms on M1, drop to 32MiB / t=2 — security trades against UX. Document the final choice.
