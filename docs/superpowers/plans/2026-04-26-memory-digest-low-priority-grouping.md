# Memory Digest Phase 4 — Low-Priority Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface LOW-priority items in the Memory River as a single collapsible "Other" cluster row in the scrubber, replacing the current behavior where LOW items are hidden entirely behind a Filters chip.

**Architecture:** Pure frontend change in `hifi/screens-a.jsx`. Add a new `riverEvents` useMemo derived from the existing `events` useMemo (scoped to `view === 'river'` so Kakejiku / Heatmap / Digest / Search are unaffected). The synthetic cluster entry `{ kind: 'low_cluster', count, items }` flows through the existing scrubber so prev/next, `X / N`, and detail-panel rendering all keep working with one new render branch. Expand state lives in module-scope so it survives Memory→Home→River round trips, resets on app reload.

**Tech Stack:** React (no JSX build — file is loaded as `text/babel` by the Hi-Fi HTML harness), Tauri 2 (no Rust changes), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-04-26-memory-digest-low-priority-grouping-design.md` (commit `51d9162`)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `hifi/screens-a.jsx` | Modify | All UI + state. Add `lowClusterExpanded` state, `riverEvents` useMemo, cluster-header detail panel branch, inline LOW breadcrumb, hour-bin remap. Delete `(+N)` badge. |
| `hifi/lib/ipc-client.js` | Modify (small) | Vary `priority` by item index in the `shogun_memory_summary_batch` mock so e2e tests get a deterministic mix of HIGH / MEDIUM / LOW. |
| `tests/e2e/memory-river-low-cluster.spec.js` | Create | Playwright spec covering: cluster appears, click expand/collapse, LOW filter ON suppresses cluster, Snooze removes LOW, screen-switch persistence, other view modes unaffected. |

No backend (`src-tauri/`) changes. No new IPC actions. No new dependencies.

---

## Pre-flight

- [ ] **Step 0.1: Confirm baseline is green**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all three pass. If `hifi-smoke` fails, stop and investigate before continuing — every task ends by re-running it.

- [ ] **Step 0.2: Verify current branch**

```bash
git branch --show-current
git status --short
```

Expected: branch `feat/memory-digest-phase1`, working tree clean (only this plan file untracked is fine; no unrelated modifications).

---

## Task 1: Promote `effectivePriority` to a component-scope helper

**Why:** Three different blocks need to read an event's effective priority — the existing `events` useMemo, the new `riverEvents` useMemo, and the new cluster-header render branch. Today the helper is defined inline inside `events` useMemo (line 1943), which means we'd duplicate it. Hoist it once.

**Files:**
- Modify: `hifi/screens-a.jsx:1938-1974` (the `events` useMemo)

- [ ] **Step 1.1: Add `getEventPriority` helper above the `events` useMemo**

Find the line just before the existing `events` useMemo (after the `activeKinds` useMemo at line 1931). Add:

```js
  // Resolves an event's effective priority via the summary cache.
  // userPriority (manual pin) wins over priority (LLM). Returns null when
  // unsummarized or when the summary lacks a priority field.
  const getEventPriority = (e) => {
    const s = e && e.memoryId ? summaryByMemId[e.memoryId] : null;
    return (s && (s.userPriority || s.priority)) || null;
  };
```

- [ ] **Step 1.2: Replace inline `effectivePriority` inside the `events` useMemo**

In `hifi/screens-a.jsx`, around lines 1942-1949, change:

```js
    // effective = user's manual override takes precedence over LLM priority.
    const effectivePriority = (s) => (s && (s.userPriority || s.priority)) || null;
    const filtered = rawEvents.filter((e) => {
      if (!matchesProvider(e)) return false;
      if (showLow) return true;
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      if (!s) return true;
      return effectivePriority(s) !== 'low';
    });
```

to:

```js
    const filtered = rawEvents.filter((e) => {
      if (!matchesProvider(e)) return false;
      if (showLow) return true;
      return getEventPriority(e) !== 'low';
    });
```

And around lines 1957-1965, change the `rank` helper from:

```js
    const rank = (e) => {
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      const p = effectivePriority(s);
      if (!p) return 2; // unclassified sits between MED and LOW
      if (p === 'high') return 0;
      if (p === 'medium') return 1;
      if (p === 'low') return 3;
      return 2;
    };
```

to:

```js
    const rank = (e) => {
      const p = getEventPriority(e);
      if (!p) return 2; // unclassified sits between MED and LOW
      if (p === 'high') return 0;
      if (p === 'medium') return 1;
      if (p === 'low') return 3;
      return 2;
    };
