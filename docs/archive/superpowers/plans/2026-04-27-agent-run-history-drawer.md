# Agent Run History Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a per-agent run history in a right-side drawer when the user clicks `See all →` in the AgentCard's expanded RECENT RUNS section. Each row collapses to a one-line summary and expands inline to show tools, input, output (or error), and memory items touched.

**Architecture:** Single-file frontend change in `hifi/screens-b.jsx`. Existing `recentRuns` entries on `AGENTS_DEMO` are upgraded with new per-run metadata. A pure `generateAgentRunHistory(agent)` helper deterministically synthesizes older runs from each agent's curated 5 entries up to 50 total. Two new components — `RunRow` and `AgentRunHistoryDrawer` — render the drawer; `AgentCard` and `ScreenAgents` get small wiring changes.

**Tech Stack:** React 19 (in-browser via babel transformer, no bundler), `hifi/tokens.css` design tokens, existing `Icon` and `SHOGUN_RUNTIME?.pushToast` helpers.

**Spec:** `docs/superpowers/specs/2026-04-27-agent-run-history-drawer-design.md`

---

## File Map

**Modified:** `hifi/screens-b.jsx` only.

Changes inside `hifi/screens-b.jsx`:
- `AGENTS_DEMO` — each `recentRuns[i]` entry gains `id`, `atMs`, `durationMs`, `tools`, `input`, `output`, `error?`, `memoryTouched`. (Existing fields `t`, `msg`, `level` preserved.)
- New `generateAgentRunHistory(agent)` helper — pure, ~30 lines.
- New `RunRow` component (collapsed + expanded body, ~80 lines).
- New `AgentRunHistoryDrawer` component (backdrop + panel + header + grouping + ESC handler, ~120 lines).
- `AgentCard` — accepts new prop `onOpenHistory(agentId)` and passes it through.
- `ScreenAgents` — adds `historyDrawerAgentId` state, threads `onOpenHistory` to `AgentCard`, renders `AgentRunHistoryDrawer` conditionally.

**No new files.** **No tests** (per spec § 8 — manual eye-test only). Verification = `npm run check:ipc-mock` + manual UI run-through.

**File size watchdog:** Pre-task `screens-b.jsx` is ~1300 lines. After this plan it will be ~1550 lines. The split decision into `hifi/screens-agents.jsx` is **explicitly out of scope** for this plan — defer.

---

## Task 1: Extend `AGENTS_DEMO[i].recentRuns` with new fields

**Files:**
- Modify: `hifi/screens-b.jsx` — `AGENTS_DEMO` (currently lines 741-820)

- [ ] **Step 1: Replace the entire `AGENTS_DEMO` array**

Use Edit with the existing `const AGENTS_DEMO = [...]` block as `old_string` and the extended array below as `new_string`. The reference timestamp constants `AGENTS_DEMO_NOW` and `HOUR` already exist immediately above and stay unchanged.

