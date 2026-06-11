# Agents Screen Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Agents screen so it reads as agent management first (status overview second), with inline-expanding cards, an attention strip for failures, and a Coming-soon modal replacing the broken `+ New agent` flow.

**Architecture:** Single-file frontend change. All work confined to `hifi/screens-b.jsx` (`ScreenAgents`, `AgentCard`, plus new inline components). Existing design tokens (`hifi/tokens.css`) are reused; no new CSS file. Demo data (`AGENTS_DEMO`) is extended with per-run history and attention flags. The Playground drawer stays — only its entry point moves.

**Tech Stack:** React 19 (in-browser via babel transformer, no bundler), `hifi/tokens.css` design tokens, `Icon` component (already in scope).

**Spec:** `docs/superpowers/specs/2026-04-27-agents-screen-redesign-design.md`

---

## File Map

**Modified:**
- `hifi/screens-b.jsx` — only file. Touches: `AGENTS_DEMO` (data shape), `AGENT_STATUS_META` (add `error`), `AgentCard` (collapsed + expanded), `ScreenAgents` (header, attention strip, filter bar, agent list, live activity footer, modal wiring). `AgentsKpiCard` deleted (no callers after Task 5).

**No new files.** New components (`AttentionStrip`, `FilterBar`, `RecentRunsList`, `NewAgentModal`, `AgentsEmptyState`) live alongside `AgentCard` in `screens-b.jsx`. If the file passes ~1100 lines after this work, defer the split to a follow-up.

**No tests in scope** (per spec § 9 — manual eye-test only). Verification = `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual UI run-through with the live Tauri dev app.

---

## Task 1: Extend AGENTS_DEMO data shape + status meta

**Files:**
- Modify: `hifi/screens-b.jsx:697-753` (`AGENTS_DEMO`, `AGENT_STATUS_META`)

- [ ] **Step 1: Replace `AGENTS_DEMO` (lines 697-738)**

Use Edit with the existing 4-element array as `old_string` and the extended array below as `new_string`. The new shape:
- adds `lastRunMs` (epoch ms of most recent run; null if never)
- adds `nextRunMs` (epoch ms of next scheduled fire; null for event/idle/paused)
- adds `recentRuns` (array of `{ t, msg, level }`, last 5, newest first)
- adds optional `attention` (`'error' | 'stale' | 'auth_expired'`)
- removes `runs: number` (not rendered anywhere after this redesign)

Replace lines 697-738 with:

```js
// Demo timestamps: anchored to a fixed reference instant so the relative
// labels ("2h ago", "next 14:00") render consistently across reloads.
const AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');
const HOUR = 60 * 60 * 1000;
const AGENTS_DEMO = [
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    icon: 'mail',
    status: 'running',
    trigger: 'every 2 hours',
    triggerSince: '2026-04-12',
    description: 'Sorts Gmail by memory-derived priority. Drafts replies for you to approve.',
    tools: [{ name: 'mail', icon: 'mail' }, { name: 'memory', icon: 'memory' }],
    lastRunMs: AGENTS_DEMO_NOW - 2 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 0.5 * HOUR,
    recentRuns: [
      { t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'success' },
      { t: '12:31', msg: 'Polled inbox · no new priority', level: 'info' },
      { t: '10:31', msg: 'Read 5 emails · drafted 2 replies', level: 'success' },
      { t: '08:31', msg: 'Auth refresh · token rotated', level: 'info' },
      { t: '06:31', msg: 'Read 1 email · no draft needed', level: 'success' },
    ],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    icon: 'calendar',
    status: 'idle',
    trigger: 'on calendar event',
    triggerSince: '2026-03-22',
    description: 'Captures calendar events, extracts decisions into memory, links to entities.',
    tools: [{ name: 'calendar', icon: 'calendar' }, { name: 'memory', icon: 'memory' }],
    lastRunMs: AGENTS_DEMO_NOW - 12 * HOUR,
    nextRunMs: null,
    recentRuns: [
      { t: '02:30', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success' },
      { t: '01:00', msg: 'Calendar event captured · linked to "Yuito" entity', level: 'info' },
    ],
  },
  {
    id: 'daily-digest',
    name: 'Daily digest',
    icon: 'note',
    status: 'scheduled',
    trigger: '21:00 daily',
    triggerSince: '2026-04-01',
    description: 'Synthesizes the day at 21:00. Writes a morning brief for tomorrow at 07:00.',
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }],
    lastRunMs: AGENTS_DEMO_NOW - 17 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 6.5 * HOUR,
    recentRuns: [
      { t: '21:00', msg: 'Wrote daily digest · 14 highlights', level: 'success' },
      { t: '07:00', msg: 'Morning brief · 4 priorities surfaced', level: 'success' },
    ],
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    icon: 'clock',
    status: 'scheduled',
    trigger: 'weekly',
    triggerSince: '2026-03-08',
    description: 'Sunday morning. What moved this week? What needs decisions. Drafts a retro.',
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }, { name: 'calendar', icon: 'calendar' }],
    lastRunMs: AGENTS_DEMO_NOW - 4 * 24 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 3 * 24 * HOUR,
    recentRuns: [
      { t: 'Sun 10:00', msg: 'Drafted retro · 3 decisions, 2 risks flagged', level: 'success' },
    ],
  },
];
```

- [ ] **Step 2: Extend `AGENT_STATUS_META` (lines 748-753) to add `error` state**

Replace:

```js
const AGENT_STATUS_META = {
  running: { color: 'var(--success)', label: 'running' },
  scheduled: { color: 'var(--gold)', label: 'scheduled' },
  idle: { color: 'var(--text-mute)', label: 'idle' },
  paused: { color: 'var(--text-dim)', label: 'paused' },
};
```

With:

```js
const AGENT_STATUS_META = {
  running: { color: 'var(--success)', label: 'running' },
  scheduled: { color: 'var(--gold)', label: 'scheduled' },
  idle: { color: 'var(--text-mute)', label: 'idle' },
  paused: { color: 'var(--text-dim)', label: 'paused' },
  error: { color: 'var(--danger)', label: 'error' },
};
```

- [ ] **Step 3: Verify the page still renders (no breakage)**

The `AgentCard` component at line 765 currently reads `agent.status`, `agent.icon`, `agent.name`, `agent.trigger`, `agent.description`, `agent.runs`, `agent.tools`. After the data change, `agent.runs` is `undefined` — the card footer renders `{agent.runs} RUNS` which becomes `undefined RUNS`. **This is expected and will be fixed in Task 2**.

In the running Tauri app, refresh (`Cmd+R`) → Agents screen should render with `undefined RUNS` in each card's footer. No JS error.

If you see a JS error in DevTools, stop and report BLOCKED.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): extend AGENTS_DEMO with run history + attention flags"
```

