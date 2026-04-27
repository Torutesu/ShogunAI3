# Agent Run History Drawer

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-27-agents-screen-redesign-design.md` § 2.2 (the `See all →` link in expanded AgentCard)

## Problem

The Agents screen now shows the last 5 runs of each agent inside the
expanded card. The `See all →` link sits at the bottom of that list
but currently fires only a `Coming soon` toast. To debug a failure or
review an agent's pattern over the last few days, the user has no
way to see runs older than the last five — and no way to inspect
what actually happened in a given run beyond a one-line summary.

We want a drawer that gives the user the agent's full recent history
plus a click-through into each run's input, output, tool usage, and
the memory items it touched. The drawer must keep the Agents list in
view (so context isn't lost) and feel cheap to open and close.

## Goals

- Open the run history for any agent in a right-side drawer
  triggered by the existing `See all →` link.
- List up to 50 recent runs grouped by date (Today / Yesterday /
  This week / Earlier).
- Each row collapsed shows time + duration + message + level pill;
  expanded shows tools, input, output (or error), and the memory
  items touched.
- Same visual language as the rest of the Agents redesign — design
  tokens only, no new CSS file.
- Demo data only this round: a deterministic `generateAgentRunHistory`
  helper synthesizes the older entries from each agent's existing 5
  curated runs. No backend, no IPC.

## Non-Goals

- Real run data wiring. The data source stays `AGENTS_DEMO` +
  the synthetic generator. Real backend integration is a follow-up
  task (and depends on the "Run now / Pause" infra, which is its
  own track).
- Cross-agent history view (showing runs from all agents on one
  timeline). Out of scope — the drawer is per-agent.
- Pagination / infinite scroll. The 50-row cap covers the demo and
  the common debugging window; full history is a follow-up.
- Status filter pills inside the drawer (`All / Errors / Successes`).
  Easy follow-up; deferred so v1 stays focused.
- Editing or replaying a run. Read-only this round.
- Persisting which runs the user expanded across drawer opens.
  Session-scoped state only (`expandedRunIds: Set` resets on close).

## § 1. Layout

```
┌──────────────────────────────────────┐    ┌─────────────────────────────────┐
│ Agents (dim 60%)                      │    │ [📧] Inbox triage         [✕]  │
│   filter pills                        │    │      ● running · 2h ago         │
│   AgentCard ...                       │    ├─────────────────────────────────┤
│   AgentCard ...                       │    │ TODAY                           │
│ ...                                   │    │   14:31  1.2s  Read 3 emails…  │
│                                       │    │                       [✓]       │
│                                       │    │   12:31  0.8s  Polled inbox    │
│         backdrop dim 40%              │    │                       [info]    │
│                                       │    │   ... (today's runs)            │
│                                       │    │                                 │
│                                       │    │ YESTERDAY                       │
│                                       │    │   23:31  0.7s  Auth refresh    │
│                                       │    │   ...                           │
│                                       │    │                                 │
│                                       │    │ THIS WEEK                       │
│                                       │    │   ...                           │
│                                       │    │                                 │
│                                       │    │ EARLIER                         │
│                                       │    │   ...                           │
└──────────────────────────────────────┘    └─────────────────────────────────┘
                                              480px wide, slides from right
```

- Backdrop: `position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 999`. Click → close.
- Drawer: `position: fixed; right: 0; top: 0; bottom: 0; width: 480px; z-index: 1000; background: var(--surface); border-left: 1px solid var(--border-hi); box-shadow: var(--shadow-lg);`
- Render: conditionally rendered (mounts when `historyDrawerAgentId` becomes non-null, unmounts on close — same pattern as NewAgentModal). No slide-in animation in v1; the drawer simply appears. A polished slide animation is an easy follow-up — defer until the static drawer feels right.
- Header: `padding: var(--space-5) var(--space-6); border-bottom: 1px solid var(--border);`. Contents: agent icon (40×40 surface-2 box), agent name (16px / 600), status mono sub-line (`● status · 2h ago`), `✕` close button.
- Content: `flex: 1; overflow-y: auto; padding: var(--space-5) var(--space-6);`.
- ESC key closes the drawer when it's open.

## § 2. Date grouping

Computed at render time from each run's `atMs`:

| group       | window                                                |
|-------------|-------------------------------------------------------|
| TODAY       | from start of today (local) onwards                   |
| YESTERDAY   | from start of yesterday until start of today          |
| THIS WEEK   | from start of week (Monday local) until yesterday end |
| EARLIER     | everything older                                      |

Group header: `t-mono`, `var(--text-mute)`, `fontSize: 10`,
`marginTop: var(--space-4)` (skip the top margin for the very first
group). Empty groups are skipped (no header rendered).

## § 3. Row — collapsed and expanded

### 3.1 Collapsed row

```
14:31  1.2s  Read 3 emails · drafted 1 reply       [✓ success]
```

Grid: `grid-template-columns: 56px 48px 1fr auto; gap: var(--space-3); align-items: baseline; padding: var(--space-2) var(--space-3); cursor: pointer; border-radius: var(--radius-sm);`

Hover: `background: var(--surface-2);`

- Time (`{HH:MM}`): `t-mono`, `var(--text-mute)`, fontSize 11
- Duration (`{N.N}s` or `{NNN}ms`): `t-mono`, `var(--text-dim)`, fontSize 11. Computed from `durationMs`: `< 1000 → "{N}ms"`, else `"{(durationMs/1000).toFixed(1)}s"`
- Message: `var(--text)`, fontSize 12, `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`
- Level pill: same style as existing `RecentRunsList` (uppercase, color from level)

Click anywhere on the row toggles expand. Keyboard: row is a `<button type="button">` for accessibility.

### 3.2 Expanded row body

Renders below the row when expanded. Sections (each with mono uppercase header in `var(--text-mute)`, fontSize 10):

```
TOOLS    gmail · memory

INPUT
  Sweep Gmail inbox since 12:31

OUTPUT
  Found 3 unread, 1 priority (Yuito).
  Drafted reply to Yuito's "Re: All-Strategy".
  Skipped 2 newsletters.

MEMORY TOUCHED
  • m_1779381… "Yuito · Re: All-Strategy" [open]
  • m_1779380… "MarkeZine News" (skipped)
```

If `level === 'error'`, replace `OUTPUT` with:

```
ERROR
  TypeError: Cannot read property 'subject' of undefined
    at processInbox (gmail.js:42)
    at runAgent (runner.js:88)
```

`ERROR` block uses `var(--danger)` for the label color and a thin `border-left: 2px solid var(--danger); padding-left: var(--space-2)` on the content.

`MEMORY TOUCHED` items render as muted text rows; `[open]` link is a stub button that toasts `Memory item view coming soon` (real wiring is a follow-up that goes through the existing memory item viewer in `screens-a.jsx`).

Style: `padding: var(--space-3) var(--space-4); border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: var(--space-3);`

### 3.3 Expansion state

The drawer holds `expandedRunIds: Set<string>` keyed by `run.id`. Multiple rows may be open at once. Closing the drawer resets the set.

## § 4. Demo data

### 4.1 Per-run shape (extension of existing `recentRuns`)

```ts
type Run = {
  id: string;          // stable, e.g. `${agentId}-r-${atMs}`
  atMs: number;        // epoch ms; used for sort + grouping
  t: string;           // display label, e.g. "14:31" or "Sun 10:00" — already present
  msg: string;         // already present
  level: 'success' | 'info' | 'error';  // already present
  // NEW:
  durationMs: number;
  tools: string[];     // e.g. ['gmail', 'memory']
  input: string;       // 1-3 line summary
  output: string;      // multi-line summary; ignored when level==='error'
  error?: string;      // multi-line stack-like text; required when level==='error'
  memoryTouched: { id: string; title: string; note?: string }[];
};
```

### 4.2 Existing 5 curated runs are upgraded in place

The 5 existing entries inside each `AGENTS_DEMO[i].recentRuns` get
the new fields filled by hand (deterministic, hand-written content
so the curated demo reads naturally on the AgentCard's RECENT RUNS
list and on the drawer).

### 4.3 `generateAgentRunHistory(agent)` helper

Pure function in `hifi/screens-b.jsx`. Returns an array of up to 50
runs sorted newest-first:

1. Start with `agent.recentRuns` (the 5 curated entries).
2. Walk backwards in time from the oldest curated run's `atMs`,
   stepping by 2 hours (cron-ish) or 24 hours (daily) or 7 days
   (weekly), depending on the agent's `trigger`.
3. At each step, generate a synthetic run with deterministic content
   based on the agent — a small per-agent template list cycled with
   a seeded counter so the output is stable across reloads.
4. Stop when the array has 50 entries.

The synthetic runs are clearly synthetic (e.g.
`Polled inbox · no new priority mail`) and mostly `level: 'info'`,
with one or two `'error'` sprinkled in (every ~12th run) to give
the drawer something to demo for failures.

### 4.4 No `recentRuns` count breakage

`AgentCard`'s `RECENT RUNS` already does `runs.slice(0, 5)`, so
extending the array (or adding fields) doesn't change what that
component shows. The drawer consumes the full
`generateAgentRunHistory(agent)` output.

## § 5. Drawer state, render, and lifecycle

State in `ScreenAgents`:

```js
const [historyDrawerAgentId, setHistoryDrawerAgentId] = React.useState(null);
```

The `See all →` link in `RecentRunsList` already takes an `onSeeAll`
callback. Currently the AgentCard passes a stub that toasts. Change
that prop chain so AgentCard receives a `onOpenHistory(agentId)`
callback from `ScreenAgents` and passes `() => onOpenHistory(agent.id)`
to `RecentRunsList`. ScreenAgents wires the callback to
`setHistoryDrawerAgentId`.

Drawer render (at the bottom of `ScreenAgents`, alongside
`NewAgentModal`):

```jsx
{historyDrawerAgentId && (
  <AgentRunHistoryDrawer
    agent={AGENTS_DEMO.find((a) => a.id === historyDrawerAgentId)}
    nowMs={AGENTS_DEMO_NOW}
    onClose={() => setHistoryDrawerAgentId(null)}
  />
)}
```

The drawer is conditionally rendered; closing destroys the state
(including `expandedRunIds`). No mount-time animation in v1.

ESC handler: a `useEffect` inside `AgentRunHistoryDrawer` that
`addEventListener('keydown')` for `Escape` and calls `onClose`.

## § 6. Empty state

When `generateAgentRunHistory(agent).length === 0` (would only
happen if the agent has no curated runs and the generator is somehow
short-circuited — defensive only):

```
┌────────────────────────────┐
│ No runs yet for this agent. │
└────────────────────────────┘
```

Centered, dashed border, mute color, fontSize 12. No CTA — agents
without runs are inert (and in practice every demo agent has at
least one curated run).

## § 7. Implementation surface

Single file: `hifi/screens-b.jsx`.

**New components, defined alongside the existing
`AttentionStrip` / `FilterBar` / `NewAgentModal` / `RecentRunsList` / `AgentCard`:**

- `RunRow({ run, expanded, onToggle })` — collapsed + expanded body
- `AgentRunHistoryDrawer({ agent, nowMs, onClose })` — backdrop + drawer panel + grouping logic + ESC handler

**New helper:**

- `generateAgentRunHistory(agent)` — pure function, ~30 lines

**Modified:**

- `AGENTS_DEMO[i].recentRuns` — each entry gains `id`, `atMs`,
  `durationMs`, `tools`, `input`, `output`, `error?`, `memoryTouched`.
- `AgentCard` — receives a new `onOpenHistory(agentId)` prop, passes
  `() => onOpenHistory(agent.id)` to `RecentRunsList`'s `onSeeAll`.
- `ScreenAgents` — adds `historyDrawerAgentId` state, wires
  `onOpenHistory` down to AgentCard, renders `AgentRunHistoryDrawer`
  conditionally.

**File size estimate:** post-redesign `screens-b.jsx` is ~1300 lines;
this adds ~250 lines (~80 for `RunRow`, ~120 for
`AgentRunHistoryDrawer`, ~30 for the generator, ~20 for
`AGENTS_DEMO` field expansions, ~10 for state wiring). New total
~1550 lines.

**Split decision:** if total passes 1500 lines mid-implementation,
extract everything Agents-related (`AGENTS_DEMO` constants,
`AGENTS_LIVE`, `AGENT_STATUS_META`, all helper functions,
`AttentionStrip`, `FilterBar`, `RecentRunsList`, `RunRow`,
`AgentRunHistoryDrawer`, `NewAgentModal`, `AgentsEmptyState`,
`AgentCard`, `ScreenAgents`) into a new `hifi/screens-agents.jsx`,
re-export `ScreenAgents` from `screens-b.jsx` for app.jsx
compatibility. The split is mechanical — defer the call to plan
time once we see the actual line count.

## § 8. Testing & Verification

- `npm run check:ipc-mock` — pass (no IPC changes).
- `python3 hifi/scripts/check-actions.py` — pass (no new registry keys; the `[open]` stub toasts via SHOGUN_RUNTIME without invoking a runtime action).
- Manual eye-test:
  1. Inbox triage card → expand → click `See all →` → drawer slides in from right with backdrop.
  2. Header shows agent icon + name + `● running · 2h ago` sub-line + `✕`.
  3. Content shows `TODAY` group at top with first ~5 runs, then `YESTERDAY`, `THIS WEEK`, `EARLIER` (when older synthetic data is generated).
  4. Click a row → expands inline showing TOOLS / INPUT / OUTPUT / MEMORY TOUCHED. Click again → collapses.
  5. Click an `[open]` link in MEMORY TOUCHED → toast "Memory item view coming soon".
  6. Find a row with `level: 'error'` (every ~12th synthetic run): expanded body shows `ERROR` section with red-bordered stack text.
  7. Press ESC → drawer closes.
  8. Click backdrop → drawer closes.
  9. Open drawer for one agent, close, open for a different agent — `expandedRunIds` is fresh (no leak).
  10. Filter to `paused` (empty list) — `See all →` still works for any agent that's manually expanded before filtering. (Edge: this only matters if the user expands a card, then filters it out — the drawer is independent of filter state.)

## § 9. Rollout

Single change, demo-data-only, no flag, no migration. Ships
together with the previous Agents redesign. The `See all →` link's
existing toast is replaced by the drawer in one shot.
