# Memory Digest Phase 4 — Summary Manual Editing Design

**Status:** Draft
**Date:** 2026-04-26
**Spec parent:** `docs/superpowers/specs/2026-04-24-memory-digest-design.md` (§ 8 Phase 4 / Open Questions)

## Problem

The Memory Digest summarizer (`mem_summaries`) produces an LLM-generated
title, key-points list, reason, and priority for each item. The output
is good in aggregate but wrong on individual items frequently enough
that users want a way to fix it in place. Today the only manual override
is the priority `PIN H/M/L` button (`userPriority` column). Title and
key-points are read-only.

We want users to edit `title`, `keyPoints`, and `reason` inline,
preserve those edits across re-summarization, and capture rich edit
metadata so the next phase (Heuristic pre-filter externalization) can
use the edit history as a learning signal.

## Goals

- Inline edit of `title`, `keyPoints`, `reason` from the River detail
  panel.
- Edits persist across LLM re-summarization (`memory.summary.invalidate`).
- Each edit is captured with metadata (field, from, to, timestamp,
  source, entity) so future heuristic work can correlate user edits
  with sender/source patterns.
- Zero new feature flag, zero schema migration.

## Non-Goals

- **Heuristic feedback wiring.** Edits are stored and exposable, but
  no automatic action is taken on them in this spec. That belongs to
  Phase 4-b (Heuristic externalization).
- **Priority editing UI.** `userPriority` is already implemented via
  the PIN H/M/L buttons; we do not add a second editing path for it.
- **Multi-user edit conflict resolution.** Hi-Fi prototype is
  single-user; last-write-wins is acceptable.
- **Server-side telemetry of edits.** Local storage only.

## § 1. Architecture & Data Flow

Three-layer change. No new feature flag.

### Frontend (`hifi/screens-a.jsx`)

Three regions of the scrub summary detail panel become inline-editable:

- `scrubSummary.title` (around line 2740) — clickable `<div>` becomes
  `<textarea>` with autoresize on click.
- `scrubSummary.keyPoints[i]` (line 2748–2753) — each `<li>` becomes
  `<input type="text">` on click. Plus a `+ Add point` button at the
  end and a `×` removal button on each editable item.
- `scrubSummary.reason` (around line 3060, in the metadata grid) —
  `<textarea>` on click.

State:

```js
const [editingField, setEditingField] = useState(null);
// 'title' | 'kp:0' | 'kp:1' | ... | 'reason' | null
const [editingDraft, setEditingDraft] = useState('');
```

### IPC (`hifi/lib/action-registry.js` + `shogun-api.js` + `ipc-client.js`)

Two new actions:

1. `memory.summary.edit({targetId, targetKind, field, value, baseValue})`
   - `field`: `'title' | 'keyPoints' | 'reason'`
   - `value`: edited value (array for `keyPoints`)
   - `baseValue`: pre-edit display value (recorded as `from` in history)
   - Returns: full updated summary object (merged)

2. `memory.summary.revert({targetId, targetKind, field})`
   - Clears the user-edit history for that one field.
   - Returns: full updated summary object (now reverted to LLM base for
     that field).

### Backend reader (existing `memory.summary.get` / `memory.summary.batch`)

Modified to apply the merge rule (see § 2). Existing callers see
`scrubSummary.title` / `keyPoints` / `reason` etc. with effective values
already computed; no client change needed beyond the new edit/revert
calls.

### Frontend save flow

1. Click → `setEditingField(field)` + `setEditingDraft(currentValue)`,
   focus the textarea/input.
2. Enter (single keypress, not Cmd+Enter) → save + blur.
3. Escape → discard, `setEditingField(null)`, no IPC.
4. Blur → save (if changed).
5. On save: optimistic update of `scrubSummary` and `summaryByMemId`,
   then `runRuntimeActionA('memory.summary.edit', {...})`. On failure,
   revert local state and show a toast.

## § 2. Data Model — `raw_json` Shape

