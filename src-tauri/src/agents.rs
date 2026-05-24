//! Agent "Run now" dispatcher — maps demo agent ids to existing sync/rollup jobs
//! and persists last-run metadata under `settings.sections.agents.runs`.

use crate::{gmail, google_calendar, settings_store, summarizer};
use chrono::{Datelike, Utc};
use serde_json::{json, Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

pub fn record_agent_run(agent_id: &str, ok: bool, summary: &str) -> Result<(), String> {
  let doc = settings_store::load()?;
  let mut runs = doc
    .pointer("/sections/agents/runs")
    .and_then(|v| v.as_object())
    .cloned()
    .unwrap_or_else(Map::new);
  runs.insert(
    agent_id.to_string(),
    json!({
      "atMs": now_ms(),
      "ok": ok,
      "summary": summary.chars().take(500).collect::<String>(),
    }),
  );
  settings_store::save_patch(&json!({
    "section": "agents",
    "runs": Value::Object(runs),
  }))?;
  Ok(())
}

pub async fn run_now(agent_id: &str) -> Result<Value, String> {
  let id = agent_id.trim();
  if id.is_empty() {
    return Err("agentId is required".to_string());
  }

  let result: Result<(Value, String), String> = match id {
    "inbox-triage" => {
      let data = gmail::sync_inbox_to_memory(20, None).await?;
      let n = data.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      Ok((data, format!("Synced {} emails", n)))
    }
    "meeting-notes" => {
      let data = google_calendar::sync_events_to_memory("primary", 25, 0).await?;
      let n = data.get("ingested").and_then(|v| v.as_u64()).unwrap_or(0);
      Ok((data, format!("Synced {} calendar events", n)))
    }
    "daily-digest" => {
      let day_start_ms = payload_day_start_ms(None);
      let rollup = summarizer::summarize_day_rollup(day_start_ms, "en").await?;
      let data = json!({
        "rollupId": rollup.target_id,
        "rollupTitle": rollup.title,
        "dayStartMs": day_start_ms,
      });
      Ok((data, "Daily digest regenerated".to_string()))
    }
    "weekly-review" => {
      let week_start_ms = payload_week_start_ms(None);
      let rollup = summarizer::summarize_week_rollup(week_start_ms, "en").await?;
      let data = json!({
        "rollupId": rollup.target_id,
        "rollupTitle": rollup.title,
        "weekStartMs": week_start_ms,
      });
      Ok((data, "Weekly review regenerated".to_string()))
    }
    _ => Err(format!("Unknown agent id: {}", id)),
  };

  match result {
    Ok((data, summary)) => {
      let _ = record_agent_run(id, true, &summary);
      let mut out = data.as_object().cloned().unwrap_or_else(Map::new);
      out.insert("agentId".to_string(), json!(id));
      out.insert("summary".to_string(), json!(summary));
      out.insert("ok".to_string(), json!(true));
      Ok(Value::Object(out))
    }
    Err(e) => {
      let _ = record_agent_run(id, false, &e);
      Err(e)
    }
  }
}

fn payload_day_start_ms(raw: Option<i64>) -> i64 {
  if let Some(ms) = raw {
    if ms > 0 {
      return ms;
    }
  }
  let now = Utc::now();
  now.date_naive()
    .and_hms_opt(0, 0, 0)
    .map(|dt| dt.and_utc().timestamp_millis())
    .unwrap_or(now.timestamp_millis())
}

fn payload_week_start_ms(raw: Option<i64>) -> i64 {
  if let Some(ms) = raw {
    if ms > 0 {
      return ms;
    }
  }
  let now = Utc::now();
  let weekday = now.weekday().num_days_from_monday();
  let monday = now.date_naive() - chrono::Duration::days(weekday as i64);
  monday
    .and_hms_opt(0, 0, 0)
    .map(|dt| dt.and_utc().timestamp_millis())
    .unwrap_or(now.timestamp_millis())
}

pub async fn run_now_with_payload(payload: &Value) -> Result<Value, String> {
  let agent_id = payload
    .get("agentId")
    .or_else(|| payload.get("agent_id"))
    .and_then(|v| v.as_str())
    .unwrap_or("");
  if agent_id.is_empty() {
    return Err("agentId is required".to_string());
  }
  if agent_id == "daily-digest" {
    let day_start_ms = payload
      .get("dayStartMs")
      .and_then(|v| v.as_i64())
      .or_else(|| payload.get("day_start_ms").and_then(|v| v.as_i64()));
    let result = summarizer::summarize_day_rollup(payload_day_start_ms(day_start_ms), "en").await;
    return match result {
      Ok(rollup) => {
        let summary = "Daily digest regenerated".to_string();
        let _ = record_agent_run(agent_id, true, &summary);
        Ok(json!({
          "agentId": agent_id,
          "ok": true,
          "summary": summary,
          "rollupId": rollup.target_id,
          "rollupTitle": rollup.title,
          "dayStartMs": payload_day_start_ms(day_start_ms),
        }))
      }
      Err(e) => {
        let _ = record_agent_run(agent_id, false, &e);
        Err(e)
      }
    };
  }
  if agent_id == "weekly-review" {
    let week_start_ms = payload
      .get("weekStartMs")
      .and_then(|v| v.as_i64())
      .or_else(|| payload.get("week_start_ms").and_then(|v| v.as_i64()));
    let result =
      summarizer::summarize_week_rollup(payload_week_start_ms(week_start_ms), "en").await;
    return match result {
      Ok(rollup) => {
        let summary = "Weekly review regenerated".to_string();
        let _ = record_agent_run(agent_id, true, &summary);
        Ok(json!({
          "agentId": agent_id,
          "ok": true,
          "summary": summary,
          "rollupId": rollup.target_id,
          "rollupTitle": rollup.title,
          "weekStartMs": payload_week_start_ms(week_start_ms),
        }))
      }
      Err(e) => {
        let _ = record_agent_run(agent_id, false, &e);
        Err(e)
      }
    };
  }
  run_now(agent_id).await
}
