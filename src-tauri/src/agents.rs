//! Agent "Run now" dispatcher — maps demo agent ids to existing sync/rollup jobs
//! and persists last-run metadata under `settings.sections.agents.runs`.

use crate::{
    app_events, background_sync::now_ms, gmail, google_calendar, llm, settings_store,
    summarizer,
};
use chrono::{Datelike, Utc};
use serde_json::{json, Map, Value};
use std::time::Duration;

pub fn record_agent_run(agent_id: &str, ok: bool, summary: &str, source: &str) -> Result<(), String> {
    let at_ms = now_ms();
    let doc = settings_store::load()?;
    let mut runs = doc
        .pointer("/sections/agents/runs")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_else(Map::new);
    runs.insert(
        agent_id.to_string(),
        json!({
          "atMs": at_ms,
          "ok": ok,
          "summary": summary.chars().take(500).collect::<String>(),
          "source": source,
        }),
    );
    settings_store::save_patch(&json!({
      "section": "agents",
      "runs": Value::Object(runs),
    }))?;
    app_events::emit(
        "shogun-agents-runs-changed",
        json!({
          "agentId": agent_id,
          "atMs": at_ms,
          "ok": ok,
          "summary": summary,
          "source": source,
        }),
    );
    Ok(())
}

fn load_custom_agent(agent_id: &str) -> Result<Option<Value>, String> {
    let doc = settings_store::load()?;
    let items = doc
        .pointer("/sections/agents/customAgents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items.into_iter().find(|item| {
        item.get("id")
            .and_then(|v| v.as_str())
            .is_some_and(|id| id == agent_id)
    }))
}

fn build_custom_agent_draft_payload(
    agent: &Value,
    request_payload: &Value,
) -> Result<Value, String> {
    let agent_id = agent
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let agent_name = agent
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Custom Agent")
        .trim();
    let prompt = agent
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if prompt.is_empty() {
        return Err(format!("Custom agent '{}' is missing a prompt", agent_id));
    }

    let tool_names: Vec<String> = agent
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|tool| tool.get("name").and_then(|v| v.as_str()))
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let tool_hints = if tool_names.is_empty() {
        None
    } else {
        Some(format!("Tools: {}", tool_names.join(", ")))
    };
    let full_prompt = [Some(prompt.to_string()), tool_hints]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join("\n");

    let memory_assembly = if request_payload.get("memoryAssembly").is_some() {
        request_payload
            .get("memoryAssembly")
            .cloned()
            .unwrap_or(Value::Null)
    } else {
        json!({
          "query": agent_name,
          "limit": 14,
          "semantic": true,
        })
    };

    Ok(json!({
      "target": request_payload.get("target").cloned().unwrap_or_else(|| json!("agent_run")),
      "source": request_payload.get("source").cloned().unwrap_or_else(|| json!("custom_agent")),
      "title": request_payload
        .get("title")
        .cloned()
        .unwrap_or_else(|| json!(format!("Draft · {}", agent_name))),
      "prompt": full_prompt,
      "memoryAssembly": memory_assembly,
    }))
}

async fn run_custom_agent_now(agent: &Value, request_payload: &Value) -> Result<Value, String> {
    let agent_id = agent
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let agent_name = agent
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Custom Agent")
        .trim();
    let draft_payload = build_custom_agent_draft_payload(agent, request_payload)?;
    match llm::draft_from_payload(&draft_payload, None).await {
        Ok(draft) => {
            let summary = format!("Draft created for {}", agent_name);
            let run_source = request_payload
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("custom_agent");
            let _ = record_agent_run(agent_id, true, &summary, run_source);
            let mut out = draft.as_object().cloned().unwrap_or_else(Map::new);
            out.insert("agentId".to_string(), json!(agent_id));
            out.insert("summary".to_string(), json!(summary));
            out.insert("ok".to_string(), json!(true));
            out.insert("custom".to_string(), json!(true));
            Ok(Value::Object(out))
        }
        Err(e) => {
            let run_source = request_payload
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("custom_agent");
            let _ = record_agent_run(agent_id, false, &e, run_source);
            Err(e)
        }
    }
}

fn load_custom_agent_overrides() -> Result<Map<String, Value>, String> {
    let doc = settings_store::load()?;
    Ok(doc
        .pointer("/sections/agents/customAgentOverrides")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default())
}

fn load_agent_runs_map() -> Result<Map<String, Value>, String> {
    let doc = settings_store::load()?;
    Ok(doc
        .pointer("/sections/agents/runs")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default())
}

