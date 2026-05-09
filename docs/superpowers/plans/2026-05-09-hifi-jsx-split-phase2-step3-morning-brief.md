# Phase 2 / Step 3 — morning-brief feature split

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `src/features/_legacy/screens-morning-brief.tsx` (289 lines) to `src/features/morning-brief/` with proper TypeScript types, decomposed components/hooks/lib, and Vitest unit tests for pure functions.

**Architecture:** Standard feature-folder layout (`<feature>Screen.tsx`, `components/`, `hooks/`, `lib/`, `types.ts`, `index.ts`). Lift the `BriefItemCard` component into `components/`, push the `runRuntimeMB`/load/onAction/onContext logic into a `useMorningBrief` hook, push pure functions (`contextIconName`, `formatFocusBlocks`, `POSTURE_LABEL`, `CONTEXT_ICON`) into `lib/posture.ts`. Type all surfaces.

**Tech Stack:** Same as Phase 1 (Vite, TS strict, React 18). Add Vitest unit tests.

**Notes specific to this feature:**
- `ScreenMorningBrief` is **not** routed in `src/app/App.tsx` (no nav-item points to it). It's a standalone screen exposed only via `window.ScreenMorningBrief` for legacy access. e2e regression risk is essentially zero.
- The actual Morning Brief card on the Home screen lives inside `screens-a.tsx` (Phase 2 Step 8). This Step 3 only handles the standalone screen.

---

## Task 1: Create feature folder + types.ts

**Files:**
- Create: `src/features/morning-brief/types.ts`
- Create: `src/features/morning-brief/index.ts` (placeholder)

- [ ] **Step 1: Create the directory and types.ts**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
mkdir -p src/features/morning-brief/{components,hooks,lib}
```

Create `src/features/morning-brief/types.ts`:

```typescript
export type Posture = 'focus' | 'meeting-heavy' | 'recovery' | 'launch';

export type ContextItemType =
  | 'document'
  | 'person'
  | 'decision'
  | 'slack_thread'
  | 'email'
  | 'commit'
  | 'calendar';

export interface ContextItem {
  type: ContextItemType;
  title: string;
  uri?: string;
}

export interface NextAction {
  label?: string;
  key?: string;
  payload?: Record<string, unknown>;
}

export interface FocusBlock {
  start: string;
  end: string;
  duration_minutes?: number;
}

export interface BriefSummary {
  headline?: string;
  posture?: Posture;
  total_meeting_minutes?: number | null;
  focus_blocks?: FocusBlock[];
}

export interface BriefItem {
  id?: string;
  what: string;
  why_now: string;
  time_hint?: string | null;
  related_context?: ContextItem[];
  next_action?: NextAction;
}

export interface DeferredItem {
  id: string;
  snippet: string;
  reason?: string;
}

export interface MorningBriefV2 {
  version: '2.0';
  date?: string;
  summary?: BriefSummary;
  items?: BriefItem[];
  deferred?: DeferredItem[];
}

export interface MorningBriefV1 {
  version?: string;
  sections?: Array<{ title: string; body: string }>;
}

export type MorningBrief = MorningBriefV2 | MorningBriefV1;
```

- [ ] **Step 2: Placeholder index.ts**

Create `src/features/morning-brief/index.ts`:

```typescript
// Public entry for the morning-brief feature.
// Filled in as components are migrated from _legacy/.
export type { MorningBrief, MorningBriefV2, BriefItem, BriefSummary } from './types';
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck 2>&1 | tail -5
```
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/features/morning-brief/
git commit -m "feat(features/morning-brief): create folder skeleton + types (Phase 2 Step 3)"
```

---

## Task 2: Move pure functions to lib/posture.ts

**Files:**
- Create: `src/features/morning-brief/lib/posture.ts`
- Create: `src/features/morning-brief/lib/posture.test.ts`

- [ ] **Step 1: Create lib/posture.ts**

Create `src/features/morning-brief/lib/posture.ts`:

