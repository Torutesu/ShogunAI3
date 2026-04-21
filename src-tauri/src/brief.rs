//! Morning Brief v2 orchestration, fixture, and version gating.
//! v2 JSON matches `hifi/schemas/morning-brief-v2.schema.json`.
//! Stub copy is English to keep the source ASCII-safe; localized AMC text
//! comes from the composer pipeline.

use crate::amc_candidates;
use crate::amc_sidecar;
use crate::brief_v2_adapter;
use crate::diagnostics;
use crate::meeting_store;
use crate::memory_store;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};
use tauri::AppHandle;

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

/// Produce a v2 Morning Brief. Gathers local candidates (calendar /
/// gmail memory rows) and pipes them to the Node AMC pipeline on
/// stdin. When no candidates are available locally, falls back to the
/// pipeline's bundled fixture (dry) so the UI still gets a realistic
/// shape. Any sidecar or adapter failure is recorded in
/// `diagnostics::record` and surfaced via a `fallbackReason` on the
/// built-in stub.
///
/// The pipeline itself decides `--dry` vs. live LLM based on
/// `ANTHROPIC_API_KEY`; Rust does not force the mode here.
pub async fn get_morning_brief_v2(
  user_tz: &str,
  payload: &Value,
  app: Option<&AppHandle>,
) -> Value {
  let candidates = amc_candidates::build_candidates();
  let (run_result, mode) = if candidates.is_empty() {
    (amc_sidecar::run_pipeline_dry(app).await, "fixture_dry")
  } else {
    (
      amc_sidecar::run_pipeline_with_candidates(&candidates, false, app).await,
      "stdin_candidates",
    )
  };

  match run_result {
    Ok(v1_raw) => {
      if v1_raw.get("skipped").and_then(|v| v.as_bool()).unwrap_or(false) {
        let reason = v1_raw
          .get("reason")
          .and_then(|v| v.as_str())
          .unwrap_or("pipeline_skipped")
          .to_string();
        diagnostics::record("amc_sidecar.skipped", reason.clone());
        return fallback_stub(user_tz, payload, &format!("skipped: {}", reason));
      }
      let v1 = v1_raw.get("brief").cloned().unwrap_or(v1_raw);
      match brief_v2_adapter::v1_to_v2(&v1, user_tz, payload) {
        Ok(mut v2) => {
          v2["sourceMode"] = json!(mode);
          v2["candidateCount"] = json!(candidates.len());
          v2
        }
        Err(e) => {
          diagnostics::record("amc_sidecar.adapter", e.clone());
          fallback_stub(user_tz, payload, &format!("adapter_failed: {}", e))
        }
      }
    }
    Err(e) => {
      let msg = e.to_string();
      diagnostics::record("amc_sidecar.run", msg.clone());
      fallback_stub(user_tz, payload, &msg)
    }
  }
}

fn fallback_stub(user_tz: &str, payload: &Value, reason: &str) -> Value {
  let mut out = morning_brief_v2_stub(memory_store::now_ms(), user_tz, payload);
  out["fallbackReason"] = json!(reason);
  out
}
