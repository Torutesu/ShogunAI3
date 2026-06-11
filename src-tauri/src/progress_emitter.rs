//! Global `AppHandle` slot so connector modules can emit UI progress events
//! without threading the handle through every call site.

use crate::app_events;

pub fn set_app_handle(handle: tauri::AppHandle) {
  app_events::init(&handle);
}

/// Emit a `historical-sync-progress` event with `{ provider, current, total?, phase }`.
/// No-op when no `AppHandle` is registered (e.g. in unit tests).
pub fn emit(provider: &str, current: u64, total: Option<u64>, phase: &str) {
  app_events::emit_sync_progress(provider, current, total, phase);
}
