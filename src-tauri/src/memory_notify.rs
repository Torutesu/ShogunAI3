//! Throttled Tauri events when the local memory index changes (capture ingest).

use crate::app_events;
use tauri::AppHandle;

pub fn init(app: AppHandle) {
    app_events::init(&app);
}

/// Notify frontends that Memory should refresh (capture rows only, rate-limited).
pub fn notify_index_changed_if_capture(source: &str) {
    app_events::emit_memory_index_changed_if_capture(source);
    let source = source.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = crate::agents::run_event_triggered_custom_agents("memory").await;
        crate::memory_obs::emit("custom_agent_memory_event", &[("source", source)]);
    });
}
