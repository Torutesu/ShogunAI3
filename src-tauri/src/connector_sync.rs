//! Periodic background sync for third-party connectors
//! (Gmail / Slack / Notion / GitHub).
//!
//! Each tick checks every provider and, if all conditions hold, triggers a
//! sync using a short rolling window (days <= the provider's last historical
//! import, capped at 7). Respects per-provider enable toggle + interval in
//! `settings.sections.integrations.*AutoSync` / `*SyncIntervalMins`.

use crate::{
  apple_local, github, gmail, google_drive, integration_secrets, integrations, linear, notion,
  outlook, figma, claude, settings_store, slack, zoom,
};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

#[derive(Clone, Debug, Default)]
struct ProviderState {
  last_sync_ms: Option<u64>,
}

static STATES: Mutex<[ProviderState; 12]> = Mutex::new([
  ProviderState { last_sync_ms: None }, // gmail
  ProviderState { last_sync_ms: None }, // slack
  ProviderState { last_sync_ms: None }, // notion
  ProviderState { last_sync_ms: None }, // github
  ProviderState { last_sync_ms: None }, // linear
  ProviderState { last_sync_ms: None }, // google_drive
  ProviderState { last_sync_ms: None }, // zoom
  ProviderState { last_sync_ms: None }, // outlook
  ProviderState { last_sync_ms: None }, // figma
  ProviderState { last_sync_ms: None }, // claude
  ProviderState { last_sync_ms: None }, // apple_calendar
  ProviderState { last_sync_ms: None }, // apple_reminders
]);

const IDX_GMAIL: usize = 0;
const IDX_SLACK: usize = 1;
const IDX_NOTION: usize = 2;
const IDX_GITHUB: usize = 3;
const IDX_LINEAR: usize = 4;
const IDX_DRIVE: usize = 5;
const IDX_ZOOM: usize = 6;
const IDX_OUTLOOK: usize = 7;
const IDX_FIGMA: usize = 8;
const IDX_CLAUDE: usize = 9;
const IDX_APPLE_CAL: usize = 10;
const IDX_APPLE_REM: usize = 11;

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
    // Settings keys use the same slug as the provider; for Drive this produces
    // `google_driveAutoSync` / `google_driveSyncIntervalMins` which is
    // intentionally consistent with how the frontend writes the flags.
    "google_drive" => "google_drive",
    "zoom" => "zoom",
    "outlook" => "outlook",
    "figma" => "figma",
    "claude" => "claude",
    "apple_calendar" => "apple_calendar",
    "apple_reminders" => "apple_reminders",
    _ => "unknown",
  }
}

fn apple_auto_sync_settings(doc: &Value, provider: &str, default_mins: u64) -> (bool, u64, bool) {
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
  let connected = integrations::provider_connected_in_settings(provider).unwrap_or(false);
  (enabled, mins, connected)
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

async fn tick_drive(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "google_drive", 60);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("google_drive")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_DRIVE)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match google_drive::sync_drive_to_memory(days, 200).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("drive auto-sync: ingested {} file(s)", n);
      record_sync_ms(IDX_DRIVE, now_ms());
    }
    Err(e) => log::warn!("drive auto-sync failed: {}", e),
  }
}

async fn tick_zoom(doc: &Value) {
  // Default to a long interval — each tick can transcribe many hours of
  // audio through Deepgram, so we don't want to hammer it every hour.
  let (enabled, mins, decided, window) = provider_settings(doc, "zoom", 360);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("zoom")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_ZOOM)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(1) } else { Some(window) };
  match zoom::sync_recordings_to_memory(days, 10).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("zoom auto-sync: ingested {} meeting(s)", n);
      record_sync_ms(IDX_ZOOM, now_ms());
    }
    Err(e) => log::warn!("zoom auto-sync failed: {}", e),
  }
}

async fn tick_outlook(doc: &Value) {
  let (enabled, mins, decided, window) = provider_settings(doc, "outlook", 30);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("outlook")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_OUTLOOK)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  let days = if window == 0 { Some(7) } else { Some(window) };
  match outlook::sync_mail_to_memory(days, 80).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("outlook auto-sync: ingested {} message(s)", n);
      record_sync_ms(IDX_OUTLOOK, now_ms());
    }
    Err(e) => log::warn!("outlook auto-sync failed: {}", e),
  }
}

async fn tick_figma(doc: &Value) {
  let (enabled, mins, decided, _window) = provider_settings(doc, "figma", 120);
  if !enabled || !decided {
    return;
  }
  if integration_secrets::get_credentials("figma")
    .ok()
    .flatten()
    .is_none()
  {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_FIGMA)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  match figma::sync_files_to_memory(30).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("figma auto-sync: ingested {} file(s)", n);
      record_sync_ms(IDX_FIGMA, now_ms());
    }
    Err(e) => log::warn!("figma auto-sync failed: {}", e),
  }
}

async fn tick_claude(doc: &Value) {
  let (enabled, mins, decided, _window) = provider_settings(doc, "claude", 360);
  if !enabled || !decided {
    return;
  }
  let has_integration = integration_secrets::get_credentials("claude")
    .ok()
    .flatten()
    .is_some();
  let has_llm = crate::secrets::get_llm_api_key()
    .ok()
    .flatten()
    .map(|k| k.starts_with("sk-ant-"))
    .unwrap_or(false);
  if !has_integration && !has_llm {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_CLAUDE)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  match claude::sync_context_to_memory(20).await {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("claude auto-sync: ingested {} item(s)", n);
      record_sync_ms(IDX_CLAUDE, now_ms());
    }
    Err(e) => log::warn!("claude auto-sync failed: {}", e),
  }
}

fn tick_apple_calendar(doc: &Value) {
  let (enabled, mins, connected) = apple_auto_sync_settings(doc, "apple_calendar", 60);
  if !enabled || !connected {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_APPLE_CAL)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  match apple_local::sync_calendar_to_memory(50) {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("apple_calendar auto-sync: ingested {} event(s)", n);
      record_sync_ms(IDX_APPLE_CAL, now_ms());
    }
    Err(e) => log::warn!("apple_calendar auto-sync failed: {}", e),
  }
}

fn tick_apple_reminders(doc: &Value) {
  let (enabled, mins, connected) = apple_auto_sync_settings(doc, "apple_reminders", 120);
  if !enabled || !connected {
    return;
  }
  let now = now_ms();
  let period_ms = mins.saturating_mul(60_000);
  let due = last_sync_ms(IDX_APPLE_REM)
    .map(|t| now.saturating_sub(t) >= period_ms)
    .unwrap_or(true);
  if !due {
    return;
  }
  match apple_local::sync_reminders_to_memory(80) {
    Ok(out) => {
      let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      log::info!("apple_reminders auto-sync: ingested {} item(s)", n);
      record_sync_ms(IDX_APPLE_REM, now_ms());
    }
    Err(e) => log::warn!("apple_reminders auto-sync failed: {}", e),
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
      tick_drive(&doc).await;
      tick_zoom(&doc).await;
      tick_outlook(&doc).await;
      tick_figma(&doc).await;
      tick_claude(&doc).await;
      tick_apple_calendar(&doc);
      tick_apple_reminders(&doc);
      tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
  });
}