```js
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
      {
        id: 'inbox-triage-r-1', atMs: AGENTS_DEMO_NOW - 2 * HOUR,
        t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'success',
        durationMs: 1200, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 12:31',
        output: 'Found 3 unread, 1 priority (Yuito).\nDrafted reply to Yuito\'s "Re: All-Strategy".\nSkipped 2 newsletters.',
        memoryTouched: [
          { id: 'm_1779381', title: 'Yuito · Re: All-Strategy' },
          { id: 'm_1779380', title: 'MarkeZine News', note: 'skipped' },
        ],
      },
      {
        id: 'inbox-triage-r-2', atMs: AGENTS_DEMO_NOW - 4 * HOUR,
        t: '12:31', msg: 'Polled inbox · no new priority', level: 'info',
        durationMs: 800, tools: ['gmail'],
        input: 'Sweep Gmail inbox since 10:31',
        output: 'Inbox empty since last sweep.',
        memoryTouched: [],
      },
      {
        id: 'inbox-triage-r-3', atMs: AGENTS_DEMO_NOW - 6 * HOUR,
        t: '10:31', msg: 'Read 5 emails · drafted 2 replies', level: 'success',
        durationMs: 1500, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 08:31',
        output: 'Found 5 unread, 2 priorities.\nDrafted reply to Akiko ("RE: PR review").\nDrafted reply to Mei ("Schedule check").',
        memoryTouched: [
          { id: 'm_1779370', title: 'Akiko · RE: PR review' },
          { id: 'm_1779369', title: 'Mei · Schedule check' },
        ],
      },
      {
        id: 'inbox-triage-r-4', atMs: AGENTS_DEMO_NOW - 8 * HOUR,
        t: '08:31', msg: 'Auth refresh · token rotated', level: 'info',
        durationMs: 400, tools: ['gmail'],
        input: 'Token expiring in 5min — refresh',
        output: 'OAuth refresh succeeded.\nNew token expires 2026-04-27T20:31Z.',
        memoryTouched: [],
      },
      {
        id: 'inbox-triage-r-5', atMs: AGENTS_DEMO_NOW - 10 * HOUR,
        t: '06:31', msg: 'Read 1 email · no draft needed', level: 'success',
        durationMs: 700, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 04:31',
        output: 'Found 1 unread (newsletter).\nMatched memory: similar low-priority pattern.\nNo draft generated.',
        memoryTouched: [
          { id: 'm_1779360', title: 'Daily newsletter', note: 'low-priority' },
        ],
      },
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
      {
        id: 'meeting-notes-r-1', atMs: AGENTS_DEMO_NOW - 12 * HOUR,
        t: '02:30', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success',
        durationMs: 4200, tools: ['calendar', 'memory'],
        input: 'Calendar event end-trigger: "All PJ" 02:00-02:30',
        output: '6 decisions extracted.\nLinked to entities: Yuito, Mei, Akiko.\nFollow-ups due: 2 (assigned to Yuito by Friday).',
        memoryTouched: [
          { id: 'm_1779350', title: 'All PJ · 6 decisions' },
          { id: 'm_1779351', title: 'Follow-up · Yuito · Friday' },
        ],
      },
      {
        id: 'meeting-notes-r-2', atMs: AGENTS_DEMO_NOW - 13.5 * HOUR,
        t: '01:00', msg: 'Calendar event captured · linked to "Yuito" entity', level: 'info',
        durationMs: 1800, tools: ['calendar', 'memory'],
        input: 'Calendar event start: "1:1 Yuito" 01:00-01:30',
        output: 'Pre-meeting brief generated.\nLinked to "Yuito" entity (3 prior touches).',
        memoryTouched: [
          { id: 'm_1779340', title: '1:1 Yuito · pre-brief' },
        ],
      },
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
      {
        id: 'daily-digest-r-1', atMs: AGENTS_DEMO_NOW - 17 * HOUR,
        t: '21:00', msg: 'Wrote daily digest · 14 highlights', level: 'success',
        durationMs: 8500, tools: ['memory', 'note'],
        input: 'Synthesize 2026-04-26 (memory window: 00:00-21:00)',
        output: '14 highlights extracted.\nThemes: Inbox triage tuning, KIOKU phase 2 review.\nWritten to note: "Daily 2026-04-26".',
        memoryTouched: [
          { id: 'm_1779300', title: 'Daily 2026-04-26' },
        ],
      },
      {
        id: 'daily-digest-r-2', atMs: AGENTS_DEMO_NOW - 31 * HOUR,
        t: '07:00', msg: 'Morning brief · 4 priorities surfaced', level: 'success',
        durationMs: 6100, tools: ['memory', 'note'],
        input: 'Generate morning brief for 2026-04-26',
        output: '4 priorities for today.\nP1: Yuito sync · 14:00\nP2: Memory rollup polish\nP3: Agents UI review\nP4: Inbox catch-up',
        memoryTouched: [
          { id: 'm_1779290', title: 'Morning brief 2026-04-26' },
        ],
      },
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
      {
        id: 'weekly-review-r-1', atMs: AGENTS_DEMO_NOW - 4 * 24 * HOUR,
        t: 'Sun 10:00', msg: 'Drafted retro · 3 decisions, 2 risks flagged', level: 'success',
        durationMs: 12300, tools: ['memory', 'note', 'calendar'],
        input: 'Synthesize week of 2026-04-13 to 2026-04-19',
        output: '3 decisions:\n- Adopt KIOKU phase 2 schema\n- Defer multi-provider LLM to v0.5\n- Promote Memory digest to default-on\n\n2 risks flagged:\n- LLM cost trending +20% W/W\n- Inbox triage success rate dropped 8%\n\nDrafted retro: "Week 2026-04-13"',
        memoryTouched: [
          { id: 'm_1779100', title: 'Week 2026-04-13 retro' },
        ],
      },
    ],
  },
];
```

