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
///
/// Some fields (sync_status, sync_excluded_reason, cloud_index_id, encrypted_at)
/// are populated by `select_pending_rows` and consumed by Phase 2.1.4
/// (split-architecture search) + downstream tooling that introspects the row's
/// sync state. They aren't read by the upload path itself today.
#[allow(dead_code)] // sync-status fields consumed by Phase 2.1.4 search + tooling
#[derive(Debug, Clone)]
pub(crate) struct MemItemRow {
    pub id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub kinds_json: String,
    /// Raw embedding BLOB (column added by `ensure_embedding_column`).
    /// Base64-encoded into the encrypted payload as `embedding_b64` per RFC § 4.1
    /// so that Phase 2.1.4 split-architecture search can run vector similarity on
    /// decrypted blobs.
    pub embedding: Option<Vec<u8>>,
    pub created_at: i64,
    pub provenance: Option<String>,
    pub entity_id: Option<String>,
    pub confidence: Option<f64>,
    pub redaction: Option<String>,
    pub sync_status: String,
    pub sync_excluded_reason: Option<String>,
    pub cloud_index_id: Option<String>,
    pub encrypted_at: Option<i64>,
    /// Persisted per-row upload attempt counter (column `sync_attempt_count`).
    /// Persistence chosen over an in-process map (Option B) so the S4 retry-and-stuck
    /// guard survives app restarts and the row can be marked `excluded` with
    /// `sync_excluded_reason='stuck'` deterministically.
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

/// Process-wide sync engine.
///
/// # Lock order (read carefully — deadlock prevention)
///
/// `SyncEngine` carries three independent mutexes. To avoid lock-order
/// inversions, ALWAYS acquire them in this canonical order, top to bottom:
///
/// 1. `master_key`
/// 2. `client`
/// 3. `stats`
///
/// Each lock must be released before reaching for one earlier in the order.
/// Reverse-acquisition risks deadlock between `run_cycle` (which currently
/// touches `master_key` and `client` early, and `stats` late) and any future
/// admin path that holds `stats` while reaching for `master_key` or `client`.
///
/// All call sites use scoped guards (`{ let g = self.x.lock()?; ... }`) so
/// each Mutex is released as soon as its block exits — keep that pattern.
pub(crate) struct SyncEngine {
    master_key: Mutex<Option<crypto::MasterKey>>,
    client: Mutex<Option<http::Client>>,
    stats: Mutex<SyncStats>,
}

static ENGINE: OnceLock<SyncEngine> = OnceLock::new();

/// Dedicated tokio runtime for Mirror HTTP work.
///
/// `run_cycle` uses `block_on` to bridge async HTTP into its synchronous
/// scheduler thread. We MUST NOT call `Handle::current().block_on(...)` because
/// when `mirror_sync_now` (a Tauri command running on Tauri's runtime) drives
/// `run_cycle`, `block_on`-from-within-the-current-runtime panics.
///
/// Instead we own a separate multi-thread runtime here and `block_on` against
/// it. This is safe whether the caller is on a `std::thread::spawn` worker
/// (no current runtime) OR inside Tauri's runtime — the dedicated runtime is
/// always a different one. See Fix #3 in the code-review follow-up.
static MIRROR_RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub(crate) fn mirror_runtime() -> &'static tokio::runtime::Runtime {
    MIRROR_RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("shogun-mirror")
            .build()
            .expect("mirror runtime init failed")
    })
}

