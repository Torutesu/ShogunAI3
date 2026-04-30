//! JSON tool descriptors for kioku tools exposed via shogun-mcp.

use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "shogun.kioku_debug_stats",
            "description": "One-shot snapshot of the memory subsystem health: capture/extraction queue, monthly cost ledger, graph node/edge totals, active rules, and feature flags.",
            "input_schema": {
                "type": "object",
                "properties": {}
            }
        },
        {
            "name": "shogun.kioku_related",
            "description": "Find memory items related to a seed via the kioku knowledge graph (decision-graph traversal + decay-aware ranking). Provide either a `query` (lexical entry-point pick) or `seed_ids` (explicit entry points). Returns ranked items with bodies inlined so no follow-up `memory_fetch` is needed.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query — entry nodes are picked via lexical match (top 5 hits)" },
                    "seed_ids": { "type": "array", "items": { "type": "string" }, "description": "Memory item IDs to use as graph entry points" },
                    "limit": { "type": "integer", "default": 10, "description": "Max ranked hits returned" },
                    "max_depth": { "type": "integer", "default": 2, "description": "Graph traversal depth (clamped to 1..=3)" },
                    "kinds": { "type": "array", "items": { "type": "string" }, "description": "Optional node-kind filter applied between traversal and ranking" }
                }
            }
        }
    ])
}
