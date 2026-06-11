//! Unified `AppHandle` slot for Tauri event emission across the app.

use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST_MEMORY_INDEX_EMIT_MS: AtomicU64 = AtomicU64::new(0);

const MEMORY_INDEX_MIN_INTERVAL_MS: u64 = 2_000;

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Register the process-wide `AppHandle` (idempotent — first call wins).
pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
}

/// Emit a Tauri event with a serializable payload. No-op when not initialized.
pub fn emit(event: &str, payload: impl Serialize) {
  let Some(app) = APP.get() else {
    return;
  };
  let payload = match serde_json::to_value(payload) {
    Ok(v) => v,
    Err(e) => {
      log::warn!("app_events emit({event}) serialize failed: {e}");
      return;
    }
  };
  if let Err(e) = app.emit(event, payload) {
    log::warn!("app_events emit({event}) failed: {e}");
  }
}

/// Throttled `shogun-memory-index-changed` for capture ingest sources.
pub fn emit_memory_index_changed_if_capture(source: &str) {
  if !source.starts_with("capture_") {
    return;
  }
  let now = now_ms();
  let last = LAST_MEMORY_INDEX_EMIT_MS.load(Ordering::Relaxed);
  if now.saturating_sub(last) < MEMORY_INDEX_MIN_INTERVAL_MS {
    return;
  }
  LAST_MEMORY_INDEX_EMIT_MS.store(now, Ordering::Relaxed);
  emit("shogun-memory-index-changed", json!({ "source": source }));
}

/// Emit `historical-sync-progress` for connector sync UIs.
pub fn emit_sync_progress(provider: &str, current: u64, total: Option<u64>, phase: &str) {
  emit(
    "historical-sync-progress",
    json!({
      "provider": provider,
      "current": current,
      "total": total,
      "phase": phase,
    }),
  );
}

/// Focus main window and emit `hummingbird-open`.
pub fn emit_hummingbird_open(source: &str) {
  let Some(app) = APP.get() else {
    return;
  };
  if let Some(win) = app.get_webview_window("main") {
    let _ = win.show();
    let _ = win.set_focus();
  }
  let _ = app.emit(
    "hummingbird-open",
    json!({ "source": source, "mode": "in_app_overlay" }),
  );
}
