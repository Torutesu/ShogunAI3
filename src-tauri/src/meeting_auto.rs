//! Auto-start a backend meeting session when a video call (Meet/Zoom) is detected
//! from screen capture. Respects `sections.meetings.autoStartOnVideoDetect`.

use crate::{
  meeting_mic, meeting_session, meeting_store, meeting_stt, memory_store, settings_store,
};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

pub fn auto_start_on_video_detect_enabled() -> bool {
  settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/meetings/autoStartOnVideoDetect")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
}

pub fn auto_start_mic_enabled() -> bool {
  settings_store::load()
    .ok()
    .and_then(|doc| {
      doc
        .pointer("/sections/meetings/autoStartMicOnVideoDetect")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
}

fn provider_label(provider: &str) -> &str {
  match provider {
    "google_meet" => "Google Meet",
    "zoom" => "Zoom",
    _ => "Video call",
  }
}

/// Start a backend meeting + optional mic capture when a video URL is detected.
/// Returns the new meeting id when a session was created.
pub fn try_start_from_video_detect(
  app: &AppHandle,
  provider: &str,
  url: &str,
  app_label: &str,
) -> Option<String> {
  if !auto_start_on_video_detect_enabled() {
    return None;
  }

  let session = app.try_state::<meeting_session::MeetingSessionState>()?;
  if session
    .active_id()
    .ok()
    .flatten()
    .is_some()
  {
    return None;
  }

  let title = format!("{} · {}", provider_label(provider), app_label.trim());
  let id = meeting_store::new_uuid();
  let started = memory_store::now_ms();

  if meeting_store::meeting_insert(
    &id,
    started,
    None,
    Some(provider),
    Some(title.trim()),
    None,
  )
  .is_err()
  {
    return None;
  }

  if session
    .start(meeting_session::ActiveMeeting {
      id: id.clone(),
      started_at_ms: started,
      template_id: None,
      app_bundle_id: Some(provider.to_string()),
      title: title.clone(),
      live: Vec::new(),
      last_activity_ms: started,
      last_video_seen_ms: started,
    })
    .is_err()
  {
    return None;
  }

  let note = format!(
    "Video meeting detected\n\nProvider: {}\nURL: {}",
    provider_label(provider),
    url.trim()
  );
  let bid = meeting_store::new_uuid();
  let _ = meeting_store::insert_note_block(&id, &bid, 0, &note, "user", &[]);

  let mut mic_started = false;
  let mut system_started = false;
  if auto_start_mic_enabled() && meeting_stt::deepgram_api_key().is_some() {
    if let Some(mic) = app.try_state::<meeting_mic::MeetingMicController>() {
      match mic.start_with(
        Some(app.clone()),
        meeting_mic::StartOptions {
          meeting_id: Some(id.clone()),
          live_stt: true,
          capture_system: true,
        },
      ) {
        Ok(v) => {
          mic_started = v.get("mic_running").and_then(|x| x.as_bool()).unwrap_or(true);
          system_started = v
            .get("system_running")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);
        }
        Err(e) => log::warn!("auto-start mic failed: {}", e),
      }
    }
  }

  let screen_capture_granted = crate::macos_permissions::screen_capture_granted();
  let payload = json!({
    "meeting_id": id,
    "provider": provider,
    "url": url,
    "title": title,
    "app": app_label,
    "mic_started": mic_started,
    "system_started": system_started,
    "screen_capture_granted": screen_capture_granted,
    "auto_started": true,
  });
  let _ = app.emit("video-meeting-started", payload.clone());
  let _ = app.emit("video-meeting-auto-started", payload);

  Some(id)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn auto_start_defaults_enabled() {
    // Without settings file in unit tests, defaults apply.
    assert!(auto_start_on_video_detect_enabled());
    assert!(auto_start_mic_enabled());
  }

  #[test]
  fn provider_label_maps_known_slugs() {
    assert_eq!(provider_label("google_meet"), "Google Meet");
    assert_eq!(provider_label("zoom"), "Zoom");
  }
}
