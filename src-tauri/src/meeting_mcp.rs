//! JSON tool descriptors for external MCP clients (Claude Desktop, etc.).

use serde_json::{json, Value};

/// Six meeting tools from PRD §10 — names use `shogun.*` convention.
pub fn tool_definitions() -> Value {
  json!([
    {
      "name": "shogun.meetings_list",
      "description": "List saved meetings with optional time range.",
      "input_schema": {
        "type": "object",
        "properties": {
          "from_ms": { "type": "integer", "description": "Epoch ms lower bound (optional)" },
          "to_ms": { "type": "integer", "description": "Epoch ms upper bound (optional)" },
          "limit": { "type": "integer", "default": 25 }
        }
      }
    },
    {
      "name": "shogun.meeting_get",
      "description": "Meeting metadata + transcript + note blocks.",
      "input_schema": {
        "type": "object",
        "properties": { "meeting_id": { "type": "string" } },
        "required": ["meeting_id"]
      }
    },
    {
      "name": "shogun.meeting_transcript",
      "description": "Final transcript segments for a meeting.",
      "input_schema": {
        "type": "object",
        "properties": { "meeting_id": { "type": "string" } },
        "required": ["meeting_id"]
      }
    },
    {
      "name": "shogun.meeting_notes",
      "description": "Note blocks (user / ai / ai_edited) for a meeting.",
      "input_schema": {
        "type": "object",
        "properties": { "meeting_id": { "type": "string" } },
        "required": ["meeting_id"]
      }
    },
    {
      "name": "shogun.meetings_search",
      "description": "Keyword search across meeting titles, transcripts, and notes.",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "integer", "default": 25 }
        },
        "required": ["query"]
      }
    },
    {
      "name": "shogun.meeting_recipe_run",
      "description": "Run a builtin recipe (LLM) on a meeting.",
      "input_schema": {
        "type": "object",
        "properties": {
          "recipe_id": { "type": "string" },
          "meeting_id": { "type": "string" }
        },
        "required": ["recipe_id", "meeting_id"]
      }
    }
  ])
}
