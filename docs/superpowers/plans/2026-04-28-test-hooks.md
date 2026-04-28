# Test Hooks Implementation Plan — un-fixme Phase 4 e2e tests

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `?test=1`-gated `window.__SHOGUN_TEST__` hook with two helpers (`seedSummaries`, `waitForScreen`) and un-fixme 13 Phase 4 e2e tests.

**Architecture:** App init reads URL `?test=1` and creates an empty `window.__SHOGUN_TEST__`. Each Phase 4 component (`ScreenMemory`, `ScreenEditInsights`) publishes its own helper on mount via `useEffect` and tears it down on unmount. Tests open with `?test=1`, navigate to the screen first, then call the helper. Hook is undefined in production opens — no behavior change for end users.

**Tech Stack:** React via `text/babel` script tag (no JSX build), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-04-28-test-hooks-design.md` (commit `ac10987`)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `hifi/app.jsx` | Modify | Add a `useEffect` early in the App component that reads `URLSearchParams` and initializes `window.__SHOGUN_TEST__ = {}` when `test=1`; cleanup removes it. |
| `hifi/screens-a.jsx` | Modify | In `ScreenMemory`, add a `useEffect` that registers `window.__SHOGUN_TEST__.seedSummaries = (map) => setSummaryByMemId(...)` on mount, deletes it on unmount. |
| `hifi/screens-edit-insights.jsx` | Modify | In `ScreenEditInsights`, add a `settledRef` + `useEffect` that registers `window.__SHOGUN_TEST__.waitForScreen` on mount; resolves any pending waiters after the first IPC settles. |
| `tests/e2e/memory-river-low-cluster.spec.js` | Modify | Switch `goto` to `?test=1`; remove fixme block; un-fixme 5 (or 6 — see Task 5) tests; add `seedSummariesForDemo` helper + call. |
| `tests/e2e/memory-summary-edit.spec.js` | Modify | Same `?test=1` + un-fixme 5 + `seedSummariesForDemo` (replaces the old `waitForSummaryPanel` race). |
| `tests/e2e/memory-edit-insights.spec.js` | Modify | Same `?test=1` + un-fixme 3 + `waitForScreen('edit-insights')` await. |

No backend changes. No new files.

---

## Pre-flight

- [ ] **Step 0.1: Confirm baseline**

```bash
npm run check:ipc-mock
npx playwright test --reporter=line
```

Expected: ipc-mock OK; Playwright reports the current baseline (e.g. 22 passed + 13 fixme'd + 4 pre-existing failed). Record exact counts.

- [ ] **Step 0.2: Confirm branch + worktree**

```bash
git branch --show-current
git status --short
```

Expected: branch `feat/test-hooks`. Untracked `package-lock.json` from worktree-setup is OK.

---

## Task 1: `?test=1` query gate in `app.jsx`

**Why:** The empty skeleton `window.__SHOGUN_TEST__ = {}` must be present before any screen mounts so screens can register their own helpers into it. Putting the gate in the App component's earliest `useEffect` guarantees this ordering.

**Files:**
- Modify: `hifi/app.jsx`

- [ ] **Step 1.1: Locate the App component's mount-time effects**

```bash
grep -n "function App\|export default function App\|useEffect" hifi/app.jsx | head -10
```

Find a spot near the top of the App component's body, before `ensureRuntimeDeps` or any other setup `useEffect`.

- [ ] **Step 1.2: Add the gate effect**

Insert this block in the App component's body (e.g., right after the existing `useState` declarations, before the first `useEffect`):

```js
  // Test hook gate. When the page is opened with ?test=1, expose an empty
  // window.__SHOGUN_TEST__ object that the Memory + Edit Insights screen
  // components fill in on mount. Spec:
  // docs/superpowers/specs/2026-04-28-test-hooks-design.md
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let exposed = false;
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('test') === '1') {
        window.__SHOGUN_TEST__ = {};
        exposed = true;
      }
    } catch (_) {
      // location not available in some test contexts; ignore
    }
    return () => {
      if (exposed && typeof window !== 'undefined' && window.__SHOGUN_TEST__) {
        delete window.__SHOGUN_TEST__;
      }
    };
  }, []);
