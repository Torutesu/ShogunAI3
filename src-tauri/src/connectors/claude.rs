//! Claude / Anthropic integration sync into local memory.
//! Token: Anthropic API key (`sk-ant-…`) via integration import, or falls
//! back to the main LLM API key when it is Anthropic-shaped.
//!
//! Sync ingests optional export notes from `settings.sections.claude.notes`
//! (array of `{title, body}`) and validates the API key with a minimal request.

use crate::{integration_secrets, memory_store, secrets, settings_store};
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "claude";
const API_BASE: &str = "https://api.anthropic.com/v1";

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ClaudeSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<ClaudeSyncState> = Mutex::new(ClaudeSyncState {
    last_sync_ms: None,
    last_ingested: None,
    last_error: None,
    last_duration_ms: None,
});

pub fn snapshot_state() -> ClaudeSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_configured_msg() -> String {
    "Claude is not configured. Paste an Anthropic API key (sk-ant-…) via integration import, or set the main LLM key in Settings → Model & API."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
    doc.get("accessToken")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn resolve_api_key() -> Result<String, String> {
    if let Some(doc) = integration_secrets::get_credentials(PROVIDER)? {
        if let Some(t) = token_from_doc(&doc) {
            return Ok(t);
        }
    }
    secrets::get_llm_api_key()?
        .filter(|k| k.trim().starts_with("sk-ant-"))
        .ok_or_else(not_configured_msg)
}

fn notes_from_settings() -> Vec<(String, String)> {
    let doc = settings_store::load().unwrap_or_else(|_| json!({}));
    doc.pointer("/sections/claude/notes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|row| {
                    let title = row
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Claude note");
                    let body = row.get("body").and_then(|v| v.as_str()).unwrap_or("");
                    if body.trim().is_empty() {
                        None
                    } else {
                        Some((title.to_string(), body.to_string()))
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn validate_key(key: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
      "model": "claude-3-5-haiku-latest",
      "max_tokens": 1,
      "messages": [{"role": "user", "content": "."}],
    });
    let resp = client
        .post(format!("{API_BASE}/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Claude API request failed: {}", e))?;
    if resp.status().is_success() {
        return Ok(());
    }
    let status = resp.status();
    let text: String = resp
        .text()
        .await
        .unwrap_or_default()
        .chars()
        .take(400)
        .collect();
    Err(format!("Claude API HTTP {}: {}", status, text))
}

fn ingest_note(title: &str, body: &str, entity_suffix: &str) -> Result<bool, String> {
    let payload = json!({
      "title": format!("Claude: {}", title.chars().take(200).collect::<String>()),
      "snippet": body.chars().take(8000).collect::<String>(),
      "source": PROVIDER,
      "entity_id": format!("claude:note:{}", entity_suffix),
      "provenance": "connector",
      "kinds": ["llm", "note"],
    });
    match memory_store::ingest(&payload) {
        Ok(v) => Ok(v.get("skipped").and_then(|x| x.as_bool()).unwrap_or(false)),
        Err(e) => {
            let _ = crate::dead_letter::record(PROVIDER, &payload, &e);
            Err(e)
        }
    }
}

pub async fn sync_context_to_memory(max_items: usize) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let key = resolve_api_key()?;
    validate_key(&key).await?;

    let cap = max_items.clamp(1, 100);
    let mut ingested: u32 = 0;
    let mut skipped: u32 = 0;

    let heartbeat = json!({
      "title": "Claude API connected",
      "snippet": "Anthropic API key validated. Add export notes in Settings → Integrations to ingest Claude project context into Memory.",
      "source": PROVIDER,
      "entity_id": "claude:api:heartbeat",
      "provenance": "connector",
      "kinds": ["llm"],
    });
    match memory_store::ingest(&heartbeat) {
        Ok(v) if v.get("skipped").and_then(|x| x.as_bool()) == Some(true) => skipped += 1,
        Ok(_) => ingested += 1,
        Err(e) => log::warn!("Claude heartbeat ingest failed: {}", e),
    }

    for (i, (title, body)) in notes_from_settings().into_iter().take(cap).enumerate() {
        match ingest_note(&title, &body, &i.to_string()) {
            Ok(true) => skipped += 1,
            Ok(false) => ingested += 1,
            Err(e) => log::warn!("Claude note ingest failed: {}", e),
        }
    }

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
      "elapsedMs": elapsed_ms,
    }))
}
