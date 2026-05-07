//! Memory Mirror — encrypted cloud sync of memory metadata.
//! Decomposed into sub-phases per
//! `docs/superpowers/specs/2026-05-06-memory-mirror-mvp-architecture.md`.
//! 2.1.0 ships only the crypto + keychain primitives; later phases add
//! sync engine, server, and UI on top of these.

pub(crate) mod crypto;

#[cfg(target_os = "macos")]
pub(crate) mod keychain;

// Re-export the canonical types so consumers don't pierce into sub-modules.
// These APIs are consumed starting in Phase 2.1.2 (sync engine + IPC commands).
#[allow(unused_imports)]
pub(crate) use crypto::{
    decrypt, derive_jek, derive_master_key, derive_mek, derive_rek, encrypt, Ciphertext,
    JobEncryptionKey, MasterKey, MemoryEncryptionKey, ResultEncryptionKey, KEY_LEN,
};
