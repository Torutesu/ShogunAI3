//! Memory tool handlers. Each handler is a thin pass-through to the
//! corresponding `memory_store::*` function, with arg validation up front
//! and the MCP `content` envelope on the way out.

use super::{content_text, require_string_field};
use crate::memory_store;
use serde_json::Value;

pub(super) fn handle_search(args: &Value) -> Result<Value, String> {
    let _ = require_string_field(args, "query")?;
    let result = memory_store::search(args)?;
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
}