```

- [ ] **Step 1.3: Verify no regression**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass. The change is a pure refactor — same behavior, same render output.

- [ ] **Step 1.4: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
refactor(memory-river): hoist getEventPriority helper

Move the event→effective-priority resolution out of the events useMemo
so the upcoming riverEvents useMemo can reuse it without duplication.
No behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add module-scope expand state and React useState wiring

**Why:** Per spec § 1, expand state must survive React unmount when the user switches Memory → Home → Memory, but reset on app reload. Module-scope `let` is the simplest persistence boundary that achieves this.

**Files:**
- Modify: `hifi/screens-a.jsx` (top-of-file module scope; River component body)

- [ ] **Step 2.1: Add module-scope variable near the top of `screens-a.jsx`**

Find the existing module-level helpers (around line 80-95, near `memoryHitToRiverEvent` / `smartSnoozePresets`). Add:

```js
// Memory River — Low-priority cluster expand state. Module-scope so the
// value survives React unmounts (Home tab roundtrip) but resets on app
// reload. Read on River mount; written on every toggle.
let lowClusterExpandedSession = false;
```

Place it right above the `smartSnoozePresets` JSDoc.

- [ ] **Step 2.2: Add useState + persisted setter inside the River component**

Find the River component's state-declaration block (the cluster around lines 1690-1710 where `rawEvents`, `scrubIdx`, `summaryByMemId` etc. live). After the existing `useState` calls, add:

```js
  const [lowClusterExpanded, setLowClusterExpandedRaw] = useState(lowClusterExpandedSession);
  const setLowClusterExpanded = (next) => {
    setLowClusterExpandedRaw((prev) => {
      const v = typeof next === 'function' ? next(prev) : next;
      lowClusterExpandedSession = v;
      return v;
    });
  };
```

The wrapper keeps the module variable in sync no matter how callers update state (boolean or updater function).

- [ ] **Step 2.3: Verify no regression**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass. The state is declared but unused — adds no runtime work.

- [ ] **Step 2.4: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-river): add lowClusterExpanded state with session persistence

Module-scope variable + useState wrapper so the upcoming "Other" cluster
remembers its expanded state across screen switches but resets on app
reload. Not yet consumed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `riverEvents` useMemo (River-scrubber-only)

**Why:** Spec § 1 — keep `events` (shared with Kakejiku/Heatmap) untouched. Derive `riverEvents` for the scrubber only.

**Files:**
- Modify: `hifi/screens-a.jsx` (right after the existing `events` useMemo, around line 1975)

- [ ] **Step 3.1: Add `riverEvents` useMemo**

Insert this block immediately after the closing `}, [...])` of the existing `events` useMemo (around line 1974) and before the `useEffect` for batch summarization at line 1977:

```js
  // Memory Digest Phase 4 — Low-priority cluster.
  // Only the River scrubber consumes this. Other view modes keep using
  // `events` directly so the synthetic cluster entry never leaks into
  // Kakejiku, Heatmap, Digest, or Search.
  // - L filter ON  → passthrough (mixed mode).
  // - L filter OFF → partition LOW out, append a synthetic cluster entry,
  //   and (when expanded) splice the LOW items back in after the cluster.
  const riverEvents = useMemo(() => {
    if (activeFilters.priority.low) return events;
    const mainEvents = events.filter((e) => getEventPriority(e) !== 'low');
    const lowEvents  = events.filter((e) => getEventPriority(e) === 'low');
    if (lowEvents.length === 0) return mainEvents;
    const cluster = {
      kind: 'low_cluster',
      count: lowEvents.length,
      items: lowEvents,
      // sentinel fields so any code that defensively reads .h / .ts / .src
      // on a generic event doesn't NaN. Cluster is excluded from `bins`
      // and `hourIndexFromEvents` because those use `events`, not riverEvents.
      h: 23.99,
      ts: 0,
      src: 'note',
      title: '',
      snippet: '',
      memoryId: null,
      provenance: null,
      sourceRaw: '',
      entityId: null,
    };
    return lowClusterExpanded
      ? [...mainEvents, cluster, ...lowEvents]
      : [...mainEvents, cluster];
  }, [events, activeFilters.priority.low, lowClusterExpanded, summaryByMemId]);