`mem_summaries.raw_json` already holds the LLM tool_use response. We
extend it with a `user_edits` array. No new columns; no DB migration.

```jsonc
{
  "tool_use": {
    "title": "...",
    "keyPoints": ["...", "..."],
    "reason": "...",
    "priority": "low",
    "sourceType": "mail"
  },
  "stop_reason": "tool_use",
  "model": "claude-haiku-4-5",
  "schemaVersion": 1,

  "user_edits": [
    {
      "field": "title",
      "from": "Slack #aurora-launch — release checklist",
      "to":   "Aurora release checklist (3 P1 left)",
      "at":   1735164234123,
      "source_raw": "chat",
      "entity_id": "slack:aurora-launch",
      "schema": 1
    },
    {
      "field": "keyPoints",
      "from": ["A", "B", "C"],
      "to":   ["A revised", "B", "C"],
      "at":   1735164300000,
      "source_raw": "chat",
      "entity_id": "slack:aurora-launch",
      "schema": 1
    }
  ]
}
```

### Reader merge rule

```
effective = clone(raw_json.tool_use)
for entry in raw_json.user_edits || []:
    if entry.schema != 1: continue   // forward-compat
    effective[entry.field] = entry.to
return effective
```

`userPriority` continues to be read from its dedicated column. Reader
returns the merged summary (with both column-based and edit-based
overrides applied) to existing callers.

### Backward compatibility

Rows without `user_edits` are read as `user_edits = []` — identical
behavior to today.

## § 3. UI

### Inline edit affordance

Each editable field has the same interaction shape:

| Trigger | Action |
|---|---|
| Click on display element | Enter edit mode for that field |
| Tab from another focusable | Tab into the field; Enter activates edit mode |
| Enter (in textarea/input) | Save (validate change), blur |
| Escape | Discard, exit edit mode, no IPC |
| Blur | Save (if changed) |

`textarea` autoresizes (1–3 lines for title, 1–2 for reason). `input`
for keyPoints items is single-line.

### keyPoints add/remove

- After the last editable `<li>` (or always present), a small `+ Add
  point` button.
- On click: append empty string to local `keyPoints`, immediately enter
  edit mode for the new item. Empty + blur → no IPC, item dropped.
- Each `<li>` in edit mode shows a `×` on the right. Click → remove from
  array, save the new shorter array via IPC.

### Edited indicator

Each effective field that has at least one entry in `user_edits` shows
a small `·` dot or compact `<span>edited</span>` chip immediately after
the text:

- Hover: tooltip `Edited by you · {relative time}` (en) / `編集済み · {相対時刻}` (jp)
- Click on the dot/chip: opens a small inline action `Revert to AI` /
  `AIに戻す` → calls `memory.summary.revert` for that field.

### Save state UX

- Optimistic update is immediate. No spinner.
- On IPC failure: local state rolls back, toast `Failed to save edit`
  / `保存に失敗しました`.
- No "saving…" indicator (saves are <100ms in normal operation).

### a11y

- Display element: `role="button" tabIndex={0}` with
  `aria-label="Edit title"` etc.
- Edit element: `aria-label` mirrors the display, plus
  `aria-describedby` on a hidden helper that explains
  "Enter to save, Escape to discard".

## § 4. Edge Cases

