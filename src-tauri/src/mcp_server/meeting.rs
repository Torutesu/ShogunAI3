//! Meeting tool handlers (5 tools). Moved verbatim from the prior single-file
//! `mcp_server.rs`. No behavior change.

use super::{content_text, require_meeting_id};
use crate::meeting_store;
use serde_json::Value;

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

pub(super) fn handle_meetings_list(args: &Value) -> Result<Value, String> {
    let p = parse_meetings_list_args(args)?;
    let rows = meeting_store::list_meetings(p.from_ms, p.to_ms, p.limit)?;
    Ok(content_text(&serde_json::to_string(&rows).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_get(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let detail = meeting_store::get_meeting_detail(&id)?;
    Ok(content_text(&serde_json::to_string(&detail).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_transcript(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let segments = meeting_store::list_transcript_final(&id)?;
    Ok(content_text(&serde_json::to_string(&segments).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meeting_notes(args: &Value) -> Result<Value, String> {
    let id = require_meeting_id(args)?;
    let blocks = meeting_store::list_note_blocks(&id)?;
    Ok(content_text(&serde_json::to_string(&blocks).map_err(|e| e.to_string())?))
}

pub(super) fn handle_meetings_search(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "query is required (non-empty string)".to_string())?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(25);
    let hits = meeting_store::search_meetings_fts(query, limit)?;
    Ok(content_text(&serde_json::to_string(&hits).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn meetings_list_parses_valid_args() {
        let args = json!({ "from_ms": 1714435200000u64, "to_ms": 1714521600000u64, "limit": 10 });
        let parsed = super::parse_meetings_list_args(&args).expect("valid args");
        assert_eq!(parsed.from_ms, Some(1714435200000));
        assert_eq!(parsed.to_ms, Some(1714521600000));
        assert_eq!(parsed.limit, 10);
    }

    #[test]
    fn meetings_list_defaults_limit_when_missing() {
        let parsed = super::parse_meetings_list_args(&json!({})).expect("empty args ok");
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

    #[test]
    fn meeting_transcript_requires_meeting_id() {
        let err = dispatch("shogun.meeting_transcript", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meeting_notes_requires_meeting_id() {
        let err = dispatch("shogun.meeting_notes", &json!({})).unwrap_err();
        assert!(err.contains("meeting_id"), "got: {err}");
    }

    #[test]
    fn meetings_search_requires_query() {
        let err = dispatch("shogun.meetings_search", &json!({})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn meetings_search_rejects_empty_query() {
        let err = dispatch("shogun.meetings_search", &json!({ "query": "" })).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }
}
