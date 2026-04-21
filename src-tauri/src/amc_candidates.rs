//! Build `MorningBriefCandidate` objects (see `hifi/amc-pipeline/src/schemas.js`)
//! from local data sources so the Node AMC pipeline can compose real
//! Morning Brief items instead of running on its bundled fixture.
//!
//! Phase B.3 sources: `google_calendar` + `gmail` memory rows, plus
//! recent rows from `meeting_store`. Each candidate is enriched with up
//! to three `related_kioku_hits` from a local FTS5 search over the
//! candidate's title (synthetic relevance scores: 0.95 / 0.80 / 0.65).

use crate::{meeting_store, memory_store};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

const WINDOW_MS: u64 = 3 * 86_400_000; // 3 days
const CALENDAR_LIMIT: usize = 8;
const GMAIL_LIMIT: usize = 6;
const MEETING_LIMIT: usize = 6;
const TOTAL_CAP: usize = 20;
const RELATED_LIMIT: usize = 3;

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

fn epoch_ms_to_rfc3339(ms: u64) -> Option<String> {
  if ms == 0 {
    return None;
  }
  DateTime::<Utc>::from_timestamp_millis(ms as i64)
    .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn epoch_ms_to_ymd(ms: u64) -> Option<String> {
  if ms == 0 {
    return None;
  }
  DateTime::<Utc>::from_timestamp_millis(ms as i64).map(|dt| dt.format("%Y-%m-%d").to_string())
}

/// Pure: synthetic relevance score for a memory hit at zero-indexed `rank`.
/// Memory_store search does not surface a scalar score; we approximate
/// with a monotonically decreasing curve so the pipeline's downstream
/// "drop below 0.5" filter still keeps the top three.
pub(crate) fn synthetic_relevance(rank: usize) -> f64 {
  match rank {
    0 => 0.95,
    1 => 0.80,
    2 => 0.65,
    _ => 0.50,
  }
}

/// Pure: convert one memory_store search hit into a `KiokuHit` value
/// (see `KiokuHitSchema` in the pipeline).
pub(crate) fn memory_hit_to_kioku_hit(hit: &Value, rank: usize) -> Value {
  let id = hit.get("id").and_then(|v| v.as_str()).unwrap_or("");
  let title = hit.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let snippet = hit.get("snippet").and_then(|v| v.as_str()).unwrap_or("");
  let last_touched = hit
    .get("created_at")
    .and_then(|v| v.as_u64())
    .and_then(epoch_ms_to_ymd)
    .unwrap_or_default();
  json!({
    "doc_id": id,
    "title": title,
    "snippet": snippet,
    "last_touched": last_touched,
    "relevance_score": synthetic_relevance(rank),
  })
}

/// Pure: replace `related_kioku_hits` on the candidate with up to
/// `RELATED_LIMIT` mapped hits, skipping any hit whose `id` matches
/// the candidate's own memory row id (avoids self-reference for
/// memory-derived candidates).
pub(crate) fn attach_related_hits(candidate: &mut Value, hits: &[Value]) {
  let self_id = candidate
    .get("candidate_id")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let mapped: Vec<Value> = hits
    .iter()
    .filter(|h| {
      h.get("id")
        .and_then(|v| v.as_str())
        .map(|s| s != self_id)
        .unwrap_or(true)
    })
    .take(RELATED_LIMIT)
    .enumerate()
    .map(|(i, h)| memory_hit_to_kioku_hit(h, i))
    .collect();
  candidate["related_kioku_hits"] = json!(mapped);
}

/// Pure: text used as the FTS5 query when looking up related hits.
/// Falls back to the candidate id if no human title is present.
pub(crate) fn candidate_query_text(candidate: &Value) -> String {
  if let Some(t) = candidate
    .pointer("/raw_data/calendar_event/title")
    .and_then(|v| v.as_str())
  {
    return t.to_string();
  }
  if let Some(t) = candidate
    .pointer("/raw_data/email_thread/subject")
    .and_then(|v| v.as_str())
  {
    return t.to_string();
  }
  candidate
    .get("candidate_id")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string()
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

/// Pure: map one `meeting_store::list_meetings` row into a
/// `MorningBriefCandidate`. Treats meetings as `calendar` triggers
/// (the pipeline has no dedicated meeting bucket; meetings ARE
/// calendar entries in practice). `started_at` / `ended_at` are
/// converted from epoch ms to RFC3339 UTC.
pub fn meeting_row_to_candidate(meeting: &Value) -> Option<Value> {
  let id = meeting.get("id").and_then(|v| v.as_str())?;
  let title = meeting
    .get("title")
    .and_then(|v| v.as_str())
    .unwrap_or("Meeting");
  let started_at_ms = meeting
    .get("started_at")
    .and_then(|v| v.as_u64())
    .unwrap_or(0);
  let start = epoch_ms_to_rfc3339(started_at_ms).unwrap_or_default();
  let end = meeting
    .get("ended_at")
    .and_then(|v| v.as_u64())
    .and_then(epoch_ms_to_rfc3339);

  let mut event = json!({
    "id": id,
    "title": title,
    "start": start,
  });
  if let Some(e) = end {
    event["end"] = json!(e);
  }

  Some(json!({
    "candidate_id": format!("meeting_{}", id),
    "trigger_source": "calendar",
    "raw_data": { "calendar_event": event },
    "related_kioku_hits": [],
    "decision_graph_hits": [],
    "available_mcp_tools": [
      "shogun.open_pack",
      "shogun.start_focus_session",
      "shogun.draft_reply",
    ],
  }))
}

fn enrich_with_related_hits(out: &mut [Value]) {
  for cand in out.iter_mut() {
    let q = candidate_query_text(cand);
    if q.trim().is_empty() {
      continue;
    }
    let payload = json!({ "query": q, "limit": (RELATED_LIMIT as u64) + 3 });
    let Ok(resp) = memory_store::search(&payload) else {
      continue;
    };
    if let Some(hits) = resp.get("hits").and_then(|v| v.as_array()) {
      attach_related_hits(cand, hits);
    }
  }
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
  if let Ok(meetings) = meeting_store::list_meetings(Some(since), None, MEETING_LIMIT) {
    for m in meetings {
      if let Some(c) = meeting_row_to_candidate(&m) {
        out.push(c);
      }
    }
  }
  out.truncate(TOTAL_CAP);
  enrich_with_related_hits(&mut out);
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

  // ---- meeting_row_to_candidate ----

  #[test]
  fn meeting_with_full_window_becomes_candidate() {
    // 1_776_900_225_000 ms == 2026-04-22T23:23:45Z;
    // 1_776_903_825_000 ms == 2026-04-23T00:23:45Z (start + 1h).
    let m = json!({
      "id": "mtg_42",
      "title": "Q2 review",
      "started_at": 1_776_900_225_000u64,
      "ended_at": 1_776_903_825_000u64,
      "state": "active",
    });
    let c = meeting_row_to_candidate(&m).expect("candidate");
    assert_eq!(c["candidate_id"].as_str(), Some("meeting_mtg_42"));
    assert_eq!(c["trigger_source"].as_str(), Some("calendar"));
    let ev = &c["raw_data"]["calendar_event"];
    assert_eq!(ev["id"].as_str(), Some("mtg_42"));
    assert_eq!(ev["title"].as_str(), Some("Q2 review"));
    assert_eq!(ev["start"].as_str(), Some("2026-04-22T23:23:45Z"));
    assert_eq!(ev["end"].as_str(), Some("2026-04-23T00:23:45Z"));
  }

  #[test]
  fn meeting_without_ended_at_omits_end() {
    let m = json!({
      "id": "mtg_99",
      "title": "Open standup",
      "started_at": 1_776_900_225_000u64,
    });
    let c = meeting_row_to_candidate(&m).unwrap();
    assert!(c["raw_data"]["calendar_event"].get("end").is_none());
  }

  #[test]
  fn meeting_missing_title_falls_back_to_meeting() {
    let m = json!({ "id": "mtg_x", "started_at": 1_776_900_225_000u64 });
    let c = meeting_row_to_candidate(&m).unwrap();
    assert_eq!(
      c["raw_data"]["calendar_event"]["title"].as_str(),
      Some("Meeting")
    );
  }

  // ---- attach_related_hits / synthetic_relevance ----

  #[test]
  fn synthetic_relevance_decreases_monotonically() {
    assert!(synthetic_relevance(0) > synthetic_relevance(1));
    assert!(synthetic_relevance(1) > synthetic_relevance(2));
    assert!(synthetic_relevance(2) >= 0.5);
    assert!(synthetic_relevance(0) <= 1.0);
  }

  #[test]
  fn memory_hit_maps_to_kioku_hit() {
    // 1_776_816_000_000 ms == 2026-04-22T00:00:00Z.
    let h = json!({
      "id": "m_55",
      "title": "doc",
      "snippet": "body",
      "source": "user",
      "created_at": 1_776_816_000_000u64,
    });
    let k = memory_hit_to_kioku_hit(&h, 1);
    assert_eq!(k["doc_id"].as_str(), Some("m_55"));
    assert_eq!(k["title"].as_str(), Some("doc"));
    assert_eq!(k["last_touched"].as_str(), Some("2026-04-22"));
    assert_eq!(k["relevance_score"].as_f64(), Some(0.80));
  }

  #[test]
  fn attach_related_hits_excludes_self_and_caps_three() {
    let mut cand = json!({
      "candidate_id": "m_self",
      "raw_data": { "calendar_event": { "title": "X" } },
      "related_kioku_hits": [],
    });
    let hits = vec![
      json!({ "id": "m_self", "title": "self" }),
      json!({ "id": "m_a", "title": "a" }),
      json!({ "id": "m_b", "title": "b" }),
      json!({ "id": "m_c", "title": "c" }),
      json!({ "id": "m_d", "title": "d" }),
    ];
    attach_related_hits(&mut cand, &hits);
    let arr = cand["related_kioku_hits"].as_array().unwrap();
    assert_eq!(arr.len(), 3);
    assert_eq!(arr[0]["doc_id"].as_str(), Some("m_a"));
    assert_eq!(arr[2]["doc_id"].as_str(), Some("m_c"));
    // self-id excluded
    assert!(arr.iter().all(|h| h["doc_id"].as_str() != Some("m_self")));
  }

  #[test]
  fn candidate_query_text_prefers_calendar_title() {
    let c = json!({
      "candidate_id": "m_1",
      "raw_data": { "calendar_event": { "title": "Quarterly review" } },
    });
    assert_eq!(candidate_query_text(&c), "Quarterly review");
  }

  #[test]
  fn candidate_query_text_falls_back_to_email_subject() {
    let c = json!({
      "candidate_id": "m_2",
      "raw_data": { "email_thread": { "subject": "Term sheet" } },
    });
    assert_eq!(candidate_query_text(&c), "Term sheet");
  }

  #[test]
  fn candidate_query_text_falls_back_to_id_when_no_title() {
    let c = json!({ "candidate_id": "m_3", "raw_data": {} });
    assert_eq!(candidate_query_text(&c), "m_3");
  }
}
