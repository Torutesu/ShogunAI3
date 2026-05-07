//! Storage abstraction layer — `BlobStore` trait + data types.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub mod local_disk;

// Re-export the concrete impl
pub use local_disk::LocalDiskStore;

// ── Error type ───────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("not found")]
    NotFound,
    #[error("gone (tombstoned)")]
    Gone,
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("internal: {0}")]
    Internal(String),
}

// ── Wire types ────────────────────────────────────────────────────────────────

/// Plaintext metadata carried inside a `BlobEnvelope`.
/// NEVER includes raw text or PII (see RFC § 4.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlobMetadata {
    pub kinds: Vec<String>,
    pub provenance: String,
    pub captured_at_minute: u64,
}

/// The ciphertext portion of a blob.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlobCiphertext {
    /// Base64 of 24-byte XChaCha20-Poly1305 nonce.
    pub nonce: String,
    /// Base64 of (ciphertext ‖ tag).
    pub data: String,
}

/// Full blob envelope as stored and returned on `GET /v1/blobs/<id>`.
/// Matches RFC § 4.1.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlobEnvelope {
    pub version: u8,
    pub blob_id: String,
    pub device_id: String,
    pub created_at: DateTime<Utc>,
    pub schema: String,
    pub metadata: BlobMetadata,
    pub ciphertext: BlobCiphertext,
    /// Server-assigned; not in the original POST body.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stored_at: Option<DateTime<Utc>>,
}

/// Lightweight entry returned in list responses (no ciphertext).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobListEntry {
    pub blob_id: String,
    pub device_id: String,
    pub stored_at: DateTime<Utc>,
    /// `None` when tombstoned.
    pub metadata: Option<BlobMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tombstoned_at: Option<DateTime<Utc>>,
}

/// Device registry record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceRecord {
    pub device_id: String,
    /// Per-server constant for single-account MVP.
    pub account_id: String,
    pub device_name: String,
    /// Argon2id-hashed bearer token.
    pub token_hash: String,
    pub registered_at: DateTime<Utc>,
}

// ── Query / result types ─────────────────────────────────────────────────────

pub struct ListQuery {
    pub device_id: Option<String>,
    pub since: Option<DateTime<Utc>>,
    pub until: Option<DateTime<Utc>>,
    /// Opaque base64 cursor: base64( JSON{ device_id, seq } ) per R5.
    pub cursor: Option<String>,
    pub limit: usize,
}

pub struct ListResult {
    pub blobs: Vec<BlobListEntry>,
    pub next_cursor: Option<String>,
}

// ── BlobStore trait ───────────────────────────────────────────────────────────

#[async_trait]
pub trait BlobStore: Send + Sync {
    /// Store a blob. Idempotent if same blob_id + same content; Conflict if different content.
    async fn put(&self, env: &BlobEnvelope) -> Result<(), StoreError>;

    /// Fetch a blob by id. Returns `None` if not found; `Gone` if tombstoned.
    async fn get(&self, blob_id: &str) -> Result<Option<BlobEnvelope>, StoreError>;

    /// List blobs matching the query. Ordered by (stored_at, seq).
    async fn list(&self, query: &ListQuery) -> Result<ListResult, StoreError>;

    /// Soft-delete a blob: removes ciphertext, keeps tombstone marker in index.
    async fn tombstone(&self, blob_id: &str) -> Result<(), StoreError>;

    /// Hard-purge tombstone records older than `before`. Returns count purged.
    async fn purge_tombstones_before(&self, before: DateTime<Utc>) -> Result<u64, StoreError>;

    /// Tombstone every blob for a device (used by DELETE /v1/devices/<id>).
    async fn tombstone_device(&self, device_id: &str) -> Result<u64, StoreError>;

    /// Persist a device record.
    async fn save_device(&self, record: &DeviceRecord) -> Result<(), StoreError>;

    /// Load a device record by id.
    async fn load_device(&self, device_id: &str) -> Result<Option<DeviceRecord>, StoreError>;

    /// Delete a device record.
    async fn delete_device(&self, device_id: &str) -> Result<(), StoreError>;

    /// List all device records.
    async fn list_devices(&self) -> Result<Vec<DeviceRecord>, StoreError>;

    /// Update a device's name.
    async fn update_device_name(
        &self,
        device_id: &str,
        new_name: &str,
    ) -> Result<DeviceRecord, StoreError>;
}

// ── Cursor codec ─────────────────────────────────────────────────────────────

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

#[derive(Debug, Serialize, Deserialize)]
pub struct CursorPayload {
    pub device_id: Option<String>,
    pub seq: u64,
}

pub fn encode_cursor(payload: &CursorPayload) -> String {
    let json = serde_json::to_string(payload).unwrap_or_default();
    URL_SAFE_NO_PAD.encode(json.as_bytes())
}

pub fn decode_cursor(cursor: &str) -> Option<CursorPayload> {
    let bytes = URL_SAFE_NO_PAD.decode(cursor).ok()?;
    serde_json::from_slice(&bytes).ok()
}
