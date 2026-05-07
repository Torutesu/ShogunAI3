//! Phase 2.1.4 — split-architecture search.
//!
//! Fetches encrypted blobs from the Mirror server in a time range, decrypts
//! locally with the MEK, runs vector similarity in-process, returns ranked
//! hits. The merge with local results happens in the frontend (per spec
//! `docs/superpowers/specs/2026-05-07-mirror-search-and-settings-ui-design.md`).

use crate::mirror::{crypto, http, sync as mirror_sync};
use base64::Engine;
use lru::LruCache;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::num::NonZeroUsize;
use std::sync::{Mutex, OnceLock};

// ─── Wire-format plaintext ───────────────────────────────────────────────────

/// Plaintext shape produced by `mirror::sync::build_plaintext_obj_no_embedding`
/// (with optional `embedding_b64` per RFC § 4.1).
#[allow(dead_code)] // consumed in T2 (commands.rs IPC) and T4 (frontend merge)
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MemItemPlaintext {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub kinds_json: String,
    pub created_at: i64,
    #[serde(default)]
    pub provenance: Option<String>,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub redaction: Option<String>,
    /// Base64-encoded little-endian f32 vector. Optional — older rows may not
    /// have it (or it may be dropped when the with-embedding plaintext exceeds
    /// the 1 MB cap; see `mirror::sync::build_blob_envelope`).
    #[serde(default)]
    pub embedding_b64: Option<String>,
}

#[allow(dead_code)] // consumed in T2 (commands.rs IPC) and T4 (frontend merge)
#[derive(Debug, Clone)]
pub(crate) struct CloudSearchHit {
    pub blob_id: String,
    pub device_id: String,
    pub mem_item: MemItemPlaintext,
    pub similarity: f32,
    pub source: HitSource,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HitSource {
    /// Reserved for the merge step in T4 (not produced by this module).
    #[allow(dead_code)]
    Local,
    MirrorThisDevice,
    MirrorOtherDevice {
        device_name: String,
    },
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/// Cosine similarity in [-1, 1]. Returns 0.0 if either vector is empty,
/// the lengths differ, or either vector has zero magnitude.
pub(crate) fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Sort hits by similarity desc; truncate to `k`. If `k == 0`, returns empty.
/// If `k >= hits.len()`, returns the full sorted list.
#[allow(dead_code)] // consumed in T4 (frontend merge ranks the cross-source result list)
pub(crate) fn rank_and_truncate(mut hits: Vec<CloudSearchHit>, k: usize) -> Vec<CloudSearchHit> {
    if k == 0 {
        return Vec::new();
    }
    hits.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    if hits.len() > k {
        hits.truncate(k);
    }
    hits
}

/// Decode an `embedding_b64` field into a `Vec<f32>` (little-endian f32s,
/// length must be a multiple of 4). Returns None on decode error.
fn decode_embedding_b64(s: &str) -> Option<Vec<f32>> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(s).ok()?;
    if bytes.len() % 4 != 0 {
        return None;
    }
    let out: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    Some(out)
}

// ─── Blob plaintext cache ────────────────────────────────────────────────────

/// Bounded by entry count (10K), not bytes. At typical blob sizes (~6KB)
/// this approximates the design's 64MB cap. A pathological user (blobs near
/// the 1MB plaintext limit) could push memory to ~10GB before saturation —
/// acceptable since that's far beyond the personal-memory-store scale.
const CACHE_CAPACITY: usize = 10_000;

static BLOB_CACHE: OnceLock<Mutex<LruCache<String, Vec<u8>>>> = OnceLock::new();

fn blob_cache() -> &'static Mutex<LruCache<String, Vec<u8>>> {
    BLOB_CACHE.get_or_init(|| {
        Mutex::new(LruCache::new(
            NonZeroUsize::new(CACHE_CAPACITY).expect("CACHE_CAPACITY > 0"),
        ))
    })
}

#[cfg(test)]
pub(crate) fn clear_cache_for_test() {
    let mut g = blob_cache().lock().expect("blob cache lock");
    g.clear();
}

// ─── Cloud search orchestration ──────────────────────────────────────────────

/// Defensive cap on cursor-drain pagination. Server max page size is 1000
/// entries, so 10K pages = 10M entries — well past anything legitimate. If
/// the loop hits this, the server is buggy or the response is hostile, and
/// we abort rather than burn unbounded memory.
const MAX_PAGES: usize = 10_000;

/// RFC 3339 representation of a unix-millisecond timestamp.
///
/// Clamps absurdly-far-future timestamps to year 9999-12-31 (chrono's max
/// supported year before its formatting machinery panics).
fn unix_ms_to_rfc3339(ms: i64) -> String {
    // Year 9999-12-31T23:59:59 ≈ 253402300799 secs since UNIX epoch.
    const MAX_SECS: u64 = 253_402_300_799;
    let ms_u = ms.max(0) as u64;
    let secs = (ms_u / 1000).min(MAX_SECS);
    let millis = ms_u % 1000;
    let dt = chrono::DateTime::<chrono::Utc>::from(
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs),
    );
    format!("{}.{:03}Z", dt.format("%Y-%m-%dT%H:%M:%S"), millis)
}

