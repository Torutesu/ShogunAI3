//! Throttled Tauri events when the local memory index changes (capture ingest).

use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST_EMIT_MS: AtomicU64 = AtomicU64::new(0);

const MIN_INTERVAL_MS: u64 = 2_000;

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

pub fn init(app: AppHandle) {
  let _ = APP.set(app);
}

/// Notify frontends that Memory should refresh (capture rows only, rate-limited).
pub fn notify_index_changed_if_capture(source: &str) {
  if !source.starts_with("capture_") {
    return;
  }
  let now = now_ms();
  let last = LAST_EMIT_MS.load(Ordering::Relaxed);
  if now.saturating_sub(last) < MIN_INTERVAL_MS {
    return;
  }
  LAST_EMIT_MS.store(now, Ordering::Relaxed);
  if let Some(app) = APP.get() {
    let _ = app.emit("shogun-memory-index-changed", json!({ "source": source }));
  }
}
