# Agent Edit Modal + File Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split all Agents-related code out of `hifi/screens-b.jsx` into a new `hifi/screens-agents.jsx`, then add `EditAgentModal` (Name / Description / Trigger) wired through a session-scoped `agentOverrides` layer.

**Architecture:** First do a pure mechanical extraction — the Agents block (lines ~694–1907 in screens-b.jsx, plus the `window.ScreenAgents` assignment) moves verbatim to a new file, with one new `<script>` tag in the HTML. Then add EditAgentModal + parseTrigger/serializeTrigger helpers + overrides state inside the new file. Both phases keep the UI behavior identical except for the now-functional Edit button.

**Tech Stack:** React 19 (in-browser via babel transformer, no bundler), `hifi/tokens.css` design tokens, existing `Icon` global.

**Spec:** `docs/superpowers/specs/2026-04-27-agent-edit-modal-and-file-split-design.md`

---

## File Map

**Created:** `hifi/screens-agents.jsx` (~1850 lines after Edit modal added).

**Modified:**
- `hifi/screens-b.jsx` — Agents block (lines ~694–1907) deleted; line 1909 (`window.ScreenAgents = ScreenAgents;`) deleted. Result: ~600 lines containing only `ScreenChat` and its helpers + `window.ScreenChat = ScreenChat;`.
- `SHOGUN Hi-Fi UI.html` — add `<script type="text/babel" src="hifi/screens-agents.jsx"></script>` immediately after the existing `screens-b.jsx` line.

**No tests** (per spec § 7 — manual eye-test only). Verification = `npm run check:ipc-mock` + manual UI run-through.

---

## Task 1: Mechanical extraction — create `hifi/screens-agents.jsx`

This task is intentionally a single atomic move with NO behavior change. After committing, the app must look and behave identically to before.

**Files:**
- Create: `hifi/screens-agents.jsx`
- Modify: `hifi/screens-b.jsx` (delete the Agents block + the `window.ScreenAgents` assignment)
- Modify: `SHOGUN Hi-Fi UI.html` (add one `<script>` line)

- [ ] **Step 1: Snapshot the Agents block from screens-b.jsx**

The boundaries (current line numbers in screens-b.jsx):
- **Start (inclusive):** line 694 — the blank line before the `// L4 · AGENTS — execution layer` comment header. Take everything from the blank line on line 694 down through line 1907 (the closing `}` of the `ScreenAgents` function).
- **End (exclusive):** line 1908 — `window.ScreenChat = ScreenChat;` stays in screens-b.jsx.
- **Plus:** line 1909 — `window.ScreenAgents = ScreenAgents;` — extract this too.

To capture exactly the right slice, use:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
sed -n '694,1907p;1909p' hifi/screens-b.jsx > /tmp/agents-block.jsx
wc -l /tmp/agents-block.jsx
```

Expected: ~1215 lines. Confirm by reading the first and last line of /tmp/agents-block.jsx — first should be a blank line followed by `// L4 · AGENTS — execution layer`, last should be `window.ScreenAgents = ScreenAgents;`.

- [ ] **Step 2: Create `hifi/screens-agents.jsx` with a header + the extracted block**

Write the new file. Start with a 2-line header banner that mirrors the L4 banner style, then paste the extracted block:

```bash
cat > hifi/screens-agents.jsx <<'HEADER_EOF'
// hifi/screens-agents.jsx
// Agents (execution layer) — extracted from screens-b.jsx for file-size hygiene.
// All globals (React, Icon, window.SHOGUN_RUNTIME) are loaded by earlier <script> tags.
HEADER_EOF
cat /tmp/agents-block.jsx >> hifi/screens-agents.jsx
```

(Or use Write with the full concatenated string if you prefer — same result.)

Verify:

```bash
wc -l hifi/screens-agents.jsx
head -5 hifi/screens-agents.jsx
tail -5 hifi/screens-agents.jsx
```

Expected: ~1218 lines. Header at top, `window.ScreenAgents = ScreenAgents;` at bottom.

- [ ] **Step 3: Delete the Agents block from `hifi/screens-b.jsx`**

Use Edit (NOT sed) to delete lines 694-1907 AND the standalone line 1909. The cleanest way is two Edits:

