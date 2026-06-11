# Agent Run Now / Pause Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stub `Run now` and `Pause` toasts on AgentCard with real wiring: `Run now` invokes the agent's mapped IPC action and toasts the result; `Pause/Resume` flips the existing per-section auto-sync flag in settings (which the background workers already honor) so paused agents truly halt.

**Architecture:** A single hardcoded `AGENT_RUNTIME` dictionary inside `hifi/screens-agents.jsx` maps each demo agent id to (a) an IPC action name + payload + success message and (b) a settings path (`[section, key]`) for its underlying auto-sync flag. ScreenAgents adds two pieces of state — `runningIds: Set` for in-flight Run now and `settings` re-fetched after each Pause/Resume — and threads new props (`running`, `onRunNow`, `onTogglePause`) through `AgentCard`. `effectiveAgents` derivation gains a settings-driven `paused` overlay so the existing status-pill and AttentionStrip code "just work" with no further changes. AttentionStrip skips paused agents in its stale heuristic.

**Tech Stack:** React 19 (in-browser via babel transformer), existing `runRuntimeActionA` IPC helper, existing `settings.save` / `settings.load` actions, existing `gmail.sync` / `calendar.sync` / `memory.rollup.day.get` / `memory.rollup.get` actions (all already registered in `hifi/lib/action-registry.js` — verified).

**Spec:** `docs/superpowers/specs/2026-04-27-agent-run-now-and-pause-design.md`

---

## File Map

**Modified:** `hifi/screens-agents.jsx` only.

Inside that file:
- New constant `AGENT_RUNTIME` (~40 lines) — mapping per agent id.
- ScreenAgents gains `runningIds`, `settings`, `settingsTick` state + load effect + `runAgentNow` + `togglePauseAgent` callbacks (~60 lines).
- `effectiveAgents` useMemo extended by ~6 lines to overlay paused-from-settings.
- `AgentCard` gains 3 props (`running`, `onRunNow`, `onTogglePause`) and the Run now / Pause buttons stop being toast stubs.
- `AttentionStrip` gains a 1-line `if (a.paused) continue;` guard.

**No Rust changes. No new IPC actions. No new settings keys.** All four settings paths (`integrations.gmailAutoSync`, `integrations.googleCalendarAutoSync`, `memory.enableMemoryDigestAutoSync` — used twice) point at flags the existing `*_sync.rs` workers already gate on.

**No tests** (per spec § 7 — manual eye-test only).

---

## Task 1: Add `AGENT_RUNTIME` mapping constant

**Files:**
- Modify: `hifi/screens-agents.jsx` — insert immediately after the existing `AGENT_STATUS_META` declaration

- [ ] **Step 1: Locate `AGENT_STATUS_META` and verify the surrounding context**

Run:

```bash
grep -n "^const AGENT_STATUS_META" hifi/screens-agents.jsx
```

Expected: 1 hit, around line 367 (post-redesign + drawer + edit + split).

Read 5 lines after the closing `};` of that constant to confirm what follows is a blank line + the next definition (probably `function AttentionStrip` or a helper).

- [ ] **Step 2: Insert the `AGENT_RUNTIME` constant**

Use Edit. The `old_string` is the closing `};` of `AGENT_STATUS_META` plus the blank line after it. The exact 3-line anchor:

```js
  error: { color: 'var(--danger)', label: 'error' },
};

```

(Two trailing newlines so the blank line is captured.)

Replace with:

```js
  error: { color: 'var(--danger)', label: 'error' },
};

// Per-agent runtime mapping: which IPC action backs each agent's
// Run now button, and which settings path drives its Pause/Resume.
// Daily-digest and weekly-review intentionally share
// `enableMemoryDigestAutoSync` — pausing one pauses both, matching
// the current rollup_sync.rs behavior.
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

- [ ] **Step 3: Verify the file still parses (no callers yet)**

Refresh the Tauri app (`Cmd+R`). The Agents screen renders identically to before — `AGENT_RUNTIME` is defined but not consumed yet. NO console errors.

If you see a JS error (e.g., "Unexpected token", "AGENT_RUNTIME already declared"), STOP and report BLOCKED.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): add AGENT_RUNTIME — per-agent IPC + settings mapping"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`. If anything else, REVERT and report BLOCKED.

