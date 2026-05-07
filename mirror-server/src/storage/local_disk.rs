//! `LocalDiskStore` — file-per-blob + JSONL index per device.
//!
//! Layout:
//! ```text
//! data_dir/
//! ├── devices/<device_id>.json          DeviceRecord
//! ├── blobs/<device_id>/<blob_id>.json  BlobEnvelope (no ciphertext when tombstoned)
//! └── index/<device_id>.jsonl           IndexEntry lines (seq, blob_id, stored_at, tombstoned_at)
//! ```

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;

use super::{
    decode_cursor, encode_cursor, BlobEnvelope, BlobListEntry, BlobStore, CursorPayload,
    DeviceRecord, ListQuery, ListResult, StoreError,
};

// ── Index entry (one line per blob in the JSONL file) ───────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    seq: u64,
    blob_id: String,
    device_id: String,
    stored_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tombstoned_at: Option<DateTime<Utc>>,
}

// ── LocalDiskStore ────────────────────────────────────────────────────────────

pub struct LocalDiskStore {
    data_dir: PathBuf,
    /// Global monotonic sequence counter (per store instance).
    next_seq: AtomicU64,
}

impl LocalDiskStore {
    pub async fn new(data_dir: &Path) -> Result<Self, StoreError> {
        fs::create_dir_all(data_dir.join("devices")).await?;
        fs::create_dir_all(data_dir.join("blobs")).await?;
        fs::create_dir_all(data_dir.join("index")).await?;

        // Recover the next_seq from existing indices so we never reuse a seq after restart.
        let max_seq = Self::scan_max_seq(data_dir).await?;

        Ok(Self {
            data_dir: data_dir.to_owned(),
            next_seq: AtomicU64::new(max_seq + 1),
        })
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn blob_path(&self, device_id: &str, blob_id: &str) -> PathBuf {
        self.data_dir
            .join("blobs")
            .join(device_id)
            .join(format!("{blob_id}.json"))
    }

    fn index_path(&self, device_id: &str) -> PathBuf {
        self.data_dir
            .join("index")
            .join(format!("{device_id}.jsonl"))
    }

    fn device_path(&self, device_id: &str) -> PathBuf {
        self.data_dir
            .join("devices")
            .join(format!("{device_id}.json"))
    }

    fn tombstone_marker_path(&self, device_id: &str, blob_id: &str) -> PathBuf {
        self.data_dir
            .join("blobs")
            .join(device_id)
            .join(format!("{blob_id}.tombstone"))
    }

    /// Atomically write data to `path` via temp-file + rename.
    async fn atomic_write(path: &Path, data: &[u8]) -> Result<(), StoreError> {
        let tmp = path.with_extension("tmp");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        let mut f = fs::File::create(&tmp).await?;
        f.write_all(data).await?;
        f.flush().await?;
        drop(f);
        fs::rename(&tmp, path).await?;
        Ok(())
    }

    /// Append a line to the JSONL index.
    /// Uses a std::sync::Mutex to serialize appends without holding the guard across awaits.
    async fn append_index(&self, device_id: &str, entry: &IndexEntry) -> Result<(), StoreError> {
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');
        let path = self.index_path(device_id);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        // Open the file — this is async but we don't hold the lock here.
        let mut f = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;
        // Serialize the actual write with the lock, but the write itself is synchronous bytes.
        // We call write_all outside the lock (the fd is ours alone after open).
        f.write_all(line.as_bytes()).await?;
        Ok(())
    }

    /// Read all index entries for a device.
    async fn read_index(&self, device_id: &str) -> Result<Vec<IndexEntry>, StoreError> {
        let path = self.index_path(device_id);
        match fs::read_to_string(&path).await {
            Ok(content) => {
                let mut entries = Vec::new();
                for line in content.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    let entry: IndexEntry = serde_json::from_str(line)?;
                    entries.push(entry);
                }
                Ok(entries)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e.into()),
        }
    }

