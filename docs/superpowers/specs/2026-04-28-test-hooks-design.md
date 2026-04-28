# Test Hooks Design — un-fixme Phase 4 e2e tests

**Status:** Draft
**Date:** 2026-04-28
**Related:** Phase 4 cluster (PR #18), summary edit (PR #19), heuristic externalization / edit-insights (PR #21)

## Problem

Three Phase 4 PRs landed with fixme'd Playwright e2e tests because of an inherent async race in the mock IPC flow: React state (`summaryByMemId`) and screen-mount-then-IPC sequencing settle asynchronously, and there's no observable signal from outside React when they're done. Earlier passing runs were lucky timing.

Counts:
- `tests/e2e/memory-river-low-cluster.spec.js` — 5 `test.fixme`
- `tests/e2e/memory-summary-edit.spec.js` — 5 `test.fixme`
- `tests/e2e/memory-edit-insights.spec.js` — 3 `test.fixme`

Total: 13 tests documented but never exercised. They lock in expected behavior on paper but provide zero regression protection.

The Phase 4 fixme comment blocks all pointed at the same resolution path: a test-only `window.__SHOGUN_TEST__` hook that exposes (a) synchronous state-injection for `summaryByMemId`, and (b) an async signal for "screen has finished its first IPC."

This spec implements that hook and un-fixmes the 13 tests.

## Goals

- All 13 fixme'd Phase 4 e2e tests run as `test` (not `test.fixme`) and pass.
- Hook surface is minimal: two high-level helpers (`seedSummaries`, `waitForScreen`).
- Hook is gated by a `?test=1` URL query, so production users never see `__SHOGUN_TEST__` even on accidental URL exposure of dev builds.
- No new infrastructure (no test harness fork, no second HTML entry).
- No production code path change (the hook is a pure additive `useEffect` in two existing components).

## Non-Goals

- **Generic state-inspection hooks.** No `__getInternals()` or `setReactState(path, ...)` — tests should call the high-level helpers, not poke at React internals.
- **Other screens beyond Memory + Edit Insights.** OAuth tests already pass without a hook; other screens haven't surfaced a race yet.
- **Hot-reload / debug overlay.** The hook is for Playwright e2e, not interactive debugging.
- **Production telemetry of hook usage.** Out of scope.

## § 1. Architecture & Data Flow

### File layout

| File | Change | Responsibility |
|---|---|---|
| `hifi/app.jsx` | Modify | On page mount, check `new URLSearchParams(location.search).get('test') === '1'`. If true, initialize `window.__SHOGUN_TEST__ = {}` (empty skeleton; screen components fill in their own helpers). |
| `hifi/screens-a.jsx` | Modify | Inside `ScreenMemory`, add a `useEffect` that registers `window.__SHOGUN_TEST__.seedSummaries = (map) => setSummaryByMemId(new Map(Object.entries(map)))` on mount and deletes it on unmount. |
| `hifi/screens-edit-insights.jsx` | Modify | Inside `ScreenEditInsights`, add a `useEffect` that registers `window.__SHOGUN_TEST__.waitForScreen = (id) => Promise<void>` on mount and deletes on unmount. The Promise resolves after the screen's first `memory.summary.edit_insights` IPC settles. |
| `tests/e2e/memory-river-low-cluster.spec.js` | Modify | Switch `goto` to `?test=1`. Remove the fixme comment block. Change all 5 `test.fixme` to `test`. Add a `seedSummariesForDemo(page)` helper call after `goToMemoryRiver`. |
| `tests/e2e/memory-summary-edit.spec.js` | Modify | Same pattern. Replace the existing `waitForSummaryPanel` with a `seedSummariesForDemo` + small wait, since the panel renders immediately once `summaryByMemId` is populated. |
| `tests/e2e/memory-edit-insights.spec.js` | Modify | Switch `goto` to `?test=1`. Remove fixme comment block. Change all 3 `test.fixme` to `test`. Add `waitForScreen('edit-insights')` await after `setActiveScreen`. |

No backend changes. No new files.

### Hook publication flow

1. Page loads at `…/SHOGUN%20Hi-Fi%20UI.html?test=1`.
2. `app.jsx`'s `ensureRuntimeDeps` (or equivalent early-init code) runs once on mount. It reads `URLSearchParams` and, if `test=1`, sets `window.__SHOGUN_TEST__ = {}` (empty plain object).
3. When `ScreenMemory` mounts (typically on first navigation to Memory or via `setActiveScreen('memory')`), its `useEffect` populates `window.__SHOGUN_TEST__.seedSummaries`. On unmount, it deletes the property.
4. Similarly when `ScreenEditInsights` mounts, it populates `window.__SHOGUN_TEST__.waitForScreen` and the corresponding `firstIpcSettled` Promise machinery.

Tests therefore must:
1. Open with `?test=1`.
2. Navigate to the screen first (`setActiveScreen` or natural nav).
3. Call the hook.

If a test calls `seedSummaries` before `ScreenMemory` mounts, `window.__SHOGUN_TEST__.seedSummaries` is `undefined` and the test fails with TypeError. This is the desired behavior — it surfaces ordering bugs in the test itself, rather than silently doing nothing.

## § 2. Hook API

### `window.__SHOGUN_TEST__.seedSummaries(map)`

- **Argument**: `map` — a plain object `{ [memoryId: string]: SummaryObject }`.
- **Behavior**: synchronously calls `setSummaryByMemId(new Map(Object.entries(map)))`, which fully replaces the screen's summary cache. Next React render reflects the new state.
- **Return**: `void`.
- **Precondition**: `ScreenMemory` is mounted. If not, the function is `undefined`.

`SummaryObject` minimum shape (matches mock IPC's `makeSummaryBase`):

```js
{
  targetKind: 'item',
  targetId: 'demo-m-04',
  title: 'Stub summary',
  keyPoints: ['mock'],
  sourceType: 'mail',
  priority: 'low' | 'medium' | 'high',
  reason: 'mock',
  model: 'mock',
  schemaVersion: 1,
  generatedAt: 0,
}
```

### `window.__SHOGUN_TEST__.waitForScreen(screenId)`

- **Argument**: `screenId` — `'edit-insights'` (only Phase 4-b screen with this issue today).
- **Behavior**: returns a `Promise<void>` that resolves after the screen's first IPC has settled and React has re-rendered. If already settled, returns an already-resolved Promise.
- **Unknown id**: returns an already-resolved Promise (no-op) so tests don't crash on typos.
- **Re-mount**: when the screen unmounts and re-mounts, the next mount reinitializes the resolver and starts a fresh Promise.

### Implementation hints

**`screens-a.jsx::ScreenMemory`** — add immediately after the existing `setSummaryByMemId` declaration:

```js
React.useEffect(() => {
  if (!window.__SHOGUN_TEST__) return;
  window.__SHOGUN_TEST__.seedSummaries = (map) => {
    setSummaryByMemId(new Map(Object.entries(map)));
  };
  return () => {
    if (window.__SHOGUN_TEST__) {
      delete window.__SHOGUN_TEST__.seedSummaries;
    }
  };
}, [setSummaryByMemId]);
```

**`screens-edit-insights.jsx::ScreenEditInsights`** — add at the top of the component, alongside other state:

```js
const settledRef = React.useRef({ resolved: false, resolvers: [] });

React.useEffect(() => {
  if (!window.__SHOGUN_TEST__) return;
  window.__SHOGUN_TEST__.waitForScreen = (id) => {
    if (id !== 'edit-insights') return Promise.resolve();
    if (settledRef.current.resolved) return Promise.resolve();
    return new Promise((resolve) => settledRef.current.resolvers.push(resolve));
  };
  return () => {
    if (window.__SHOGUN_TEST__) {
      delete window.__SHOGUN_TEST__.waitForScreen;
    }
    settledRef.current = { resolved: false, resolvers: [] };
  };
}, []);
```

After the existing `load` callback's success branch (where `setData(res.data)` is called), add:

```js
settledRef.current.resolved = true;
const resolvers = settledRef.current.resolvers;
settledRef.current.resolvers = [];
resolvers.forEach((r) => r());
```

**`app.jsx`** — early in the component (before `ensureRuntimeDeps`):

```js
React.useEffect(() => {
  if (typeof window === 'undefined') return;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('test') === '1') {
      window.__SHOGUN_TEST__ = {};
    }
  } catch (_) {
    // location may not be available in tests; ignore
  }
  return () => {
    if (window.__SHOGUN_TEST__) {
      delete window.__SHOGUN_TEST__;
    }
  };
}, []);
```

## § 3. Test-side Updates

### Common helpers (added to all 3 spec files)

```js
function makeSummaryStub(id, priority = 'medium') {
  return {
    targetKind: 'item',
    targetId: id,
    title: `Stub: ${id}`,
    keyPoints: ['mock'],
    sourceType: 'mail',
    priority,
    reason: 'mock',
    model: 'mock',
    schemaVersion: 1,
    generatedAt: 0,
  };
}

async function seedSummariesForDemo(page) {
  // Demo seed has demo-m-01..12. Mark 04/08/10 as LOW so the cluster appears.
  await page.evaluate(() => {
    const isLow = (id) => ['demo-m-04', 'demo-m-08', 'demo-m-10'].includes(id);
    const map = {};
    for (let i = 1; i <= 12; i++) {
      const id = `demo-m-${String(i).padStart(2, '0')}`;
      map[id] = {
        targetKind: 'item',
        targetId: id,
        title: `Stub: ${id}`,
        keyPoints: ['mock'],
        sourceType: 'mail',
        priority: isLow(id) ? 'low' : 'medium',
        reason: 'mock',
        model: 'mock',
        schemaVersion: 1,
        generatedAt: 0,
      };
    }
    if (!window.__SHOGUN_TEST__?.seedSummaries) {
      throw new Error('window.__SHOGUN_TEST__.seedSummaries not available — Memory screen not mounted, or ?test=1 missing');
    }
    window.__SHOGUN_TEST__.seedSummaries(map);
  });
}
```

### Per-file changes

**`memory-river-low-cluster.spec.js`**

- `openHiFi` → `await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: 'load', timeout: 90000 })`.
- Delete the entire fixme comment block (lines 69-84-ish in the current file).
- Change all 5 `test.fixme(...` → `test(...`.
- After `await goToMemoryRiver(page)` and BEFORE `await advanceToLastEvent(page)`, add `await seedSummariesForDemo(page)`.

**`memory-summary-edit.spec.js`**

- Same `?test=1` switch.
- Same fixme removal + `test.fixme` → `test`.
- Replace `await waitForSummaryPanel(page)` calls with `await seedSummariesForDemo(page)`. The panel renders synchronously once `summaryByMemId` is populated.

**`memory-edit-insights.spec.js`**

- Same `?test=1` switch.
- Delete the fixme comment block.
- Change all 3 `test.fixme(...` → `test(...`.
- After `await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'))`, add:
  ```js
  await page.evaluate(() => window.__SHOGUN_TEST__.waitForScreen('edit-insights'));
  ```

## § 4. Edge Cases

| Scenario | Behavior |
|---|---|
| Test runs without `?test=1` | `window.__SHOGUN_TEST__` is `undefined`. `seedSummaries` call → TypeError → test fails. Desired: surfaces test-author errors fast. |
| `seedSummaries` called before `ScreenMemory` mounts | Function is `undefined` → TypeError → test fails. Test must navigate to Memory first. |
| `seedSummaries` called twice in one test | Second call replaces the map. Last write wins. Tests should set the complete intended state. |
| `waitForScreen('edit-insights')` called before screen mounts | `window.__SHOGUN_TEST__.waitForScreen` is `undefined` → TypeError → test fails. Test must call `setActiveScreen('edit-insights')` first. |
| `waitForScreen` called twice | Both await the same Promise; once resolved, both return immediately. |
| Screen unmounts mid-test | Cleanup deletes the property. If test calls the helper after, TypeError. Desired. |
| Production user types `?test=1` in URL | Hook is exposed but doesn't break anything — `seedSummaries` just calls a setter, `waitForScreen` returns Promises. No data leak, no privilege escalation. |
| `seedSummaries(map)` with malformed entries | The setter accepts whatever JS object is passed. Bad data may break downstream rendering (e.g., missing `priority` field skips cluster classification). Tests should pass complete shapes. |
| Re-render between hook registration and use | `useEffect` cleanup deletes the old property and re-registers, so the latest setter is always live. |

## § 5. Testing

This spec IS the test infrastructure. Success is measured by:

1. `npx playwright test --reporter=line` reports **37 passed + 0 fixme** (24 baseline + 13 newly un-fixme'd; the existing already-fixme'd L-filter test in cluster is also un-fixme'd as part of this work).
2. None of the un-fixme'd tests are flaky across 3 consecutive runs.

No new test files. The "test" for this work is that the existing 13 tests now run reliably.

### Static checks

- `npm run check:actions` — unchanged.
- `npm run check:ipc-mock` — unchanged.

### Manual smoke

- Open `SHOGUN Hi-Fi UI.html?test=1` in browser.
- Devtools console: `window.__SHOGUN_TEST__` should be defined (an empty object initially).
- Click into Memory: `window.__SHOGUN_TEST__.seedSummaries` populates.
- Call it: `window.__SHOGUN_TEST__.seedSummaries({"demo-m-01": {...}})` — Memory River updates.
- Call `setActiveScreen('edit-insights')` then `await window.__SHOGUN_TEST__.waitForScreen('edit-insights')` — resolves quickly.

### Regression check

- Open `SHOGUN Hi-Fi UI.html` (no `?test=1`): `window.__SHOGUN_TEST__` is undefined.

## § 6. Rollout

No feature flag. No DB migration. No backend touched. The `?test=1` query gate keeps production users unaware.

## Open Questions / Future Work

- **Hooks for other screens**: Home, Chat, Work, Meetings — none have surfaced races yet. Add when a fixme appears.
- **Generic `__resetState()`**: If many tests want a clean slate, a single helper on `__SHOGUN_TEST__` could clear all known state stores. Defer.
- **Tighter typing**: `seedSummaries` accepts any plain object; a runtime schema validator would catch test-author mistakes faster. Defer.

## Success Criteria

1. After this branch lands, `npx playwright test` reports 37 passed and 0 fixme/skipped (modulo any unrelated pre-existing fixmes).
2. Each newly-un-fixme'd test passes 3 consecutive runs without flake.
3. `?test=1` is the only documented entry point to the hook; production opens of the Hi-Fi HTML without that flag never expose `window.__SHOGUN_TEST__`.
4. No backend code paths change.
