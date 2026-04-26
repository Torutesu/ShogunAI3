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
- Zero backend changes. Frontend-only grouping via a new `riverEvents`
  useMemo derived from the existing `events` useMemo.

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

### Scope: River scrubber only

The Memory screen has multiple `view` modes (`river`, `kakejiku`,
`heatmap`, `digest`, `search`) that all read the same `events` useMemo
(line 1938). Only the **River scrubber** (`view === 'river'`) hides
LOW items today, so clustering should be scoped there.

To avoid leaking the synthetic cluster entry into Kakejiku, Heatmap,
etc., we **do not modify** the existing `events` useMemo. Instead we
add a new `riverEvents` useMemo derived from `events` that the scrubber
and its `(+N)` badge consume.

```js
const riverEvents = useMemo(() => {
  // mixed mode (L filter ON): pass through unchanged
  if (activeFilters.priority.low) return events;

  // cluster mode (L filter OFF): partition + cluster
  const mainEvents = events.filter((e) => effectivePriority(e) !== 'low');
  const lowEvents  = events.filter((e) => effectivePriority(e) === 'low');
  if (lowEvents.length === 0) return mainEvents;
  const cluster = {
    kind: 'low_cluster',
    count: lowEvents.length,
    items: lowEvents,
    // `h` set so heatmap/scrubber math doesn't NaN if any code reads it
    h: 23.99, ts: 0,
  };
  return lowClusterExpanded
    ? [...mainEvents, cluster, ...lowEvents]
    : [...mainEvents, cluster];
}, [events, activeFilters.priority.low, lowClusterExpanded, summaryByMemId]);
```

`effectivePriority` is the same helper already defined inside the
existing `events` useMemo (line 1943) — promote it to component scope
so `riverEvents` can use it too.

### Bindings inside the River view

The River scrubber currently reads `events` directly in many places
(`scrubbed`, scrubber `X/N`, `(+N)` badge, `hourIndexFromEvents`,
`bins`, `timeSpanLabel`, etc.). For this feature we change **only the
scrubber-facing reads** to use `riverEvents`:

- `scrubbed = riverEvents[Math.min(scrubIdx, riverEvents.length - 1)]`
  (line 2141)
- `Math.min(scrubIdx, riverEvents.length - 1)` clamping in
  `useEffect` (lines 2107-2110)
- Scrubber `X / N` (line 2658) and prev/next disabled-state (lines
  2673-2675)
- `(+N)` badge (lines 2659-2663): see "Header `(+N)` badge" below

`bins`, `hourIndexFromEvents`, `timeSpanLabel`, the Kakejiku list, and
the Heatmap grid keep using `events`. The synthetic cluster does not
appear in any of those.

### Header `(+N)` badge (lines 2659-2663)

Removed. The cluster header itself communicates "N LOW items below" and
is always visible in cluster mode. Keeping `(+N)` would double-count
the affordance. (In `L`-filter-ON / mixed mode, `riverEvents === events`
and the badge would always read `+0` anyway, so it's safe to delete
unconditionally.)

## § 2. UI

The River screen is a **scrubber UI**: one card detail panel at a time,
navigated by prev/next chevrons and the 24-hour bar at the bottom. The
cluster therefore manifests in two ways:

### A. Cluster header view (when `scrubbed.kind === 'low_cluster'`)

The big detail panel (currently rendering `scrubSummary` /
`scrubbed.title` / keyPoints — line 2714 onward) is replaced by a
dedicated cluster panel:

- Same outer container shape (`memory-summary-card`, padding, left
  border) but neutral border color (`var(--border)`, not gold)
- Title row: large chevron (`▶` collapsed / `▼` expanded) + heading
  `Other · {count} items` (en) / `その他 · {count}件` (jp)
- Subtitle row: muted hint
  - collapsed: `Click to expand and step through {count} low-priority items.` /
    `クリックで展開し、{count}件の低優先メモリを順に見ます。`
  - expanded: `Step → with the next-memory arrow to scan items, or click to collapse.` /
    `→ で順送り、もう一度クリックで畳めます。`
- The whole panel is `role="button"` with `aria-expanded={lowClusterExpanded}`,
  Enter/Space toggles
- Click → `setLowClusterExpanded((v) => !v)` (and write back to
  `lowClusterExpandedSession`)

When the panel is rendered, the surrounding scrubber chrome (provenance
chips, `Show raw`, `PIN H/M/L`, hour-bin highlight, copy buttons) is
suppressed because none of it applies to a synthetic entry.