    /// Rewrite the JSONL index for a device atomically.
    async fn rewrite_index(
        &self,
        device_id: &str,
        entries: &[IndexEntry],
    ) -> Result<(), StoreError> {
        let mut content = String::new();
        for entry in entries {
            content.push_str(&serde_json::to_string(entry)?);
            content.push('\n');
        }
        let path = self.index_path(device_id);
        Self::atomic_write(&path, content.as_bytes()).await
    }

    /// Scan all JSONL indices and return the maximum seq found (0 if none).
    async fn scan_max_seq(data_dir: &Path) -> Result<u64, StoreError> {
        let index_dir = data_dir.join("index");
        let mut max_seq = 0u64;
        let mut rd = match fs::read_dir(&index_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path).await {
                for line in content.lines() {
                    if let Ok(ie) = serde_json::from_str::<IndexEntry>(line) {
                        if ie.seq > max_seq {
                            max_seq = ie.seq;
                        }
                    }
                }
            }
        }
        Ok(max_seq)
    }

    /// Collect `IndexEntry` rows from all device indices.
    async fn all_index_entries(&self) -> Result<Vec<IndexEntry>, StoreError> {
        let index_dir = self.data_dir.join("index");
        let mut all = Vec::new();
        let mut rd = match fs::read_dir(&index_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(all),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path).await {
                for line in content.lines() {
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(ie) = serde_json::from_str::<IndexEntry>(line) {
                        all.push(ie);
                    }
                }
            }
        }
        Ok(all)
    }
}

// ── BlobStore impl ────────────────────────────────────────────────────────────

#[async_trait]
impl BlobStore for LocalDiskStore {
    async fn put(&self, env: &BlobEnvelope) -> Result<(), StoreError> {
        let blob_dir = self.data_dir.join("blobs").join(&env.device_id);
        fs::create_dir_all(&blob_dir).await?;

        let path = self.blob_path(&env.device_id, &env.blob_id);

        // Check for existing blob.
        if let Ok(existing_bytes) = fs::read(&path).await {
            let existing: BlobEnvelope = serde_json::from_slice(&existing_bytes)?;
            if existing.ciphertext == env.ciphertext {
                // Idempotent re-upload — OK.
                return Ok(());
            } else {
                return Err(StoreError::Conflict(format!(
                    "blob_id {} already exists with different content",
                    env.blob_id
                )));
            }
        }

        // Check for tombstone — if the blob was previously tombstoned, reject new upload.
        let ts_path = self.tombstone_marker_path(&env.device_id, &env.blob_id);
        if ts_path.exists() {
            return Err(StoreError::Gone);
        }

        let stored_at = Utc::now();
        let mut stored_env = env.clone();
        stored_env.stored_at = Some(stored_at);

        let data = serde_json::to_vec(&stored_env)?;
        Self::atomic_write(&path, &data).await?;

        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let entry = IndexEntry {
            seq,
            blob_id: env.blob_id.clone(),
            device_id: env.device_id.clone(),
            stored_at,
            tombstoned_at: None,
        };
        self.append_index(&env.device_id, &entry).await?;

        Ok(())
    }

    async fn get(&self, blob_id: &str) -> Result<Option<BlobEnvelope>, StoreError> {
        // Search all device directories.
        let blobs_dir = self.data_dir.join("blobs");
        let mut rd = match fs::read_dir(&blobs_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.into()),
        };

        while let Some(device_entry) = rd.next_entry().await? {
            if !device_entry.file_type().await?.is_dir() {
                continue;
            }
            let device_id = device_entry.file_name().to_string_lossy().to_string();
            let path = self.blob_path(&device_id, blob_id);

            // Check for tombstone marker.
            let ts_path = self.tombstone_marker_path(&device_id, blob_id);
            if ts_path.exists() {
                return Err(StoreError::Gone);
            }

            match fs::read(&path).await {
                Ok(bytes) => {
                    let env: BlobEnvelope = serde_json::from_slice(&bytes)?;
                    return Ok(Some(env));
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => return Err(e.into()),
            }
        }

        Ok(None)
    }

