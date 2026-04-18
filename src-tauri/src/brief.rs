//! Morning Brief v2 fixture and version gating. v2 JSON matches `hifi/schemas/morning-brief-v2.schema.json`.
//! v1 continues to use `llm::brief_generate` (sections + generatedAt).

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
      "headline": "\u6295\u8cc7\u5bb6MTG2\u4ef6\u3001\u30d7\u30ed\u30c0\u30af\u30c8\u30ed\u30fc\u30f3\u30c1\u6e96\u5099\u65e5",
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
        "what": "10:00 \u6295\u8cc7\u5bb6MTG\uff08\u7530\u4e2d\u6c0f / \u25cb\u25cbCapital\uff09",
        "why_now": "\u524d\u56de\u300c\u53ce\u76ca\u30e2\u30c7\u30ebv2\u3092\u6301\u53c2\u300d\u3068\u7d04\u675f\u6e08\u307f\u3002\u958b\u59cb\u304c\u8fd1\u3044\u3002",
        "related_context": [
          { "type": "document", "title": "\u53ce\u76ca\u30e2\u30c7\u30ebv2", "uri": "shogun://doc/revenue-v2" },
          { "type": "document", "title": "\u524d\u56de\u8b70\u4e8b\u9332", "uri": "shogun://doc/minutes-last" },
          { "type": "document", "title": "\u7af6\u5408\u6bd4\u8f03\u30b9\u30e9\u30a4\u30c9", "uri": "shogun://doc/comp-deck" }
        ],
        "next_action": {
          "verb": "\u958b\u304f",
          "label": "\u8cc7\u6599\u30d1\u30c3\u30af\u3092\u958b\u304f",
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
        "what": "13:00-15:00 Focus Block \u2014 SHOGUN LP v2 \u30b3\u30d4\u30fc\u5dee\u3057\u66ff\u3048",
        "why_now": "\u524d\u56deDream Cycle\u3067\u672a\u5b8c\u4e86\u30bf\u30b9\u30af\u3002\u4eca\u65e5\u306e\u96c6\u4e2d\u67a0\u306b\u5272\u308a\u5f53\u3066\u6e08\u307f\u3002",
        "related_context": [
          { "type": "document", "title": "LP v1", "uri": "shogun://doc/lp-v1" },
          { "type": "document", "title": "\u30b3\u30d4\u30fc\u30e1\u30e2", "uri": "shogun://doc/copy-notes" }
        ],
        "next_action": {
          "verb": "\u958b\u59cb\u3059\u308b",
          "label": "\u4f5c\u696d\u30bb\u30c3\u30b7\u30e7\u30f3\u958b\u59cb",
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
        "snippet": "SLCT \u554f\u3044\u5408\u308f\u305b\u30c6\u30f3\u30d7\u30ec\u66f4\u65b0\uff08\u6765\u9031\u7de0\u5207\uff09"
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