---

## Task 2: Settings load + paused-overlay in `effectiveAgents`

**Files:**
- Modify: `hifi/screens-agents.jsx` — `ScreenAgents` function (state declarations + `effectiveAgents` useMemo)

- [ ] **Step 1: Add settings state + load effect**

Inside `ScreenAgents`, the existing state declarations are clustered at the top of the function. Find the `agentOverrides` declaration (added in the Edit modal plan):

```js
  const [agentOverrides, setAgentOverrides] = React.useState({});
```

IMMEDIATELY AFTER that line, insert:

```js
  // Settings cache for the paused-overlay. Re-fetched whenever
  // settingsTick increments (e.g., after Pause/Resume save).
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

- [ ] **Step 2: Extend `effectiveAgents` to overlay paused-from-settings**

Find the existing `effectiveAgents` useMemo (added in the Edit modal plan). It currently looks like:

```js
  const effectiveAgents = React.useMemo(() => {
    return sourceAgents.map((a) => {
      const o = agentOverrides[a.id];
      return o ? { ...a, ...o } : a;
    });
  }, [agentOverrides, sourceAgents]);
```

Replace with:

```js
  const effectiveAgents = React.useMemo(() => {
    return sourceAgents.map((a) => {
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
  }, [agentOverrides, sourceAgents, settings]);
```

(Two changes: the loop body adds the paused-overlay branch; the dep array adds `settings`.)

- [ ] **Step 3: Manual verify (no behavior change expected on first load)**

Refresh the Tauri app:

- Initial render: `settings` is `null` for ~100ms, so all agents render as before (running/scheduled/idle/error pills unchanged).
- After settings loads: if any agent's underlying auto-sync flag is currently `false` in your settings, that AgentCard's status pill flips to `paused`. If all four flags are `true` (or unset/undefined), no visible change — that's expected.
- No console errors.

To force-test the overlay: open the Settings modal → Integrations pane → toggle Gmail auto-sync OFF → close Settings → refresh. Inbox triage's status pill should now show `● paused · last 2h ago`. Toggle the flag back ON, refresh — pill returns to `running`.

If the flip works, the overlay is wired correctly. If it doesn't, check the DevTools console for the `settings.load` response shape and confirm `r.data.settings.sections.integrations.gmailAutoSync` is the right path (matching `AGENT_RUNTIME['inbox-triage'].pausedSettingPath`).

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): settings cache + paused-overlay in effectiveAgents"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 3: `runAgentNow` callback + `runningIds` state

**Files:**
- Modify: `hifi/screens-agents.jsx` — `ScreenAgents` function (state + callback)

- [ ] **Step 1: Add `runningIds` state**

Inside `ScreenAgents`, find the `settingsTick` declaration added in Task 2:

```js
  const [settingsTick, setSettingsTick] = React.useState(0);
```

IMMEDIATELY AFTER that line, insert:

```js
  const [runningIds, setRunningIds] = React.useState(() => new Set());
```

- [ ] **Step 2: Add the `runAgentNow` callback**

Find the existing `editingAgent` useMemo (added in the Edit modal plan) — it's a few lines below the `visibleAgents` useMemo:

```js
  const editingAgent = React.useMemo(
    () => effectiveAgents.find((a) => a.id === editModalAgentId) || null,
    [effectiveAgents, editModalAgentId],
  );
```

IMMEDIATELY AFTER that block, insert:

```js
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

- [ ] **Step 3: Manual verify (no UI change yet — caller is added in Task 5)**

Refresh the Tauri app. No visible change. Open DevTools console and confirm there are no errors.

To smoke-test the callback in isolation, paste into the DevTools console:

```js
window.SHOGUN_RUNTIME?.pushToast?.('Smoke test', 'info')
```

You should see a toast. (This just confirms the toast helper is reachable from the page; the runAgentNow code path isn't triggered yet.)

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): runAgentNow callback + runningIds state"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 4: `togglePauseAgent` callback

**Files:**
- Modify: `hifi/screens-agents.jsx` — insert callback alongside `runAgentNow` (added in Task 3)

- [ ] **Step 1: Add the `togglePauseAgent` callback**

Find the `runAgentNow` callback you added in Task 3. Locate its closing `}, [effectiveAgents]);`. IMMEDIATELY AFTER that line, insert:

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

- [ ] **Step 2: Manual verify (no UI change yet — caller is added in Task 5)**

Refresh the Tauri app. No visible change. No console errors.

To smoke-test in isolation, paste into the DevTools console (this assumes the page exposes the callback — it doesn't yet, so nothing should happen; this is just to confirm no syntax error breaks the page):

```js
typeof React  // → 'object' (or whatever non-undefined value)
```

If the page fails to render at all, you have a syntax error in the inserted block — REVERT and re-apply.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): togglePauseAgent callback — flips per-section settings flag"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 5: Wire `AgentCard` props + buttons

**Files:**
- Modify: `hifi/screens-agents.jsx` — `AgentCard` (signature + Run now button + Pause button), `ScreenAgents` (grid render)

- [ ] **Step 1: Extend `AgentCard`'s function signature**

Find:

```js
function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory, onEdit }) {
```

Replace with:

```js
function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory, onEdit, running, onRunNow, onTogglePause }) {
```

- [ ] **Step 2: Replace the Run now button stub**

Find the Run now button inside the expanded action row. Currently:

```jsx
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Run now: ${agent.name} (stub)`, 'info')}
            >
              <Icon name="play" size={12}/> Run now
            </button>
