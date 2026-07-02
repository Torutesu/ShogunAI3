//! Detect Google Meet / Zoom from the frontmost app (independent of capture ingest filters).
//! Runs on a fixed interval so meeting prompts work even when capture is paused or AX ingest
//! is blocked by privacy filters.

use crate::macos_frontmost::frontmost_focus_snapshot;
use crate::meeting_auto;
use crate::settings_store;
use serde_json::json;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

static LAST_VIDEO_EMIT: Mutex<Option<(String, u64)>> = Mutex::new(None);
const EMIT_COOLDOWN_MS: u64 = 300_000;

pub fn start_poller(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        poll_once(&app);
    });
}

pub fn poll_once(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(frontmost) = frontmost_focus_snapshot() else {
            return;
        };
        try_detect_and_emit(
            app,
            &frontmost.app_name,
            None,
            frontmost.window_title.as_deref(),
        );
        if let Some(ax) = crate::macos_ax::focused_ax_snapshot() {
            let t = ax.trim();
            if !t.is_empty() {
                try_detect_and_emit(
                    app,
                    &frontmost.app_name,
                    Some(t),
                    frontmost.window_title.as_deref(),
                );
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

fn app_detect_alerts_enabled() -> bool {
    settings_store::load()
        .ok()
        .and_then(|doc| {
            doc.pointer("/sections/meetings/appDetectAlerts")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true)
}

fn meeting_detect_notification_body(provider: &str, app_label: &str, auto_started: bool) -> String {
    let label = provider_label(provider);
    let app_name = app_label.trim();
    if auto_started {
        format!(
            "{label} detected in {app_name}. SHOGUN started a live meeting session."
        )
    } else {
        format!(
            "{label} detected in {app_name}. Open SHOGUN to capture the meeting context."
        )
    }
}

#[cfg(target_os = "macos")]
pub fn detect_video_meeting(text: &str) -> Option<(String, String)> {
    let lower = text.to_lowercase();
    if lower.contains("meet.google.com") || lower.contains("meet.google") {
        let url = extract_meeting_url(&lower, "meet.google");
        return Some(("google_meet".to_string(), url));
    }
    if lower.contains("zoom.us") || lower.contains("zoomgov.com") {
        let url = extract_meeting_url(&lower, "zoom.us");
        return Some(("zoom".to_string(), url));
    }
    None
}

#[cfg(target_os = "macos")]
fn extract_meeting_url(text: &str, needle: &str) -> String {
    for token in text.split_whitespace() {
        if token.contains(needle) {
            let trimmed = token
                .trim_matches(|c: char| {
                    !c.is_ascii_alphanumeric()
                        && c != ':'
                        && c != '/'
                        && c != '.'
                        && c != '?'
                        && c != '='
                        && c != '-'
                        && c != '_'
                })
                .to_string();
            if !trimmed.is_empty() {
                return trimmed;
            }
        }
    }
    if needle.contains("meet.google") {
        "https://meet.google.com".to_string()
    } else {
        "https://zoom.us".to_string()
    }
}

#[cfg(target_os = "macos")]
pub fn detect_video_meeting_from_app_and_title(
    app_label: &str,
    window_title: Option<&str>,
) -> Option<(String, String)> {
    let app_l = app_label.to_lowercase();
    if app_l.contains("zoom") {
        return Some(("zoom".to_string(), "https://zoom.us".to_string()));
    }
    if is_browser_app(&app_l) {
        if let Some(title) = window_title {
            if detect_meet_in_title(title) {
                return Some((
                    "google_meet".to_string(),
                    "https://meet.google.com".to_string(),
                ));
            }
            if detect_zoom_in_title(title) {
                return Some(("zoom".to_string(), "https://zoom.us".to_string()));
            }
        }
    }
    if let Some(title) = window_title {
        let t = title.to_lowercase();
        if t.contains("meet.google") || t.contains("google meet") {
            return Some((
                "google_meet".to_string(),
                "https://meet.google.com".to_string(),
            ));
        }
        if detect_zoom_in_title(title) {
            return Some(("zoom".to_string(), "https://zoom.us".to_string()));
        }
        if detect_meet_in_title(title) {
            return Some((
                "google_meet".to_string(),
                "https://meet.google.com".to_string(),
            ));
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn is_browser_app(app_l: &str) -> bool {
    app_l.contains("chrome")
        || app_l.contains("safari")
        || app_l.contains("firefox")
        || app_l.contains("edge")
        || app_l.contains("arc")
        || app_l.contains("brave")
        || app_l.contains("opera")
}

#[cfg(target_os = "macos")]
fn detect_meet_in_title(title: &str) -> bool {
    let t = title.to_lowercase();
    t.starts_with("meet -")
        || t.starts_with("meet —")
        || t.contains(" - google meet")
        || t.ends_with("google meet")
        || t.contains("meet.google.com")
}

#[cfg(target_os = "macos")]
fn detect_zoom_in_title(title: &str) -> bool {
    let t = title.to_lowercase();
    t.contains("zoom meeting")
        || t.contains("zoom -")
        || t.starts_with("zoom ")
        || t.contains("zoom.us")
}

#[cfg(target_os = "macos")]
fn try_detect_and_emit(
    app: &AppHandle,
    app_label: &str,
    ax_text: Option<&str>,
    window_title_hint: Option<&str>,
) {
    let (provider, url) = if let Some(text) = ax_text {
        if let Some(found) = detect_video_meeting(text) {
            found
        } else {
            let Some(found) = detect_video_meeting_from_app_and_title(app_label, window_title_hint)
            else {
                return;
            };
            found
        }
    } else {
        let Some(found) = detect_video_meeting_from_app_and_title(app_label, window_title_hint)
        else {
            return;
        };
        found
    };

    if let Some(session) = app.try_state::<crate::meeting_session::MeetingSessionState>() {
        if session.active_id().ok().flatten().is_some() {
            return;
        }
    }

    let now = now_ms();
    if let Ok(mut guard) = LAST_VIDEO_EMIT.lock() {
        if let Some((prev_provider, prev_ms)) = guard.as_ref() {
            if prev_provider == &provider && now.saturating_sub(*prev_ms) < EMIT_COOLDOWN_MS {
                return;
            }
        }
        *guard = Some((provider.clone(), now));
    }

    let meeting_id = meeting_auto::try_start_from_video_detect(app, &provider, &url, app_label);
    crate::meeting_lifecycle::touch_video_activity(app);

    let title = if meeting_id.is_some() {
        format!("{} · {}", provider_label(&provider), app_label.trim())
    } else {
        format!("{} · {}", provider_label(&provider), app_label.trim())
    };

    log::info!(
        "meeting_video_detect: {} detected (app={}, url={}, meeting_id={:?})",
        provider,
        app_label,
        url,
        meeting_id
    );

    if app_detect_alerts_enabled() {
        let body = meeting_detect_notification_body(&provider, app_label, meeting_id.is_some());
        crate::app_events::notify_native("Meeting App Detected", &body);
    }

    let _ = app.emit(
        "video-meeting-started",
        json!({
          "provider": provider,
          "url": url,
          "title": title,
          "app": app_label,
          "meeting_id": meeting_id,
          "auto_started": meeting_id.is_some(),
        }),
    );
}

fn provider_label(provider: &str) -> &str {
    match provider {
        "google_meet" => "Google Meet",
        "zoom" => "Zoom",
        _ => "Video call",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings_store::{save_patch, TestSettingsGuard};

    #[test]
    fn detect_zoom_from_app_name() {
        let found = detect_video_meeting_from_app_and_title("zoom.us", None);
        assert_eq!(found.as_ref().map(|x| x.0.as_str()), Some("zoom"));
    }

    #[test]
    fn detect_meet_from_chrome_title() {
        let found =
            detect_video_meeting_from_app_and_title("Google Chrome", Some("Meet - abc-defg-hij"));
        assert_eq!(found.as_ref().map(|x| x.0.as_str()), Some("google_meet"));
    }

    #[test]
    fn detect_meet_from_ax_url() {
        let found = detect_video_meeting("Join meet.google.com/abc-defg-hij");
        assert_eq!(found.as_ref().map(|x| x.0.as_str()), Some("google_meet"));
    }

    #[test]
    fn app_detect_alerts_respects_settings() {
        let _guard = TestSettingsGuard::new("meeting-video-detect-alerts");
        assert!(app_detect_alerts_enabled());
        save_patch(&json!({
          "section": "meetings",
          "appDetectAlerts": false
        }))
        .expect("save meetings settings");
        assert!(!app_detect_alerts_enabled());
    }

    #[test]
    fn meeting_detect_notification_body_matches_auto_start_state() {
        assert_eq!(
            meeting_detect_notification_body("google_meet", "Google Chrome", true),
            "Google Meet detected in Google Chrome. SHOGUN started a live meeting session."
        );
        assert_eq!(
            meeting_detect_notification_body("zoom", "Arc", false),
            "Zoom detected in Arc. Open SHOGUN to capture the meeting context."
        );
    }
}
