//! Background auto-generation of memory digests. Ensures that when the user
//! opens the app in the morning, today's day rollup and this week's week
//! rollup are already cached (so the Home "Memory digest" card shows content
//! without requiring a Memory-screen visit).
//!
//! What this does NOT do:
//! - Does not trigger ingestion (that lives in calendar_sync / connector_sync).
//! - Does not itself batch-summarize individual items — rollups pull from
//!   whatever mem_summaries already exist. The River's on-screen batch flow
//!   remains the primary path for item-level summaries. Auto-rollup waits
//!   until there's something to synthesize.
//! - Does not generate for every (lang) pair. Pre-generates only the current
//!   `sections.memory.autoDigestLang` (default "en"); non-matching langs
//!   fall back to on-demand generation when the user visits Memory.

use crate::settings_store;
use crate::summarizer;
use crate::summarizer_store;
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct RollupSyncState {
  pub last_run_ms: Option<u64>,
  pub last_day_id: Option<String>,
  pub last_week_id: Option<String>,
  pub last_error: Option<String>,
}

static STATE: Mutex<RollupSyncState> = Mutex::new(RollupSyncState {
  last_run_ms: None,
  last_day_id: None,
  last_week_id: None,
  last_error: None,
});

pub fn snapshot_state() -> RollupSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Settings → (enabled, interval_minutes, lang).
fn auto_digest_settings() -> (bool, u64, String) {
  let Ok(doc) = settings_store::load() else {
    return (true, 360, "en".to_string()); // sensible default even if settings haven't loaded
  };
  // enableMemorySummary AND autoDigest both must not be explicitly false.
  let summary_enabled = doc
    .pointer("/sections/memory/enableMemorySummary")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let auto_enabled = doc
    .pointer("/sections/memory/autoDigest")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let enabled = summary_enabled && auto_enabled;
  let mins = doc
    .pointer("/sections/memory/autoDigestIntervalMins")
    .and_then(|v| v.as_u64())
    .unwrap_or(360) // 6 hours
    .clamp(60, 24 * 60);
  let lang = doc
    .pointer("/sections/memory/autoDigestLang")
    .and_then(|v| v.as_str())
    .unwrap_or("en")
    .to_string();
  (enabled, mins, lang)
}

/// Calendar-day start (00:00 UTC) of today, in ms.
fn today_start_ms() -> i64 {
  let today = Utc::now().date_naive();
  NaiveDate::from_ymd_opt(today.year(), today.month(), today.day())
    .and_then(|d| d.and_hms_opt(0, 0, 0))
    .map(|ndt| Utc.from_utc_datetime(&ndt).timestamp_millis())
    .unwrap_or(0)
}

/// Current ISO-week Monday (00:00 UTC), in ms.
fn this_week_start_ms() -> i64 {
  let today = Utc::now().date_naive();
  let weekday_from_mon = today.weekday().num_days_from_monday() as i64;
  let monday = today
    .checked_sub_signed(chrono::Duration::days(weekday_from_mon))
    .unwrap_or(today);
  NaiveDate::from_ymd_opt(monday.year(), monday.month(), monday.day())
    .and_then(|d| d.and_hms_opt(0, 0, 0))
    .map(|ndt| Utc.from_utc_datetime(&ndt).timestamp_millis())
    .unwrap_or(0)
}

/// Returns true if there is at least one item summary in the [start_ms, end_ms)
/// window for the given language. Used to avoid calling the LLM when the
/// window is empty (summarize_*_rollup handles empty too, but an early return
/// skips logging noise).
fn window_has_summaries(start_ms: i64, end_ms: i64, lang: &str) -> bool {
  summarizer_store::get_summaries_in_window(start_ms, end_ms, lang)
    .map(|v| !v.is_empty())
    .unwrap_or(false)
}

async fn run_once(lang: &str) -> Result<(String, String), String> {
  let day_ms = today_start_ms();
  let week_ms = this_week_start_ms();

  // Day rollup: only run when we have at least one item summary for today,
  // AND either there's no cached day rollup yet or items were added since
  // the cache was written.
  let day_id = summarizer::format_week_id(day_ms);
  let day_end = day_ms + 24 * 3600 * 1000;
  let day_cache = summarizer_store::get_cached("day_rollup", &day_id, lang).ok().flatten();
  let day_should_run = window_has_summaries(day_ms, day_end, lang)
    && match &day_cache {
      // No cache → run.
      None => true,
      // Have cache → re-run only if any item summary was generated AFTER the cache.
      Some(c) => {
        summarizer_store::get_summaries_in_window(day_ms, day_end, lang)
          .map(|items| items.iter().any(|s| s.generated_at > c.generated_at))
          .unwrap_or(false)
      }
    };
  if day_should_run {
    let rollup = summarizer::summarize_day_rollup(day_ms, lang).await?;
    summarizer_store::upsert(&rollup)?;
  }

  // Week rollup: same gating logic.
  let week_id = summarizer::format_week_id(week_ms);
  let week_end = week_ms + 7 * 24 * 3600 * 1000;
  let week_cache = summarizer_store::get_cached("week_rollup", &week_id, lang).ok().flatten();
  let week_should_run = window_has_summaries(week_ms, week_end, lang)
    && match &week_cache {
      None => true,
      Some(c) => summarizer_store::get_summaries_in_window(week_ms, week_end, lang)
        .map(|items| items.iter().any(|s| s.generated_at > c.generated_at))
        .unwrap_or(false),
    };
  if week_should_run {
    let rollup = summarizer::summarize_week_rollup(week_ms, lang).await?;
    summarizer_store::upsert(&rollup)?;
  }

  Ok((day_id, week_id))
}

pub fn spawn_background_rollup_sync() {
  spawn(async move {
    // Quick warmup — wait 30s after app start so initial item summaries have
    // a chance to land before we synthesize rollups over them.
    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
    loop {
      let (enabled, mins, lang) = auto_digest_settings();
      if enabled {
        let now = now_ms();
        let last_ms = STATE.lock().ok().and_then(|g| g.last_run_ms);
        let period_ms = mins.saturating_mul(60_000);
        let due = last_ms
          .map(|t| now.saturating_sub(t) >= period_ms)
          .unwrap_or(true);
        if due {
          match run_once(&lang).await {
            Ok((day_id, week_id)) => {
              if let Ok(mut s) = STATE.lock() {
                s.last_run_ms = Some(now_ms());
                s.last_day_id = Some(day_id);
                s.last_week_id = Some(week_id);
                s.last_error = None;
              }
              crate::memory_obs::emit("rollup_sync_done", &[("lang", lang.clone())]);
            }
            Err(e) => {
              log::warn!("rollup auto-sync failed: {}", e);
              if let Ok(mut s) = STATE.lock() {
                s.last_error = Some(e.clone());
              }
              crate::memory_obs::emit("rollup_sync_error", &[("error", e)]);
            }
          }
        }
      }
      // Wake up every 5 minutes to re-evaluate. Actual work is gated by the
      // `due` check above, so setting mins=360 still only runs every 6h.
      tokio::time::sleep(std::time::Duration::from_secs(300)).await;
    }
  });
}