```

The file uses destructured `useState` / `useRef` from React (loaded as a global via the `text/babel` script tag); `React.useEffect` works because `React` is also a global. Confirm via `grep -c "React.useEffect" hifi/app.jsx` — the namespace is acceptable and matches existing patterns elsewhere in the file.

- [ ] **Step 1.3: Verify static checks**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke baseline unchanged (the new effect only runs when `?test=1` is in the URL, which the smoke tests don't add).

- [ ] **Step 1.4: Manual smoke**

Open `SHOGUN Hi-Fi UI.html?test=1` in a browser (no need for `npm run dev:desktop` since this is pure-frontend). In DevTools console:

```js
typeof window.__SHOGUN_TEST__  // expected: "object"
window.__SHOGUN_TEST__         // expected: {}
```

Reload without `?test=1`:

```js
typeof window.__SHOGUN_TEST__  // expected: "undefined"
```

If the hook IS defined when `?test=1` is absent, the gate is broken — re-check the URLSearchParams logic.

- [ ] **Step 1.5: Commit**

```bash
git add hifi/app.jsx
git commit -m "$(cat <<'EOF'
feat(test-hooks): ?test=1 query gate for window.__SHOGUN_TEST__

Adds a mount-time useEffect in the App component that initializes
window.__SHOGUN_TEST__ to an empty object when the page is opened with
?test=1. Cleanup deletes it on unmount. Production opens without the
flag never see the hook.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `seedSummaries` in `ScreenMemory`

**Why:** Cluster + summary-edit tests need a synchronous way to populate `summaryByMemId` so the Memory River detail panel renders deterministic content. We register the helper from inside `ScreenMemory` because the component owns the state setter.

**Files:**
- Modify: `hifi/screens-a.jsx`

- [ ] **Step 2.1: Locate the `summaryByMemId` setter**

```bash
grep -n "setSummaryByMemId\|const \[summaryByMemId" hifi/screens-a.jsx | head -5
```

Note the line where `setSummaryByMemId` is declared and pick a position immediately after it for the new effect.

- [ ] **Step 2.2: Add the registration `useEffect`**

Insert immediately after the `useState` line for `summaryByMemId`:

```js
  // Test hook: when window.__SHOGUN_TEST__ is exposed (?test=1), register
  // a synchronous seedSummaries helper that replaces the entire summary
  // cache. Used by cluster + summary-edit Playwright tests to bypass the
  // async batch-summarize useEffect race.
  // Spec: docs/superpowers/specs/2026-04-28-test-hooks-design.md
  useEffect(() => {
    if (typeof window === 'undefined' || !window.__SHOGUN_TEST__) return;
    window.__SHOGUN_TEST__.seedSummaries = (map) => {
      setSummaryByMemId(new Map(Object.entries(map || {})));
    };
    return () => {
      if (typeof window !== 'undefined' && window.__SHOGUN_TEST__) {
        delete window.__SHOGUN_TEST__.seedSummaries;
      }
    };
  }, [setSummaryByMemId]);
```

(The file uses destructured `useEffect` — confirm with `grep -c "^const { useState, useRef" hifi/screens-a.jsx` or the equivalent destructure pattern. If only `React.useEffect` is used, swap accordingly.)

- [ ] **Step 2.3: Verify static checks**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke baseline unchanged.

- [ ] **Step 2.4: Manual smoke**

Open `SHOGUN Hi-Fi UI.html?test=1` in a browser. Click into the Memory tab. In console:

```js
typeof window.__SHOGUN_TEST__.seedSummaries  // expected: "function"
window.__SHOGUN_TEST__.seedSummaries({
  'demo-m-04': { targetKind: 'item', targetId: 'demo-m-04', title: 'Hooked', keyPoints: ['ok'], sourceType: 'mail', priority: 'low', reason: 'mock', model: 'mock', schemaVersion: 1, generatedAt: 0 },
})
```

Memory River should show the cluster entry on next interaction. Switch to a different tab and back — the helper should be undefined while Memory is unmounted, then re-registered when Memory mounts again.

- [ ] **Step 2.5: Commit**

