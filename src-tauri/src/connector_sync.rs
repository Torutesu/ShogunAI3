//! Periodic background sync for third-party connectors
//! (Gmail / Slack / Notion / GitHub).
//!
//! Each tick checks every provider and, if all conditions hold, triggers a
//! sync using a short rolling window (days <= the provider's last historical
//! import, capped at 7). Respects per-provider enable toggle + interval in
//! `settings.sections.integrations.*AutoSync` / `*SyncIntervalMins`.

use crate::{github, gmail, integration_secrets, linear, notion, settings_store, slack};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

#[derive(Clone, Debug, Default)]
struct ProviderState {
  last_sync_ms: Option<u64>,
}

static STATES: Mutex<[ProviderState; 5]> = Mutex::new([
  ProviderState { last_sync_ms: None }, // gmail
  ProviderState { last_sync_ms: None }, // slack
  ProviderState { last_sync_ms: None }, // notion
  ProviderState { last_sync_ms: None }, // github
  ProviderState { last_sync_ms: None }, // linear
]);

const IDX_GMAIL: usize = 0;
const IDX_SLACK: usize = 1;
const IDX_NOTION: usize = 2;
const IDX_GITHUB: usize = 3;
const IDX_LINEAR: usize = 4;

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn last_sync_ms(idx: usize) -> Option<u64> {
  STATES.lock().ok().and_then(|g| g[idx].last_sync_ms)
}

fn record_sync_ms(idx: usize, ts: u64) {
  if let Ok(mut g) = STATES.lock() {
    g[idx].last_sync_ms = Some(ts);
  }
}

/// `(enabled, interval_mins, already_onboarded, window_days)`.
/// - `already_onboarded`: the user has answered the historical-import prompt
///   (value exists, even if 0 = skipped). We don't start auto-syncing until
///   the user has expressed intent for this provider.
/// - `window_days`: how far back each tick fetches. For historical coverage
///   we cap at 7 days so the periodic call stays light.
fn provider_settings(
  doc: &Value,
  provider: &str,
  default_mins: u64,
) -> (bool, u64, bool, u32) {
  let enabled = doc
    .pointer(&format!(
      "/sections/integrations/{}AutoSync",
      provider_key_camel(provider)
    ))
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let mins = doc
    .pointer(&format!(
      "/sections/integrations/{}SyncIntervalMins",
      provider_key_camel(provider)
    ))
    .and_then(|v| v.as_u64())
    .unwrap_or(default_mins)
    .clamp(5, 1440);

  // `historicalSyncDays` is set when the user clicks Skip (0) or runs an
  // import (>0) — either way they've seen the prompt for this provider.
  let decided = doc
    .pointer(&format!("/sections/{}/historicalSyncDays", provider))
    .is_some();
  let last_hist = doc
    .pointer(&format!("/sections/{}/historicalSyncDays", provider))
    .and_then(|v| v.as_u64())
    .unwrap_or(0);
  // Incremental tick fetches at most `min(last_hist, 7)` days so it's fast.
  let window_days = last_hist.min(7) as u32;

  (enabled, mins, decided, window_days)
}

fn provider_key_camel(provider: &str) -> &'static str {
  match provider {
    "gmail" => "gmail",
    "slack" => "slack",
    "notion" => "notion",
    "github" => "github",
    "linear" => "linear",
    _ => "unknown",
  }
}

async fn tick_gmail(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "gmail", 15);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("gmail")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_GMAIL)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match gmail::sync_inbox_to_memory(500, days).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("gmail auto-sync: ingested {} email(s)", n);
      record_sync_ms(IDX_GMAIL, now_ms());
    }
    Err(e) => log::warn!("gmail auto-sync failed: {}", e),
  }
}

async fn tick_slack(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "slack", 30);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("slack")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_SLACK)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match slack::sync_workspace_to_memory(days, 200).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("slack auto-sync: ingested {} message(s)", n);
      record_sync_ms(IDX_SLACK, now_ms());
    }
    Err(e) => log::warn!("slack auto-sync failed: {}", e),
  }
}

async fn tick_notion(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "notion", 60);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("notion")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_NOTION)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match notion::sync_workspace_to_memory(days, 200).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("notion auto-sync: ingested {} page(s)", n);
      record_sync_ms(IDX_NOTION, now_ms());
    }
    Err(e) => log::warn!("notion auto-sync failed: {}", e),
  }
}

async fn tick_github(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "github", 60);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("github")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_GITHUB)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match github::sync_activity_to_memory(days, 200).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("github auto-sync: ingested {} item(s)", n);
      record_sync_ms(IDX_GITHUB, now_ms());
    }
    Err(e) => log::warn!("github auto-sync failed: {}", e),
  }
}

async fn tick_linear(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "linear", 60);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("linear")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_LINEAR)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match linear::sync_activity_to_memory(days, 200).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("linear auto-sync: ingested {} issue(s)", n);
      record_sync_ms(IDX_LINEAR, now_ms());
    }
    Err(e) => log::warn!("linear auto-sync failed: {}", e),
  }
}

/// Starts a single background loop that polls each connector in turn. The
/// outer sleep is 60s; each provider self-gates on its own interval so the
/// cadence stays correct.
pub fn spawn_background_connector_sync() {
  spawn(async move {
    // Small stagger so we don't all sync at once on app startup.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    loop {
      let doc = settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
      tick_gmail(&doc).await;
      tick_slack(&doc).await;
      tick_notion(&doc).await;
      tick_github(&doc).await;
      tick_linear(&doc).await;
      tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
  });
}
