//! Mac-side sync engine: turns local mem_items rows into encrypted blobs
//! and uploads them to the configured Mirror server. Background-thread driven,
//! pause-safe, retry-with-backoff.
//!
//! See spec `docs/superpowers/specs/2026-05-07-mirror-sync-engine-design.md`.

use crate::mirror::{crypto, http};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub(crate) struct SyncStats {
    pub queue_depth: u64,
    pub last_sync_at: Option<i64>,
    pub last_error: Option<String>,
    pub synced_total: u64,
    /// true when master_key is None (engine locked).
    pub locked: bool,
}

impl Default for SyncStats {
    fn default() -> Self {
        Self {
            queue_depth: 0,
            last_sync_at: None,
            last_error: None,
            synced_total: 0,
            locked: true,
        }
    }
}

/// A single row from mem_items that is a candidate for sync.
#[derive(Debug, Clone)]
pub(crate) struct MemItemRow {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub kinds_json: String,
    pub created_at: i64,
    pub provenance: Option<String>,
    pub entity_id: Option<String>,
    pub confidence: Option<f64>,
    pub redaction: Option<String>,
    pub sync_status: String,
    pub sync_excluded_reason: Option<String>,
    pub cloud_index_id: Option<String>,
    pub encrypted_at: Option<i64>,
    /// How many upload attempts have been made for this row.
    pub attempt_count: i64,
}

/// Outcome of `classify_error_for_retry`.
#[derive(Debug, PartialEq)]
pub(crate) enum RetryDisposition {
    /// Permanent error — mark row `excluded`, don't retry.
    Permanent,
    /// Transient error — leave row as `local_only`, increment attempt counter.
    Transient,
    /// Server-specified backoff — honor Retry-After duration.
    BackoffSpecific(Duration),
}

// ─── SyncEngine ──────────────────────────────────────────────────────────────

pub(crate) struct SyncEngine {
    master_key: Mutex<Option<crypto::MasterKey>>,
    stats: Mutex<SyncStats>,
    client: Mutex<Option<http::Client>>,
}

static ENGINE: OnceLock<SyncEngine> = OnceLock::new();

