//! Read-only GitHub activity sync (Personal Access Token or OAuth token from
//! `integration_secrets` key `github`).
//!
//! Pulls issues and PRs the authenticated user is involved in, updated within
//! the requested window. Each hit lands in local memory with
//! `source: "github"`, `entity_id: <html_url>`, `provenance: "connector"`.

use crate::{integration_secrets, memory_store};
use chrono::{Duration, Utc};
use reqwest::StatusCode;
use serde_json::{json, Value};
use std::sync::Mutex;

const PROVIDER: &str = "github";
const API_BASE: &str = "https://api.github.com";
const USER_AGENT: &str = "ShogunAI/1.0";

/// Safety cap on total items ingested per run.
const TOTAL_ITEM_CAP: usize = 2000;
/// GitHub `search/issues` returns at most 1000 items (10 pages × 100).
const SEARCH_MAX_PAGE: u32 = 10;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct GithubSyncState {
    pub last_sync_ms: Option<u64>,
    pub last_ingested: Option<u64>,
    pub last_error: Option<String>,
    pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<GithubSyncState> = Mutex::new(GithubSyncState {
    last_sync_ms: None,
    last_ingested: None,
    last_error: None,
    last_duration_ms: None,
});

pub fn snapshot_state() -> GithubSyncState {
    STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn not_configured_msg() -> String {
    "GitHub is not configured. Import credentials via app_integration_import_credentials with provider \"github\" and `accessToken` (Personal Access Token or OAuth token)."
    .to_string()
}

fn token_from_doc(doc: &Value) -> Option<String> {
    doc.get("accessToken")
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

async fn gh_get(
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
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("GitHub {} request failed: {}", endpoint, e))?;
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

async fn fetch_username(token: &str) -> Result<String, String> {
    let (status, text) = gh_get(token, "user", &[]).await?;
    if !status.is_success() {
        let clip: String = text.chars().take(400).collect();
        return Err(format!("GitHub /user HTTP {}: {}", status, clip));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("GitHub JSON: {}", e))?;
    v.get("login")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "GitHub /user response had no `login`".to_string())
}

fn ingest_issue_or_pr(item: &Value) -> Result<bool, String> {
    let is_pr = item.get("pull_request").is_some();
    let html_url = item.get("html_url").and_then(|x| x.as_str()).unwrap_or("");
    if html_url.is_empty() {
        return Ok(true);
    }
    let number = item.get("number").and_then(|x| x.as_i64()).unwrap_or(0);
    let repo = item
        .get("repository_url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .rsplit("/repos/")
        .next()
        .unwrap_or("")
        .to_string();
    let title_raw = item
        .get("title")
        .and_then(|x| x.as_str())
        .unwrap_or("(untitled)");
    let state = item.get("state").and_then(|x| x.as_str()).unwrap_or("");
    let body = item.get("body").and_then(|x| x.as_str()).unwrap_or("");
    let author = item
        .pointer("/user/login")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let updated = item
        .get("updated_at")
        .and_then(|x| x.as_str())
        .unwrap_or("");

    let prefix = if is_pr { "GitHub PR" } else { "GitHub Issue" };
    let title_line = if repo.is_empty() {
        format!("{} #{}: {}", prefix, number, title_raw)
    } else {
        format!("{} {}#{}: {}", prefix, repo, number, title_raw)
    };

    let mut snippet = format!(
        "{}\nstate: {} · author: {} · updated: {}",
        html_url, state, author, updated,
    );
    if !body.is_empty() {
        snippet.push_str("\n\n");
        snippet.push_str(body);
    }

    let ing = json!({
      "title": title_line.chars().take(220).collect::<String>(),
      "snippet": snippet.chars().take(4000).collect::<String>(),
      "source": "github",
      "kinds": [if is_pr { "code" } else { "task" }],
      "provenance": "connector",
      "entity_id": html_url,
    });
    match memory_store::ingest(&ing) {
        Ok(out) => Ok(out
            .get("skipped")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)),
        Err(e) => {
            let _ = crate::dead_letter::record("github", &ing, &e);
            Err(e)
        }
    }
}

/// Top-level activity sync. Fetches issues/PRs the authenticated user is
/// involved in, updated within the `days` window (default: last 30).
pub async fn sync_activity_to_memory(days: Option<u32>, max_items: usize) -> Result<Value, String> {
    let start = std::time::Instant::now();
    let creds = integration_secrets::get_credentials(PROVIDER)?.ok_or_else(not_configured_msg)?;
    let token = token_from_doc(&creds).ok_or_else(not_configured_msg)?;

    let username = fetch_username(&token).await?;
    let cap = max_items.clamp(1, TOTAL_ITEM_CAP);

    // Default to 30 days if unspecified to avoid unbounded historical imports.
    let window_days = days.unwrap_or(30).min(366);
    let cutoff = Utc::now() - Duration::days(window_days as i64);
    let cutoff_date = cutoff.format("%Y-%m-%d").to_string();
    let q = format!("involves:{} updated:>={}", username, cutoff_date);

    let mut ingested: u32 = 0;
    let mut skipped: u32 = 0;
    let mut considered: u32 = 0;
    let mut page: u32 = 1;
    crate::progress_emitter::emit("github", 0, Some(cap as u64), "search");

    while page <= SEARCH_MAX_PAGE {
        let query: Vec<(&str, String)> = vec![
            ("q", q.clone()),
            ("sort", "updated".to_string()),
            ("order", "desc".to_string()),
            ("per_page", "100".to_string()),
            ("page", page.to_string()),
        ];
        let (status, text) = gh_get(&token, "search/issues", &query).await?;
        if !status.is_success() {
            let clip: String = text.chars().take(400).collect();
            let err = format!("GitHub HTTP {}: {}", status, clip);
            if let Ok(mut s) = STATE.lock() {
                s.last_error = Some(err.clone());
            }
            return Err(err);
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("GitHub JSON: {}", e))?;
        let items = v
            .get("items")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            break;
        }
        for item in items.iter() {
            considered += 1;
            match ingest_issue_or_pr(item) {
                Ok(true) => skipped += 1,
                Ok(false) => ingested += 1,
                Err(e) => log::warn!("GitHub ingest failed: {}", e),
            }
            if (ingested as usize) >= cap {
                break;
            }
        }
        if (ingested as usize) >= cap {
            break;
        }
        crate::progress_emitter::emit("github", ingested as u64, Some(cap as u64), "pages");
        // search API caps at 1000 results total; once we drop below per_page, stop.
        if items.len() < 100 {
            break;
        }
        page += 1;
    }
    crate::progress_emitter::emit("github", ingested as u64, Some(cap as u64), "done");

    let elapsed_ms = start.elapsed().as_millis() as u64;
    crate::memory_obs::emit(
        "github_sync_done",
        &[
            ("ingested", ingested.to_string()),
            ("skipped", skipped.to_string()),
            ("considered", considered.to_string()),
            ("days", window_days.to_string()),
            ("user", username.clone()),
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
      "user": username,
      "stub": false,
    }))
}