```

- [ ] **Step 3.2: Verify no regression**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass. The new useMemo is computed but not yet read by anything.

- [ ] **Step 3.3: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-river): add riverEvents useMemo with low_cluster synthesis

Derives the scrubber-facing event list with a synthetic 'low_cluster'
entry when the L filter is OFF. Not yet consumed by any render path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Make the mock IPC return mixed priorities (test seam)

**Why:** Today `shogun_memory_summary_batch` and `shogun_memory_summary_get` mocks return `priority: "medium"` for every item, so no LOW items naturally appear in dev/Playwright. We need a deterministic mix to write a meaningful e2e and to manually smoke-test the cluster.

The change is a tiny derivation rule based on the item id. Real Tauri runtime is unaffected.

**Files:**
- Modify: `hifi/lib/ipc-client.js:494-526`

- [ ] **Step 4.1: Add a deterministic `priority` from item id**

In `hifi/lib/ipc-client.js`, add this helper near the top of the mock-transport switch block (or just inside the `shogun_memory_summary_get`/`batch` cases — pick a single shared helper above the switch for clarity):

Find an empty line above the `shogun_memory_summary_get` case (around line 493) and add:

```js
      // Mock-only: derive a stable LOW/MEDIUM/HIGH from the item id so the
      // River cluster UI has something to render. Real backend ignores this.
      const mockPriorityForId = (id) => {
        const s = String(id || '');
        if (!s) return 'medium';
        const last = s.charCodeAt(s.length - 1);
        // ~25% LOW, ~25% HIGH, ~50% MEDIUM
        const m = last % 4;
        if (m === 0) return 'low';
        if (m === 1) return 'high';
        return 'medium';
      };
```

- [ ] **Step 4.2: Use the helper in `shogun_memory_summary_get`**

Change line 502 from:

```js
            priority: "medium",
```

to:

```js
            priority: mockPriorityForId((echo && echo.targetId) || "m_stub"),
```

- [ ] **Step 4.3: Use the helper in `shogun_memory_summary_batch`**

Change line 518 from:

```js
            priority: "medium",
```

to:

```js
            priority: mockPriorityForId((it && it.id) || "m_stub"),
```

- [ ] **Step 4.4: Verify mocks still parse and smoke still passes**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock-sync OK, smoke passes (no assertion in smoke depends on a specific priority value).

- [ ] **Step 4.5: Commit**

```bash
git add hifi/lib/ipc-client.js
git commit -m "$(cat <<'EOF'
test(mock): vary memory.summary priority by item id

Lets dev/Playwright preview LOW/MEDIUM/HIGH mix in the River instead of
all-MEDIUM. Real Tauri backend is unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Switch scrubber bindings to `riverEvents`, add cluster-header detail panel, delete `(+N)` badge

**Why:** This is the visible behavior change — the user now sees a "Other · N items" entry at the end of the scrubber stream. This task does all three together because doing the bindings switch alone (Task 5a) without the render branch (Task 5b) would briefly leave LOW items invisible with no cluster to show.

**Files:**
- Modify: `hifi/screens-a.jsx` lines 2107-2110 (clamping useEffect), 2141 (`scrubbed`), 2658-2663 (header readout + `(+N)` badge), 2673-2675 (next button), 2714-onward (cluster panel render branch)

- [ ] **Step 5.1: Switch the clamping useEffect**

Find the useEffect around lines 2106-2110 that clamps `scrubIdx`:

```js
    setScrubIdx((i) => {
      if (events.length === 0) return 0;
      return Math.min(i, events.length - 1);
    });
  }, [events.length]);
```

Change `events.length` (both occurrences) to `riverEvents.length`:

```js
    setScrubIdx((i) => {
      if (riverEvents.length === 0) return 0;
      return Math.min(i, riverEvents.length - 1);
    });
  }, [riverEvents.length]);
```

- [ ] **Step 5.2: Switch `scrubbed`**

Find line 2138-2142:

```js
  const scrubbed = timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null }
    : events.length
      ? events[Math.min(scrubIdx, events.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null };
```

Change `events` (3 occurrences in this block) to `riverEvents`:

```js
  const scrubbed = timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null }
    : riverEvents.length
      ? riverEvents[Math.min(scrubIdx, riverEvents.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null };
```

- [ ] **Step 5.3: Switch scrubber header `X / N` and delete `(+N)` badge**

Find the block at lines 2648-2669 (the `events.length > 0 && !timelineLoading &&` chevron group). Change:

```js
            {events.length > 0 && !timelineLoading && (
              <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:4}}>
                <button
                  type="button"
                  aria-label="Previous memory"
                  onClick={() => setScrubIdx((i) => Math.max(0, i - 1))}
                  disabled={scrubIdx === 0}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx === 0 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx === 0 ? 0.35 : 1}}
                ><Icon name="chevronLeft" size={11}/></button>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'0 2px'}}>
                  {Math.min(scrubIdx + 1, events.length)} / {events.length}
                  {rawEvents.length > events.length && (
                    <span style={{marginLeft:6, color:'var(--text-mute)'}} title="Low-priority items hidden. Toggle in Filters to show.">
                      (+{rawEvents.length - events.length})
                    </span>
                  )}
                  {batchSummarizing > 0 && (
                    <span style={{marginLeft:8, color:'var(--gold)'}} title={`Summarizing ${batchSummarizing} item(s)…`}>
                      · summarizing {batchSummarizing}
                    </span>
                  )}
                </span>
```

