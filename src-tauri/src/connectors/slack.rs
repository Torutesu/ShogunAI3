//! Read-only Slack sync into local memory (Bot or User token from
//! `integration_secrets` key `slack`). Messages go in with
//! `source: "slack"`, `entity_id: "{channel}:{ts}"`, `provenance: "connector"`.

use crate::{integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "slack";
const API_BASE: &str = "https://slack.com/api";

/// Hard cap on total messages ingested per sync run (safety against very
/// large workspaces). Large DMs/channels can easily have 10k+ messages.
const TOTAL_MESSAGE_CAP: usize = 5000;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct SlackSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<SlackSyncState> = Mutex::new(SlackSyncState {
    last_sync_ms: None,
    last_ingested: None,
    last_error: None,
    last_duration_ms: None,
});

pub fn snapshot_state() -> SlackSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_configured_msg() -> String {
    "Slack is not configured. Import credentials via app_integration_import_credentials with provider \"slack\" and `accessToken` (Bot or User OAuth token starting with xoxb-/xoxp-)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
    doc.get("accessToken")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn slack_get(
    token: &str,
    endpoint: &str,
    query: &[(&str, String)],
) -> Result<(StatusCode, String), String> {
    let url = format!("{API_BASE}/{endpoint}");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut attempt: u32 = 0;
    loop {
        attempt += 1;
        let resp = client
            .get(&url)
            .query(query)
            .header("Authorization", format!("Bearer {}", token))
            .send()
            .await
            .map_err(|e| format!("Slack {} request failed: {}", endpoint, e))?;
        let status = resp.status();
        if status.is_success() || attempt >= crate::http_retry::DEFAULT_MAX_ATTEMPTS {
            let text = resp.text().await.map_err(|e| e.to_string())?;
            return Ok((status, text));
        }
        match crate::http_retry::next_retry_delay(
            status,
            resp.headers(),
            attempt,
            crate::http_retry::DEFAULT_BASE_DELAY_MS,
            crate::http_retry::DEFAULT_MAX_DELAY_MS,
        ) {
            Some(delay) => {
                let _ = resp.bytes().await;
                tokio::time::sleep(delay).await;
            }
            None => {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                return Ok((status, text));
            }
        }
    }
}

/// Slack sometimes returns 200 with `{ok:false, error:"…"}`. Treat that as an error.
fn ensure_slack_ok(body: &Value) -> Result<(), String> {
    let ok = body.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    if ok {
        return Ok(());
    }
    let err = body
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown_error");
    Err(format!("Slack API error: {}", err))
}

async fn list_conversations(token: &str) -> Result<Vec<Value>, String> {
    let mut out: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut q: Vec<(&str, String)> = vec![
            // Bot users need to be invited to channels; user tokens can see everything
            // they have access to. Include all conversation types so DMs flow through.
            (
                "types",
                "public_channel,private_channel,mpim,im".to_string(),
            ),
            ("exclude_archived", "true".to_string()),
            ("limit", "200".to_string()),
        ];
        if let Some(c) = cursor.as_ref() {
            if !c.is_empty() {
                q.push(("cursor", c.clone()));
            }
        }
        let (status, text) = slack_get(token, "conversations.list", &q).await?;
        if !status.is_success() {
            let clip: String = text.chars().take(400).collect();
            return Err(format!("Slack HTTP {}: {}", status, clip));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("Slack JSON: {}", e))?;
        ensure_slack_ok(&v)?;
        if let Some(arr) = v.get("channels").and_then(|x| x.as_array()) {
            out.extend(arr.iter().cloned());
        }
        let next = v
            .pointer("/response_metadata/next_cursor")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        match next {
            Some(ref s) if !s.is_empty() => cursor = Some(s.clone()),
            _ => break,
        }
    }
    Ok(out)
}

/// Fetch up to `max` messages newer than `oldest_ts` seconds.
async fn history_for_channel(
    token: &str,
    channel_id: &str,
    oldest_ts_secs: Option<f64>,
    max: usize,
) -> Result<Vec<Value>, String> {
    let mut out: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut q: Vec<(&str, String)> = vec![
            ("channel", channel_id.to_string()),
            ("limit", "200".to_string()),
        ];
        if let Some(o) = oldest_ts_secs {
            q.push(("oldest", format!("{:.6}", o)));
        }
        if let Some(c) = cursor.as_ref() {
            if !c.is_empty() {
                q.push(("cursor", c.clone()));
            }
        }
        let (status, text) = slack_get(token, "conversations.history", &q).await?;
        if !status.is_success() {
            let clip: String = text.chars().take(400).collect();
            return Err(format!("Slack HTTP {}: {}", status, clip));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("Slack JSON: {}", e))?;
        if let Err(e) = ensure_slack_ok(&v) {
            // Channels the bot isn't a member of return `not_in_channel` — that's
            // expected for bot tokens, just skip.
            log::warn!("skip channel {}: {}", channel_id, e);
            return Ok(Vec::new());
        }
        if let Some(arr) = v.get("messages").and_then(|x| x.as_array()) {
            for m in arr {
                out.push(m.clone());
                if out.len() >= max {
                    break;
                }
            }
        }
        if out.len() >= max {
            break;
        }
        let has_more = v.get("has_more").and_then(|x| x.as_bool()).unwrap_or(false);
        if !has_more {
            break;
        }
        let next = v
            .pointer("/response_metadata/next_cursor")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        match next {
            Some(ref s) if !s.is_empty() => cursor = Some(s.clone()),
            _ => break,
        }
    }
    Ok(out)
}

