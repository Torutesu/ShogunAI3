# Agent Edit Modal + Split `screens-b.jsx` → `screens-agents.jsx`

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-27-agents-screen-redesign-design.md` § 2.2 (the `[✎ Edit]` action button), § 7 (file size watchdog)

## Problem

The Agents redesign reached `hifi/screens-b.jsx` ~1900 lines, well
past the 1500-line split threshold the redesign spec called out as
a follow-up. The Edit button on each AgentCard is still a stub
toast — there's no way to change an agent's name, description, or
trigger from the UI.

This round addresses both at once: extract every Agents-related
symbol into a new `hifi/screens-agents.jsx`, and add an Edit modal
that lets the user change Name / Description / Trigger, persisted
in a session-scoped overrides layer (no real backend yet).

## Goals

- Move all Agents components, helpers, and demo data out of
  `screens-b.jsx` into a new `hifi/screens-agents.jsx`. After the
  split, `screens-b.jsx` contains only `ScreenChat`.
- Add `EditAgentModal` triggered by AgentCard's `[✎ Edit]` button.
  Lets the user change Name (`<input>`), Description (`<textarea>`),
  and Trigger (Type `<select>` + a single value widget that swaps
  with the selected type).
- Trigger editor handles 4 trigger shapes: `Interval`, `Event`,
  `Daily`, `Weekly`. Existing trigger strings are parsed back into
  the structured form on modal open.
- Edits are written to a session-scoped `agentOverrides` state in
  `ScreenAgents` and merged over `AGENTS_DEMO` for rendering.
  Reload reverts to the curated demo (no localStorage / settings
  persistence — out of scope, no backend yet).

## Non-Goals

- Real agent creation. The `+ New agent` button still opens the
  Coming-soon modal added in the previous redesign. Editing
  applies only to the four curated demo agents.
- Editing tools (the chip list at the bottom of each card). User
  picked B in brainstorming — Name / Description / Trigger only,
  Tools are out of scope this round.
- Editing icon, status, triggerSince, or run history — these are
  system-managed.
- Persisting edits across reloads (no localStorage, no
  `settings.json` write, no SQLite). Session state only.
- Validating the trigger value beyond shape (`Interval` ≥ 1,
  `Daily` matches `HH:MM`). Semantic checks ("does that schedule
  conflict with another agent") are not in scope.

## § 1. File split

### 1.1 New file: `hifi/screens-agents.jsx`

The new file owns all Agents-related code currently in
`screens-b.jsx`:

| Symbol                                | Source location (current) |
|---------------------------------------|---------------------------|
| `AGENTS_DEMO_NOW`, `HOUR`             | constants                 |
| `fmtRelativeTime`, `fmtNextTime`, `buildAgentSubLine` | helpers       |
| `AGENTS_DEMO`                         | data                      |
| `AGENTS_LIVE`                         | data                      |
| `AGENT_STATUS_META`                   | data                      |
| `ATTENTION_REASONS`                   | data                      |
| `AttentionStrip`                      | component                 |
| `RecentRunsList`                      | component                 |
| `FILTER_OPTIONS`                      | data                      |
| `FilterBar`                           | component                 |
| `NewAgentModal`                       | component                 |
| `AgentsEmptyState`                    | component                 |
| `generateAgentRunHistory`, `formatRunStamp`, `SYNTHETIC_RUN_TEMPLATES` | helpers + data |
| `RunRow`                              | component                 |
| `bucketRunsByDate`                    | helper                    |
| `AgentRunHistoryDrawer`               | component                 |
| `AgentCard`                           | component                 |
| `ScreenAgents`                        | screen function           |
| `window.ScreenAgents = ScreenAgents`  | global registration       |

The new file uses the same global `React`, `Icon`, `window.SHOGUN_RUNTIME`
references that the existing screens-b.jsx code uses — no module
imports.

### 1.2 `screens-b.jsx` after split

Becomes ~600 lines, contains only `ScreenChat` and its helpers.
The `window.ScreenChat = ScreenChat` assignment stays at the
bottom; the `window.ScreenAgents = ScreenAgents` assignment moves
to the new file.

### 1.3 HTML wiring

`SHOGUN Hi-Fi UI.html` line 23 currently has:

```html
<script type="text/babel" src="hifi/screens-b.jsx"></script>
```

Add a new line **immediately after** it (so screens-agents.jsx
loads after screens-b.jsx but before screens-c.jsx):

```html
<script type="text/babel" src="hifi/screens-agents.jsx"></script>
```

Order doesn't matter functionally between screens-b.jsx and
screens-agents.jsx (the two files reference disjoint globals
after the split). Placing it adjacent keeps the script tag block
visually grouped.

## § 2. EditAgentModal

### 2.1 Layout

```
┌────────────────────────────────────────┐
│ EDIT AGENT                       [✕]  │
│                                        │
│ NAME                                   │
│ [ Inbox triage                       ] │
│                                        │
│ DESCRIPTION                            │
│ ┌──────────────────────────────────┐  │
│ │ Sorts Gmail by memory-derived    │  │
│ │ priority. Drafts replies for...  │  │
│ └──────────────────────────────────┘  │
│                                        │
│ TRIGGER                                │
│ Type: [Interval ▼]                     │
│ Every [ 2 ] [hours ▼]                  │
│                                        │
│         [Cancel]  [Save changes]       │
└────────────────────────────────────────┘
```

- 480px wide, centered, backdrop-dim same pattern as `NewAgentModal`.
- Section labels: mono uppercase, `var(--text-mute)`, fontSize 10.
- Inputs use the existing `s-input` class style (re-create inline if not in scope).
- Backdrop click and ESC fire `Cancel`.

### 2.2 Form fields

**NAME**: `<input type="text">`, required, max 60 chars. Shows the
current `agent.name` on open.

**DESCRIPTION**: `<textarea rows={3}>`, required, max 240 chars.
Shows the current `agent.description` on open.

**TRIGGER**: Type `<select>` with 4 options + a value widget that
swaps based on type. See § 3.

### 2.3 Validation + Save

The Save button is disabled until:

- `name.trim().length >= 1`
- `description.trim().length >= 1`
- The current trigger form has a valid value (per § 3.4)

When enabled and clicked, Save:

1. Serializes the trigger form back to a string (per § 3.3).
2. Calls `onSave({ name, description, trigger })`.
3. Closes the modal.

`Cancel` discards form state and closes.

## § 3. Trigger editor

### 3.1 Shape

The current `agent.trigger` is a free-form string (e.g.
`"every 2 hours"`, `"on calendar event"`, `"21:00 daily"`,
`"weekly"`). The editor decodes that string into a structured
form, edits it, then re-encodes on Save.

```ts
type TriggerForm =
  | { type: 'interval'; value: number; unit: 'minute' | 'hour' | 'day' }
  | { type: 'event'; source: 'calendar' }   // v1: calendar only
  | { type: 'daily'; time: string }          // 'HH:MM'
  | { type: 'weekly' };
