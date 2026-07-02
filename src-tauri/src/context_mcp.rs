//! JSON tool descriptors for shared context-layer tools exposed via shogun-mcp.

use serde_json::{json, Value};

pub fn tool_definitions() -> Value {
    json!([
        {
            "name": "shogun.search_context",
            "description": "Read-only search across the shared desktop context layer. Returns a combined view of timeline hits, AI Fields, Action Queue items, queue artifacts, and latest audit signals without creating a CRM-specific data model.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Free-form search query" },
                    "ownerEntityId": { "type": "string", "description": "Optional shared owner entity filter such as company:acme or project:apollo" },
                    "include": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional sections to include: timeline | ai_fields | actions | queue_artifacts | audits"
                    },
                    "limit": { "type": "integer", "default": 10 }
                },
                "required": ["query"]
            }
        },
        {
            "name": "shogun.get_recent_context",
            "description": "Read the most recent shared context objects from the desktop layer, optionally scoped to one owner entity.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ownerEntityId": { "type": "string", "description": "Optional shared owner entity id" },
                    "limit": { "type": "integer", "default": 8 }
                }
            }
        },
        {
            "name": "shogun.get_customer_context",
            "description": "Return an entity-centric context bundle for a customer/company/deal using the same shared core used by AI Fields and Actions.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "entityId": { "type": "string", "description": "Shared entity id such as company:acme or deal:seed-round" },
                    "entityLabel": { "type": "string", "description": "Optional display label" },
                    "lang": { "type": "string", "default": "en" },
                    "limit": { "type": "integer", "default": 6 }
                },
                "required": ["entityId"]
            }
        },
        {
            "name": "shogun.get_project_context",
            "description": "Return an entity-centric context bundle for a project from the shared context layer, not a separate project-only store.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "entityId": { "type": "string", "description": "Shared entity id such as project:apollo" },
                    "entityLabel": { "type": "string", "description": "Optional display label" },
                    "lang": { "type": "string", "default": "en" },
                    "limit": { "type": "integer", "default": 6 }
                },
                "required": ["entityId"]
            }
        },
        {
            "name": "shogun.get_meeting_summary",
            "description": "Return one meeting's read-only context bundle for external MCP clients.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "meeting_id": { "type": "string", "description": "Meeting id from the shared meeting store" }
                },
                "required": ["meeting_id"]
            }
        },
        {
            "name": "shogun.list_tasks",
            "description": "Read pending shared tasks from the human-approvable Action Queue. This is a read-only view over shared context actions, not a separate task DB.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ownerEntityId": { "type": "string", "description": "Optional owner entity filter" },
                    "query": { "type": "string", "description": "Optional free-text filter over task-like actions" },
                    "statuses": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Optional statuses to include; defaults to proposed and approved"
                    },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        },
        {
            "name": "shogun.ai_fields_list",
            "description": "List shared AI Fields tracked in the desktop context layer. Useful for reading current blockers, next actions, budgets, or other evidence-backed state across surfaces.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Optional exact AI Field id" },
                    "ownerEntityId": { "type": "string", "description": "Optional owner entity id such as company:acme or deal:seed-round" },
                    "query": { "type": "string", "description": "Optional free-text match against field name, instruction, or current value" },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        },
        {
            "name": "shogun.action_queue_list",
            "description": "List shared context actions across proposed, approved, executed, and rejected states. This is the human-approvable action layer, not a surface-specific task list.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Optional exact action id" },
                    "ownerEntityId": { "type": "string", "description": "Optional owner entity filter" },
                    "sourceAiFieldId": { "type": "string", "description": "Optional exact source AI Field id" },
                    "status": {
                        "type": "string",
                        "enum": ["proposed", "approved", "executed", "rejected"],
                        "description": "Optional status filter"
                    },
                    "query": { "type": "string", "description": "Optional free-text match against action type, title, or detail" },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        },
        {
            "name": "shogun.action_audit_list",
            "description": "Read the audit trail for one action, including proposal, status changes, and execution events.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "actionId": { "type": "string", "description": "Exact action id" },
                    "limit": { "type": "integer", "default": 12 }
                },
                "required": ["actionId"]
            }
        },
        {
            "name": "shogun.queue_artifacts_list",
            "description": "List read-only local queue artifacts created by executed shared actions, including task queue and CRM update queue items.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ownerEntityId": { "type": "string", "description": "Optional owner entity filter such as company:acme or project:apollo" },
                    "queueKind": {
                        "type": "string",
                        "enum": ["tasks", "crm_updates"],
                        "description": "Optional queue filter"
                    },
                    "limit": { "type": "integer", "default": 20 }
                }
            }
        },
        {
            "name": "shogun.owner_context_summary",
            "description": "Return a read-only owner/entity summary that combines entity context, AI Fields, Actions, queue artifacts, and the latest action audits for one shared owner entity.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "ownerEntityId": { "type": "string", "description": "Required shared owner entity id such as company:acme, investor:sequoia, project:apollo, or task:onboarding-followup" },
                    "limit": { "type": "integer", "default": 6 }
                },
                "required": ["ownerEntityId"]
            }
        },
        {
            "name": "shogun.entity_context_get",
            "description": "Return one entity-centric context bundle from the shared desktop context layer, combining cached entity rollup, recent summaries, AI Fields, and Actions.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "entityId": { "type": "string", "description": "Exact entity id such as company:acme, project:apollo, or deal:seed-round" },
                    "entityLabel": { "type": "string", "description": "Optional display label for the caller's convenience" },
                    "lang": { "type": "string", "default": "en", "description": "Language for cached rollup / summaries lookup" },
                    "limit": { "type": "integer", "default": 6, "description": "Cap per sub-list" }
                },
                "required": ["entityId"]
            }
        }
    ])
}
