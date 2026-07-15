use crate::{
    ai_fields, context_actions, crm_update_queue, entity_context, meeting_store, memory_store,
    schedule_queue,
};
use serde_json::{json, Map, Value};

fn optional_string_arg(args: &Value, field: &str) -> Option<String> {
    args.get(field)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
}

fn optional_string_list(args: &Value, field: &str) -> Option<Vec<String>> {
    args.get(field)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::trim))
                .filter(|item| !item.is_empty())
                .map(|item| item.to_ascii_lowercase())
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
}

fn limit_arg(args: &Value, default_limit: u64, max_limit: u64) -> u64 {
    args.get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(default_limit)
        .clamp(1, max_limit)
}

fn meeting_id_from_owner_entity(owner_entity_id: Option<&str>) -> Option<&str> {
    owner_entity_id.and_then(|owner| owner.strip_prefix("meeting:"))
}

fn queue_item_provenance(source_action_id: &str) -> Result<Value, String> {
    let action_result = context_actions::list_context_actions(&json!({
      "id": source_action_id,
      "limit": 1,
    }))?;
    let action = action_result
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);

    let latest_audit_result = context_actions::list_context_action_audit(&json!({
      "actionId": source_action_id,
      "limit": 1,
    }))?;
    let latest_audit = latest_audit_result
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
        .cloned()
        .unwrap_or(Value::Null);

    Ok(json!({
      "sourceAction": action,
      "latestAudit": latest_audit,
    }))
}