fn custom_agent_paused(agent_id: &str, overrides: &Map<String, Value>) -> bool {
    overrides
        .get(agent_id)
        .and_then(|v| v.get("paused"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn run_record_at_ms(agent_id: &str, runs: &Map<String, Value>, fallback: Option<u64>) -> Option<u64> {
    runs.get(agent_id)
        .and_then(|v| v.get("atMs"))
        .and_then(|v| v.as_u64())
        .or(fallback)
}

fn interval_trigger_due(trigger: &str, now_ms: u64, last_run_ms: Option<u64>) -> bool {
    let Some(caps) = regex_captures(trigger, r"^every (\d+) (minute|hour|day)s?$") else {
        return false;
    };
    let value = caps.0.parse::<u64>().unwrap_or(1).max(1);
    let unit_ms = match caps.1 {
        "minute" => 60_000,
        "day" => 24 * 60 * 60_000,
        _ => 60 * 60_000,
    };
    match last_run_ms {
        Some(last) => now_ms.saturating_sub(last) >= value.saturating_mul(unit_ms),
        None => true,
    }
}

fn daily_trigger_due(trigger: &str, now_ms: u64, last_run_ms: Option<u64>) -> bool {
    let Some(caps) = regex_captures(trigger, r"^(\d{2}):(\d{2}) daily$") else {
        return false;
    };
    let hour = caps.0.parse::<u32>().unwrap_or(0).min(23);
    let minute = caps.1.parse::<u32>().unwrap_or(0).min(59);
    let now = match chrono::DateTime::<Utc>::from_timestamp_millis(now_ms as i64) {
        Some(value) => value,
        None => return false,
    };
    let scheduled_today = now
        .date_naive()
        .and_hms_opt(hour, minute, 0)
        .map(|dt| dt.and_utc().timestamp_millis() as u64);
    let Some(scheduled_today) = scheduled_today else {
        return false;
    };
    if now_ms < scheduled_today {
        return false;
    }
    match last_run_ms {
        Some(last) => last < scheduled_today,
        None => true,
    }
}

fn weekly_trigger_due(trigger: &str, now_ms: u64, last_run_ms: Option<u64>) -> bool {
    if trigger.trim() != "weekly" {
        return false;
    }
    match last_run_ms {
        Some(last) => now_ms.saturating_sub(last) >= 7 * 24 * 60 * 60_000,
        None => true,
    }
}

fn event_trigger_source(trigger: &str) -> Option<&str> {
    trigger
        .trim()
        .strip_prefix("on ")
        .and_then(|rest| rest.strip_suffix(" event"))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn regex_captures<'a>(text: &'a str, pattern: &str) -> Option<(&'a str, &'a str)> {
    let re = regex::Regex::new(pattern).ok()?;
    let caps = re.captures(text.trim())?;
    Some((
        caps.get(1)?.as_str(),
        caps.get(2).map(|m| m.as_str()).unwrap_or(""),
    ))
}

fn custom_agent_due(agent: &Value, overrides: &Map<String, Value>, runs: &Map<String, Value>, now_ms: u64) -> bool {
    let agent_id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if agent_id.is_empty() || custom_agent_paused(agent_id, overrides) {
        return false;
    }
    let trigger = agent.get("trigger").and_then(|v| v.as_str()).unwrap_or("").trim();
    let fallback_last_run = agent.get("lastRunMs").and_then(|v| v.as_u64());
    let last_run_ms = run_record_at_ms(agent_id, runs, fallback_last_run);
    interval_trigger_due(trigger, now_ms, last_run_ms)
        || daily_trigger_due(trigger, now_ms, last_run_ms)
        || weekly_trigger_due(trigger, now_ms, last_run_ms)
}

fn custom_agent_matches_event_source(
    agent: &Value,
    overrides: &Map<String, Value>,
    source: &str,
) -> bool {
    let agent_id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
    if agent_id.is_empty() || custom_agent_paused(agent_id, overrides) {
        return false;
    }
    let trigger = agent.get("trigger").and_then(|v| v.as_str()).unwrap_or("").trim();
    event_trigger_source(trigger).is_some_and(|value| value == source)
}

async fn run_due_custom_agents_once() -> Result<usize, String> {
    let now = now_ms();
    let overrides = load_custom_agent_overrides()?;
    let runs = load_agent_runs_map()?;
    let doc = settings_store::load()?;
    let agents = doc
        .pointer("/sections/agents/customAgents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut executed = 0usize;
    for agent in agents {
        if !custom_agent_due(&agent, &overrides, &runs, now) {
            continue;
        }
        let _ = run_custom_agent_now(
            &agent,
            &json!({
              "target": "agent_run",
              "source": "custom_agent_background",
            }),
        )
        .await;
        executed += 1;
    }
    Ok(executed)
}

pub async fn run_event_triggered_custom_agents(source: &str) -> Result<usize, String> {
    let normalized = source.trim();
    if normalized.is_empty() {
        return Ok(0);
    }
    let overrides = load_custom_agent_overrides()?;
    let doc = settings_store::load()?;
    let agents = doc
        .pointer("/sections/agents/customAgents")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut executed = 0usize;
    for agent in agents {
        if !custom_agent_matches_event_source(&agent, &overrides, normalized) {
            continue;
        }
        let _ = run_custom_agent_now(
            &agent,
            &json!({
              "target": "agent_run",
              "source": format!("custom_agent_event:{normalized}"),
            }),
        )
        .await;
        executed += 1;
    }
    Ok(executed)
}

pub fn spawn_background_custom_agent_sync() {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        loop {
            if let Err(err) = run_due_custom_agents_once().await {
                log::warn!("custom agent background sync failed: {}", err);
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
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
            let _ = record_agent_run(id, true, &summary, "builtin_manual");
            let mut out = data.as_object().cloned().unwrap_or_else(Map::new);
            out.insert("agentId".to_string(), json!(id));
            out.insert("summary".to_string(), json!(summary));
            out.insert("ok".to_string(), json!(true));
            Ok(Value::Object(out))
        }
        Err(e) => {
            let _ = record_agent_run(id, false, &e, "builtin_manual");
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
    if let Some(agent) = load_custom_agent(agent_id)? {
        return run_custom_agent_now(&agent, payload).await;
    }
    if agent_id == "daily-digest" {
        let day_start_ms = payload
            .get("dayStartMs")
            .and_then(|v| v.as_i64())
            .or_else(|| payload.get("day_start_ms").and_then(|v| v.as_i64()));
        let result =
            summarizer::summarize_day_rollup(payload_day_start_ms(day_start_ms), "en").await;
        return match result {
            Ok(rollup) => {
                let summary = "Daily digest regenerated".to_string();
                let _ = record_agent_run(agent_id, true, &summary, "builtin_manual");
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
                let _ = record_agent_run(agent_id, false, &e, "builtin_manual");
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
                let _ = record_agent_run(agent_id, true, &summary, "builtin_manual");
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
                let _ = record_agent_run(agent_id, false, &e, "builtin_manual");
                Err(e)
            }
        };
    }
    run_now(agent_id).await
}

#[cfg(test)]
mod tests {
    use super::{
        build_custom_agent_draft_payload, custom_agent_due, custom_agent_matches_event_source,
        daily_trigger_due, event_trigger_source, interval_trigger_due, load_custom_agent,
        weekly_trigger_due,
    };
    use crate::settings_store::{save_patch, TestSettingsGuard};
    use serde_json::{json, Map, Value};

    #[test]
    fn loads_custom_agent_from_settings() {
        let _guard = TestSettingsGuard::new("agents-load-custom");
        save_patch(&json!({
          "section": "agents",
          "customAgents": [
            {
              "id": "custom-1",
              "name": "Follow Up Drafter",
              "icon": "spark",
              "status": "scheduled",
              "trigger": "every 1 hour",
              "triggerSince": "Saved",
              "description": "Drafts follow ups",
              "tools": [{ "name": "mail", "icon": "mail" }],
              "lastRunMs": null,
              "nextRunMs": null,
              "recentRuns": [],
              "isCustom": true,
              "prompt": "Draft a concise follow-up email"
            }
          ]
        }))
        .expect("save settings patch");

        let agent = load_custom_agent("custom-1")
            .expect("load custom agent")
            .expect("custom agent should exist");
        assert_eq!(
            agent.get("name").and_then(|v| v.as_str()),
            Some("Follow Up Drafter")
        );
    }

    #[test]
    fn builds_custom_agent_payload_with_tools_and_default_memory_query() {
        let payload = build_custom_agent_draft_payload(
            &json!({
              "id": "custom-1",
              "name": "Follow Up Drafter",
              "prompt": "Draft a concise follow-up email",
              "tools": [
                { "name": "mail", "icon": "mail" },
                { "name": "memory", "icon": "memory" }
              ]
            }),
            &json!({}),
        )
        .expect("build custom payload");

        assert_eq!(
            payload.get("target").and_then(|v| v.as_str()),
            Some("agent_run")
        );
        assert_eq!(
            payload.get("source").and_then(|v| v.as_str()),
            Some("custom_agent")
        );
        assert_eq!(
            payload
                .get("memoryAssembly")
                .and_then(|v| v.get("query"))
                .and_then(|v| v.as_str()),
            Some("Follow Up Drafter")
        );
        assert!(payload
            .get("prompt")
            .and_then(|v| v.as_str())
            .is_some_and(|value| value.contains("Tools: mail, memory")));
    }

    #[test]
    fn preserves_explicit_memory_assembly_override_for_custom_agent() {
        let payload = build_custom_agent_draft_payload(
            &json!({
              "id": "custom-1",
              "name": "Follow Up Drafter",
              "prompt": "Draft a concise follow-up email",
              "tools": []
            }),
            &json!({
              "memoryAssembly": null,
              "title": "Draft · Explicit Override"
            }),
        )
        .expect("build custom payload");

        assert!(payload.get("memoryAssembly").is_some_and(Value::is_null));
        assert_eq!(
            payload.get("title").and_then(|v| v.as_str()),
            Some("Draft · Explicit Override")
        );
    }

    #[test]
    fn interval_trigger_due_when_last_run_is_old_enough() {
        assert!(interval_trigger_due(
            "every 2 hours",
            10 * 60 * 60_000,
            Some(7 * 60 * 60_000)
        ));
        assert!(!interval_trigger_due(
            "every 2 hours",
            10 * 60 * 60_000,
            Some(9 * 60 * 60_000)
        ));
    }

    #[test]
    fn daily_trigger_due_once_per_day_after_scheduled_time() {
        let now = chrono::NaiveDate::from_ymd_opt(2026, 6, 30)
            .and_then(|d| d.and_hms_opt(10, 0, 0))
            .map(|dt| dt.and_utc().timestamp_millis() as u64)
            .expect("now");
        let ran_yesterday = chrono::NaiveDate::from_ymd_opt(2026, 6, 29)
            .and_then(|d| d.and_hms_opt(9, 5, 0))
            .map(|dt| dt.and_utc().timestamp_millis() as u64)
            .expect("yesterday");
        let ran_today = chrono::NaiveDate::from_ymd_opt(2026, 6, 30)
            .and_then(|d| d.and_hms_opt(9, 5, 0))
            .map(|dt| dt.and_utc().timestamp_millis() as u64)
            .expect("today");
        assert!(daily_trigger_due("09:00 daily", now, Some(ran_yesterday)));
        assert!(!daily_trigger_due("09:00 daily", now, Some(ran_today)));
    }

    #[test]
    fn weekly_trigger_due_after_seven_days() {
        assert!(weekly_trigger_due("weekly", 9 * 24 * 60 * 60_000, Some(1)));
        assert!(!weekly_trigger_due("weekly", 3 * 24 * 60 * 60_000, Some(1)));
    }

    #[test]
    fn custom_agent_due_respects_pause_override() {
        let agent = json!({
          "id": "custom-1",
          "trigger": "every 1 hour",
          "lastRunMs": null,
        });
        let overrides = serde_json::from_value::<Map<String, Value>>(json!({
          "custom-1": { "paused": true }
        }))
        .expect("overrides");
        assert!(!custom_agent_due(&agent, &overrides, &Map::new(), 5 * 60 * 60_000));
    }

    #[test]
    fn event_trigger_source_extracts_calendar_and_memory() {
        assert_eq!(event_trigger_source("on calendar event"), Some("calendar"));
        assert_eq!(event_trigger_source("on memory event"), Some("memory"));
        assert_eq!(event_trigger_source("every 1 hour"), None);
    }

    #[test]
    fn custom_agent_matches_event_source_respects_pause_override() {
        let agent = json!({
          "id": "custom-1",
          "trigger": "on memory event",
        });
        assert!(custom_agent_matches_event_source(&agent, &Map::new(), "memory"));
        let paused = serde_json::from_value::<Map<String, Value>>(json!({
          "custom-1": { "paused": true }
        }))
        .expect("paused overrides");
        assert!(!custom_agent_matches_event_source(&agent, &paused, "memory"));
        assert!(!custom_agent_matches_event_source(&agent, &Map::new(), "calendar"));
    }
}
