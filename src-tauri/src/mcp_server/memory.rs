//! Memory tool handlers. Each handler is a thin pass-through to the
//! corresponding `memory_store::*` function, with arg validation up front
//! and the MCP `content` envelope on the way out.

use super::{content_text, require_string_field};
use crate::memory_store;
use serde_json::Value;

pub(super) fn handle_fetch(args: &Value) -> Result<Value, String> {
    let ids = args
        .get("ids")
        .and_then(|v| v.as_array())
        .filter(|arr| !arr.is_empty())
        .ok_or_else(|| "ids is required (non-empty array)".to_string())?;
    // Confirm every element is a string for a clearer error than what
    // memory_store::fetch would surface.
    for v in ids {
        if !v.is_string() {
            return Err("ids must be an array of strings".to_string());
        }
    }
    let result = memory_store::fetch(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}

pub(super) fn handle_search(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "query")?;
    let result = memory_store::search(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}

pub(super) fn handle_entities(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "q")?;
    let result = memory_store::entities_from_catalog(args)?;
    Ok(content_text(&serde_json::to_string(&result).map_err(|e| e.to_string())?))
}

#[cfg(test)]
mod tests {
    use super::super::dispatch;
    use serde_json::json;

    #[test]
    fn memory_search_requires_query() {
        let err = dispatch("shogun.memory_search", &json!({})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn memory_search_rejects_empty_query() {
        let err = dispatch("shogun.memory_search", &json!({"query": ""})).unwrap_err();
        assert!(err.contains("query"), "got: {err}");
    }

    #[test]
    fn memory_fetch_requires_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }

    #[test]
    fn memory_fetch_rejects_empty_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({"ids": []})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }

    #[test]
    fn memory_fetch_rejects_non_array_ids() {
        let err = dispatch("shogun.memory_fetch", &json!({"ids": "abc"})).unwrap_err();
        assert!(err.contains("ids"), "got: {err}");
    }

    #[test]
    fn memory_entities_requires_q() {
        let err = dispatch("shogun.memory_entities", &json!({})).unwrap_err();
        assert!(err.contains("q is required"), "got: {err}");
    }
}