/// Drain `GET /v1/blobs` across all paginated cursors, returning a flat
/// vector of entries. Bounded by `max_pages` as a defensive cap against a
/// runaway `next_cursor` (server bug or hostile response).
async fn drain_blob_list(
    client: &http::Client,
    since_rfc: &str,
    until_rfc: &str,
    max_pages: usize,
) -> Result<Vec<http::BlobListEntry>, String> {
    let mut entries = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0usize;
    loop {
        pages += 1;
        if pages > max_pages {
            return Err(format!(
                "cloud-search: pagination exceeded MAX_PAGES ({max_pages}) — possible server bug or attack"
            ));
        }
        let resp = client
            .list_blobs_time_range(since_rfc, until_rfc, None, cursor.as_deref())
            .await
            .map_err(|e| format!("cloud-search: list failed: {e}"))?;
        entries.extend(resp.blobs);
        if resp.next_cursor.is_none() {
            break;
        }
        cursor = resp.next_cursor;
    }
    Ok(entries)
}

/// Search cloud blobs in the given time range. Returns unranked hits — the
/// caller (frontend merge layer) handles ranking + truncation across local +
/// cloud.
///
/// Calls `embeddings::embed_one` to produce the query vector. For unit tests
/// (no live embedding provider), use `search_cloud_blobs_with_embedding`
/// directly with a precomputed query vector.
///
/// `since_ms` / `until_ms` are unix milliseconds.
///
/// # Errors
/// - Returns `Err` if `embeddings::embed_one` fails (network or model issue).
/// - Returns `Err` if listing blobs fails on any page (network).
/// - Returns `Err` if pagination exceeds MAX_PAGES (defensive bound).
///
/// Per-blob errors (decrypt, deserialize, dimension mismatch, missing
/// embedding) are logged and the blob is skipped without aborting the search.
#[allow(dead_code)] // consumed in T2 (commands.rs IPC)
pub(crate) async fn search_cloud_blobs<F>(
    query: &str,
    since_ms: i64,
    until_ms: i64,
    client: &http::Client,
    mek: &crypto::MemoryEncryptionKey,
    this_device_id: &str,
    device_name_lookup: F,
) -> Result<Vec<CloudSearchHit>, String>
where
    F: Fn(&str) -> Option<String>,
{
    let query_emb = crate::embeddings::embed_one(query)
        .await
        .map_err(|e| format!("cloud-search: embed failed: {e}"))?;
    search_cloud_blobs_with_embedding(
        &query_emb,
        since_ms,
        until_ms,
        client,
        mek,
        this_device_id,
        device_name_lookup,
    )
    .await
}

