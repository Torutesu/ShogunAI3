# Agents Screen Redesign

**Status:** Draft
**Date:** 2026-04-27

## Problem

The current Agents screen (`hifi/screens-b.jsx` `ScreenAgents`) is a flat
landing-style page: header → 4 KPI tiles → 2-column agent card grid →
global Live activity log → hidden Playground drawer. It's pleasant to
look at but weak as a *management* surface:

- The 4 KPI tiles report counts (RUNNING 1, SCHEDULED 2, …) without
  saying *which* agent is in which state. To act on a running or
  failing agent the user must scroll and scan the cards.
- Each agent card shows status, trigger, description, run count, and
  tool chips, but no *next-fire time*, no *last-result*, and no
  inline controls. The `⋯` menu hints at actions but isn't wired.
- Failure states have no visual surfacing — a broken agent looks
  identical to a healthy idle one.
- The "+ New agent" button opens a Playground drawer that is
  actually a one-off "Draft + Memory" prompt tool, not an agent
  creator. Users will reasonably expect it to create an agent.
- The global Live activity log duplicates information that more
  naturally belongs alongside each agent.

We want the screen to read primarily as **agent management**, with
**status overview** as the secondary lens, and to fix the
"+ New agent" mismatch.

## Goals

- Each agent card supports inline expand to reveal quick actions
  (Run now / Pause / Edit / ⋯), trigger details, and the last 3-5
  runs — without leaving the list.
- Failure / staleness / config errors surface at the top via an
  Attention strip; healthy days show no strip at all.
- The "+ New agent" button no longer mis-routes to the Playground.
  It opens a small "Coming soon" modal until the agent-creator UI is
  built.
- Visual treatment stays inside the existing token system
  (`hifi/tokens.css`): no new colors, no new font families, no new
  spacing primitives.
- Live activity remains visible but compressed (z) — kept as a
  small global-feed footer, since the user explicitly wanted it
  retained at reduced size.

## Non-Goals

- Building the actual New-agent creator. Out of scope this round —
  the button opens a placeholder modal.
- Per-run drill-down view (`/agents/:id/runs/:runId`). Out of scope.
  The `See all →` link in the expanded card is wired to a stub
  route or a `Coming soon` toast.
- Persisting expanded state across page reloads. Session-scoped
  React state only.
- Real backend wiring. The screen reads from the existing
  hard-coded `AGENTS_DEMO` / `AGENTS_LIVE` arrays. Real data
  bindings are a separate task.
- Filter bar search input — the visual slot is reserved but the
  input is non-functional this round.
- Refactoring `screens-b.jsx`. The file is medium-sized; the
  redesign stays in-place.

## § 1. Layout

```
┌─────────────────────────────────────────────────────────┐
│ EXECUTION LAYER                                          │
│ Agents                          [⌘ MCP console] [+ New]  │
│ 4 agents · 11 MCP tools · 1 needs attention              │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ⚠ Attention strip (conditional)                         │
│                                                          │
│  Your agents     all · running · scheduled · paused      │
│                                              [search ⌘F] │
│                                                          │
│  ┌── AgentCard (collapsed) ───────────────────────────┐ │
│  │ [icon] Name              [▼]                        │ │
│  │        ● status · 2h ago · next 14:00               │ │
│  │ ──────                                              │ │
│  │ Description...                                      │ │
│  │ ──────                              tool · chips    │ │
│  └─────────────────────────────────────────────────────┘ │
│                                                          │
│  ... more cards in 2-col grid ...                       │
│                                                          │
│  ─────────────────────────────────────────────          │
│  Live activity (compact)                                 │
│   14:31 inbox-triage  Read 3 emails · drafted 1  [✓]   │
│   14:18 meeting-notes Processed "All PJ" meeting [✓]   │
│   14:02 memory        Indexed conversation       [info] │
│   ... (max 5 rows, no border container, smaller font)   │
└─────────────────────────────────────────────────────────┘
```

**Removed from current screen:**
- The 4 KPI tiles (`RUNNING / SCHEDULED / PAUSED / TOOLS CONNECTED`).
  Replaced by the 1-line subtitle counter and the Attention strip.

