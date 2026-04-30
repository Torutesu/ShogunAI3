//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

mod meeting;

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => meeting::handle_meetings_list(args),
        "shogun.meeting_get" => meeting::handle_meeting_get(args),
        "shogun.meeting_transcript" => meeting::handle_meeting_transcript(args),
        "shogun.meeting_notes" => meeting::handle_meeting_notes(args),
        "shogun.meetings_search" => meeting::handle_meetings_search(args),
        _ => Err(format!("unknown tool: {name}")),
    }
}

fn require_meeting_id(args: &Value) -> Result<String, String> {
    args.get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "meeting_id is required (string)".to_string())
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
}