to (note: `events.length` → `riverEvents.length` everywhere in this block, and the `(+N)` `<span>…</span>` block is deleted entirely):

```js
            {riverEvents.length > 0 && !timelineLoading && (
              <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:4}}>
                <button
                  type="button"
                  aria-label="Previous memory"
                  onClick={() => setScrubIdx((i) => Math.max(0, i - 1))}
                  disabled={scrubIdx === 0}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx === 0 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx === 0 ? 0.35 : 1}}
                ><Icon name="chevronLeft" size={11}/></button>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'0 2px'}}>
                  {Math.min(scrubIdx + 1, riverEvents.length)} / {riverEvents.length}
                  {batchSummarizing > 0 && (
                    <span style={{marginLeft:8, color:'var(--gold)'}} title={`Summarizing ${batchSummarizing} item(s)…`}>
                      · summarizing {batchSummarizing}
                    </span>
                  )}
                </span>
```

- [ ] **Step 5.4: Switch the Next button**

Find lines 2670-2675 (the next-memory button). Change:

```js
                <button
                  type="button"
                  aria-label="Next memory"
                  onClick={() => setScrubIdx((i) => Math.min(events.length - 1, i + 1))}
                  disabled={scrubIdx >= events.length - 1}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx >= events.length - 1 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx >= events.length - 1 ? 0.35 : 1}}
```

to:

```js
                <button
                  type="button"
                  aria-label="Next memory"
                  onClick={() => setScrubIdx((i) => Math.min(riverEvents.length - 1, i + 1))}
                  disabled={scrubIdx >= riverEvents.length - 1}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx >= riverEvents.length - 1 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx >= riverEvents.length - 1 ? 0.35 : 1}}
```

- [ ] **Step 5.5: Add cluster-header render branch**

Find the start of the detail panel render around line 2714:

```js
          {!timelineLoading && scrubSummary && !showRaw && (() => {
```

Just **above** that line, insert a new render branch for the cluster:

```js
          {!timelineLoading && scrubbed && scrubbed.kind === 'low_cluster' && (
            <div
              className="memory-summary-card"
              role="button"
              tabIndex={0}
              aria-expanded={lowClusterExpanded}
              aria-controls="low-cluster-items"
              onClick={() => setLowClusterExpanded((v) => !v)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setLowClusterExpanded((v) => !v);
                }
              }}
              style={{
                display:'flex', flexDirection:'column', gap:10,
                marginBottom:14,
                borderLeft:'2px solid var(--border)',
                paddingLeft:14,
                cursor:'pointer',
                userSelect:'none',
              }}
            >
              <div style={{display:'flex', alignItems:'center', gap:10}}>
                <span style={{
                  display:'inline-flex',
                  transform: lowClusterExpanded ? 'rotate(90deg)' : 'none',
                  transition: 'transform 120ms',
                }}>
                  <Icon name="chevronRight" size={14}/>
                </span>
                <div style={{fontSize:18, fontWeight:600, lineHeight:1.3}}>
                  <span className="en-only">Other · {scrubbed.count} items</span>
                  <span className="jp">その他 · {scrubbed.count}件</span>
                </div>
                <span className="t-mono" style={{marginLeft:'auto', fontSize:9, color:'var(--text-dim)', letterSpacing:'0.12em', padding:'2px 6px', border:'1px solid var(--border)', borderRadius:4}}>
                  <span className="en-only">LOW</span>
                  <span className="jp">低優先</span>
                </span>
              </div>
              <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.5}}>
                {lowClusterExpanded ? (
                  <>
                    <span className="en-only">Use → to step through items, or click to collapse.</span>
                    <span className="jp">→ で順送り、もう一度クリックで畳めます。</span>
                  </>
                ) : (
                  <>
                    <span className="en-only">Click to expand and step through {scrubbed.count} low-priority items.</span>
                    <span className="jp">クリックで展開し、{scrubbed.count}件の低優先メモリを順に見ます。</span>
                  </>
                )}
              </div>
            </div>
          )}
```

The codebase only ships `chevronLeft` / `chevronRight` icons (no `chevronDown`), so the snippet above rotates `chevronRight` 90° via inline transform when expanded. If you want to confirm: `grep -oE 'Icon name="[a-zA-Z]+"' hifi/screens-a.jsx hifi/app.jsx | sort -u`.

