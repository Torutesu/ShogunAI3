//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

mod meeting;
mod memory;

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => meeting::handle_meetings_list(args),
        "shogun.meeting_get" => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes" => meeting::handle_meeting_notes(args),
        "shogun.meetings_search" => meeting::handle_meetings_search(args),
        "shogun.memory_search" => memory::handle_search(args),
        "shogun.memory_fetch" => memory::handle_fetch(args),
        "shogun.memory_entities" => memory::handle_entities(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn require_meeting_id(args: &Value) -> Result<String, String> {
    args.get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "meeting_id is required (string)".to_string())
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