pub(crate) fn search_context(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "query is required".to_string())?
        .to_string();
    let owner_entity_id = optional_string_arg(args, "ownerEntityId");
    let include = optional_string_list(args, "include");
    let wants = |key: &str| {
        include
            .as_ref()
            .map(|items| items.iter().any(|item| item == key))
            .unwrap_or(true)
    };
    let limit = limit_arg(args, 10, 50);

    let timeline = if wants("timeline") {
        memory_store::search_timeline(&json!({
          "query": query,
          "limit": limit,
        }))?
    } else {
        json!({ "hits": [], "total": 0 })
    };

    let ai_fields_result = if wants("ai_fields") {
        let mut payload = Map::new();
        payload.insert("query".to_string(), json!(query));
        payload.insert("limit".to_string(), json!(limit));
        if let Some(owner) = owner_entity_id.as_ref() {
            payload.insert("ownerEntityId".to_string(), json!(owner));
        }
        ai_fields::list_ai_fields(&Value::Object(payload))?
    } else {
        json!({ "items": [], "total": 0 })
    };

    let actions_result = if wants("actions") {
        let mut payload = Map::new();
        payload.insert("query".to_string(), json!(query));
        payload.insert("limit".to_string(), json!(limit));
        if let Some(owner) = owner_entity_id.as_ref() {
            payload.insert("ownerEntityId".to_string(), json!(owner));
        }
        context_actions::list_context_actions(&Value::Object(payload))?
    } else {
        json!({ "items": [], "total": 0 })
    };

    let queue_artifacts_result = if wants("queue_artifacts") {
        let listed = list_queue_artifacts(&json!({
          "ownerEntityId": owner_entity_id,
          "limit": limit,
        }))?;
        let query_lower = query.to_ascii_lowercase();
        let matched_items = listed
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                let title = item
                    .get("payload")
                    .and_then(|payload| payload.get("title"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let detail = item
                    .get("payload")
                    .and_then(|payload| payload.get("detail"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let owner = item
                    .get("payload")
                    .and_then(|payload| payload.get("owner_entity_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                title.contains(&query_lower)
                    || detail.contains(&query_lower)
                    || owner.contains(&query_lower)
            })
            .take(limit as usize)
            .collect::<Vec<_>>();
        json!({
          "items": matched_items,
          "total": matched_items.len(),
        })
    } else {
        json!({ "items": [], "total": 0 })
    };

    let latest_audits_result = if wants("audits") {
        let action_items = actions_result
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let latest_items = action_items
            .iter()
            .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
            .take(limit as usize)
            .map(|action_id| {
                let latest = context_actions::list_context_action_audit(&json!({
                  "actionId": action_id,
                  "limit": 1,
                }))?
                .get("items")
                .and_then(|v| v.as_array())
                .and_then(|items| items.first())
                .cloned()
                .unwrap_or(Value::Null);
                Ok(json!({
                  "actionId": action_id,
                  "latestAudit": latest,
                }))
            })
            .collect::<Result<Vec<Value>, String>>()?;
        json!({
          "items": latest_items,
          "total": latest_items.len(),
        })
    } else {
        json!({ "items": [], "total": 0 })
    };

    Ok(json!({
      "query": query,
      "ownerEntityId": owner_entity_id,
      "timeline": timeline,
      "aiFields": ai_fields_result,
      "actions": actions_result,
      "queueArtifacts": queue_artifacts_result,
      "latestAudits": latest_audits_result,
    }))
}

pub(crate) fn get_recent_context(args: &Value) -> Result<Value, String> {
    let owner_entity_id = optional_string_arg(args, "ownerEntityId");
    let limit = limit_arg(args, 8, 50);

    let mut ai_fields_payload = Map::new();
    ai_fields_payload.insert("limit".to_string(), json!(limit));
    if let Some(owner) = owner_entity_id.as_ref() {
        ai_fields_payload.insert("ownerEntityId".to_string(), json!(owner));
    }

    let mut actions_payload = Map::new();
    actions_payload.insert("limit".to_string(), json!(limit));
    if let Some(owner) = owner_entity_id.as_ref() {
        actions_payload.insert("ownerEntityId".to_string(), json!(owner));
    }

    let entity_bundle = if let Some(owner) = owner_entity_id.as_ref() {
        entity_context::get_entity_context(&json!({
          "entityId": owner,
          "entityLabel": owner,
          "limit": limit,
        }))?
    } else {
        Value::Null
    };

    let recent_meetings =
        if let Some(meeting_id) = meeting_id_from_owner_entity(owner_entity_id.as_deref()) {
            meeting_store::get_meeting_detail(meeting_id)?
                .map(|meeting| vec![meeting])
                .unwrap_or_default()
        } else {
            meeting_store::list_meetings(None, None, limit as usize)?
        };

    Ok(json!({
      "ownerEntityId": owner_entity_id,
      "entityContext": entity_bundle,
      "recentAiFields": ai_fields::list_ai_fields(&Value::Object(ai_fields_payload))?,
      "recentActions": context_actions::list_context_actions(&Value::Object(actions_payload))?,
      "recentQueueArtifacts": list_queue_artifacts(&json!({
        "ownerEntityId": owner_entity_id,
        "limit": limit,
      }))?,
      "recentMeetings": recent_meetings,
    }))
}

pub(crate) fn list_tasks(args: &Value) -> Result<Value, String> {
    let owner_entity_id = optional_string_arg(args, "ownerEntityId");
    let query = optional_string_arg(args, "query");
    let statuses = optional_string_list(args, "statuses")
        .unwrap_or_else(|| vec!["proposed".to_string(), "approved".to_string()]);
    let limit = limit_arg(args, 20, 100) as usize;

    let mut payload = Map::new();
    payload.insert(
        "limit".to_string(),
        json!((limit.saturating_mul(4)).clamp(limit, 100)),
    );
    if let Some(owner) = owner_entity_id.as_ref() {
        payload.insert("ownerEntityId".to_string(), json!(owner));
    }
    if let Some(q) = query.as_ref() {
        payload.insert("query".to_string(), json!(q));
    }

    let listed = context_actions::list_context_actions(&Value::Object(payload))?;
    let items = listed
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| {
            item.get("status")
                .and_then(|v| v.as_str())
                .map(|status| statuses.iter().any(|candidate| candidate == status))
                .unwrap_or(false)
        })
        .take(limit)
        .collect::<Vec<_>>();

    Ok(json!({
      "ownerEntityId": owner_entity_id,
      "query": query,
      "statuses": statuses,
      "items": items,
      "total": items.len(),
    }))
}

pub(crate) fn get_meeting_summary(args: &Value) -> Result<Value, String> {
    let meeting_id = args
        .get("meeting_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "meeting_id is required".to_string())?;
    meeting_store::get_meeting_detail(meeting_id)?
        .ok_or_else(|| format!("meeting not found: {meeting_id}"))
}

pub(crate) fn list_queue_artifacts(args: &Value) -> Result<Value, String> {
    let owner_entity_id = optional_string_arg(args, "ownerEntityId");
    let queue_kind = optional_string_arg(args, "queueKind")
        .map(|value| value.to_ascii_lowercase())
        .filter(|value| value == "tasks" || value == "crm_updates");
    let limit = limit_arg(args, 20, 100);

    let task_items = if queue_kind.as_deref() == Some("crm_updates") {
        Vec::new()
    } else {
        schedule_queue::list(&json!({ "limit": limit }))?
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };

    let crm_items = if queue_kind.as_deref() == Some("tasks") {
        Vec::new()
    } else {
        crm_update_queue::list(&json!({ "limit": limit }))?
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };

    let owner_matches = |item: &Value| {
        owner_entity_id
            .as_ref()
            .map(|owner| {
                item.get("payload")
                    .and_then(|payload| payload.get("owner_entity_id"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .map(|value| value == owner)
                    .unwrap_or(false)
            })
            .unwrap_or(true)
    };

    let mut items = task_items
        .into_iter()
        .filter(owner_matches)
        .map(|item| {
            let mut object = item.as_object().cloned().unwrap_or_default();
            object.insert("queueKind".to_string(), json!("tasks"));
            if let Some(source_action_id) = object
                .get("payload")
                .and_then(|payload| payload.get("source_action_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                object.insert(
                    "provenance".to_string(),
                    queue_item_provenance(source_action_id).unwrap_or(Value::Null),
                );
            }
            Value::Object(object)
        })
        .chain(crm_items.into_iter().filter(owner_matches).map(|item| {
            let mut object = item.as_object().cloned().unwrap_or_default();
            object.insert("queueKind".to_string(), json!("crm_updates"));
            if let Some(source_action_id) = object
                .get("payload")
                .and_then(|payload| payload.get("source_action_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                object.insert(
                    "provenance".to_string(),
                    queue_item_provenance(source_action_id).unwrap_or(Value::Null),
                );
            }
            Value::Object(object)
        }))
        .collect::<Vec<_>>();

    items.sort_by(|a, b| {
        let a_created = a.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        let b_created = b.get("createdAt").and_then(|v| v.as_u64()).unwrap_or(0);
        b_created.cmp(&a_created)
    });
    items.truncate(limit as usize);

    Ok(json!({
      "ownerEntityId": owner_entity_id,
      "queueKind": queue_kind,
      "items": items,
      "total": items.len(),
    }))
}

pub(crate) fn owner_context_summary(args: &Value) -> Result<Value, String> {
    let owner_entity_id = args
        .get("ownerEntityId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "ownerEntityId is required".to_string())?
        .to_string();
    let limit = limit_arg(args, 6, 20);

    let entity_context_result = entity_context::get_entity_context(&json!({
      "entityId": owner_entity_id,
      "entityLabel": owner_entity_id,
      "limit": limit,
    }))?;
    let ai_fields_result = ai_fields::list_ai_fields(&json!({
      "ownerEntityId": owner_entity_id,
      "limit": limit,
    }))?;
    let actions_result = context_actions::list_context_actions(&json!({
      "ownerEntityId": owner_entity_id,
      "limit": limit,
    }))?;
    let queue_result = list_queue_artifacts(&json!({
      "ownerEntityId": owner_entity_id,
      "limit": limit,
    }))?;

    let action_items = actions_result
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let latest_audits = action_items
        .iter()
        .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
        .take(limit as usize)
        .map(|action_id| {
            let latest_audit = context_actions::list_context_action_audit(&json!({
              "actionId": action_id,
              "limit": 1,
            }))?
            .get("items")
            .and_then(|v| v.as_array())
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null);
            Ok(json!({
              "actionId": action_id,
              "latestAudit": latest_audit,
            }))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    let action_status_counts = action_items.iter().fold(
        json!({
          "proposed": 0,
          "approved": 0,
          "executed": 0,
          "rejected": 0
        }),
        |mut acc, item| {
            if let Some(status) = item.get("status").and_then(|v| v.as_str()) {
                let current = acc.get(status).and_then(|v| v.as_u64()).unwrap_or(0);
                if let Some(map) = acc.as_object_mut() {
                    map.insert(status.to_string(), json!(current + 1));
                }
            }
            acc
        },
    );

    Ok(json!({
      "ownerEntityId": owner_entity_id,
      "entityContext": entity_context_result,
      "aiFields": ai_fields_result,
      "actions": actions_result,
      "queueArtifacts": queue_result,
      "latestAudits": latest_audits,
      "summary": {
        "aiFieldCount": ai_fields_result.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
        "actionCount": action_items.len(),
        "queueArtifactCount": queue_result.get("total").and_then(|v| v.as_u64()).unwrap_or(0),
        "actionStatusCounts": action_status_counts
      }
    }))
}

#[cfg(test)]
mod tests {
    use super::{get_recent_context, list_queue_artifacts, owner_context_summary};
    use crate::{
        ai_fields, context_actions, crm_update_queue, memory_store::testkit::TestDbGuard,
        paths::testkit::TestAppDataGuard, schedule_queue,
    };
    use serde_json::json;

    #[test]
    fn owner_context_summary_aggregates_shared_context_state() {
        let _db = TestDbGuard::new("owner-context-summary");
        let _app_data = TestAppDataGuard::new("owner-context-summary");

        ai_fields::upsert_ai_field(&json!({
          "ownerEntityId": "workspace:apollo",
          "fieldName": "next_action",
          "instruction": "Track the next action for Apollo.",
          "currentValue": "Prepare customer follow-up",
          "confidence": 0.81,
          "evidenceEventIds": ["meeting:mtg-42"]
        }))
        .expect("seed ai field");

        let action = context_actions::propose_context_action(&json!({
          "ownerEntityId": "workspace:apollo",
          "actionType": "create_task",
          "title": "Queue follow-up task",
          "detail": "Turn the Apollo meeting into a tracked task.",
          "riskLevel": "medium",
          "evidenceEventIds": ["meeting:mtg-42"]
        }))
        .expect("seed action");
        let action_id = action["item"]["id"].as_str().expect("action id");

        schedule_queue::append(&json!({
          "owner_entity_id": "workspace:apollo",
          "title": "Queued task from Apollo",
          "detail": "Follow up on the open blocker",
          "source_action_id": action_id
        }))
        .expect("seed queue");

        let result = owner_context_summary(&json!({
          "ownerEntityId": "workspace:apollo",
          "limit": 6
        }))
        .expect("owner summary");

        assert_eq!(result["ownerEntityId"].as_str(), Some("workspace:apollo"));
        assert_eq!(
            result["entityContext"]["entityId"].as_str(),
            Some("workspace:apollo")
        );
        assert_eq!(result["summary"]["aiFieldCount"].as_u64(), Some(1));
        assert_eq!(result["summary"]["actionCount"].as_u64(), Some(1));
        assert_eq!(result["summary"]["queueArtifactCount"].as_u64(), Some(1));
        assert_eq!(
            result["summary"]["actionStatusCounts"]["proposed"].as_u64(),
            Some(1)
        );
        assert_eq!(
            result["latestAudits"][0]["latestAudit"]["eventType"].as_str(),
            Some("proposed")
        );
        assert_eq!(
            result["queueArtifacts"]["items"][0]["provenance"]["sourceAction"]["id"].as_str(),
            Some(action_id)
        );
    }

    #[test]
    fn get_recent_context_scopes_results_to_owner_entity() {
        let _db = TestDbGuard::new("recent-context");
        let _app_data = TestAppDataGuard::new("recent-context");

        ai_fields::upsert_ai_field(&json!({
          "ownerEntityId": "meeting:mtg-77",
          "fieldName": "blocker",
          "instruction": "Track unresolved meeting blocker.",
          "currentValue": "Security review pending"
        }))
        .expect("seed meeting field");
        ai_fields::upsert_ai_field(&json!({
          "ownerEntityId": "workspace:apollo",
          "fieldName": "next_action",
          "instruction": "Track workspace next action.",
          "currentValue": "Draft summary"
        }))
        .expect("seed workspace field");

        let conn = crate::memory_store::open_conn().expect("open conn");
        conn.execute(
            "INSERT INTO meetings
              (id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state, client_storage_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                "mtg-77",
                1710000000000_i64,
                1710003600000_i64,
                "com.shogun.calendar",
                Option::<String>::None,
                "Aurora sync",
                "[]",
                "completed",
                Option::<String>::None,
            ],
        )
        .expect("insert scoped meeting");
        conn.execute(
            "INSERT INTO meetings
              (id, started_at, ended_at, app_bundle_id, template_id, title, participants_json, state, client_storage_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                "mtg-99",
                1711000000000_i64,
                1711003600000_i64,
                "com.shogun.calendar",
                Option::<String>::None,
                "Other sync",
                "[]",
                "completed",
                Option::<String>::None,
            ],
        )
        .expect("insert other meeting");
        drop(conn);

        let result = get_recent_context(&json!({
          "ownerEntityId": "meeting:mtg-77",
          "limit": 5
        }))
        .expect("recent context");

        assert_eq!(result["ownerEntityId"].as_str(), Some("meeting:mtg-77"));
        assert_eq!(
            result["entityContext"]["entityId"].as_str(),
            Some("meeting:mtg-77")
        );
        assert_eq!(result["recentAiFields"]["total"].as_u64(), Some(1));
        assert_eq!(
            result["recentAiFields"]["items"][0]["ownerEntityId"].as_str(),
            Some("meeting:mtg-77")
        );
        assert_eq!(
            result["recentMeetings"].as_array().map(|items| items.len()),
            Some(1)
        );
        let meeting_id = result["recentMeetings"][0]
            .get("id")
            .and_then(|value| value.as_str())
            .or_else(|| {
                result["recentMeetings"][0]
                    .get("meeting")
                    .and_then(|meeting| meeting.get("id"))
                    .and_then(|value| value.as_str())
            });
        assert_eq!(meeting_id, Some("mtg-77"));
    }

    #[test]
    fn get_recent_context_includes_recent_queue_artifacts_with_provenance() {
        let _db = TestDbGuard::new("recent-context-queue-artifacts");
        let _app_data = TestAppDataGuard::new("recent-context-queue-artifacts");

        let action = context_actions::propose_context_action(&json!({
          "ownerEntityId": "workspace:apollo",
          "actionType": "queue_crm_update",
          "title": "Queue Apollo CRM update",
          "detail": "Push Apollo diligence notes into CRM.",
          "riskLevel": "medium",
          "evidenceEventIds": ["meeting:mtg-42"]
        }))
        .expect("seed action");
        let action_id = action["item"]["id"].as_str().expect("action id");

        schedule_queue::append(&json!({
          "owner_entity_id": "workspace:apollo",
          "title": "Queued Apollo follow-up",
          "detail": "Prepare task handoff",
          "source_action_id": action_id
        }))
        .expect("seed task queue");

        crm_update_queue::append(&json!({
          "owner_entity_id": "workspace:apollo",
          "title": "Queue Apollo CRM update",
          "detail": "Push Apollo diligence notes into CRM.",
          "source_action_id": action_id
        }))
        .expect("seed crm queue");

        let result = get_recent_context(&json!({
          "ownerEntityId": "workspace:apollo",
          "limit": 6
        }))
        .expect("recent context");

        assert_eq!(result["recentQueueArtifacts"]["total"].as_u64(), Some(2));
        assert_eq!(
            result["recentQueueArtifacts"]["items"][0]["payload"]["owner_entity_id"].as_str(),
            Some("workspace:apollo")
        );
        assert_eq!(
            result["recentQueueArtifacts"]["items"][0]["provenance"]["sourceAction"]["id"].as_str(),
            Some(action_id)
        );
        assert_eq!(
            result["recentQueueArtifacts"]["items"][1]["provenance"]["latestAudit"]["eventType"]
                .as_str(),
            Some("proposed")
        );
    }

    #[test]
    fn list_queue_artifacts_filters_by_queue_kind_and_owner() {
        let _db = TestDbGuard::new("queue-artifacts-filtering");
        let _app_data = TestAppDataGuard::new("queue-artifacts-filtering");

        let action = context_actions::propose_context_action(&json!({
          "ownerEntityId": "workspace:apollo",
          "actionType": "create_task",
          "title": "Queue artifact filter seed",
          "detail": "Seed action for queue artifact tests.",
          "riskLevel": "low"
        }))
        .expect("seed action");
        let action_id = action["item"]["id"].as_str().expect("action id");

        schedule_queue::append(&json!({
          "owner_entity_id": "workspace:apollo",
          "title": "Apollo task queue item",
          "detail": "Task queue artifact",
          "source_action_id": action_id
        }))
        .expect("seed task queue");
        crm_update_queue::append(&json!({
          "owner_entity_id": "workspace:apollo",
          "title": "Apollo crm queue item",
          "detail": "CRM queue artifact",
          "source_action_id": action_id
        }))
        .expect("seed crm queue");
        schedule_queue::append(&json!({
          "owner_entity_id": "workspace:other",
          "title": "Other workspace queue item",
          "detail": "Should be filtered out",
          "source_action_id": action_id
        }))
        .expect("seed other queue");

        let task_result = list_queue_artifacts(&json!({
          "ownerEntityId": "workspace:apollo",
          "queueKind": "tasks",
          "limit": 10
        }))
        .expect("task queue artifacts");
        let crm_result = list_queue_artifacts(&json!({
          "ownerEntityId": "workspace:apollo",
          "queueKind": "crm_updates",
          "limit": 10
        }))
        .expect("crm queue artifacts");

        assert_eq!(task_result["total"].as_u64(), Some(1));
        assert_eq!(task_result["items"][0]["queueKind"].as_str(), Some("tasks"));
        assert_eq!(
            task_result["items"][0]["payload"]["owner_entity_id"].as_str(),
            Some("workspace:apollo")
        );

        assert_eq!(crm_result["total"].as_u64(), Some(1));
        assert_eq!(
            crm_result["items"][0]["queueKind"].as_str(),
            Some("crm_updates")
        );
        assert_eq!(
            crm_result["items"][0]["payload"]["title"].as_str(),
            Some("Apollo crm queue item")
        );
    }
}
