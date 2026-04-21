//! Pure mapping from the AMC pipeline's v1 Morning Brief JSON
//! (see `hifi/amc-pipeline/src/schemas.js` `MorningBriefJsonSchema`)
//! into the v2 `morning-brief-v2.schema.json` shape expected by the UI.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

/// Map v1 `trigger_source` enum to v2 `brief_source.type`. Values outside
/// the v2 vocabulary collapse onto `dream_cycle` (the catch-all "signal"
/// bucket) — this keeps the output schema-valid rather than surfacing
/// unknown values.
fn map_source_type(v1: &str) -> &'static str {
  match v1 {
    "calendar" => "calendar",
    "email" => "email",
    "slack" => "slack",
    "decision_graph" => "decision_graph",
    "kioku" => "kioku_search",
    _ => "dream_cycle",
  }
}

/// Map v1 `next_action.type` to v2. v1 `focus` corresponds to v2
/// `execute` (start-a-session semantics); v1 `other` falls back to
/// `open` since the v2 vocabulary has no free-form bucket.
fn map_next_action_type(v1: &str) -> &'static str {
  match v1 {
    "open" => "open",
    "draft" => "draft",
    "focus" => "execute",
    "schedule" => "schedule",
    "ignore" => "ignore",
    _ => "open",
  }
}

/// Map v1 `related_context[].type` (literally `"document"`) to a v2
/// `context_ref.type`. Anything else defaults to `document`.
fn map_context_type(v1: &str) -> &'static str {
  match v1 {
    "document" | "person" | "decision" | "slack_thread" | "email" | "commit" | "calendar" => {
      match v1 {
        "document" => "document",
        "person" => "person",
        "decision" => "decision",
        "slack_thread" => "slack_thread",
        "email" => "email",
        "commit" => "commit",
        "calendar" => "calendar",
        _ => "document",
      }
    }
    _ => "document",
  }
}

fn ymd_from_rfc3339(rfc3339: &str) -> String {
  DateTime::parse_from_rfc3339(rfc3339)
    .map(|dt| dt.format("%Y-%m-%d").to_string())
    .unwrap_or_else(|_| Utc::now().format("%Y-%m-%d").to_string())
}

fn map_context_ref(v1_ref: &Value) -> Value {
  let type_in = v1_ref.get("type").and_then(|v| v.as_str()).unwrap_or("document");
  let title = v1_ref.get("title").and_then(|v| v.as_str()).unwrap_or("");
  let uri = v1_ref.get("uri").and_then(|v| v.as_str()).unwrap_or("");
  let mut out = json!({
    "type": map_context_type(type_in),
    "title": title,
    "uri": uri,
  });
  if let Some(lt) = v1_ref.get("last_touched").and_then(|v| v.as_str()) {
    out["last_touched"] = json!(lt);
  }
  if let Some(sn) = v1_ref.get("snippet").and_then(|v| v.as_str()) {
    out["snippet"] = json!(sn);
  }
  out
}

fn map_next_action(v1_action: &Value) -> Value {
  let verb = v1_action.get("verb").and_then(|v| v.as_str()).unwrap_or("");
  let label = v1_action.get("label").and_then(|v| v.as_str()).unwrap_or("");
  let t = v1_action.get("type").and_then(|v| v.as_str()).unwrap_or("open");
  let mut out = json!({
    "verb": verb,
    "label": label,
    "type": map_next_action_type(t),
  });
  if let Some(tool) = v1_action.get("mcp_tool") {
    let tool_name = tool
      .get("tool_name")
      .and_then(|v| v.as_str())
      .unwrap_or("");
    let args = tool
      .get("arguments")
      .cloned()
      .unwrap_or_else(|| json!({}));
    out["mcp_tool"] = json!({
      "tool_name": tool_name,
      "arguments": args,
    });
  }
  if let Some(est) = v1_action.get("estimated_minutes").and_then(|v| v.as_f64()) {
    if est >= 0.0 {
      out["estimated_minutes"] = json!(est);
    }
  }
  out
}

