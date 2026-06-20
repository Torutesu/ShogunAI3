//! Frontmost application snapshot on macOS.
//!
//! The sampler and meeting detector both need the same "what is currently
//! frontmost?" answer. Taking one snapshot for app name, bundle id, and
//! window title keeps those fields aligned. AppKit gives us the app identity
//! directly; AX gives us the window title when accessibility is available,
//! with System Events as a fallback.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmostFocus {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub window_title: Option<String>,
    pub window_title_source: Option<String>,
}

fn normalize_app_name(app_name: String, bundle_id: Option<&str>) -> String {
    let trimmed = app_name.trim();
    if trimmed.eq_ignore_ascii_case("app") && bundle_id == Some("ai.shogun.desktop") {
        return "Shogun AI".to_string();
    }
    trimmed.to_string()
}

fn parse_frontmost_focus_snapshot(raw: &str) -> Option<FrontmostFocus> {
    let mut parts = raw.split('\u{1f}');
    let app_name = parts.next()?.trim().to_string();
    if app_name.is_empty() {
        return None;
    }
    let bundle_id = parts.next().map(str::trim).and_then(|s| {
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    });
    let window_title = parts.next().map(str::trim).and_then(|s| {
        if s.is_empty() {
            None
        } else {
            Some(s.to_string())
        }
    });
    let app_name = normalize_app_name(app_name, bundle_id.as_deref());
    Some(FrontmostFocus {
        app_name,
        bundle_id,
        window_title,
        window_title_source: Some("system_events".to_string()),
    })
}

#[cfg(target_os = "macos")]
fn frontmost_window_title_from_system_events() -> Option<String> {
    use std::process::Command;

    let script = r#"tell application "System Events"
  tell first application process whose frontmost is true
    set winTitle to ""
    try
      set winTitle to title of front window
    end try
    return winTitle
  end tell
end tell"#;
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        None
    } else {
        Some(raw)
    }
}

#[cfg(target_os = "macos")]
fn frontmost_window_title() -> (Option<String>, Option<&'static str>) {
    if let Some(title) = crate::macos_ax::focused_window_title() {
        return (Some(title), Some("ax"));
    }
    if let Some(title) = frontmost_window_title_from_system_events() {
        return (Some(title), Some("system_events"));
    }
    (None, None)
}

#[cfg(target_os = "macos")]
fn frontmost_focus_from_appkit() -> Option<FrontmostFocus> {
    use objc2_app_kit::NSWorkspace;

    let workspace = NSWorkspace::sharedWorkspace();
    let app = workspace.frontmostApplication()?;
    let app_name = app
        .localizedName()
        .map(|name| name.to_string())
        .filter(|name| !name.trim().is_empty())?;
    let bundle_id = app
        .bundleIdentifier()
        .map(|bundle| bundle.to_string())
        .filter(|bundle| !bundle.trim().is_empty());
    let (window_title, window_title_source) = frontmost_window_title();
    Some(FrontmostFocus {
        app_name: normalize_app_name(app_name, bundle_id.as_deref()),
        bundle_id,
        window_title,
        window_title_source: window_title_source.map(str::to_string),
    })
}

#[cfg(target_os = "macos")]
fn frontmost_focus_from_system_events() -> Option<FrontmostFocus> {
    use std::process::Command;

    let script = r#"tell application "System Events"
  tell first application process whose frontmost is true
    set appName to name
    set bundleId to bundle identifier
    set winTitle to ""
    try
      set winTitle to title of front window
    end try
    return appName & ASCII character 31 & bundleId & ASCII character 31 & winTitle
  end tell
end tell"#;
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    parse_frontmost_focus_snapshot(&raw)
}

#[cfg(target_os = "macos")]
pub fn frontmost_focus_snapshot() -> Option<FrontmostFocus> {
    frontmost_focus_from_appkit().or_else(frontmost_focus_from_system_events)
}

#[cfg(not(target_os = "macos"))]
pub fn frontmost_focus_snapshot() -> Option<FrontmostFocus> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_frontmost_focus_snapshot_reads_tabular_payload() {
        let raw = "Safari\u{1f}com.apple.Safari\u{1f}Inbox";
        let parsed = parse_frontmost_focus_snapshot(raw).expect("parsed");
        assert_eq!(parsed.app_name, "Safari");
        assert_eq!(parsed.bundle_id.as_deref(), Some("com.apple.Safari"));
        assert_eq!(parsed.window_title.as_deref(), Some("Inbox"));
        assert_eq!(parsed.window_title_source.as_deref(), Some("system_events"));
    }

    #[test]
    fn parse_frontmost_focus_snapshot_tolerates_missing_optional_fields() {
        let parsed = parse_frontmost_focus_snapshot("Finder\u{1f}\u{1f}").expect("parsed");
        assert_eq!(parsed.app_name, "Finder");
        assert_eq!(parsed.bundle_id, None);
        assert_eq!(parsed.window_title, None);
        assert_eq!(parsed.window_title_source.as_deref(), Some("system_events"));
    }

    #[test]
    fn parse_frontmost_focus_snapshot_normalizes_shogun_dev_app_name() {
        let parsed = parse_frontmost_focus_snapshot("app\u{1f}ai.shogun.desktop\u{1f}Inbox")
            .expect("parsed");
        assert_eq!(parsed.app_name, "Shogun AI");
        assert_eq!(parsed.bundle_id.as_deref(), Some("ai.shogun.desktop"));
        assert_eq!(parsed.window_title.as_deref(), Some("Inbox"));
        assert_eq!(parsed.window_title_source.as_deref(), Some("system_events"));
    }
}