(3a) Find the unique anchor at the top of the Agents block:

```jsx
}

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
```

The `}` is the end of the `ScreenChat` function (which ends at line 693). The blank line after it and the comment block are uniquely identifiable.

Replace EVERYTHING from that `}` through the closing brace of `ScreenAgents` and the trailing `window.ScreenAgents = ScreenAgents;` with just the closing `}` of ScreenChat. The new tail of screens-b.jsx should read:

```jsx
}

window.ScreenChat = ScreenChat;
```

The simplest robust approach with the Edit tool: read screens-b.jsx around line 1900-1910 to get the exact final 30 lines, then replace the `}` at line 693 + everything through the last line with just `}\n\nwindow.ScreenChat = ScreenChat;\n`.

Concretely:

```bash
# Verify current ending
tail -15 hifi/screens-b.jsx
# Should show: closing brace of ScreenAgents, blank line, window.ScreenChat = ..., window.ScreenAgents = ...
```

Then apply Edit with `old_string` set to the unique 4-line anchor at the top of the Agents block:

```jsx
}

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
```

…and `new_string` set to:

```jsx
}

window.ScreenChat = ScreenChat;
```

(This will fail with "old_string not unique" only if the Agents banner appears more than once — verify with `grep -c "L4 · AGENTS" hifi/screens-b.jsx`. Expected: 1.)

After the Edit, the file should END at the new `window.ScreenChat = ScreenChat;` line — there should be no Agents code, no `window.ScreenAgents` line, nothing else after.

Verify:

```bash
wc -l hifi/screens-b.jsx           # expected: ~696 lines
tail -5 hifi/screens-b.jsx          # last line should be: window.ScreenChat = ScreenChat;
grep -c "ScreenAgents\|AGENTS_DEMO\|AgentCard" hifi/screens-b.jsx   # expected: 0
```

If any check fails, REVERT (`git restore hifi/screens-b.jsx`) and report BLOCKED.

- [ ] **Step 4: Add the `<script>` tag to `SHOGUN Hi-Fi UI.html`**

Find the existing line 23:

```html
<script type="text/babel" src="hifi/screens-b.jsx"></script>
```

Replace with two lines:

```html
<script type="text/babel" src="hifi/screens-b.jsx"></script>
<script type="text/babel" src="hifi/screens-agents.jsx"></script>
```

- [ ] **Step 5: Manual verify (behavior parity)**

Refresh the Tauri app (`Cmd+R`). The Agents screen must render IDENTICALLY to before:
- Header subtitle, FilterBar, AgentCard grid, AttentionStrip, footer Live activity all visible.
- `+ New agent` opens the Coming-soon modal.
- Click chevron on Inbox triage → expand. Click `[✎ Edit]` → still shows the stub toast `Edit: Inbox triage (stub)` (Task 2 wires it for real).
- Click `See all →` → drawer opens with the full run history.
- All filters work.

If anything is different from pre-split (missing component, console error, etc.), STOP and report BLOCKED. The cardinal rule for Task 1 is "no behavior change."

- [ ] **Step 6: Commit (stage by name only)**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-b.jsx hifi/screens-agents.jsx 'SHOGUN Hi-Fi UI.html'
git diff --cached --stat
git commit -m "refactor(agents): extract Agents code into hifi/screens-agents.jsx"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 3 files: `hifi/screens-b.jsx`, `hifi/screens-agents.jsx`, `SHOGUN Hi-Fi UI.html`. If anything else, REVERT and report BLOCKED.

---

## Task 2: `parseTrigger` + `serializeTrigger` helpers

