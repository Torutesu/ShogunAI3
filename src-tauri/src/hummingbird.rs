//! Screen-context snapshot for the in-app Hummingbird overlay.

use crate::macos_frontmost::frontmost_focus_snapshot;
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
    doc.pointer("/sections/hummingbird/enabled")
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

pub(crate) fn capture_context_from_frontmost(
    _frontmost: Option<crate::macos_frontmost::FrontmostFocus>,
) -> Value {
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
        let frontmost = _frontmost.or_else(frontmost_focus_snapshot);
        let app = frontmost
            .as_ref()
            .map(|focus| focus.app_name.clone())
            .unwrap_or_else(|| "unknown".to_string());
        let mut ax_parts: Vec<String> = Vec::new();
        let mut snapshot_present = false;
        let mut tree_present = false;
        let mut window_tree_present = false;
        if let Some(snapshot) = macos_ax::focused_ax_snapshot() {
            let t = snapshot.trim();
            if !t.is_empty() {
                snapshot_present = true;
                ax_parts.push(t.to_string());
            }
        }
        if let Some(tree) = macos_ax::focused_ax_tree(2, 24, 2_000) {
            let t = tree.trim();
            if !t.is_empty() {
                tree_present = true;
                ax_parts.push(t.to_string());
            }
        }
        if !ax_parts
            .iter()
            .any(|p| macos_ax::ax_text_has_content_signal(p))
        {
            if let Some(tree) = macos_ax::focused_window_ax_tree(4, 120, 8_000) {
                let t = tree.trim();
                if !t.is_empty() {
                    window_tree_present = true;
                    ax_parts.push(t.to_string());
                }
            }
        }
        let ax = ax_parts.join("\n\n");
        let ax_source = if snapshot_present {
            if window_tree_present {
                "focused_element_plus_window_tree"
            } else {
                "focused_element"
            }
        } else if tree_present {
            if window_tree_present {
                "focused_tree_plus_window_tree"
            } else {
                "focused_tree"
            }
        } else if window_tree_present {
            "focused_window_tree"
        } else {
            "empty"
        };
        let ax_diagnostics =
            macos_ax::focused_ax_diagnostics(snapshot_present, tree_present || window_tree_present);
        let ax_text_signal_present = macos_ax::ax_text_has_content_signal(&ax);
        let ax_text_chars = ax.chars().count();
        let ax_line_count = ax.lines().filter(|line| !line.trim().is_empty()).count();
        let ax_clip: String = ax.chars().take(4_000).collect();
        return json!({
          "enabled": enabled,
          "mode": mode,
          "frontmostApp": app,
          "frontmostBundleId": frontmost.as_ref().and_then(|focus| focus.bundle_id.clone()),
          "frontmostWindowTitle": frontmost.as_ref().and_then(|focus| focus.window_title.clone()),
          "frontmostFocus": frontmost,
          "axSnapshot": ax_clip,
          "axSnapshotSource": ax_source,
          "axDiagnostics": ax_diagnostics,
          "axTextSignalPresent": ax_text_signal_present,
          "axTextChars": ax_text_chars,
          "axLineCount": ax_line_count,
          "stub": false,
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        json!({
          "enabled": enabled,
          "mode": mode,
          "frontmostApp": null,
          "frontmostBundleId": null,
          "frontmostWindowTitle": null,
          "frontmostFocus": null,
          "axSnapshot": "",
          "axSnapshotSource": "unavailable",
          "axDiagnostics": crate::macos_ax::focused_ax_diagnostics(false, false),
          "axTextSignalPresent": false,
          "axTextChars": 0,
          "axLineCount": 0,
          "stub": false,
          "note": "Screen context is only available on macOS.",
        })
    }
}

pub fn capture_context() -> Value {
    capture_context_from_frontmost(frontmost_focus_snapshot())
}
