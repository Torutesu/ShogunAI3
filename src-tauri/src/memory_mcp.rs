//! JSON tool descriptors for memory tools exposed via shogun-mcp.

use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "shogun.memory_search",
            "description": "Lexical search across memory items (notes, decisions, facts the user has captured). Returns ranked hits with snippets.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-form search terms" },
                    "kinds": { "type": "array", "items": { "type": "string" }, "description": "Optional filter on item kind" },
                    "scope": { "type": "string", "description": "Optional scope filter" },
                    "limit": { "type": "integer", "default": 25 }
                },
                "required": ["query"]
            }
        }
    ])
}
