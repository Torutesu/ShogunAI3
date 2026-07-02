# AI Fields First Slice Plan

Updated: 2026-06-22
Status: In progress, expanded with read-only MCP follow-on

## Why This Slice

The prompt asks for architecture first, then an implementation plan, then actual execution.
`AI Field` is the right first slice because it turns the architecture into a reusable core capability instead of another surface-specific feature.

## Scope

### In scope

- Add a shared `AI Field` domain contract
- Persist AI fields locally in the desktop store
- Add Tauri commands for listing and upserting AI fields
- Expose those commands through the existing frontend runtime action system
- Show AI fields in an existing application surface
- Reuse the same core for entity-centric context and read-only MCP tools

### Out of scope

- Automated AI field updater worker
- Full action execution and approval pipeline
- Dedicated CRM screen
- Entity master-table redesign

## Implementation Steps

1. Define shared frontend types for context-layer primitives
2. Add `ai_fields` local table and storage helpers in Rust
3. Add IPC commands and frontend runtime wiring
4. Add a Home-screen card for viewing and editing AI fields
5. Extend the same shared core into entity context, action queue, and read-only MCP tools
6. Verify with Rust tests plus web typecheck

## Acceptance Criteria

- AI fields can be created without adding a new product-specific schema
- AI fields can be listed in descending update order
- Each field stores owner entity, instruction, current value, confidence, and evidence ids
- The Home surface can display and save AI fields
- Read-only MCP tools can expose shared context without creating a separate CRM / project schema
- No existing Memory flows regress