**Files:**
- Modify: `hifi/screens-agents.jsx` — append helpers near the existing trigger-related helpers (or above `EditAgentModal` definition added in Task 3 — order doesn't matter so long as both helpers exist before any caller).

- [ ] **Step 1: Add the two pure helpers**

Find a stable insertion anchor near the top of `hifi/screens-agents.jsx`, immediately AFTER the `buildAgentSubLine` function (which ends with the line `}` followed by a blank line and the `const AGENTS_DEMO_NOW = ...` line).

The current stretch looks like:

```js
function buildAgentSubLine(agent, statusLabel, nowMs) {
  // ... body ...
  return parts.join(' · ');
}

const AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');
```

Use Edit with the 3-line anchor `}\n\nconst AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');` and replace with the helpers spliced between:

```js
}

// Pure: decode a free-form `agent.trigger` string into a structured form
// the EditAgentModal can edit. Falls back to interval/1/hour when no
// pattern matches and warns to the console (the demo data should never
// hit the fallback in practice).
function parseTrigger(triggerStr) {
  const s = String(triggerStr || '').trim();
  let m;
  m = s.match(/^every (\d+) (minute|hour|day)s?$/);
  if (m) return { type: 'interval', value: Number(m[1]), unit: m[2] };
  m = s.match(/^on (\w+) event$/);
  if (m) return { type: 'event', source: m[1] };
  m = s.match(/^(\d{2}):(\d{2}) daily$/);
  if (m) return { type: 'daily', time: `${m[1]}:${m[2]}` };
  if (s === 'weekly') return { type: 'weekly' };
  console.warn('parseTrigger: unrecognized trigger string:', triggerStr);
  return { type: 'interval', value: 1, unit: 'hour' };
}

// Pure: round-trip a structured form back to the same string format
// AGENTS_DEMO uses today.
function serializeTrigger(form) {
  if (!form || !form.type) return '';
  if (form.type === 'interval') {
    const n = Number(form.value) || 1;
    const u = form.unit || 'hour';
    return `every ${n} ${u}${n === 1 ? '' : 's'}`;
  }
  if (form.type === 'event') {
    return `on ${form.source || 'calendar'} event`;
  }
  if (form.type === 'daily') {
    return `${form.time || '12:00'} daily`;
  }
  if (form.type === 'weekly') {
    return 'weekly';
  }
  return '';
}

const AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');
```

- [ ] **Step 2: Manual verify (no callers yet)**

Refresh the Tauri app. No visible change. Open DevTools console and run:

```js
parseTrigger('every 2 hours')
// → { type: 'interval', value: 2, unit: 'hour' }

parseTrigger('on calendar event')
// → { type: 'event', source: 'calendar' }

parseTrigger('21:00 daily')
// → { type: 'daily', time: '21:00' }

parseTrigger('weekly')
// → { type: 'weekly' }

parseTrigger('garbage')
// → { type: 'interval', value: 1, unit: 'hour' } + console warning

serializeTrigger({ type: 'interval', value: 1, unit: 'hour' })  // 'every 1 hour'
serializeTrigger({ type: 'interval', value: 2, unit: 'hour' })  // 'every 2 hours'
serializeTrigger({ type: 'daily', time: '21:00' })             // '21:00 daily'
serializeTrigger({ type: 'weekly' })                            // 'weekly'
serializeTrigger({ type: 'event', source: 'calendar' })        // 'on calendar event'
```

Round-trip check: `serializeTrigger(parseTrigger(s)) === s` for all four canonical strings used by `AGENTS_DEMO`. If any round-trip fails, fix the helpers before continuing.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): parseTrigger + serializeTrigger pure helpers"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 3: `EditAgentModal` component

**Files:**
- Modify: `hifi/screens-agents.jsx` — insert the component above `AgentCard` (alongside the other modals — `NewAgentModal`, `AgentRunHistoryDrawer`).

- [ ] **Step 1: Add the component**

Use Edit to insert the following block IMMEDIATELY ABOVE the existing `function NewAgentModal(...)` definition. (NewAgentModal is currently around the middle of screens-agents.jsx; find it via `grep -n "^function NewAgentModal" hifi/screens-agents.jsx`.)

