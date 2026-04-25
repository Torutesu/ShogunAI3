//! Read-only Linear sync into local memory (Personal API Key or OAuth access
//! token from `integration_secrets` key `linear`).
//!
//! Uses the Linear GraphQL API at `https://api.linear.app/graphql`. Pulls
//! issues the user is involved in, updated within the requested window.
//! Ingests each issue with `source: "linear"`, `entity_id: issue.id`,
//! `provenance: "connector"`.

use crate::{integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "linear";
const API_URL: &str = "https://api.linear.app/graphql";
/// Safety cap on total issues per sync run.
const ISSUE_HARD_CAP: usize = 2000;
const PAGE_SIZE: u32 = 100;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct LinearSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<LinearSyncState> = Mutex::new(LinearSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> LinearSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn not_configured_msg() -> String {
  "Linear is not configured. Import credentials via app_integration_import_credentials with provider \"linear\" and `accessToken` (Personal API Key from Linear → Settings → API, or OAuth access token)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
  doc
    .get("accessToken")
    .and_then(|v| v.as_str())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

fn http_client() -> Result<reqwest::Client, String> {
  reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(60))
    .build()
    .map_err(|e| e.to_string())
}

async fn linear_graphql(
  token: &str,
  query: &str,
  variables: &Value,
) -> Result<(StatusCode, String), String> {
  let client = http_client()?;
  let body = json!({ "query": query, "variables": variables });
  let mut attempt: u32 = 0;
  loop {
    attempt += 1;
    let resp = client
      .post(API_URL)
      // Linear accepts both "Authorization: <key>" (personal API key) and
      // "Authorization: Bearer <token>" (OAuth). Personal API keys start with
      // `lin_api_`; OAuth tokens are UUID-like. We forward as-is since Linear
      // tolerates Bearer prefix for personal keys too.
      .header("Authorization", token.to_string())
      .header("Content-Type", "application/json")
      .json(&body)
      .send()
      .await
      .map_err(|e| format!("Linear request failed: {}", e))?;
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

/// GraphQL envelope: `{ data: { issues: { nodes: [...], pageInfo: { hasNextPage, endCursor } } }, errors? }`.
fn ingest_issue(item: &Value) -> Result<bool, String> {
  let id = item.get("id").and_then(|x| x.as_str()).unwrap_or("");
  if id.is_empty() {
    return Ok(true);
  }
  let title = item.get("title").and_then(|x| x.as_str()).unwrap_or("(untitled)");
  let identifier = item
    .get("identifier")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let description = item.get("description").and_then(|x| x.as_str()).unwrap_or("");
  let state = item
    .pointer("/state/name")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let url = item.get("url").and_then(|x| x.as_str()).unwrap_or("");
  let assignee = item
    .pointer("/assignee/name")
    .and_then(|x| x.as_str())
    .unwrap_or("");
  let updated = item.get("updatedAt").and_then(|x| x.as_str()).unwrap_or("");

  let title_line = if identifier.is_empty() {
    format!("Linear: {}", title)
  } else {
    format!("Linear {}: {}", identifier, title)
  };

  let mut snippet = format!(
    "{}\nstate: {} · assignee: {} · updated: {}",
    url, state, assignee, updated,
  );
  if !description.is_empty() {
    snippet.push_str("\n\n");
    snippet.push_str(description);
  }

  let ing = json!({
    "title": title_line.chars().take(220).collect::<String>(),
    "snippet": snippet.chars().take(4000).collect::<String>(),
    "source": "linear",
    "kinds": ["task"],
    "provenance": "connector",
    "entity_id": id,
  });
  match memory_store::ingest(&ing) {
    Ok(out) => Ok(out.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false)),
    Err(e) => {
      let _ = crate::dead_letter::record("linear", &ing, &e);
      Err(e)
    }
  }
}

pub async fn sync_activity_to_memory(
  days: Option<u32>,
  max_items: usize,
) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;
  let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

  let window_days = days.unwrap_or(30).min(366);
  let cutoff = Utc::now() - Duration::days(window_days as i64);
  let cutoff_iso = cutoff.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
  let cap = max_items.clamp(1, ISSUE_HARD_CAP);

  // Filter to issues updated within the window. `orderBy: updatedAt` is not
  // supported directly; we request default (descending updatedAt order is
  // typical) then paginate.
  let query = r#"
    query Issues($first: Int!, $after: String, $updatedAfter: DateTime!) {
      issues(
        first: $first,
        after: $after,
        filter: { updatedAt: { gte: $updatedAfter } }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          identifier
          title
          description
          url
          updatedAt
          state { name }
          assignee { name }
        }
      }
    }
  "#;

  let mut cursor: Option<String> = None;
  let mut ingested: u32 = 0;
  let mut skipped: u32 = 0;
  let mut considered: u32 = 0;
  crate::progress_emitter::emit("linear", 0, Some(cap as u64), "search");

  loop {
    let mut vars = json!({ "first": PAGE_SIZE, "updatedAfter": cutoff_iso });
    if let Some(c) = cursor.as_ref() {
      vars["after"] = json!(c);
    }
    let (status, text) = linear_graphql(&token, query, &vars).await?;
    if !status.is_success() {
      let clip: String = text.chars().take(400).collect();
      let err = format!("Linear HTTP {}: {}", status, clip);
      if let Ok(mut s) = STATE.lock() {
        s.last_error = Some(err.clone());
      }
      return Err(err);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Linear JSON: {}", e))?;
    if let Some(errs) = v.get("errors").and_then(|x| x.as_array()) {
      if !errs.is_empty() {
        let first = errs[0]
          .get("message")
          .and_then(|m| m.as_str())
          .unwrap_or("unknown GraphQL error");
        return Err(format!("Linear GraphQL error: {}", first));
      }
    }
    let nodes = v
      .pointer("/data/issues/nodes")
      .and_then(|x| x.as_array())
      .cloned()
      .unwrap_or_default();
    for item in nodes.iter() {
      considered += 1;
      match ingest_issue(item) {
        Ok(true) => skipped += 1,
        Ok(false) => ingested += 1,
        Err(e) => log::warn!("Linear ingest failed: {}", e),
      }
      if (ingested as usize) >= cap {
        break;
      }
    }
    if (ingested as usize) >= cap {
      break;
    }
    let has_next = v
      .pointer("/data/issues/pageInfo/hasNextPage")
      .and_then(|x| x.as_bool())
      .unwrap_or(false);
    if !has_next {
      break;
    }
    cursor = v
      .pointer("/data/issues/pageInfo/endCursor")
      .and_then(|x| x.as_str())
      .map(|s| s.to_string());
    if cursor.is_none() {
      break;
    }
    crate::progress_emitter::emit("linear", ingested as u64, Some(cap as u64), "pages");
  }
  crate::progress_emitter::emit("linear", ingested as u64, Some(cap as u64), "done");

  let elapsed_ms = start.elapsed().as_millis() as u64;
  crate::memory_obs::emit(
    "linear_sync_done",
    &[
      ("ingested", ingested.to_string()),
      ("skipped", skipped.to_string()),
      ("considered", considered.to_string()),
      ("days", window_days.to_string()),
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
    "considered": considered,
    "days": window_days,
    "stub": false,
  }))
}