/// Same as `search_cloud_blobs` but takes a precomputed query embedding.
/// Factored out so tests can avoid the network roundtrip to the embedding
/// provider.
#[allow(dead_code)] // consumed in T2 (commands.rs IPC) and exercised by tests below
pub(crate) async fn search_cloud_blobs_with_embedding<F>(
    query_emb: &[f32],
    since_ms: i64,
    until_ms: i64,
    client: &http::Client,
    mek: &crypto::MemoryEncryptionKey,
    this_device_id: &str,
    device_name_lookup: F,
) -> Result<Vec<CloudSearchHit>, String>
where
    F: Fn(&str) -> Option<String>,
{
    // 1. Convert ms → RFC 3339 (the wire format expected by
    //    Client::list_blobs_time_range).
    let since_rfc = unix_ms_to_rfc3339(since_ms);
    let until_rfc = unix_ms_to_rfc3339(until_ms);

    // 2. List blobs in range. Drain the cursor — server enforces a per-page
    //    limit (default 100 / max 1000); we may need multiple round trips for
    //    active accounts.
    let entries = drain_blob_list(client, &since_rfc, &until_rfc, MAX_PAGES).await?;

    // 3. For each non-tombstoned entry: cache-or-fetch, decrypt, deserialize,
    //    score. Skip entries that fail to decrypt or lack an embedding.
    let mut hits = Vec::new();
    for entry in entries {
        if entry.tombstoned_at.is_some() {
            continue;
        }

        // Cache lookup (clone bytes inside the lock so we release it fast).
        let cached: Option<Vec<u8>> = {
            let mut cache = blob_cache().lock().expect("blob cache lock");
            cache.get(&entry.blob_id).cloned()
        };

        let plaintext_bytes = match cached {
            Some(bytes) => bytes,
            None => {
                let envelope = match client.fetch_blob(&entry.blob_id).await {
                    Ok(e) => e,
                    Err(e) => {
                        log::warn!(
                            "cloud-search: fetch {} failed: {e}",
                            entry.blob_id
                        );
                        continue;
                    }
                };
                let decrypted = match decrypt_envelope(&envelope, mek) {
                    Ok(d) => d,
                    Err(e) => {
                        log::warn!(
                            "cloud-search: decrypt {} failed: {}",
                            entry.blob_id,
                            e
                        );
                        continue;
                    }
                };
                blob_cache()
                    .lock()
                    .expect("blob cache lock")
                    .put(entry.blob_id.clone(), decrypted.clone());
                decrypted
            }
        };

        let mem_item: MemItemPlaintext = match serde_json::from_slice(&plaintext_bytes) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "cloud-search: deserialize {} failed: {}",
                    entry.blob_id,
                    e
                );
                continue;
            }
        };

        // Skip entries without embeddings — cannot rank.
        let Some(emb_b64) = mem_item.embedding_b64.as_deref() else {
            continue;
        };
        let Some(item_emb) = decode_embedding_b64(emb_b64) else {
            continue;
        };

        // Skip entries whose embedding dimension differs from the query.
        // `cosine_similarity` would defensively return 0.0, but a 0-similarity
        // hit still pollutes the ranked result list — drop them entirely.
        if item_emb.len() != query_emb.len() {
            log::warn!(
                "cloud-search: dimension mismatch for {} (query {} vs item {}); skipping",
                entry.blob_id,
                query_emb.len(),
                item_emb.len()
            );
            continue;
        }

        let similarity = cosine_similarity(query_emb, &item_emb);

        let source = if entry.device_id == this_device_id {
            HitSource::MirrorThisDevice
        } else {
            HitSource::MirrorOtherDevice {
                device_name: device_name_lookup(&entry.device_id)
                    .unwrap_or_else(|| entry.device_id.chars().take(8).collect()),
            }
        };

        hits.push(CloudSearchHit {
            blob_id: entry.blob_id,
            device_id: entry.device_id,
            mem_item,
            similarity,
            source,
        });
    }
    Ok(hits)
}