```

### 3.2 `parseTrigger(triggerStr) → TriggerForm`

Pure function. Tries each pattern in order; first match wins.

| Regex                              | Resulting form                                    |
|------------------------------------|---------------------------------------------------|
| `/^every (\d+) (minute|hour|day)s?$/` | `{ type:'interval', value:N, unit:capture }`   |
| `/^on (\w+) event$/`               | `{ type:'event', source:capture }`                |
| `/^(\d{2}):(\d{2}) daily$/`        | `{ type:'daily', time:'HH:MM' }`                  |
| `/^weekly$/`                       | `{ type:'weekly' }`                               |
| (no match)                         | `{ type:'interval', value:1, unit:'hour' }` + `console.warn` |

### 3.3 `serializeTrigger(form) → string`

Pure function. Round-trips back to the same string format
`AGENTS_DEMO` uses today.

| form                              | string                              |
|-----------------------------------|-------------------------------------|
| `{type:'interval', value, unit}`  | `"every {value} {unit}{value > 1 ? 's' : ''}"` (e.g. `every 1 hour`, `every 2 hours`) |
| `{type:'event', source}`          | `"on {source} event"`               |
| `{type:'daily', time}`            | `"{time} daily"`                    |
| `{type:'weekly'}`                 | `"weekly"`                          |

### 3.4 Per-type widget + validation

| type     | UI                                                  | valid when                                       |
|----------|-----------------------------------------------------|--------------------------------------------------|
| interval | `Every [number input] [select: minute/hour/day]`    | `value` is integer ≥ 1                          |
| event    | `On [select: calendar]`                             | always (calendar is the only option for v1)      |
| daily    | `[time input HH:MM]`                                | matches `/^\d{2}:\d{2}$/` AND `HH < 24, MM < 60` |
| weekly   | (no further widget; just a hint `Runs once a week, time set by system`) | always                |

When the user changes Type, the form's other fields reset to
defaults: interval `{1, hour}`, event `{calendar}`, daily
`{12:00}`, weekly `{}`.

## § 4. Overrides state in ScreenAgents

```js
const [agentOverrides, setAgentOverrides] = React.useState({});
// Shape: { [agentId]: Partial<Agent> }