---

## Task 2: AgentCard collapsed redesign

**Files:**
- Modify: `hifi/screens-b.jsx:765-806` (`AgentCard` function)

- [ ] **Step 1: Add a small relative-time helper at the top of the file**

Insert this helper function immediately ABOVE `const AGENTS_DEMO_NOW = ...` (which is the line you added in Task 1, around line 697):

```js
// "2h ago" / "12m ago" / "Sun 10:00" — relative to AGENTS_DEMO_NOW.
function fmtRelativeTime(ms, nowMs) {
  if (!ms || !nowMs) return '—';
  const diff = nowMs - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "14:00" / "Sun 10:00" — formatted next-fire time, today vs future-day-aware.
function fmtNextTime(ms, nowMs) {
  if (!ms || !nowMs) return null;
  const d = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${hh}:${mm}`;
}

// "running · 2h ago · next 14:00" — derives the small mono sub-line.
function buildAgentSubLine(agent, statusLabel, nowMs) {
  const parts = [statusLabel];
  if (agent.lastRunMs && statusLabel !== 'paused') {
    parts.push(`${fmtRelativeTime(agent.lastRunMs, nowMs)}`);
  } else if (agent.lastRunMs && statusLabel === 'paused') {
    parts.push(`last ${fmtRelativeTime(agent.lastRunMs, nowMs)}`);
  }
  const next = fmtNextTime(agent.nextRunMs, nowMs);
  if (next && (statusLabel === 'running' || statusLabel === 'scheduled')) {
    parts.push(`next ${next}`);
  }
  return parts.join(' · ');
}
```

- [ ] **Step 2: Rewrite `AgentCard` (lines 765-806) for the collapsed layout**

Replace the entire `function AgentCard({ agent }) { … }` block with:

```js
function AgentCard({ agent, expanded, onToggle, nowMs }) {
  // If the most recent run failed, surface it as `error` regardless of
  // the schema status — operationally this is what matters.
  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] || AGENT_STATUS_META.idle;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  return (
    <div
      className="card card-hover"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderColor: expanded ? 'var(--border-hi)' : 'var(--border)',
        transition: `border-color var(--dur-base) var(--ease-out)`,
      }}
    >
      <div style={{padding:'var(--space-4) var(--space-6)', display:'flex', alignItems:'flex-start', gap:'var(--space-3)'}}>
        <div style={{
          width:40, height:40, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:'1px solid var(--border)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', flexShrink:0,
        }}>
          <Icon name={agent.icon} size={18}/>
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em', marginBottom:4}}>{agent.name}</div>
          <div className="t-mono" style={{display:'inline-flex', alignItems:'center', gap:'var(--space-2)'}}>
            <span style={{width:6, height:6, borderRadius:999, background:status.color, display:'inline-block'}}/>
            {subLine}
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse agent' : 'Expand agent'}
          aria-expanded={expanded}
          style={{
            all:'unset',
            padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
          }}
        >
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15}/>
        </button>
      </div>
      <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-4) var(--space-6)', color:'var(--text-mute)'}} className="t-sm">
        {agent.description}
      </div>
      {/* expanded section is added in Task 3 — keep this empty placeholder until then */}
      <div style={{padding:'var(--space-3) var(--space-6)', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
        <span style={{flex:1}}/>
        {agent.tools.map((tool) => (
          <span key={tool.name} className="label" style={{display:'inline-flex', alignItems:'center', gap:5}}>
            <Icon name={tool.icon} size={11}/>{tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}
```

Key changes from current:
- Added props: `expanded`, `onToggle`, `nowMs`.
- `⋯` more-button replaced with `▼ / ▲` chevron toggle (`Icon name="chevron-down"`/`"chevron-up"`). If those icon names don't exist in the Icon component, fall back to `name="more"` for both states (functional, just visually less ideal — flag as concern).
- Sub-line now built dynamically from status + relative-time helpers.
- `effectiveStatus` derives `error` from the last run's level.
- Footer no longer shows `N RUNS`; only tool chips remain.

- [ ] **Step 3: Update the `ScreenAgents` agent grid (lines 905-908) to pass the new props**

Find the existing block at line 905-909:

```jsx
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {AGENTS_DEMO.map((a) => (
          <AgentCard key={a.id} agent={a}/>
        ))}
      </div>
```

Replace with (note: also add a `useState` for expanded set at top of `ScreenAgents`):

First, near the existing `useState` declarations at the top of `ScreenAgents` (around lines 809-811), add:

```js
  const [expandedIds, setExpandedIds] = React.useState(() => new Set());
  const toggleExpanded = React.useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
```

Then replace the grid block with:

```jsx
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {AGENTS_DEMO.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            expanded={expandedIds.has(a.id)}
            onToggle={() => toggleExpanded(a.id)}
            nowMs={AGENTS_DEMO_NOW}
          />
        ))}
      </div>
```

- [ ] **Step 4: Manual verify in app**

Refresh Tauri (`Cmd+R`). Each card now shows:
- header sub-line in mono: `● running · 2h ago · next 14:30` etc.
- chevron-down icon in the top-right of each card
- footer with tool chips only (no `RUNS` count)

Click a chevron → it toggles to chevron-up; the card border lightens to `--border-hi`. No expanded content visible yet — that comes in Task 3.

Note: if `chevron-down` / `chevron-up` icons aren't defined in `Icon`, the button shows nothing or a fallback. Continue (Task 3 will be the visible change anyway). Note as concern in the report.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): collapsed AgentCard redesign — dynamic sub-line + expand toggle"
```

---

## Task 3: AgentCard expanded section (TRIGGER + actions + RECENT RUNS)

**Files:**
- Modify: `hifi/screens-b.jsx` — `AgentCard` (insert expanded section between description and footer)

- [ ] **Step 1: Add a `RecentRunsList` component above `AgentCard`**

Insert immediately above the `function AgentCard(...)` declaration:

```js
function RecentRunsList({ runs, onSeeAll }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="t-sm" style={{color:'var(--text-mute)', padding:'var(--space-2) 0'}}>
        No runs yet.
      </div>
    );
  }
  return (
    <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {runs.slice(0, 5).map((r, i) => {
        const levelColor = r.level === 'success' ? 'var(--success)'
                         : r.level === 'error'   ? 'var(--danger)'
                         : 'var(--text-mute)';
        return (
          <div key={i} style={{display:'grid', gridTemplateColumns:'48px 1fr auto', gap:'var(--space-3)', alignItems:'center'}} className="t-sm">
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{r.t}</span>
            <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.msg}</span>
            <span
              className="label"
              style={{
                borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
                color: levelColor,
              }}
            >
              {r.level.toUpperCase()}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onSeeAll}
        style={{
          all: 'unset',
          alignSelf: 'flex-end',
          marginTop: 'var(--space-1)',
          color: 'var(--text-dim)',
          fontSize: 11,
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        See all →
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Insert the expanded section into `AgentCard`**

In `AgentCard`, locate the JSX block that opens with `{/* expanded section is added in Task 3 — keep this empty placeholder until then */}` and the footer block immediately below it.

Replace the placeholder comment line with:

```jsx
      {expanded && (
        <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-5) var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-4)'}}>
          {/* TRIGGER */}
          <div>
            <div className="t-mono" style={{color:'var(--text-mute)', marginBottom:'var(--space-1)'}}>TRIGGER</div>
            <div className="t-sm">
              {agent.trigger}
              {agent.triggerSince && <> · since {agent.triggerSince}</>}
              {fmtNextTime(agent.nextRunMs, nowMs) && <> · next {fmtNextTime(agent.nextRunMs, nowMs)}</>}
            </div>
          </div>
          {/* Actions */}
          <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Run now: ${agent.name} (stub)`, 'info')}
            >
              <Icon name="play" size={12}/> Run now
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`${agent.status === 'paused' ? 'Resume' : 'Pause'}: ${agent.name} (stub)`, 'info')}
            >
              <Icon name={agent.status === 'paused' ? 'play' : 'pause'} size={12}/>
              {agent.status === 'paused' ? ' Resume' : ' Pause'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Edit: ${agent.name} (stub)`, 'info')}
            >
              <Icon name="edit" size={12}/> Edit
            </button>
          </div>
          {/* Recent runs */}
          <div>
            <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:'var(--space-2)'}}>
              <span className="t-mono" style={{color:'var(--text-mute)'}}>RECENT RUNS</span>
            </div>
            <RecentRunsList
              runs={agent.recentRuns}
              onSeeAll={() => window.SHOGUN_RUNTIME?.pushToast?.(`Run history page coming soon`, 'info')}
            />
          </div>
        </div>
      )}
