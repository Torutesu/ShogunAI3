use crate::{memory_store, mirror, settings_store};
use serde_json::{json, Value};

#[tauri::command]
pub async fn mirror_register(payload: Value) -> Result<Value, String> {
    let server_url = payload
        .get("server_url")
        .and_then(|v| v.as_str())
        .ok_or("server_url required")?
        .to_string();
    let registration_code = payload
        .get("registration_code")
        .and_then(|v| v.as_str())
        .ok_or("registration_code required")?;
    let device_name = payload
        .get("device_name")
        .and_then(|v| v.as_str())
        .unwrap_or("My Mac");

    let client =
        mirror::http::Client::new_unauthenticated(server_url.clone()).map_err(|e| e.to_string())?;
    let registration = client
        .register_device(registration_code, device_name)
        .await
        .map_err(|e| e.to_string())?;

    // Persist device_id + server_url to settings.
    settings_store::save_patch(&json!({
      "section": "cloud_mirror",
      "enabled": true,
      "server_url": server_url,
      "device_id": registration.device_id,
    }))?;

    // Persist device_token to Keychain.
    #[cfg(target_os = "macos")]
    mirror::keychain::save_device_token(&registration.device_token)?;

    // Wire up the authenticated client in the SyncEngine.
    let auth_client = mirror::http::Client::new(server_url, registration.device_token)
        .map_err(|e| e.to_string())?;
    mirror::sync::SyncEngine::global().set_client(auth_client);

    Ok(json!({ "device_id": registration.device_id, "stub": false }))
}

#[tauri::command]
pub fn mirror_unlock(payload: Value) -> Result<Value, String> {
    let passphrase = payload
        .get("passphrase")
        .and_then(|v| v.as_str())
        .ok_or("passphrase required")?;
    mirror::sync::SyncEngine::global().unlock(passphrase)?;
    Ok(json!({ "stub": false }))
}

