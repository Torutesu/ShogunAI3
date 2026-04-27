//! Global `AppHandle` slot so connector modules can emit UI progress events
//! without threading the handle through every call site.

use serde_json::json;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app_handle(handle: AppHandle) {
  let _ = APP_HANDLE.set(handle);
}

/// Emit a `historical-sync-progress` event with `{ provider, current, total?, phase }`.
/// No-op when no `AppHandle` is registered (e.g. in unit tests).
pub fn emit(provider: &str, current: u64, total: Option<u64>, phase: &str) {
  let Some(app) = APP_HANDLE.get() else {
    return;
  };
  let payload = json!({
    "provider": provider,
    "current": current,
    "total": total,
    "phase": phase,
  });
  if let Err(e) = app.emit("historical-sync-progress", payload) {
    log::warn!("progress emit failed: {}", e);
  }
}
