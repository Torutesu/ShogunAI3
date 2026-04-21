//! Periodic Google Calendar → Memory sync when enabled in settings and credentials exist.

use crate::{diagnostics, google_calendar, integration_secrets, settings_store};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

static LAST_SYNC_MS: Mutex<Option<u64>> = Mutex::new(None);

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn auto_sync_settings() -> (bool, u64) {
  let Ok(doc) = settings_store::load() else {
    return (false, 15);
  };
  let enabled = doc
    .pointer("/sections/integrations/googleCalendarAutoSync")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let mins = doc
    .pointer("/sections/integrations/googleCalendarSyncIntervalMins")
    .and_then(|v| v.as_u64())
    .unwrap_or(15)
    .clamp(5, 1440);
  (enabled, mins)
}

pub fn spawn_background_calendar_sync() {
  spawn(async move {
    loop {
      tokio::time::sleep(std::time::Duration::from_secs(60)).await;
      let (enabled, mins) = auto_sync_settings();
      if !enabled {
        continue;
      }
      if integration_secrets::get_credentials("google_calendar")
        .ok()
        .flatten()
        .is_none()
      {
        continue;
      }
      let now = now_ms();
      let period_ms = mins.saturating_mul(60_000);
      let due = {
        let Ok(last) = LAST_SYNC_MS.lock() else {
          continue;
        };
        last
          .map(|t| now.saturating_sub(t) >= period_ms)
          .unwrap_or(true)
      };
      if !due {
        continue;
      }
      match google_calendar::sync_events_to_memory("primary", 25).await {
        Ok(out) => {
          let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
          log::info!("calendar auto-sync: ingested {} event(s)", n);
          if let Ok(mut last) = LAST_SYNC_MS.lock() {
            *last = Some(now_ms());
          }
        }
        Err(e) => {
          log::warn!("calendar auto-sync failed: {}", e);
          diagnostics::record("calendar_sync.auto", e);
        }
      }
    }
  });
}
