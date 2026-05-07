//! Pure crypto. No I/O, no platform deps. Tested on every platform.
//!
//! Master Key derivation:  Argon2id(passphrase, salt) -> 32 bytes
//! Sub-key derivation:     HKDF-SHA256(MasterKey, info) -> 32 bytes per sub-key
//! Symmetric encryption:   XChaCha20-Poly1305 AEAD with random 24-byte nonces
//! See spec docs/superpowers/specs/2026-05-07-mirror-encryption-primitives-design.md.
//!
//! All types and functions here are consumed starting in Phase 2.1.2 (sync engine).
// Suppress dead-code warnings until Phase 2.1.2 consumes these APIs.
#![allow(dead_code)]

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use sha2::Sha256;

/// Argon2id parameters: 64MiB / 3 iters / 1 lane / 32-byte output.
const KDF_M_KIB: u32 = 64 * 1024;
const KDF_T: u32 = 3;
const KDF_P: u32 = 1;

/// Length in bytes of all key types in this module.
pub(crate) const KEY_LEN: usize = 32;

const HKDF_INFO_MEK: &[u8] = b"shogun.mirror.mek.v1";
const HKDF_INFO_JEK: &[u8] = b"shogun.mirror.jek.v1";
const HKDF_INFO_REK: &[u8] = b"shogun.mirror.rek.v1";

/// Master Key — 32-byte opaque value derived from a user passphrase via Argon2id.
/// Never exposed to JS/TS; only crosses module boundaries inside the Rust crate.
#[derive(Clone, Debug)]
pub(crate) struct MasterKey([u8; KEY_LEN]);

/// Memory Encryption Key — derived from MasterKey via HKDF-SHA256 with info
/// `b"shogun.mirror.mek.v1"`. Used to encrypt memory metadata blobs.
#[derive(Clone)]
pub(crate) struct MemoryEncryptionKey([u8; KEY_LEN]);

/// Job Encryption Key — derived from MasterKey via HKDF-SHA256 with info
/// `b"shogun.mirror.jek.v1"`. Used to encrypt extraction job payloads.
#[derive(Clone)]
pub(crate) struct JobEncryptionKey([u8; KEY_LEN]);

/// Result Encryption Key — derived from MasterKey via HKDF-SHA256 with info
/// `b"shogun.mirror.rek.v1"`. Used to encrypt extraction result blobs.
#[derive(Clone)]
pub(crate) struct ResultEncryptionKey([u8; KEY_LEN]);

/// Encrypted envelope: 24-byte nonce ‖ ciphertext ‖ 16-byte AEAD tag.
/// The tag is appended by XChaCha20-Poly1305 and included in `ciphertext`.
/// Total wire size = 24 + plaintext.len() + 16 bytes.
pub(crate) struct Ciphertext {
    pub(crate) nonce: [u8; 24],
    /// Ciphertext bytes including the 16-byte authentication tag appended by the AEAD.
    pub(crate) ciphertext: Vec<u8>,
}

/// Derive a `MasterKey` from a user passphrase and a per-device random salt.
///
/// Parameters: Argon2id, m=64MiB, t=3 iterations, p=1 lane, output=32 bytes.
/// Expected runtime on Apple Silicon: ~120–180 ms. Calibrated via test C4.
pub(crate) fn derive_master_key(passphrase: &str, salt: &[u8]) -> Result<MasterKey, String> {
    let params = Params::new(KDF_M_KIB, KDF_T, KDF_P, Some(KEY_LEN)).map_err(|e| e.to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(MasterKey(out))
}

/// Derive the Memory Encryption Key from a Master Key.
pub(crate) fn derive_mek(mk: &MasterKey) -> MemoryEncryptionKey {
    MemoryEncryptionKey(derive_subkey(mk, HKDF_INFO_MEK))
}

/// Derive the Job Encryption Key from a Master Key.
pub(crate) fn derive_jek(mk: &MasterKey) -> JobEncryptionKey {
    JobEncryptionKey(derive_subkey(mk, HKDF_INFO_JEK))
}

/// Derive the Result Encryption Key from a Master Key.
pub(crate) fn derive_rek(mk: &MasterKey) -> ResultEncryptionKey {
    ResultEncryptionKey(derive_subkey(mk, HKDF_INFO_REK))
}

fn derive_subkey(mk: &MasterKey, info: &[u8]) -> [u8; KEY_LEN] {
    let hk = Hkdf::<Sha256>::new(None, &mk.0);
    let mut out = [0u8; KEY_LEN];
    // HKDF expand cannot fail for output lengths ≤ 255 * HashLen (8160 bytes for SHA-256).
    hk.expand(info, &mut out).expect("HKDF expand cannot fail for 32-byte output");
    out
}

/// Encrypt `plaintext` with XChaCha20-Poly1305 AEAD using a random 24-byte nonce.
///
/// The returned `Ciphertext` contains the nonce and the authenticated ciphertext
/// (including the 16-byte AEAD tag). Random nonces are safe because the 192-bit
/// nonce space makes collisions vanishingly unlikely (~2^96 per birthday bound).
pub(crate) fn encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Ciphertext, String> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 24];
    getrandom::getrandom(&mut nonce_bytes).map_err(|e| e.to_string())?;
    let nonce = XNonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| e.to_string())?;
    Ok(Ciphertext { nonce: nonce_bytes, ciphertext })
}

