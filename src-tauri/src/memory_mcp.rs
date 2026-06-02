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
        },
        {
            "name": "shogun.memory_search_timeline",
            "description": "Unified timeline search across memory items and meeting transcripts. Returns ranked hits with snippets from both sources.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-form search terms" },
                    "limit": { "type": "integer", "default": 25 },
                    "start_ms": { "type": "integer", "description": "Optional epoch-ms window start" },
                    "end_ms": { "type": "integer", "description": "Optional epoch-ms window end" },
                    "content_types": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional filter: memory | meeting"
                    }
                },
                "required": ["query"]
            }
        },
        {
            "name": "shogun.memory_fetch",
            "description": "Retrieve full content of memory items by ID. Typically called after `shogun.memory_search` returns hits.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ids": { "type": "array", "items": { "type": "string" }, "description": "Memory item IDs" }
                },
                "required": ["ids"]
            }
        },
        {
            "name": "shogun.memory_entities",
            "description": "Search the entity catalog (people, organizations, projects extracted across memories). Returns matched entities with their occurrence counts.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "q": { "type": "string", "description": "Entity name or partial query" }
                },
                "required": ["q"]
            }
        }
    ])
}
