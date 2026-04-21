//! Build `MorningBriefCandidate` objects (see `hifi/amc-pipeline/src/schemas.js`)
//! from local data sources so the Node AMC pipeline can compose real
//! Morning Brief items instead of running on its bundled fixture.
//!
//! Phase B.2: calendar + gmail memory rows only, empty `related_kioku_hits`.
//! Related-hit enrichment and meeting/focus sources are Phase B.3.

use crate::memory_store;
use serde_json::{json, Value};

const WINDOW_MS: u64 = 3 * 86_400_000; // 3 days
const CALENDAR_LIMIT: usize = 8;
const GMAIL_LIMIT: usize = 6;
const TOTAL_CAP: usize = 20;

fn strip_title_prefix<'a>(title: &'a str, prefix: &str) -> &'a str {
  title.strip_prefix(prefix).unwrap_or(title)
}

/// Heuristic: pull an ISO-ish datetime token out of the calendar
/// memory snippet (`google_calendar` rows are ingested with
/// `Google Calendar · {start} · {link}`).
pub(crate) fn extract_calendar_start(snippet: &str) -> Option<String> {
  for tok in snippet.split('·') {
    let t = tok.trim();
    let bytes = t.as_bytes();
    if bytes.len() >= 10
      && bytes[4] == b'-'
      && bytes[7] == b'-'
      && bytes[0..4].iter().all(|b| b.is_ascii_digit())
    {
      return Some(t.to_string());
    }
  }
  None
}

/// Pure: map one `memory_store` row into a `MorningBriefCandidate`
/// JSON value. Returns `None` for sources we don't know how to
/// normalise yet (capture, telemetry, ...).
pub fn memory_row_to_candidate(row: &Value) -> Option<Value> {
  let id = row.get("id").and_then(|v| v.as_str())?;
  let title = row.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = row.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
  let source = row.get("source").and_then(|v| v.as_str())?;

  let (trigger, raw_data) = match source {
    "google_calendar" => {
      let clean = strip_title_prefix(title, "Calendar: ").to_string();
      let start = extract_calendar_start(snippet).unwrap_or_default();
      (
        "calendar",
        json!({
          "calendar_event": {
            "id": id,
            "title": clean,
            "start": start,
          }
        }),
      )
    }
    "gmail" => {
      let clean = strip_title_prefix(title, "Gmail: ").to_string();
      (
        "email",
        json!({
          "email_thread": {
            "subject": clean,
          }
        }),
      )
    }
    _ => return None,
  };

  Some(json!({
    "candidate_id": id,
    "trigger_source": trigger,
    "raw_data": raw_data,
    "related_kioku_hits": [],
    "decision_graph_hits": [],
    "available_mcp_tools": [
      "shogun.open_pack",
      "shogun.start_focus_session",
      "shogun.draft_reply",
    ],
  }))
}

/// Gather candidates from local sources. Returns an empty vec on any
/// read error so the caller (brief orchestration) can cleanly fall
/// back to the bundled fixture.
pub fn build_candidates() -> Vec<Value> {
  let since = memory_store::now_ms().saturating_sub(WINDOW_MS);
  let mut out: Vec<Value> = Vec::new();
  if let Ok(cal) = memory_store::recent_by_source("google_calendar", since, CALENDAR_LIMIT) {
    for row in cal {
      if let Some(c) = memory_row_to_candidate(&row) {
        out.push(c);
      }
    }
  }
  if let Ok(mail) = memory_store::recent_by_source("gmail", since, GMAIL_LIMIT) {
    for row in mail {
      if let Some(c) = memory_row_to_candidate(&row) {
        out.push(c);
      }
    }
  }
  out.truncate(TOTAL_CAP);
  out
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn extracts_iso_start_from_calendar_snippet() {
    let s = "Google Calendar · 2026-04-22T10:00:00+09:00 · https://cal.example";
    assert_eq!(
      extract_calendar_start(s),
      Some("2026-04-22T10:00:00+09:00".into())
    );
  }

  #[test]
  fn returns_none_for_snippets_without_iso() {
    let s = "Google Calendar · no date here · https://x";
    assert!(extract_calendar_start(s).is_none());
  }

  #[test]
  fn calendar_row_becomes_calendar_candidate() {
    let row = json!({
      "id": "m_100",
      "title": "Calendar: Investor MTG",
      "snippet": "Google Calendar · 2026-04-22T10:00:00+09:00 · https://cal.example",
      "source": "google_calendar",
      "kinds": ["calendar"],
      "created_at": 100u64,
    });
    let c = memory_row_to_candidate(&row).expect("candidate");
    assert_eq!(c["candidate_id"].as_str(), Some("m_100"));
    assert_eq!(c["trigger_source"].as_str(), Some("calendar"));
    let ev = &c["raw_data"]["calendar_event"];
    assert_eq!(ev["title"].as_str(), Some("Investor MTG"));
    assert_eq!(ev["start"].as_str(), Some("2026-04-22T10:00:00+09:00"));
    assert_eq!(c["related_kioku_hits"].as_array().unwrap().len(), 0);
    assert!(c["available_mcp_tools"]
      .as_array()
      .unwrap()
      .iter()
      .any(|v| v.as_str() == Some("shogun.open_pack")));
  }

  #[test]
  fn gmail_row_becomes_email_candidate() {
    let row = json!({
      "id": "m_200",
      "title": "Gmail: Invoice from XYZ",
      "snippet": "body preview",
      "source": "gmail",
      "kinds": ["email"],
      "created_at": 200u64,
    });
    let c = memory_row_to_candidate(&row).expect("candidate");
    assert_eq!(c["trigger_source"].as_str(), Some("email"));
    assert_eq!(
      c["raw_data"]["email_thread"]["subject"].as_str(),
      Some("Invoice from XYZ")
    );
  }

  #[test]
  fn unsupported_source_returns_none() {
    let row = json!({
      "id": "m_300",
      "title": "Focus · Safari",
      "snippet": "",
      "source": "capture_sampler",
      "kinds": ["screen"],
      "created_at": 300u64,
    });
    assert!(memory_row_to_candidate(&row).is_none());
  }

  #[test]
  fn missing_id_or_source_rejects_row() {
    assert!(memory_row_to_candidate(&json!({ "title": "x" })).is_none());
    assert!(memory_row_to_candidate(&json!({ "id": "m_x", "title": "x" })).is_none());
  }

  #[test]
  fn calendar_title_without_prefix_is_preserved() {
    let row = json!({
      "id": "m_101",
      "title": "Quarterly planning",
      "snippet": "Google Calendar · 2026-04-22T09:00:00Z · x",
      "source": "google_calendar",
    });
    let c = memory_row_to_candidate(&row).unwrap();
    assert_eq!(
      c["raw_data"]["calendar_event"]["title"].as_str(),
      Some("Quarterly planning")
    );
  }

  #[test]
  fn calendar_with_no_start_still_produces_candidate() {
    let row = json!({
      "id": "m_102",
      "title": "Calendar: No-date event",
      "snippet": "Google Calendar · TBD · https://x",
      "source": "google_calendar",
    });
    let c = memory_row_to_candidate(&row).unwrap();
    assert_eq!(c["raw_data"]["calendar_event"]["start"].as_str(), Some(""));
  }
}
