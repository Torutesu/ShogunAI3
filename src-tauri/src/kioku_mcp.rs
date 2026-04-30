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
        }
    ])
}
