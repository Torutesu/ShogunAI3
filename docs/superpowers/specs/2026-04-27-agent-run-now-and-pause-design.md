# Agent Run now / Pause — wire to existing background workers

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-27-agents-screen-redesign-design.md` § 2.2 (the `Run now` and `Pause/Resume` action buttons)

## Problem

The `[▶ Run now]` and `[⏸ Pause]` buttons in the AgentCard's
expanded action row are stub toasts. The four demo agents map
cleanly onto background workers / commands the codebase already
ships (`gmail.sync`, `google_calendar.sync`,
`memory.rollup.day.get`, `memory.rollup.get`), and the workers
already gate themselves on per-section settings flags. We want the
buttons to drive those existing primitives so the UI feels real
without introducing a new scheduler or persistence layer.

## Goals

- `Run now` invokes the agent's mapped IPC action and shows
  loading + result via toast.
- `Pause` flips the existing per-section auto-sync flag in
  settings to `false`; `Resume` flips it back to `true`. The
  background workers honor that flag without code changes.
- AgentCard's status pill renders `paused` whenever the agent's
  underlying setting is `false`.
- Per-agent runtime mapping lives in a single hardcoded dictionary
  (`AGENT_RUNTIME`) at the top of the agents file — easy to extend
  when more agents are added.
- Daily-digest and weekly-review explicitly share one settings flag
  (`enableMemoryDigestAutoSync`); pausing one pauses the other. The
  UI doesn't try to hide this — it's the current rollup_sync.rs
  reality.

## Non-Goals

- A new agent scheduler or DB-backed agent definitions. Agents
  remain hardcoded in `AGENTS_DEMO` + `AGENT_RUNTIME`.
- Per-agent independent pause for daily vs weekly digest. Both
  share `enableMemoryDigestAutoSync` because rollup_sync.rs treats
  them as one auto-sync. Independent pause requires worker code
  changes — explicit follow-up.
- Run now retry / progress bars / cancel. The toast model is
  enough for MVP; long-running syncs surface progress through the
  existing per-action toasts and progress events.
- Optimistic UI for Pause/Resume. We re-fetch settings after
  `settings.save` and rebuild `effectiveAgents` from the server
  truth.
- Surfacing Run now failures in the AttentionStrip. The strip stays
  on its current heuristics (`error` from `recentRuns`, stale,
  auth_expired). MVP — easy follow-up to add a transient
  `lastRunNowFailed` flag if needed.
- Wiring AGENT_RUNTIME into AGENTS_DEMO via a `runtime` field on
  each agent. The dictionary stays separate so `AGENTS_DEMO` keeps
  its current "demo data" feel.

## § 1. Per-agent runtime mapping

A single hardcoded dictionary in `hifi/screens-agents.jsx`,
defined near the top with the other Agents constants:

```js
const AGENT_RUNTIME = {
  'inbox-triage': {
    runNowAction: 'gmail.sync',
    runNowPayload: () => ({ maxResults: 20 }),
    runNowSuccessMsg: (data) => `Synced ${data?.imported ?? 0} emails`,
    pausedSettingPath: ['integrations', 'gmailAutoSync'],
  },
  'meeting-notes': {
    runNowAction: 'calendar.sync',
    runNowPayload: () => ({ maxResults: 25 }),
    runNowSuccessMsg: (data) => `Synced ${data?.imported ?? 0} events`,
    pausedSettingPath: ['integrations', 'googleCalendarAutoSync'],
  },
  'daily-digest': {
    runNowAction: 'memory.rollup.day.get',
    runNowPayload: () => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      return { dayStartMs: day.getTime(), regenerate: true };
    },
    runNowSuccessMsg: () => 'Daily digest regenerated',
    pausedSettingPath: ['memory', 'enableMemoryDigestAutoSync'],
  },
  'weekly-review': {
    runNowAction: 'memory.rollup.get',
    runNowPayload: () => {
      const cursor = new Date();
      const day = cursor.getDay();
      const mondayOffset = (day === 0 ? -6 : 1 - day);
      const monday = new Date(cursor);
      monday.setDate(cursor.getDate() + mondayOffset);
      monday.setHours(0, 0, 0, 0);
      return { weekStartMs: monday.getTime(), regenerate: true };
    },
    runNowSuccessMsg: () => 'Weekly review regenerated',
    pausedSettingPath: ['memory', 'enableMemoryDigestAutoSync'],
  },
};
```

The four `runNowAction` values are already registered in
`hifi/lib/action-registry.js` (verified — `gmail.sync`,
`calendar.sync`, `memory.rollup.day.get`, `memory.rollup.get`).

`pausedSettingPath` is `[section, key]`. The full path under
`settings.sections.{section}.{key}` is what the existing
`*_sync.rs` workers read.

## § 2. Run now

### 2.1 Button states

| state    | visual                                      | enabled |
|----------|---------------------------------------------|---------|
| idle     | `[▶ Run now]` (gold primary)                | yes     |
| running  | `[⟳ Running…]` with spinner icon, opacity:0.6, cursor:wait | no |

The button stays in `running` from click until the IPC promise
settles — no other transitions.

### 2.2 State + handler in ScreenAgents

```js
const [runningIds, setRunningIds] = React.useState(() => new Set());

