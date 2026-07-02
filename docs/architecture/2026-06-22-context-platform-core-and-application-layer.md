# SHOGUN AI Context Platform Architecture

Updated: 2026-06-22
Status: Proposed direction aligned to current repository

## Goal

SHOGUN AI should remain a single repository and a single product core.
Founder Sales, Fundraising CRM, Meeting Context Recorder, Builder Memory, MCP Server, and Agent Actions should be implemented as application surfaces on top of the same desktop context platform, not as separate products or duplicate storage systems.

## Current Repository Reading

The current repository already has the right center of gravity:

- `src-tauri/` contains the desktop runtime, ingestion paths, local persistence, connector sync, and worker-style background execution.
- `src/features/` contains user-facing surfaces such as Home, Memory, Chat, Meetings, Agents, and Work.
- `src/shared/` contains cross-surface UI/runtime contracts.
- `tools/amc-pipeline/` is already a package-style auxiliary pipeline.

In other words, SHOGUN is already closer to a context platform than to a single-purpose CRM.
What is still missing is a more explicit contract for the shared core domain and a cleaner distinction between:

1. Core context objects
2. Application-layer workflows
3. Background ingestion / updating responsibilities

## Architectural Direction

### 1. Keep One Repository

Do not split CRM, meetings, MCP, and memory into separate repositories.

### 2. Keep One Core

The following concepts should be owned by shared core logic and shared storage contracts:

- `Entity`
- `Event`
- `Memory`
- `AI Field`
- `Action`
- `Relationship`
- `Source`
- `Permission`
- `Audit Log`

These must not be redefined independently inside each surface.

### 3. Separate Application Surfaces

Surface-specific UX, prompts, and workflows should stay separated by feature boundary:

- Home
- Memory
- Chat
- Meetings
- Agents
- Work
- Future: Founder Sales, Fundraising, MCP setup, and operator surfaces

Current progress on this separation:

- Home reads recent shared context and search results from the shared core
- Chat can attach unified shared context, Memory, or AI Fields into one conversation flow
- Actions, Entity Context, Founder Sales, Fundraising, and Project Memory all reuse the same owner-entity and action contracts

### 4. Normalize Ingestion Into Shared Context

Connectors and desktop capture should continue to ingest source-specific data, but the product should increasingly normalize those results into shared events and evidence-backed derived state.

## Mapping the Current Repo to the Target Shape

The prompt suggested `apps/`, `packages/`, and `workers/`.
This repository does not need a large rename now.
We can map the current structure to the same responsibilities with minimal churn:

- Application layer
  - `src/features/*`
  - `src/app/*`
- Shared packages / contracts
  - `src/shared/*`
  - `src-tauri/src/context_assembly.rs`
  - `src-tauri/src/memory_store.rs`
  - `src-tauri/src/llm.rs`
  - `src-tauri/src/meeting/*`
  - `src-tauri/src/connectors/*`
- Worker and ingestion runtime
  - `src-tauri/src/capture_*`
  - `src-tauri/src/*sync.rs`
  - `src-tauri/src/extraction_jobs.rs`
  - `src-tauri/src/schedule_queue.rs`
  - `src-tauri/src/patterns_sync.rs`
  - `src-tauri/src/supersession_sync.rs`

This means the immediate priority is not directory migration.
The immediate priority is enforcing domain boundaries through shared contracts and storage.

## Core Domain Contract

### Entity

Represents a durable business object such as:

- person
- company
- project
- deal
- investor
- meeting
- document
- task
- app

Entity identity should be stable across surfaces.

Recommended id convention:

- `company:acme`
- `deal:seed-round`
- `investor:sequoia`
- `project:apollo`
- `task:onboarding-followup`

Application surfaces should filter or group by these shared prefixes rather than creating surface-specific foreign keys or duplicate tables.

### Event

Represents something that happened.
Examples:

- email_received
- email_sent
- meeting_started
- meeting_transcribed
- browser_page_viewed
- document_edited
- slack_message
- github_issue_updated
- file_opened
- screen_context_captured

Events are the main provenance layer for AI reasoning.

### Memory

Represents a derived, searchable memory built from events.
The existing `mem_items` table already approximates this role.
The next step is to keep strengthening evidence links and cross-surface semantics rather than creating parallel memory stores.

### AI Field

Represents evidence-backed, continuously updated state tied to an owner entity.
Minimum schema:

- `id`
- `owner_entity_id`
- `field_name`
- `instruction`
- `current_value`
- `confidence`
- `evidence_event_ids`
- `last_updated_at`

Examples:

- blocker
- next_action
- budget
- decision_maker
- competitor
- deployment_timing

This is the most important missing core abstraction today because it lets SHOGUN turn raw context into reusable application state without hard-coding everything inside one vertical surface.

### Action

Represents a proposed or executed operation.
Minimum schema should include:

- `risk_level`
- `status`

Initial direction:

- keep MCP and external mutations mostly read-only first
- require approval and auditability for write-capable actions

### Supporting Core Contracts

To keep application surfaces from re-inventing adjacent storage models, the shared domain also needs lightweight contracts for:

- `Relationship` for links such as person -> company, meeting -> project, deal -> company
- `Source` for ingestion and sync ownership
- `Permission` for MCP / connector / action scope boundaries
- `Audit Log` for who changed what and why

These do not all need full backend persistence immediately, but they should exist as shared contracts before new surfaces create their own ad hoc variants.

## Boundary Rules

- Core storage and contracts live once.
- Surface-specific cards, panes, and workflows can vary freely.
- Connectors may ingest source-specific payloads, but downstream interpretation should converge on shared context objects.
- AI-updated state should be evidence-backed and queryable outside the original surface.

## First Implementation Slice

To make this architecture real without a repository rewrite, the first slice should introduce `AI Field` as a shared core object:

1. Persist AI fields in the local desktop store
2. Expose read/write commands through the existing Tauri action layer
3. Surface them in the Home screen as cross-application context, not as a CRM-only artifact

That slice is intentionally small, but it creates a reusable substrate for:

- Founder Sales blockers and next steps
- Fundraising investor concerns
- Meeting follow-up state
- Project unresolved issues
- Agent-generated suggested actions

## Read-only MCP Slice

The next thin slice after AI Fields and Action Queue is a read-only MCP surface that reuses the same shared objects instead of inventing a separate export model.

Suggested first-pass tools:

- `shogun.search_context`
- `shogun.get_recent_context`
- `shogun.get_customer_context`
- `shogun.get_project_context`
- `shogun.get_meeting_summary`
- `shogun.list_tasks`

These tools should stay read-only and should compose existing shared stores such as Memory, AI Fields, Actions, and Meeting Context.

## Non-Goals for This Slice

- No large directory migration
- No duplicate CRM-specific schema
- No action execution engine redesign yet
- No second repository or second database

## Success Criteria

- The repository remains unified
- The design clearly distinguishes core objects from application surfaces
- At least one shared core object beyond Memory is implemented end-to-end
- The new implementation is usable from an existing product surface
