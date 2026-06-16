//! Morning Brief v2 fixture and version gating. v2 JSON matches `hifi/schemas/morning-brief-v2.schema.json`.
//! Stub copy is English to keep the source ASCII-safe; localized AMC text comes from the composer pipeline.

use crate::kioku_decision_graph::{DecisionGraphHit, KiokuHit};
use crate::context_assembly;
use crate::meeting_store;
use crate::memory_store;
use crate::summarizer;
use crate::summarizer_store;
use chrono::{Datelike, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Value};

/// Read mem_items.entity_id for a single id without imposing a full row read.
/// Returns None if the row doesn't exist or has NULL/empty entity_id.
fn lookup_item_entity_id(target_id: &str) -> Option<String> {
  let conn = memory_store::open_conn().ok()?;
  conn
    .query_row(
      "SELECT entity_id FROM mem_items WHERE id = ?1",
      [target_id],
      |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
    .filter(|s| !s.is_empty())
}

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
  // Respect the user's manual priority override when selecting highlights.
  // Also drop items the user has snoozed past now (they re-surface
  // automatically once snooze_until <= now_ms).
  let now = now_ms;
  let highlights: Vec<Value> = summaries
    .iter()
    .filter(|s| {
      let p: &str = s.user_priority.as_deref().unwrap_or(&s.priority);
      let is_priority = p == "high" || p == "medium";
      let snoozed = s.snooze_until.map(|t| t > now).unwrap_or(false);
      is_priority && !snoozed
    })
    .take(8)
    .map(|s| {
      // Look up the underlying mem_item to surface its entity_id (if any)
      // so the UI can offer a "Related" view via the entity rollup.
      let entity_id = lookup_item_entity_id(&s.target_id);
      json!({
        "targetId": s.target_id,
        "targetKind": s.target_kind,
        "title": s.title,
        "keyPoints": s.key_points,
        "priority": s.priority,
        "userPriority": s.user_priority,
        "reason": s.reason,
        "sourceType": s.source_type,
        "generatedAt": s.generated_at,
        "acknowledgedAt": s.acknowledged_at,
        "entityId": entity_id,
      })
    })
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
    "read_path": context_assembly::current_read_path(),
  })
}

const BRIEF_DIGEST_HIGHLIGHT_TARGET: usize = 8;

fn hit_source_type(hit: &context_assembly::Hit) -> &'static str {
  match hit.provenance.as_str() {
    "meeting" => "meeting",
    "connector" => summarizer::derive_source_type(&hit.source),
    _ => "memory",
  }
}

/// Convert graph/legacy retrieval hits into brief digest highlight rows.
pub fn hits_to_digest_highlights(hits: &[context_assembly::Hit]) -> Vec<Value> {
  hits
    .iter()
    .take(BRIEF_DIGEST_HIGHLIGHT_TARGET)
    .map(|hit| {
      let title = if hit.title.trim().is_empty() {
        truncate_chars(hit.snippet.trim(), 60)
      } else {
        hit.title.clone()
      };
      let snippet_preview = truncate_chars(hit.snippet.trim(), 140);
      let entity_id = lookup_item_entity_id(&hit.id);
      json!({
        "targetId": hit.id,
        "targetKind": "item",
        "title": title,
        "keyPoints": if snippet_preview.is_empty() {
          Value::Array(vec![])
        } else {
          json!([snippet_preview])
        },
        "priority": "medium",
        "userPriority": Value::Null,
        "reason": Value::Null,
        "sourceType": hit_source_type(hit),
        "generatedAt": hit.created_at as i64,
        "acknowledgedAt": Value::Null,
        "entityId": entity_id,
        "fromGraph": true,
      })
    })
    .collect()
}

