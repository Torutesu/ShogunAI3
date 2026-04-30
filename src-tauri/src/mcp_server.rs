//! Tool dispatch for the shogun-mcp stdio binary.
//!
//! Each handler is a pure function: parse args, call existing `meeting_store::*`,
//! wrap the result in an MCP `content` block. No global state, no async.

use serde_json::{json, Value};

use crate::meeting_store;

#[derive(Debug)]
struct MeetingsListArgs {
    from_ms: Option<u64>,
    to_ms: Option<u64>,
    limit: usize,
}

fn parse_meetings_list_args(args: &Value) -> Result<MeetingsListArgs, String> {
    Ok(MeetingsListArgs {
        from_ms: args.get("from_ms").and_then(|v| v.as_u64()),
        to_ms: args.get("to_ms").and_then(|v| v.as_u64()),
        limit: args
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|n| n as usize)
            .unwrap_or(25),
    })
}

fn handle_meetings_list(args: &Value) -> Result<Value, String> {
    let p = parse_meetings_list_args(args)?;
    let rows = meeting_store::list_meetings(p.from_ms, p.to_ms, p.limit)?;
    Ok(content_text(&serde_json::to_string(&rows).map_err(|e| e.to_string())?))
}

/// Wrap a string payload in the MCP `content` shape.
fn content_text(s: &str) -> Value {
    json!({ "content": [ { "type": "text", "text": s } ] })
}

fn require_meeting_id(args: &Value) -> Result<String, String> {
    args.get("meeting_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "meeting_id is required (string)".to_string())
}

fn handle_meeting_get(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let detail = meeting_store::get_meeting_detail(&id)?;
    Ok(content_text(&serde_json::to_string(&detail).map_err(|e| e.to_string())?))
}

/// Dispatch a tool call by name. Returns the JSON-RPC `result` payload that
/// `rmcp` will return to the client (i.e. an object with a `content` array).
pub fn dispatch(name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "shogun.meetings_list" => handle_meetings_list(args),
        "shogun.meeting_get" => handle_meeting_get(args),
        _ => Err(format!("unknown tool: {name}")),
    }
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
    fn meetings_list_parses_valid_args() {
        let args = json!({ "from_ms": 1714435200000u64, "to_ms": 1714521600000u64, "limit": 10 });
        let parsed = parse_meetings_list_args(&args).expect("valid args");
        assert_eq!(parsed.from_ms, Some(1714435200000));
        assert_eq!(parsed.to_ms, Some(1714521600000));
        assert_eq!(parsed.limit, 10);
    }

    #[test]
    fn meetings_list_defaults_limit_when_missing() {
        let parsed = parse_meetings_list_args(&json!({})).expect("empty args ok");
        assert_eq!(parsed.from_ms, None);
        assert_eq!(parsed.to_ms, None);
        assert_eq!(parsed.limit, 25);
    }

    #[test]
    fn meeting_get_requires_meeting_id() {
        let err = dispatch("shogun.meeting_get", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meeting_get_rejects_non_string_meeting_id() {
        let err = dispatch("shogun.meeting_get", &json!({ "meeting_id": 42 })).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }
}