- [ ] **Step 5.6: Suppress the standard panel when on the cluster**

The existing detail-panel branches (`scrubSummary && !showRaw`, the raw `scrubbed.snippet` fallback, the metadata grid) all read `scrubbed.title` / `scrubbed.snippet` / `scrubbed.sourceRaw` etc. For a synthetic cluster entry these are empty strings — they would render an awkward empty card under our cluster header.

Add `scrubbed.kind !== 'low_cluster'` as a guard to each existing top-level render block in the detail panel. Find each `{!timelineLoading && ...` block in the detail panel area (roughly lines 2680-3082) and add the guard. The four blocks to patch:

1. The provenance/source label row (line 2680-ish, starting `{!timelineLoading && scrubbed && (`):
   change `{!timelineLoading && scrubbed && (` → `{!timelineLoading && scrubbed && scrubbed.kind !== 'low_cluster' && (`
2. The `{!timelineLoading && scrubSummary && !showRaw && (() => {` block (line 2714) — `scrubSummary` is already null when `scrubbed.kind === 'low_cluster'` (because the summary fetch useEffect requires `scrubbed.memoryId`), but add the explicit guard for safety: `{!timelineLoading && scrubbed && scrubbed.kind !== 'low_cluster' && scrubSummary && !showRaw && (() => {`
3. The raw-snippet fallback (search for `scrubbed.snippet || (events.length` near line 2854 — change `events.length` → `riverEvents.length` here too, AND wrap the surrounding render branch in the `kind` guard).
4. The metadata grid block (around lines 3040-3082, the `Source / Captured / Priority / Reason / Entity` grid) — wrap in the guard.

After editing, re-run `grep -n "scrubbed.kind !== 'low_cluster'" hifi/screens-a.jsx` and confirm 4 occurrences (one per block).

- [ ] **Step 5.7: Verify smoke + manual check**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass.

Manual smoke (from spec § 4):

```bash
npm run dev:desktop
```

In the app: navigate to Memory → River. With the default L=OFF filter, advance the scrubber with → to the end. After the last HIGH/MEDIUM/unclassified card, the next step should land on a "Other · N items" panel with a chevron and the hint text. Click → expanded state, hint changes, panel border still neutral. Click again → collapsed.

- [ ] **Step 5.8: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-river): low-priority cluster header in scrubber

Switches scrubber bindings to riverEvents and adds a render branch for
the synthetic 'low_cluster' entry. Removes the (+N) header badge — the
cluster panel itself now communicates the LOW count and is the
discoverable affordance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Inline LOW breadcrumb + Collapse button

**Why:** When `lowClusterExpanded` is true and the user advances past the cluster header, individual LOW items render in the standard detail panel. Per spec § 2-B, give them a breadcrumb so the user knows they're inside the cluster and can collapse back.

**Files:**
- Modify: `hifi/screens-a.jsx` (just above the existing summary-card render, around line 2714)

- [ ] **Step 6.1: Compute cluster-position info**

Just before the cluster-header render added in Task 5.5 (so above all detail-panel JSX), add a derivation:

```js
          {(() => {
            // Cluster-position helpers used by the breadcrumb below and by
            // the Collapse button. Recomputed per render — riverEvents is
            // already memoized so this is cheap.
            const clusterIdx = riverEvents.findIndex((e) => e && e.kind === 'low_cluster');
            const inCluster = lowClusterExpanded
              && clusterIdx >= 0
              && scrubIdx > clusterIdx
              && scrubbed
              && scrubbed.kind !== 'low_cluster'
              && getEventPriority(scrubbed) === 'low';
            const clusterCount = clusterIdx >= 0 ? (riverEvents[clusterIdx].count || 0) : 0;
            const positionInCluster = inCluster ? (scrubIdx - clusterIdx) : 0; // 1-indexed
            return (
              <>
                {inCluster && (
                  <div style={{
                    display:'flex', alignItems:'center', gap:8,
                    fontSize:11, color:'var(--text-dim)',
                    marginBottom:10, paddingLeft:14,
                    borderLeft:'2px solid var(--border)',
                  }}>
                    <Icon name="arrowUp" size={11}/>
                    <span className="en-only">Inside Other cluster · {positionInCluster}/{clusterCount}</span>
                    <span className="jp">その他クラスタ内 · {positionInCluster}/{clusterCount}</span>
                    <button
                      type="button"
                      onClick={() => {
                        setLowClusterExpanded(false);
                        setScrubIdx(clusterIdx);
                      }}
                      style={{
                        marginLeft:'auto',
                        padding:'2px 8px', border:'none', background:'transparent',
                        color:'var(--text-dim)', fontSize:11, cursor:'pointer',
                        fontFamily:'inherit', textDecoration:'underline',
                      }}
                      title="Collapse the Other cluster and return to the cluster header"
                    >
                      <span className="en-only">Collapse</span>
                      <span className="jp">畳む</span>
                    </button>
                  </div>
                )}
              </>
            );
          })()}
```