fn map_item(v1_item: &Value) -> Value {
  let id = v1_item
    .get("id")
    .and_then(|v| v.as_str())
    .unwrap_or("item_xx");
  let priority = v1_item
    .get("priority")
    .and_then(|v| v.as_u64())
    .unwrap_or(3)
    .clamp(1, 3);
  let category = v1_item
    .get("category")
    .and_then(|v| v.as_str())
    .unwrap_or("signal");
  let what = v1_item.get("what").and_then(|v| v.as_str()).unwrap_or("");
  let why_now = v1_item
    .get("why_now")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let related: Vec<Value> = v1_item
    .get("related_context")
    .and_then(|v| v.as_array())
    .map(|a| a.iter().take(3).map(map_context_ref).collect())
    .unwrap_or_default();
  let next_action = v1_item
    .get("next_action")
    .map(map_next_action)
    .unwrap_or_else(|| json!({ "verb": "", "label": "", "type": "open" }));
  let src = v1_item.get("source");
  let source_type = src
    .and_then(|s| s.get("type"))
    .and_then(|v| v.as_str())
    .unwrap_or("dream_cycle");
  let upstream_ids: Vec<Value> = src
    .and_then(|s| s.get("upstream_ids"))
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default();
  let confidence = v1_item
    .get("confidence")
    .and_then(|v| v.as_f64())
    .unwrap_or(0.5)
    .clamp(0.0, 1.0);

  let mut out = json!({
    "id": id,
    "priority": priority,
    "category": category,
    "what": what,
    "why_now": why_now,
    "related_context": related,
    "next_action": next_action,
    "source": {
      "type": map_source_type(source_type),
      "upstream_ids": upstream_ids,
    },
    "confidence": confidence,
  });
  if let Some(th) = v1_item.get("time_hint").and_then(|v| v.as_str()) {
    out["time_hint"] = json!(th);
  }
  out
}

fn total_meeting_minutes(items: &[Value]) -> f64 {
  items
    .iter()
    .filter(|it| {
      it.get("category")
        .and_then(|v| v.as_str())
        .map(|c| c == "meeting")
        .unwrap_or(false)
    })
    .filter_map(|it| {
      it.get("next_action")
        .and_then(|na| na.get("estimated_minutes"))
        .and_then(|v| v.as_f64())
    })
    .sum()
}

fn map_deferred(v1: &Value) -> Vec<Value> {
  let preview = v1
    .get("deferred_preview")
    .and_then(|v| v.as_array())
    .cloned()
    .unwrap_or_default();
  preview
    .iter()
    .enumerate()
    .map(|(i, s)| {
      let snippet = s.as_str().unwrap_or("").to_string();
      json!({
        "id": format!("def_{:02}", i + 1),
        "reason": "low_priority_today",
        "snippet": snippet,
      })
    })
    .collect()
}