```

Replace with:

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

- [ ] **Step 3: Replace the Pause button stub**

Find the Pause button immediately below. Currently:

```jsx
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`${agent.status === 'paused' ? 'Resume' : 'Pause'}: ${agent.name} (stub)`, 'info')}
            >
              <Icon name={agent.status === 'paused' ? 'play' : 'pause'} size={12}/>
              {agent.status === 'paused' ? ' Resume' : ' Pause'}
            </button>
```

Replace with:

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

(Note: switched from `agent.status === 'paused'` to `agent.paused`. The `paused` field is set by the `effectiveAgents` overlay when settings has the flag off; the `status` derivation also reflects it via `merged.status = 'paused'`. Using the dedicated `paused` boolean is more direct and survives any future status-derivation edits.)

- [ ] **Step 4: Pass the new props to every `<AgentCard>`**

Find the AgentCard rendering inside the agent grid. Currently:

```jsx
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
              onOpenHistory={setHistoryDrawerAgentId}
              onEdit={setEditModalAgentId}
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
              onEdit={setEditModalAgentId}
              running={runningIds.has(a.id)}
              onRunNow={() => runAgentNow(a.id)}
              onTogglePause={() => togglePauseAgent(a.id)}
            />
```

- [ ] **Step 5: Manual verify (full Run now + Pause flow)**

Refresh the Tauri app:

1. Inbox triage card → expand → click `[▶ Run now]`. Button immediately flips to `[⟳ Running…]` (icon name `loader` if defined, otherwise the icon area is blank — that's a minor visual issue, not a blocker), disabled. Toast appears: `Synced N emails` (success) or `warn` toast with the credentials/network error after the IPC settles. Button returns to `Run now`.

2. Click `[⏸ Pause]`. Toast: `Inbox triage paused — background work halted`. Status pill on the card flips to `● paused · last 2h ago` (the `next` segment disappears). Button now reads `[▶ Resume]`.

3. Open the Settings modal → Integrations pane. The Gmail auto-sync toggle should now be OFF (= source of truth; the agent's pause flipped it). Don't change it via the modal — just confirm.

4. Back on Agents, click `[▶ Resume]`. Toast: `Inbox triage resumed`. Status pill returns to `● running · 2h ago · next 14:30`. Button returns to `Pause`.

5. Click Pause on `Daily digest`. Toast. Both Daily digest AND Weekly review status pills flip to `paused` — they share `enableMemoryDigestAutoSync`. This is documented as expected.

6. Click Resume on Weekly review. Both flip back. (Same shared flag.)

7. Pause an agent, then click Run now on it. The Run now button still works — Run now is a manual override, not blocked by paused state.

8. Click Run now on Daily digest → toast `Daily digest regenerated` after a few seconds. Switch to Memory screen → Day rollup banner shows the freshly-regenerated content.

If any step fails, STOP and report BLOCKED with the specific failure.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): wire Run now + Pause buttons through AGENT_RUNTIME"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 6: AttentionStrip stale-skip for paused agents

**Files:**
- Modify: `hifi/screens-agents.jsx` — `AttentionStrip` component (insert one guard line)

- [ ] **Step 1: Add the `if (a.paused) continue;` guard**

Find the issue-derivation loop inside `AttentionStrip`:

```js
  const issues = [];
  for (const a of agents) {
    const last = a.recentRuns && a.recentRuns[0];
    const tooStale =
      (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
      a.lastRunMs && (nowMs - a.lastRunMs) > 24 * 60 * 60 * 1000;
    let reason = null;
```

Replace with (inserting one new line after `for (const a of agents) {`):

```js
  const issues = [];
  for (const a of agents) {
    if (a.paused) continue;
    const last = a.recentRuns && a.recentRuns[0];
    const tooStale =
      (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
      a.lastRunMs && (nowMs - a.lastRunMs) > 24 * 60 * 60 * 1000;
    let reason = null;
```

- [ ] **Step 2: Manual verify**

Refresh the Tauri app:

1. Pause Inbox triage. Confirm its status pill flips to `paused`. AttentionStrip should NOT be visible (no other agent has issues).

2. Open DevTools console and inject a temporary error to test the skip logic:

```js
// Find Inbox triage's first run via the React tree — easier just to flip the source
// data, but the simplest test is to manually check that pause + error doesn't surface.
// Step: Resume Inbox triage, then in screens-agents.jsx temporarily change
// AGENTS_DEMO[0].recentRuns[0].level = 'error' to 'error'.
```

Easier test: in `hifi/screens-agents.jsx`, find Inbox triage's first `recentRuns` entry:

```js
        id: 'inbox-triage-r-1', atMs: AGENTS_DEMO_NOW - 2 * HOUR,
        t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'success',
```

Temporarily change `level: 'success'` to `level: 'error'`. Refresh the app:
- AttentionStrip appears with `Inbox triage failed last run 2h ago.` (proves the strip works pre-pause).
- Click `[⏸ Pause]` on Inbox triage. AttentionStrip's entry for Inbox triage should disappear (the new guard skips paused agents).
- Click `[▶ Resume]`. AttentionStrip's entry returns.

After verifying, REVERT the test injection: change `level: 'error'` back to `level: 'success'`.

If the strip doesn't disappear when paused, the guard isn't being hit — verify the `paused` field actually reaches AttentionStrip via `effectiveAgents` (which is what ScreenAgents passes as `agents={effectiveAgents}`).

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): AttentionStrip skips paused agents in stale heuristic"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

Run from repo root:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS.
- `check-actions.py`: same pre-existing failures only. No new errors. (No new registry keys were added — `gmail.sync`, `calendar.sync`, `memory.rollup.day.get`, `memory.rollup.get`, `settings.save`, `settings.load` are all already registered.)

- [ ] **Step 2: Spec § 7 manual run-through**

Refresh the Tauri app and walk through every numbered item in spec § 7 (1 through 8). All must pass.

- [ ] **Step 3: Orphan / leftover check**

Run:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -n "Run now: .*stub\|Pause: .*stub\|Resume: .*stub" hifi/screens-agents.jsx
```

Expected: 0 hits. The old stub toast strings should be fully replaced by the new wiring.

- [ ] **Step 4: File size check**

Run:

```bash
wc -l hifi/screens-agents.jsx
```

Expected: ~1655 lines (per spec § 6). If significantly larger (e.g., > 1750), inspect the diff for accidental duplication.

- [ ] **Step 5: No commit (verification only)**

If all steps pass, the wiring is complete. Report DONE with the SHA range from Tasks 1-6 (`git log --oneline HEAD~6..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the same file.
