//! In-memory live transcript + session pointer (final segments persist via `meeting_store` on stop).

use serde_json::Value;
use std::sync::Mutex;

pub struct MeetingSessionState {
  inner: Mutex<Option<ActiveMeeting>>,
}

impl Default for MeetingSessionState {
  fn default() -> Self {
    Self {
      inner: Mutex::new(None),
    }
  }
}

#[allow(dead_code)]
pub struct ActiveMeeting {
  pub id: String,
  pub started_at_ms: u64,
  pub template_id: Option<String>,
  pub app_bundle_id: Option<String>,
  pub title: String,
  /// Partial + final segments for `shogun_meeting_transcript_live`
  pub live: Vec<Value>,
  pub last_activity_ms: u64,
  pub last_video_seen_ms: u64,
}

impl MeetingSessionState {
  pub fn start(&self, mut m: ActiveMeeting) -> Result<(), String> {
    let now = crate::memory_store::now_ms();
    if m.last_activity_ms == 0 {
      m.last_activity_ms = now;
    }
    if m.last_video_seen_ms == 0 {
      m.last_video_seen_ms = now;
    }
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    if g.is_some() {
      return Err("A meeting is already active".to_string());
    }
    *g = Some(m);
    Ok(())
  }

  #[allow(dead_code)]
  pub fn active_id(&self) -> Result<Option<String>, String> {
    let g = self.inner.lock().map_err(|e| e.to_string())?;
    Ok(g.as_ref().map(|m| m.id.clone()))
  }

  pub fn push_live_segment(&self, meeting_id: &str, seg: Value) -> Result<(), String> {
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    let Some(m) = g.as_mut() else {
      return Err("No active meeting".to_string());
    };
    if m.id != meeting_id {
      return Err("meeting_id does not match active session".to_string());
    }
    m.live.push(seg);
    m.last_activity_ms = crate::memory_store::now_ms();
    Ok(())
  }

  pub fn touch_activity(&self, meeting_id: &str) -> Result<(), String> {
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    let Some(m) = g.as_mut() else {
      return Ok(());
    };
    if m.id == meeting_id {
      m.last_activity_ms = crate::memory_store::now_ms();
    }
    Ok(())
  }

  pub fn touch_video_seen(&self, meeting_id: &str) -> Result<(), String> {
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    let Some(m) = g.as_mut() else {
      return Ok(());
    };
    if m.id == meeting_id {
      m.last_video_seen_ms = crate::memory_store::now_ms();
    }
    Ok(())
  }

  pub fn activity_idle_ms(&self, meeting_id: &str) -> Result<u64, String> {
    let g = self.inner.lock().map_err(|e| e.to_string())?;
    let now = crate::memory_store::now_ms();
    Ok(
      g.as_ref()
        .filter(|m| m.id == meeting_id)
        .map(|m| now.saturating_sub(m.last_activity_ms))
        .unwrap_or(0),
    )
  }

  pub fn video_idle_ms(&self, meeting_id: &str) -> Result<u64, String> {
    let g = self.inner.lock().map_err(|e| e.to_string())?;
    let now = crate::memory_store::now_ms();
    Ok(
      g.as_ref()
        .filter(|m| m.id == meeting_id)
        .map(|m| now.saturating_sub(m.last_video_seen_ms))
        .unwrap_or(0),
    )
  }

  pub fn is_video_provider_meeting(&self, meeting_id: &str) -> Result<bool, String> {
    let g = self.inner.lock().map_err(|e| e.to_string())?;
    Ok(
      g.as_ref()
        .filter(|m| m.id == meeting_id)
        .map(|m| {
          matches!(
            m.app_bundle_id.as_deref(),
            Some("google_meet") | Some("zoom")
          )
        })
        .unwrap_or(false),
    )
  }

  #[allow(dead_code)]
  pub fn clear_live(&self, meeting_id: &str) -> Result<(), String> {
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    if let Some(m) = g.as_mut() {
      if m.id == meeting_id {
        m.live.clear();
      }
    }
    Ok(())
  }

  pub fn take_active(&self) -> Result<Option<ActiveMeeting>, String> {
    let mut g = self.inner.lock().map_err(|e| e.to_string())?;
    Ok(g.take())
  }

  pub fn live_snapshot(&self, meeting_id: &str) -> Result<Vec<Value>, String> {
    let g = self.inner.lock().map_err(|e| e.to_string())?;
    Ok(
      g.as_ref()
        .filter(|m| m.id == meeting_id)
        .map(|m| m.live.clone())
        .unwrap_or_default(),
    )
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn touch_activity_resets_idle() {
    let state = MeetingSessionState::default();
    let started = crate::memory_store::now_ms();
    state
      .start(ActiveMeeting {
        id: "m1".to_string(),
        started_at_ms: started,
        template_id: None,
        app_bundle_id: Some("google_meet".to_string()),
        title: "Test".to_string(),
        live: Vec::new(),
        last_activity_ms: started.saturating_sub(120_000),
        last_video_seen_ms: started,
      })
      .unwrap();
    assert!(state.activity_idle_ms("m1").unwrap() >= 120_000);
    state.touch_activity("m1").unwrap();
    assert_eq!(state.activity_idle_ms("m1").unwrap(), 0);
  }
}
