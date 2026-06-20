//! Read-only Figma file metadata sync into local memory.
//! Token: Personal Access Token (paste via integration import).
//! Optional file keys: `settings.sections.figma.fileKeys` (array of strings).

use crate::{integration_secrets, memory_store, settings_store};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "figma";
const API_BASE: &str = "https://api.figma.com/v1";
const FILE_CAP: usize = 200;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct FigmaSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<FigmaSyncState> = Mutex::new(FigmaSyncState {
    last_sync_ms: None,
    last_ingested: None,
    last_error: None,
    last_duration_ms: None,
});

pub fn snapshot_state() -> FigmaSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_configured_msg() -> String {
    "Figma is not configured. Import credentials via app_integration_import_credentials with provider \"figma\" and `accessToken` (Personal Access Token)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
    doc.get("accessToken")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn figma_get(token: &str, endpoint: &str) -> Result<(StatusCode, String), String> {
    let url = format!("{API_BASE}/{endpoint}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("X-Figma-Token", token)
        .send()
        .await
        .map_err(|e| format!("Figma {} request failed: {}", endpoint, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn file_keys_from_settings() -> Vec<String> {
    let doc = settings_store::load().unwrap_or_else(|_| json!({}));
    doc.pointer("/sections/figma/fileKeys")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn ingest_file_meta(file_key: &str, body: &Value) -> Result<bool, String> {
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled");
    let last_modified = body
        .get("lastModified")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let version = body.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let snippet = format!(
        "Figma file key: {}\nLast modified: {}\nVersion: {}",
        file_key, last_modified, version
    );
    let payload = json!({
      "title": format!("Figma: {}", name.chars().take(200).collect::<String>()),
      "snippet": snippet,
      "source": PROVIDER,
      "entity_id": file_key,
      "provenance": "connector",
      "kinds": ["design"],
    });
    match memory_store::ingest(&payload) {
        Ok(v) => Ok(v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false)),
        Err(e) => {
            let _ = crate::dead_letter::record(PROVIDER, &payload, &e);
            Err(e)
        }
    }
}

pub async fn sync_files_to_memory(max_files: usize) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let creds = integration_secrets::get_credentials(PROVIDER)?.ok_or_else(not_configured_msg)?;
    let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;
    let cap = max_files.clamp(1, FILE_CAP);

    let (me_status, me_text) = figma_get(&token, "me").await?;
    if !me_status.is_success() {
        let clip: String = me_text.chars().take(400).collect();
        return Err(format!("Figma /me HTTP {}: {}", me_status, clip));
    }

    let keys = file_keys_from_settings();
    if keys.is_empty() {
        let me: Value = serde_json::from_str(&me_text).map_err(|e| e.to_string())?;
        let handle = me.get("handle").and_then(|v| v.as_str()).unwrap_or("user");
        let email = me.get("email").and_then(|v| v.as_str()).unwrap_or("");
        let payload = json!({
          "title": format!("Figma connected: {}", handle),
          "snippet": format!("Figma account {} ({}) is connected. Add file keys in Settings → Integrations to sync design files.", handle, email),
          "source": PROVIDER,
          "entity_id": format!("figma:account:{}", handle),
          "provenance": "connector",
          "kinds": ["design"],
        });
        let _ = memory_store::ingest(&payload);
        return Ok(json!({
          "ingested": 1,
          "skipped": 0,
          "provider": PROVIDER,
          "note": "No figma.fileKeys configured — ingested account heartbeat only",
          "elapsedMs": start.elapsed().as_millis() as u64,
        }));
    }

    let mut ingested: u32 = 0;
    let mut skipped: u32 = 0;
    crate::progress_emitter::emit(PROVIDER, 0, Some(cap as u64), "files");

    for key in keys.iter().take(cap) {
        let endpoint = format!("files/{}", urlencoding::encode(key));
        let (status, text) = figma_get(&token, &endpoint).await?;
        if !status.is_success() {
            log::warn!(
                "Figma file {} HTTP {}: {}",
                key,
                status,
                text.chars().take(200).collect::<String>()
            );
            continue;
        }
        let body: Value = serde_json::from_str(&text).map_err(|e| format!("Figma JSON: {}", e))?;
        match ingest_file_meta(key, &body) {
            Ok(true) => skipped += 1,
            Ok(false) => ingested += 1,
            Err(e) => log::warn!("Figma ingest {} failed: {}", key, e),
        }
    }

    crate::progress_emitter::emit(PROVIDER, ingested as u64, Some(cap as u64), "done");
    let elapsed_ms = start.elapsed().as_millis() as u64;
    if let Ok(mut s) = STATE.lock() {
        s.last_sync_ms = Some(now_ms());
        s.last_ingested = Some(ingested as u64);
        s.last_duration_ms = Some(elapsed_ms);
        s.last_error = None;
    }

    Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "provider": PROVIDER,
      "filesRequested": keys.len().min(cap),
      "elapsedMs": elapsed_ms,
    }))
}