#[tauri::command]
pub fn mirror_status(_payload: Value) -> Result<Value, String> {
    let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
    let enabled = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let device_id = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("device_id"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let stats = mirror::sync::SyncEngine::global().stats();

    Ok(json!({
      "enabled": enabled,
      "queue_depth": stats.queue_depth,
      "last_sync_at": stats.last_sync_at,
      "last_error": stats.last_error,
      "locked": stats.locked,
      "device_id": device_id,
      "stub": false,
    }))
}

#[tauri::command]
pub async fn mirror_sync_now(_payload: Value) -> Result<Value, String> {
    let synced_count =
        tokio::task::spawn_blocking(|| mirror::sync::SyncEngine::global().run_cycle())
            .await
            .map_err(|e| format!("mirror_sync_now task join error: {}", e))??;
    Ok(json!({ "synced_count": synced_count, "stub": false }))
}

#[tauri::command]
pub async fn mirror_reset_stuck(_payload: Value) -> Result<Value, String> {
    let reset = tokio::task::spawn_blocking(|| -> Result<u64, String> {
        let conn = memory_store::open_conn()?;
        let updated = conn
            .execute(
                "UPDATE mem_items
         SET sync_status = 'local_only',
             sync_attempt_count = 0,
             sync_excluded_reason = NULL
         WHERE sync_status = 'excluded' AND sync_excluded_reason = 'stuck'",
                [],
            )
            .map_err(|e| e.to_string())?;
        Ok(updated as u64)
    })
    .await
    .map_err(|e| format!("mirror_reset_stuck task join error: {}", e))??;
    Ok(json!({ "reset": reset, "stub": false }))
}

#[tauri::command]
pub fn mirror_disable(payload: Value) -> Result<Value, String> {
    let wipe_keys = payload
        .get("wipe_keys")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Always lock the engine (clears in-process MasterKey).
    mirror::sync::SyncEngine::global().lock();
    mirror::sync::SyncEngine::global().clear_client();

    if wipe_keys {
        // Remove Master Key and device token from Keychain.
        #[cfg(target_os = "macos")]
        {
            let _ = mirror::keychain::delete_master_key();
            let _ = mirror::keychain::delete_device_token();
            let _ = mirror::keychain::delete_salt();
        }
    }

    // Disable in settings.
    settings_store::save_patch(&json!({
      "section": "cloud_mirror",
      "enabled": false,
    }))?;

    Ok(json!({ "stub": false }))
}

fn load_device_names_cache() -> std::collections::HashMap<String, String> {
    let settings = settings_store::load().unwrap_or_else(|_| json!({ "sections": {} }));
    let mut out = std::collections::HashMap::new();
    if let Some(map) = settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("device_names"))
        .and_then(|v| v.as_object())
    {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

fn load_this_device_id() -> Option<String> {
    let settings = settings_store::load().ok()?;
    settings
        .get("sections")
        .and_then(|s| s.get("cloud_mirror"))
        .and_then(|m| m.get("device_id"))
        .and_then(|v| v.as_str())
        .map(String::from)
}

fn save_device_names_cache(
    cache: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let mut map = serde_json::Map::new();
    for (k, v) in cache {
        map.insert(k.clone(), Value::String(v.clone()));
    }
    settings_store::save_patch(&json!({
      "section": "cloud_mirror",
      "device_names": Value::Object(map),
    }))?;
    Ok(())
}

#[tauri::command]
pub async fn mirror_search_blobs(payload: Value) -> Result<Value, String> {
    let query = payload
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("query required")?
        .to_string();
    let since_ms = payload
        .get("since_ms")
        .and_then(|v| v.as_i64())
        .ok_or("since_ms required")?;
    let until_ms = payload
        .get("until_ms")
        .and_then(|v| v.as_i64())
        .ok_or("until_ms required")?;

    // Defensive lock check — frontend already gates on `mirror_status.locked`,
    // but a race could land here before unlock. Reject early with the same
    // error string the frontend recognizes.
    let stats = mirror::sync::SyncEngine::global().stats();
    if stats.locked {
        return Err("locked".into());
    }

    // Reconstruct the client from persisted state if needed (e.g. fresh app
    // launch where the user already registered but hasn't synced yet).
    // Cheap; safe to run on the Tauri runtime before handing off to spawn_blocking.
    mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();

    // Move the CPU-heavy decrypt/parse/score work into spawn_blocking. The
    // closure captures owned values (`String`, `i64`, `HashMap`) so it is `Send`,
    // and uses the dedicated `MIRROR_RUNTIME` to drive the inner async HTTP
    // calls inside `search_cloud_blobs`.
    let hits = tokio::task::spawn_blocking(
        move || -> Result<Vec<mirror::search::CloudSearchHit>, String> {
            let mek = mirror::sync::SyncEngine::global()
                .mek()
                .ok_or_else(|| "locked".to_string())?;
            let client = mirror::sync::SyncEngine::global()
                .client()
                .ok_or_else(|| "not registered".to_string())?;
            let this_device_id =
                load_this_device_id().unwrap_or_else(|| "unknown_device".to_string());
            let names = load_device_names_cache();

            mirror::sync::mirror_runtime().block_on(mirror::search::search_cloud_blobs(
                &query,
                since_ms,
                until_ms,
                &client,
                &mek,
                &this_device_id,
                move |id: &str| names.get(id).cloned(),
            ))
        },
    )
    .await
    .map_err(|e| format!("mirror_search_blobs task join error: {}", e))??;

    let out: Vec<Value> = hits
        .into_iter()
        .map(|h| {
            let (source_str, device_name) = match h.source {
                mirror::search::HitSource::Local => ("local", None),
                mirror::search::HitSource::MirrorThisDevice => ("mirror-self", None),
                mirror::search::HitSource::MirrorOtherDevice { device_name } => {
                    ("mirror-other", Some(device_name))
                }
            };
            let mut obj = serde_json::Map::new();
            obj.insert("blob_id".to_string(), Value::String(h.blob_id));
            obj.insert("device_id".to_string(), Value::String(h.device_id));
            obj.insert("id".to_string(), Value::String(h.mem_item.id));
            obj.insert("title".to_string(), Value::String(h.mem_item.title));
            obj.insert("snippet".to_string(), Value::String(h.mem_item.snippet));
            obj.insert("source_field".to_string(), Value::String(h.mem_item.source));
            obj.insert(
                "kinds_json".to_string(),
                Value::String(h.mem_item.kinds_json),
            );
            obj.insert("created_at".to_string(), json!(h.mem_item.created_at));
            obj.insert("similarity".to_string(), json!(h.similarity));
            obj.insert("source".to_string(), Value::String(source_str.to_string()));
            if let Some(name) = device_name {
                obj.insert("device_name".to_string(), Value::String(name));
            }
            Value::Object(obj)
        })
        .collect();

    Ok(json!({ "hits": out }))
}

#[tauri::command]
pub async fn mirror_list_devices(_payload: Value) -> Result<Value, String> {
    mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
    let client = mirror::sync::SyncEngine::global()
        .client()
        .ok_or_else(|| "not registered".to_string())?;

    let result = client
        .list_devices_by_aggregation()
        .await
        .map_err(|e| e.to_string())?;

    let this_device_id = load_this_device_id();
    let names = load_device_names_cache();

    let devices: Vec<Value> = result
        .summaries
        .into_iter()
        .map(|s| {
            let is_self = this_device_id.as_deref() == Some(s.device_id.as_str());
            let mut obj = serde_json::Map::new();
            obj.insert("device_id".to_string(), Value::String(s.device_id.clone()));
            obj.insert("blob_count".to_string(), json!(s.blob_count));
            obj.insert(
                "latest_stored_at".to_string(),
                match s.latest_stored_at {
                    Some(v) => Value::String(v),
                    None => Value::Null,
                },
            );
            obj.insert("is_this_device".to_string(), Value::Bool(is_self));
            if let Some(name) = names.get(&s.device_id) {
                obj.insert("device_name".to_string(), Value::String(name.clone()));
            }
            Value::Object(obj)
        })
        .collect();

    Ok(json!({
      "devices": devices,
      "truncated": result.truncated,
    }))
}

#[tauri::command]
pub async fn mirror_rename_device(payload: Value) -> Result<Value, String> {
    let device_id = payload
        .get("device_id")
        .and_then(|v| v.as_str())
        .ok_or("device_id required")?
        .to_string();
    let new_name_raw = payload
        .get("new_name")
        .and_then(|v| v.as_str())
        .ok_or("name-empty")?;
    let new_name = new_name_raw.trim();

    if new_name.is_empty() {
        return Err("name-empty".into());
    }
    // RFC § 5.4: device names are bounded by 64 *characters* (not bytes).
    // Use char count so multibyte names (e.g. Japanese, ~3 bytes/char) aren't
    // rejected by an over-strict byte limit.
    if new_name.chars().count() > 64 {
        return Err("name-too-long".into());
    }

    mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
    let client = mirror::sync::SyncEngine::global()
        .client()
        .ok_or_else(|| "not registered".to_string())?;

    let record = client
        .rename_device(&device_id, new_name)
        .await
        .map_err(|e| e.to_string())?;

    // Refresh the local name cache so subsequent list/search responses
    // surface the updated label without re-fetching from the server.
    // Best-effort: TOCTOU race possible if two clients rename/delete concurrently.
    // Acceptable for single-user Settings UI; the server is the source of truth.
    let mut names = load_device_names_cache();
    names.insert(record.device_id.clone(), record.device_name.clone());
    save_device_names_cache(&names)?;

    let device_value = serde_json::to_value(&record).map_err(|e| e.to_string())?;
    Ok(json!({ "device": device_value }))
}

#[tauri::command]
pub async fn mirror_delete_device(payload: Value) -> Result<Value, String> {
    let device_id = payload
        .get("device_id")
        .and_then(|v| v.as_str())
        .ok_or("device_id required")?
        .to_string();
    let confirm = payload
        .get("confirm")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if confirm != "DELETE" {
        return Err("confirm-mismatch".into());
    }

    let this_device_id = load_this_device_id();
    if this_device_id.as_deref() == Some(device_id.as_str()) {
        return Err("cannot-delete-self".into());
    }

    mirror::sync::SyncEngine::global().ensure_client_from_persisted_state();
    let client = mirror::sync::SyncEngine::global()
        .client()
        .ok_or_else(|| "not registered".to_string())?;

    let count = client
        .delete_device(&device_id)
        .await
        .map_err(|e| e.to_string())?;

    // Drop the deleted device from the local name cache.
    // Best-effort: TOCTOU race possible if two clients rename/delete concurrently.
    // Acceptable for single-user Settings UI; the server is the source of truth.
    let mut names = load_device_names_cache();
    if names.remove(&device_id).is_some() {
        save_device_names_cache(&names)?;
    }

    Ok(json!({ "tombstoned_blobs": count }))
}

#[cfg(test)]
mod mirror_phase_2_1_4_tests {
    use super::*;

    #[tokio::test]
    async fn mirror_search_blobs_locked_returns_locked() {
        // The engine starts locked by default in unit tests (no Keychain access),
        // so a search call should reject with the "locked" sentinel that the
        // frontend recognizes.
        let payload = json!({
          "query": "hello",
          "since_ms": 0i64,
          "until_ms": 1_700_000_000_000i64,
        });
        let res = mirror_search_blobs(payload).await;
        assert!(res.is_err(), "expected Err while locked, got {:?}", res);
        let err = res.unwrap_err();
        assert_eq!(err, "locked", "expected 'locked' sentinel, got {err:?}");
    }

    #[tokio::test]
    async fn mirror_rename_device_validates_empty_name() {
        let payload = json!({ "device_id": "dev_a", "new_name": "   " });
        let res = mirror_rename_device(payload).await;
        assert!(res.is_err(), "expected Err for empty name, got {:?}", res);
        let err = res.unwrap_err();
        assert_eq!(
            err, "name-empty",
            "expected 'name-empty' sentinel, got {err:?}"
        );
    }

    #[tokio::test]
    async fn mirror_rename_device_validates_too_long_name() {
        let too_long = "x".repeat(65);
        let payload = json!({ "device_id": "dev_a", "new_name": too_long });
        let res = mirror_rename_device(payload).await;
        assert!(
            res.is_err(),
            "expected Err for >64-char name, got {:?}",
            res
        );
        let err = res.unwrap_err();
        assert_eq!(
            err, "name-too-long",
            "expected 'name-too-long' sentinel, got {err:?}"
        );
    }

    #[tokio::test]
    async fn mirror_rename_device_accepts_multibyte_name_under_64_chars() {
        // RFC § 5.4 says the limit is 64 *characters*, not bytes. A 22-char
        // Japanese name is ~66 bytes (3 bytes/char) — historically rejected by a
        // byte-count check. It must pass length validation now.
        // 22 CJK chars ⇒ 66 bytes (3 bytes/char): "会議室の私のマックブックプロ一号機テスト用名"
        let multibyte_22 = "会議室の私のマックブックプロ一号機テスト用名";
        assert_eq!(
            multibyte_22.chars().count(),
            22,
            "fixture sanity: char count should be 22, got {}",
            multibyte_22.chars().count()
        );
        assert!(
            multibyte_22.len() > 64,
            "fixture sanity: byte length should be >64 to exercise the regression (got {})",
            multibyte_22.len()
        );

        let payload = json!({ "device_id": "dev_a", "new_name": multibyte_22 });
        let res = mirror_rename_device(payload).await;
        // The call will still fail (unit tests don't have a registered client),
        // but the failure must NOT be a length-validation error.
        assert!(res.is_err(), "expected Err (no client), got {:?}", res);
        let err = res.unwrap_err();
        assert_ne!(
            err, "name-too-long",
            "multibyte 22-char name was wrongly rejected as too long"
        );
        assert_ne!(
            err, "name-empty",
            "multibyte name was wrongly rejected as empty"
        );
    }

    #[tokio::test]
    async fn mirror_delete_device_validates_confirm() {
        let payload = json!({ "device_id": "dev_a", "confirm": "WRONG" });
        let res = mirror_delete_device(payload).await;
        assert!(res.is_err(), "expected Err for bad confirm, got {:?}", res);
        let err = res.unwrap_err();
        assert_eq!(
            err, "confirm-mismatch",
            "expected 'confirm-mismatch' sentinel, got {err:?}"
        );
    }
}
