//! Screen-context snapshot for the in-app Hummingbird overlay.

use crate::{app_events, macos_ax, settings_store};
use serde_json::{json, Value};
use tauri::AppHandle;

pub fn register_app(app: AppHandle) {
  app_events::init(&app);
}

pub fn emit_open(source: &str) {
  app_events::emit_hummingbird_open(source);
}

fn hummingbird_enabled_in_settings() -> bool {
  let doc = settings_store::load().unwrap_or_else(|_| json!({}));
  doc
    .pointer("/sections/hummingbird/enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(true)
}

/// Called from the macOS input tap when Option is double-tapped globally.
pub fn on_global_option_double_tap() {
  if !hummingbird_enabled_in_settings() {
    return;
  }
  let doc = settings_store::load().unwrap_or_else(|_| json!({}));
  let shortcut = doc
    .pointer("/sections/hummingbird/globalShortcut")
    .and_then(|v| v.as_str())
    .unwrap_or("option_double_tap");
  if shortcut != "option_double_tap" {
    return;
  }
  emit_open("global_hotkey");
}

#[cfg(target_os = "macos")]
fn frontmost_app_name() -> Option<String> {
  let script = r#"tell application "System Events" to get name of first application process whose frontmost is true"#;
  std::process::Command::new("osascript")
    .args(["-e", script])
    .output()
    .ok()
    .and_then(|o| {
      if o.status.success() {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if s.is_empty() {
          None
        } else {
          Some(s)
        }
      } else {
        None
      }
    })
}

pub fn capture_context() -> Value {
  let doc = settings_store::load().unwrap_or_else(|_| json!({}));
  let hb = doc.pointer("/sections/hummingbird");
  let mode = hb
    .and_then(|h| h.get("mode"))
    .and_then(|v| v.as_str())
    .unwrap_or("any_app");
  let enabled = hb
    .and_then(|h| h.get("enabled"))
    .and_then(|v| v.as_bool())
    .unwrap_or(true);

  #[cfg(target_os = "macos")]
  {
    let app = frontmost_app_name().unwrap_or_else(|| "unknown".to_string());
    let ax = macos_ax::focused_ax_snapshot()
      .or_else(|| macos_ax::focused_ax_tree(2, 24, 2_000))
      .unwrap_or_default();
    let ax_clip: String = ax.chars().take(4_000).collect();
    return json!({
      "enabled": enabled,
      "mode": mode,
      "frontmostApp": app,
      "axSnapshot": ax_clip,
      "stub": false,
    });
  }

  #[cfg(not(target_os = "macos"))]
  {
    json!({
      "enabled": enabled,
      "mode": mode,
      "frontmostApp": null,
      "axSnapshot": "",
      "stub": false,
      "note": "Screen context is only available on macOS.",
    })
  }
}