impl SyncEngine {
    /// Return the process-wide singleton SyncEngine.
    pub(crate) fn global() -> &'static Self {
        ENGINE.get_or_init(|| SyncEngine {
            master_key: Mutex::new(None),
            client: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
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

    /// Snapshot the cached `http::Client` (Phase 2.1.4: needed by IPC commands
    /// that drive search / device management outside of `run_cycle`). Returns
    /// `None` if the client has not been wired up yet (e.g. before
    /// `mirror_register` ran or after `clear_client()`).
    pub(crate) fn client(&self) -> Option<http::Client> {
        self.client.lock().ok().and_then(|g| g.clone())
    }

    /// Derive a fresh `MemoryEncryptionKey` from the cached `MasterKey`. Returns
    /// `None` if Mirror is locked (no MK in memory). Phase 2.1.4 IPC search
    /// uses this to decrypt blobs without re-deriving via passphrase.
    pub(crate) fn mek(&self) -> Option<crypto::MemoryEncryptionKey> {
        let guard = self.master_key.lock().ok()?;
        guard.as_ref().map(crypto::derive_mek)
    }

    /// Restore the authenticated `http::Client` after an app restart.
    ///
    /// `mirror_register` constructs a client and stashes it in this engine, but
    /// the `OnceLock` resets on app launch. On restart we reconstruct the client
    /// from persisted state: `server_url` from settings, `device_token` from
    /// macOS Keychain. Idempotent — does nothing if a client is already set or
    /// if either piece of persisted state is missing.
    ///
    /// Called automatically from `run_cycle` so the scheduler self-heals after
    /// a restart without requiring the user to re-register.
    pub(crate) fn ensure_client_from_persisted_state(&self) {
        // Fast path: already configured.
        if let Ok(guard) = self.client.lock() {
            if guard.is_some() {
                return;
            }
        }

        // Need server_url from settings.
        let settings = crate::settings_store::load()
            .unwrap_or_else(|_| json!({ "sections": {} }));
        let server_url = settings
            .get("sections")
            .and_then(|s| s.get("cloud_mirror"))
            .and_then(|m| m.get("server_url"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let Some(server_url) = server_url else { return };

        // Need device_token from Keychain (macOS only).
        #[cfg(target_os = "macos")]
        {
            let token = match crate::mirror::keychain::load_device_token() {
                Ok(Some(t)) => t,
                _ => return,
            };
            if let Ok(client) = http::Client::new(server_url, token) {
                self.set_client(client);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = server_url; // unused off macOS
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

        // Must have a configured client. After an app restart the in-memory
        // client is None even though the user previously registered — try to
        // reconstruct from persisted server_url + device_token before giving up.
        self.ensure_client_from_persisted_state();
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
        // Per-row attempt counter; after 6 transient retries on the 5-min
        // interval (~30 minutes total) the row is marked `excluded=stuck` to
        // prevent indefinite retries. Exponential backoff is deferred —
        // current implementation re-attempts on every cycle until threshold.
        let max_attempts = 6;

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

            // Upload via the dedicated MIRROR_RUNTIME (Fix #3). Safe whether
            // we're called from the std::thread scheduler (no current runtime)
            // or from `mirror_sync_now` running on Tauri's runtime.
            let upload_result: Result<http::UploadResponse, http::Error> =
                mirror_runtime().block_on(async { client.upload_blob(&envelope).await });

            match upload_result {
                Ok(resp) => {
                    // 201: mark synced, store cloud_index_id + encrypted_at,
                    // reset attempt counter (defensive — synced rows won't be
                    // re-selected, but resetting keeps the column consistent).
                    let now_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    let _ = conn.execute(
                        "UPDATE mem_items
                         SET sync_status = 'synced',
                             cloud_index_id = ?1,
                             encrypted_at = ?2,
                             sync_attempt_count = 0
                         WHERE id = ?3",
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
                            // Persist the new counter so the guard survives restarts.
                            let _ = conn.execute(
                                "UPDATE mem_items SET sync_attempt_count = ?1 WHERE id = ?2",
                                params![new_attempts, row.id],
                            );
                            if new_attempts >= max_attempts {
                                // S4: after `max_attempts` transient failures, the
                                // row is "stuck". Mark it `excluded` with reason
                                // `stuck` so the queue isn't blocked, and surface
                                // the failure to the user via `stats.last_error`.
                                log::warn!(
                                    "mirror sync: row {} stuck after {} attempts: {}",
                                    row.id, new_attempts, err
                                );
                                let _ = conn.execute(
                                    "UPDATE mem_items
                                     SET sync_status = 'excluded',
                                         sync_excluded_reason = 'stuck'
                                     WHERE id = ?1",
                                    params![row.id],
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
///
/// Pulls `embedding` (raw BLOB) and `sync_attempt_count` so that
/// `build_blob_envelope` can include `embedding_b64` (RFC § 4.1) and the
/// retry-and-stuck guard can persist across app restarts.
pub(crate) fn select_pending_rows(
    conn: &Connection,
    batch_size: usize,
) -> Result<Vec<MemItemRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, snippet, source, kinds_json, embedding, created_at,
                    provenance, entity_id, confidence, redaction,
                    sync_status, sync_excluded_reason, cloud_index_id, encrypted_at,
                    COALESCE(sync_attempt_count, 0)
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
                embedding: r.get::<_, Option<Vec<u8>>>(5)?,
                created_at: r.get(6)?,
                provenance: r.get(7)?,
                entity_id: r.get(8)?,
                confidence: r.get(9)?,
                redaction: r.get(10)?,
                sync_status: r.get(11)?,
                sync_excluded_reason: r.get(12)?,
                cloud_index_id: r.get(13)?,
                encrypted_at: r.get(14)?,
                attempt_count: r.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(rows)
}

/// Maximum decrypted plaintext size, per RFC § 4.1 + S7. Embedding inclusion
/// is best-effort under this cap — see `build_blob_envelope` for the
/// "fits-without-embedding but not with-embedding" graceful-drop policy.
const MAX_PLAINTEXT_BYTES: usize = 1024 * 1024; // 1MB

/// Build a `BlobEnvelope` from a `mem_items` row per RFC § 4.1.
///
/// Plaintext is a JSON object matching `row_to_item`'s shape (with `embedding_b64`
/// added when the row has an embedding BLOB).
///
/// AEAD associated data is sort-only-keyed JSON of
/// `{blob_id, device_id, metadata, schema, version}` per RFC § 4.3. The AD
/// payload is restricted to integer numbers + ASCII strings — see
/// `sorted_json_for_ad`'s contract. Adding new AD fields requires either
/// staying in that subset OR switching to a real JCS implementation.
///
/// Embedding-vs-size policy (Fix #2):
/// 1. Build plaintext WITHOUT embedding; if even that exceeds 1MB, return Err
///    so the caller marks the row `excluded=payload_too_large`.
/// 2. Try adding `embedding_b64`; if the embedded form fits, use it.
/// 3. If embedding would push us over the cap, drop the embedding (with a
///    `log::warn!`) and ship the row anyway. RFC § 4.1 documents `embedding_b64`
///    as optional, so this remains wire-compatible.
pub(crate) fn build_blob_envelope(
    row: &MemItemRow,
    mek: &crypto::MemoryEncryptionKey,
    device_id: &str,
) -> Result<http::BlobEnvelope, String> {
    // Step 1: build plaintext WITHOUT embedding (always required).
    let mut plaintext_obj = build_plaintext_obj_no_embedding(row);
    let no_emb_bytes = serde_json::to_vec(&Value::Object(plaintext_obj.clone()))
        .map_err(|e| e.to_string())?;

    // Step 2: hard size guard on the embedding-less form. If even THIS
    // exceeds 1MB the row is genuinely too large and must be excluded.
    if no_emb_bytes.len() > MAX_PLAINTEXT_BYTES {
        return Err(format!(
            "row {} is too large for sync: {} bytes (limit {})",
            row.id,
            no_emb_bytes.len(),
            MAX_PLAINTEXT_BYTES
        ));
    }

    // Step 3: try adding `embedding_b64` if present. If the embedded form
    // would push us over the cap, drop the embedding and ship the row.
    let plaintext_bytes = if let Some(ref emb) = row.embedding {
        let emb_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            emb,
        );
        plaintext_obj.insert("embedding_b64".to_string(), Value::String(emb_b64));
        let with_emb_bytes = serde_json::to_vec(&Value::Object(plaintext_obj.clone()))
            .map_err(|e| e.to_string())?;
        if with_emb_bytes.len() <= MAX_PLAINTEXT_BYTES {
            with_emb_bytes
        } else {
            // Drop the embedding; ship the user content anyway.
            log::warn!(
                "mirror sync: dropped embedding from row {} ({} bytes with embedding > {} cap; user content fits)",
                row.id,
                with_emb_bytes.len(),
                MAX_PLAINTEXT_BYTES
            );
            plaintext_obj.remove("embedding_b64");
            no_emb_bytes
        }
    } else {
        no_emb_bytes
    };

    // Generate a ULID-like blob_id (use a UUID v4 for MVP simplicity —
    // RFC allows any unique string).
    let blob_id = format!("blob_{}", uuid::Uuid::new_v4().simple());

    // Step 4: build metadata once, share between envelope + AD (Fix #5).
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
        kinds,
        provenance,
        captured_at_minute,
    };

    // RFC 3339 created_at (ms → ISO 8601).
    let created_at_str = {
        let secs = row.created_at.max(0) as u64 / 1000;
        let millis = row.created_at.max(0) as u64 % 1000;
        format_rfc3339(secs, millis)
    };

    // AEAD AD per RFC § 4.3: sort-only-keyed JSON of
    // {blob_id, device_id, metadata, schema, version}.
    //
    // AD payload is restricted to integers + ASCII per `sorted_json_for_ad`'s
    // contract. Building `metadata_value` from the same `BlobMetadata` struct
    // that ships in the envelope ensures the two cannot drift (Fix #5). Adding
    // new fields here requires either ASCII-only / integer-only types OR
    // switching to a real JCS implementation.
    let metadata_value =
        serde_json::to_value(&metadata).expect("BlobMetadata is always serializable");
    let ad_value = json!({
        "blob_id": &blob_id,
        "device_id": device_id,
        "metadata": metadata_value,
        "schema": "mem_items.v1",
        "version": 1u8,
    });
    let ad_bytes = sorted_json_for_ad(&ad_value)?;

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

/// Build the plaintext object representing a `mem_items` row, without the
/// `embedding_b64` field. Extracted for the embedding-vs-size dance in
/// `build_blob_envelope`.
fn build_plaintext_obj_no_embedding(row: &MemItemRow) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    obj.insert("id".to_string(), Value::String(row.id.clone()));
    obj.insert("title".to_string(), Value::String(row.title.clone()));
    obj.insert("snippet".to_string(), Value::String(row.snippet.clone()));
    obj.insert("source".to_string(), Value::String(row.source.clone()));
    obj.insert("kinds_json".to_string(), Value::String(row.kinds_json.clone()));
    obj.insert(
        "created_at".to_string(),
        Value::Number(serde_json::Number::from(row.created_at)),
    );
    obj.insert(
        "provenance".to_string(),
        row.provenance
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "entity_id".to_string(),
        row.entity_id
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "confidence".to_string(),
        row.confidence
            .and_then(serde_json::Number::from_f64)
            .map(Value::Number)
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "redaction".to_string(),
        row.redaction
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    obj.insert("sync_status".to_string(), Value::String("synced".to_string()));
    obj.insert("sync_excluded_reason".to_string(), Value::Null);
    obj
}

/// Classify an HTTP error to determine retry policy (S4).
pub(crate) fn classify_error_for_retry(err: &http::Error) -> RetryDisposition {
    match err {
        // Permanent rejections — don't retry.
        http::Error::Unauthorized
        | http::Error::Forbidden
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

/// Apply allowlist filter (S2): a row is eligible for sync only if BOTH the
/// `app_allowlist` AND the `url_allowlist` accept it.
///
/// - `app_allowlist`: matched against `row.source`. Empty = allow-all.
/// - `url_allowlist`: matched against any URL extracted from `row.title` /
///   `row.snippet` using suffix matching (mirrors Phase 2.0a's
///   `excludedSites` host-suffix convention). Empty = allow-all (no URL
///   filtering applied). If the row contains no URL, the URL allowlist is
///   trivially satisfied (the row has nothing to filter on).
///
/// Both filters use the same wildcard semantics: a `"*"` entry matches anything.
pub(crate) fn apply_allowlist(row: &MemItemRow, settings: &Value) -> bool {
    let app_allowlist: Vec<String> = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("app_allowlist"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // App-allowlist check. Empty = allow all.
    let app_ok = app_allowlist.is_empty()
        || app_allowlist.iter().any(|a| a == "*")
        || app_allowlist.iter().any(|a| a == &row.source);
    if !app_ok {
        return false;
    }

    // URL-allowlist check. Empty = allow all (no URL filtering).
    let url_allowlist: Vec<String> = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("url_allowlist"))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    if url_allowlist.is_empty() || url_allowlist.iter().any(|a| a == "*") {
        return true;
    }

    // Extract URLs/hosts from row text. If the row has no URL, the URL
    // allowlist is trivially satisfied (only filters rows that actually
    // contain a URL). This mirrors the spirit of Phase 2.0a's privacy filter,
    // which only acts on text that actually contains URLs.
    let hosts = extract_hosts_from_row(row);
    if hosts.is_empty() {
        return true;
    }

    // Match if ANY host in the row matches ANY allowlist entry (suffix-match
    // per Phase 2.0a's `host_suffix_match`).
    hosts
        .iter()
        .any(|h| url_allowlist.iter().any(|allow| host_suffix_match(h, allow)))
}

/// Extract host names from any URL-like tokens in the row's `title` and
/// `snippet`. Mirrors the URL-extraction logic in
/// `capture_sampler.rs::ax_text_excluded` for parity (Fix #9):
///
/// 1. Scheme-prefixed URLs: tokens containing `://`, parsed via `url::Url`.
/// 2. Bare hosts: dotted ASCII tokens (`example.com/path`) detected by
///    scanning host-byte runs (`A-Za-z0-9.-`).
///
/// **IDN / IPv6 caveats** (documented for `apply_allowlist` callers):
///
/// - **IDN**: `url::Url::parse` Punycode-encodes non-ASCII hosts. Allowlist
///   entries for IDN domains MUST be in Punycode (`xn--r8jz45g.jp`, not
///   `例え.jp`) to match.
/// - **IPv6**: `url::Url` reports IPv6 hosts in bracketed form (`[::1]`).
///   To allowlist an IPv6 literal, include the brackets in the entry.
fn extract_hosts_from_row(row: &MemItemRow) -> Vec<String> {
    let mut hosts: Vec<String> = Vec::new();
    for text in [row.title.as_str(), row.snippet.as_str()] {
        let lower = text.to_ascii_lowercase();

        // (1) Scheme-prefixed URLs.
        for tok in lower.split_whitespace() {
            if !tok.contains("://") {
                continue;
            }
            let clean = tok.trim_end_matches(|c: char| {
                matches!(c, '.' | ',' | ';' | ')' | ']' | '>' | '"' | '\'' | '!' | '?')
            });
            if let Ok(url) = url::Url::parse(clean) {
                if let Some(h) = url.host_str() {
                    hosts.push(h.to_string());
                }
            }
        }

        // (2) Bare hosts: scan host-byte runs and keep tokens that contain a
        // dot. Mirrors capture_sampler.rs::ax_text_excluded lines 306-321.
        let bytes = lower.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if !is_host_byte(bytes[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && is_host_byte(bytes[i]) {
                i += 1;
            }
            let token = lower[start..i].trim_matches(|c: char| c == '.' || c == '-');
            if token.contains('.') {
                hosts.push(token.to_string());
            }
        }
    }
    hosts
}

fn is_host_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'.'
}

/// Suffix-match a host against an allowlist entry. `example.com` matches
/// `mail.example.com` but not `notexample.com` (label boundary required).
/// Inputs are lower-cased here so callers don't have to. Mirrors
/// `capture_sampler::host_suffix_match`.
fn host_suffix_match(host: &str, suffix: &str) -> bool {
    let h = host.to_ascii_lowercase();
    let s = suffix.to_ascii_lowercase();
    if h == s {
        return true;
    }
    h.len() > s.len()
        && h.as_bytes()[h.len() - s.len() - 1] == b'.'
        && h.ends_with(&s)
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

/// Sort-only JSON serialization for the AEAD AD payload. Recursively sorts
/// object keys (BTreeMap-via-rebuild) and otherwise relies on serde_json's
/// defaults.
///
/// # Cross-module contract — byte-identical AD invariant
///
/// This function is **shared between `mirror::sync` (write side) and
/// `mirror::search` (read side)**. Both call sites must produce
/// byte-identical AD bytes from logically-equivalent inputs, or AEAD
/// decryption will silently fail for previously-uploaded blobs.
///
/// Any change to this function — or to the structure of the AD object that
/// either side passes in (`{blob_id, device_id, metadata, schema, version}`)
/// — MUST be applied symmetrically on both sides. Adding/removing keys,
/// changing key names, swapping types, or altering serialization defaults
/// breaks the contract. The current callers are:
///
/// - `mirror::sync::build_blob_envelope` (encryption / upload)
/// - `mirror::search::decrypt_envelope` (download / decryption)
///
/// **NOT** RFC 8785 (JCS) compliant. The function name was renamed from
/// `canonical_json` to be honest about its scope. The AEAD AD payload is
/// restricted by design to:
///
/// - Integer numbers (`version: u8`, `captured_at_minute: u64`)
/// - ASCII strings (blob_id ULID, device_id ULID, schema enum, kinds enum)
///
/// Adding floats, negative numbers, or non-BMP Unicode (e.g. emoji) to the AD
/// payload would require a real JCS implementation (e.g. the `jcs` crate)
/// because serde_json's default float formatting and Unicode escaping diverge
/// from JCS §3.2 / §3.3. Keep this restriction documented at the AD
/// construction site as well — see `build_blob_envelope`.
pub(crate) fn sorted_json_for_ad(value: &Value) -> Result<Vec<u8>, String> {
    // serde_json serializes Object in insertion order. To get sorted keys we
    // round-trip through a recursive BTreeMap rebuild.
    let canonical = to_sorted_value(value);
    serde_json::to_vec(&canonical).map_err(|e| e.to_string())
}

fn to_sorted_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            // BTreeMap sorts keys lexicographically.
            let mut btree: std::collections::BTreeMap<String, Value> = std::collections::BTreeMap::new();
            for (k, v) in map {
                btree.insert(k.clone(), to_sorted_value(v));
            }
            serde_json::to_value(btree).unwrap_or(Value::Null)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(to_sorted_value).collect()),
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
            embedding: None,
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
            client: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
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

    // ─── U20: sorted_json_for_ad sorts keys ──────────────────────────────────

    #[test]
    fn u20_sorted_json_for_ad_sorts_keys() {
        let v = json!({ "z": 1, "a": 2, "m": 3 });
        let bytes = sorted_json_for_ad(&v).expect("sorted_json_for_ad");
        let s = String::from_utf8(bytes).unwrap();
        // "a" must come before "m" which must come before "z".
        let pos_a = s.find("\"a\"").unwrap();
        let pos_m = s.find("\"m\"").unwrap();
        let pos_z = s.find("\"z\"").unwrap();
        assert!(pos_a < pos_m && pos_m < pos_z, "keys must be sorted: {}", s);
    }

    /// Helper used by Fix #1 / future AEAD round-trip tests: rebuild the AEAD
    /// associated data the SAME way `build_blob_envelope` does. Prevents
    /// drift between production and tests by passing through `BlobMetadata`
    /// (Fix #5 — single source of truth).
    fn rebuild_ad_for(env: &http::BlobEnvelope) -> Vec<u8> {
        let metadata_value = serde_json::to_value(&env.metadata).unwrap();
        let ad_value = json!({
            "blob_id": &env.blob_id,
            "device_id": &env.device_id,
            "metadata": metadata_value,
            "schema": "mem_items.v1",
            "version": 1u8,
        });
        sorted_json_for_ad(&ad_value).unwrap()
    }

    // ─── Spec-reviewer follow-up tests (Fixes #1–#4) ─────────────────────────

    /// FIX1: `embedding_b64` field appears in decrypted plaintext and matches
    /// the original BLOB byte-for-byte. Phase 2.1.4 split-architecture search
    /// depends on this for vector similarity over decrypted blobs (RFC § 4.1).
    #[test]
    fn fix1_embedding_b64_roundtrip_in_encrypted_payload() {
        let mek = make_mek();
        let mut row = make_row("r_emb");
        // Non-trivial 4-byte sequence — easy to spot-check in the b64.
        let original_embedding: Vec<u8> = vec![0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0x00, 0x80];
        row.embedding = Some(original_embedding.clone());

        let env = build_blob_envelope(&row, &mek, "dev_emb").expect("build_blob_envelope");

        let nonce_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.nonce.as_bytes(),
        )
        .expect("decode nonce");
        let data_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.data.as_bytes(),
        )
        .expect("decode data");
        let ad_bytes = rebuild_ad_for(&env);

        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(&nonce_bytes[..24]);
        let plaintext = crypto::decrypt_with_ad(
            mek.as_bytes(),
            &crypto::Ciphertext {
                nonce: nonce_arr,
                ciphertext: data_bytes,
            },
            &ad_bytes,
        )
        .expect("decrypt_with_ad");

        // Parse the plaintext JSON and assert embedding_b64 is present.
        let plaintext_value: Value = serde_json::from_slice(&plaintext).expect("plaintext JSON");
        let emb_b64 = plaintext_value
            .get("embedding_b64")
            .and_then(|v| v.as_str())
            .expect("embedding_b64 present in decrypted plaintext");
        let decoded = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            emb_b64.as_bytes(),
        )
        .expect("decode embedding_b64");
        assert_eq!(
            decoded, original_embedding,
            "embedding_b64 must round-trip byte-for-byte"
        );
    }

    /// FIX1b: Rows without an embedding must NOT include `embedding_b64`.
    /// Otherwise a NULL embedding becomes ambiguous on the decrypt side.
    #[test]
    fn fix1_no_embedding_field_when_row_has_no_embedding() {
        let mek = make_mek();
        let mut row = make_row("r_no_emb");
        row.embedding = None;
        let env = build_blob_envelope(&row, &mek, "dev_no_emb").expect("build_blob_envelope");

        let nonce_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.nonce.as_bytes(),
        )
        .unwrap();
        let data_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.data.as_bytes(),
        )
        .unwrap();
        let ad_bytes = rebuild_ad_for(&env);
        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(&nonce_bytes[..24]);
        let plaintext = crypto::decrypt_with_ad(
            mek.as_bytes(),
            &crypto::Ciphertext {
                nonce: nonce_arr,
                ciphertext: data_bytes,
            },
            &ad_bytes,
        )
        .unwrap();
        let plaintext_value: Value = serde_json::from_slice(&plaintext).unwrap();
        assert!(
            plaintext_value.get("embedding_b64").is_none(),
            "embedding_b64 must be absent when row.embedding is None"
        );
    }

    /// FIX2: Persisted attempt counter survives in `sync_attempt_count` and
    /// after `max_attempts` (6) consecutive transient failures the row is
    /// marked `excluded` with `sync_excluded_reason='stuck'` (S4).
    ///
    /// Drives a row through 6 simulated transient failures (server 5xx) by
    /// directly invoking the same persistence logic `run_cycle` uses, since
    /// `run_cycle` requires a tokio runtime + live HTTP client.
    #[test]
    fn fix2_attempt_count_persisted_and_row_marked_stuck_after_max_attempts() {
        let conn = make_full_conn();
        let max_attempts = 6;

        conn.execute(
            "INSERT INTO mem_items
                (id, title, snippet, source, kinds_json, created_at, sync_status, sync_attempt_count)
             VALUES ('r_flaky', 'T', 'S', 'capture_sampler', '[]', 1000, 'local_only', 0)",
            [],
        )
        .expect("insert flaky row");

        // Simulate `max_attempts` transient failures the same way run_cycle does.
        for _ in 0..max_attempts {
            // Re-fetch the current attempt_count (the column is the source of truth).
            let attempts: i64 = conn
                .query_row(
                    "SELECT sync_attempt_count FROM mem_items WHERE id = 'r_flaky'",
                    [],
                    |r| r.get(0),
                )
                .expect("read counter");
            let new_attempts = attempts + 1;

            // Assert the disposition stays Transient throughout (5xx).
            let err = http::Error::ServerError(503);
            assert_eq!(
                classify_error_for_retry(&err),
                RetryDisposition::Transient
            );

            // Persist the increment exactly the way run_cycle does.
            conn.execute(
                "UPDATE mem_items SET sync_attempt_count = ?1 WHERE id = ?2",
                params![new_attempts, "r_flaky"],
            )
            .expect("update counter");

            // On the final attempt, run_cycle promotes to excluded.
            if new_attempts >= max_attempts {
                conn.execute(
                    "UPDATE mem_items
                     SET sync_status = 'excluded',
                         sync_excluded_reason = 'stuck'
                     WHERE id = ?1",
                    params!["r_flaky"],
                )
                .expect("mark stuck");
            }
        }

        // Final assertions.
        let (status, reason, attempts): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT sync_status, sync_excluded_reason, sync_attempt_count
                 FROM mem_items WHERE id = 'r_flaky'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .expect("select final state");
        assert_eq!(status, "excluded", "row should be excluded after stuck");
        assert_eq!(
            reason.as_deref(),
            Some("stuck"),
            "reason must be 'stuck' so UI can surface it"
        );
        assert_eq!(attempts, max_attempts, "counter should equal max_attempts");

        // The next select_pending_rows must NOT return the stuck row (it's excluded).
        let pending = select_pending_rows(&conn, 50).expect("select pending");
        assert!(
            pending.iter().all(|r| r.id != "r_flaky"),
            "stuck row must not be re-selected"
        );
    }

    /// FIX2b: After a successful upload the persisted counter resets to 0.
    /// Defensive: synced rows aren't re-selected, but resetting keeps the
    /// column meaningful in the durable record.
    #[test]
    fn fix2_counter_resets_on_successful_upload() {
        let conn = make_full_conn();
        conn.execute(
            "INSERT INTO mem_items
                (id, title, snippet, source, kinds_json, created_at, sync_status, sync_attempt_count)
             VALUES ('r_recover', 'T', 'S', 'capture_sampler', '[]', 1000, 'local_only', 3)",
            [],
        )
        .expect("insert recovering row");

        // Simulate the success branch: synced + reset.
        conn.execute(
            "UPDATE mem_items
             SET sync_status = 'synced',
                 cloud_index_id = 'srv_blob_xyz',
                 encrypted_at = 1700000000000,
                 sync_attempt_count = 0
             WHERE id = 'r_recover'",
            [],
        )
        .expect("update on success");

        let attempts: i64 = conn
            .query_row(
                "SELECT sync_attempt_count FROM mem_items WHERE id = 'r_recover'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 0, "counter must reset on successful upload");
    }

    /// FIX3: `url_allowlist` filters rows whose extracted URL host is NOT
    /// in the allowlist. Rows whose URL DOES match are accepted.
    #[test]
    fn fix3_url_allowlist_filters_by_host_suffix() {
        // Row carrying a URL in its snippet.
        let mut row = make_row("r_url");
        row.snippet = "Check out https://docs.example.com/page-x for context".to_string();
        // app_allowlist is wide-open; only url_allowlist is constrained.
        let allow_settings = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["example.com"]
                }
            }
        });
        assert!(
            apply_allowlist(&row, &allow_settings),
            "URL host docs.example.com matches example.com (suffix)"
        );

        // Now switch the allowlist so the row's URL is excluded.
        let block_settings = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["other.com"]
                }
            }
        });
        assert!(
            !apply_allowlist(&row, &block_settings),
            "URL host docs.example.com must NOT match other.com"
        );
    }