```js
function EditAgentModal({ agent, onSave, onClose }) {
  const [name, setName] = React.useState(agent.name);
  const [description, setDescription] = React.useState(agent.description);
  const [triggerForm, setTriggerForm] = React.useState(() => parseTrigger(agent.trigger));

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Validation
  const nameValid = name.trim().length >= 1;
  const descValid = description.trim().length >= 1;
  const triggerValid = (() => {
    if (!triggerForm) return false;
    if (triggerForm.type === 'interval') return Number.isInteger(Number(triggerForm.value)) && Number(triggerForm.value) >= 1;
    if (triggerForm.type === 'event') return Boolean(triggerForm.source);
    if (triggerForm.type === 'daily') {
      if (!/^\d{2}:\d{2}$/.test(triggerForm.time || '')) return false;
      const [h, m] = triggerForm.time.split(':').map(Number);
      return h < 24 && m < 60;
    }
    if (triggerForm.type === 'weekly') return true;
    return false;
  })();
  const saveEnabled = nameValid && descValid && triggerValid;

  // Type change resets the per-type fields to defaults.
  const setType = (type) => {
    if (type === 'interval') setTriggerForm({ type, value: 1, unit: 'hour' });
    else if (type === 'event') setTriggerForm({ type, source: 'calendar' });
    else if (type === 'daily') setTriggerForm({ type, time: '12:00' });
    else if (type === 'weekly') setTriggerForm({ type });
  };

  const onSubmit = () => {
    if (!saveEnabled) return;
    onSave({
      name: name.trim(),
      description: description.trim(),
      trigger: serializeTrigger(triggerForm),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit agent"
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
          display:'flex', flexDirection:'column', gap:'var(--space-5)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div className="t-mono" style={{color:'var(--gold)'}}>EDIT AGENT</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              all:'unset', cursor:'pointer',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)',
            }}
          >
            <Icon name="x" size={14}/>
          </button>
        </div>

        {/* NAME */}
        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>NAME</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:14,
            }}
          />
        </div>

        {/* DESCRIPTION */}
        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>DESCRIPTION</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={240}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:13,
              resize:'vertical',
            }}
          />
        </div>

        {/* TRIGGER */}
        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>TRIGGER</div>
          <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)', marginBottom:'var(--space-3)'}}>
            <span className="t-sm" style={{color:'var(--text-mute)'}}>Type:</span>
            <select
              value={triggerForm.type}
              onChange={(e) => setType(e.target.value)}
              style={{
                padding:'var(--space-1) var(--space-3)',
                background:'var(--surface-2)', border:`1px solid var(--border)`,
                borderRadius:'var(--radius-sm)',
                color:'var(--text)', fontFamily:'inherit', fontSize:13,
              }}
            >
              <option value="interval">Interval</option>
              <option value="event">Event</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          {triggerForm.type === 'interval' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>Every</span>
              <input
                type="number"
                min={1}
                value={triggerForm.value}
                onChange={(e) => setTriggerForm({ ...triggerForm, value: Number(e.target.value) })}
                style={{
                  width:64, padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <select
                value={triggerForm.unit}
                onChange={(e) => setTriggerForm({ ...triggerForm, unit: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="minute">minutes</option>
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
            </div>
          )}

          {triggerForm.type === 'event' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>On</span>
              <select
                value={triggerForm.source}
                onChange={(e) => setTriggerForm({ ...triggerForm, source: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="calendar">calendar</option>
              </select>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>event</span>
            </div>
          )}

          {triggerForm.type === 'daily' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <input
                type="time"
                value={triggerForm.time}
                onChange={(e) => setTriggerForm({ ...triggerForm, time: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <span className="t-sm" style={{color:'var(--text-mute)'}}>daily</span>
            </div>
          )}

          {triggerForm.type === 'weekly' && (
            <div className="t-sm" style={{color:'var(--text-mute)'}}>
              Runs once a week. Specific day/time set by system.
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end', marginTop:'var(--space-2)'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saveEnabled}
            onClick={onSubmit}
            style={{opacity: saveEnabled ? 1 : 0.5, cursor: saveEnabled ? 'pointer' : 'not-allowed'}}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Manual verify (no callers yet)**

Refresh the Tauri app. No visible change — the modal is defined but not yet rendered anywhere. NO console errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): EditAgentModal — name/description/trigger form"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 4: `agentOverrides` state + `effectiveAgents` derivation

**Files:**
- Modify: `hifi/screens-agents.jsx` — `ScreenAgents` function (currently the bottom of the file before the `window.ScreenAgents = ScreenAgents;` line).

- [ ] **Step 1: Add the overrides state and effectiveAgents memo**

Inside `ScreenAgents`, find the existing `historyDrawerAgentId` state (added in the drawer plan). Immediately AFTER that line, insert:

```js
  const [editModalAgentId, setEditModalAgentId] = React.useState(null);
  const [agentOverrides, setAgentOverrides] = React.useState({});

  const effectiveAgents = React.useMemo(() => {
    return AGENTS_DEMO.map((a) => {
      const o = agentOverrides[a.id];
      return o ? { ...a, ...o } : a;
    });
  }, [agentOverrides]);
