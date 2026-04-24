//! Morning Brief v2 fixture and version gating. v2 JSON matches `hifi/schemas/morning-brief-v2.schema.json`.
//! Stub copy is English to keep the source ASCII-safe; localized AMC text comes from the composer pipeline.

use crate::meeting_store;
use crate::memory_store;
use crate::summarizer;
use crate::summarizer_store;
use chrono::{Datelike, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

/// Build a memory-backed digest for the brief: top HIGH/MED item summaries
/// from the last 7 days + the current week's rollup (if cached).
///
/// Read-only: never triggers LLM generation. If no summaries exist yet, the
/// returned object has empty `highlights` and `week_rollup: null`. The user
/// populates the cache by visiting Memory → River (batch) or Memory → Week.
pub fn build_memory_digest(lang: &str) -> Value {
  let now_ms = memory_store::now_ms() as i64;
  let window_ms: i64 = 7 * 24 * 3600 * 1000;
  let start_ms = now_ms - window_ms;

  // Fetch HIGH + MEDIUM summaries in the last 7 days (LOW stays in memory).
  let summaries = summarizer_store::get_summaries_in_window(start_ms, now_ms, lang)
    .unwrap_or_default();
  let highlights: Vec<Value> = summaries
    .iter()
    .filter(|s| s.priority == "high" || s.priority == "medium")
    .take(8)
    .map(|s| json!({
      "targetId": s.target_id,
      "title": s.title,
      "keyPoints": s.key_points,
      "priority": s.priority,
      "reason": s.reason,
      "sourceType": s.source_type,
      "generatedAt": s.generated_at,
    }))
    .collect();

  // Current week's Monday 00:00 UTC, matching the id format used by rollup
  // generation so a cached entry hits cleanly.
  let today = Utc::now().date_naive();
  let weekday_from_mon = today.weekday().num_days_from_monday() as i64;
  let monday = today
    .checked_sub_signed(chrono::Duration::days(weekday_from_mon))
    .unwrap_or(today);
  let monday_ms = NaiveDate::from_ymd_opt(monday.year(), monday.month(), monday.day())
    .and_then(|d| d.and_hms_opt(0, 0, 0))
    .map(|ndt| Utc.from_utc_datetime(&ndt).timestamp_millis())
    .unwrap_or(0);
  let week_id = summarizer::format_week_id(monday_ms);

  let week_rollup = summarizer_store::get_cached("week_rollup", &week_id, lang)
    .ok()
    .flatten()
    .map(|s| s.to_json());

  // Today's day rollup (Phase 2.5). Cache-only: not triggered from brief.get.
  let today_ms = NaiveDate::from_ymd_opt(today.year(), today.month(), today.day())
    .and_then(|d| d.and_hms_opt(0, 0, 0))
    .map(|ndt| Utc.from_utc_datetime(&ndt).timestamp_millis())
    .unwrap_or(0);
  let day_id = summarizer::format_week_id(today_ms); // YYYY-MM-DD
  let day_rollup = summarizer_store::get_cached("day_rollup", &day_id, lang)
    .ok()
    .flatten()
    .map(|s| s.to_json());

  json!({
    "highlights": highlights,
    "week_rollup": week_rollup,
    "day_rollup": day_rollup,
  })
}

pub fn morning_brief_v2_stub(_generated_ms: u64, user_tz: &str, payload: &Value) -> Value {
  let now = Utc::now();
  let generated_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
  let date = now.format("%Y-%m-%d").to_string();

  let from_ms = memory_store::now_ms().saturating_sub(86_400_000);
  let meetings_recent = meeting_store::list_meetings(Some(from_ms), None, 8).unwrap_or_default();
  let meeting_bullets: Vec<Value> = meetings_recent
    .iter()
    .filter_map(|m| {
      let title = m.get("title").and_then(|t| t.as_str()).unwrap_or("Meeting");
      let id = m.get("id").and_then(|t| t.as_str()).unwrap_or("");
      let started = m.get("started_at").and_then(|t| t.as_u64()).unwrap_or(0);
      Some(json!({
        "meeting_id": id,
        "title": title,
        "started_at": started,
        "bullets": [
          "Open SHOGUN → Meetings for full transcript and notes.",
        ],
      }))
    })
    .collect();

  let mut out = json!({
    "version": "2.0",
    "generated_at": generated_at,
    "user_tz": user_tz,
    "date": date,
    "summary": {
      "headline": "Two investor meetings; product launch prep day (stub)",
      "posture": "meeting-heavy",
      "total_meeting_minutes": 120,
      "focus_blocks": [
        { "start": "13:00", "end": "15:00", "duration_minutes": 120 }
      ]
    },
    "items": [
      {
        "id": "item_01",
        "priority": 1,
        "category": "meeting",
        "what": "10:00 Investor call (Tanaka / XX Capital)",
        "why_now": "Last time you committed to bring revenue model v2; start is soon.",
        "related_context": [
          { "type": "document", "title": "Revenue model v2", "uri": "shogun://doc/revenue-v2" },
          { "type": "document", "title": "Last meeting notes", "uri": "shogun://doc/minutes-last" },
          { "type": "document", "title": "Competitive deck", "uri": "shogun://doc/comp-deck" }
        ],
        "next_action": {
          "verb": "Open",
          "label": "Open material pack",
          "type": "open",
          "mcp_tool": {
            "tool_name": "shogun.open_pack",
            "arguments": { "pack_id": "investor_tanaka_apr18" }
          },
          "estimated_minutes": 5
        },
        "time_hint": "10:00-11:00",
        "source": { "type": "calendar", "upstream_ids": ["cal_evt_stub_1"] },
        "confidence": 0.92
      },
      {
        "id": "item_02",
        "priority": 2,
        "category": "prep",
        "what": "13:00-15:00 Focus block — SHOGUN LP v2 copy swap",
        "why_now": "Open from Dream Cycle; slotted into today focus window.",
        "related_context": [
          { "type": "document", "title": "LP v1", "uri": "shogun://doc/lp-v1" },
          { "type": "document", "title": "Copy memo", "uri": "shogun://doc/copy-notes" }
        ],
        "next_action": {
          "verb": "Start",
          "label": "Start work session",
          "type": "execute",
          "mcp_tool": {
            "tool_name": "shogun.start_focus_session",
            "arguments": { "duration_minutes": 120, "task": "lp_v2_copy" }
          },
          "estimated_minutes": 120
        },
        "time_hint": "13:00-15:00",
        "source": { "type": "dream_cycle", "upstream_ids": ["dc_task_lp_v2"] },
        "confidence": 0.78
      }
    ],
    "deferred": [
      {
        "id": "def_01",
        "reason": "low_priority_today",
        "snippet": "SLCT inquiry template update (due next week)"
      }
    ],
    "stub": true,
    "echo": payload
  });

  if !meeting_bullets.is_empty() {
    out["meetings_recent"] = json!(meeting_bullets);
  }

  // Attach memory-backed digest (highlights + week rollup). Empty for new
  // users; populated as the user interacts with Memory.
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en");
  out["memory_digest"] = build_memory_digest(lang);

  out
}

fn payload_wants_v2(payload: &Value) -> bool {
  if payload.get("forceV2").and_then(|v| v.as_bool()).unwrap_or(false) {
    return true;
  }
  match payload.get("version").and_then(|v| v.as_str()) {
    Some("2") | Some("2.0") => return true,
    _ => {}
  }
  matches!(
    payload.get("briefVersion").and_then(|v| v.as_str()),
    Some("2") | Some("2.0")
  )
}

fn settings_use_v2(settings: &Value) -> bool {
  settings
    .get("sections")
    .and_then(|s| s.get("brief"))
    .and_then(|b| b.get("morningBriefVersion"))
    .and_then(|v| v.as_str())
    == Some("2")
}

pub fn should_use_v2(settings: &Value, payload: &Value) -> bool {
  payload_wants_v2(payload) || settings_use_v2(settings)
}