- [ ] **Step 2: Manual verify**

Refresh the Tauri dev app (`Cmd+R`). The Agents screen should still render exactly as before — RECENT RUNS section in each expanded card still shows the same 5 (or fewer) one-line summaries. The new fields are unread by any rendered component yet, so there's no visible change. NO console error.

If you see a console error, stop and report BLOCKED.

- [ ] **Step 3: Commit (stage by name only)**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git diff --cached --stat
git commit -m "feat(agents): extend recentRuns with id/atMs/durationMs/tools/input/output/memoryTouched"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file: `hifi/screens-b.jsx`. If anything else, REVERT and report BLOCKED.

---

## Task 2: `generateAgentRunHistory` synthesizer

**Files:**
- Modify: `hifi/screens-b.jsx` — insert helper above `AgentCard` (currently around line 1099)

- [ ] **Step 1: Add `generateAgentRunHistory` immediately above the existing `function AgentCard(...)` declaration**

Insert this block:

```js
// Pure: deterministically pads agent.recentRuns out to 50 entries by
// stepping backwards from the oldest curated run, using a per-trigger
// stride. Synthetic content is intentionally repetitive so it reads as
// background noise next to the curated entries on top.
function generateAgentRunHistory(agent) {
  const out = [...(agent.recentRuns || [])];
  if (out.length === 0) return out;
  const last = out[out.length - 1];
  // Stride per agent kind, in ms. Cron-ish agents step by 2h, daily by
  // 24h, weekly by 7d. Default falls back to 2h.
  let strideMs;
  if (agent.trigger === 'weekly') strideMs = 7 * 24 * 60 * 60 * 1000;
  else if ((agent.trigger || '').endsWith('daily')) strideMs = 24 * 60 * 60 * 1000;
  else strideMs = 2 * 60 * 60 * 1000;

  // Per-agent template list of {msg, output, tools, durationMs}.
  const templates = SYNTHETIC_RUN_TEMPLATES[agent.id] || SYNTHETIC_RUN_TEMPLATES.default;
  let cursor = last.atMs - strideMs;
  let i = 0;
  while (out.length < 50) {
    const tpl = templates[i % templates.length];
    // every ~12th synthetic run is an error so the drawer can demo failures.
    const isError = (i + 1) % 12 === 0;
    const atMs = cursor;
    const d = new Date(atMs);
    const t = formatRunStamp(d, agent.trigger === 'weekly');
    out.push({
      id: `${agent.id}-r-syn-${i + 1}`,
      atMs, t,
      msg: isError ? 'Run failed · see details' : tpl.msg,
      level: isError ? 'error' : 'info',
      durationMs: tpl.durationMs,
      tools: tpl.tools,
      input: tpl.input,
      output: isError ? '' : tpl.output,
      error: isError ? 'TypeError: Cannot read property \'subject\' of undefined\n    at processInbox (gmail.js:42)\n    at runAgent (runner.js:88)' : undefined,
      memoryTouched: [],
    });
    cursor -= strideMs;
    i += 1;
  }
  return out;
}

function formatRunStamp(d, weekly) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (weekly) {
    const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${wd} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

// Per-agent synthetic run templates. Each agent has 3 templates that
// cycle to keep the synthetic history readable.
const SYNTHETIC_RUN_TEMPLATES = {
  'inbox-triage': [
    { msg: 'Polled inbox · 0 new', durationMs: 600, tools: ['gmail'], input: 'Sweep inbox', output: 'No new mail since last sweep.' },
    { msg: 'Read 2 emails · 0 priority', durationMs: 900, tools: ['gmail', 'memory'], input: 'Sweep inbox', output: '2 newsletters, both auto-archived.' },
    { msg: 'Auth refresh · token rotated', durationMs: 400, tools: ['gmail'], input: 'Token expiring · refresh', output: 'OAuth refresh succeeded.' },
  ],
  'meeting-notes': [
    { msg: 'No calendar events in window', durationMs: 200, tools: ['calendar'], input: 'Window check', output: 'Calendar empty.' },
    { msg: 'Processed 1 meeting · 2 decisions', durationMs: 3100, tools: ['calendar', 'memory'], input: 'Meeting end trigger', output: '2 decisions extracted, linked to 1 entity.' },
    { msg: 'Linked event to entity', durationMs: 1200, tools: ['calendar', 'memory'], input: 'Event start', output: 'Linked to existing entity in memory.' },
  ],
  'daily-digest': [
    { msg: 'Wrote daily digest · 9 highlights', durationMs: 7200, tools: ['memory', 'note'], input: 'Synthesize the day', output: '9 highlights, 1 theme. Note written.' },
    { msg: 'Morning brief · 3 priorities', durationMs: 5800, tools: ['memory', 'note'], input: 'Generate morning brief', output: '3 priorities surfaced.' },
    { msg: 'Wrote daily digest · 12 highlights', durationMs: 8100, tools: ['memory', 'note'], input: 'Synthesize the day', output: '12 highlights across 3 themes.' },
  ],
  'weekly-review': [
    { msg: 'Drafted retro · 2 decisions, 1 risk', durationMs: 11200, tools: ['memory', 'note', 'calendar'], input: 'Synthesize the week', output: '2 decisions, 1 risk flagged.' },
    { msg: 'Drafted retro · 4 decisions', durationMs: 13400, tools: ['memory', 'note', 'calendar'], input: 'Synthesize the week', output: '4 decisions, no risks flagged.' },
  ],
  default: [
    { msg: 'Background tick', durationMs: 300, tools: [], input: 'Tick', output: 'No-op.' },
  ],
};
```