Insert this block immediately before the cluster-header render branch from Step 5.5 so they sit together.

The icon used here (`arrowUp`) is already in the codebase. Confirm via `grep -oE 'Icon name="[a-zA-Z]+"' hifi/screens-a.jsx hifi/app.jsx | sort -u`.

- [ ] **Step 6.2: Smoke + manual check**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass.

Manual: in `npm run dev:desktop`, expand the cluster and step → into a LOW item. The breadcrumb should appear above the standard detail card. Click `Collapse` → state collapses and you land back on the cluster header.

- [ ] **Step 6.3: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-river): in-cluster breadcrumb with Collapse for LOW items

When the user has expanded the Other cluster and advanced into a LOW
item, render a breadcrumb showing position within the cluster and a
Collapse button that snaps back to the cluster header.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Hour-bin click remap for `riverEvents`

**Why:** The 24-hour bar at the bottom of the River computes `firstIdx` against `events` (line 2229-2235) and uses it as `setScrubIdx(firstIdx)` on click (line 3135). After Task 5, `scrubIdx` indexes into `riverEvents` — a different array. With the cluster collapsed, hour bins whose first event is a LOW item would set `scrubIdx` to an index that doesn't exist in `riverEvents`, landing the scrubber on the wrong card or out of range.

Per spec § 3, keep the bar's **shape** (counts/colors) computed against `events` so the visualization doesn't shift when the user expands/collapses, but compute click targets against `riverEvents`.

**Files:**
- Modify: `hifi/screens-a.jsx:2227-2247` (the `hourIndexFromEvents` useMemo) and `hifi/screens-a.jsx:3115-3135` (the bar click handler / active-bar highlight)

- [ ] **Step 7.1: Add a parallel index against `riverEvents`**

Find the existing `hourIndexFromEvents` useMemo (lines 2227-2247). Right after it, add:

```js
  // Click-target index for the 24-hour bar. Counts/colors stay on
  // hourIndexFromEvents (so the bar shape doesn't shift when the cluster
  // expands), but bar clicks need an index into riverEvents (where the
  // scrubber actually navigates). Bars whose only matching events are
  // collapsed-LOW resolve to firstIdx = -1 (non-clickable).
  const hourClickIndex = useMemo(() => {
    const firstIdx = new Array(24).fill(-1);
    riverEvents.forEach((e, i) => {
      if (e && e.kind === 'low_cluster') return; // never click-land on the cluster header
      const hh = Math.floor(Number(e?.h));
      const h = Math.max(0, Math.min(23, Number.isFinite(hh) ? hh : 12));
      if (firstIdx[h] < 0) firstIdx[h] = i;
    });
    return { firstIdx };
  }, [riverEvents]);
```

- [ ] **Step 7.2: Use `hourClickIndex.firstIdx` for click targets**

Find the bar render around lines 3111-3147. The relevant lines:

```js
                const firstIdx = hourIndexFromEvents.firstIdx[h];
                ...
                const active = firstIdx >= 0 && scrubIdx >= firstIdx && scrubIdx < firstIdx + count;
                const clickable = firstIdx >= 0;
                ...
                    onClick={() => { if (clickable) setScrubIdx(firstIdx); }}
```

Replace the `firstIdx` lookup with the click-index version, and recompute `active` from it. The visual count/color (line 3112: `const count = hourIndexFromEvents.counts[h] || 0;` and line 3117: `const topTier = hourIndexFromEvents.topPriority[h];`) stays unchanged. Specifically change:

```js
                const count = hourIndexFromEvents.counts[h] || 0;
                const firstIdx = hourIndexFromEvents.firstIdx[h];
                const height = count > 0 ? Math.round((count / hourIndexFromEvents.maxC) * 42) + 6 : 4;
                const active = firstIdx >= 0 && scrubIdx >= firstIdx && scrubIdx < firstIdx + count;
                const clickable = firstIdx >= 0;
```

to:

```js
                const count = hourIndexFromEvents.counts[h] || 0;
                const firstIdxView = hourClickIndex.firstIdx[h];
                const height = count > 0 ? Math.round((count / hourIndexFromEvents.maxC) * 42) + 6 : 4;
                const active = firstIdxView >= 0 && scrubIdx === firstIdxView;
                const clickable = firstIdxView >= 0;
```