/// Convert a v1 Morning Brief JSON object to the v2 shape. `generated_at`
/// and `date` come from the input when available; `user_tz` is copied
/// from the caller's payload (default `UTC`).
pub fn v1_to_v2(v1: &Value, user_tz: &str, payload: &Value) -> Result<Value, String> {
  let version_ok = v1
    .get("version")
    .and_then(|v| v.as_u64())
    .map(|n| n == 1)
    .unwrap_or(false);
  if !version_ok {
    return Err(format!(
      "expected v1 brief (version: 1), got {}",
      v1.get("version").cloned().unwrap_or(Value::Null)
    ));
  }

  let generated_at = v1
    .get("generated_at")
    .and_then(|v| v.as_str())
    .map(str::to_string)
    .unwrap_or_else(|| Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true));
  let date = ymd_from_rfc3339(&generated_at);

  let items: Vec<Value> = v1
    .get("items")
    .and_then(|v| v.as_array())
    .map(|a| a.iter().take(7).map(map_item).collect())
    .unwrap_or_default();
  let deferred = map_deferred(v1);
  let total_mtg = total_meeting_minutes(&items);
  let headline = v1
    .get("headline")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .to_string();
  let posture = v1
    .get("posture")
    .and_then(|v| v.as_str())
    .unwrap_or("focus")
    .to_string();

  Ok(json!({
    "version": "2.0",
    "generated_at": generated_at,
    "user_tz": user_tz,
    "date": date,
    "summary": {
      "headline": headline,
      "posture": posture,
      "total_meeting_minutes": total_mtg,
      "focus_blocks": [],
    },
    "items": items,
    "deferred": deferred,
    "echo": payload,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample_v1() -> Value {
    json!({
      "version": 1,
      "generated_at": "2026-04-21T01:00:00.000Z",
      "headline": "今日の優先",
      "posture": "meeting-heavy",
      "items": [
        {
          "id": "item_01",
          "priority": 1,
          "category": "meeting",
          "what": "Investor MTG",
          "why_now": "Revenue v2 due today",
          "related_context": [
            { "type": "document", "title": "Notes", "uri": "shogun://doc/k1", "last_touched": "2026-04-04" }
          ],
          "next_action": {
            "verb": "Open",
            "label": "Open pack",
            "type": "open",
            "mcp_tool": { "tool_name": "shogun.open_pack", "arguments": { "doc_ids": ["k1"] } },
            "estimated_minutes": 60
          },
          "time_hint": "10:00-11:00",
          "source": { "type": "calendar", "upstream_ids": ["cand_001"] },
          "confidence": 0.9
        },
        {
          "id": "item_02",
          "priority": 2,
          "category": "prep",
          "what": "LP v2 copy",
          "why_now": "Stuck 4 days",
          "related_context": [],
          "next_action": {
            "verb": "Start",
            "label": "Start focus",
            "type": "focus",
            "estimated_minutes": 120
          },
          "source": { "type": "focus_block", "upstream_ids": ["cand_002"] },
          "confidence": 0.6
        }
      ],
      "deferred_count": 2,
      "deferred_preview": ["Low-prio doc review", "Follow-up email"]
    })
  }

  #[test]
  fn adapts_minimal_v1_to_v2_shape() {
    let out = v1_to_v2(&sample_v1(), "Asia/Tokyo", &json!({})).unwrap();
    assert_eq!(out["version"].as_str(), Some("2.0"));
    assert_eq!(out["user_tz"].as_str(), Some("Asia/Tokyo"));
    assert_eq!(out["date"].as_str(), Some("2026-04-21"));
    assert_eq!(out["generated_at"].as_str(), Some("2026-04-21T01:00:00.000Z"));
    assert_eq!(out["summary"]["headline"].as_str(), Some("今日の優先"));
    assert_eq!(out["summary"]["posture"].as_str(), Some("meeting-heavy"));
    assert_eq!(out["items"].as_array().unwrap().len(), 2);
    assert_eq!(out["deferred"].as_array().unwrap().len(), 2);
    assert_eq!(out["deferred"][0]["id"].as_str(), Some("def_01"));
    assert_eq!(
      out["deferred"][0]["reason"].as_str(),
      Some("low_priority_today")
    );
  }

  #[test]
  fn sums_meeting_minutes_only() {
    let out = v1_to_v2(&sample_v1(), "UTC", &json!({})).unwrap();
    // Only item_01 (category=meeting) contributes 60; item_02 prep does not.
    assert_eq!(
      out["summary"]["total_meeting_minutes"].as_f64(),
      Some(60.0)
    );
  }

  #[test]
  fn maps_focus_action_to_execute_and_focus_block_to_dream_cycle() {
    let out = v1_to_v2(&sample_v1(), "UTC", &json!({})).unwrap();
    let it = &out["items"][1];
    assert_eq!(it["next_action"]["type"].as_str(), Some("execute"));
    assert_eq!(it["source"]["type"].as_str(), Some("dream_cycle"));
    assert_eq!(
      it["source"]["upstream_ids"].as_array().unwrap()[0].as_str(),
      Some("cand_002")
    );
  }

  #[test]
  fn caps_items_at_seven() {
    let mut v1 = sample_v1();
    let template = v1["items"][1].clone();
    let items = v1["items"].as_array_mut().unwrap();
    while items.len() < 10 {
      items.push(template.clone());
    }
    let out = v1_to_v2(&v1, "UTC", &json!({})).unwrap();
    assert_eq!(out["items"].as_array().unwrap().len(), 7);
  }

  #[test]
  fn rejects_non_v1_input() {
    let v2ish = json!({ "version": "2.0" });
    let err = v1_to_v2(&v2ish, "UTC", &json!({})).unwrap_err();
    assert!(err.contains("v1"));
  }

  #[test]
  fn clamps_priority_and_confidence_into_range() {
    let mut v1 = sample_v1();
    v1["items"][0]["priority"] = json!(9);
    v1["items"][0]["confidence"] = json!(1.7);
    let out = v1_to_v2(&v1, "UTC", &json!({})).unwrap();
    assert_eq!(out["items"][0]["priority"].as_u64(), Some(3));
    assert_eq!(out["items"][0]["confidence"].as_f64(), Some(1.0));
  }

  #[test]
  fn related_context_cap_three() {
    let mut v1 = sample_v1();
    let mut refs = Vec::new();
    for i in 0..5 {
      refs.push(json!({ "type": "document", "title": format!("t{}", i), "uri": format!("shogun://doc/k{}", i) }));
    }
    v1["items"][0]["related_context"] = json!(refs);
    let out = v1_to_v2(&v1, "UTC", &json!({})).unwrap();
    assert_eq!(out["items"][0]["related_context"].as_array().unwrap().len(), 3);
  }

  #[test]
  fn passes_through_payload_echo() {
    let payload = json!({ "user_tz": "Asia/Tokyo", "forceV2": true });
    let out = v1_to_v2(&sample_v1(), "Asia/Tokyo", &payload).unwrap();
    assert_eq!(out["echo"]["forceV2"].as_bool(), Some(true));
  }

  #[test]
  fn unknown_trigger_source_collapses_to_dream_cycle() {
    let mut v1 = sample_v1();
    v1["items"][0]["source"]["type"] = json!("signal");
    let out = v1_to_v2(&v1, "UTC", &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"]["type"].as_str(), Some("dream_cycle"));
  }

  #[test]
  fn kioku_trigger_renames_to_kioku_search() {
    let mut v1 = sample_v1();
    v1["items"][0]["source"]["type"] = json!("kioku");
    let out = v1_to_v2(&v1, "UTC", &json!({})).unwrap();
    assert_eq!(out["items"][0]["source"]["type"].as_str(), Some("kioku_search"));
  }
}