/// Decrypt a `Ciphertext` produced by `encrypt`. Returns the original plaintext.
///
/// On any failure (wrong key, tampered ciphertext, tampered nonce) returns a
/// generic error message to avoid acting as a decryption oracle.
pub(crate) fn decrypt(key: &[u8; KEY_LEN], ct: &Ciphertext) -> Result<Vec<u8>, String> {
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|e| e.to_string())?;
    let nonce = XNonce::from_slice(&ct.nonce);
    cipher
        .decrypt(nonce, ct.ciphertext.as_slice())
        .map_err(|_| "decryption failed (key mismatch or tampering)".to_string())
}

impl MasterKey {
    /// Construct a MasterKey from raw bytes (e.g. when loading from keychain).
    /// Caller is responsible for ensuring the bytes came from a trusted source.
    pub(crate) fn from_bytes(b: [u8; KEY_LEN]) -> Self {
        Self(b)
    }

    /// Expose the raw key bytes. Use only for keychain storage and sub-key derivation.
    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl MemoryEncryptionKey {
    /// Expose the raw key bytes for use with `encrypt` / `decrypt`.
    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl JobEncryptionKey {
    /// Expose the raw key bytes for use with `encrypt` / `decrypt`.
    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl ResultEncryptionKey {
    /// Expose the raw key bytes for use with `encrypt` / `decrypt`.
    pub(crate) fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::time::Instant;

    // ─── Helper ───────────────────────────────────────────────────────────────

    fn random_key() -> [u8; KEY_LEN] {
        let mut k = [0u8; KEY_LEN];
        getrandom::getrandom(&mut k).unwrap();
        k
    }

    // ─── C1: Argon2id round-trip determinism ──────────────────────────────────

    #[test]
    fn c1_argon2id_round_trip_determinism() {
        let salt = b"fixed_16_b_salt!";
        let mk1 = derive_master_key("hunter2", salt).unwrap();
        let mk2 = derive_master_key("hunter2", salt).unwrap();
        assert_eq!(mk1.as_bytes(), mk2.as_bytes());
        assert_eq!(mk1.as_bytes().len(), KEY_LEN);
    }

    // ─── C2: Different salt → different master ────────────────────────────────

    #[test]
    fn c2_different_salt_yields_different_master() {
        let salt1 = [0xAA_u8; 16];
        let salt2 = [0xBB_u8; 16];
        let mk1 = derive_master_key("passphrase", &salt1).unwrap();
        let mk2 = derive_master_key("passphrase", &salt2).unwrap();
        assert_ne!(mk1.as_bytes(), mk2.as_bytes());
    }

    // ─── C3: Different passphrase → different master ──────────────────────────

    #[test]
    fn c3_different_passphrase_yields_different_master() {
        let salt = [0x42_u8; 16];
        let mk1 = derive_master_key("password1", &salt).unwrap();
        let mk2 = derive_master_key("password2", &salt).unwrap();
        assert_ne!(mk1.as_bytes(), mk2.as_bytes());
    }

    // ─── C4: KDF cost in [50ms, 500ms] (release-only timing gate) ────────────
    //
    // Debug builds run Argon2id ~20x slower (no LLVM opts) so the timing
    // assertion is only enforced in --release.  The test still exercises the
    // KDF in debug builds; it just skips the wall-clock assertion.

    #[test]
    fn c4_kdf_cost_in_acceptable_range() {
        let salt = [0x01_u8; 16];
        let start = Instant::now();
        let _mk = derive_master_key("benchmark_passphrase", &salt).unwrap();
        let elapsed = start.elapsed();
        println!("C4 — Argon2id KDF elapsed: {:?}", elapsed);

        // Only assert timing in optimized builds; debug is ~20x slower.
        #[cfg(not(debug_assertions))]
        {
            assert!(
                elapsed.as_millis() >= 50,
                "KDF too fast ({:?}): params may be misconfigured",
                elapsed
            );
            assert!(
                elapsed.as_millis() <= 500,
                "KDF too slow ({:?}): will hurt UX on target hardware",
                elapsed
            );
        }
    }

    // ─── C5: HKDF MEK derivation deterministic ────────────────────────────────

    #[test]
    fn c5_hkdf_mek_derivation_deterministic() {
        let salt = [0x55_u8; 16];
        let mk = derive_master_key("stable", &salt).unwrap();
        let mek1 = derive_mek(&mk);
        let mek2 = derive_mek(&mk);
        assert_eq!(mek1.as_bytes(), mek2.as_bytes());
    }

    // ─── C6: MEK / JEK / REK pairwise distinct ────────────────────────────────

    #[test]
    fn c6_mek_jek_rek_are_pairwise_distinct() {
        let salt = [0x66_u8; 16];
        let mk = derive_master_key("distinct", &salt).unwrap();
        let mek = derive_mek(&mk);
        let jek = derive_jek(&mk);
        let rek = derive_rek(&mk);
        assert_ne!(mek.as_bytes(), jek.as_bytes(), "MEK == JEK");
        assert_ne!(mek.as_bytes(), rek.as_bytes(), "MEK == REK");
        assert_ne!(jek.as_bytes(), rek.as_bytes(), "JEK == REK");
    }

    // ─── C7: encrypt round-trip ────────────────────────────────────────────────

    #[test]
    fn c7_encrypt_round_trip() {
        let key = random_key();
        let plaintext = b"hello, mirror world";
        let ct = encrypt(&key, plaintext).unwrap();
        let got = decrypt(&key, &ct).unwrap();
        assert_eq!(&got, plaintext);
    }

    // ─── C8: wrong key fails ──────────────────────────────────────────────────

    #[test]
    fn c8_wrong_key_decrypt_fails() {
        let k1 = random_key();
        let k2 = random_key();
        let ct = encrypt(&k1, b"secret").unwrap();
        let result = decrypt(&k2, &ct);
        assert!(result.is_err(), "decrypt with wrong key should fail");
        assert_eq!(result.unwrap_err(), "decryption failed (key mismatch or tampering)");
    }

    // ─── C9: tampered ciphertext fails ────────────────────────────────────────

    #[test]
    fn c9_tampered_ciphertext_fails() {
        let key = random_key();
        let mut ct = encrypt(&key, b"tamper me").unwrap();
        // Flip a byte in the middle of the ciphertext body (not the tag).
        let mid = ct.ciphertext.len() / 2;
        ct.ciphertext[mid] ^= 0xFF;
        let result = decrypt(&key, &ct);
        assert!(result.is_err(), "tampered ciphertext should fail authentication");
    }

    // ─── C10: tampered nonce fails ────────────────────────────────────────────

    #[test]
    fn c10_tampered_nonce_fails() {
        let key = random_key();
        let mut ct = encrypt(&key, b"nonce tamper").unwrap();
        ct.nonce[0] ^= 0xFF;
        let result = decrypt(&key, &ct);
        assert!(result.is_err(), "tampered nonce should fail authentication");
    }

    // ─── C11: nonce uniqueness over 10000 calls ───────────────────────────────

    #[test]
    fn c11_nonce_uniqueness_10000() {
        let key = random_key();
        let mut nonces: HashSet<[u8; 24]> = HashSet::with_capacity(10_000);
        for _ in 0..10_000 {
            let ct = encrypt(&key, b"x").unwrap();
            assert!(nonces.insert(ct.nonce), "nonce collision detected");
        }
    }

    // ─── C12: empty plaintext round-trips ────────────────────────────────────

    #[test]
    fn c12_empty_plaintext_round_trips() {
        let key = random_key();
        let ct = encrypt(&key, b"").unwrap();
        let got = decrypt(&key, &ct).unwrap();
        assert!(got.is_empty());
    }

    // ─── C13: 1 MB plaintext round-trips ─────────────────────────────────────

    #[test]
    fn c13_one_mb_plaintext_round_trips() {
        let key = random_key();
        let mut plaintext = vec![0u8; 1024 * 1024];
        getrandom::getrandom(&mut plaintext).unwrap();
        let ct = encrypt(&key, &plaintext).unwrap();
        let got = decrypt(&key, &ct).unwrap();
        assert_eq!(got, plaintext);
    }

    // ─── C14: random binary plaintext round-trips ────────────────────────────

    #[test]
    fn c14_binary_plaintext_round_trips() {
        let key = random_key();
        let mut plaintext = [0u8; 256];
        // Fill with all 256 possible byte values (non-UTF-8 safe mix).
        for (i, b) in plaintext.iter_mut().enumerate() {
            *b = i as u8;
        }
        let ct = encrypt(&key, &plaintext).unwrap();
        let got = decrypt(&key, &ct).unwrap();
        assert_eq!(&got[..], &plaintext[..]);
    }

    // ─── C15: rotating Master Key invalidates old MEK ─────────────────────────

    #[test]
    fn c15_master_key_rotation_invalidates_mek() {
        let salt = [0x15_u8; 16];
        let mk1 = derive_master_key("old-passphrase", &salt).unwrap();
        let mk2 = derive_master_key("new-passphrase", &salt).unwrap();
        let mek1 = derive_mek(&mk1);
        let mek2 = derive_mek(&mk2);
        assert_ne!(mek1.as_bytes(), mek2.as_bytes());
    }

    // ─── C16: multi-thread safety (8 threads × 1000 encrypts) ────────────────

    #[test]
    fn c16_multi_thread_no_nonce_collision() {
        use std::sync::{Arc, Mutex};
        use std::thread;

        let key = Arc::new(random_key());
        let nonces: Arc<Mutex<HashSet<[u8; 24]>>> = Arc::new(Mutex::new(HashSet::new()));
        let mut handles = Vec::new();

        for _ in 0..8 {
            let key = Arc::clone(&key);
            let nonces = Arc::clone(&nonces);
            let handle = thread::spawn(move || {
                let mut local = Vec::with_capacity(1000);
                for _ in 0..1000 {
                    let ct = encrypt(&key, b"thread-safe").unwrap();
                    local.push(ct.nonce);
                }
                let mut guard = nonces.lock().unwrap();
                for nonce in local {
                    assert!(guard.insert(nonce), "nonce collision in multi-thread test");
                }
            });
            handles.push(handle);
        }

        for h in handles {
            h.join().expect("thread panicked");
        }

        let final_count = nonces.lock().unwrap().len();
        assert_eq!(final_count, 8 * 1000, "expected 8000 unique nonces");
    }

    // ─── C17: from_bytes / as_bytes round-trip ───────────────────────────────

    #[test]
    fn c17_from_bytes_as_bytes_round_trip() {
        let arr: [u8; KEY_LEN] = random_key();
        let mk = MasterKey::from_bytes(arr);
        assert_eq!(mk.as_bytes(), &arr);
    }

    // ─── C18: KEY_LEN == 32 const sanity ─────────────────────────────────────

    #[test]
    fn c18_key_len_constant_is_32() {
        assert_eq!(KEY_LEN, 32);
        // Also confirm the constant matches what XChaCha20-Poly1305 requires.
        // XChaCha20Poly1305 key size is 256 bits = 32 bytes.
        let all_zeros = [0u8; KEY_LEN];
        // new_from_slice fails only if len != 32; this confirms KEY_LEN is correct.
        XChaCha20Poly1305::new_from_slice(&all_zeros)
            .expect("KEY_LEN must equal XChaCha20Poly1305 key length (32)");
    }

}