```bash
git add hifi/screens-a.jsx
git commit -m "$(cat <<'EOF'
feat(test-hooks): expose seedSummaries from ScreenMemory

When window.__SHOGUN_TEST__ is present (?test=1), ScreenMemory registers
seedSummaries(map) on mount: a synchronous setter that fully replaces
summaryByMemId. Cleanup removes the registration on unmount. Used by
cluster + summary-edit e2e tests (Tasks 4 and 5).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `waitForScreen` in `ScreenEditInsights`

**Why:** Edit Insights tests need to await the screen's first `memory.summary.edit_insights` IPC settling. Putting the resolver inside the screen component keeps the lifecycle aligned with mount/unmount.

**Files:**
- Modify: `hifi/screens-edit-insights.jsx`

- [ ] **Step 3.1: Locate the `load` callback**

```bash
grep -n "const load\|setData(res.data)\|useState\|useRef" hifi/screens-edit-insights.jsx | head -10
```

Identify two spots:
1. State-declarations region (top of `ScreenEditInsights`).
2. Inside `load`, where `setData(res.data)` is called on success.

- [ ] **Step 3.2: Add the `settledRef` + registration effect**

In the state-declarations region, add:

```js
  const settledRef = React.useRef({ resolved: false, resolvers: [] });

  // Test hook: when window.__SHOGUN_TEST__ is exposed (?test=1), register
  // a waitForScreen helper that returns a Promise resolving after the
  // first IPC settles. Used by edit-insights Playwright tests.
  // Spec: docs/superpowers/specs/2026-04-28-test-hooks-design.md
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.__SHOGUN_TEST__) return;
    window.__SHOGUN_TEST__.waitForScreen = (id) => {
      if (id !== 'edit-insights') return Promise.resolve();
      if (settledRef.current.resolved) return Promise.resolve();
      return new Promise((resolve) => settledRef.current.resolvers.push(resolve));
    };
    return () => {
      if (typeof window !== 'undefined' && window.__SHOGUN_TEST__) {
        delete window.__SHOGUN_TEST__.waitForScreen;
      }
      settledRef.current = { resolved: false, resolvers: [] };
    };
  }, []);
```

- [ ] **Step 3.3: Resolve the waiters after the IPC settles**

Inside `load`, find the success branch where `setData(res.data)` is called. Right after it, add:

```js
      // Wake up any test waiters now that the screen has rendered with data.
      const refState = settledRef.current;
      refState.resolved = true;
      const pending = refState.resolvers;
      refState.resolvers = [];
      pending.forEach((r) => r());
```

The handler runs after the first IPC succeeds. If it FAILS, we don't resolve — tests would hang (acceptable; a real failure should fail the test, not paper over it). The `settledRef` resets on unmount, so a re-mount waits for a fresh first-IPC.

- [ ] **Step 3.4: Verify static checks**

```bash
npm run check:ipc-mock
npx playwright test tests/e2e/hifi-smoke.spec.js --reporter=line
```

Expected: ipc-mock OK; smoke baseline unchanged.

- [ ] **Step 3.5: Manual smoke**

Open `SHOGUN Hi-Fi UI.html?test=1`. In console:

```js
window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights')
typeof window.__SHOGUN_TEST__.waitForScreen  // "function"
await window.__SHOGUN_TEST__.waitForScreen('edit-insights')  // resolves quickly
```

- [ ] **Step 3.6: Commit**

```bash
git add hifi/screens-edit-insights.jsx
git commit -m "$(cat <<'EOF'
feat(test-hooks): expose waitForScreen from ScreenEditInsights