Note: the old `active` formula was a range `[firstIdx, firstIdx+count)`. With the new index it's not a contiguous slice anymore (LOW items are pulled out), so we narrow `active` to exact-match — the bar lights up only when the scrubber is on the bar's first clickable event. This is a small visual regression we accept; bars stay informative as a histogram and the click jumps the scrubber.

Then change the click handler:

```js
                    onClick={() => { if (clickable) setScrubIdx(firstIdx); }}
```

to:

```js
                    onClick={() => { if (clickable) setScrubIdx(firstIdxView); }}
```

- [ ] **Step 7.3: Smoke + manual check**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: all pass.

Manual: in `npm run dev:desktop`, click various bars. Each click lands on a HIGH/MEDIUM/unclassified card or the cluster header (when that hour has no non-LOW events). With the cluster collapsed, no click should land on a LOW item. Expand the cluster, click bars again — clicks may now land on LOW items if the cluster is expanded and a LOW item is the first non-cluster event in that bar (acceptable per spec).

- [ ] **Step 7.4: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(memory-river): remap 24h bar clicks to riverEvents indices

Bar shape (counts/colors) keeps using events so visualization is stable.
Click targets resolve against riverEvents so collapsed LOW items aren't
addressable from the bar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Playwright e2e for the cluster

**Why:** Lock in the user-visible behavior so future refactors of the scrubber don't silently regress the cluster.

**Files:**
- Create: `tests/e2e/memory-river-low-cluster.spec.js`

- [ ] **Step 8.1: Write the spec**

Create `tests/e2e/memory-river-low-cluster.spec.js` with this content:

```js
const { test, expect } = require("@playwright/test");

const HIFI_ENTRY = "/SHOGUN%20Hi-Fi%20UI.html";

async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}

async function goToMemoryRiver(page) {
  // Open the Memory screen via the runtime hook used elsewhere.
  await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
  await expect(page.locator('.memory-screen')).toBeVisible();
  // Make sure we're on the River sub-view (default).
  await page.locator('button', { hasText: 'River' }).first().click().catch(() => {});
}

async function advanceToLastEvent(page) {
  // Click "Next memory" until disabled.
  const next = page.getByRole('button', { name: 'Next memory' });
  for (let i = 0; i < 200; i++) {
    if (await next.isDisabled()) break;
    await next.click();
  }
}

test.describe('Memory River — Low-priority cluster', () => {
  test('cluster header appears at end of scrubber stream', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    // Cluster panel uses a chevron + "Other · N items" / "その他 · N件".
    await expect(page.locator('.memory-summary-card[role="button"]')).toBeVisible();
    await expect(page.locator('.memory-summary-card[role="button"]'))
      .toContainText(/Other · \d+ items|その他 · \d+件/);
  });

  test('cluster header click toggles aria-expanded', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    const cluster = page.locator('.memory-summary-card[role="button"]').first();
    await expect(cluster).toHaveAttribute('aria-expanded', 'false');
    await cluster.click();
    await expect(cluster).toHaveAttribute('aria-expanded', 'true');
    await cluster.click();
    await expect(cluster).toHaveAttribute('aria-expanded', 'false');
  });

  test('expanded cluster lets next-arrow step into LOW items with breadcrumb', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    const cluster = page.locator('.memory-summary-card[role="button"]').first();
    await cluster.click(); // expand
    // After expansion, advancing once should land on a LOW item with breadcrumb.
    await page.getByRole('button', { name: 'Next memory' }).click();
    await expect(page.locator('text=/Inside Other cluster|その他クラスタ内/')).toBeVisible();
  });

  test('Collapse button snaps back to cluster header', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    await page.locator('.memory-summary-card[role="button"]').first().click(); // expand
    await page.getByRole('button', { name: 'Next memory' }).click(); // step into LOW
    await page.getByRole('button', { name: /Collapse|畳む/ }).click();
    await expect(page.locator('.memory-summary-card[role="button"]'))
      .toContainText(/Other ·|その他 ·/);
    await expect(page.locator('.memory-summary-card[role="button"]'))
      .toHaveAttribute('aria-expanded', 'false');
  });

  test('expand state survives Memory → Home → Memory round trip', async ({ page }) => {
    await openHiFi(page);
    await goToMemoryRiver(page);
    await advanceToLastEvent(page);
    await page.locator('.memory-summary-card[role="button"]').first().click(); // expand
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('home'));
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('memory'));
    await advanceToLastEvent(page);
    // Cluster should still be in expanded state after the round trip.
    await expect(page.locator('.memory-summary-card[role="button"]').first())
      .toHaveAttribute('aria-expanded', 'true');
  });
});
```

