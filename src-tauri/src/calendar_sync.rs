//! Periodic Google Calendar → Memory sync when enabled in settings and credentials exist.

use crate::{google_calendar, integration_secrets, settings_store};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::async_runtime::spawn;

#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct CalendarSyncState {
  pub last_sync_ms: Option<u64>,
  pub last_ingested: Option<u64>,
  pub last_error: Option<String>,
  pub last_duration_ms: Option<u64>,
}

static STATE: Mutex<CalendarSyncState> = Mutex::new(CalendarSyncState {
  last_sync_ms: None,
  last_ingested: None,
  last_error: None,
  last_duration_ms: None,
});

pub fn snapshot_state() -> CalendarSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

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
      let credentials_present = integration_secrets::get_credentials("google_calendar")
        .ok()
        .flatten()
        .is_some();
      let now = now_ms();
      let period_ms = mins.saturating_mul(60_000);
      let last_ms = STATE.lock().ok().and_then(|g| g.last_sync_ms);
      let due = last_ms
        .map(|t| now.saturating_sub(t) >= period_ms)
        .unwrap_or(true);
      crate::memory_obs::emit(
        "calendar_tick",
        &[
          ("enabled", enabled.to_string()),
          ("credentials", credentials_present.to_string()),
          ("due", due.to_string()),
          (
            "last_sync_ms",
            last_ms.map(|t| t.to_string()).unwrap_or_else(|| "0".to_string()),
          ),
        ],
      );
      if !enabled {
        continue;
      }
      if !credentials_present {
        continue;
      }
      if !due {
        continue;
      }
      let sync_start = std::time::Instant::now();
      match google_calendar::sync_events_to_memory("primary", 25).await {
        Ok(out) => {
          let n = out.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
          log::info!("calendar auto-sync: ingested {} event(s)", n);
          crate::memory_obs::emit(
            "calendar_sync_done",
            &[
              ("ingested", n.to_string()),
              (
                "elapsed_ms",
                (sync_start.elapsed().as_millis() as u64).to_string(),
              ),
            ],
          );
          if let Ok(mut s) = STATE.lock() {
            s.last_sync_ms = Some(now_ms());
            s.last_ingested = Some(n);
            s.last_error = None;
            s.last_duration_ms = Some(sync_start.elapsed().as_millis() as u64);
          }
        }
        Err(e) => {
          log::warn!("calendar auto-sync failed: {}", e);
          if let Ok(mut s) = STATE.lock() {
            s.last_error = Some(e.clone());
            s.last_duration_ms = Some(sync_start.elapsed().as_millis() as u64);
          }
          crate::memory_obs::emit(
            "calendar_sync_error",
            &[
              ("error", e.clone()),
              (
                "elapsed_ms",
                (sync_start.elapsed().as_millis() as u64).to_string(),
              ),
            ],
          );
        }
      }
    }
  });
}
