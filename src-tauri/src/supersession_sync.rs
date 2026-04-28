//! Supersession 30-day background sync (KIOKU Sub-spec D). Modeled after
//! `patterns_sync.rs`. Wakes every 6 hours, runs detection if 30 days have
//! elapsed since the last successful run.

use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct SupersessionSyncState {
  pub last_run_ms: Option<i64>,
  pub last_marked_count: usize,
  pub last_error: Option<String>,
}

static STATE: Mutex<SupersessionSyncState> = Mutex::new(SupersessionSyncState {
  last_run_ms: None,
  last_marked_count: 0,
  last_error: None,
});

pub fn snapshot_state() -> SupersessionSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

fn supersession_enabled() -> bool {
  crate::settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/kioku_graph/supersession_enabled")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true) // default ON
}

fn should_run() -> bool {
  let last = STATE.lock().ok().and_then(|s| s.last_run_ms);
  match last {
    None => true,
    Some(t) => (now_ms() - t) >= 30 * 24 * 60 * 60 * 1000,
  }
}

pub fn spawn_background_supersession_sync() {
  tokio::spawn(async move {
    // Cold-start delay so app boot isn't competing with detection.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
      if supersession_enabled() && should_run() {
        match crate::supersession::run_supersession().await {
          Ok(marked) => {
            if let Ok(mut s) = STATE.lock() {
              s.last_run_ms = Some(now_ms());
              s.last_marked_count = marked;
              s.last_error = None;
            }
            crate::memory_obs::emit(
              "supersession_done",
              &[("marked", marked.to_string())],
            );
          }
          Err(e) => {
            log::warn!("supersession failed: {}", e);
            if let Ok(mut s) = STATE.lock() {
              s.last_error = Some(e.clone());
            }
            crate::memory_obs::emit("supersession_error", &[("error", e)]);
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
    }
  });
}