const runAgentNow = React.useCallback(async (agentId) => {
  const agent = effectiveAgents.find((a) => a.id === agentId);
  const def = AGENT_RUNTIME[agentId];
  if (!agent || !def) return;
  setRunningIds((prev) => new Set([...prev, agentId]));
  try {
    const res = await runRuntimeActionA(def.runNowAction, def.runNowPayload(), { silentError: true });
    if (res?.ok) {
      window.SHOGUN_RUNTIME?.pushToast?.(def.runNowSuccessMsg(res.data), 'success');
    } else {
      const errMsg = res?.error?.message || 'Run failed';
      window.SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
    }
  } finally {
    setRunningIds((prev) => {
      const next = new Set(prev);
      next.delete(agentId);
      return next;
    });
  }
}, [effectiveAgents]);
```

### 2.3 AgentCard wiring

`AgentCard` gains props `running: boolean` and `onRunNow: () => void`.

The Run now button JSX inside the expanded action row:

```jsx
<button
  type="button"
  className="btn btn-sm btn-primary"
  disabled={running}
  onClick={onRunNow}
  style={{opacity: running ? 0.6 : 1, cursor: running ? 'wait' : 'pointer'}}
>
  <Icon name={running ? 'loader' : 'play'} size={12}/>
  {running ? ' Running…' : ' Run now'}
</button>
```

ScreenAgents passes:

```jsx
<AgentCard
  …existing props…
  running={runningIds.has(a.id)}
  onRunNow={() => runAgentNow(a.id)}
/>
```

### 2.4 Error handling

All errors flow through the existing toast system. Common failures:

- **Credentials missing** (e.g. Gmail not connected): the action returns `{ ok: false, error: { message: 'needsCredentials' | 'gmail credentials missing' | … } }`. The handler shows `{agentName}: {message}` as a `warn` toast.
- **Network / API error**: same shape, same toast path.
- **IPC unavailable**: caught by `runRuntimeActionA`'s `silentError: true`; we fall through to the `warn` toast with the surfaced message.

No modal blocking, no retry queue. The user clicks again if they want to retry.

## § 3. Pause / Resume

### 3.1 Button states

| paused | visual              |
|--------|---------------------|
| false  | `[⏸ Pause]`         |
| true   | `[▶ Resume]`        |

Toggle between the two via a single button whose label/icon flips
on `agent.paused`.

### 3.2 Status pill flip

When `effectiveAgents[i].paused === true`:

- `effectiveStatus` becomes `'paused'` (overrides any other derivation, including the `error` derivation from `recentRuns[0].level`)
- Status pill shows `● paused · last 2h ago` (no `next` segment)
- AttentionStrip's stale heuristic skips paused agents — pausing intentionally is not "stale"

### 3.3 Settings fetch + cache

ScreenAgents loads settings on mount and on demand via a tick state:

```js
const [settings, setSettings] = React.useState(null);
const [settingsTick, setSettingsTick] = React.useState(0);

React.useEffect(() => {
  let cancelled = false;
  runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
    if (cancelled) return;
    if (r?.ok && r.data?.settings?.sections) setSettings(r.data.settings.sections);
  });
  return () => { cancelled = true; };
}, [settingsTick]);
```

`settings` starts as `null` — the first ~100ms after mount, all
agents render as not-paused. Acceptable for MVP — this matches how
the rest of the app handles initial settings load.

### 3.4 effectiveAgents derivation extended

```js
const effectiveAgents = React.useMemo(() => {
  return AGENTS_DEMO.map((a) => {
    const o = agentOverrides[a.id];
    let merged = o ? { ...a, ...o } : a;
    const def = AGENT_RUNTIME[a.id];
    if (def && settings) {
      const [section, key] = def.pausedSettingPath;
      const enabled = settings[section]?.[key];
      if (enabled === false) {
        merged = { ...merged, status: 'paused', paused: true };
      }
    }
    return merged;
  });
}, [agentOverrides, settings]);
```

The `paused: true` field is added so `AgentCard`'s status pill
logic can prefer it over the `error` derivation.

### 3.5 Toggle handler

```js
const togglePauseAgent = React.useCallback(async (agentId) => {
  const agent = effectiveAgents.find((a) => a.id === agentId);
  const def = AGENT_RUNTIME[agentId];
  if (!agent || !def) return;
  const [section, key] = def.pausedSettingPath;
  const currentEnabled = settings?.[section]?.[key];
  const nextEnabled = currentEnabled === false ? true : false;

  const patch = { section, [key]: nextEnabled };
  const res = await runRuntimeActionA('settings.save', patch, { silentError: true });
  if (res?.ok) {
    setSettingsTick((n) => n + 1);
    window.SHOGUN_RUNTIME?.pushToast?.(
      nextEnabled
        ? `${agent.name} resumed`
        : `${agent.name} paused — background work halted`,
      'info',
    );
  } else {
    window.SHOGUN_RUNTIME?.pushToast?.(`Failed to update ${agent.name}`, 'warn');
  }
}, [effectiveAgents, settings]);
```

`setSettingsTick((n) => n + 1)` forces the settings useEffect to
re-fetch — the next render uses the freshly-saved value, no
optimistic update needed.

### 3.6 AgentCard wiring

`AgentCard` gains `onTogglePause: () => void` (no `paused` prop —
it derives from `agent.paused`). The Pause/Resume button:

```jsx
<button
  type="button"
  className="btn btn-sm btn-secondary"
  onClick={onTogglePause}