/// Decrypt a `BlobEnvelope` using the MEK. Reconstructs the AEAD AD using the
/// same shape as `mirror::sync::build_blob_envelope`:
/// `{blob_id, device_id, metadata: {kinds, provenance, captured_at_minute},
///   schema, version}`, serialized via `mirror::sync::sorted_json_for_ad`.
///
/// Any deviation here would silently break decryption (AEAD AD must round-trip
/// byte-identically with the upload site).
fn decrypt_envelope(
    env: &http::BlobEnvelope,
    mek: &crypto::MemoryEncryptionKey,
) -> Result<Vec<u8>, String> {
    // Build the metadata sub-object (matches `BlobMetadata`'s serde shape).
    let metadata_value = serde_json::to_value(&env.metadata)
        .map_err(|e| format!("decrypt: metadata serialize: {e}"))?;

    // Build the AD object. Insertion order doesn't matter — `sorted_json_for_ad`
    // sorts keys before serializing.
    let mut ad_obj = Map::new();
    ad_obj.insert("blob_id".to_string(), Value::String(env.blob_id.clone()));
    ad_obj.insert("device_id".to_string(), Value::String(env.device_id.clone()));
    ad_obj.insert("metadata".to_string(), metadata_value);
    ad_obj.insert("schema".to_string(), Value::String(env.schema.clone()));
    ad_obj.insert(
        "version".to_string(),
        Value::Number(env.version.into()),
    );
    let ad_value = Value::Object(ad_obj);
    let ad_bytes = mirror_sync::sorted_json_for_ad(&ad_value)?;

    // Decode the wire ciphertext.
    let nonce_bytes = base64::engine::general_purpose::STANDARD
        .decode(&env.ciphertext.nonce)
        .map_err(|e| format!("decrypt: nonce b64: {e}"))?;
    let data_bytes = base64::engine::general_purpose::STANDARD
        .decode(&env.ciphertext.data)
        .map_err(|e| format!("decrypt: data b64: {e}"))?;

    if nonce_bytes.len() != 24 {
        return Err(format!("decrypt: nonce wrong len {}", nonce_bytes.len()));
    }
    let mut nonce_arr = [0u8; 24];
    nonce_arr.copy_from_slice(&nonce_bytes);

    let ct = crypto::Ciphertext {
        nonce: nonce_arr,
        ciphertext: data_bytes,
    };
    crypto::decrypt_with_ad(mek.as_bytes(), &ct, &ad_bytes)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mirror::http::{
        BlobEnvelope, BlobListEntry, BlobMetadata, EnvelopeCiphertext,
    };
    use mockito::Server;
    use serde_json::json;

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// Serializes tests that touch the global `BLOB_CACHE`. Without this,
    /// parallel cache-touching tests race and the LRU eviction tests (which
    /// expect specific evictees) become flaky.
    fn cache_test_lock() -> &'static std::sync::Mutex<()> {
        static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        M.get_or_init(|| std::sync::Mutex::new(()))
    }

    fn make_mek() -> crypto::MemoryEncryptionKey {
        let mk = crypto::MasterKey::from_bytes([0x42u8; 32]);
        crypto::derive_mek(&mk)
    }

    fn make_client(server: &Server) -> http::Client {
        http::Client::new(server.url(), "tok".to_string()).expect("Client::new")
    }

    fn encode_emb(v: &[f32]) -> String {
        let bytes: Vec<u8> = v.iter().flat_map(|f| f.to_le_bytes()).collect();
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    }

    /// Build an envelope by encrypting the given plaintext with the AD shape
    /// that `decrypt_envelope` expects. Mirrors `mirror::sync::build_blob_envelope`.
    fn build_test_envelope(
        blob_id: &str,
        device_id: &str,
        plaintext_obj: serde_json::Map<String, Value>,
        mek: &crypto::MemoryEncryptionKey,
    ) -> BlobEnvelope {
        let metadata = BlobMetadata {
            kinds: vec!["screen".to_string()],
            provenance: "screen".to_string(),
            captured_at_minute: 28872034,
        };
        let metadata_value =
            serde_json::to_value(&metadata).expect("BlobMetadata serializes");
        let ad_value = json!({
            "blob_id": blob_id,
            "device_id": device_id,
            "metadata": metadata_value,
            "schema": "mem_items.v1",
            "version": 1u8,
        });
        let ad_bytes = mirror_sync::sorted_json_for_ad(&ad_value).expect("AD bytes");

        let plaintext_bytes =
            serde_json::to_vec(&Value::Object(plaintext_obj)).expect("serialize plaintext");
        let ct = crypto::encrypt_with_ad(mek.as_bytes(), &plaintext_bytes, &ad_bytes)
            .expect("encrypt_with_ad");

        let nonce_b64 =
            base64::engine::general_purpose::STANDARD.encode(&ct.nonce);
        let data_b64 =
            base64::engine::general_purpose::STANDARD.encode(&ct.ciphertext);

        BlobEnvelope {
            version: 1,
            blob_id: blob_id.to_string(),
            device_id: device_id.to_string(),
            created_at: "2026-05-07T12:34:56.000Z".to_string(),
            schema: "mem_items.v1".to_string(),
            metadata,
            ciphertext: EnvelopeCiphertext {
                nonce: nonce_b64,
                data: data_b64,
            },
        }
    }

    fn make_plaintext_obj(
        id: &str,
        title: &str,
        snippet: &str,
        embedding: Option<&[f32]>,
    ) -> serde_json::Map<String, Value> {
        let mut obj = serde_json::Map::new();
        obj.insert("id".to_string(), Value::String(id.to_string()));
        obj.insert("title".to_string(), Value::String(title.to_string()));
        obj.insert("snippet".to_string(), Value::String(snippet.to_string()));
        obj.insert("source".to_string(), Value::String("capture_sampler".to_string()));
        obj.insert("kinds_json".to_string(), Value::String("[\"screen\"]".to_string()));
        obj.insert(
            "created_at".to_string(),
            Value::Number(serde_json::Number::from(1700000000000i64)),
        );
        obj.insert("provenance".to_string(), Value::String("screen".to_string()));
        if let Some(emb) = embedding {
            obj.insert("embedding_b64".to_string(), Value::String(encode_emb(emb)));
        }
        obj
    }

    fn make_list_entry(blob_id: &str, device_id: &str, tombstoned: bool) -> BlobListEntry {
        BlobListEntry {
            blob_id: blob_id.to_string(),
            device_id: device_id.to_string(),
            stored_at: "2026-05-07T12:34:57Z".to_string(),
            metadata: Some(BlobMetadata {
                kinds: vec!["screen".to_string()],
                provenance: "screen".to_string(),
                captured_at_minute: 28872034,
            }),
            tombstoned_at: if tombstoned {
                Some("2026-05-07T13:00:00Z".to_string())
            } else {
                None
            },
        }
    }

    fn empty_hit(sim: f32) -> CloudSearchHit {
        CloudSearchHit {
            blob_id: "b".to_string(),
            device_id: "d".to_string(),
            mem_item: MemItemPlaintext {
                id: "i".to_string(),
                title: String::new(),
                snippet: String::new(),
                source: String::new(),
                kinds_json: String::new(),
                created_at: 0,
                provenance: None,
                entity_id: None,
                confidence: None,
                redaction: None,
                embedding_b64: None,
            },
            similarity: sim,
            source: HitSource::MirrorThisDevice,
        }
    }

    // ─── cosine_similarity ───────────────────────────────────────────────────

    #[test]
    fn cs1_orthogonal_vectors_zero() {
        let a = [1.0f32, 0.0];
        let b = [0.0f32, 1.0];
        let s = cosine_similarity(&a, &b);
        assert!(s.abs() < 1e-6, "expected ~0, got {}", s);
    }

    #[test]
    fn cs2_parallel_vectors_one() {
        let a = [3.0f32, 4.0];
        let b = [6.0f32, 8.0]; // 2x scalar of a
        let s = cosine_similarity(&a, &b);
        assert!((s - 1.0).abs() < 1e-6, "expected ~1, got {}", s);
    }

    #[test]
    fn cs3_mismatched_length_zero() {
        let a = [1.0f32, 2.0];
        let b = [1.0f32, 2.0, 3.0];
        assert_eq!(cosine_similarity(&a, &b), 0.0);
        assert_eq!(cosine_similarity(&[], &[1.0f32, 2.0]), 0.0);
    }

    // ─── rank_and_truncate ───────────────────────────────────────────────────

    #[test]
    fn rt1_k_zero_returns_empty() {
        let hits = vec![empty_hit(0.9), empty_hit(0.1)];
        assert_eq!(rank_and_truncate(hits, 0).len(), 0);
    }

    #[test]
    fn rt2_k_equals_n_no_truncation() {
        let hits = vec![empty_hit(0.1), empty_hit(0.9), empty_hit(0.5)];
        let out = rank_and_truncate(hits, 3);
        assert_eq!(out.len(), 3);
        // Sorted descending.
        assert!(out[0].similarity >= out[1].similarity);
        assert!(out[1].similarity >= out[2].similarity);
        assert!((out[0].similarity - 0.9).abs() < 1e-6);
    }

    #[test]
    fn rt3_k_greater_than_n_no_panic() {
        let hits = vec![empty_hit(0.9), empty_hit(0.1)];
        let out = rank_and_truncate(hits, 50);
        assert_eq!(out.len(), 2);
        assert!((out[0].similarity - 0.9).abs() < 1e-6);
    }

    // ─── LRU cache ───────────────────────────────────────────────────────────

    #[test]
    fn lru1_miss_returns_none_initially() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let v = blob_cache()
            .lock()
            .unwrap()
            .get(&"missing".to_string())
            .cloned();
        assert!(v.is_none());
    }

    #[test]
    fn lru2_hit_returns_cached() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        blob_cache()
            .lock()
            .unwrap()
            .put("k".to_string(), vec![1u8, 2, 3]);
        let v = blob_cache()
            .lock()
            .unwrap()
            .get(&"k".to_string())
            .cloned();
        assert_eq!(v, Some(vec![1u8, 2, 3]));
    }

    #[test]
    fn lru3_eviction_at_capacity() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        // Insert CACHE_CAPACITY entries with keys "0".."N-1".
        {
            let mut g = blob_cache().lock().unwrap();
            for i in 0..CACHE_CAPACITY {
                g.put(format!("{}", i), vec![i as u8]);
            }
        }
        // Insert one more — the LRU entry ("0") must be evicted.
        {
            let mut g = blob_cache().lock().unwrap();
            g.put("overflow".to_string(), vec![0xFFu8]);
        }
        let evicted = blob_cache()
            .lock()
            .unwrap()
            .get(&"0".to_string())
            .cloned();
        assert!(evicted.is_none(), "expected '0' to be evicted");
        let kept = blob_cache()
            .lock()
            .unwrap()
            .get(&"overflow".to_string())
            .cloned();
        assert_eq!(kept, Some(vec![0xFFu8]));
    }

    #[test]
    fn lru4_get_promotes_to_most_recent() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        // Fill cache.
        {
            let mut g = blob_cache().lock().unwrap();
            for i in 0..CACHE_CAPACITY {
                g.put(format!("{}", i), vec![i as u8]);
            }
        }
        // Touch "0" — promotes it to MRU.
        {
            let mut g = blob_cache().lock().unwrap();
            let _ = g.get(&"0".to_string()).cloned();
        }
        // Insert one more — now "1" should be evicted (the new LRU), not "0".
        {
            let mut g = blob_cache().lock().unwrap();
            g.put("overflow".to_string(), vec![0xFFu8]);
        }
        let zero = blob_cache()
            .lock()
            .unwrap()
            .get(&"0".to_string())
            .cloned();
        let one = blob_cache()
            .lock()
            .unwrap()
            .get(&"1".to_string())
            .cloned();
        assert!(zero.is_some(), "'0' should still be cached after promotion");
        assert!(one.is_none(), "'1' should be evicted as new LRU");
    }

    // ─── decode_embedding_b64 ────────────────────────────────────────────────

    #[test]
    fn decode_embedding_round_trips() {
        let v = [1.0f32, -2.5, 3.14, 0.0];
        let s = encode_emb(&v);
        let got = decode_embedding_b64(&s).expect("decode");
        assert_eq!(got, v);
    }

    #[test]
    fn decode_embedding_rejects_bad_length() {
        // Encode 5 bytes (not multiple of 4).
        let s =
            base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 3, 4].as_slice());
        assert!(decode_embedding_b64(&s).is_none());
    }

    // ─── search_cloud_blobs_with_embedding (mockito) ─────────────────────────

    #[tokio::test]
    async fn search1_single_hit() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        let item_emb = vec![1.0f32, 0.0, 0.0];
        let query_emb = vec![1.0f32, 0.0, 0.0]; // parallel — sim=1
        let plaintext = make_plaintext_obj("row1", "Hello", "World", Some(&item_emb));
        let env = build_test_envelope("blob1", device_id, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("blob1", device_id, false)],
            "next_cursor": null,
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _fetch = server
            .mock("GET", "/v1/blobs/blob1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &query_emb,
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].blob_id, "blob1");
        assert_eq!(hits[0].mem_item.id, "row1");
        assert!((hits[0].similarity - 1.0).abs() < 1e-6);
        assert_eq!(hits[0].source, HitSource::MirrorThisDevice);
    }

    #[tokio::test]
    async fn search2_multiple_hits_rerank() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        let query_emb = vec![1.0f32, 0.0];
        // hit_a: parallel (sim ≈ 1.0)
        // hit_b: orthogonal (sim ≈ 0.0)
        let pa = make_plaintext_obj("ra", "A", "x", Some(&[1.0f32, 0.0]));
        let pb = make_plaintext_obj("rb", "B", "y", Some(&[0.0f32, 1.0]));
        let ea = build_test_envelope("ba", device_id, pa, &mek);
        let eb = build_test_envelope("bb", device_id, pb, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [
                make_list_entry("ba", device_id, false),
                make_list_entry("bb", device_id, false),
            ],
            "next_cursor": null,
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _fa = server
            .mock("GET", "/v1/blobs/ba")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&ea).unwrap())
            .create_async()
            .await;
        let _fb = server
            .mock("GET", "/v1/blobs/bb")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&eb).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &query_emb,
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert_eq!(hits.len(), 2);
        // After rank_and_truncate, ba (sim=1) should be first.
        let ranked = rank_and_truncate(hits, 10);
        assert_eq!(ranked[0].blob_id, "ba");
        assert!((ranked[0].similarity - 1.0).abs() < 1e-6);
        assert_eq!(ranked[1].blob_id, "bb");
        assert!(ranked[1].similarity.abs() < 1e-6);
    }

    #[tokio::test]
    async fn search3_tombstoned_skipped() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [
                make_list_entry("dead", device_id, true),
            ],
            "next_cursor": null,
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;

        // Explicit fetch-blob mock that fails the test if it is hit. Without
        // this, a regression that broke tombstone skipping but also broke
        // fetch (e.g. mockito returning 501 for an un-mocked path) would
        // still leave `hits.is_empty()` true and silently pass. `.expect(0)`
        // + `.assert_async()` makes mockito panic if any GET hits the path.
        let no_fetch_mock = server
            .mock("GET", "/v1/blobs/dead")
            .with_status(200)
            .with_body("{}")
            .expect(0)
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &[1.0f32, 0.0, 0.0],
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert!(hits.is_empty(), "tombstoned blobs must be skipped");
        no_fetch_mock.assert_async().await;
    }

    #[tokio::test]
    async fn search4_no_embedding_skipped() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        // Plaintext object WITHOUT embedding_b64.
        let plaintext = make_plaintext_obj("row1", "Hello", "World", None);
        let env = build_test_envelope("blob_noemb", device_id, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("blob_noemb", device_id, false)],
            "next_cursor": null,
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _fetch = server
            .mock("GET", "/v1/blobs/blob_noemb")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &[1.0f32, 0.0],
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert!(hits.is_empty(), "blobs without embedding must be skipped");
    }

    // ─── Source classification ───────────────────────────────────────────────

    #[tokio::test]
    async fn source1_this_device() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        let plaintext = make_plaintext_obj("r", "T", "S", Some(&[1.0f32, 0.0]));
        let env = build_test_envelope("b1", device_id, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("b1", device_id, false)],
            "next_cursor": null,
        });
        let _l = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _f = server
            .mock("GET", "/v1/blobs/b1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &[1.0f32, 0.0],
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].source, HitSource::MirrorThisDevice);
    }

    #[tokio::test]
    async fn source2_other_device_with_lookup_name() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let this_device = "this_dev";
        let other_device = "remote_device_id";

        let plaintext = make_plaintext_obj("r", "T", "S", Some(&[1.0f32, 0.0]));
        let env = build_test_envelope("b1", other_device, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("b1", other_device, false)],
            "next_cursor": null,
        });
        let _l = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _f = server
            .mock("GET", "/v1/blobs/b1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &[1.0f32, 0.0],
            0,
            i64::MAX / 2,
            &client,
            &mek,
            this_device,
            |id| {
                if id == other_device {
                    Some("Sarah's iPhone".to_string())
                } else {
                    None
                }
            },
        )
        .await
        .expect("search");

        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].source,
            HitSource::MirrorOtherDevice {
                device_name: "Sarah's iPhone".to_string()
            }
        );
    }

    #[tokio::test]
    async fn source3_other_device_lookup_none_falls_back_to_id_prefix() {
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let this_device = "this_dev";
        let other_device = "01HVXYZ1234567890_long_id";

        let plaintext = make_plaintext_obj("r", "T", "S", Some(&[1.0f32, 0.0]));
        let env = build_test_envelope("b1", other_device, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("b1", other_device, false)],
            "next_cursor": null,
        });
        let _l = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _f = server
            .mock("GET", "/v1/blobs/b1")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &[1.0f32, 0.0],
            0,
            i64::MAX / 2,
            &client,
            &mek,
            this_device,
            |_| None, // lookup always misses
        )
        .await
        .expect("search");

        assert_eq!(hits.len(), 1);
        // Falls back to first 8 chars of device_id.
        let expected_prefix: String = other_device.chars().take(8).collect();
        assert_eq!(
            hits[0].source,
            HitSource::MirrorOtherDevice {
                device_name: expected_prefix
            }
        );
    }

    // ─── Cursor pagination ───────────────────────────────────────────────────

    #[tokio::test]
    async fn search_cloud_blobs_drains_cursor() {
        // Server paginates GET /v1/blobs (default 100 / max 1000). Verify the
        // search drains all pages by making two list calls and producing hits
        // from both pages.
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        let item_emb = vec![1.0f32, 0.0, 0.0];
        let query_emb = vec![1.0f32, 0.0, 0.0];

        // Page 1: blobs "p1a" + "p1b", with next_cursor = "page2".
        let p1a = make_plaintext_obj("r1a", "P1A", "x", Some(&item_emb));
        let p1b = make_plaintext_obj("r1b", "P1B", "y", Some(&item_emb));
        let env_p1a = build_test_envelope("p1a", device_id, p1a, &mek);
        let env_p1b = build_test_envelope("p1b", device_id, p1b, &mek);
        // Page 2: blob "p2a", with next_cursor = null.
        let p2a = make_plaintext_obj("r2a", "P2A", "z", Some(&item_emb));
        let env_p2a = build_test_envelope("p2a", device_id, p2a, &mek);

        let mut server = Server::new_async().await;

        // We want page-1 and page-2 list mocks to be unambiguous. mockito 1.x
        // routes a request to the first mock whose matcher matches AND whose
        // hits are still under expectation; if multiple mocks match, the
        // tiebreak (first-with-missing-hits) is an internal detail we don't
        // want this test depending on. So:
        //
        // - Page-2 mock has an explicit `cursor=page2` matcher (UrlEncoded),
        //   so it ONLY matches the second call, when the client round-tripped
        //   the cursor.
        // - Page-1 mock matches any /v1/blobs? request and is constrained by
        //   `expect(1)` + `assert_async` below — if a regression caused both
        //   calls to land on it (e.g. the cursor wasn't sent), mockito would
        //   panic with "expected 1 hit, got 2", catching the bug.
        let list_body_p1 = json!({
            "blobs": [
                make_list_entry("p1a", device_id, false),
                make_list_entry("p1b", device_id, false),
            ],
            "next_cursor": "page2",
        });
        let list_p1 = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body_p1.to_string())
            .expect(1)
            .create_async()
            .await;

        // Page-2 mock: only matches when `cursor=page2` is present in the
        // query string. `match_query(Matcher::UrlEncoded(...))` parses the
        // query string properly (no fragile substring regex on the path).
        let list_body_p2 = json!({
            "blobs": [make_list_entry("p2a", device_id, false)],
            "next_cursor": null,
        });
        let list_p2 = server
            .mock("GET", "/v1/blobs")
            .match_query(mockito::Matcher::UrlEncoded(
                "cursor".to_string(),
                "page2".to_string(),
            ))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body_p2.to_string())
            .expect(1)
            .create_async()
            .await;

        // Per-blob fetch mocks for all three blobs.
        let _f_p1a = server
            .mock("GET", "/v1/blobs/p1a")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env_p1a).unwrap())
            .create_async()
            .await;
        let _f_p1b = server
            .mock("GET", "/v1/blobs/p1b")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env_p1b).unwrap())
            .create_async()
            .await;
        let _f_p2a = server
            .mock("GET", "/v1/blobs/p2a")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env_p2a).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &query_emb,
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        // All three blobs across both pages should produce hits.
        assert_eq!(hits.len(), 3, "expected 3 hits across 2 pages, got {}", hits.len());
        let mut ids: Vec<String> = hits.iter().map(|h| h.blob_id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["p1a".to_string(), "p1b".to_string(), "p2a".to_string()]);

        // Guard rail: each list mock must have been hit exactly once. If the
        // client failed to send the cursor, both calls would land on page-1
        // and `list_p1.assert_async()` would panic with "expected 1 hit, got 2".
        list_p1.assert_async().await;
        list_p2.assert_async().await;
    }

    // ─── unix_ms_to_rfc3339 ──────────────────────────────────────────────────

    #[test]
    fn unix_ms_to_rfc3339_zero() {
        let s = unix_ms_to_rfc3339(0);
        assert_eq!(s, "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn unix_ms_to_rfc3339_negative_clamps_to_zero() {
        // Negative ms should clamp to epoch (same as ms=0).
        let s = unix_ms_to_rfc3339(-1000);
        assert_eq!(s, "1970-01-01T00:00:00.000Z");
        let s_zero = unix_ms_to_rfc3339(0);
        assert_eq!(s, s_zero);
    }

    #[test]
    fn unix_ms_to_rfc3339_max_clamped() {
        // i64::MAX ms is far past year 9999. Seconds are clamped to year 9999
        // (chrono's max), but the millis-suffix is `(ms_u % 1000)` of the
        // unclamped value — that's a known quirk; we just verify the prefix.
        let s = unix_ms_to_rfc3339(i64::MAX);
        assert!(
            s.starts_with("9999-12-31T23:59:59."),
            "expected clamp to year 9999, got: {s}"
        );
        assert!(s.ends_with('Z'), "expected RFC 3339 'Z' suffix, got: {s}");
    }

    // ─── search_cloud_blobs_with_embedding — dimension mismatch ──────────────

    #[tokio::test]
    async fn search_cloud_blobs_dimension_mismatch_skipped() {
        // Item embedding length differs from query embedding length. Without
        // the orchestration-level skip, cosine_similarity would defensively
        // return 0.0 and pollute the result list with a 0-similarity hit.
        let _g = cache_test_lock().lock().unwrap_or_else(|e| e.into_inner());
        clear_cache_for_test();
        let mek = make_mek();
        let device_id = "this_dev";

        // Item embedding has 4 dims; query has 2.
        let item_emb = vec![1.0f32, 0.0, 0.0, 0.0];
        let query_emb = vec![1.0f32, 0.0];
        let plaintext = make_plaintext_obj("row1", "Hello", "World", Some(&item_emb));
        let env = build_test_envelope("blob_dim", device_id, plaintext, &mek);

        let mut server = Server::new_async().await;
        let list_body = json!({
            "blobs": [make_list_entry("blob_dim", device_id, false)],
            "next_cursor": null,
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(list_body.to_string())
            .create_async()
            .await;
        let _fetch = server
            .mock("GET", "/v1/blobs/blob_dim")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(serde_json::to_string(&env).unwrap())
            .create_async()
            .await;

        let client = make_client(&server);
        let hits = search_cloud_blobs_with_embedding(
            &query_emb,
            0,
            i64::MAX / 2,
            &client,
            &mek,
            device_id,
            |_| None,
        )
        .await
        .expect("search");

        assert!(
            hits.is_empty(),
            "blobs with mismatched embedding dimensions must be skipped, got {} hits",
            hits.len()
        );
    }

    // ─── Pagination max-pages cap ────────────────────────────────────────────

    #[tokio::test]
    async fn drain_blob_list_caps_at_max_pages() {
        // Server keeps returning a non-null next_cursor forever. The drain
        // helper must abort once it exceeds the configured max_pages bound.
        // We use a small max_pages here so the test doesn't actually do 10K
        // round trips — the production constant is `MAX_PAGES = 10_000`.
        let mut server = Server::new_async().await;
        let runaway_body = json!({
            "blobs": [],
            "next_cursor": "always_more",
        });
        let _list = server
            .mock("GET", mockito::Matcher::Regex(r"^/v1/blobs\?".to_string()))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(runaway_body.to_string())
            // Allow this mock to serve as many calls as needed (up to the
            // bound + 1 attempt that fails the cap check).
            .expect_at_least(1)
            .create_async()
            .await;

        let client = make_client(&server);
        // Use a small bound for testing. The production code uses
        // `MAX_PAGES = 10_000`; the helper takes max_pages as a parameter
        // expressly so we can verify the bound triggers without 10K calls.
        let result = drain_blob_list(
            &client,
            "1970-01-01T00:00:00.000Z",
            "9999-12-31T23:59:59.000Z",
            5,
        )
        .await;

        let err = result.expect_err("drain should fail when pagination exceeds max_pages");
        assert!(
            err.contains("MAX_PAGES (5)") || err.contains("pagination exceeded"),
            "expected pagination-exceeded error message, got: {err}"
        );
    }
}