```

- [ ] **Step 3: Manual verify**

Refresh Tauri. Click chevron-down on `Inbox triage`:
- TRIGGER section shows: `every 2 hours · since 2026-04-12 · next 14:30`.
- Three buttons render: gold `Run now`, secondary `Pause`, secondary `Edit`. Clicking each shows a stub toast in the bottom-right.
- RECENT RUNS shows 5 mono rows with timestamp + message + level pill (`SUCCESS` green, `INFO` muted).
- A muted `See all →` link appears below the runs; clicking it shows a toast.

Click chevron-up → expanded section disappears.

If the icon names `play` / `pause` / `edit` don't exist in `Icon`, the buttons render text only. Functional, note as concern.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): expanded AgentCard — trigger, actions, recent runs"
```

---

## Task 4: AttentionStrip component

**Files:**
- Modify: `hifi/screens-b.jsx` — add `AttentionStrip` component, render in `ScreenAgents` above the agents grid

- [ ] **Step 1: Define `AttentionStrip` above `AgentCard`**

Insert immediately above `function RecentRunsList(...)`:

```js
const ATTENTION_REASONS = {
  error: (a) => `${a.name} failed last run ${'lastRunRel' in a ? a.lastRunRel : 'recently'}.`,
  stale: (a) => `${a.name} hasn't run in over 24 hours.`,
  auth_expired: (a) => `${a.name} needs re-authorization.`,
};