settledRef holds the first-IPC-completed flag and a queue of pending
test resolvers. On mount the component registers waitForScreen('edit-
insights') as a Promise factory. After the first memory.summary.edit_
insights IPC succeeds (setData call), all pending resolvers are flushed.
Re-mounts reset the ref so subsequent waiters wait for a fresh load.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Un-fixme the cluster e2e tests

**Why:** With the hook in place, the cluster's 5 fixme'd tests can run as `test`. Each gets a `seedSummariesForDemo(page)` call after `goToMemoryRiver` so the LOW-priority items are present synchronously.

**Files:**
- Modify: `tests/e2e/memory-river-low-cluster.spec.js`

- [ ] **Step 4.1: Switch `openHiFi` to `?test=1`**

Find the `openHiFi` helper:

```js
async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

Replace with:

```js
async function openHiFi(page) {
  await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

- [ ] **Step 4.2: Add the seed helper**

After the `advanceToLastEvent` helper (or anywhere before `test.describe`), add:

```js
async function seedSummariesForDemo(page) {
  // Demo seed has demo-m-01..12. Mark 04/08/10 as LOW so the cluster appears.
  await page.evaluate(() => {
    if (!window.__SHOGUN_TEST__?.seedSummaries) {
      throw new Error('window.__SHOGUN_TEST__.seedSummaries not available — Memory screen not mounted, or ?test=1 missing');
    }
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
    window.__SHOGUN_TEST__.seedSummaries(map);
  });
}
```

- [ ] **Step 4.3: Delete the fixme comment block + un-fixme 5 tests**

Find the fixme comment block (search via `grep -n "test.fixme due to" tests/e2e/memory-river-low-cluster.spec.js`). Delete the entire block (the `// The five tests below...` paragraph and the rest of the multi-line comment).

Then change all 5 occurrences:
- `test.fixme('cluster header appears at end of scrubber stream', async` → `test('cluster header appears at end of scrubber stream', async`
- `test.fixme('cluster header click toggles aria-expanded', async` → `test('cluster header click toggles aria-expanded', async`
- `test.fixme('expanded cluster lets next-arrow step into LOW items with breadcrumb', async` → `test('expanded cluster lets next-arrow step into LOW items with breadcrumb', async`
- `test.fixme('Collapse button snaps back to cluster header', async` → `test('Collapse button snaps back to cluster header', async`
- `test.fixme('expand state survives Memory → Home → Memory round trip', async` → `test('expand state survives Memory → Home → Memory round trip', async`

There's also one PRE-EXISTING `test.fixme` for the L-filter test (cluster has 6 fixmes total — 5 from the original race + 1 already-fixme'd L-filter that was independent). Check the L-filter test's fixme reason — if it relies on the same race, un-fixme it too. If it's blocked by something different, leave it. Search via `grep -B5 "test.fixme.*L filter" tests/e2e/memory-river-low-cluster.spec.js` to read the surrounding comment.

- [ ] **Step 4.4: Add `seedSummariesForDemo` calls to each un-fixme'd test**

For each of the 5 tests, find the line `await advanceToLastEvent(page);` (or `await goToMemoryRiver(page);` if there's no advance call) and insert before it:

```js
    await seedSummariesForDemo(page);
```

The seed must come AFTER `goToMemoryRiver(page)` (Memory screen must be mounted) and BEFORE any cluster assertion.

- [ ] **Step 4.5: Run the cluster spec**

```bash
npx playwright test tests/e2e/memory-river-low-cluster.spec.js --reporter=line
```

Expected: 5 passed + 1 skipped (the unaddressed L-filter, OR 6 passed if the L-filter was un-fixme'd in step 4.3).

If any test fails:
- Read the error in `test-results/<test-name>/error-context.md`.
- Common cause: cluster card text format (`Other · N items`) — the count depends on how many items survive the cluster filter. Adjust the seed if needed.
- Don't `.fixme` again — the whole point is to make these run.

- [ ] **Step 4.6: Commit**

```bash
git add tests/e2e/memory-river-low-cluster.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): un-fixme cluster tests via window.__SHOGUN_TEST__.seedSummaries

5 fixme'd tests in the cluster spec are now `test` (and the previously-
fixme'd L-filter test if its underlying issue was the same race). Each
test calls seedSummariesForDemo(page) after navigating to Memory; this
populates summaryByMemId synchronously so the cluster row renders on
the next React render with deterministic content.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Un-fixme the summary-edit e2e tests

**Why:** Same pattern as Task 4. The 5 fixme'd summary-edit tests need `seedSummariesForDemo` so the detail panel renders before the test asserts on title / keyPoints / reason.

**Files:**
- Modify: `tests/e2e/memory-summary-edit.spec.js`

- [ ] **Step 5.1: Switch `openHiFi` to `?test=1`**

Same pattern as Task 4. Replace:

```js
async function openHiFi(page) {
  await page.addInitScript(DEMO_SEED_SCRIPT);
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

with:

```js
async function openHiFi(page) {
  await page.addInitScript(DEMO_SEED_SCRIPT);
  await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

(Keep the `addInitScript` for the demo seed — it provides `rawEvents`, which is independent of `summaryByMemId`.)

- [ ] **Step 5.2: Add the seed helper**

Insert the same `seedSummariesForDemo(page)` helper as in Task 4 Step 4.2 (copy verbatim — it's the same priority distribution).

- [ ] **Step 5.3: Replace `waitForSummaryPanel` calls with `seedSummariesForDemo`**

Find the existing helper:

```js
async function waitForSummaryPanel(page) {
  await page.locator('.memory-summary-card').first().waitFor({ state: 'visible', timeout: 30000 });
}
```

The summary panel is what was racy — once `seedSummariesForDemo` runs, the panel renders synchronously. Either delete `waitForSummaryPanel` and replace each call with `seedSummariesForDemo`, OR refactor `waitForSummaryPanel` to internally call `seedSummariesForDemo`. Pick the cleaner: replace calls.

For each `await waitForSummaryPanel(page);` in the 5 tests, replace with `await seedSummariesForDemo(page);`.

- [ ] **Step 5.4: Delete the fixme comment block + un-fixme 5 tests**

Same pattern as Task 4 Step 4.3. The 5 test names are:
- `title click → edit → Enter saves; reload preserves`
- `Escape during edit discards changes`
- `Revert restores AI baseline`
- `keyPoints click → edit; + Add point appends new editable item`
- `reason click → edit → save`

Change `test.fixme(...)` → `test(...)` for each.

- [ ] **Step 5.5: Run the summary-edit spec**

```bash
npx playwright test tests/e2e/memory-summary-edit.spec.js --reporter=line
```

Expected: 5 passed.

If a test fails, common causes:
- Summary panel renders but in `showRaw` mode (no inline edit) — confirm the seed has `priority` set so the summary card renders normally.
- `Edit title` button is the wrong selector — inspect the rendered DOM via the `test-results/.../error-context.md` HTML snapshot.

- [ ] **Step 5.6: Commit**

```bash
git add tests/e2e/memory-summary-edit.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): un-fixme summary-edit tests via seedSummaries

5 fixme'd tests in memory-summary-edit.spec.js are now `test`. Each
test calls seedSummariesForDemo(page) after navigating to Memory,
replacing the racy waitForSummaryPanel approach. The summary detail
panel renders synchronously once summaryByMemId is populated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Un-fixme the edit-insights e2e tests

**Why:** Edit Insights uses the different hook (`waitForScreen`), not `seedSummaries`. The 3 fixme'd tests need a `waitForScreen('edit-insights')` await after `setActiveScreen`.

**Files:**
- Modify: `tests/e2e/memory-edit-insights.spec.js`

- [ ] **Step 6.1: Switch `openHiFi` to `?test=1`**

Same pattern. The current helper is just `goto` + `waitForSelector` (no init script). Replace:

```js
async function openHiFi(page) {
  await page.goto(HIFI_ENTRY, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

with:

```js
async function openHiFi(page) {
  await page.goto(HIFI_ENTRY + '?test=1', { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector(".app", { timeout: 90000 });
}
```

- [ ] **Step 6.2: Delete the fixme comment block + un-fixme 3 tests**

Same pattern as Task 4 Step 4.3. The 3 test names are:
- `setActiveScreen("edit-insights") mounts the screen with mock data`
- `Reload button re-fetches`
- `TOML hint shows for the most-edited gmail sender`

Change `test.fixme(...)` → `test(...)` for each.

- [ ] **Step 6.3: Add `waitForScreen` await after each `setActiveScreen`**

For each of the 3 tests, find the line:

```js
    await page.evaluate(() => window.SHOGUN_RUNTIME?.setActiveScreen?.('edit-insights'));
```

Insert immediately after it:

```js
    await page.evaluate(() => window.__SHOGUN_TEST__.waitForScreen('edit-insights'));
```

- [ ] **Step 6.4: Run the edit-insights spec**

```bash
npx playwright test tests/e2e/memory-edit-insights.spec.js --reporter=line
```

Expected: 3 passed.

If a test fails because `waitForScreen` is undefined: confirm Task 3 registered the helper correctly and that the test's `?test=1` made it through. Read the error context for the actual exception message.

- [ ] **Step 6.5: Commit**

```bash
git add tests/e2e/memory-edit-insights.spec.js
git commit -m "$(cat <<'EOF'
test(e2e): un-fixme edit-insights tests via waitForScreen

3 fixme'd tests now `test`. Each calls window.__SHOGUN_TEST__.waitForScreen
('edit-insights') immediately after setActiveScreen, blocking until the
screen's first IPC has settled and the rendered output is stable.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Final verification + branch review

- [ ] **Step 7.1: All checks**

```bash
npm run check:ipc-mock
npx playwright test --reporter=line
```

Expected:
- ipc-mock OK (count unchanged from baseline).
- Playwright passes 13 more tests than the baseline. If baseline was 22 passed + 13 fixme'd, the new state is 35 passed + 0 fixme'd (modulo the 4 pre-existing failures which are independent). The L-filter cluster test may push the total to 36 if Task 4 un-fixme'd it.

- [ ] **Step 7.2: Stability check (3 runs)**

```bash
for i in 1 2 3; do
  echo "=== Run $i ==="
  npx playwright test --reporter=line 2>&1 | tail -3
done
```

Expected: identical pass/fail counts across all 3 runs. Any test that flips between passed and failed across runs is flaky and needs investigation.

If a test flakes, the most likely cause is a missed wait (e.g., a selector timing out before `seedSummaries` has propagated). Add an explicit short wait or a `waitFor` on a stable DOM element.

- [ ] **Step 7.3: Manual smoke**

Open `SHOGUN Hi-Fi UI.html?test=1` in a browser:

1. `window.__SHOGUN_TEST__` is `{}` initially.
2. Click Memory → `window.__SHOGUN_TEST__.seedSummaries` is a function. Call it; River updates.
3. `setActiveScreen('edit-insights')` → `await window.__SHOGUN_TEST__.waitForScreen('edit-insights')` resolves quickly.
4. Switch back to Home → both helpers go undefined.
5. Reload without `?test=1` → `window.__SHOGUN_TEST__` is undefined.

- [ ] **Step 7.4: Branch summary**

```bash
git log --oneline 41d7fd0..HEAD
git diff --stat 41d7fd0..HEAD
```

Confirm:
- 6-7 commits across 7 tasks (each task = 1 commit).
- Files changed: 3 frontend + 3 test specs (the spec/plan files committed earlier are also there).

- [ ] **Step 7.5: Final dispatch**

After all 6 implementation tasks pass spec + code-quality reviews, dispatch a **branch-level final reviewer** via `superpowers:code-reviewer`. Provide the cumulative diff `41d7fd0..HEAD`. Address any Important issues before invoking `superpowers:finishing-a-development-branch`.

---

## Self-Review

**Spec coverage:**
- § 1 Architecture & data flow — Tasks 1, 2, 3 ✓
- § 2 Hook API — Task 2 (seedSummaries), Task 3 (waitForScreen) with the exact body from the spec ✓
- § 3 Test-side updates — Tasks 4, 5, 6 ✓
- § 4 Edge cases — covered implicitly by the helper bodies (null checks, cleanup, throw on missing) ✓
- § 5 Testing — success criteria + 3-run stability check in Task 7 ✓
- § 6 Rollout — no flag, gated by `?test=1` only; covered in Task 1 ✓

**Placeholder scan:** No "TBD", "FIXME", "as appropriate" in any task body.

**Type / API consistency:**
- `window.__SHOGUN_TEST__` shape: `{ seedSummaries(map): void, waitForScreen(id): Promise<void> }` — used consistently across Tasks 1, 2, 3, 4, 5, 6.
- `seedSummariesForDemo(page)` helper duplicated across Tasks 4 and 5 (intentional — keeps each spec file self-contained; the alternative is a shared helper file, but spec files don't currently share helpers).
- Demo seed memory IDs (`demo-m-01..12` with 04/08/10 as LOW) match the existing `mockPriorityForId` distribution used by the mock IPC.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-28-test-hooks.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