| Scenario | Behavior |
|---|---|
| Repeated edits to the same field | Each save appends a new entry to `user_edits[]`. Reader uses the latest. Full history preserved. |
| Edit while re-summarize runs | `invalidate` rewrites `raw_json.tool_use` and `model`/`schemaVersion`/`stop_reason`. `user_edits[]` is untouched. Reader merge applies user edits on top of the new LLM baseline. |
| Edit-mode interrupted by screen change | React unmount discards `editingField`. Autosave on blur fires before unmount, so committed-edits land. Drafts (typing in progress) are lost. |
| `value === baseValue` no-op | No IPC, no history pollution. `editingField` simply closes. |
| `keyPoints` becomes empty | Saved as `to: []`. UI shows only the `+ Add point` button. |
| `reason` was originally `null` | First edit records `from: null, to: "..."`. Reader returns user value. |
| Revert + re-edit | Revert clears history for that field. New edit records `from: base, to: ...` (continuous history starting from the new base). |
| IPC failure | Local rollback + toast. Draft text is lost (user retypes). |
| Same memoryId open in multiple components | `setSummaryByMemId` is single source of truth; both re-render. |
| `userPriority` (existing) | Independent path; unaffected by `user_edits[]`. PIN buttons remain the only priority editor. |
| `keyPoints` mid-array delete | Array re-built; `to: [...newArray]`. `from: [...oldArray]`. Reader uses `to` directly. |
| `entry.schema !== 1` | Reader ignores that entry (forward-compat). |
| LLM regenerates with a NEW field shape (e.g. adds `summary` field) | `user_edits` for unknown fields are still applied if reader is updated; today's reader only knows the 3 supported fields and ignores edits for others. |

## § 5. Testing

### Rust unit tests (`src-tauri/src/memory/summaries.rs` or equivalent)

- `apply_user_edits()` merge helper:
  - Empty `user_edits` → base unchanged.
  - Single title edit → effective.title = latest, others = base.
  - Two edits to the same field → latest wins.
  - keyPoints edit → array replaced wholesale.
  - Revert → field reverts to base.
  - `entry.schema` mismatch → entry ignored.

### Rust integration tests (DB roundtrip)

- `summary.edit` IPC appends to `raw_json.user_edits[]` correctly.
- `summary.get` returns merged effective values.
- `summary.revert` clears the field history.
- `summary.invalidate` after edits: `tool_use` is rewritten,
  `user_edits[]` survives, reader still returns merged values.

### Frontend Playwright e2e (new: `tests/e2e/memory-summary-edit.spec.js`)

- Click title → textarea appears, type new value, Enter → display
  updates.
- Reload page (or navigate Memory→Home→Memory) → edited value
  persists (round-trip via mock IPC).
- Escape during edit → original value remains, no IPC fired.
- Click a `<li>` in keyPoints → input appears, edit, save.
- `+ Add point` → new editable item.
- `×` on an item → item disappears.
- Edited-field dot → hover tooltip; click → Revert action.
- Revert → field reverts to base, dot disappears.
- Re-edit after revert → new dot, edit value.

### Mock IPC additions (`hifi/lib/ipc-client.js`)

- `shogun_memory_summary_edit`: in-memory map keyed by `targetId`,
  appends to a stub `user_edits[]`, returns merged summary.
- `shogun_memory_summary_revert`: clears edits for the field, returns
  base summary.
- Both must be added to the mock + the `check:ipc-mock` allow list.

### Static checks

- `npm run check:actions` — confirms two new IPC actions are registered.
- `npm run check:ipc-mock` — confirms mocks match action map.

### Manual smoke

- `npm run dev:desktop`
- Edit title → re-summarize via existing `Re-summarize` (or
  `summary.invalidate` from Settings/debug) → confirm edited title
  survives.
- Revert → confirm AI value returns.
- Cross-language EN/JP toggle for tooltips.

## § 6. Rollout

No feature flag. The `enable_memory_summary` flag already gates whether
`scrubSummary` is non-null upstream — when off, the editing UI never
renders.

No DB migration. `raw_json` is already `TEXT NOT NULL`; we just write
a richer JSON shape going forward, and the reader treats absence of
`user_edits` as `[]`.

## Success Criteria

1. User can edit any of `title`, `keyPoints`, `reason` and the change
   persists across page reloads and re-summarization.
2. Re-summarization preserves user edits per spec (merge rule).
3. `user_edits[]` accumulates rich metadata (source, entity, timestamp,
   from/to) sufficient for Phase 4-b heuristic work.
4. Zero new IPC failures in `check:actions` / `check:ipc-mock`.
5. New Playwright spec covers the inline edit happy path + Revert.
