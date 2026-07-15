//! Unified `AppHandle` slot for Tauri event emission across the app.

use serde::Serialize;
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

static APP: OnceLock<AppHandle> = OnceLock::new();
static LAST_MEMORY_INDEX_EMIT_MS: AtomicU64 = AtomicU64::new(0);

const MEMORY_INDEX_MIN_INTERVAL_MS: u64 = 2_000;
pub const ACTION_LAYER_REFRESH_EVENT: &str = "shogun-action-layer-refresh";

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

/// Emit `shogun-action-layer-refresh` so desktop surfaces can reload action and
/// queue state after native mutations.
pub fn emit_action_layer_refresh(reason: &str, payload: Option<serde_json::Value>) {
    let mut detail = json!({
      "reason": reason.trim().to_string(),
    });
    if let (Some(extra), Some(obj)) = (payload, detail.as_object_mut()) {
        obj.insert("payload".to_string(), extra);
    }
    emit(ACTION_LAYER_REFRESH_EVENT, detail);
}

fn read_system_notification_pref(settings: &serde_json::Value, key: &str, fallback: bool) -> bool {
    settings
        .get("sections")
        .and_then(|v| v.get("system"))
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(fallback)
}

fn notifications_enabled() -> bool {
    match crate::settings_store::load() {
        Ok(settings) => read_system_notification_pref(&settings, "notif", true),
        Err(_) => true,
    }
}

fn notification_sound_enabled() -> bool {
    match crate::settings_store::load() {
        Ok(settings) => read_system_notification_pref(&settings, "sound", false),
        Err(_) => false,
    }
}

pub fn notify_native(title: &str, body: &str) {
    if !notifications_enabled() {
        return;
    }
    let Some(app) = APP.get() else {
        return;
    };
    let mut notification = app.notification().builder().title(title).body(body);
    if notification_sound_enabled() {
        notification = notification.sound("default");
    }
    if let Err(err) = notification.show() {
        log::warn!("native notification failed: {}", err);
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
    if phase.trim().eq_ignore_ascii_case("done") {
        notify_native(
            "Historical Sync Complete",
            &sync_completion_notification_body(provider, current, total),
        );
    }
}

fn sync_provider_label(provider: &str) -> &'static str {
    match provider.trim() {
        "gmail" => "Gmail",
        "google_calendar" => "Google Calendar",
        "google_drive" => "Google Drive",
        "slack" => "Slack",
        "notion" => "Notion",
        "github" => "GitHub",
        "linear" => "Linear",
        "zoom" => "Zoom",
        "figma" => "Figma",
        "outlook" => "Outlook",
        _ => "Connector",
    }
}

fn sync_completion_notification_body(provider: &str, current: u64, total: Option<u64>) -> String {
    let label = sync_provider_label(provider);
    match total {
        Some(total) if total > 0 => {
            format!("{label} historical sync finished. Imported {current} of {total} items.")
        }
        _ => format!("{label} historical sync finished. Imported {current} items."),
    }
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

#[cfg(test)]
mod tests {
    use super::{
        read_system_notification_pref, sync_completion_notification_body, sync_provider_label,
    };
    use serde_json::json;

    #[test]
    fn system_notification_pref_reads_bool_and_falls_back() {
        let settings = json!({
          "sections": {
            "system": {
              "notif": false,
              "sound": true
            }
          }
        });
        assert!(!read_system_notification_pref(&settings, "notif", true));
        assert!(read_system_notification_pref(&settings, "sound", false));
        assert!(read_system_notification_pref(&settings, "missing", true));
    }

    #[test]
    fn sync_provider_label_maps_known_providers() {
        assert_eq!(sync_provider_label("gmail"), "Gmail");
        assert_eq!(sync_provider_label("google_drive"), "Google Drive");
        assert_eq!(sync_provider_label("unknown"), "Connector");
    }

    #[test]
    fn sync_completion_notification_body_formats_counts() {
        assert_eq!(
            sync_completion_notification_body("gmail", 24, Some(24)),
            "Gmail historical sync finished. Imported 24 of 24 items."
        );
        assert_eq!(
            sync_completion_notification_body("notion", 8, None),
            "Notion historical sync finished. Imported 8 items."
        );
    }
}