fn channel_display_name(ch: &Value) -> String {
    if let Some(name) = ch.get("name").and_then(|x| x.as_str()) {
        if !name.is_empty() {
            return name.to_string();
        }
    }
    if let Some(user) = ch.get("user").and_then(|x| x.as_str()) {
        return format!("dm:{}", user);
    }
    ch.get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("channel")
        .to_string()
}

fn ingest_slack_message(channel: &Value, msg: &Value) -> Result<bool, String> {
    let channel_id = channel.get("id").and_then(|x| x.as_str()).unwrap_or("");
    let channel_name = channel_display_name(channel);
    let ts = msg.get("ts").and_then(|x| x.as_str()).unwrap_or("");
    if ts.is_empty() || channel_id.is_empty() {
        return Ok(true);
    }
    let text = msg.get("text").and_then(|x| x.as_str()).unwrap_or("");
    // Skip empty / ephemeral bot frames.
    if text.trim().is_empty() {
        return Ok(true);
    }
    let user = msg
        .get("user")
        .and_then(|x| x.as_str())
        .or_else(|| msg.get("username").and_then(|x| x.as_str()))
        .unwrap_or("");
    let subtype = msg.get("subtype").and_then(|x| x.as_str()).unwrap_or("");
    let title = if user.is_empty() {
        format!(
            "Slack #{}: {}",
            channel_name,
            text.chars().take(80).collect::<String>()
        )
    } else {
        format!(
            "Slack #{} · {}: {}",
            channel_name,
            user,
            text.chars().take(80).collect::<String>()
        )
    };
    let body = if subtype.is_empty() {
        text.to_string()
    } else {
        format!("[{}] {}", subtype, text)
    };
    let ing = json!({
      "title": title.chars().take(200).collect::<String>(),
      "snippet": body.chars().take(4000).collect::<String>(),
      "source": "slack",
      "kinds": ["chat"],
      "provenance": "connector",
      "entity_id": format!("{}:{}", channel_id, ts),
    });
    match memory_store::ingest(&ing) {
        Ok(out) => Ok(out
            .get("skipped")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)),
        Err(e) => {
            let _ = crate::dead_letter::record("slack", &ing, &e);
            Err(e)
        }
    }
}

/// Top-level workspace sync. When `days` is `Some`, only messages newer than
/// `now - days` are fetched. `max_per_channel` caps per-channel ingestion.
pub async fn sync_workspace_to_memory(
    days: Option<u32>,
    max_per_channel: usize,
) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let creds = integration_secrets::get_credentials(PROVIDER)?.ok_or_else(not_configured_msg)?;
    let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

    let oldest_secs = days.and_then(|d| {
        if d == 0 {
            None
        } else {
            let since = Utc::now() - Duration::days(d as i64);
            Some(since.timestamp() as f64)
        }
    });
    let cap = max_per_channel.clamp(1, 1000);

    let channels = list_conversations(&token).await?;
    crate::progress_emitter::emit("slack", 0, Some(channels.len() as u64), "channels");

    let mut ingested: u32 = 0;
    let mut skipped: u32 = 0;
    let mut channels_touched: u32 = 0;
    let mut total_budget = TOTAL_MESSAGE_CAP;

    let channel_total = channels.len() as u64;
    for (ch_idx, ch) in channels.iter().enumerate() {
        if total_budget == 0 {
            break;
        }
        crate::progress_emitter::emit("slack", ch_idx as u64, Some(channel_total), "channels");
        let id = ch.get("id").and_then(|x| x.as_str()).unwrap_or("");
        if id.is_empty() {
            continue;
        }
        let pull = std::cmp::min(cap, total_budget);
        let msgs = match history_for_channel(&token, id, oldest_secs, pull).await {
            Ok(m) => m,
            Err(e) => {
                log::warn!("Slack history failed for {}: {}", id, e);
                continue;
            }
        };
        if msgs.is_empty() {
            continue;
        }
        channels_touched += 1;
        for m in msgs.iter() {
            match ingest_slack_message(ch, m) {
                Ok(true) => skipped += 1,
                Ok(false) => ingested += 1,
                Err(e) => {
                    log::warn!("Slack ingest failed ({}): {}", id, e);
                    continue;
                }
            }
            total_budget = total_budget.saturating_sub(1);
            if total_budget == 0 {
                break;
            }
        }
    }

    crate::progress_emitter::emit("slack", channel_total, Some(channel_total), "done");
    let elapsed_ms = start.elapsed().as_millis() as u64;
    crate::memory_obs::emit(
        "slack_sync_done",
        &[
            ("ingested", ingested.to_string()),
            ("skipped", skipped.to_string()),
            ("channels", channels_touched.to_string()),
            ("days", days.map(|d| d.to_string()).unwrap_or_default()),
            ("elapsed_ms", elapsed_ms.to_string()),
        ],
    );
    if let Ok(mut s) = STATE.lock() {
        s.last_sync_ms = Some(now_ms());
        s.last_ingested = Some(ingested as u64);
        s.last_error = None;
        s.last_duration_ms = Some(elapsed_ms);
    }
    Ok(json!({
      "ingested": ingested,
      "skipped": skipped,
      "channels": channels_touched,
      "days": days,
      "stub": false,
    }))
}