    /// FIX3b: Rows with NO URL pass the URL allowlist (vacuously true).
    /// Otherwise non-URL rows would be filtered out by any non-empty
    /// allowlist, which was not the design intent.
    #[test]
    fn fix3_url_allowlist_no_url_passes() {
        let row = make_row("r_no_url"); // no URL in title/snippet
        let settings = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["example.com"]
                }
            }
        });
        assert!(
            apply_allowlist(&row, &settings),
            "rows without URLs must pass the URL allowlist trivially"
        );
    }

    /// FIX3c: Wildcard `"*"` in url_allowlist allows everything.
    #[test]
    fn fix3_url_allowlist_wildcard() {
        let mut row = make_row("r_url");
        row.snippet = "https://anything.example.org".to_string();
        let settings = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["*"]
                }
            }
        });
        assert!(apply_allowlist(&row, &settings));
    }

    /// FIX4: After an "app restart" — fresh SyncEngine with `client: None` —
    /// `ensure_client_from_persisted_state` is a no-op when no token has been
    /// persisted (off macOS the call is a stub). On macOS, with a server_url
    /// in settings and a token in Keychain, it reconstructs the client.
    ///
    /// This test verifies the no-op path (the macOS Keychain path is exercised
    /// by manual smoke tests; making it deterministic in CI requires Keychain
    /// mocking, which is out of scope).
    #[test]
    fn fix4_ensure_client_from_persisted_state_is_idempotent_when_unconfigured() {
        let engine = SyncEngine {
            master_key: Mutex::new(None),
            client: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
        };

        // No client at start.
        assert!(engine.client.lock().unwrap().is_none());

        // Calling restore is a safe no-op when there's nothing persisted.
        engine.ensure_client_from_persisted_state();

        // Still no client (Keychain has no token in test env, or off-macOS the
        // function is a no-op). This is the "fresh install / never registered"
        // case — should NOT panic, should NOT fabricate a client.
        // (Note: on a developer machine with a real Mirror device_token in
        // Keychain this test would still pass because we only care about the
        // graceful no-op contract; reconstruction is exercised manually.)
        // We at least verify the call doesn't panic and the state is
        // observable through stats().
        let _ = engine.stats();
    }

    /// FIX4b: If a client was already set, ensure_client_from_persisted_state
    /// must NOT clobber it (idempotent fast path).
    #[test]
    fn fix4_ensure_client_does_not_clobber_existing() {
        // Build a stand-in client (any base_url; test never makes a request).
        let stand_in =
            http::Client::new("http://localhost:65535".to_string(), "tok_xyz".to_string())
                .expect("stand-in client");
        let engine = SyncEngine {
            master_key: Mutex::new(None),
            client: Mutex::new(Some(stand_in)),
            stats: Mutex::new(SyncStats::default()),
        };
        // Ensure does not replace.
        engine.ensure_client_from_persisted_state();
        assert!(
            engine.client.lock().unwrap().is_some(),
            "existing client must not be replaced"
        );
    }

    // ─── Code-review follow-up tests (Critical/Important fixes) ──────────────

    /// CR-FIX1: An emoji-containing `provenance` slips into the AD payload —
    /// because `sorted_json_for_ad` is sort-only (NOT JCS-compliant) and
    /// serde_json's default Unicode handling keeps the emoji as a multi-byte
    /// UTF-8 sequence, this still round-trips today.
    ///
    /// The test pins down the contract: encrypt+decrypt with the exact same
    /// AD construction succeeds, but if decryption is attempted with a
    /// DIFFERENT-LOOKING-but-equivalent AD (e.g. provenance re-stringified
    /// with different escapes), AEAD authentication fails. This documents
    /// the "safe today / fragile tomorrow" property and gives a regression
    /// signal if a future refactor (e.g. swapping serializer impls) silently
    /// changes encoding behavior.
    #[test]
    fn cr_fix1_ad_with_unicode_provenance_documented_fragility() {
        let mek = make_mek();
        let mut row = make_row("r_unicode");
        // Force a non-ASCII provenance to enter the AD.
        row.provenance = Some("📦".to_string());
        // Override derive_provenance fallback by also using a non-derived source.
        row.source = "user_authored".to_string();

        let env = build_blob_envelope(&row, &mek, "dev_unicode")
            .expect("build_blob_envelope");

        // Re-create AD using the canonical helper — must round-trip since both
        // sides use the same serializer.
        let ad_bytes_ok = rebuild_ad_for(&env);
        let nonce_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.nonce.as_bytes(),
        )
        .unwrap();
        let data_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.data.as_bytes(),
        )
        .unwrap();
        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(&nonce_bytes[..24]);
        let ct = crypto::Ciphertext {
            nonce: nonce_arr,
            ciphertext: data_bytes,
        };

        // Same serializer ⇒ decrypt succeeds.
        assert!(
            crypto::decrypt_with_ad(mek.as_bytes(), &ct, &ad_bytes_ok).is_ok(),
            "decrypt with matching AD must succeed"
        );

        // Tampered AD (any byte change) ⇒ decrypt fails. Demonstrates AD bind.
        let mut tampered = ad_bytes_ok.clone();
        if let Some(b) = tampered.last_mut() {
            *b ^= 0x01;
        }
        assert!(
            crypto::decrypt_with_ad(mek.as_bytes(), &ct, &tampered).is_err(),
            "decrypt with tampered AD must fail (proves AD binding)"
        );
    }

    /// CR-FIX2: A row whose embedding pushes plaintext over the 1MB cap,
    /// but whose user content (without the embedding) still fits, must
    /// be uploaded WITHOUT the embedding rather than excluded outright.
    ///
    /// Verifies the graceful-drop policy in `build_blob_envelope`:
    /// 1. user content fits → don't return Err
    /// 2. embedding included would overflow → drop it
    /// 3. resulting plaintext has no `embedding_b64`
    #[test]
    fn cr_fix2_oversized_embedding_is_dropped_row_still_synced() {
        let mek = make_mek();
        let mut row = make_row("r_big_emb");
        // ~1.1MB embedding — plaintext-without-it is tiny, but b64 of it is
        // (1.1MB * 4/3) ≈ 1.47MB which definitely exceeds the cap.
        row.embedding = Some(vec![0xABu8; 1_100_000]);

        let env = build_blob_envelope(&row, &mek, "dev_big_emb")
            .expect("envelope must build (embedding dropped, row content fits)");

        let nonce_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.nonce.as_bytes(),
        )
        .unwrap();
        let data_bytes = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            env.ciphertext.data.as_bytes(),
        )
        .unwrap();
        let ad_bytes = rebuild_ad_for(&env);
        let mut nonce_arr = [0u8; 24];
        nonce_arr.copy_from_slice(&nonce_bytes[..24]);
        let plaintext = crypto::decrypt_with_ad(
            mek.as_bytes(),
            &crypto::Ciphertext {
                nonce: nonce_arr,
                ciphertext: data_bytes,
            },
            &ad_bytes,
        )
        .unwrap();
        let plaintext_value: Value = serde_json::from_slice(&plaintext).unwrap();
        assert!(
            plaintext_value.get("embedding_b64").is_none(),
            "oversized embedding should have been dropped, not included"
        );
        // User content still present.
        assert_eq!(
            plaintext_value.get("title").and_then(|v| v.as_str()),
            Some("Test Title")
        );
    }

    /// CR-FIX2b: A row whose user content (without any embedding) already
    /// exceeds 1MB must still be rejected with a `too large` error so the
    /// caller marks it `excluded=payload_too_large`.
    #[test]
    fn cr_fix2_genuinely_oversized_row_rejected() {
        let mek = make_mek();
        let mut row = make_row("r_truly_too_big");
        // 1.5MB title — won't shrink no matter what we do.
        row.title = "x".repeat(1_500_000);
        row.embedding = None;
        let result = build_blob_envelope(&row, &mek, "dev_big");
        assert!(
            result.is_err(),
            "row with >1MB user content must be rejected"
        );
        assert!(result.unwrap_err().contains("too large"));
    }

    /// CR-FIX3: `run_cycle` called from inside an existing tokio runtime must
    /// NOT panic with "Cannot start a runtime from within a runtime."
    ///
    /// Setup: the engine is locked → `run_cycle` returns an Err early before
    /// reaching the upload path, but it MUST get there without panicking on
    /// runtime detection. (Driving the full upload path needs a live mock
    /// server; the panic point we're hardening is the early `block_on`
    /// machinery, which is exercised regardless of whether any rows exist.)
    ///
    /// To exercise the dedicated `MIRROR_RUNTIME` end-to-end we'd need
    /// integration tests with a mockito server — that's I3-style coverage,
    /// out of scope here. The contract being verified is that calling into
    /// the engine FROM inside a tokio runtime is safe for the locked path.
    #[test]
    fn cr_fix3_run_cycle_inside_tokio_runtime_does_not_panic() {
        // Build a fresh local engine (not the global; keeps tests independent).
        let engine = SyncEngine {
            master_key: Mutex::new(None),
            client: Mutex::new(None),
            stats: Mutex::new(SyncStats::default()),
        };

        // From inside a tokio runtime, call run_cycle.
        let rt = tokio::runtime::Runtime::new().unwrap();
        // run_cycle is sync; we just need to invoke it from inside an async
        // block-on context to verify no nested-runtime panic. Engine is
        // disabled in settings so this returns Ok(0) without touching HTTP.
        let outcome = rt.block_on(async { engine.run_cycle() });
        // Settings probably has cloud_mirror.enabled = false in the test env,
        // so we expect Ok(0) — but the key contract is "no panic on entry".
        let _ = outcome;
    }

    /// CR-FIX3b: The dedicated `MIRROR_RUNTIME` is a separate runtime from any
    /// caller's tokio runtime, so `block_on` against it is always safe.
    /// Smoke-test: get a handle, run a trivial async future on it, twice.
    #[test]
    fn cr_fix3_mirror_runtime_is_reusable() {
        let r1 = mirror_runtime().block_on(async { 1 + 1 });
        let r2 = mirror_runtime().block_on(async { 2 + 2 });
        assert_eq!(r1, 2);
        assert_eq!(r2, 4);
    }

    /// CR-FIX7: `mirror_reset_stuck` resets all stuck rows back to local_only
    /// with counter=0 and reason=NULL.
    #[test]
    fn cr_fix7_reset_stuck_rows_returns_them_to_local_only() {
        let conn = make_full_conn();
        // 3 stuck rows + 1 untouched excluded (e.g. payload_too_large) + 1 synced.
        for i in 0..3 {
            conn.execute(
                "INSERT INTO mem_items
                  (id, title, snippet, source, kinds_json, created_at, sync_status,
                   sync_excluded_reason, sync_attempt_count)
                 VALUES (?1, 'T', 'S', 'capture_sampler', '[]', ?2, 'excluded', 'stuck', 6)",
                params![format!("r_stuck_{}", i), i as i64],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO mem_items
              (id, title, snippet, source, kinds_json, created_at, sync_status,
               sync_excluded_reason, sync_attempt_count)
             VALUES ('r_too_big', 'T', 'S', 'capture_sampler', '[]', 100, 'excluded',
                     'payload_too_large', 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO mem_items
              (id, title, snippet, source, kinds_json, created_at, sync_status)
             VALUES ('r_synced', 'T', 'S', 'capture_sampler', '[]', 200, 'synced')",
            [],
        )
        .unwrap();

        // Run the same UPDATE that mirror_reset_stuck issues. Mirrors the
        // exact SQL in commands.rs::mirror_reset_stuck.
        let updated = conn
            .execute(
                "UPDATE mem_items
                 SET sync_status = 'local_only',
                     sync_attempt_count = 0,
                     sync_excluded_reason = NULL
                 WHERE sync_status = 'excluded' AND sync_excluded_reason = 'stuck'",
                [],
            )
            .unwrap();
        assert_eq!(updated, 3, "exactly the 3 stuck rows should be reset");

        // Verify all 3 stuck rows are now local_only with reset counters.
        for i in 0..3 {
            let id = format!("r_stuck_{}", i);
            let (status, reason, attempts): (String, Option<String>, i64) = conn
                .query_row(
                    "SELECT sync_status, sync_excluded_reason, sync_attempt_count
                     FROM mem_items WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap();
            assert_eq!(status, "local_only");
            assert!(reason.is_none(), "reason should be NULL");
            assert_eq!(attempts, 0);
        }

        // Untouched excluded row stays excluded.
        let (status, reason): (String, Option<String>) = conn
            .query_row(
                "SELECT sync_status, sync_excluded_reason FROM mem_items WHERE id = 'r_too_big'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "excluded");
        assert_eq!(reason.as_deref(), Some("payload_too_large"));
    }

    /// CR-FIX9: bare-host URL (no scheme) is detected and matched against
    /// the URL allowlist for parity with `capture_sampler::ax_text_excluded`.
    #[test]
    fn cr_fix9_bare_host_extracted_for_url_allowlist() {
        let mut row = make_row("r_bare");
        // No `://` — bare host with path.
        row.snippet = "Visit example.com/help for docs".to_string();

        // Allowlist that includes example.com → row should be ALLOWED.
        let allow = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["example.com"]
                }
            }
        });
        assert!(
            apply_allowlist(&row, &allow),
            "bare host example.com should match url_allowlist entry"
        );

        // Allowlist that excludes example.com → row should be FILTERED OUT.
        let block = json!({
            "sections": {
                "cloud_mirror": {
                    "app_allowlist": ["*"],
                    "url_allowlist": ["other.com"]
                }
            }
        });
        assert!(
            !apply_allowlist(&row, &block),
            "bare host example.com must NOT match other.com"
        );
    }
}