### B. Inline LOW item view (expanded, `scrubbed.priority === 'low'`)

When `lowClusterExpanded` is true and the user advances past the
cluster header into a LOW item, the detail panel renders normally
(reusing the existing `memory-summary-card` block) with one addition:
a 1-line breadcrumb pinned above the card —

- Left: small chevron-up icon
- Text: `Inside Other cluster · {idx}/{count}` (en) /
  `その他クラスタ内 · {idx}/{count}` (jp)
- Right: ghost button `Collapse` / `畳む` → sets
  `lowClusterExpanded = false` and snaps `scrubIdx` back to the cluster
  header's index (so the user lands on the collapsed cluster row, not
  off the end of the list)

The card itself, including PIN H/M/L and Mark-read / Open-in-Memory /
Snooze actions, is unchanged.

### Card actions inside the cluster

Identical to today's HIGH/MEDIUM cards (Mark read · Open in Memory ·
Snooze 1h / Tomorrow 9am / Next Monday). No new code — same panel.

## § 3. Edge Cases

| Scenario | Behavior |
|---|---|
| LOW count = 0 | Cluster header is not added to `riverEvents`. |
| `L` filter ON | `riverEvents === events` (passthrough); cluster suppressed, LOW interleaved (current behavior). `lowClusterExpanded` value is preserved so toggling `L` back OFF restores the previous expand state. |
| Provider filter excludes a LOW source | Provider/source filtering happens inside the existing `events` useMemo, before `riverEvents` partitions, so excluded LOW items don't show in the cluster either. |
| User snoozes the last LOW item | Re-render drops the cluster entry from `riverEvents`; header disappears. Next time a LOW item appears, the header returns and respects the current `lowClusterExpanded` value (preserved across the empty interval). |
| Scrubber navigation crosses the cluster | Header is one scrubber step. Expanded → LOW cards are individually steppable (with breadcrumb above). Collapsed → LOW cards are not in `riverEvents`, so not steppable. **No auto-expand on focus** (Q6-A: toggle only). |
| Hour-bin click lands on a LOW item | Hour bins are computed from `events` (not `riverEvents`), so they include LOW items. If a bin's `firstIdx` points to a LOW item but the cluster is collapsed, that item is not in `riverEvents` and `setScrubIdx(firstIdx)` would land out of range. **Mitigation:** rebuild the hour index against `riverEvents` (for the bin → scrubIdx mapping only — counts/colors continue to use `events` so the timeline shape doesn't visually change with expand/collapse). Bins whose only members are clustered LOW items are non-clickable (or click expands the cluster and snaps to the LOW item — pick the simpler "non-clickable when collapsed and the bin contains only LOW" rule for now). |
| River unmount → remount (Memory → River) | `useState(lowClusterExpandedSession)` rehydrates the previous value. App restart resets to `false`. |
| All items are LOW (rare) | `mainEvents` is empty; cluster is the only entry. Scrubber reads `1 / 1` collapsed, `1 / 1+N` expanded. |
| Other view modes (`kakejiku`, `heatmap`, `digest`, `search`) | Read `events` (not `riverEvents`), so they are unaffected. LOW items continue to appear in those views the same as today — clustering is River-scrubber-only. |

## § 4. Testing

### Playwright e2e (new: `tests/e2e/memory-river-low-cluster.spec.js`)

- Default render with mixed-priority seed → scrubber lands on a HIGH
  item; advancing past `mainEvents.length - 1` shows the cluster header
  panel; `(+N)` header badge gone.
- Click cluster header (or press Enter while focused) → `aria-expanded`
  flips to `true`, scrubber `X / N` denominator grows by `count`,
  next-arrow becomes active.
- Press next inside expanded cluster → breadcrumb `Inside Other cluster
  · 1/N` appears above the standard card panel; PIN H/M/L still works
  on the LOW item.
- Click `Collapse` in breadcrumb → expanded becomes false, scrubIdx
  snaps back to the cluster header position.
- Toggle `L` filter ON → cluster header disappears, LOW items interleave
  in the standard card view; toggle OFF → cluster returns at previous
  expand state.
- Seed with zero LOW items → no cluster header in the scrubber stream.
- Snooze one LOW item via the in-cluster card actions → cluster `count`
  decrements; snoozing the last LOW snaps scrubIdx back to the last
  HIGH/MED item and header is gone.
- Navigate River → Memory tab → River → expand state preserved across
  the screen switch.
- Other view modes: switch to `kakejiku` and confirm no synthetic
  `low_cluster` row appears in the vertical list.

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
