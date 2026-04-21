//! Bounded in-memory ring buffer for backend error events (capture, sync, etc.).
//! Surfaced via `app_diagnostics_report.recentErrors`; not persisted to disk.

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_EVENTS: usize = 50;
const MAX_MESSAGE_CHARS: usize = 500;

#[derive(Clone, Debug)]
struct BackendErrorEvent {
  at_ms: u64,
  source: &'static str,
  message: String,
}

static EVENTS: Mutex<VecDeque<BackendErrorEvent>> = Mutex::new(VecDeque::new());

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Record a backend error. `source` should be a short, static label
/// (e.g. `"capture_sampler.focus_ingest"`); `message` is truncated.
pub fn record(source: &'static str, message: impl Into<String>) {
  let raw: String = message.into();
  let truncated: String = raw.chars().take(MAX_MESSAGE_CHARS).collect();
  let event = BackendErrorEvent {
    at_ms: now_ms(),
    source,
    message: truncated,
  };
  if let Ok(mut q) = EVENTS.lock() {
    if q.len() >= MAX_EVENTS {
      q.pop_front();
    }
    q.push_back(event);
  }
}

/// Snapshot the current ring buffer as a JSON array (oldest first).
pub fn snapshot() -> Vec<Value> {
  EVENTS
    .lock()
    .map(|q| {
      q.iter()
        .map(|e| {
          json!({
            "at": e.at_ms,
            "source": e.source,
            "message": e.message,
          })
        })
        .collect()
    })
    .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn clear() {
  if let Ok(mut q) = EVENTS.lock() {
    q.clear();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The ring is a process-wide singleton; serialize tests that mutate it.
  static TEST_LOCK: Mutex<()> = Mutex::new(());

  #[test]
  fn records_and_snapshots_in_order() {
    let _g = TEST_LOCK.lock().unwrap();
    clear();
    record("test.a", "one");
    record("test.b", "two");
    let snap = snapshot();
    assert_eq!(snap.len(), 2);
    assert_eq!(snap[0]["source"].as_str(), Some("test.a"));
    assert_eq!(snap[0]["message"].as_str(), Some("one"));
    assert_eq!(snap[1]["source"].as_str(), Some("test.b"));
    assert_eq!(snap[1]["message"].as_str(), Some("two"));
    clear();
  }

  #[test]
  fn evicts_oldest_above_cap() {
    let _g = TEST_LOCK.lock().unwrap();
    clear();
    for i in 0..(MAX_EVENTS + 10) {
      record("test.cap", format!("msg-{}", i));
    }
    let snap = snapshot();
    assert_eq!(snap.len(), MAX_EVENTS);
    // Oldest retained should be index 10 (first 10 were evicted).
    assert_eq!(snap[0]["message"].as_str(), Some("msg-10"));
    assert_eq!(
      snap[MAX_EVENTS - 1]["message"].as_str(),
      Some(format!("msg-{}", MAX_EVENTS + 9)).as_deref()
    );
    clear();
  }

  #[test]
  fn truncates_long_messages_by_chars() {
    let _g = TEST_LOCK.lock().unwrap();
    clear();
    // Multibyte chars exercise char-count truncation (not byte-count).
    let long = "あ".repeat(1000);
    record("test.trunc", long);
    let snap = snapshot();
    assert_eq!(snap.len(), 1);
    let m = snap[0]["message"].as_str().unwrap();
    assert_eq!(m.chars().count(), MAX_MESSAGE_CHARS);
    clear();
  }

  #[test]
  fn empty_snapshot_after_clear() {
    let _g = TEST_LOCK.lock().unwrap();
    clear();
    record("test.clr", "x");
    clear();
    assert!(snapshot().is_empty());
  }
}