function AttentionStrip({ agents, nowMs, onView }) {
  // Derive issues: explicit `attention` flag, OR last run was error,
  // OR scheduled/cron and lastRunMs is older than 24h.
  const issues = [];
  for (const a of agents) {
    const last = a.recentRuns && a.recentRuns[0];
    const tooStale =
      (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
      a.lastRunMs && (nowMs - a.lastRunMs) > 24 * 60 * 60 * 1000;
    let reason = null;
    if (a.attention === 'error' || (last && last.level === 'error')) reason = 'error';
    else if (a.attention === 'auth_expired') reason = 'auth_expired';
    else if (a.attention === 'stale' || tooStale) reason = 'stale';
    if (reason) {
      issues.push({
        agent: a,
        reason,
        lastRunRel: a.lastRunMs ? fmtRelativeTime(a.lastRunMs, nowMs) : 'recently',
      });
    }
  }
  if (issues.length === 0) return null;
  const visible = issues.slice(0, 3);
  const overflow = issues.length - visible.length;

  return (
    <div style={{marginBottom:'var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {visible.map(({ agent, reason, lastRunRel }) => (
        <div
          key={agent.id}
          style={{
            display:'flex', alignItems:'center', gap:'var(--space-3)',
            padding:'var(--space-3) var(--space-4)',
            background:'var(--surface-2)',
            borderLeft:'3px solid var(--danger)',
            borderRadius:'var(--radius-md)',
          }}
        >
          <Icon name="alert" size={14} style={{color:'var(--danger)', flexShrink:0}}/>
          <span className="t-sm" style={{flex:1, color:'var(--text)'}}>
            {ATTENTION_REASONS[reason]({ ...agent, lastRunRel })}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Run now: ${agent.name} (stub)`, 'info')}
          >
            Run now
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onView(agent.id)}
          >
            View
          </button>
        </div>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          className="t-sm"
          onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Attention list page coming soon`, 'info')}
          style={{
            all:'unset', cursor:'pointer', color:'var(--text-dim)', alignSelf:'flex-start',
            padding:'var(--space-1) var(--space-2)',
          }}
        >
          +{overflow} more
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render `AttentionStrip` in `ScreenAgents`**

Find the `{/* KPI row */}` comment block (currently at lines 895-901) — that whole block is going away in Task 5, but for now we need to render the AttentionStrip ABOVE it. Insert this block immediately BEFORE the `{/* KPI row */}` comment (which is around line 895):

```jsx
      <AttentionStrip
        agents={AGENTS_DEMO}
        nowMs={AGENTS_DEMO_NOW}
        onView={(id) => {
          setExpandedIds((prev) => new Set([...prev, id]));
          requestAnimationFrame(() => {
            const el = document.getElementById(`agent-card-${id}`);
            if (el && typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        }}
      />
```

For the `View` scroll-into-view to work, add `id={`agent-card-${agent.id}`}` to the outermost `<div className="card card-hover" ...>` inside `AgentCard`. Find that div and add the `id` prop:

```jsx
    <div
      id={`agent-card-${agent.id}`}
      className="card card-hover"
```

- [ ] **Step 3: Inject one demo error to test the strip visually**

For verification only (revert in step 5), modify `AGENTS_DEMO[0].recentRuns[0].level` from `'success'` to `'error'`:

In `AGENTS_DEMO`, find the inbox-triage `recentRuns` array's first entry:

```js
      { t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'success' },
```

Temporarily change to:

```js
      { t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'error' },
```

- [ ] **Step 4: Manual verify**

Refresh Tauri:
- Attention strip appears at the top of the agent area, with: `⚠ Inbox triage failed last run 2h ago.` and `[Run now]` `[View]` buttons.
- Click `View` → the Inbox triage card auto-expands and scrolls into view.
- Inbox triage card's status pill is now red (effectiveStatus = error) — the `● error · …` rendering.
- Other 3 agents have no strip entry.

If strip doesn't render at all, check console for errors and report BLOCKED.

- [ ] **Step 5: Revert the test injection**

Change `level: 'error'` back to `level: 'success'`. The strip should now disappear (no agents with attention).

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): attention strip surfaces failing/stale agents at top"
```

---

## Task 5: Header restructure + remove KPI tiles + remove AgentsKpiCard

**Files:**
- Modify: `hifi/screens-b.jsx` — `ScreenAgents` header + KPI block; delete `AgentsKpiCard`

- [ ] **Step 1: Compute attention count for the subtitle**

In `ScreenAgents`, near the existing `runningCount` / `scheduledCount` / `pausedCount` declarations (currently lines 872-874 — they will be deleted in step 3), add ABOVE them:

```js
  const attentionCount = AGENTS_DEMO.filter((a) => {
    const last = a.recentRuns && a.recentRuns[0];
    const stale = (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
                  a.lastRunMs && (AGENTS_DEMO_NOW - a.lastRunMs) > 24 * 60 * 60 * 1000;
    return a.attention === 'error' || a.attention === 'auth_expired' ||
           (last && last.level === 'error') || a.attention === 'stale' || stale;
  }).length;
```

- [ ] **Step 2: Replace the header subtitle**

Find the header block (line 879-893):

```jsx
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>EXECUTION LAYER</div>
          <h1>Agents</h1>
          <div className="sub">Agents that read your memory and act. {runningCount + scheduledCount + pausedCount + 8} MCP tools available.</div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary" onClick={() => setPlaygroundOpen((v) => !v)}>
            <Icon name="terminal" size={14}/> MCP console
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setPlaygroundOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
        </div>
      </div>
```

Replace with (note: `+ New agent` button rewiring to modal happens in Task 7; for now leave the existing onClick alone):

```jsx
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>EXECUTION LAYER</div>
          <h1>Agents</h1>
          <div className="sub">
            <span style={{color:'var(--text-mute)'}}>{AGENTS_DEMO.length} agents · 11 MCP tools</span>
            {attentionCount > 0 && (
              <>
                <span style={{color:'var(--text-mute)'}}> · </span>
                <span style={{color:'var(--danger)'}}>{attentionCount} needs attention</span>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary" onClick={() => setPlaygroundOpen((v) => !v)}>
            <Icon name="terminal" size={14}/> MCP console
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setPlaygroundOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Delete the KPI row entirely (lines 895-901)**

Find and delete this block:

```jsx
      {/* KPI row */}
      <div style={{display:'grid', gridTemplateColumns:'repeat(4, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        <AgentsKpiCard label="RUNNING" value={runningCount} tone="success"/>
        <AgentsKpiCard label="SCHEDULED" value={scheduledCount} tone="gold"/>
        <AgentsKpiCard label="PAUSED" value={pausedCount} tone="dim"/>
        <AgentsKpiCard label="TOOLS CONNECTED" value={20} tone="gold"/>
      </div>
```

Also delete the now-unused `runningCount` / `scheduledCount` / `pausedCount` declarations (the lines around 872-874).

- [ ] **Step 4: Delete the `AgentsKpiCard` component (lines 755-763)**

Find and delete the entire function:

```js
function AgentsKpiCard({ label, value, tone }) {
  const toneColor = tone === 'success' ? 'var(--success)' : tone === 'gold' ? 'var(--gold)' : tone === 'dim' ? 'var(--text-mute)' : 'var(--text)';
  return (
    <div className="card" style={{display:'flex', flexDirection:'column', gap:'var(--space-3)'}}>
      <div className="t-mono">{label}</div>
      <div className="t-h2" style={{color:toneColor, margin:0}}>{value}</div>
    </div>
  );
}
```

Verify with `grep "AgentsKpiCard" hifi/screens-b.jsx` — should return 0 hits.

- [ ] **Step 5: Manual verify**

Refresh Tauri:
- Header subtitle now reads `4 agents · 11 MCP tools` (mute color), no attention segment because no agents have failures.
- 4 KPI tiles are GONE.
- Attention strip section (from Task 4) renders empty — no JS errors.
- Agent cards still render in 2-col grid.

To test the attention segment in the subtitle: temporarily set `AGENTS_DEMO[0].recentRuns[0].level = 'error'`, refresh — subtitle should now read `4 agents · 11 MCP tools · 1 needs attention` with the last segment in red. Revert.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): structured header subtitle, remove KPI tiles + AgentsKpiCard"
```

---

## Task 6: FilterBar component

**Files:**
- Modify: `hifi/screens-b.jsx` — add `FilterBar` component, wire status filter into agent grid

- [ ] **Step 1: Define `FilterBar` above `AgentCard`**

Insert immediately above `function RecentRunsList(...)`:

```js
const FILTER_OPTIONS = [
  { id: 'all', label: 'all' },
  { id: 'running', label: 'running' },
  { id: 'scheduled', label: 'scheduled' },
  { id: 'paused', label: 'paused' },
  { id: 'error', label: 'error' },
];

function FilterBar({ active, onChange, counts }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:'var(--space-2)',
      marginBottom:'var(--space-4)', flexWrap:'wrap',
    }}>
      {FILTER_OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        const count = counts[opt.id] ?? 0;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            style={{
              all:'unset', cursor:'pointer',
              padding:'var(--space-1) var(--space-3)',
              border:`1px solid ${isActive ? 'var(--border-hi)' : 'var(--border)'}`,
              borderRadius: 999,
              color: isActive ? 'var(--text)' : 'var(--text-mute)',
              fontSize: 12,
              transition: `all var(--dur-fast) var(--ease-out)`,
            }}
          >
            {opt.label} ({count})
          </button>
        );
      })}
      <span style={{flex:1}}/>
      <input
        type="text"
        placeholder="search ⌘F"
        disabled
        style={{
          background:'transparent', border:`1px solid var(--border)`,
          borderRadius:'var(--radius-sm)', padding:'var(--space-1) var(--space-3)',
          color:'var(--text-dim)', fontSize:12, fontFamily:'inherit',
          width:160, opacity:0.6, cursor:'not-allowed',
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Wire filter state in `ScreenAgents`**

Near the existing `useState` declarations at the top of `ScreenAgents` (after `expandedIds` from Task 2), add:

```js
  const [filterStatus, setFilterStatus] = React.useState('all');

  const filterCounts = React.useMemo(() => {
    const c = { all: AGENTS_DEMO.length, running: 0, scheduled: 0, paused: 0, error: 0 };
    for (const a of AGENTS_DEMO) {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      if (c[eff] !== undefined) c[eff] += 1;
    }
    return c;
  }, []);

  const visibleAgents = React.useMemo(() => {
    if (filterStatus === 'all') return AGENTS_DEMO;
    return AGENTS_DEMO.filter((a) => {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      return eff === filterStatus;
    });
  }, [filterStatus]);
```

- [ ] **Step 3: Render `FilterBar` and use `visibleAgents` in the grid**

Find the existing "Your agents" section (currently around line 904):

```jsx
      <div style={{marginBottom:'var(--space-4)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {AGENTS_DEMO.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            expanded={expandedIds.has(a.id)}
            onToggle={() => toggleExpanded(a.id)}
            nowMs={AGENTS_DEMO_NOW}
          />
        ))}
      </div>
```

Replace with:

```jsx
      <div style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <FilterBar
        active={filterStatus}
        onChange={setFilterStatus}
        counts={filterCounts}
      />
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {visibleAgents.map((a) => (
          <AgentCard
            key={a.id}
            agent={a}
            expanded={expandedIds.has(a.id)}
            onToggle={() => toggleExpanded(a.id)}
            nowMs={AGENTS_DEMO_NOW}
          />
        ))}
      </div>
```

- [ ] **Step 4: Manual verify**

Refresh Tauri:
- A horizontal pill row appears between "Your agents" header and the grid: `all (4)  running (1)  scheduled (2)  paused (0)  error (0)`.
- Active pill (`all` initially) has lighter border + white text.
- Click `running` → only Inbox triage shows.
- Click `paused` → grid is empty (no error, just no cards). The empty list state is fine for this task — Task 8 adds the proper empty state.
- Right-side search input is dimmed/disabled.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): filter bar — pill tabs by status with counts"
```

---

## Task 7: NewAgentModal + button rewiring

**Files:**
- Modify: `hifi/screens-b.jsx` — add `NewAgentModal`, change `+ New agent` onClick

- [ ] **Step 1: Define `NewAgentModal` above `AgentCard`**

Insert immediately above `function FilterBar(...)`:

```js
function NewAgentModal({ open, onClose, onOpenPlayground }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New agent"
      onClick={onClose}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(0,0,0,0.5)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:'var(--surface)',
          border:`1px solid var(--border-hi)`,
          borderRadius:'var(--radius-lg)',
          padding:'var(--space-8)',
          maxWidth:480, width:'90%',
          boxShadow:'var(--shadow-lg)',
        }}
      >
        <div className="t-mono" style={{color:'var(--gold)', marginBottom:'var(--space-3)'}}>+ NEW AGENT</div>
        <div style={{fontSize:18, fontWeight:600, marginBottom:'var(--space-3)', letterSpacing:'-0.01em'}}>
          Custom agents — coming in v0.5
        </div>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-2)'}}>
          The four agents above are the curated default set. Custom agent
          creation (your own triggers, prompts, and tool selections) is
          coming in v0.5.
        </p>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-6)'}}>
          Want to experiment with agent-style prompts in the meantime?
        </p>
        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={onOpenPlayground}>Open Playground</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire state and rewire the `+ New agent` button**

