//! Unified meeting context timeline — transcript segments + screen captures on one axis.

use crate::{meeting_session, meeting_store, memory_store};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn format_offset_ms(ms: u64) -> String {
  let total_secs = ms / 1000;
  let m = (total_secs / 60) % 60;
  let s = total_secs % 60;
  let h = total_secs / 3600;
  if h > 0 {
    format!("{h:02}:{m:02}:{s:02}")
  } else {
    format!("{m:02}:{s:02}")
  }
}

pub fn build_context_timeline(
  app: Option<&AppHandle>,
  meeting_id: &str,
  include_live: bool,
  limit: usize,
) -> Result<Value, String> {
  let detail = meeting_store::get_meeting_detail(meeting_id)?
    .ok_or_else(|| "meeting not found".to_string())?;
  let started_at = detail
    .get("started_at")
    .and_then(|v| v.as_u64())
    .unwrap_or(0);
  let title = detail
    .get("title")
    .and_then(|v| v.as_str())
    .unwrap_or("Meeting");

  let mut items: Vec<Value> = Vec::new();

  for seg in meeting_store::list_transcript_final(meeting_id)? {
    let start_ms = seg.get("start_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    let speaker = seg
      .get("speaker")
      .and_then(|v| v.as_str())
      .unwrap_or("Speaker");
    let text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
    if text.is_empty() {
      continue;
    }
    items.push(json!({
      "kind": "transcript",
      "offset_ms": start_ms,
      "offset_label": format_offset_ms(start_ms),
      "timestamp_ms": started_at.saturating_add(start_ms),
      "speaker": speaker,
      "title": format!("{} · {}", speaker, format_offset_ms(start_ms)),
      "text": text,
    }));
  }

  if include_live {
    if let Some(handle) = app {
      if let Some(state) = handle.try_state::<meeting_session::MeetingSessionState>() {
        if let Ok(live) = state.live_snapshot(meeting_id) {
          for seg in live {
            let start_ms = seg.get("start_ms").and_then(|v| v.as_u64()).unwrap_or(0);
            let speaker = seg
              .get("speaker")
              .and_then(|v| v.as_str())
              .unwrap_or("Speaker");
            let text = seg.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            if text.is_empty() {
              continue;
            }
            items.push(json!({
              "kind": "transcript",
              "live": true,
              "offset_ms": start_ms,
              "offset_label": format_offset_ms(start_ms),
              "timestamp_ms": started_at.saturating_add(start_ms),
              "speaker": speaker,
              "title": format!("{} · {}", speaker, format_offset_ms(start_ms)),
              "text": text,
            }));
          }
        }
      }
    }
  }

  for cap in memory_store::list_meeting_capture_rows(meeting_id, limit)? {
    let offset_ms = cap
      .get("meeting_offset_ms")
      .and_then(|v| v.as_u64())
      .unwrap_or_else(|| {
        cap.get("created_at")
          .and_then(|v| v.as_u64())
          .map(|ts| ts.saturating_sub(started_at))
          .unwrap_or(0)
      });
    let snippet = cap
      .get("snippet")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .chars()
      .take(400)
      .collect::<String>();
    let cap_title = cap
      .get("title")
      .and_then(|v| v.as_str())
      .unwrap_or("Screen");
    items.push(json!({
      "kind": "capture",
      "offset_ms": offset_ms,
      "offset_label": format_offset_ms(offset_ms),
      "timestamp_ms": started_at.saturating_add(offset_ms),
      "source": cap.get("source").cloned().unwrap_or(json!("capture")),
      "memory_id": cap.get("id"),
      "title": cap_title,
      "text": snippet,
    }));
  }

  items.sort_by(|a, b| {
    let oa = a.get("offset_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    let ob = b.get("offset_ms").and_then(|v| v.as_u64()).unwrap_or(0);
    oa.cmp(&ob)
  });
  let total = items.len();
  items.truncate(limit);

  Ok(json!({
    "meeting_id": meeting_id,
    "title": title,
    "started_at": started_at,
    "items": items,
    "total": total,
    "stub": false,
  }))
}