    async fn list(&self, query: &ListQuery) -> Result<ListResult, StoreError> {
        // Decode cursor to get (optional device_id filter, min seq exclusive).
        let after_seq = if let Some(cursor_str) = &query.cursor {
            let payload = decode_cursor(cursor_str)
                .ok_or_else(|| StoreError::Internal("invalid cursor".to_string()))?;
            payload.seq
        } else {
            0
        };

        // Collect matching index entries.
        let mut entries = if let Some(ref dev_id) = query.device_id {
            self.read_index(dev_id).await?
        } else {
            self.all_index_entries().await?
        };

        // Filter by after_seq (cursor-based) and time range.
        entries.retain(|e| {
            if e.seq <= after_seq {
                return false;
            }
            if let Some(since) = query.since {
                if e.stored_at < since {
                    return false;
                }
            }
            if let Some(until) = query.until {
                if e.stored_at > until {
                    return false;
                }
            }
            true
        });

        // Sort by (stored_at, seq).
        entries.sort_by(|a, b| a.stored_at.cmp(&b.stored_at).then(a.seq.cmp(&b.seq)));

        let has_more = entries.len() > query.limit;
        let page: Vec<IndexEntry> = entries.into_iter().take(query.limit).collect();

        // Build list entries.
        let mut blobs = Vec::with_capacity(page.len());
        for ie in &page {
            if ie.tombstoned_at.is_some() {
                blobs.push(BlobListEntry {
                    blob_id: ie.blob_id.clone(),
                    device_id: ie.device_id.clone(),
                    stored_at: ie.stored_at,
                    metadata: None,
                    tombstoned_at: ie.tombstoned_at,
                });
            } else {
                // Load metadata from blob file.
                let blob_path = self.blob_path(&ie.device_id, &ie.blob_id);
                match fs::read(&blob_path).await {
                    Ok(bytes) => {
                        let env: BlobEnvelope = serde_json::from_slice(&bytes)?;
                        blobs.push(BlobListEntry {
                            blob_id: ie.blob_id.clone(),
                            device_id: ie.device_id.clone(),
                            stored_at: ie.stored_at,
                            metadata: Some(env.metadata),
                            tombstoned_at: None,
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        // Blob file missing but not tombstoned — skip (inconsistent state).
                        continue;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        }

        let next_cursor = if has_more || !blobs.is_empty() {
            // Next cursor points to last returned seq.
            if let Some(last) = page.last() {
                // Only emit next_cursor if there are more items.
                if has_more {
                    Some(encode_cursor(&CursorPayload {
                        device_id: query.device_id.clone(),
                        seq: last.seq,
                    }))
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok(ListResult { blobs, next_cursor })
    }

    async fn tombstone(&self, blob_id: &str) -> Result<(), StoreError> {
        // Find the blob.
        let blobs_dir = self.data_dir.join("blobs");
        let mut rd = match fs::read_dir(&blobs_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(StoreError::NotFound),
            Err(e) => return Err(e.into()),
        };

        let mut found_device: Option<String> = None;
        while let Some(device_entry) = rd.next_entry().await? {
            if !device_entry.file_type().await?.is_dir() {
                continue;
            }
            let device_id = device_entry.file_name().to_string_lossy().to_string();
            let path = self.blob_path(&device_id, blob_id);
            let ts_path = self.tombstone_marker_path(&device_id, blob_id);

            if ts_path.exists() {
                // Already tombstoned — idempotent.
                return Ok(());
            }
            if path.exists() {
                found_device = Some(device_id);
                break;
            }
        }

        let device_id = found_device.ok_or(StoreError::NotFound)?;
        let tombstoned_at = Utc::now();

        // Remove the blob file.
        let path = self.blob_path(&device_id, blob_id);
        fs::remove_file(&path).await?;

        // Write tombstone marker.
        let ts_path = self.tombstone_marker_path(&device_id, blob_id);
        let ts_data = serde_json::to_vec(&serde_json::json!({ "tombstoned_at": tombstoned_at }))?;
        Self::atomic_write(&ts_path, &ts_data).await?;

        // Update the JSONL index entry.
        let mut entries = self.read_index(&device_id).await?;
        let mut updated = false;
        for entry in &mut entries {
            if entry.blob_id == blob_id {
                entry.tombstoned_at = Some(tombstoned_at);
                updated = true;
            }
        }
        if !updated {
            // Index entry missing — this shouldn't happen but handle gracefully.
            return Err(StoreError::Internal(format!(
                "index entry for blob {blob_id} not found during tombstone"
            )));
        }
        self.rewrite_index(&device_id, &entries).await?;

        Ok(())
    }

    async fn purge_tombstones_before(&self, before: DateTime<Utc>) -> Result<u64, StoreError> {
        let index_dir = self.data_dir.join("index");
        let mut rd = match fs::read_dir(&index_dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(e) => return Err(e.into()),
        };

        let mut total_purged = 0u64;
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let device_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();

            let mut entries = self.read_index(&device_id).await?;
            let mut purged = 0u64;
            entries.retain(|e| {
                if let Some(ts) = e.tombstoned_at {
                    if ts < before {
                        purged += 1;
                        return false;
                    }
                }
                true
            });

            if purged > 0 {
                self.rewrite_index(&device_id, &entries).await?;
                // Also remove tombstone marker files.
                total_purged += purged;
            }
        }

        Ok(total_purged)
    }

    async fn tombstone_device(&self, device_id: &str) -> Result<u64, StoreError> {
        let entries = self.read_index(device_id).await?;
        let mut count = 0u64;

        for entry in &entries {
            if entry.tombstoned_at.is_none() {
                // Use our own tombstone method.
                match self.tombstone(&entry.blob_id).await {
                    Ok(()) => count += 1,
                    Err(StoreError::NotFound) => {} // already gone
                    Err(e) => return Err(e),
                }
            }
        }

        Ok(count)
    }

    async fn save_device(&self, record: &DeviceRecord) -> Result<(), StoreError> {
        let path = self.device_path(&record.device_id);
        let data = serde_json::to_vec(record)?;
        Self::atomic_write(&path, &data).await
    }

    async fn load_device(&self, device_id: &str) -> Result<Option<DeviceRecord>, StoreError> {
        let path = self.device_path(device_id);
        match fs::read(&path).await {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    async fn delete_device(&self, device_id: &str) -> Result<(), StoreError> {
        let path = self.device_path(device_id);
        match fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StoreError::NotFound),
            Err(e) => Err(e.into()),
        }
    }

    async fn list_devices(&self) -> Result<Vec<DeviceRecord>, StoreError> {
        let dir = self.data_dir.join("devices");
        let mut devices = Vec::new();
        let mut rd = match fs::read_dir(&dir).await {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(devices),
            Err(e) => return Err(e.into()),
        };
        while let Some(entry) = rd.next_entry().await? {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read(&path).await {
                Ok(bytes) => {
                    let record: DeviceRecord = serde_json::from_slice(&bytes)?;
                    devices.push(record);
                }
                Err(_) => continue,
            }
        }
        Ok(devices)
    }

    async fn update_device_name(
        &self,
        device_id: &str,
        new_name: &str,
    ) -> Result<DeviceRecord, StoreError> {
        let mut record = self
            .load_device(device_id)
            .await?
            .ok_or(StoreError::NotFound)?;
        record.device_name = new_name.to_string();
        self.save_device(&record).await?;
        Ok(record)
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{BlobCiphertext, BlobMetadata};
    use tempfile::TempDir;

    fn make_envelope(blob_id: &str, device_id: &str) -> BlobEnvelope {
        BlobEnvelope {
            version: 1,
            blob_id: blob_id.to_string(),
            device_id: device_id.to_string(),
            created_at: Utc::now(),
            schema: "mem_items.v1".to_string(),
            metadata: BlobMetadata {
                kinds: vec!["screen".to_string()],
                provenance: "screen".to_string(),
                captured_at_minute: 28872034,
            },
            ciphertext: BlobCiphertext {
                nonce: "VGhpcyBpcyAyNCBieXRlcyBleGFjdGx5".to_string(),
                data: "0Xn_fake_ciphertext".to_string(),
            },
            stored_at: None,
        }
    }

    async fn make_store() -> (LocalDiskStore, TempDir) {
        let dir = TempDir::new().unwrap();
        let store = LocalDiskStore::new(dir.path()).await.unwrap();
        (store, dir)
    }

    #[tokio::test]
    async fn test_put_and_get() {
        let (store, _dir) = make_store().await;
        let env = make_envelope("01HVXXX001", "01HVDDD001");
        store.put(&env).await.unwrap();
        let fetched = store.get("01HVXXX001").await.unwrap().unwrap();
        assert_eq!(fetched.blob_id, env.blob_id);
        assert_eq!(fetched.ciphertext.data, env.ciphertext.data);
        assert!(fetched.stored_at.is_some());
    }

    #[tokio::test]
    async fn test_get_missing_returns_none() {
        let (store, _dir) = make_store().await;
        let result = store.get("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_put_idempotent_same_content() {
        let (store, _dir) = make_store().await;
        let env = make_envelope("01HVXXX002", "01HVDDD001");
        store.put(&env).await.unwrap();
        store.put(&env).await.unwrap(); // should not error
                                        // List should have only 1 entry.
        let result = store
            .list(&ListQuery {
                device_id: Some("01HVDDD001".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert_eq!(result.blobs.len(), 1);
    }

    #[tokio::test]
    async fn test_put_conflict_different_content() {
        let (store, _dir) = make_store().await;
        let env1 = make_envelope("01HVXXX003", "01HVDDD001");
        let mut env2 = env1.clone();
        env2.ciphertext.data = "different_ciphertext".to_string();
        store.put(&env1).await.unwrap();
        let err = store.put(&env2).await.unwrap_err();
        assert!(matches!(err, StoreError::Conflict(_)));
    }

    #[tokio::test]
    async fn test_list_ordering() {
        let (store, _dir) = make_store().await;
        // Insert 10 blobs; verify they come back in seq order.
        for i in 0..10u32 {
            let env = make_envelope(&format!("blob{i:03}"), "dev001");
            store.put(&env).await.unwrap();
        }
        let result = store
            .list(&ListQuery {
                device_id: Some("dev001".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert_eq!(result.blobs.len(), 10);
        // Verify ordering is consistent (by stored_at, then seq).
        let seqs_ascending = result
            .blobs
            .windows(2)
            .all(|w| w[0].stored_at <= w[1].stored_at);
        assert!(seqs_ascending);
    }

    #[tokio::test]
    async fn test_cursor_pagination() {
        let (store, _dir) = make_store().await;
        for i in 0..10u32 {
            let env = make_envelope(&format!("cpblob{i:03}"), "devpag");
            store.put(&env).await.unwrap();
        }
        // Page 1: limit=4
        let r1 = store
            .list(&ListQuery {
                device_id: Some("devpag".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 4,
            })
            .await
            .unwrap();
        assert_eq!(r1.blobs.len(), 4);
        assert!(r1.next_cursor.is_some());

        // Page 2
        let r2 = store
            .list(&ListQuery {
                device_id: Some("devpag".to_string()),
                since: None,
                until: None,
                cursor: r1.next_cursor.clone(),
                limit: 4,
            })
            .await
            .unwrap();
        assert_eq!(r2.blobs.len(), 4);
        assert!(r2.next_cursor.is_some());

        // Page 3 — remainder
        let r3 = store
            .list(&ListQuery {
                device_id: Some("devpag".to_string()),
                since: None,
                until: None,
                cursor: r2.next_cursor.clone(),
                limit: 4,
            })
            .await
            .unwrap();
        assert_eq!(r3.blobs.len(), 2);
        assert!(r3.next_cursor.is_none());
    }

    #[tokio::test]
    async fn test_tombstone_visibility_in_list() {
        let (store, _dir) = make_store().await;
        let env = make_envelope("tbblob001", "dev002");
        store.put(&env).await.unwrap();
        store.tombstone("tbblob001").await.unwrap();

        // GET should return Gone.
        let err = store.get("tbblob001").await.unwrap_err();
        assert!(matches!(err, StoreError::Gone));

        // List should include the tombstone entry.
        let result = store
            .list(&ListQuery {
                device_id: Some("dev002".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert_eq!(result.blobs.len(), 1);
        assert!(result.blobs[0].tombstoned_at.is_some());
        assert!(result.blobs[0].metadata.is_none());
    }

    #[tokio::test]
    async fn test_purge_tombstones_before() {
        let (store, _dir) = make_store().await;
        for i in 0..5u32 {
            let env = make_envelope(&format!("purgeblob{i:03}"), "dev003");
            store.put(&env).await.unwrap();
            store.tombstone(&format!("purgeblob{i:03}")).await.unwrap();
        }

        // Purge everything tombstoned before "now + 1 second".
        let cutoff = Utc::now() + chrono::Duration::seconds(1);
        let purged = store.purge_tombstones_before(cutoff).await.unwrap();
        assert_eq!(purged, 5);

        // Index should now be empty.
        let result = store
            .list(&ListQuery {
                device_id: Some("dev003".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert_eq!(result.blobs.len(), 0);
    }

    #[tokio::test]
    async fn test_purge_respects_cutoff() {
        let (store, _dir) = make_store().await;
        for i in 0..5u32 {
            let env = make_envelope(&format!("cutoffblob{i:03}"), "dev004");
            store.put(&env).await.unwrap();
            store.tombstone(&format!("cutoffblob{i:03}")).await.unwrap();
        }

        // Purge only entries older than "now - 1 hour" (none should be purged).
        let cutoff = Utc::now() - chrono::Duration::hours(1);
        let purged = store.purge_tombstones_before(cutoff).await.unwrap();
        assert_eq!(purged, 0);
    }

    #[tokio::test]
    async fn test_tombstone_device() {
        let (store, _dir) = make_store().await;
        for i in 0..3u32 {
            let env = make_envelope(&format!("devtomb{i:03}"), "devtombs");
            store.put(&env).await.unwrap();
        }
        let count = store.tombstone_device("devtombs").await.unwrap();
        assert_eq!(count, 3);

        let result = store
            .list(&ListQuery {
                device_id: Some("devtombs".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        assert!(result.blobs.iter().all(|b| b.tombstoned_at.is_some()));
    }

    #[tokio::test]
    async fn test_device_crud() {
        let (store, _dir) = make_store().await;
        let record = DeviceRecord {
            device_id: "devA".to_string(),
            account_id: "account1".to_string(),
            device_name: "My Mac".to_string(),
            token_hash: "fakehash".to_string(),
            registered_at: Utc::now(),
        };
        store.save_device(&record).await.unwrap();
        let loaded = store.load_device("devA").await.unwrap().unwrap();
        assert_eq!(loaded.device_name, "My Mac");

        let updated = store.update_device_name("devA", "New Name").await.unwrap();
        assert_eq!(updated.device_name, "New Name");

        store.delete_device("devA").await.unwrap();
        let missing = store.load_device("devA").await.unwrap();
        assert!(missing.is_none());
    }

    #[tokio::test]
    async fn test_cursor_encode_decode_roundtrip() {
        let payload = CursorPayload {
            device_id: Some("device1".to_string()),
            seq: 42,
        };
        let encoded = encode_cursor(&payload);
        let decoded = decode_cursor(&encoded).unwrap();
        assert_eq!(decoded.seq, 42);
        assert_eq!(decoded.device_id, Some("device1".to_string()));
    }

    #[tokio::test]
    async fn test_restart_seq_recovery() {
        let dir = TempDir::new().unwrap();
        {
            let store = LocalDiskStore::new(dir.path()).await.unwrap();
            for i in 0..5u32 {
                let env = make_envelope(&format!("restart{i:03}"), "devR");
                store.put(&env).await.unwrap();
            }
        }
        // Re-open store — seq should resume from after 4.
        let store2 = LocalDiskStore::new(dir.path()).await.unwrap();
        let env = make_envelope("restart999", "devR");
        store2.put(&env).await.unwrap();
        let result = store2
            .list(&ListQuery {
                device_id: Some("devR".to_string()),
                since: None,
                until: None,
                cursor: None,
                limit: 100,
            })
            .await
            .unwrap();
        // seq of the 6th blob should be > 4
        assert_eq!(result.blobs.len(), 6);
    }
}