```typescript
import type { Posture, ContextItemType, FocusBlock } from '../types';

export const POSTURE_LABEL: Record<Posture, string> = {
  focus: 'Focus',
  'meeting-heavy': 'Meeting-heavy',
  recovery: 'Recovery',
  launch: 'Launch',
};

export const CONTEXT_ICON: Record<ContextItemType, string> = {
  document: 'note',
  person: 'users',
  decision: 'check',
  slack_thread: 'chat',
  email: 'mail',
  commit: 'terminal',
  calendar: 'calendar',
};

export function contextIconName(type: ContextItemType | string | undefined): string {
  if (!type) return 'file';
  return (CONTEXT_ICON as Record<string, string>)[type] || 'file';
}

export function formatFocusBlocks(blocks: FocusBlock[] | undefined): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return blocks
    .map((b) => {
      const h = Math.round((b.duration_minutes || 0) / 60);
      const hm = h > 0 ? `${h}h` : `${b.duration_minutes || 0}m`;
      return `${b.start}-${b.end} (${hm})`;
    })
    .join(' · ');
}
```

- [ ] **Step 2: Write Vitest unit tests**

Create `src/features/morning-brief/lib/posture.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { contextIconName, formatFocusBlocks, POSTURE_LABEL, CONTEXT_ICON } from './posture';

describe('contextIconName', () => {
  it('returns mapped icon for known types', () => {
    expect(contextIconName('document')).toBe('note');
    expect(contextIconName('person')).toBe('users');
    expect(contextIconName('decision')).toBe('check');
    expect(contextIconName('slack_thread')).toBe('chat');
    expect(contextIconName('email')).toBe('mail');
    expect(contextIconName('commit')).toBe('terminal');
    expect(contextIconName('calendar')).toBe('calendar');
  });

  it('falls back to "file" for unknown or empty types', () => {
    expect(contextIconName('unknown')).toBe('file');
    expect(contextIconName('')).toBe('file');
    expect(contextIconName(undefined)).toBe('file');
  });
});

describe('formatFocusBlocks', () => {
  it('returns null for empty or missing input', () => {
    expect(formatFocusBlocks(undefined)).toBeNull();
    expect(formatFocusBlocks([])).toBeNull();
  });

  it('formats single block with hour duration', () => {
    expect(
      formatFocusBlocks([{ start: '09:00', end: '11:00', duration_minutes: 120 }]),
    ).toBe('09:00-11:00 (2h)');
  });

  it('formats single block with minutes when below an hour', () => {
    expect(
      formatFocusBlocks([{ start: '09:00', end: '09:45', duration_minutes: 45 }]),
    ).toBe('09:00-09:45 (45m)');
  });

  it('joins multiple blocks with " · "', () => {
    expect(
      formatFocusBlocks([
        { start: '09:00', end: '10:00', duration_minutes: 60 },
        { start: '14:00', end: '16:00', duration_minutes: 120 },
      ]),
    ).toBe('09:00-10:00 (1h) · 14:00-16:00 (2h)');
  });
});

describe('POSTURE_LABEL / CONTEXT_ICON', () => {
  it('has all 4 postures', () => {
    expect(Object.keys(POSTURE_LABEL).sort()).toEqual([
      'focus',
      'launch',
      'meeting-heavy',
      'recovery',
    ]);
  });

  it('has all 7 context types', () => {
    expect(Object.keys(CONTEXT_ICON).length).toBe(7);
  });
});
```

- [ ] **Step 3: Run unit tests**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npx vitest run src/features/morning-brief/lib/posture.test.ts 2>&1 | tail -15
```
Expected: 4 test files pass (or however many describe blocks; should show all green).

- [ ] **Step 4: Commit**

```bash
git add src/features/morning-brief/lib/
git commit -m "feat(features/morning-brief): add posture helpers + tests (Phase 2 Step 3)"
```

---

## Task 3: Extract BriefItemCard component

**Files:**
- Create: `src/features/morning-brief/components/BriefItemCard.tsx`

- [ ] **Step 1: Create the component**

Create `src/features/morning-brief/components/BriefItemCard.tsx`:

```typescript
import { Icon } from '@/shared/icons';
import { contextIconName } from '../lib/posture';
import type { BriefItem, ContextItem } from '../types';

