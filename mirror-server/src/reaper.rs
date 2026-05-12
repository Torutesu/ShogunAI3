//! Background tombstone reaper — hard-purges tombstones older than retention window.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::storage::BlobStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaperConfig {
    /// How often to run the reaper, in seconds (default: 3600 = 1 hour).
    pub interval_seconds: u64,
    /// Tombstone retention in days (default: 30).
    pub tombstone_retention_days: u64,
}

impl Default for ReaperConfig {
    fn default() -> Self {
        ReaperConfig {
            interval_seconds: 3600,
            tombstone_retention_days: 30,
        }
    }
}

/// Run the reaper loop indefinitely.  Intended to be spawned via `tokio::spawn`.
pub async fn run_reaper(store: Arc<dyn BlobStore>, config: ReaperConfig) {
    let mut interval = tokio::time::interval(Duration::from_secs(config.interval_seconds));
    loop {
        interval.tick().await;
        let cutoff =
            chrono::Utc::now() - chrono::Duration::days(config.tombstone_retention_days as i64);
        match store.purge_tombstones_before(cutoff).await {
            Ok(purged) => {
                if purged > 0 {
                    tracing::info!("reaper purged {} tombstones", purged);
                }
            }
            Err(e) => tracing::warn!("reaper error: {}", e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{BlobCiphertext, BlobEnvelope, BlobMetadata, BlobStore, LocalDiskStore};
    use chrono::Utc;
    use tempfile::TempDir;

    fn make_envelope(id: &str, dev: &str) -> BlobEnvelope {
        BlobEnvelope {
            version: 1,
            blob_id: id.to_string(),
            device_id: dev.to_string(),
            created_at: Utc::now(),
            schema: "mem_items.v1".to_string(),
            metadata: BlobMetadata {
                kinds: vec!["screen".to_string()],
                provenance: "screen".to_string(),
                captured_at_minute: 100,
            },
            ciphertext: BlobCiphertext {
                nonce: "dGVzdG5vbmNlMjRieXRlczEyMzQ1Ng".to_string(),
                data: "encrypteddata".to_string(),
            },
            stored_at: None,
        }
    }

    #[tokio::test]
    async fn test_reaper_purges_old_tombstones() {
        let dir = TempDir::new().unwrap();
        let store: Arc<dyn BlobStore> = Arc::new(LocalDiskStore::new(dir.path()).await.unwrap());

        for i in 0..5u32 {
            let env = make_envelope(&format!("reaper{i:03}"), "rdev");
            store.put(&env).await.unwrap();
            store.tombstone(&format!("reaper{i:03}")).await.unwrap();
        }

        // Cutoff in the future — should purge all.
        let cutoff = Utc::now() + chrono::Duration::seconds(10);
        let purged = store.purge_tombstones_before(cutoff).await.unwrap();
        assert_eq!(purged, 5);
    }

    #[tokio::test]
    async fn test_reaper_keeps_recent_tombstones() {
        let dir = TempDir::new().unwrap();
        let store: Arc<dyn BlobStore> = Arc::new(LocalDiskStore::new(dir.path()).await.unwrap());

        for i in 0..3u32 {
            let env = make_envelope(&format!("recent{i:03}"), "rdev2");
            store.put(&env).await.unwrap();
            store.tombstone(&format!("recent{i:03}")).await.unwrap();
        }

        // Cutoff in the past — should keep all.
        let cutoff = Utc::now() - chrono::Duration::hours(1);
        let purged = store.purge_tombstones_before(cutoff).await.unwrap();
        assert_eq!(purged, 0);
    }

    #[tokio::test]
    async fn test_reaper_no_tombstones() {
        let dir = TempDir::new().unwrap();
        let store: Arc<dyn BlobStore> = Arc::new(LocalDiskStore::new(dir.path()).await.unwrap());

        let env = make_envelope("live001", "rdev3");
        store.put(&env).await.unwrap();

        let cutoff = Utc::now() + chrono::Duration::seconds(10);
        let purged = store.purge_tombstones_before(cutoff).await.unwrap();
        assert_eq!(purged, 0);
    }
}