In `ScreenAgents`, add a state declaration (place it next to the existing `playgroundOpen`):

```js
  const [newAgentModalOpen, setNewAgentModalOpen] = React.useState(false);
```

Find the `+ New agent` button in the header (it currently calls `setPlaygroundOpen(true)`):

```jsx
          <button type="button" className="btn btn-primary" onClick={() => setPlaygroundOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
```

Replace with:

```jsx
          <button type="button" className="btn btn-primary" onClick={() => setNewAgentModalOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
```

- [ ] **Step 3: Render the modal**

Find the existing Playground drawer rendering at the bottom of `ScreenAgents` (currently line 937 `{playgroundOpen && (`). Add the modal render IMMEDIATELY ABOVE that block:

```jsx
      <NewAgentModal
        open={newAgentModalOpen}
        onClose={() => setNewAgentModalOpen(false)}
        onOpenPlayground={() => {
          setNewAgentModalOpen(false);
          setPlaygroundOpen(true);
        }}
      />
```

- [ ] **Step 4: Manual verify**

Refresh Tauri:
- Click `+ New agent` → modal opens centered, gold "+ NEW AGENT" overline, title "Custom agents — coming in v0.5", body text, two buttons.
- Click outside the modal (the dim backdrop) → closes.
- Click `Close` → closes.
- Click `Open Playground` → modal closes, the Playground drawer opens at the bottom (existing behavior preserved — textarea + Draft + Memory / Open in Chat buttons).
- Click `MCP console` button (still in the header) → still toggles the Playground directly (this is unchanged).

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): + New agent opens Coming-soon modal instead of Playground"
```

---

## Task 8: Empty state when filtered list is empty

**Files:**
- Modify: `hifi/screens-b.jsx` — add `AgentsEmptyState`, render when `visibleAgents` is empty

- [ ] **Step 1: Define `AgentsEmptyState` above `AgentCard`**

Insert immediately above `function NewAgentModal(...)`:

```js
function AgentsEmptyState({ filterStatus, totalCount, onCreate }) {
  // Two flavors: zero agents at all (welcome), vs zero matching the filter.
  if (totalCount === 0) {
    return (
      <div style={{
        padding:'var(--space-12) var(--space-6)',
        border:`1px dashed var(--border)`,
        borderRadius:'var(--radius-lg)',
        textAlign:'center',
        color:'var(--text-mute)',
      }}>
        <div style={{
          width:48, height:48, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:`1px solid var(--border)`,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', marginBottom:'var(--space-4)',
        }}>
          <Icon name="plus" size={20}/>
        </div>
        <div style={{fontSize:16, fontWeight:600, color:'var(--text)', marginBottom:'var(--space-2)'}}>
          No agents yet
        </div>
        <div className="t-sm" style={{marginBottom:'var(--space-4)'}}>
          Agents read your memory and act on your behalf.
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Icon name="plus" size={14}/> Create your first agent
        </button>
      </div>
    );
  }
  return (
    <div style={{
      padding:'var(--space-8) var(--space-6)',
      border:`1px dashed var(--border)`,
      borderRadius:'var(--radius-lg)',
      textAlign:'center',
      color:'var(--text-mute)',
    }} className="t-sm">
      No agents in “{filterStatus}”.
    </div>
  );
}
```

- [ ] **Step 2: Render the empty state when `visibleAgents` is empty**

Locate the agent grid block (added in Task 6):

```jsx
      <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
        {visibleAgents.map((a) => (
          <AgentCard ... />
        ))}
      </div>