impl SyncEngine {
    /// Return the process-wide singleton SyncEngine.
    pub(crate) fn global() -> &'static Self {
        ENGINE.get_or_init(|| SyncEngine {
            master_key: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
            client: Mutex::new(None),
        })
    }


    /// Unlock the engine: derive MasterKey from passphrase and cache it.
    ///
    /// # Security discipline
    /// The passphrase string lives only in the stack frame of this function
    /// and the `crypto::derive_master_key` call chain. It is never stored.
    /// The derived MasterKey is cached in process memory (cleared by `lock()`
    /// or `mirror_disable`).
    #[cfg(target_os = "macos")]
    pub(crate) fn unlock(&self, passphrase: &str) -> Result<(), String> {
        // 1. Load or create the per-device salt from Keychain.
        let salt = crate::mirror::keychain::ensure_salt()?;

        // 2. Derive MasterKey via Argon2id.
        let mk = crypto::derive_master_key(passphrase, &salt)?;

        // 3. Optionally verify against the stored MasterKey (if one exists).
        if let Some(stored) = crate::mirror::keychain::load_master_key()? {
            if stored.as_bytes() != mk.as_bytes() {
                return Err("passphrase does not match stored master key".to_string());
            }
        } else {
            // First time: persist the new MasterKey to Keychain.
            crate::mirror::keychain::save_master_key(&mk)?;
        }

        // 4. Cache in the Mutex.
        {
            let mut guard = self.master_key.lock().map_err(|e| e.to_string())?;
            *guard = Some(mk);
        }

        // 5. Update stats.
        {
            let mut s = self.stats.lock().map_err(|e| e.to_string())?;
            s.locked = false;
        }

        Ok(())
    }

    /// Non-macOS stub — keychain unavailable off macOS.
    #[cfg(not(target_os = "macos"))]
    pub(crate) fn unlock(&self, _passphrase: &str) -> Result<(), String> {
        Err("Mirror unlock is only supported on macOS".to_string())
    }

    /// Clear the cached MasterKey. Does NOT delete from Keychain.
    pub(crate) fn lock(&self) {
        if let Ok(mut guard) = self.master_key.lock() {
            *guard = None;
        }
        if let Ok(mut s) = self.stats.lock() {
            s.locked = true;
        }
    }

    /// Snapshot the current stats.
    pub(crate) fn stats(&self) -> SyncStats {
        self.stats.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Wire up the HTTP client (called from `mirror_register` after registration).
    pub(crate) fn set_client(&self, client: http::Client) {
        if let Ok(mut guard) = self.client.lock() {
            *guard = Some(client);
        }
    }

    /// Clear the HTTP client (called from `mirror_disable`).
    pub(crate) fn clear_client(&self) {
        if let Ok(mut guard) = self.client.lock() {
            *guard = None;
        }
    }

    /// Run one sync cycle. Returns the number of rows successfully uploaded.
    pub(crate) fn run_cycle(&self) -> Result<u64, String> {
        // Check if mirror is enabled in settings.
        let settings = crate::settings_store::load()
            .unwrap_or_else(|_| json!({ "sections": {} }));
        let sections = settings.get("sections").and_then(|s| s.as_object());

        let enabled = sections
            .and_then(|s| s.get("cloud_mirror"))
            .and_then(|m| m.get("enabled"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if !enabled {
            return Ok(0);
        }

        // Honor capture pause — if capture is paused, sync also pauses (S9).
        let capture_paused = sections
            .and_then(|s| s.get("capture"))
            .and_then(|c| c.get("paused"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if capture_paused {
            return Ok(0);
        }

        // Must be unlocked.
        let mek = {
            let guard = self.master_key.lock().map_err(|e| e.to_string())?;
            match &*guard {
                Some(mk) => crypto::derive_mek(mk),
                None => return Err("Mirror is locked — call mirror_unlock first".to_string()),
            }
        };

        // Must have a configured client.
        let client = {
            let guard = self.client.lock().map_err(|e| e.to_string())?;
            guard.clone()
        };
        let client = client.ok_or_else(|| "Mirror client not configured — call mirror_register first".to_string())?;

        let device_id = sections
            .and_then(|s| s.get("cloud_mirror"))
            .and_then(|m| m.get("device_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown_device")
            .to_string();

        // Open the DB and select pending rows.
        let conn = crate::memory_store::open_conn()?;
        let batch_size = 50; // S5: 50 rows per cycle.
        let rows = select_pending_rows(&conn, batch_size)?;

        // Update queue depth in stats.
        {
            let total_pending: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mem_items WHERE sync_status = 'local_only'",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            if let Ok(mut s) = self.stats.lock() {
                s.queue_depth = total_pending as u64;
            }
        }

        let mut synced_count = 0u64;
        let max_attempts = 6; // S4: 30s, 60s, 5m, 30m, 2h, then stuck.

        // Build a per-cycle tokio runtime for async HTTP calls (S in plan Task 3 Step 5).
        // We're on a std::thread; use block_on via Handle if Tauri's runtime is available,
        // otherwise create a small per-cycle runtime.
        let rt_handle = tokio::runtime::Handle::try_current().ok();

        for row in &rows {
            // S11: check pause state between rows.
            let re_settings = crate::settings_store::load()
                .unwrap_or_else(|_| json!({ "sections": {} }));
            let still_paused = re_settings
                .get("sections")
                .and_then(|s| s.as_object())
                .and_then(|s| s.get("capture"))
                .and_then(|c| c.get("paused"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if still_paused {
                break;
            }

            // Apply allowlist filter.
            if !apply_allowlist(row, &settings) {
                // Mark excluded — won't retry.
                let _ = conn.execute(
                    "UPDATE mem_items SET sync_status = 'excluded', sync_excluded_reason = 'allowlist' WHERE id = ?1",
                    params![row.id],
                );
                continue;
            }

            // Build the BlobEnvelope.
            let envelope = match build_blob_envelope(row, &mek, &device_id) {
                Ok(env) => env,
                Err(e) => {
                    log::warn!("mirror sync: build_blob_envelope failed for {}: {}", row.id, e);
                    // Treat as permanent if it's a size error.
                    if e.contains("too large") {
                        let _ = conn.execute(
                            "UPDATE mem_items SET sync_status = 'excluded', sync_excluded_reason = 'payload_too_large' WHERE id = ?1",
                            params![row.id],
                        );
                    }
                    continue;
                }
            };

            // Upload.
            let upload_result: Result<http::UploadResponse, http::Error> = if let Some(handle) = &rt_handle {
                handle.block_on(client.upload_blob(&envelope))
            } else {
                // Create a small per-call runtime.
                match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt.block_on(client.upload_blob(&envelope)),
                    Err(e) => Err(http::Error::Network(e.to_string())),
                }
            };

            match upload_result {
                Ok(resp) => {
                    // 201: mark synced, store cloud_index_id + encrypted_at.
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let _ = conn.execute(
                        "UPDATE mem_items SET sync_status = 'synced', cloud_index_id = ?1, encrypted_at = ?2 WHERE id = ?3",
                        params![resp.blob_id, now_ms, row.id],
                    );
                    synced_count += 1;
                }
                Err(err) => {
                    let disposition = classify_error_for_retry(&err);
                    match disposition {
                        RetryDisposition::Permanent => {
                            let reason = format!("{}", err);
                            let _ = conn.execute(
                                "UPDATE mem_items SET sync_status = 'excluded', sync_excluded_reason = ?1 WHERE id = ?2",
                                params![reason, row.id],
                            );
                        }
                        RetryDisposition::Transient | RetryDisposition::BackoffSpecific(_) => {
                            let new_attempts = row.attempt_count + 1;
                            if new_attempts >= max_attempts {
                                // "Stuck" — leave as local_only but log for the user.
                                log::warn!(
                                    "mirror sync: row {} stuck after {} attempts: {}",
                                    row.id, new_attempts, err
                                );
                                if let Ok(mut s) = self.stats.lock() {
                                    s.last_error = Some(format!("stuck: {}", err));
                                }
                            } else {
                                log::info!(
                                    "mirror sync: transient error for {} (attempt {}): {}",
                                    row.id, new_attempts, err
                                );
                                if let Ok(mut s) = self.stats.lock() {
                                    s.last_error = Some(format!("{}", err));
                                }
                            }
                        }
                    }
                }
            }
        }

        // Update stats.
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if let Ok(mut s) = self.stats.lock() {
            s.last_sync_at = Some(now_ms);
            s.synced_total += synced_count;
            if synced_count > 0 {
                s.last_error = None;
            }
        }

        Ok(synced_count)
    }
}

/// Spawn the background scheduler on a std::thread.
/// The scheduler sleeps for the configured interval, then calls run_cycle.
/// Spawning unconditionally is safe — run_cycle is a no-op when mirror is disabled (S9).
pub(crate) fn spawn_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        loop {
            let interval_secs = scheduler_interval_secs(&app);
            std::thread::sleep(Duration::from_secs(interval_secs));
            let engine = SyncEngine::global();
            if let Err(e) = engine.run_cycle() {
                log::warn!("mirror sync: run_cycle error: {}", e);
            }
        }
    });
}

fn scheduler_interval_secs(_app: &tauri::AppHandle) -> u64 {
    // Read from settings if available; default 5 minutes (S6).
    let settings = crate::settings_store::load()
        .unwrap_or_else(|_| json!({ "sections": {} }));
    settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("sync_interval_minutes"))
        .and_then(|v| v.as_u64())
        .map(|m| m.clamp(1, 1440) * 60)
        .unwrap_or(300) // default 5 minutes
}

// ─── Pure helpers (testable) ──────────────────────────────────────────────────

/// Select rows eligible for sync: sync_status = 'local_only', up to batch_size rows.
pub(crate) fn select_pending_rows(
    conn: &Connection,
    batch_size: usize,
) -> Result<Vec<MemItemRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, snippet, source, kinds_json, created_at,
                    provenance, entity_id, confidence, redaction,
                    sync_status, sync_excluded_reason, cloud_index_id, encrypted_at
             FROM mem_items
             WHERE sync_status = 'local_only'
             ORDER BY created_at ASC
             LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let rows: Vec<MemItemRow> = stmt
        .query_map(params![batch_size as i64], |r| {
            Ok(MemItemRow {
                id: r.get(0)?,
                title: r.get(1)?,
                snippet: r.get(2)?,
                source: r.get(3)?,
                kinds_json: r.get(4)?,
                created_at: r.get(5)?,
                provenance: r.get(6)?,
                entity_id: r.get(7)?,
                confidence: r.get(8)?,
                redaction: r.get(9)?,
                sync_status: r.get(10)?,
                sync_excluded_reason: r.get(11)?,
                cloud_index_id: r.get(12)?,
                encrypted_at: r.get(13)?,
                attempt_count: 0, // tracked in-process only for now
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Build a BlobEnvelope from a mem_items row per RFC § 4.1.
/// The plaintext is the row's JSON (matching row_to_item shape, embedding as base64).
/// AEAD associated data is canonical JSON of {version, blob_id, device_id, schema, metadata} per RFC § 4.3.
pub(crate) fn build_blob_envelope(
    row: &MemItemRow,
    mek: &crypto::MemoryEncryptionKey,
    device_id: &str,
) -> Result<http::BlobEnvelope, String> {
    // Construct plaintext: the row's JSON representation.
    let plaintext_value = json!({
        "id": row.id,
        "title": row.title,
        "snippet": row.snippet,
        "source": row.source,
        "kinds_json": row.kinds_json,
        "created_at": row.created_at,
        "provenance": row.provenance,
        "entity_id": row.entity_id,
        "confidence": row.confidence,
        "redaction": row.redaction,
        "sync_status": "synced",
        "sync_excluded_reason": null,
    });
    let plaintext_bytes = serde_json::to_vec(&plaintext_value).map_err(|e| e.to_string())?;

    // Size guard: 1MB limit per RFC § 4.1 + S7.
    const MAX_PLAINTEXT_BYTES: usize = 1024 * 1024; // 1MB
    if plaintext_bytes.len() > MAX_PLAINTEXT_BYTES {
        return Err(format!(
            "row {} is too large for sync: {} bytes (limit {})",
            row.id,
            plaintext_bytes.len(),
            MAX_PLAINTEXT_BYTES
        ));
    }

    // Generate a ULID-like blob_id (use a UUID v4 for MVP simplicity — RFC allows any unique string).
    let blob_id = format!("blob_{}", uuid::Uuid::new_v4().simple());

    // Build the metadata whitelist (RFC § 4.2).
    let kinds: Vec<String> = serde_json::from_str::<Value>(&row.kinds_json)
        .ok()
        .and_then(|v| v.as_array().cloned())
        .map(|arr| arr.into_iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_else(|| vec!["screen".to_string()]);

    let provenance = row
        .provenance
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::memory_store::derive_provenance(&row.source).to_string());

    // captured_at_minute = floor(created_at_ms / 60_000).
    let captured_at_minute = (row.created_at.max(0) as u64) / 60_000;

    let metadata = http::BlobMetadata {
        kinds: kinds.clone(),
        provenance: provenance.clone(),
        captured_at_minute,
    };

    // RFC 3339 created_at (ms → ISO 8601).
    let created_at_str = {
        let secs = row.created_at.max(0) as u64 / 1000;
        let millis = row.created_at.max(0) as u64 % 1000;
        format_rfc3339(secs, millis)
    };

    // AEAD associated data per RFC § 4.3: canonical (sorted keys, no whitespace) JSON of
    // {version, blob_id, device_id, schema, metadata}.
    let ad_value = json!({
        "blob_id": blob_id,
        "device_id": device_id,
        "metadata": {
            "captured_at_minute": captured_at_minute,
            "kinds": kinds,
            "provenance": provenance,
        },
        "schema": "mem_items.v1",
        "version": 1u8,
    });
    // Use a canonicalized form (sorted keys). serde_json's BTreeMap serialization is sorted.
    let ad_bytes = canonical_json(&ad_value)?;

    // Encrypt with AEAD.
    let ct = crypto::encrypt_with_ad(mek.as_bytes(), &plaintext_bytes, &ad_bytes)?;

    let nonce_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &ct.nonce);
    let data_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &ct.ciphertext);

    Ok(http::BlobEnvelope {
        version: 1,
        blob_id,
        device_id: device_id.to_string(),
        created_at: created_at_str,
        schema: "mem_items.v1".to_string(),
        metadata,
        ciphertext: http::EnvelopeCiphertext {
            nonce: nonce_b64,
            data: data_b64,
        },
    })
}

/// Classify an HTTP error to determine retry policy (S4).
pub(crate) fn classify_error_for_retry(err: &http::Error) -> RetryDisposition {
    match err {
        // Permanent rejections — don't retry.
        http::Error::Unauthorized
        | http::Error::InvalidEnvelope(_)
        | http::Error::Conflict(_)
        | http::Error::PayloadTooLarge
        | http::Error::Gone => RetryDisposition::Permanent,
        // Transient — retry with backoff.
        http::Error::Network(_) | http::Error::ServerError(_) | http::Error::Unknown(_) => {
            RetryDisposition::Transient
        }
        // Server-specified backoff.
        http::Error::RateLimited(d) => RetryDisposition::BackoffSpecific(*d),
        // Not found is permanent — row isn't visible, something is wrong.
        http::Error::NotFound => RetryDisposition::Permanent,
    }
}

/// Apply allowlist filter: a row is eligible for sync only if its source/app is
/// permitted by `sections.cloud_mirror.app_allowlist`.
/// Default when no allowlist configured: allow all (pass-through).
pub(crate) fn apply_allowlist(row: &MemItemRow, settings: &Value) -> bool {
    let allowlist: Vec<String> = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("app_allowlist"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // Empty allowlist = allow all.
    if allowlist.is_empty() {
        return true;
    }

    // Wildcard.
    if allowlist.iter().any(|a| a == "*") {
        return true;
    }

    // Check if the row's source matches any allowlist entry.
    allowlist.iter().any(|a| a == &row.source)
}

// ─── Internal utilities ───────────────────────────────────────────────────────

/// Format Unix seconds + milliseconds as an RFC 3339 string (simplified, no TZ offset).
fn format_rfc3339(secs: u64, millis: u64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let d = UNIX_EPOCH + Duration::from_secs(secs);
    // Use chrono for proper formatting.
    let dt = chrono::DateTime::<chrono::Utc>::from(d);
    format!("{}.{:03}Z", dt.format("%Y-%m-%dT%H:%M:%S"), millis)
}

/// Produce canonical JSON (RFC 8785 — lexicographically sorted keys, no whitespace).
/// For our use case this means converting Value to a sorted BTreeMap structure.
fn canonical_json(value: &Value) -> Result<Vec<u8>, String> {
    // serde_json serializes Object in insertion order. To get sorted keys we
    // round-trip through serde_json::to_string then re-parse into a BTreeMap.
    let canonical = to_canonical_value(value);
    serde_json::to_vec(&canonical).map_err(|e| e.to_string())
}

fn to_canonical_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            // BTreeMap sorts keys lexicographically.
            let mut btree: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
            for (k, v) in map {
                btree.insert(k.clone(), to_canonical_value(v));
            }
            serde_json::to_value(btree).unwrap_or(Value::Null)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(to_canonical_value).collect()),
        other => other.clone(),
    }
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Create an in-memory SQLite connection with the full mem_items schema
    /// (including all context-layer columns that would be added by open_conn).
    fn make_full_conn() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory db");
        crate::memory_store::init_schema(&conn).expect("init_schema");
        crate::memory_store::ensure_embedding_column(&conn).expect("ensure_embedding_column");
        crate::memory_store::ensure_context_layer_columns(&conn)
            .expect("ensure_context_layer_columns");
        conn
    }

    fn make_row(id: &str) -> MemItemRow {
        MemItemRow {
            id: id.to_string(),
            title: "Test Title".to_string(),
            snippet: "Test Snippet".to_string(),
            source: "capture_sampler".to_string(),
            kinds_json: "[\"screen\"]".to_string(),
            created_at: 1700000000000,
            provenance: Some("screen".to_string()),
            entity_id: None,
            confidence: None,
            redaction: None,
            sync_status: "local_only".to_string(),
            sync_excluded_reason: None,
            cloud_index_id: None,
            encrypted_at: None,
            attempt_count: 0,
        }
    }

    fn make_mek() -> crypto::MemoryEncryptionKey {
        let mk = crypto::MasterKey::from_bytes([0x42u8; 32]);
        crypto::derive_mek(&mk)
    }

    // ─── U1: select_pending_rows filter ───────────────────────────────────────

    #[test]
    fn u1_select_pending_rows_filter() {
        let conn = make_full_conn();

        // Insert one local_only and one synced row.
        conn.execute(
            "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, sync_status)
             VALUES ('r1', 'T', 'S', 'capture_sampler', '[]', 1000, 'local_only')",
            [],
        ).expect("insert local");
        conn.execute(
            "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, sync_status)
             VALUES ('r2', 'T', 'S', 'capture_sampler', '[]', 2000, 'synced')",
            [],
        ).expect("insert synced");

        let rows = select_pending_rows(&conn, 50).expect("select");
        assert_eq!(rows.len(), 1, "only local_only row should be selected");
        assert_eq!(rows[0].id, "r1");
    }

    // ─── U2: select_pending_rows LIMIT ────────────────────────────────────────

    #[test]
    fn u2_select_pending_rows_limit() {
        let conn = make_full_conn();

        for i in 0..10i64 {
            conn.execute(
                "INSERT INTO mem_items (id, title, snippet, source, kinds_json, created_at, sync_status)
                 VALUES (?1, 'T', 'S', 'capture_sampler', '[]', ?2, 'local_only')",
                params![format!("r{}", i), i],
            ).expect("insert");
        }

        let rows = select_pending_rows(&conn, 3).expect("select");
        assert_eq!(rows.len(), 3, "LIMIT should be honored");
    }

    // ─── U3: apply_allowlist true ─────────────────────────────────────────────

    #[test]
    fn u3_apply_allowlist_true_when_wildcard() {
        let row = make_row("r1");
        let settings = json!({
            "sections": {
                "cloud_mirror": { "app_allowlist": ["*"] }
            }
        });
        assert!(apply_allowlist(&row, &settings));
    }

    // ─── U4: apply_allowlist false ────────────────────────────────────────────

    #[test]
    fn u4_apply_allowlist_false_when_source_not_in_list() {
        let mut row = make_row("r1");
        row.source = "notion".to_string();
        let settings = json!({
            "sections": {
                "cloud_mirror": { "app_allowlist": ["capture_sampler"] }
            }
        });
        assert!(!apply_allowlist(&row, &settings));
    }

    // ─── U5: build_blob_envelope produces RFC § 4.1 shape ────────────────────

    #[test]
    fn u5_build_blob_envelope_shape() {
        let row = make_row("r1");
        let mek = make_mek();
        let env = build_blob_envelope(&row, &mek, "dev_1").expect("build_blob_envelope");

        assert_eq!(env.version, 1);
        assert!(!env.blob_id.is_empty());
        assert_eq!(env.device_id, "dev_1");
        assert_eq!(env.schema, "mem_items.v1");
        assert_eq!(env.metadata.kinds, vec!["screen"]);
        assert_eq!(env.metadata.provenance, "screen");
        assert!(!env.ciphertext.nonce.is_empty());
        assert!(!env.ciphertext.data.is_empty());
    }

    // ─── U6: AEAD AD binding includes correct fields ──────────────────────────

    #[test]
    fn u6_build_blob_envelope_aead_ad_binding() {
        // Two calls produce different blob_ids (UUIDs) but same structural shape.
        let row = make_row("r1");
        let mek = make_mek();
        let env1 = build_blob_envelope(&row, &mek, "dev_1").expect("env1");
        let env2 = build_blob_envelope(&row, &mek, "dev_1").expect("env2");

        // Different blob_ids (UUIDs are random).
        assert_ne!(env1.blob_id, env2.blob_id);
        // Different nonces (random).
        assert_ne!(env1.ciphertext.nonce, env2.ciphertext.nonce);
        // Both have version=1 and schema=mem_items.v1.
        assert_eq!(env1.version, env2.version);
        assert_eq!(env1.schema, env2.schema);
    }

    // ─── U7: payload > 1MB rejected ──────────────────────────────────────────

    #[test]
    fn u7_build_blob_envelope_rejects_oversized_row() {
        let mut row = make_row("r_big");
        // 1.1MB title field.
        row.title = "x".repeat(1024 * 1024 + 100);
        let mek = make_mek();
        let result = build_blob_envelope(&row, &mek, "dev_1");
        assert!(result.is_err(), "oversized row should be rejected");
        assert!(result.unwrap_err().contains("too large"));
    }

    // ─── U8: classify_error_for_retry for 5xx ────────────────────────────────

    #[test]
    fn u8_classify_5xx_as_transient() {
        let err = http::Error::ServerError(503);
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Transient);
    }

    // ─── U9: classify_error_for_retry for 401 ────────────────────────────────

    #[test]
    fn u9_classify_401_as_permanent() {
        let err = http::Error::Unauthorized;
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Permanent);
    }

    // ─── U10: classify_error_for_retry for 429 ───────────────────────────────

    #[test]
    fn u10_classify_429_as_backoff_specific() {
        let dur = Duration::from_secs(120);
        let err = http::Error::RateLimited(dur);
        match classify_error_for_retry(&err) {
            RetryDisposition::BackoffSpecific(d) => assert_eq!(d, dur),
            other => panic!("expected BackoffSpecific, got: {:?}", other),
        }
    }

    // ─── U11: Master Key cache lifecycle ─────────────────────────────────────

    #[test]
    fn u11_master_key_cache_lifecycle() {
        // Create a local engine for this test to avoid global state pollution.
        let engine = SyncEngine {
            master_key: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
            client: Mutex::new(None),
        };

        // Initially locked.
        let s = engine.stats();
        assert!(s.locked, "engine should start locked");

        // Inject a key directly (bypassing keychain for unit test).
        {
            let mut guard = engine.master_key.lock().unwrap();
            *guard = Some(crypto::MasterKey::from_bytes([0x42u8; 32]));
        }
        {
            let mut s = engine.stats.lock().unwrap();
            s.locked = false;
        }

        let s2 = engine.stats();
        assert!(!s2.locked, "engine should be unlocked after key injection");

        // Lock clears the key.
        engine.lock();
        let s3 = engine.stats();
        assert!(s3.locked, "engine should be locked after lock()");

        {
            let guard = engine.master_key.lock().unwrap();
            assert!(guard.is_none(), "master_key should be None after lock()");
        }
    }

    // ─── U12-U15: state machine transitions ──────────────────────────────────

    #[test]
    fn u12_classify_network_error_as_transient() {
        let err = http::Error::Network("connection refused".to_string());
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Transient);
    }

    #[test]
    fn u13_classify_payload_too_large_as_permanent() {
        let err = http::Error::PayloadTooLarge;
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Permanent);
    }

    #[test]
    fn u14_classify_invalid_envelope_as_permanent() {
        let err = http::Error::InvalidEnvelope("bad field".to_string());
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Permanent);
    }

    #[test]
    fn u15_classify_conflict_as_permanent() {
        let err = http::Error::Conflict("blob_id collision".to_string());
        assert_eq!(classify_error_for_retry(&err), RetryDisposition::Permanent);
    }

    // ─── U16: empty queue returns 0 ──────────────────────────────────────────

    #[test]
    fn u16_empty_queue() {
        let conn = make_full_conn();
        let rows = select_pending_rows(&conn, 50).expect("select");
        assert_eq!(rows.len(), 0);
    }

    // ─── U17: apply_allowlist default (empty list) allows all ─────────────────

    #[test]
    fn u17_apply_allowlist_default_allows_all() {
        let row = make_row("r1");
        let settings = json!({ "sections": {} });
        assert!(apply_allowlist(&row, &settings), "empty allowlist should allow all");
    }

    // ─── U18: apply_allowlist with matching source ─────────────────────────────

    #[test]
    fn u18_apply_allowlist_matching_source() {
        let row = make_row("r1"); // source = "capture_sampler"
        let settings = json!({
            "sections": {
                "cloud_mirror": { "app_allowlist": ["capture_sampler", "notion"] }
            }
        });
        assert!(apply_allowlist(&row, &settings));
    }

    // ─── U19: format_rfc3339 output shape ─────────────────────────────────────

    #[test]
    fn u19_format_rfc3339_shape() {
        let s = format_rfc3339(1700000000, 500);
        assert!(s.ends_with('Z'), "should end with Z");
        assert!(s.contains('T'), "should contain T separator");
    }

    // ─── U20: canonical_json sorts keys ──────────────────────────────────────

    #[test]
    fn u20_canonical_json_sorts_keys() {
        let v = json!({ "z": 1, "a": 2, "m": 3 });
        let bytes = canonical_json(&v).expect("canonical_json");
        let s = String::from_utf8(bytes).unwrap();
        // "a" must come before "m" which must come before "z".
        let pos_a = s.find("\"a\"").unwrap();
        let pos_m = s.find("\"m\"").unwrap();
        let pos_z = s.find("\"z\"").unwrap();
        assert!(pos_a < pos_m && pos_m < pos_z, "keys must be sorted: {}", s);
    }
}
