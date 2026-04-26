# Memory Digest Phase 4 — Low-Priority Grouping ("Other") Design

**Status:** Draft
**Date:** 2026-04-26
**Spec parent:** `docs/superpowers/specs/2026-04-24-memory-digest-design.md` § 8 Phase 4 / Open Questions

## Problem

Memory River currently hides LOW-priority items entirely (default
`activeFilters.priority.low = false`). The header carries a small `(+N)`
badge whose tooltip tells users to flip the `L` filter chip in Filters.
The hidden state is undiscoverable, and toggling `L` floods the river
with noise that the priority system was meant to suppress.

We want LOW items to remain present-but-quiet: visible enough that the
user knows they exist, collapsible into one row so they don't crowd out
HIGH/MEDIUM, expandable on demand to scan or act on them.

## Goals

- Surface LOW items on the River without flooding the timeline.
- Single, discoverable affordance — no reliance on the Filters menu.
- Keep the existing power-user path (`L` filter chip → mixed view).
- Zero backend changes. Pure frontend grouping in the existing
  `events` useMemo.

## Non-Goals

- Bulk actions on the cluster header (mark-all-read, snooze-all).
  Considered and explicitly deferred — Q6-A.
- Sub-grouping by source inside the cluster ("GitHub · 5 / Linear · 3").
  Deferred — Q3-A picks plain card rendering.
- Per-user persistence of expand state across app restarts. Session
  scope only — Q4-B.
- New IPC actions, DB schema changes, or summarizer logic changes.

## § 1. Architecture & Data Flow

Pure frontend change in `hifi/screens-a.jsx` River screen.

### State

- **Existing:** `activeFilters.priority.low: boolean` (kept as-is).
  - `false` (default) → cluster mode (this feature)
  - `true` → mixed mode (today's behavior, all LOW interleaved)
- **New:** `lowClusterExpanded: boolean`, React `useState` inside
  the River component.
  - Initialized from a module-scope `let
    lowClusterExpandedSession = false` so the value survives
    React-Screen unmount (Memory → Home → River round trip).
  - On change, both `setLowClusterExpanded(v)` and
    `lowClusterExpandedSession = v`.
  - Reset to `false` on app restart (module reload).

### `events` useMemo (line 1938)

After `clusterScreenSessions` and provider/source filtering:

1. Partition `clustered` into `mainEvents` (priority ∈ {high, medium,
   unclassified}) and `lowEvents` (priority === 'low').
2. Sort `mainEvents` by the existing `rank` (H → M → unclassified) then
   newest-first.
3. Sort `lowEvents` newest-first.
4. **If `activeFilters.priority.low === true`:** return
   `[...mainEvents, ...lowEvents]` (mixed mode, today's behavior — LOW
   ranks=3 sits at the end naturally).
5. **Else (cluster mode):**
   - If `lowEvents.length === 0` → return `mainEvents`.
   - Else build a synthetic event:
     ```js
     { kind: 'low_cluster', count: lowEvents.length, items: lowEvents }
     ```
   - If collapsed → return `[...mainEvents, cluster]`.
   - If expanded → return `[...mainEvents, cluster, ...lowEvents]`.

The synthetic event sits in the same array as real events, so the
scrubber (`X / N`) and all downstream loops keep working unchanged. Only
the card render path needs an `if (e.kind === 'low_cluster')` branch.

### Header `(+N)` badge (line 2660)

Removed. The cluster header itself communicates "N LOW items below" and
is always visible in cluster mode. Keeping `(+N)` would double-count and
duplicate the affordance.

## § 2. UI

### `LowClusterHeader` (inline component or render branch)

One-row collapsed/expanded toggle. Same width as a River card, ~36px
height.

- Background: `var(--surface-mute)`
- Left: chevron icon (`▶` collapsed / `▼` expanded), rotates on toggle
- Center: `Other · {count} items` (en) / `その他 · {count}件` (jp),
  using existing `<span className="en-only">` / `<span className="jp">`
  pattern
- Right: small subdued chip `[低優先]` / `[low]`
- Cursor: `pointer`
- Click → toggle expansion
- Keyboard: `role="button" tabIndex={0}`, Enter/Space toggles
- A11y: `aria-expanded={lowClusterExpanded}`,
  `aria-controls="low-cluster-items"`

### Expanded LOW cards

Reuse the existing River card component (no new prop needed — they're
the same `e` shape as any other event). Visual cue that they belong to
the cluster: a 2px `var(--border)` left rule with 4px indent on the
container holding the expanded LOW cards. No expanded-state footer; the
header is re-clicked to collapse.

### Card actions inside the cluster

Identical to today's HIGH/MEDIUM cards (Mark read · Open in Memory ·
Snooze 1h / Tomorrow 9am / Next Monday). No new code — same component.

