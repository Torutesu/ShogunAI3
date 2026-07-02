//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

mod context;
mod kioku;
mod meeting;
mod memory;

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.search_context" => context::handle_search_context(args),
        "shogun.get_recent_context" => context::handle_get_recent_context(args),
        "shogun.get_customer_context" => context::handle_get_customer_context(args),
        "shogun.get_project_context" => context::handle_get_project_context(args),
        "shogun.get_meeting_summary" => context::handle_get_meeting_summary(args),
        "shogun.list_tasks" => context::handle_list_tasks(args),
        "shogun.meetings_list" => meeting::handle_meetings_list(args),
        "shogun.meeting_get" => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes" => meeting::handle_meeting_notes(args),
        "shogun.meetings_search" => meeting::handle_meetings_search(args),
        "shogun.memory_search" => memory::handle_search(args),
        "shogun.memory_search_timeline" => memory::handle_search_timeline(args),
        "shogun.memory_fetch" => memory::handle_fetch(args),
        "shogun.memory_entities" => memory::handle_entities(args),
        "shogun.ai_fields_list" => context::handle_ai_fields_list(args),
        "shogun.action_queue_list" => context::handle_action_queue_list(args),
        "shogun.action_audit_list" => context::handle_action_audit_list(args),
        "shogun.queue_artifacts_list" => context::handle_queue_artifacts_list(args),
        "shogun.owner_context_summary" => context::handle_owner_context_summary(args),
        "shogun.entity_context_get" => context::handle_entity_context_get(args),
        "shogun.kioku_debug_stats" => kioku::handle_debug_stats(args),
        "shogun.kioku_related" => kioku::handle_related(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn require_string_field(args: &Value, field: &str) -> Result<String, String> {
    args.get(field)
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("{field} is required (non-empty string)"))
}

/// Wrap a string payload in the MCP `content` shape.
fn content_text(s: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": s } ] })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tool_name_returns_error() {
        let err = dispatch("shogun.does_not_exist", &json!({})).unwrap_err();
        assert!(err.contains("unknown tool"), "got: {err}");
    }

    #[test]
    fn require_string_field_returns_value_when_present() {
        let v = require_string_field(&json!({"q": "hello"}), "q").unwrap();
        assert_eq!(v, "hello");
    }

    #[test]
    fn require_string_field_trims_whitespace() {
        let v = require_string_field(&json!({"q": "  hello  "}), "q").unwrap();
        assert_eq!(v, "hello");
    }

    #[test]
    fn require_string_field_rejects_missing() {
        let err = require_string_field(&json!({}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_empty() {
        let err = require_string_field(&json!({"q": ""}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_whitespace_only() {
        let err = require_string_field(&json!({"q": "   "}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }

    #[test]
    fn require_string_field_rejects_non_string() {
        let err = require_string_field(&json!({"q": 42}), "q").unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }
}
