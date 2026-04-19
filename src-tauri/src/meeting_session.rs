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
}

impl MeetingSessionState {
  pub fn start(&self, m: ActiveMeeting) -> Result<(), String> {
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
    Ok(())
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