interface BriefItemCardProps {
  item: BriefItem;
  index: number;
  onAction: (item: BriefItem) => void;
  onContext: (ctx: ContextItem) => void;
}

export function BriefItemCard({ item, index, onAction, onContext }: BriefItemCardProps) {
  const num = String(index + 1).padStart(2, '0');
  const ctx = Array.isArray(item.related_context) ? item.related_context.slice(0, 3) : [];

  return (
    <div className="mb-card morning-brief-card">
      <div className="mb-item-head">
        <span className="mb-item-num">{num}</span>
        <div className="mb-item-head-text">
          {item.time_hint ? <div className="t-mono mb-time-hint">{item.time_hint}</div> : null}
          <div className="mb-what">{item.what}</div>
        </div>
      </div>
      <div className="mb-why">{item.why_now}</div>
      {ctx.length > 0 ? (
        <div className="mb-chips">
          {ctx.map((c, i) => (
            <button
              key={i}
              type="button"
              className="mb-chip"
              onClick={() => onContext(c)}
              title={c.uri || ''}
            >
              <Icon name={contextIconName(c.type)} size={12} />
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mb-cta-row">
        <button
          type="button"
          className="btn btn-sm btn-secondary mb-cta"
          onClick={() => onAction(item)}
        >
          {item.next_action && item.next_action.label ? item.next_action.label : 'Next'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck 2>&1 | tail -5
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/morning-brief/components/
git commit -m "feat(features/morning-brief): extract BriefItemCard component (Phase 2 Step 3)"
```

---

## Task 4: Extract useMorningBrief hook

**Files:**
- Create: `src/features/morning-brief/hooks/useMorningBrief.ts`

- [ ] **Step 1: Create the hook**

Create `src/features/morning-brief/hooks/useMorningBrief.ts`:

```typescript
import { useState, useEffect, useCallback } from 'react';
import type { MorningBriefV2, MorningBriefV1, BriefItem, ContextItem } from '../types';

interface ShogunRuntime {
  executeAction: (
    key: string,
    payload: Record<string, unknown>,
    options?: { silentError?: boolean; successMessage?: string },
  ) => Promise<{ ok: boolean; data?: unknown }>;
}

interface ShogunMorningBriefAPI {
  buildBriefGetPayload: () => Record<string, unknown>;
  unwrapBriefGetRegistryResult: (
    result: unknown,
  ) => { ok: boolean; brief?: MorningBriefV2 | MorningBriefV1 };
  resolveNextAction: (
    nextAction: NonNullable<BriefItem['next_action']>,
    item: BriefItem,
  ) => { skip?: boolean; key: string; payload: Record<string, unknown> };
}

interface BriefTelemetryAPI {
  EVENTS: {
    BRIEF_RENDERED: string;
    NEXT_ACTION_CLICK: string;
  };
  log: (event: string, payload: Record<string, unknown>) => void;
}

function getRuntime(): ShogunRuntime | null {
  if (typeof window === 'undefined') return null;
  const r = (window as unknown as { SHOGUN_RUNTIME?: ShogunRuntime }).SHOGUN_RUNTIME;
  return r && typeof r.executeAction === 'function' ? r : null;
}

function getMorningBriefApi(): ShogunMorningBriefAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { ShogunMorningBrief?: ShogunMorningBriefAPI }).ShogunMorningBrief ?? null;
}

function getBriefTelemetry(): BriefTelemetryAPI | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { BriefTelemetry?: BriefTelemetryAPI }).BriefTelemetry ?? null;
}

async function runtimeInvoke(
  key: string,
  payload: Record<string, unknown>,
  options: { silentError?: boolean; successMessage?: string } = {},
): Promise<{ ok: boolean; data?: unknown }> {
  const rt = getRuntime();
  if (!rt) return { ok: false };
  return rt.executeAction(key, payload, options);
}

export interface UseMorningBriefResult {
  brief: MorningBriefV2 | null;
  legacyV1: MorningBriefV1 | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  onAction: (item: BriefItem) => Promise<void>;
  onContext: (ctx: ContextItem) => Promise<void>;
}

export function useMorningBrief(): UseMorningBriefResult {
  const [brief, setBrief] = useState<MorningBriefV2 | null>(null);
  const [legacyV1, setLegacyV1] = useState<MorningBriefV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const SB = getMorningBriefApi();
    if (!SB) {
      setError('ShogunMorningBrief not loaded');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const payload = SB.buildBriefGetPayload();
    const res = await runtimeInvoke('brief.get', payload, { silentError: true });
    const unwrapped = SB.unwrapBriefGetRegistryResult(res);
    if (!unwrapped.ok || !unwrapped.brief) {
      setError('Could not load Morning Brief');
      setBrief(null);
      setLegacyV1(null);
      setLoading(false);
      return;
    }
    const b = unwrapped.brief;
    if (b.version === '2.0') {
      setBrief(b as MorningBriefV2);
      setLegacyV1(null);
      const tel = getBriefTelemetry();
      if (tel) {
        tel.log(tel.EVENTS.BRIEF_RENDERED, {
          version: '2.0',
          items: ((b as MorningBriefV2).items?.length) || 0,
        });
      }
    } else {
      setBrief(null);
      setLegacyV1(b as MorningBriefV1);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const onAction = useCallback(async (item: BriefItem) => {
    const SB = getMorningBriefApi();
    if (!SB || !item || !item.next_action) return;
    const spec = SB.resolveNextAction(item.next_action, item);
    if (spec.skip) return;
    const tel = getBriefTelemetry();
    if (tel) {
      tel.log(tel.EVENTS.NEXT_ACTION_CLICK, {
        item_id: item.id,
        key: spec.key,
      });
    }
    await runtimeInvoke(spec.key, spec.payload, {
      successMessage: item.next_action.label || 'Done',
      silentError: true,
    });
  }, []);

  const onContext = useCallback(async (c: ContextItem) => {
    const q = c.title || c.uri || '';
    await runtimeInvoke(
      'memory.search',
      { query: q, limit: 15, source: 'morning_brief_context' },
      { successMessage: 'Search started', silentError: true },
    );
  }, []);

  return { brief, legacyV1, loading, error, reload, onAction, onContext };
}
```

- [ ] **Step 2: Verify**

```bash
npm run typecheck 2>&1 | tail -5
```
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/features/morning-brief/hooks/
git commit -m "feat(features/morning-brief): extract useMorningBrief hook with types (Phase 2 Step 3)"
```

---

## Task 5: Create MorningBriefScreen.tsx + update barrel

**Files:**
- Create: `src/features/morning-brief/MorningBriefScreen.tsx`
- Modify: `src/features/morning-brief/index.ts`
- Modify: `src/features/_legacy/index.ts` (remove ScreenMorningBrief export)
- Delete: `src/features/_legacy/screens-morning-brief.tsx`

- [ ] **Step 1: Create the screen**

Create `src/features/morning-brief/MorningBriefScreen.tsx`:

```typescript
import { useMorningBrief } from './hooks/useMorningBrief';
import { BriefItemCard } from './components/BriefItemCard';
import { POSTURE_LABEL, formatFocusBlocks } from './lib/posture';

export function MorningBriefScreen() {
  const { brief, legacyV1, loading, error, reload, onAction, onContext } = useMorningBrief();

  if (loading) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: '80px 40px' }}>
        <div className="t-mono" style={{ color: 'var(--text-mute)' }}>
          Loading Morning Brief…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="content-inner morning-brief-root" style={{ padding: '80px 40px' }}>
        <div style={{ color: 'var(--danger, #A65D5D)', marginBottom: 16 }}>{error}</div>
        <button type="button" className="btn btn-sm btn-secondary" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }

  if (legacyV1) {
    const sections = Array.isArray(legacyV1.sections) ? legacyV1.sections : [];
    return (
      <div
        className="content-inner morning-brief-root"
        style={{ maxWidth: 720, margin: '0 auto', padding: '80px 40px 64px' }}
      >
        <div className="t-mono" style={{ marginBottom: 12 }}>
          Morning Brief <span style={{ color: 'var(--text-dim)' }}>v1</span>
        </div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: '0 0 24px' }}>Legacy format</h1>
        {sections.length === 0 ? (
          <div style={{ color: 'var(--text-mute)' }}>
            No sections yet. Enable v2 in Settings → Morning Brief or add{' '}
            <code>?brief=v2</code> to the URL.
          </div>
        ) : (
          sections.map((s, i) => (
            <div key={i} className="mb-card morning-brief-card" style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>{s.title}</div>
              <div style={{ color: 'var(--text-mute)', fontSize: 14, lineHeight: 1.5 }}>
                {s.body}
              </div>
            </div>
          ))
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginTop: 16 }}
          onClick={reload}
        >
          Refresh
        </button>
      </div>
    );
  }

  if (!brief) return null;

  const summary = brief.summary || {};
  const items = Array.isArray(brief.items) ? brief.items : [];
  const deferred = Array.isArray(brief.deferred) ? brief.deferred : [];
  const focusLine = formatFocusBlocks(summary.focus_blocks);
  const dateLabel = brief.date || '';
  const postureKey = summary.posture || 'focus';
  const postureLabel = (POSTURE_LABEL as Record<string, string>)[postureKey] || postureKey;

  return (
    <div
      className="content-inner morning-brief-root"
      style={{ maxWidth: 640, margin: '0 auto', padding: '56px 40px 64px' }}
    >
      <div className="mb-header">
        <div className="mb-header-top">
          <span className="mb-title-icon" aria-hidden>
            {'⚔'}
          </span>
          <div>
            <div className="t-mono mb-header-kicker">Morning Brief</div>
            <h1 className="mb-header-date">{dateLabel}</h1>
          </div>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={reload}>
            Refresh
          </button>
        </div>
      </div>

      <div className="mb-card morning-brief-card mb-summary">
        <div className="mb-headline">{summary.headline}</div>
        <div className="mb-summary-meta">
          <span className="mb-posture">{postureLabel}</span>
          {summary.total_meeting_minutes != null ? (
            <span className="t-mono mb-meta-muted">
              · {summary.total_meeting_minutes} min meetings
            </span>
          ) : null}
        </div>
        {focusLine ? (
          <div className="mb-focus-line">
            Focus: <span className="gold">{focusLine}</span>
          </div>
        ) : null}
      </div>

      <div className="mb-items" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {items.map((item, i) => (
          <BriefItemCard
            key={item.id || i}
            item={item}
            index={i}
            onAction={onAction}
            onContext={onContext}
          />
        ))}
      </div>

      {deferred.length > 0 ? (
        <div className="mb-deferred" style={{ marginTop: 24 }}>
          <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 8 }}>
            DEFERRED · {deferred.length}
          </div>
          <div className="mb-card morning-brief-card" style={{ padding: 16 }}>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-mute)', fontSize: 13 }}>
              {deferred.map((d) => (
                <li key={d.id} style={{ marginBottom: 6 }}>
                  {d.snippet}
                  {d.reason ? (
                    <span
                      className="t-mono"
                      style={{ fontSize: 10, marginLeft: 8, color: 'var(--text-dim)' }}
                    >
                      ({d.reason})
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 20 }}>
        Tip: open with <code>?brief=v2</code> to force AMC v2 in the browser mock.
      </div>
    </div>
  );
}

// Phase 2 expedient: keep window export for any external code that still uses it.
// Will be removed in Phase 2 Step 12 along with the rest of the legacy globals.
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenMorningBrief = MorningBriefScreen;
}
```

- [ ] **Step 2: Update feature index.ts**

Replace `src/features/morning-brief/index.ts` content:

```typescript
export { MorningBriefScreen } from './MorningBriefScreen';
export type { MorningBrief, MorningBriefV2, BriefItem, BriefSummary } from './types';
```

- [ ] **Step 3: Remove from _legacy barrel**

Edit `src/features/_legacy/index.ts`:

Find:
```typescript
export { ScreenMorningBrief } from './screens-morning-brief';
```

Delete this line. The standalone screen no longer comes from `_legacy/`.

- [ ] **Step 4: Delete _legacy file**

```bash
git rm src/features/_legacy/screens-morning-brief.tsx
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck 2>&1 | tail -5
npm run build 2>&1 | tail -5
npm run cycles 2>&1 | tail -3
```

Expected: typecheck 0 errors, build green, no cycles.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(features/morning-brief): split screen out of _legacy/ (Phase 2 Step 3)"
```

---

## Task 6: Verify e2e + unit tests still green

**Files:** none (verification only)

- [ ] **Step 1: Vitest**

```bash
cd /Users/torutano/code/ShogunAI3-hifi-phase0
npx vitest run 2>&1 | tail -10
```
Expected: lib/posture.test.ts passes (~3 test files / 12+ assertions). No other unit tests yet.

- [ ] **Step 2: Playwright e2e**

```bash
npx playwright test --reporter=list 2>&1 | tail -5
```
Expected: 56 passed (Phase 0 baseline maintained).

- [ ] **Step 3: Lint**

```bash
npm run lint 2>&1 | tail -10
```
Expected: 0 errors. (Note: `boundaries/element-types` is still `warn` at this point, so feature-internal violations would only warn, not fail.)

- [ ] **Step 4: Tauri smoke (manual)**

The standalone Morning Brief screen isn't reachable through nav, so this Step doesn't require a manual click-through. Just confirm `npm run build:desktop` produces `.app` without errors.

```bash
npm run build:desktop 2>&1 | tail -5
```
Expected: bundle generated.

---

## Task 7: Create PR

**Files:** none

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/hifi-phase2-step3-morning-brief
```

(Run from a branch named `feat/hifi-phase2-step3-morning-brief`. If you started from `feat/hifi-vite-migration`, create the new branch first via `git checkout -b feat/hifi-phase2-step3-morning-brief`.)

- [ ] **Step 2: Create PR**

```bash
gh pr create --base feat/hifi-vite-migration --title "Hi-Fi Phase 2 / Step 3: morning-brief feature split" --body "$(cat <<'EOF'
## Summary

Extracts the standalone Morning Brief screen from `src/features/_legacy/screens-morning-brief.tsx` (289 lines, `// @ts-nocheck`) into a properly structured feature folder under `src/features/morning-brief/`. Adds full TypeScript types, a `useMorningBrief` hook with typed `window` accessors, decomposed `BriefItemCard` component, and Vitest unit tests for the pure helpers.

## What changed

| Before | After |
|---|---|
| `_legacy/screens-morning-brief.tsx` (289 lines, no types) | `features/morning-brief/{MorningBriefScreen.tsx, components/BriefItemCard.tsx, hooks/useMorningBrief.ts, lib/posture.ts, types.ts, index.ts}` |
| `// @ts-nocheck` | full TypeScript with `strict + checkJs` |
| no tests | `lib/posture.test.ts` (12+ assertions, all green) |

## Verification

- [x] `npm run typecheck` 0 errors
- [x] `npm run build` green
- [x] `npm run cycles` no circular deps
- [x] `npm run test:unit` (vitest) green
- [x] `npm run test:e2e` 56/56 (Phase 0 baseline maintained)
- [x] `npm run build:desktop` bundle generated

## Notes

- The standalone screen isn't routed in App.tsx (no nav-item), so this Step is the lowest-risk feature split. The Morning Brief CARD on the Home screen lives inside `screens-a.tsx` and will be split as part of Phase 2 Step 8.
- `window.ScreenMorningBrief` compat shim is preserved to support any external code still using it; will be removed in Phase 2 Step 12.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## DoD (Done の定義)

- [x] `_legacy/screens-morning-brief.tsx` 削除済み
- [x] `src/features/morning-brief/` に { Screen, components/, hooks/, lib/, types.ts, index.ts } が揃っている
- [x] feature 内に `// @ts-nocheck` がゼロ
- [x] Vitest unit tests が `lib/posture.ts` をカバー
- [x] e2e 56 passed
- [x] typecheck / lint / cycles すべて通過