```

Replace with:

```jsx
      {visibleAgents.length === 0 ? (
        <div style={{marginBottom:'var(--space-8)'}}>
          <AgentsEmptyState
            filterStatus={filterStatus}
            totalCount={AGENTS_DEMO.length}
            onCreate={() => setNewAgentModalOpen(true)}
          />
        </div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
          {visibleAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
            />
          ))}
        </div>
      )}
```

- [ ] **Step 3: Manual verify**

Refresh Tauri:
- Click `paused` filter → grid replaced by a small dashed-border centered message: `No agents in "paused".`
- Click `all` filter → grid restored.
- To test the welcome empty state: temporarily empty the `AGENTS_DEMO` array (`const AGENTS_DEMO = [];`), refresh — should see the larger "No agents yet" CTA. Click `Create your first agent` → opens the New Agent modal. Revert to the original 4-element array.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): empty states for filtered + zero-agents cases"
```

---

## Task 9: Compress Live activity footer

**Files:**
- Modify: `hifi/screens-b.jsx` — `ScreenAgents` Live activity section

- [ ] **Step 1: Replace the existing Live activity block**

Find the current Live activity block (currently around lines 911-934):

```jsx
      {/* Live activity */}
      <div style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Live activity</div>
      <div className="card" style={{padding:0, overflow:'hidden'}}>
        {AGENTS_LIVE.map((row, i) => (
          <div key={i} style={{
            display:'grid', gridTemplateColumns:'120px 140px 1fr auto', columnGap:'var(--space-4)',
            alignItems:'center', padding:'var(--space-3) var(--space-6)',
            borderBottom: i < AGENTS_LIVE.length - 1 ? '1px solid var(--border)' : 'none',
          }} className="t-sm">
            <span className="t-mono">{row.t}</span>
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{row.agent}</span>
            <span style={{color:'var(--text)', lineHeight:1.5}}>{row.msg}</span>
            <span
              className="label"
              style={{
                borderColor: row.level === 'success' ? 'color-mix(in srgb, var(--success) 60%, var(--border))' : 'var(--border)',
                color: row.level === 'success' ? 'var(--success)' : 'var(--text-mute)',
              }}
            >
              {row.level.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
```