```

- [ ] **Step 2: Replace `AGENTS_DEMO` with `effectiveAgents` everywhere inside ScreenAgents**

This is a search-and-replace within `ScreenAgents` only. The references that must change (verify with `grep -n AGENTS_DEMO hifi/screens-agents.jsx | head -20`):

1. `attentionCount` filter — currently `AGENTS_DEMO.filter((a) => { ... })` → `effectiveAgents.filter(...)`
2. `filterCounts` useMemo — `for (const a of AGENTS_DEMO)` → `for (const a of effectiveAgents)`. Also the `c.all = AGENTS_DEMO.length` → `c.all = effectiveAgents.length`. The useMemo's dep array also needs `[effectiveAgents]` instead of `[]`.
3. `visibleAgents` useMemo — `if (filterStatus === 'all') return AGENTS_DEMO;` → `return effectiveAgents;`. The filter call: `AGENTS_DEMO.filter(...)` → `effectiveAgents.filter(...)`. Dep array `[filterStatus]` → `[filterStatus, effectiveAgents]`.
4. Header subtitle: `{AGENTS_DEMO.length} agents` → `{effectiveAgents.length} agents`.
5. `<AttentionStrip agents={AGENTS_DEMO} ...>` → `agents={effectiveAgents}`.
6. `<AgentsEmptyState totalCount={AGENTS_DEMO.length} ...>` → `totalCount={effectiveAgents.length}`.
7. `<AgentRunHistoryDrawer agent={AGENTS_DEMO.find((a) => a.id === historyDrawerAgentId)} ...>` → `agent={effectiveAgents.find(...)}`

**Crucially: do NOT replace `AGENTS_DEMO` references that are OUTSIDE ScreenAgents.** The `generateAgentRunHistory(agent)` call inside `AgentRunHistoryDrawer` uses `agent` (a prop), not `AGENTS_DEMO` directly — so it's already correct. The constant `AGENTS_DEMO` itself stays as the source of truth at module scope.

After all 7 replacements, run:

```bash
grep -n "AGENTS_DEMO" hifi/screens-agents.jsx
```

Expected hits: only the original `const AGENTS_DEMO = [...]` declaration line. No other reference.

- [ ] **Step 3: Manual verify (no behavior change yet)**

Refresh the Tauri app. The Agents screen renders identically to before — `agentOverrides` is empty, so `effectiveAgents === AGENTS_DEMO` (each item shallow-cloned, contents identical). All filters / counts / drawer / attention strip work as before.

If anything changes visually or a console error appears, STOP and report BLOCKED.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): agentOverrides state + effectiveAgents merge layer"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

---

## Task 5: Wire Edit button → modal → save

**Files:**
- Modify: `hifi/screens-agents.jsx` — `AgentCard` (the `[✎ Edit]` button), `ScreenAgents` (render the modal, add save handler, thread `onEdit` to AgentCard).

- [ ] **Step 1: Add `onEdit` prop to `AgentCard`**

Find `AgentCard`'s function signature:

```js
function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory }) {
```

Replace with:

```js
function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory, onEdit }) {
```

Find the Edit button inside the expanded action row. It currently looks like:

```jsx
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Edit: ${agent.name} (stub)`, 'info')}
            >
              <Icon name="edit" size={12}/> Edit
            </button>
```

Replace `onClick` with:

```jsx
              onClick={() => onEdit(agent.id)}
```

So the full button becomes:

```jsx
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => onEdit(agent.id)}
            >
              <Icon name="edit" size={12}/> Edit
            </button>
```

- [ ] **Step 2: Add the save handler in `ScreenAgents`**

Inside `ScreenAgents`, near the existing `toggleExpanded` callback, add:

```js
  const onSaveEdit = React.useCallback((agentId, partial) => {
    setAgentOverrides((prev) => ({
      ...prev,
      [agentId]: { ...(prev[agentId] || {}), ...partial },
    }));
    window.SHOGUN_RUNTIME?.pushToast?.(`Updated ${partial.name}`, 'success');
    setEditModalAgentId(null);
  }, []);
```

- [ ] **Step 3: Pass `onEdit` to every AgentCard**

Find the AgentCard rendering inside the agent grid (currently around the bottom of `ScreenAgents`'s return body — there's only ONE such block, after the empty-state ternary):

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
            />
```

- [ ] **Step 4: Render `EditAgentModal` conditionally**

Find the existing `<NewAgentModal ... />` block at the bottom of ScreenAgents. Immediately AFTER that block (and BEFORE the `<AgentRunHistoryDrawer ... />` block, though order doesn't matter functionally), insert:

```jsx
      {editModalAgentId && (
        <EditAgentModal
          agent={effectiveAgents.find((a) => a.id === editModalAgentId)}
          onSave={(partial) => onSaveEdit(editModalAgentId, partial)}
          onClose={() => setEditModalAgentId(null)}
        />
      )}
```

- [ ] **Step 5: Manual verify (full edit flow)**

Refresh the Tauri app:

1. Inbox triage card → expand → click `[✎ Edit]`. Modal opens, centered. Form pre-filled: Name `Inbox triage`, Description `Sorts Gmail by memory-derived priority...`, Type dropdown `Interval`, value `2`, unit `hours`.
2. Change value to `4`. Click `Save changes`. Modal closes. Toast: `Updated Inbox triage`. AgentCard's TRIGGER section now reads `every 4 hours · since 2026-04-12 · next 14:30`. Sub-line shows `running · 2h ago · next 14:30` (the time string format is unchanged).
3. Re-open Edit on Inbox triage. Form now reflects the new value `4 hours`.
4. Change Type to `Daily`. Value widget swaps to a `<input type="time">` defaulted to `12:00`. Click Save. AgentCard's TRIGGER reads `12:00 daily · since 2026-04-12 · next 14:30`.
5. Change Type to `Event`. Save. → `on calendar event`.
6. Change Type to `Weekly`. Hint text appears. Save. → `weekly`.
7. Open Edit on Inbox triage, blank out the Name field. Save button disables.
8. Restore Name. Save button re-enables.
9. Click Cancel → modal closes, no change applied.
10. Click backdrop → same.
11. Press ESC → same.
12. Refresh the Tauri app (`Cmd+R`) → all overrides discarded; AgentCard reverts to `every 2 hours` (proves session-only persistence).
13. Click `See all →` on Inbox triage AFTER editing the name → drawer header shows the EDITED name.
14. AttentionStrip / FilterBar / `+ New agent` modal all still work normally.

If any step fails, STOP and report BLOCKED with the specific failure.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/screens-agents.jsx
git diff --cached --stat
git commit -m "feat(agents): wire Edit button into EditAgentModal + overrides write"
git show HEAD --stat
```

Must show exactly 1 file: `hifi/screens-agents.jsx`.

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
- `check:ipc-mock`: PASS.
- `check-actions.py`: same pre-existing failures only. No new errors.

- [ ] **Step 2: File size sanity**

Run:

```bash
wc -l hifi/screens-b.jsx hifi/screens-agents.jsx
```

Expected:
- `hifi/screens-b.jsx`: ~600 lines (down from ~1900)
- `hifi/screens-agents.jsx`: ~1850 lines

If `screens-b.jsx` is more than 800 lines, the extraction missed something — investigate and fix.

- [ ] **Step 3: Spec § 7 manual run-through**

Refresh the Tauri app and walk through every numbered item in spec § 7. All must pass.

- [ ] **Step 4: Orphan / leftover check**

Run:

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -n "Edit: .*(stub)" hifi/screens-agents.jsx
grep -c "ScreenAgents\|AGENTS_DEMO\|AgentCard" hifi/screens-b.jsx
```

Expected:
- First grep: 0 hits (the old stub toast string is gone).
- Second grep: 0 hits (no Agents references leaked back into screens-b.jsx).

- [ ] **Step 5: No commit (verification only)**

If all steps pass, the redesign is complete. Report DONE with the SHA range from Tasks 1-5 (e.g., `git log --oneline HEAD~5..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the same file.