## § 3. Edge Cases

| Scenario | Behavior |
|---|---|
| LOW count = 0 | Cluster header is not added to `events`. |
| `L` filter ON | Cluster suppressed; LOW interleaved (current behavior). `lowClusterExpanded` value is preserved so toggling `L` back OFF restores the previous expand state. |
| Provider filter excludes a LOW source | Excluded LOW items are filtered out before partitioning, so they don't show in the cluster either. |
| User snoozes the last LOW item | Re-render drops the cluster entry from `events`; header disappears. Next time a LOW item appears, the header returns and respects the current `lowClusterExpanded` value (preserved across the empty interval), so a previously-expanded user sees the new item already expanded. |
| Scrubber navigation crosses the cluster | Header is one scrubber step. Expanded → LOW cards are individually steppable. Collapsed → LOW cards are not in `events`, so not steppable. **No auto-expand on focus** (Q6-A: toggle only). |
| River unmount → remount (Memory → River) | `useState(lowClusterExpandedSession)` rehydrates the previous value. App restart resets to `false`. |
| All items are LOW (rare) | `mainEvents` is empty; cluster is the only entry. Scrubber reads `1 / 1` collapsed, `1 / 1+N` expanded. |

## § 4. Testing

### Playwright e2e (new: `tests/memory-river-low-cluster.spec.js`)

- Default render with mixed-priority seed → cluster header at end,
  count correct, `(+N)` header badge gone.
- Click header → expanded, LOW cards rendered with indent rule.
- Click again → collapsed, LOW cards gone.
- `L` filter ON → cluster header gone, LOW interleaved; OFF → cluster
  returns at previous expand state.
- Seed with zero LOW → no cluster header.
- Snooze one LOW item from inside expanded cluster → count decrements;
  snooze the last → header disappears.
- Navigate River → Memory → River → expand state preserved.

### Manual smoke

- `npm run dev:desktop`
- Keyboard-only: Tab to header, Enter to expand
- Toggle EN/JP, verify both label variants

### Static checks (existing)

- `npm run check:actions` — no new IPC actions; unchanged.
- `npm run check:ipc-mock` — unchanged.

## § 5. Rollout

No feature flag. Pure UI change with a clear default that's better than
the existing hidden state. If needed, the existing
`enable_memory_summary` flag already gates the entire priority pipeline
upstream; when it's `false`, `summaryByMemId` is empty, so all items
are unclassified and no LOW partition exists — cluster never renders.

## Open Questions / Future Work

- **Bulk actions** (Mark all / Snooze all) — explicitly deferred. Revisit
  after telemetry shows how often users expand the cluster.
- **Sub-grouping by source** — defer until users complain that flat
  expanded lists are too long.
- **Cross-restart persistence** — currently session-scope. If users ask
  for it, promote `lowClusterExpandedSession` to the settings store.

## Success Criteria

1. LOW items are discoverable from the River without opening Filters.
2. The default River view (`L` OFF) is no noisier than before — cluster
   adds exactly one row.
3. Zero backend changes; existing `check:actions` / `check:ipc-mock`
   pass without modification.
4. New Playwright spec passes for all listed scenarios.