- [ ] **Step 8.2: Run the new spec**

```bash
npx playwright test tests/e2e/memory-river-low-cluster.spec.js --reporter=line
```

Expected: 5 passed. If any test fails, inspect the failure (Playwright dumps screenshots/videos under `test-results/`) and fix either the test or the implementation. Common likely failures and what to do:

- **"cluster panel never appears"** → Mock data may have zero LOW items in this run. Confirm Task 4 mock change is in place; bump the test's seed by enabling more demo items if needed.
- **"role=button not found / wrong selector"** → The cluster JSX might be wrapped in a different container; adjust the locator.
- **"Next memory button never gets disabled"** → The scrubber may be paginating an unbounded list (mock returns more on demand). Cap iterations or wait for `[data-cluster-end]` (we don't add such a marker; rely on the disabled state in the existing implementation).

- [ ] **Step 8.3: Run the full e2e suite to confirm no cross-test regression**

```bash
npx playwright test --reporter=line
```

Expected: hifi-smoke + the new spec all pass.

- [ ] **Step 8.4: Commit**

```bash
git add tests/e2e/memory-river-low-cluster.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): memory river low-priority cluster

Locks in the cluster header render, expand toggle, in-cluster
breadcrumb, Collapse snap-back, and cross-screen expand persistence.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Final verification

- [ ] **Step 9.1: All checks green**

```bash
npm run check:actions
npm run check:ipc-mock
npx playwright test --reporter=line
```

Expected: all pass.

- [ ] **Step 9.2: Manual smoke (one pass)**

`npm run dev:desktop`. Run the spec § 4 manual checklist once:

- Default render — cluster appears at the end of the scrubber stream
- Click → expand, click → collapse
- Expand → next → land on LOW with breadcrumb
- `Collapse` button → snap back
- Toggle Filters → L → ON → cluster gone, LOW interleaved; OFF → cluster back
- Snooze a LOW item from inside the expanded cluster (use the existing snooze buttons in the standard card chrome) → cluster `count` drops by 1
- Memory tab → Home → Memory → expand state preserved
- Switch to Kakejiku view → no synthetic cluster row in the list

- [ ] **Step 9.3: Branch summary**

```bash
git log --oneline feat/memory-digest-phase1 ^main 2>/dev/null | head -20
git diff --stat main..HEAD 2>/dev/null
```

Confirm the new commits look right.

---

## Self-Review (run after writing all tasks)

**1. Spec coverage:**
- § 1 Architecture — Tasks 1, 2, 3 ✓
- § 2-A Cluster header view — Task 5 ✓
- § 2-B Inline LOW breadcrumb — Task 6 ✓
- § 2 Card actions reuse — implicit, no code change required ✓
- § 3 Edge cases:
  - LOW count = 0 → covered by Task 3's `if (lowEvents.length === 0) return mainEvents;` ✓
  - L filter ON → Task 3 passthrough branch ✓
  - Provider filter → relies on existing `events` filter, untouched ✓
  - Snooze the last LOW → Task 3 returns `mainEvents` once `lowEvents.length === 0` ✓
  - Scrubber crosses cluster — Task 5 + 6 ✓
  - Hour-bin click — Task 7 ✓
  - Unmount/remount — Task 2 module-scope state ✓
  - All-LOW edge case — Task 3 returns just the cluster ✓
  - Other view modes unaffected — Task 3 leaves `events` unchanged ✓
- § 4 Testing — Task 8 ✓
- § 5 Rollout — no flag, no extra task needed ✓

**2. Placeholder scan:** No "TBD", "TODO", "as appropriate", "etc." in any task body. Each step has runnable code or commands.

**3. Type consistency:**
- `lowClusterExpanded` (state) and `lowClusterExpandedSession` (module) — distinct names, used correctly throughout.
- `riverEvents` shape: each entry is either a real event from `events` OR `{ kind: 'low_cluster', count, items, h, ts, src, title, snippet, memoryId, provenance, sourceRaw, entityId }`. Synthetic entry has the same property keys as a real event so generic reads don't crash.
- `getEventPriority(e)` is the only priority resolver after Task 1. Used in Tasks 1, 3, 6.
- Cluster guard string — `scrubbed.kind !== 'low_cluster'` (consistent quoting).

**4. Ambiguity check:**
- Task 5.5 mentions the chevron icon names `chevronRight` / `chevronDown`. The plan tells the executor to verify and swap if unavailable.
- Task 5.6 lists 4 render blocks to wrap; the executor verifies count via grep at the end.
- Task 7's `active` formula change is documented as an accepted small visual regression.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-26-memory-digest-low-priority-grouping.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