/// When cached item summaries are sparse, supplement the digest from the same
/// graph/legacy retrieval path used by chat and v1 brief.
pub async fn enrich_memory_digest_with_graph(digest: &mut Value) {
  use std::collections::HashSet;

  let existing: Vec<Value> = digest
    .get("highlights")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  let mut seen: HashSet<String> = existing
    .iter()
    .filter_map(|h| {
      h.get("targetId")
        .and_then(|v| v.as_str())
        .map(str::to_string)
    })
    .collect();

  let need = BRIEF_DIGEST_HIGHLIGHT_TARGET.saturating_sub(existing.len());
  digest["read_path"] = json!(context_assembly::current_read_path());
  if need == 0 {
    return;
  }

  let fetch_limit = need.max(BRIEF_DIGEST_HIGHLIGHT_TARGET) as u64;
  let hits = context_assembly::assemble_memory_hits(context_assembly::AssembleParams {
    query: "",
    limit: fetch_limit,
    semantic: true,
    excluded_provenances: Some(vec!["screen".to_string()]),
  })
  .await
  .unwrap_or_default();

  let mut merged = existing;
  let mut supplemented = false;
  for row in hits_to_digest_highlights(&hits) {
    let Some(id) = row.get("targetId").and_then(|v| v.as_str()) else {
      continue;
    };
    if seen.insert(id.to_string()) {
      merged.push(row);
      supplemented = true;
      if merged.len() >= BRIEF_DIGEST_HIGHLIGHT_TARGET {
        break;
      }
    }
  }

  if supplemented {
    digest["graph_supplemented"] = json!(true);
  }
  digest["highlights"] = json!(merged);
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

  let patterns_for_brief = crate::patterns::list_for_brief(4, false).unwrap_or_default();
  if !patterns_for_brief.is_empty() {
    out["patterns"] = Value::Array(patterns_for_brief);
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

/// UI-facing brief card (Home expects `headline`, `posture`, `items`, not nested `summary`).
pub fn normalize_brief_for_ui(raw: &Value) -> Value {
  let headline = raw
    .pointer("/summary/headline")
    .and_then(|v| v.as_str())
    .or_else(|| raw.get("headline").and_then(|v| v.as_str()))
    .unwrap_or("Your day from Memory");
  let posture = raw
    .pointer("/summary/posture")
    .and_then(|v| v.as_str())
    .or_else(|| raw.get("posture").and_then(|v| v.as_str()))
    .unwrap_or("focus");
  let items = raw.get("items").cloned().unwrap_or_else(|| json!([]));
  let deferred_count = raw
    .get("deferred")
    .and_then(|d| d.as_array())
    .map(|a| a.len())
    .or_else(|| raw.get("deferred_count").and_then(|v| v.as_u64()).map(|n| n as usize))
    .unwrap_or(0);
  let mut out = json!({
    "headline": headline,
    "posture": posture,
    "items": items,
    "deferred_count": deferred_count,
    "generated_at": raw.get("generated_at").cloned().unwrap_or(Value::Null),
  });
  if let Some(p) = raw.get("patterns") {
    out["patterns"] = p.clone();
  }
  out
}

pub fn wrap_brief_get_response(brief_ui: Value, memory_digest: Value, skipped: bool) -> Value {
  json!({
    "skipped": skipped,
    "brief": if skipped { Value::Null } else { brief_ui },
    "memory_digest": memory_digest,
    "memoryReadPath": context_assembly::current_read_path(),
    "stub": false,
  })
}

/// KIOKU graph payloads for Morning Brief / AMC (`shogun_kioku_brief_signals` shape).
pub fn load_kioku_brief_signals(limit_decisions: usize, limit_kioku: usize) -> Value {
  let Ok(conn) = memory_store::open_conn() else {
    return json!({
      "decision_graph_hits": [],
      "related_kioku_hits": [],
    });
  };
  let decisions =
    crate::kioku_decision_graph::fetch_decision_graph_hits(&conn, limit_decisions).unwrap_or_default();
  let kioku =
    crate::kioku_decision_graph::fetch_recent_kioku_hits(&conn, limit_kioku).unwrap_or_default();
  json!({
    "decision_graph_hits": decisions,
    "related_kioku_hits": kioku,
  })
}

fn truncate_chars(s: &str, max: usize) -> String {
  if s.chars().count() <= max {
    return s.to_string();
  }
  s.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
}

fn decision_hit_to_brief_item(hit: &DecisionGraphHit, priority: u64) -> Value {
  let pending = hit.follow_ups_pending.unwrap_or(0);
  let why_now = if pending > 0 {
    format!(
      "{pending} pending follow-up(s) linked in your decision graph."
    )
  } else {
    "Decision from your KIOKU graph — review or act today.".to_string()
  };
  let what = truncate_chars(hit.summary.trim(), 120);
  json!({
    "id": format!("dg_{}", hit.decision_id),
    "priority": priority.min(3).max(1),
    "category": "decision",
    "what": if what.is_empty() {
      "Decision".to_string()
    } else {
      what
    },
    "why_now": why_now,
    "related_context": [{
      "type": "memory",
      "title": "Decision node",
      "uri": format!("shogun://memory/{}", hit.decision_id)
    }],
    "next_action": {
      "verb": "Open",
      "label": "Search related Memory",
      "type": "open",
      "mcp_tool": {
        "tool_name": "shogun.memory_search",
        "arguments": {
          "query": hit.decision_id,
          "limit": 12
        }
      }
    },
    "source": {
      "type": "decision_graph",
      "upstream_ids": [hit.decision_id.clone()]
    },
    "confidence": 0.85
  })
}

fn kioku_hit_to_context_ref(hit: &KiokuHit) -> Value {
  json!({
    "type": "memory",
    "title": hit.title,
    "uri": format!("shogun://memory/{}", hit.doc_id)
  })
}

/// Prepend decision-graph items (max 3) and enrich related_context from KIOKU hits.
pub fn merge_kioku_signals_into_brief(brief: &mut Value, signals: &Value) {
  const MAX_DECISION_ITEMS: usize = 3;
  const MAX_BRIEF_ITEMS: usize = 6;

  let decisions: Vec<DecisionGraphHit> = signals
    .get("decision_graph_hits")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default();
  let kioku: Vec<KiokuHit> = signals
    .get("related_kioku_hits")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default();

  if decisions.is_empty() && kioku.is_empty() {
    return;
  }

  let mut items = brief
    .get("items")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default();

  if !decisions.is_empty() {
    let mut dg_items: Vec<Value> = decisions
      .iter()
      .take(MAX_DECISION_ITEMS)
      .enumerate()
      .map(|(i, hit)| decision_hit_to_brief_item(hit, (i + 1) as u64))
      .collect();
    dg_items.append(&mut items);
    items = dg_items;
  }

  if items.len() > MAX_BRIEF_ITEMS {
    items.truncate(MAX_BRIEF_ITEMS);
  }

  for (idx, item) in items.iter_mut().enumerate() {
    if let Some(obj) = item.as_object_mut() {
      obj.insert("priority".to_string(), json!((idx + 1).min(3)));
    }
  }

  if !kioku.is_empty() {
    let ctx: Vec<Value> = kioku
      .iter()
      .take(3)
      .map(kioku_hit_to_context_ref)
      .collect();
    if let Some(first) = items.first_mut().and_then(|v| v.as_object_mut()) {
      let existing = first
        .get("related_context")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
      let mut merged = ctx;
      for row in existing.into_iter().take(3usize.saturating_sub(merged.len())) {
        merged.push(row);
      }
      first.insert("related_context".to_string(), json!(merged));
    }
  }

  brief["items"] = json!(items);

  if !decisions.is_empty() {
    if let Some(summary) = brief.get_mut("summary").and_then(|v| v.as_object_mut()) {
      summary.insert(
        "headline".to_string(),
        json!("Decisions and highlights from your KIOKU graph"),
      );
    }
  }
}

fn enrich_brief_with_kioku_signals(brief: &mut Value) {
  let signals = load_kioku_brief_signals(5, 12);
  merge_kioku_signals_into_brief(brief, &signals);
}

/// Memory-backed v2 brief when no LLM key is available.
pub fn morning_brief_v2_heuristic(
  user_tz: &str,
  payload: &Value,
  memory_digest: Option<&Value>,
) -> Value {
  let now = Utc::now();
  let generated_at = now.to_rfc3339_opts(SecondsFormat::Secs, true);
  let date = now.format("%Y-%m-%d").to_string();
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en");
  let digest = memory_digest
    .cloned()
    .unwrap_or_else(|| build_memory_digest(lang));
  let highlights = digest
    .get("highlights")
    .and_then(|h| h.as_array())
    .cloned()
    .unwrap_or_default();
  let mut items: Vec<Value> = Vec::new();
  for (i, h) in highlights.iter().take(6).enumerate() {
    let title = h.get("title").and_then(|v| v.as_str()).unwrap_or("Memory item");
    let key_points = h
      .get("keyPoints")
      .and_then(|v| v.as_array())
      .map(|a| {
        a.iter()
          .filter_map(|x| x.as_str())
          .collect::<Vec<_>>()
          .join("; ")
      })
      .unwrap_or_default();
    items.push(json!({
      "id": format!("item_{:02}", i + 1),
      "priority": i + 1,
      "category": h.get("sourceType").and_then(|v| v.as_str()).unwrap_or("memory"),
      "what": title,
      "why_now": if key_points.is_empty() { "Surfaced from your local Memory highlights." } else { key_points.as_str() },
      "related_context": [{
        "type": "memory",
        "title": title,
        "uri": format!("shogun://memory/{}", h.get("targetId").and_then(|v| v.as_str()).unwrap_or(""))
      }],
      "next_action": {
        "verb": "Open",
        "label": "Search Memory",
        "type": "open",
        "mcp_tool": {
          "tool_name": "shogun.memory_search",
          "arguments": { "query": title.chars().take(80).collect::<String>(), "limit": 12 }
        }
      },
      "confidence": 0.72
    }));
  }
  let headline = if items.is_empty() {
    "No highlights yet — capture work or connect integrations to populate your brief."
  } else {
    "Top priorities from your Memory highlights"
  };
  let mut out = json!({
    "version": "2.0",
    "generated_at": generated_at,
    "user_tz": user_tz,
    "date": date,
    "summary": {
      "headline": headline,
      "posture": if items.len() >= 4 { "busy" } else { "focus" },
      "total_meeting_minutes": 0,
      "focus_blocks": []
    },
    "items": items,
    "deferred": [],
    "stub": false,
    "echo": payload,
    "memory_digest": digest,
  });
  let patterns = crate::patterns::list_for_brief(4, false).unwrap_or_default();
  if !patterns.is_empty() {
    out["patterns"] = Value::Array(patterns);
  }
  enrich_brief_with_kioku_signals(&mut out);
  out
}

pub async fn morning_brief_v2_generate(
  user_tz: &str,
  payload: &Value,
  memory_digest: Option<&Value>,
) -> Result<Value, String> {
  let lang = payload
    .get("lang")
    .and_then(|v| v.as_str())
    .unwrap_or("en");
  let digest = memory_digest
    .cloned()
    .unwrap_or_else(|| build_memory_digest(lang));
  let digest_json = serde_json::to_string(&digest).unwrap_or_else(|_| "{}".to_string());
  let user_prompt = format!(
    "From this local SHOGUN memory digest JSON, output ONLY valid Morning Brief v2 JSON with keys: \
version (\"2.0\"), generated_at (RFC3339), user_tz, date (YYYY-MM-DD), summary (headline, posture, total_meeting_minutes, focus_blocks), \
items (array of priority, category, what, why_now, related_context, next_action with mcp_tool.tool_name among shogun.open_pack|shogun.memory_search|shogun.start_focus_session, time_hint optional, confidence), \
deferred (array). No markdown fences. Max 6 items.\n\nDigest:\n{}",
    digest_json.chars().take(12_000).collect::<String>()
  );
  let synthetic = json!({
    "messages": [
      { "role": "system", "content": "You compose concise daily briefs from local memory only. Never invent meetings or people not in the digest." },
      { "role": "user", "content": user_prompt }
    ]
  });
  let out = crate::llm::chat_complete(&synthetic, None).await?;
  let message = out.get("message").and_then(|m| m.as_str()).unwrap_or("{}");
  let mut brief: Value = serde_json::from_str(message).unwrap_or_else(|_| {
    json!({
      "version": "2.0",
      "summary": { "headline": "Brief unavailable", "posture": "focus" },
      "items": [],
      "deferred": []
    })
  });
  if brief.get("generated_at").is_none() {
    brief["generated_at"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
  }
  brief["user_tz"] = json!(user_tz);
  brief["memory_digest"] = digest.clone();
  brief["stub"] = json!(false);
  let patterns = crate::patterns::list_for_brief(4, false).unwrap_or_default();
  if !patterns.is_empty() {
    brief["patterns"] = Value::Array(patterns);
  }
  enrich_brief_with_kioku_signals(&mut brief);
  Ok(brief)
}

#[cfg(test)]
mod kioku_brief_tests {
  use super::*;

  #[test]
  fn hits_to_digest_highlights_maps_snippet_and_flags_graph() {
    use crate::context_assembly::Hit;

    let hits = vec![Hit {
      id: "mem_1".into(),
      title: "Investor deck".into(),
      snippet: "Q2 metrics and runway update.".into(),
      source: "gmail".into(),
      provenance: "connector".into(),
      created_at: 1_700_000_000_000,
    }];
    let rows = hits_to_digest_highlights(&hits);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["targetId"], "mem_1");
    assert_eq!(rows[0]["title"], "Investor deck");
    assert_eq!(rows[0]["fromGraph"], true);
    assert_eq!(rows[0]["sourceType"], "mail");
  }

  #[test]
  fn merge_decision_graph_prepends_items_and_updates_headline() {
    let mut brief = json!({
      "summary": { "headline": "From highlights" },
      "items": [{
        "id": "item_01",
        "priority": 1,
        "category": "prep",
        "what": "Existing item",
        "why_now": "Already scheduled",
        "related_context": [],
        "next_action": {
          "verb": "Open",
          "label": "Search",
          "type": "open",
          "mcp_tool": { "tool_name": "shogun.memory_search", "arguments": { "query": "x", "limit": 5 } }
        },
        "source": { "type": "kioku_search" },
        "confidence": 0.7
      }]
    });
    let signals = json!({
      "decision_graph_hits": [{
        "decision_id": "dec_1",
        "summary": "Ship KIOKU graph retrieval",
        "follow_ups_pending": 2
      }],
      "related_kioku_hits": []
    });
    merge_kioku_signals_into_brief(&mut brief, &signals);
    let items = brief["items"].as_array().expect("items array");
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["id"], "dg_dec_1");
    assert_eq!(items[0]["category"], "decision");
    assert!(
      brief["summary"]["headline"]
        .as_str()
        .unwrap()
        .contains("KIOKU")
    );
  }

  #[test]
  fn merge_kioku_hits_enriches_first_item_context() {
    let mut brief = json!({
      "summary": { "headline": "Brief" },
      "items": [{
        "id": "item_01",
        "priority": 1,
        "category": "prep",
        "what": "Focus",
        "why_now": "Today",
        "related_context": [],
        "next_action": {
          "verb": "Open",
          "label": "Search",
          "type": "open",
          "mcp_tool": { "tool_name": "shogun.memory_search", "arguments": { "query": "x", "limit": 5 } }
        },
        "source": { "type": "kioku_search" },
        "confidence": 0.7
      }]
    });
    let signals = json!({
      "decision_graph_hits": [],
      "related_kioku_hits": [{
        "doc_id": "m_1",
        "title": "Launch checklist",
        "relevance_score": 0.8
      }]
    });
    merge_kioku_signals_into_brief(&mut brief, &signals);
    let ctx = brief["items"][0]["related_context"]
      .as_array()
      .expect("related_context");
    assert_eq!(ctx.len(), 1);
    assert_eq!(ctx[0]["title"], "Launch checklist");
  }
}
