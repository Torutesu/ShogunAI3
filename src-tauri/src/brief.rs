//! Morning Brief v2 fixture and version gating. v2 JSON matches `hifi/schemas/morning-brief-v2.schema.json`.
//! Stub copy is English to keep the source ASCII-safe; localized AMC text comes from the composer pipeline.

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

pub fn morning_brief_v2_stub(generated_ms: u64, user_tz: &str, payload: &Value) -> Value {
  let now = Utc::now();
  let generated_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
  let date = now.format("%Y-%m-%d").to_string();
  let _ = generated_ms;

  json!({
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
  })
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