>
  <Icon name={agent.paused ? 'play' : 'pause'} size={12}/>
  {agent.paused ? ' Resume' : ' Pause'}
</button>
```

ScreenAgents passes `onTogglePause={() => togglePauseAgent(a.id)}`.

## § 4. AttentionStrip stale-skip

`AttentionStrip`'s issue-derivation loop currently flags agents
that haven't run in 24h+. Add a guard:

```js
if (a.paused) continue;
```

at the top of the per-agent loop, before any reason matching. A
paused agent never appears in the strip — even if its last run was
an error, the user paused it intentionally.

## § 5. EditAgentModal — paused field NOT exposed

Editing is for Name / Description / Trigger only (per the previous
spec). `paused` is settings-derived, not part of the override layer.
The modal does not show or edit it.

## § 6. Implementation surface

Single file: `hifi/screens-agents.jsx`. New code:

- `AGENT_RUNTIME` constant — ~40 lines
- `runningIds` + `runAgentNow` callback in ScreenAgents — ~25 lines
- `settings` + `settingsTick` state + load effect — ~12 lines
- Extended `effectiveAgents` derivation — +6 lines
- `togglePauseAgent` callback — ~20 lines
- AgentCard prop changes (`running`, `onRunNow`, `onTogglePause`) and button JSX — ~15 lines
- AttentionStrip stale-skip guard — 1 line

Total: ~120 lines. After this round, `screens-agents.jsx` lands at
~1655 lines (still under the 1900-line line we hit pre-split).

No Rust changes. No IPC changes. No new actions registered. No new
settings keys — all four `pausedSettingPath` values point to keys
that already exist in the settings schema and are already honored
by `*_sync.rs` workers.

## § 7. Testing & Verification

- `npm run check:ipc-mock`: PASS.
- `python3 hifi/scripts/check-actions.py`: same pre-existing
  failures only.

Manual eye-test:

1. Inbox triage card → expand → click `[▶ Run now]`. Button flips to `[⟳ Running…]` and disables. After ~1-3 seconds (or however long Gmail sync takes), toast shows `Synced N emails` (or `warn` toast with the credentials/network error). Button returns to `Run now`.
2. Click `[⏸ Pause]`. Button flips to `[▶ Resume]`. Toast: `Inbox triage paused — background work halted`. Status pill on the card flips to `● paused · last 2h ago` (no `next` segment).
3. Open the Settings modal → Integrations pane. Confirm the Gmail auto-sync toggle is now off. Flip it back on manually. Re-render: AgentCard's status pill returns to `running`. (Confirms the source of truth is the settings flag, not local state.)
4. Click `[⏸ Pause]` on Daily digest. Toast. Both Daily digest AND Weekly review status pills flip to paused (shared flag — expected behavior).
5. Click `[▶ Resume]` on Weekly review. Both flip back. (Same shared flag.)
6. Pause an agent, then click Run now on it. The button still works — Run now is a manual override, not blocked by paused.
7. Pause Inbox triage, then mark its `recentRuns[0].level = 'error'` (temporarily). Refresh. AttentionStrip should NOT show an entry for Inbox triage (paused agents are skipped). Revert.
8. Click Run now on Daily digest → toast confirming regeneration. Switch to Memory screen → Day rollup banner shows the freshly-regenerated content.

## § 8. Rollout

Single change, no flag, no migration. Edits four AgentCard
buttons' behavior, threads two new pieces of state through
ScreenAgents, and extends `effectiveAgents` derivation by 6 lines.
Ships together.