**New on this screen:**
- Header subtitle becomes structured: `N agents · M MCP tools · K needs attention`.
- Attention strip (conditional, see § 3).
- Filter bar (visual + functional pill tabs; search visual only).

**Compressed but kept:**
- Live activity footer (z): keep current `AGENTS_LIVE` rows but
  drop the bordered card container and shrink to `font-size:11px`
  / `t-mono` rows with a `Live activity` mono overline.

## § 2. AgentCard — collapsed and expanded states

### 2.1 Collapsed state

Layout is the existing 3-zone card (header / description / footer)
with two changes:

| zone   | current                                         | new                                                              |
|--------|-------------------------------------------------|------------------------------------------------------------------|
| header | icon + name + `● status · trigger`  + `⋯` menu  | icon + name + `▼` toggle, sub-line `● status · {relative} · next {time}` |
| desc   | unchanged                                       | unchanged                                                        |
| footer | `N RUNS` + tool chips                           | tool chips only (total run count is removed; the expanded `RECENT RUNS` list answers "what did this agent just do" more directly) |

Sub-line examples (right of name, mono small):
- `● running · 2h ago · next 14:00`
- `● scheduled · last Sun · next Sun 10:00`
- `● paused · last 3d ago`
- `● error · failed 12m ago`

`{relative}` = relative to last run; `next` = next scheduled fire,
omitted for `idle`/`paused`/`error`.

### 2.2 Expanded state

Card grows downward; 4 new sections appear between description and
footer:

1. **TRIGGER**  
   Single mono line: `every 2 hours · since Apr 12 · next 14:00`.  
   Format varies by trigger kind: `cron`, `event`, `scheduled`, `manual`.
   For event triggers: `on calendar event · since Apr 12`.

2. **Action row**  
   Inline buttons:  
   `[▶ Run now] (gold primary)  [⏸ Pause | ▶ Resume] (toggle, secondary)  [✎ Edit] (secondary)  [⋯] (overflow: Duplicate, Disable, Delete)`  
   Disabled state: when an action is in flight (e.g. running), `Run now` shows a spinner and disables.

3. **RECENT RUNS** (max 5)  
   Each row: `{HH:MM}  {description}  [{level pill}]`.  
   Level pills mirror existing `Live activity`: `success` (green border), `info` (mute border), `error` (danger border).  
   Right-aligned in the section header: `See all →` link → stub
   `/agents/{id}/runs` (Coming soon toast for now).

4. **Footer** (unchanged from collapsed)

### 2.3 Visual

- Card background, padding, radius, separators stay identical to
  current `AgentCard`.
- Expanded transition: height auto with `transition: max-height var(--dur-base) var(--ease-out)`.
- Border color flips to `var(--border-hi)` while expanded.
- Status pill (`● {label}`) gains an `error` variant using `var(--danger)`.

### 2.4 Status state machine

| state     | dot color          | shown when                                          |
|-----------|--------------------|-----------------------------------------------------|
| running   | `var(--success)`   | currently executing                                 |
| scheduled | `var(--gold)`      | not running, future fire scheduled                  |
| idle      | `var(--text-mute)` | event-triggered, awaiting event                     |
| paused    | `var(--text-dim)`  | user-paused                                         |
| error     | `var(--danger)`    | last completed run had `level === 'error'`          |

The new `error` state is derived at render time (no schema change to
`AGENTS_DEMO`).

## § 3. Attention strip

Renders above the agents grid when at least one of the following
holds for any agent:

- Last run had level `error`
- No run in the last 24 hours and trigger is `scheduled`/`cron`
- Configuration error (e.g. `auth: 'expired'`) — schema-extensible
  but for v1 just demo data flag

Visual:

```
┌─────────────────────────────────────────────────┐
│ ⚠  Inbox triage failed last run 12 min ago.     │
│    [Run now]  [View]                            │
└─────────────────────────────────────────────────┘
```

- 4px left border in `var(--danger)`, body `var(--surface-2)`,
  `var(--space-3)` padding.
- Up to 3 rows. If more issues, show `+N more` link → opens a list
  modal (stub for v1).
- Action buttons: `Run now` triggers the row's agent (calls a stub
  for v1); `View` scrolls + auto-expands the matching `AgentCard`.

## § 4. Filter bar

Inline pill row directly under "Your agents" header:

