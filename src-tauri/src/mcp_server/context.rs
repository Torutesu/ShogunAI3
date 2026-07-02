//! Shared context-layer MCP tool handlers.

use super::{content_text, require_string_field};
use crate::{ai_fields, context_actions, context_queries, entity_context};
use serde_json::Value;

pub(super) fn handle_search_context(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "query")?;
    let result = context_queries::search_context(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_get_recent_context(args: &Value) -> Result<Value, String> {
    let result = context_queries::get_recent_context(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_get_customer_context(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "entityId")?;
    let result = entity_context::get_entity_context(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_get_project_context(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "entityId")?;
    let result = entity_context::get_entity_context(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_get_meeting_summary(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "meeting_id")?;
    let result = context_queries::get_meeting_summary(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_list_tasks(args: &Value) -> Result<Value, String> {
    let result = context_queries::list_tasks(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_ai_fields_list(args: &Value) -> Result<Value, String> {
    let result = ai_fields::list_ai_fields(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_action_queue_list(args: &Value) -> Result<Value, String> {
    let result = context_actions::list_context_actions(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_action_audit_list(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "actionId")?;
    let result = context_actions::list_context_action_audit(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_queue_artifacts_list(args: &Value) -> Result<Value, String> {
    let result = context_queries::list_queue_artifacts(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_owner_context_summary(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "ownerEntityId")?;
    let result = context_queries::owner_context_summary(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

pub(super) fn handle_entity_context_get(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "entityId")?;
    let result = entity_context::get_entity_context(args)?;
    Ok(content_text(
        &serde_json::to_string(&result).map_err(|e| e.to_string())?,
    ))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn search_context_requires_query() {
        let err = dispatch("shogun.search_context", &json!({})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn search_context_returns_extended_sections() {
        let out = dispatch(
            "shogun.search_context",
            &json!({ "query": "unlikely-query-token", "limit": 2 }),
        )
        .expect("dispatch");
        let text = out["content"][0]["text"].as_str().expect("text");
        let parsed: serde_json::Value = serde_json::from_str(text).expect("json");
        assert!(parsed.get("queueArtifacts").is_some());
        assert!(parsed.get("latestAudits").is_some());
    }

    #[test]
    fn customer_context_requires_entity_id() {
        let err = dispatch("shogun.get_customer_context", &json!({})).unwrap_err();
        assert!(err.contains("entityId"), "got: {err}");
    }

    #[test]
    fn project_context_requires_entity_id() {
        let err = dispatch("shogun.get_project_context", &json!({})).unwrap_err();
        assert!(err.contains("entityId"), "got: {err}");
    }

    #[test]
    fn meeting_summary_requires_meeting_id() {
        let err = dispatch("shogun.get_meeting_summary", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn action_audit_requires_action_id() {
        let err = dispatch("shogun.action_audit_list", &json!({})).unwrap_err();
        assert!(err.contains("actionId"), "got: {err}");
    }

    #[test]
    fn entity_context_requires_entity_id() {
        let err = dispatch("shogun.entity_context_get", &json!({})).unwrap_err();
        assert!(err.contains("entityId"), "got: {err}");
    }

    #[test]
    fn queue_artifacts_list_returns_json_payload() {
        let out =
            dispatch("shogun.queue_artifacts_list", &json!({ "limit": 5 })).expect("dispatch");
        let text = out["content"][0]["text"].as_str().expect("text");
        let parsed: serde_json::Value = serde_json::from_str(text).expect("json");
        assert!(parsed.get("items").and_then(|v| v.as_array()).is_some());
        assert_eq!(
            parsed["total"].as_u64(),
            parsed["items"].as_array().map(|items| items.len() as u64)
        );
    }

    #[test]
    fn owner_context_summary_requires_owner_entity_id() {
        let err = dispatch("shogun.owner_context_summary", &json!({})).unwrap_err();
        assert!(err.contains("ownerEntityId"), "got: {err}");
    }
}
