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
        "description": "Run a builtin LLM recipe on a meeting and return the rendered output. Recipes operate over the meeting's transcript ± notes ± related memory hits depending on the recipe. Calls a remote LLM (uses configured API keys; costs billed to the user). Latency typically several seconds.",
        "input_schema": {
          "type": "object",
          "properties": {
            "recipe_id": {
              "type": "string",
              "enum": ["rec-coach-me", "rec-follow-up-email", "rec-action-items", "rec-feature-digest", "rec-prd-draft", "rec-decision-log"],
              "description": "Which recipe to run. coach-me: 1:1 coaching feedback. follow-up-email: drafts a recap email. action-items: extracts TODOs with owners + due dates. feature-digest: pulls product implications. prd-draft: drafts a PRD section. decision-log: records decisions + rationale."
            },
            "meeting_id": {
              "type": "string",
              "description": "Meeting ID (from shogun.meetings_list or shogun.meetings_search)."
            }
          },
          "required": ["recipe_id", "meeting_id"]
        }
      }
    ])
}
