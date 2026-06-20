//! Read-only Gmail inbox sync into local memory (Bearer token from `integration_secrets` key `gmail`).

use crate::{google_oauth, integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

/// Safety cap on messages fetched in a single historical sync run
/// (1 year of heavy inbox use typically stays well under this).
const HISTORICAL_HARD_CAP: usize = 5000;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct GmailSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<GmailSyncState> = Mutex::new(GmailSyncState {
    last_sync_ms: None,
    last_ingested: None,
    last_error: None,
    last_duration_ms: None,
});

pub fn snapshot_state() -> GmailSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const PROVIDER: &str = "gmail";

fn not_configured_msg() -> String {
    "Gmail is not configured. Import credentials via app_integration_import_credentials with provider \"gmail\"."
    .to_string()
}

async fn gmail_list_messages(
    token: &str,
    max_results: usize,
    q: Option<&str>,
    page_token: Option<&str>,
) -> Result<(StatusCode, String), String> {
    let url = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let max_s = max_results.to_string();
    let mut req = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token.trim()));
    let mut params: Vec<(&str, String)> = vec![("maxResults", max_s)];
    if let Some(qs) = q {
        if !qs.trim().is_empty() {
            params.push(("q", qs.to_string()));
        }
    }
    if let Some(pt) = page_token {
        if !pt.is_empty() {
            params.push(("pageToken", pt.to_string()));
        }
    }
    req = req.query(&params);
    let resp = req
        .send()
        .await
        .map_err(|e| format!("Gmail list request failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

async fn gmail_get_message_metadata(
    token: &str,
    message_id: &str,
) -> Result<(StatusCode, String), String> {
    let path = urlencoding::encode(message_id);
    let url = format!(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}",
        path
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .query(&[
            ("format", "metadata"),
            ("metadataHeaders", "Subject"),
            ("metadataHeaders", "From"),
        ])
        .header("Authorization", format!("Bearer {}", token.trim()))
        .send()
        .await
        .map_err(|e| format!("Gmail get message failed: {}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

fn header_value(msg: &Value, name: &str) -> Option<String> {
    let headers = msg.pointer("/payload/headers")?.as_array()?;
    for h in headers {
        let n = h.get("name").and_then(|x| x.as_str())?;
        if n.eq_ignore_ascii_case(name) {
            return h
                .get("value")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
    }
    None
}

/// Returns `Ok(true)` when the row was skipped by the entity-id UNIQUE index
/// (i.e. already ingested previously); `Ok(false)` when newly inserted.
fn ingest_gmail_message(message_id: &str, msg: &Value) -> Result<bool, String> {
    let subject = header_value(msg, "Subject").unwrap_or_else(|| "(no subject)".to_string());
    let from = header_value(msg, "From").unwrap_or_default();
    let snippet = msg.get("snippet").and_then(|s| s.as_str()).unwrap_or("");
    let body = format!("Subject: {}\nFrom: {}\n{}", subject, from, snippet);
    let ing = json!({
      "title": format!("Gmail: {}", subject.chars().take(200).collect::<String>()),
      "snippet": body.chars().take(4000).collect::<String>(),
      "source": "gmail",
      "kinds": ["mail"],
      "provenance": "connector",
      "entity_id": message_id,
    });
    match memory_store::ingest(&ing) {
        Ok(out) => Ok(out
            .get("skipped")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)),
        Err(e) => {
            let _ = crate::dead_letter::record("gmail", &ing, &e);
            Err(e)
        }
    }
}

async fn refresh_and_persist_creds(creds: &Value) -> Result<Value, String> {
    let refreshed = google_oauth::refresh_access_token(creds).await?;
    integration_secrets::set_credentials(PROVIDER, &refreshed)?;
    Ok(refreshed)
}

pub async fn sync_inbox_to_memory(max_results: usize, days: Option<u32>) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let mut creds =
        integration_secrets::get_credentials(PROVIDER)?.ok_or_else(not_configured_msg)?;

    google_oauth::maybe_refresh_credentials(PROVIDER, &mut creds).await?;

    let mut token = google_oauth::access_token_from_doc(&creds)?;

    // Build optional `after:YYYY/MM/DD` query when a historical window is requested.
    let q_owned: Option<String> = days.and_then(|d| {
        if d == 0 {
            return None;
        }
        let since = Utc::now() - Duration::days(d as i64);
        Some(format!("after:{}", since.format("%Y/%m/%d")))
    });
    let q_ref: Option<&str> = q_owned.as_deref();
    // Page size: 500 is the Gmail API max. Fallback to requested max_results for small calls.
    let page_size = if days.is_some() {
        500
    } else {
        max_results.max(1)
    };
    // Total cap across all pages.
    let total_cap = if days.is_some() {
        HISTORICAL_HARD_CAP
    } else {
        max_results.max(1)
    };

    let mut collected_ids: Vec<String> = Vec::new();
    let mut page_token: Option<String> = None;

    loop {
        let (status, text) = {
            let pt = page_token.as_deref();
            let first = gmail_list_messages(&token, page_size, q_ref, pt).await?;
            if first.0 == StatusCode::UNAUTHORIZED && google_oauth::credentials_can_refresh(&creds)
            {
                log::warn!("Gmail API 401 on list; attempting token refresh");
                creds = refresh_and_persist_creds(&creds).await?;
                token = google_oauth::access_token_from_doc(&creds)?;
                gmail_list_messages(&token, page_size, q_ref, pt).await?
            } else {
                first
            }
        };

        if !status.is_success() {
            let snippet: String = text.chars().take(600).collect();
            let err = format!("Gmail API {}: {}", status, snippet);
            crate::memory_obs::emit(
                "gmail_sync_error",
                &[
                    ("error", err.clone()),
                    (
                        "elapsed_ms",
                        (start.elapsed().as_millis() as u64).to_string(),
                    ),
                ],
            );
            if let Ok(mut s) = STATE.lock() {
                s.last_error = Some(err.clone());
                s.last_duration_ms = Some(start.elapsed().as_millis() as u64);
            }
            return Err(err);
        }

        let body: Value = serde_json::from_str(&text).map_err(|e| {
            format!(
                "Invalid Gmail JSON: {} — {}",
                e,
                text.chars().take(200).collect::<String>()
            )
        })?;

        if let Some(arr) = body.get("messages").and_then(|m| m.as_array()) {
            for item in arr {
                if let Some(id) = item.get("id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        collected_ids.push(id.to_string());
                        if collected_ids.len() >= total_cap {
                            break;
                        }
                    }
                }
            }
        }

        if collected_ids.len() >= total_cap {
            break;
        }
        // Only paginate when doing historical fetch.
        let next = body
            .get("nextPageToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if days.is_none() || next.is_none() {
            break;
        }
        page_token = next;
    }

    let mut ingested = 0u32;
    let mut skipped = 0u32;
    let total = collected_ids.len() as u64;
    crate::progress_emitter::emit("gmail", 0, Some(total), "ingest");
    for (i, id) in collected_ids.iter().enumerate() {
        // Throttle progress events: emit roughly every 10 items.
        if i % 10 == 0 {
            crate::progress_emitter::emit("gmail", i as u64, Some(total), "ingest");
        }
        // Network errors on individual message fetches must not abort a long
        // historical import — log and move on.
        let first = match gmail_get_message_metadata(&token, id).await {
            Ok(r) => r,
            Err(e) => {
                log::warn!("Skipping message {} (network error): {}", id, e);
                continue;
            }
        };
        let (st, txt) = if first.0 == StatusCode::UNAUTHORIZED
            && google_oauth::credentials_can_refresh(&creds)
        {
            log::warn!("Gmail API 401 on get; attempting token refresh");
            creds = refresh_and_persist_creds(&creds).await?;
            token = google_oauth::access_token_from_doc(&creds)?;
            match gmail_get_message_metadata(&token, id).await {
                Ok(r) => r,
                Err(e) => {
                    log::warn!(
                        "Skipping message {} after refresh (network error): {}",
                        id,
                        e
                    );
                    continue;
                }
            }
        } else {
            first
        };
        if !st.is_success() {
            log::warn!("Skipping message {}: Gmail API {}", id, st);
            continue;
        }
        let msg: Value = serde_json::from_str(&txt).unwrap_or(json!({}));
        match ingest_gmail_message(id, &msg) {
            Ok(true) => skipped += 1,
            Ok(false) => ingested += 1,
            Err(e) => {
                log::warn!("Skipping message {} (ingest failed): {}", id, e);
                continue;
            }
        }
    }
    crate::progress_emitter::emit("gmail", total, Some(total), "done");

    let elapsed_ms = start.elapsed().as_millis() as u64;
    crate::memory_obs::emit(
        "gmail_sync_done",
        &[
            ("ingested", ingested.to_string()),
            ("skipped", skipped.to_string()),
            ("max_results", total_cap.to_string()),
            ("days", days.map(|d| d.to_string()).unwrap_or_default()),
            ("elapsed_ms", elapsed_ms.to_string()),
        ],
    );
    if let Ok(mut s) = STATE.lock() {
        s.last_sync_ms = Some(now_ms());
        s.last_ingested = Some(ingested as u64);
        s.last_error = None;
        s.last_duration_ms = Some(start.elapsed().as_millis() as u64);
    }
    Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "days": days,
      "stub": false,
    }))
}