- [ ] **Step 2: Verify the helper compiles (no callers yet)**

The helper isn't called yet — Task 3+ will consume it. Refresh the Tauri app and confirm the Agents screen still renders (no JS error).

If you see a console error, stop and report BLOCKED.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git diff --cached --stat
git commit -m "feat(agents): generateAgentRunHistory synthesizer + per-agent templates"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-b.jsx`. Otherwise REVERT and report BLOCKED.

---

## Task 3: `RunRow` component

**Files:**
- Modify: `hifi/screens-b.jsx` — insert `RunRow` above `function AgentCard(...)` (so above `generateAgentRunHistory` placement OR right after it; either order works since both are above AgentCard)

- [ ] **Step 1: Add `RunRow` immediately above `function AgentCard(...)`**

Insert:

```js
function RunRow({ run, expanded, onToggle, onOpenMemory }) {
  const levelColor = run.level === 'success' ? 'var(--success)'
                   : run.level === 'error'   ? 'var(--danger)'
                   : 'var(--text-mute)';
  const dur = run.durationMs < 1000
    ? `${run.durationMs}ms`
    : `${(run.durationMs / 1000).toFixed(1)}s`;

  return (
    <div style={{display:'flex', flexDirection:'column'}}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          display: 'grid',
          gridTemplateColumns: '56px 48px 1fr auto',
          gap: 'var(--space-3)',
          alignItems: 'baseline',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span className="t-mono" style={{color:'var(--text-mute)', fontSize:11}}>{run.t}</span>
        <span className="t-mono" style={{color:'var(--text-dim)', fontSize:11}}>{dur}</span>
        <span style={{color:'var(--text)', fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {run.msg}
        </span>
        <span
          className="label"
          style={{
            borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
            color: levelColor,
          }}
        >
          {run.level.toUpperCase()}
        </span>
      </button>
      {expanded && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          marginBottom: 'var(--space-2)',
        }}>
          {run.tools && run.tools.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>TOOLS</div>
              <div className="t-sm" style={{color:'var(--text)'}}>{run.tools.join(' · ')}</div>
            </div>
          )}
          {run.input && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>INPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.input}</div>
            </div>
          )}
          {run.level === 'error' && run.error ? (
            <div>
              <div className="t-mono" style={{color:'var(--danger)', fontSize:10, marginBottom:'var(--space-1)'}}>ERROR</div>
              <div
                className="t-sm t-mono"
                style={{
                  color:'var(--text)',
                  whiteSpace:'pre-wrap',
                  borderLeft:'2px solid var(--danger)',
                  paddingLeft:'var(--space-2)',
                  fontSize:11,
                }}
              >
                {run.error}
              </div>
            </div>
          ) : run.output ? (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>OUTPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.output}</div>
            </div>
          ) : null}
          {run.memoryTouched && run.memoryTouched.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>MEMORY TOUCHED</div>
              <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                {run.memoryTouched.map((m, i) => (
                  <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
                    • <span style={{color:'var(--text)'}}>{m.title}</span>
                    {m.note && <span> ({m.note})</span>}
                    {!m.note && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenMemory(m.id); }}
                        style={{
                          all:'unset', cursor:'pointer',
                          color:'var(--text-dim)', fontSize:11,
                          textDecoration:'underline', marginLeft:'var(--space-2)',
                        }}
                      >
                        [open]
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify the component compiles (no callers yet)**

Refresh the Tauri app. No visible change. No console error.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git diff --cached --stat
git commit -m "feat(agents): RunRow component — collapsed + expanded body"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-b.jsx`.

---

## Task 4: `AgentRunHistoryDrawer` component (header + grouping + ESC)

**Files:**
- Modify: `hifi/screens-b.jsx` — insert above `function AgentCard(...)`

- [ ] **Step 1: Add the drawer component**

Insert immediately above `function AgentCard(...)`:

```js
// Bucket runs into 4 chronological groups based on `atMs` and the
// caller's `nowMs`. Returns an ordered array of { label, runs }.
function bucketRunsByDate(runs, nowMs) {
  const now = new Date(nowMs);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  // Start of week = Monday local 00:00.
  const startOfWeek = new Date(startOfToday);
  const dow = startOfWeek.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  startOfWeek.setDate(startOfWeek.getDate() + mondayOffset);

  const buckets = {
    TODAY: [],
    YESTERDAY: [],
    'THIS WEEK': [],
    EARLIER: [],
  };
  for (const r of runs) {
    if (r.atMs >= startOfToday.getTime()) buckets.TODAY.push(r);
    else if (r.atMs >= startOfYesterday.getTime()) buckets.YESTERDAY.push(r);
    else if (r.atMs >= startOfWeek.getTime()) buckets['THIS WEEK'].push(r);
    else buckets.EARLIER.push(r);
  }
  return ['TODAY', 'YESTERDAY', 'THIS WEEK', 'EARLIER']
    .map((label) => ({ label, runs: buckets[label] }))
    .filter((b) => b.runs.length > 0);
}

function AgentRunHistoryDrawer({ agent, nowMs, onClose }) {
  const [expandedRunIds, setExpandedRunIds] = React.useState(() => new Set());
  const toggleExpanded = React.useCallback((id) => {
    setExpandedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runs = React.useMemo(() => generateAgentRunHistory(agent), [agent]);
  const buckets = React.useMemo(() => bucketRunsByDate(runs, nowMs), [runs, nowMs]);

  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] || AGENT_STATUS_META.idle;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  const onOpenMemory = (id) => {
    window.SHOGUN_RUNTIME?.pushToast?.(`Memory item view coming soon (${id})`, 'info');
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position:'fixed', inset:0, zIndex:999,
          background:'rgba(0,0,0,0.4)',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} run history`}
        style={{
          position:'fixed', right:0, top:0, bottom:0,
          width:480, maxWidth:'95vw', zIndex:1000,
          background:'var(--surface)',
          borderLeft:'1px solid var(--border-hi)',
          boxShadow:'var(--shadow-lg)',
          display:'flex', flexDirection:'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding:'var(--space-5) var(--space-6)',
          borderBottom:'1px solid var(--border)',
          display:'flex', alignItems:'flex-start', gap:'var(--space-3)',
        }}>
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
            onClick={onClose}
            aria-label="Close run history"
            style={{
              all:'unset',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
            }}
          >
            <Icon name="x" size={15}/>
          </button>
        </div>
        {/* Content */}
        <div style={{flex:1, overflowY:'auto', padding:'var(--space-5) var(--space-6)'}}>
          {buckets.length === 0 ? (
            <div style={{
              padding:'var(--space-8) var(--space-4)',
              border:`1px dashed var(--border)`,
              borderRadius:'var(--radius-md)',
              textAlign:'center',
              color:'var(--text-mute)',
            }} className="t-sm">
              No runs yet for this agent.
            </div>
          ) : (
            buckets.map(({ label, runs: bucketRuns }, gi) => (
              <div key={label} style={{marginTop: gi === 0 ? 0 : 'var(--space-4)'}}>
                <div className="t-mono" style={{
                  color:'var(--text-mute)', fontSize:10,
                  marginBottom:'var(--space-2)',
                }}>
                  {label}
                </div>
                <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                  {bucketRuns.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      expanded={expandedRunIds.has(r.id)}
                      onToggle={() => toggleExpanded(r.id)}
                      onOpenMemory={onOpenMemory}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify the component compiles (no callers yet)**

Refresh the Tauri app. No visible change. No console error.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git diff --cached --stat
git commit -m "feat(agents): AgentRunHistoryDrawer — backdrop + panel + grouping + ESC"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-b.jsx`.

---

## Task 5: Wire `See all →` to open the drawer

**Files:**
- Modify: `hifi/screens-b.jsx` — `AgentCard` (currently around line 1099) and `ScreenAgents` (currently around line 1300+)

- [ ] **Step 1: Add `onOpenHistory` prop to `AgentCard` and pass through to RecentRunsList**

In `AgentCard`'s function signature, change:

```js
function AgentCard({ agent, expanded, onToggle, nowMs }) {
```

To:

```js
function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory }) {
```

Then find the `<RecentRunsList ... />` usage inside the expanded section (currently around line 1191). It looks like:

```jsx
            <RecentRunsList
              runs={agent.recentRuns}
              onSeeAll={() => window.SHOGUN_RUNTIME?.pushToast?.(`Run history page coming soon`, 'info')}
            />
```

Replace the `onSeeAll` prop with:

```jsx
            <RecentRunsList
              runs={agent.recentRuns}
              onSeeAll={() => onOpenHistory(agent.id)}
            />
```

- [ ] **Step 2: Add drawer state to `ScreenAgents`**

Inside `ScreenAgents`, find where `newAgentModalOpen` was declared (added in Task 7 of the previous plan). Immediately AFTER that line, add:

```js
  const [historyDrawerAgentId, setHistoryDrawerAgentId] = React.useState(null);
```

- [ ] **Step 3: Pass `onOpenHistory` down to every `<AgentCard>`**

Find the existing AgentCard rendering inside the grid (currently around line 1372 — there's only ONE such block, after the empty-state ternary added in Task 8 of the previous plan):

```jsx
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
            />
```

Replace with:

```jsx
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
              onOpenHistory={setHistoryDrawerAgentId}
            />
```

(`setHistoryDrawerAgentId` accepts the agent id, exactly what we're calling it with.)

- [ ] **Step 4: Render the drawer at the bottom of `ScreenAgents`**

Find the existing `<NewAgentModal ... />` block (added in Task 7 of the previous plan). Immediately AFTER that block, insert:

```jsx
      {historyDrawerAgentId && (
        <AgentRunHistoryDrawer
          agent={AGENTS_DEMO.find((a) => a.id === historyDrawerAgentId)}
          nowMs={AGENTS_DEMO_NOW}
          onClose={() => setHistoryDrawerAgentId(null)}
        />
      )}
```

- [ ] **Step 5: Manual verify**

Refresh the Tauri app:
1. Click chevron on Inbox triage to expand the card.
2. In the RECENT RUNS section, click `See all →`.
3. Drawer slides in from the right (no animation in v1 — appears instantly), backdrop dims the rest of the screen.
4. Header: agent icon + `Inbox triage` + `● running · 2h ago · next 14:30` mono sub-line + `✕` button.
5. Content: `TODAY` group at the top (5 curated entries), then synthetic groups (`YESTERDAY`, `THIS WEEK`, `EARLIER`) depending on how the dates fall.
6. Click any row → it expands inline showing TOOLS / INPUT / OUTPUT / MEMORY TOUCHED.
7. Find a row with `[error]` level (every ~12th synthetic row, mostly in `EARLIER`): expanded body shows ERROR section with red-bordered stack text.
8. Click `[open]` link in MEMORY TOUCHED → toast `Memory item view coming soon (m_...)`.
9. Press `ESC` → drawer closes.
10. Click backdrop (anywhere outside the drawer panel) → drawer closes.
11. Open drawer for `Inbox triage`, expand row #1, close drawer, open drawer for `Daily digest` — `expandedRunIds` is fresh (no row pre-expanded).
12. Other agents: `Meeting notes` only has 2 curated runs but the synthesizer pads to 50 (the synthetic content uses the meeting-notes templates).

If any step fails (esp. drawer doesn't open, ESC doesn't close, JS error), stop and report BLOCKED with the specific failure.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx
git diff --cached --stat
git commit -m "feat(agents): wire See all → into per-agent run history drawer"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-b.jsx`.

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

Run from repo root:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS (no IPC changes).
- `check-actions.py`: same pre-existing failures as before — no new errors.

- [ ] **Step 2: Spec § 8 manual run-through**

Refresh the Tauri app one final time. Confirm each item from spec § 8:

1. Inbox triage card → expand → `See all →` → drawer opens with backdrop.
2. Header shows agent icon + name + `● running · 2h ago` sub-line + `✕`.
3. Content shows `TODAY` group at top with first ~5 runs, then `YESTERDAY`, `THIS WEEK`, `EARLIER` (when older synthetic data falls into them).
4. Click a row → expands inline showing TOOLS / INPUT / OUTPUT / MEMORY TOUCHED. Click again → collapses.
5. Click an `[open]` link in MEMORY TOUCHED → toast "Memory item view coming soon".
6. Find a row with `level: 'error'` (every ~12th synthetic run): expanded body shows `ERROR` section with red-bordered stack text.
7. Press ESC → drawer closes.
8. Click backdrop → drawer closes.
9. Open drawer for one agent, close, open for a different agent — `expandedRunIds` is fresh (no leak).
10. Filter to `paused` (empty grid) — no card to expand from, so the drawer entry isn't reachable; that's expected. Switch back to `all`, expand a card, click `See all →`, drawer opens correctly.

- [ ] **Step 3: Orphan / leftover check**

Run:
```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -n "Run history page coming soon" hifi/screens-b.jsx
```

Expected: 0 hits. This was the toast string from the old `See all →` stub — Task 5 should have removed every occurrence.

- [ ] **Step 4: Line count check (informational)**

Run:
```bash
wc -l hifi/screens-b.jsx
```

If the file passes 1500 lines, log a follow-up note: "Consider extracting an `hifi/screens-agents.jsx` to keep the file focused." Not blocking — the split is explicitly out of scope for this plan.

- [ ] **Step 5: No commit (verification only)**

If all steps above pass, the drawer implementation is complete. Report DONE with the commit SHA range from Tasks 1-5 (e.g., `git log --oneline HEAD~5..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the same file.
