# AMC Composer — Phase 1 specification

## Where to implement

| Option | Use when |
|--------|----------|
| **A. Node (Zod + templates)** | You want strict schema validation, retries, and versioned few-shots |
| **B. Rust (`jsonschema` + templates)** | You want everything inside Tauri before IPC |
| **C. Python worker** | You already have ML / batch infra there |

**Recommendation for this repo:** start with **B** for `shogun_brief_get` stubs, add **A** as a sidecar when LLM composition is needed, and only pass validated JSON into Rust.

The Hi-Fi UI depends only on [morning-brief-v2.schema.json](../schemas/morning-brief-v2.schema.json) and the `shogun_brief_get` response shape.

---

## System prompt (outline)

**Language:** write the **system prompt and instruction blocks in English**. That improves tool-use reliability and iteration speed. User-visible brief lines (`what`, `why_now`, `next_action.label`, …) still follow AMC: terse style for a JP/EN technical operator (no redundant keigo in those fields). The shipped composer lives in [`amc-pipeline/src/prompts.js`](../amc-pipeline/src/prompts.js).

1. Prefer **structured output** via Anthropic **`tool_use`** (`emit_brief_item` / `emit_brief_summary`) with a Zod-derived JSON Schema — not raw JSON in the assistant text. See [`amc-pipeline/`](../amc-pipeline/README.md).
2. Fill all AMC fields: `what`, `why_now`, `related_context`, `next_action`. If something cannot be filled, omit the item or move it to `deferred`.
3. `related_context` must be **selected only** from the readonly list in the prompt. No invented URIs or titles.
4. `what`: one line, noun phrase, ~40 chars target.
5. `why_now`: must tie to time or prior context (“last time…”, “due today…”), ~80 chars target.
6. `next_action`: `verb` is short; `label` starts with an actionable verb; `type` matches the shipped schema (`open` | `draft` | `focus` | `other` in v1 pipeline).

## Models (Anthropic)

Use the **current Claude API ids** from [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview). Defaults in this repo:

| Step | Env | Default id |
|------|-----|------------|
| AMC composer (per candidate) | `ANTHROPIC_MODEL` | `claude-opus-4-7` |
| Summary (headline + posture) | `ANTHROPIC_SUMMARY_MODEL` | `claude-sonnet-4-6` |
| Composer retry on 429/529 | `ANTHROPIC_MODEL_FALLBACK` | `claude-sonnet-4-6` |

Pin or change these in `.env` / deployment config; avoid deprecated `*-20250514` ids before their retirement date.

### Bad few-shot examples

- Only “23 unread emails”.
- Only “Meeting with Tanaka at 10” with no why-now and no CTA.

### Good pattern

- `what`: one-line meeting summary  
- `why_now`: link to last commitment or deadline  
- `related_context`: up to three real links  
- `next_action`: e.g. open pack via `shogun.open_pack`

---

## Composer input (per candidate)

Structured fields: `category`, `time_hint`, `source`, short `raw_signals`, and `related_context_readonly` (trimmed search hits, max three).

---

## Validation and fallback

1. Validate with JSON Schema (v2 schema in repo).
2. Light heuristics (non-empty `verb`, at most three context refs).
3. One partial retry for failed fields only.
4. If still invalid, downgrade priority or append to `deferred`, log the reason.

Prefer **batch** generation of `items[]` so ranking and caps (max 7 items, max 3 priority-1) stay consistent.

---

## Related code

- Stub: [src-tauri/src/brief.rs](../../src-tauri/src/brief.rs) (English fixture; localized copy comes from the real composer).
- Browser mock sample: [morning-brief.js](../lib/morning-brief.js).
- CTAs: [action-registry.js](../lib/action-registry.js) — `shogun.open_pack`, `shogun.start_focus_session`.