const effectiveAgents = React.useMemo(() => {
  return AGENTS_DEMO.map((a) => {
    const o = agentOverrides[a.id];
    return o ? { ...a, ...o } : a;
  });
}, [agentOverrides]);
```

**`AGENTS_DEMO` must be replaced with `effectiveAgents` everywhere
inside ScreenAgents that reads from agents.** That includes:

- `attentionCount` derivation (currently iterates `AGENTS_DEMO`)
- `filterCounts` useMemo
- `visibleAgents` useMemo
- The header subtitle's `{AGENTS_DEMO.length}` count
- `<AttentionStrip agents={AGENTS_DEMO}>`
- `<AgentsEmptyState totalCount={AGENTS_DEMO.length}>`
- `<AgentRunHistoryDrawer agent={AGENTS_DEMO.find(...)}` lookup

The map preserves identity per agent so React's `key={a.id}` keeps
working without remount.

**Save handler in ScreenAgents:**

```js
const onSaveEdit = (agentId, partial) => {
  setAgentOverrides((prev) => ({
    ...prev,
    [agentId]: { ...(prev[agentId] || {}), ...partial },
  }));
  window.SHOGUN_RUNTIME?.pushToast?.(`Updated ${partial.name}`, 'success');
  setEditModalAgentId(null);
};
```

## § 5. Wiring AgentCard's Edit button

`AgentCard`'s expanded action row currently has:

```jsx
<button ... onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Edit: ${agent.name} (stub)`, 'info')}>
  <Icon name="edit" size={12}/> Edit
</button>
```

`AgentCard` gains a new prop `onEdit(agentId)`. The button's
`onClick` becomes `() => onEdit(agent.id)`.

`ScreenAgents` adds `editModalAgentId` state and threads
`onEdit={setEditModalAgentId}` down through the map.

`EditAgentModal` is rendered conditionally at the bottom of
ScreenAgents:

```jsx
{editModalAgentId && (
  <EditAgentModal
    agent={effectiveAgents.find((a) => a.id === editModalAgentId)}
    onSave={(partial) => onSaveEdit(editModalAgentId, partial)}
    onClose={() => setEditModalAgentId(null)}
  />
)}
```

## § 6. Implementation surface

**Created:** `hifi/screens-agents.jsx` (~1850 lines after the
move; contains everything Agents-related plus EditAgentModal).

**Modified:**

- `hifi/screens-b.jsx` — delete every Agents-related symbol
  listed in § 1.1. Result: ~600 lines, only `ScreenChat`.
- `SHOGUN Hi-Fi UI.html` — add `<script type="text/babel" src="hifi/screens-agents.jsx"></script>` after the screens-b line.
- `hifi/screens-agents.jsx` — add `parseTrigger`, `serializeTrigger`, `EditAgentModal`, plus the wiring described in § 4–§ 5.

**No tests** (per the previous Agents specs — manual eye-test
only). Verification = `npm run check:ipc-mock` + the spec § 7
manual run-through.

## § 7. Testing & Verification

- `npm run check:ipc-mock`: PASS (no IPC changes).
- `python3 hifi/scripts/check-actions.py`: same pre-existing
  failures only — no new errors.
- Confirm `wc -l hifi/screens-b.jsx` is around 600 (down from
  ~1900) and `wc -l hifi/screens-agents.jsx` is around 1850.

Manual eye-test:

1. Refresh app. Agents screen renders identically to before the
   split (no visual change yet).
2. Inbox triage card → expand → click `[✎ Edit]`. Modal opens
   with Name / Description / Trigger form pre-filled from
   `agent.name` / `agent.description` / `agent.trigger` parsed
   into structured form.
3. Type dropdown defaults to `Interval`. Value widget shows
   `Every 2 hours`. Change to `4` `hours` → Save → toast → modal
   closes → AgentCard now displays `every 4 hours` in the TRIGGER
   line and the sub-line uses the new value.
4. Re-open Edit on the same agent → form reflects the new value.
5. Change Type to `Daily` → widget becomes `[time input]`
   defaulted to `12:00`. Save → AgentCard displays `12:00 daily`.
6. Change Type to `Event` → `On [calendar]`. Save → `on calendar
   event`.
7. Change Type to `Weekly` → no further widget, only the hint
   text. Save → `weekly`.
8. Change Name to empty string → Save button disables. Restore →
   re-enables.
9. Click backdrop or press ESC → modal closes without saving.
10. Refresh the app → all overrides discarded; AgentCard reverts
    to `every 2 hours` (proves session-only persistence).
11. Other Agents flows (filter, drawer, attention strip,
    `+ New agent` modal) all still work after the file split.

## § 8. Rollout

Single change, demo-data only, no flag, no migration. Ships in
two logical groups (split first, then Edit modal) but as one
release.