```
all (4)  running (1)  scheduled (2)  paused (0)  error (0)         [search ⌘F]
```

- Active pill: `border: 1px solid var(--border-hi); color: var(--text);`
- Inactive: `border: 1px solid var(--border); color: var(--text-mute);`
- Counts derived live from `AGENTS_DEMO`.
- Search input is a visual slot only (placeholder, disabled, with
  the `⌘F` hint dim) — wired in a follow-up.

## § 5. Header changes

- Subtitle is rebuilt from a 4-segment template:  
  `${agentCount} agents · ${toolCount} MCP tools${attentionCount > 0 ? ` · ${attentionCount} needs attention` : ''}`
- The `${attentionCount} needs attention` segment is rendered in
  `var(--danger)`, others in `var(--text-mute)`.
- Buttons unchanged. `+ New agent` now opens a Coming-soon modal
  instead of toggling the Playground (see § 6).

## § 6. New agent button — Coming soon modal

Plain modal centered on screen:

```
┌────────────────────────────────────────┐
│ + New agent                            │
│                                        │
│ Custom agent creation is coming        │
│ in v0.5. For now, the four agents     │
│ above are the curated default set.    │
│                                        │
│ Want to experiment with agent-style   │
│ prompts in the meantime?              │
│                                        │
│         [Open Playground]   [Close]   │
└────────────────────────────────────────┘
```

- `Open Playground` reopens the existing Playground drawer (current
  `setPlaygroundOpen(true)` behavior — fully preserved, just no
  longer the default landing for `+ New agent`).
- `Close` dismisses.

The Playground drawer's existing UI (textarea + Draft + Memory /
Open in Chat buttons) is **unchanged in this redesign**. We're only
moving its entry point.

## § 7. Empty state

When `AGENTS_DEMO` is empty:

```
┌────────────────────────────────────────┐
│ [⊕]  No agents yet                     │
│                                        │
│ Agents read your memory and act on    │
│ your behalf.                          │
│                                        │
│ [+ Create your first agent]           │
└────────────────────────────────────────┘
```

The CTA opens the same Coming-soon modal (§ 6).

## § 8. Implementation surface

Single file: `hifi/screens-b.jsx`. All changes confined to:
- `ScreenAgents` function (header, KPI removal, Attention strip, filter, agent list, Live activity compression)
- `AgentCard` component (collapsed + expanded states)
- `AgentsKpiCard` component → can be removed (no callers after redesign)
- New components: `AttentionStrip`, `FilterBar`, `RecentRunsList`,
  `NewAgentModal` — all defined in the same file. If the file grows
  past ~1100 lines, split into `hifi/screens-agents.jsx`; defer the
  decision to plan time.

Demo data changes (in the same file):
- Add `AGENTS_DEMO[i].lastRunMs: number`, `nextRunMs: number | null`,
  `recentRuns: { t: string; msg: string; level: 'success'|'info'|'error' }[]`
  (last 5), `attention?: 'error' | 'stale' | 'auth_expired'`.
- Remove `AGENTS_DEMO[i].runs: number` — the count is no longer
  rendered anywhere. (No callers outside `AgentCard`'s footer.)
- `AGENTS_LIVE` unchanged (consumed by the compressed Live activity
  footer per § 1).

No tauri / Rust / IPC / spec changes.

## § 9. Testing & Verification

- `npm run check:ipc-mock` — should pass (no IPC changes).
- `python3 hifi/scripts/check-actions.py` — should pass (no new
  registry keys; the Coming-soon modal does not invoke a runtime
  action).
- Manual eye-test:
  - All 4 demo agents render in the new card layout.
  - Click `▼` on a card: expansion animates open, action row +
    Recent runs visible.
  - Mark one demo agent with `attention: 'error'`: Attention strip
    appears, header subtitle shows `· 1 needs attention` in red.
  - Click `+ New agent`: Coming-soon modal opens; `Open Playground`
    swaps it for the existing playground drawer.
  - Filter `paused`: empty list state shows, count badge `(0)`.
  - Live activity footer: 5 rows visible, no card container,
    smaller type than current.

## § 10. Rollout

Single change, no flag. Ship together. Demo data is hardcoded so
there's no migration story; real data binding is a follow-up.