Replace with the compressed footer treatment:

```jsx
      {/* Live activity (compressed footer per spec § 1) */}
      <div className="t-mono" style={{color:'var(--text-dim)', marginTop:'var(--space-8)', marginBottom:'var(--space-2)'}}>
        LIVE ACTIVITY
      </div>
      <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)', borderTop:'1px solid var(--border)', paddingTop:'var(--space-3)'}}>
        {AGENTS_LIVE.slice(0, 5).map((row, i) => {
          const levelColor = row.level === 'success' ? 'var(--success)'
                           : row.level === 'error'   ? 'var(--danger)'
                           : 'var(--text-mute)';
          return (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'80px 120px 1fr auto', columnGap:'var(--space-3)',
              alignItems:'baseline', fontSize:11,
            }} className="t-mono">
              <span style={{color:'var(--text-dim)'}}>{row.t}</span>
              <span style={{color:'var(--text-mute)'}}>{row.agent}</span>
              <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'inherit'}}>{row.msg}</span>
              <span style={{color:levelColor, textTransform:'uppercase', fontSize:10}}>{row.level}</span>
            </div>
          );
        })}
      </div>
```

Differences vs current: no `card` container, no per-row borders, font-size 11 (was 14), level pills become inline mono lowercase-then-uppercase text (no border), the section header is mono-uppercase `LIVE ACTIVITY` in `--text-dim`.

