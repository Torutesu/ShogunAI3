//! Read-only Notion sync into local memory (Integration Token or OAuth access
//! token from `integration_secrets` key `notion`).
//!
//! Uses `POST /v1/search` to enumerate pages the integration has access to,
//! then `GET /v1/blocks/:id/children` to fetch a short snippet per page.
//! Ingests each page with `source: "notion"`, `entity_id: <page_id>`,
//! `provenance: "connector"`.

use crate::{integration_secrets, memory_store};
use chrono::{DateTime, Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "notion";
const API_BASE: &str = "https://api.notion.com/v1";
const API_VERSION: &str = "2022-06-28";

/// Safety cap: don't ingest more than this many pages in one run regardless of
/// workspace size.
const PAGE_HARD_CAP: usize = 5000;
/// Max blocks to pull per page when building the snippet.
const BLOCK_SNIPPET_LIMIT: usize = 20;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct NotionSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<NotionSyncState> = Mutex::new(NotionSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> NotionSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn not_configured_msg() -> String {
  "Notion is not configured. Import credentials via app_integration_import_credentials with provider \"notion\" and `accessToken` (Internal Integration Token or OAuth access token)."
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

async fn notion_post(
  token: &str,
  endpoint: &str,
  body: &Value,
) -> Result<(StatusCode, String), String> {
  let url = format!("{API_BASE}/{endpoint}");
  let client = http_client()?;
  let mut attempt: u32 = 0;
  loop {
    attempt += 1;
    let resp = client
      .post(&url)
      .header("Authorization", format!("Bearer {}", token))
      .header("Notion-Version", API_VERSION)
      .json(body)
      .send()
      .await
      .map_err(|e| format!("Notion {} request failed: {}", endpoint, e))?;
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

async fn notion_get(
  token: &str,
  endpoint: &str,
  query: &[(&str, String)],
) -> Result<(StatusCode, String), String> {
  let url = format!("{API_BASE}/{endpoint}");
  let client = http_client()?;
  let mut attempt: u32 = 0;
  loop {
    attempt += 1;
    let resp = client
      .get(&url)
      .query(query)
      .header("Authorization", format!("Bearer {}", token))
      .header("Notion-Version", API_VERSION)
      .send()
      .await
      .map_err(|e| format!("Notion {} request failed: {}", endpoint, e))?;
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

/// Concat all `plain_text` values inside a rich_text array.
fn rich_text_plain(rich: &Value) -> String {
  let mut out = String::new();
  if let Some(arr) = rich.as_array() {
    for t in arr {
      if let Some(s) = t.get("plain_text").and_then(|x| x.as_str()) {
        out.push_str(s);
      }
    }
  }
  out
}

/// Best-effort title extraction. Pages carry `properties.<Title>.title[]`;
/// databases carry `title[]` at the top level.
fn page_title(item: &Value) -> String {
  if let Some(props) = item.pointer("/properties").and_then(|p| p.as_object()) {
    for (_k, v) in props.iter() {
      let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
      if ty == "title" {
        let txt = rich_text_plain(v.get("title").unwrap_or(&Value::Null));
        if !txt.trim().is_empty() {
          return txt;
        }
      }
    }
  }
  if let Some(tt) = item.get("title") {
    let txt = rich_text_plain(tt);
    if !txt.trim().is_empty() {
      return txt;
    }
  }
  "Untitled".to_string()
}

/// Turn a block into a one-line plain-text snippet (headings, paragraphs, etc.).
fn block_plain_text(block: &Value) -> String {
  let ty = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
  if ty.is_empty() {
    return String::new();
  }
  if let Some(inner) = block.get(ty).and_then(|v| v.as_object()) {
    if let Some(rt) = inner.get("rich_text") {
      return rich_text_plain(rt).trim().to_string();
    }
  }
  String::new()
}

async fn fetch_page_snippet(token: &str, page_id: &str) -> String {
  let q: Vec<(&str, String)> = vec![
    ("page_size", BLOCK_SNIPPET_LIMIT.to_string()),
  ];
  let endpoint = format!("blocks/{}/children", page_id);
  let (status, text) = match notion_get(token, &endpoint, &q).await {
    Ok(r) => r,
    Err(e) => {
      log::warn!("Notion block fetch failed for {}: {}", page_id, e);
      return String::new();
    }
  };
  if !status.is_success() {
    log::warn!("Notion block HTTP {} for {}", status, page_id);
    return String::new();
  }
  let v: Value = match serde_json::from_str(&text) {
    Ok(v) => v,
    Err(_) => return String::new(),
  };
  let mut lines: Vec<String> = Vec::new();
  if let Some(arr) = v.get("results").and_then(|x| x.as_array()) {
    for b in arr {
      let line = block_plain_text(b);
      if !line.is_empty() {
        lines.push(line);
      }
      if lines.len() >= BLOCK_SNIPPET_LIMIT {
        break;
      }
    }
  }
  lines.join("\n")
}

fn parse_iso8601(s: &str) -> Option<DateTime<Utc>> {
  DateTime::parse_from_rfc3339(s)
    .ok()
    .map(|dt| dt.with_timezone(&Utc))
}

/// Top-level sync. `days = Some(N)` filters out pages whose `last_edited_time`
/// is older than `N` days; `days = None` pulls everything (capped by hard cap).
pub async fn sync_workspace_to_memory(
  days: Option<u32>,
  max_pages: usize,
) -> Result<Value, String> {
  let start = std::time::Instant::now();
  let creds = integration_secrets::get_credentials(PROVIDER)?
    .ok_or_else(not_configured_msg)?;
  let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

  let cutoff = days.and_then(|d| {
    if d == 0 {
      None
    } else {
      Some(Utc::now() - Duration::days(d as i64))
    }
  });
  let cap = max_pages.clamp(1, PAGE_HARD_CAP);

  let mut ingested: u32 = 0;
  let mut skipped: u32 = 0;
  crate::progress_emitter::emit("notion", 0, None, "search");
  let mut considered: u32 = 0;
  let mut next_cursor: Option<String> = None;

  // Search returns all pages + databases the integration has access to. We
  // filter out databases client-side; titles / metadata only — blocks come
  // from a separate request per page.
  'outer: loop {
    let mut body = json!({
      "page_size": 100,
      "sort": { "direction": "descending", "timestamp": "last_edited_time" },
      "filter": { "value": "page", "property": "object" }
    });
    if let Some(c) = next_cursor.as_ref() {
      body["start_cursor"] = json!(c);
    }
    let (status, text) = notion_post(&token, "search", &body).await?;
    if !status.is_success() {
      let clip: String = text.chars().take(400).collect();
      let err = format!("Notion HTTP {}: {}", status, clip);
      if let Ok(mut s) = STATE.lock() {
        s.last_error = Some(err.clone());
      }
      return Err(err);
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("Notion JSON: {}", e))?;

    let results = v
      .get("results")
      .and_then(|x| x.as_array())
      .cloned()
      .unwrap_or_default();

    for item in results.iter() {
      considered += 1;
      let object = item.get("object").and_then(|x| x.as_str()).unwrap_or("");
      if object != "page" {
        continue;
      }
      let page_id = item
        .get("id")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
      if page_id.is_empty() {
        continue;
      }

      let last_edit_raw = item
        .get("last_edited_time")
        .and_then(|x| x.as_str())
        .unwrap_or("");
      let last_edit = parse_iso8601(last_edit_raw);

      // Results are sorted desc by last_edited_time, so once we hit a page
      // older than the cutoff we're done.
      if let (Some(cutoff_dt), Some(edit_dt)) = (cutoff, last_edit) {
        if edit_dt < cutoff_dt {
          break 'outer;
        }
      }

      let title = page_title(item);
      let url = item
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
      let snippet_body = fetch_page_snippet(&token, &page_id).await;
      let snippet = if snippet_body.is_empty() {
        format!("{}\n{}", title, url)
      } else {
        format!("{}\n{}\n\n{}", title, url, snippet_body)
      };

      let ing = json!({
        "title": format!("Notion: {}", title.chars().take(200).collect::<String>()),
        "snippet": snippet.chars().take(4000).collect::<String>(),
        "source": "notion",
        "kinds": ["doc"],
        "provenance": "connector",
        "entity_id": page_id,
      });
      match memory_store::ingest(&ing) {
        Ok(out) => {
          if out.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false) {
            skipped += 1;
          } else {
            ingested += 1;
          }
        }
        Err(e) => {
          log::warn!("Notion ingest failed for {}: {}", page_id, e);
          let _ = crate::dead_letter::record("notion", &ing, &e);
        }
      }
      // Emit progress every few pages so the UI can follow along.
      if (considered as usize) % 5 == 0 {
        crate::progress_emitter::emit(
          "notion",
          ingested as u64,
          Some(cap as u64),
          "pages",
        );
      }
      if (ingested as usize) >= cap {
        break 'outer;
      }
    }

    let has_more = v.get("has_more").and_then(|x| x.as_bool()).unwrap_or(false);
    if !has_more {
      break;
    }
    next_cursor = v
      .get("next_cursor")
      .and_then(|x| x.as_str())
      .map(|s| s.to_string());
    if next_cursor.is_none() {
      break;
    }
  }

  crate::progress_emitter::emit("notion", ingested as u64, Some(cap as u64), "done");
  let elapsed_ms = start.elapsed().as_millis() as u64;
  crate::memory_obs::emit(
    "notion_sync_done",
    &[
      ("ingested", ingested.to_string()),
      ("skipped", skipped.to_string()),
      ("considered", considered.to_string()),
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
    "considered": considered,
    "days": days,
    "stub": false,
  }))
}