- [ ] **Step 2: Manual verify**

Refresh Tauri:
- Live activity section now reads as a small footer log: thin `LIVE ACTIVITY` mono header, then 5 rows in 11px monospace with mute-coloured agent names and inline level text on the right (success in green, info in mute).
- No card container around it; visually it sits as supporting context, not a primary feature.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git commit -m "feat(agents): compress Live activity into footer log treatment"
```

---

## Task 10: Final verification + cleanup

**Files:** none (verification only)

- [ ] **Step 1: Static checks**

Run from repo root:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS (no IPC changes were made).
- `check-actions.py`: same pre-existing failures as before (memory.rollup.* etc) — no new errors. The Coming-soon modal does not invoke any runtime action.

- [ ] **Step 2: End-to-end manual run-through**

Refresh the Tauri app one final time. Confirm the spec § 9 verification list:
1. All 4 demo agents render in the new card layout (collapsed).
2. Click chevron on a card: expansion animates open. TRIGGER, action row, RECENT RUNS visible.
3. Inject `recentRuns[0].level = 'error'` for one agent (temp): Attention strip appears, header subtitle shows `· 1 needs attention` in red. Revert.
4. Click `+ New agent`: Coming-soon modal opens; `Open Playground` swaps it for the existing Playground drawer (textarea + buttons).
5. Click filter `paused`: grid empty state shows; switch back to `all`.
6. Live activity footer: 5 rows visible in compressed style, no bordered card.

- [ ] **Step 3: Final orphan-symbol check**

Run:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -n "AgentsKpiCard\|runningCount\|scheduledCount\|pausedCount\|agent\.runs[^M]" hifi/screens-b.jsx
```

Expected: 0 hits (or only false-positive non-target matches). Any remaining reference to `AgentsKpiCard` or the old count variables means a dead symbol — delete it before finalizing.

- [ ] **Step 4: No commit (verification only)**

If all steps above pass, the redesign is complete. Report DONE with the SHA range from Tasks 1-9 (e.g., `git log --oneline HEAD~9..HEAD`).

If any step fails, fix the underlying cause as a follow-up commit on the same file.
