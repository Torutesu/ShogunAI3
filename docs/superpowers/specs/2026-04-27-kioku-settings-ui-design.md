# KIOKU Sub-spec C — Settings UI Design

**Status:** approved (2026-04-27)
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` § 6, § 7-task-7
**Predecessors:** Sub-spec A (Lessons MVP, shipped) · Sub-spec B (Patterns MVP, shipped)

---

## 1. Goal

Surface KIOKU Patterns (Sub-spec B) and Lessons (Sub-spec A) inside Settings so the user can:

- See what SHOGUN has learned about their routine and feedback.
- Remove patterns that don't reflect their behavior (`これ違う`).
- Forget lessons that no longer apply (`忘れて`).

The bar is **summary-only** per master § 6 — no raw events, no debug detail. The user reads short labels and decides "keep / drop."

## 2. Architecture

Two new top-level Settings tabs (`KIOKU Patterns`, `KIOKU Lessons`) added to the existing `SETTINGS_NAV` array in `hifi/settings-modal.jsx`, sitting next to the existing `KIOKU Graph` tab. The existing Graph pane is **unchanged** — it continues to host advanced controls (rules, cost, SLI, edge_types, backup).

Both new tabs are pure read-from-DB views with one mutation action each (invalidate / archive). All backend logic already exists in `src-tauri/src/patterns.rs` and `src-tauri/src/lessons.rs`; this sub-spec only adds five thin Tauri command wrappers and one new SQL aggregate (`lessons_stats`).

## 3. Decisions Locked During Brainstorm

| # | Decision | Choice |
|---|----------|--------|
| 1 | Tab placement | **A** — two new top-level Settings tabs (not sub-sections inside Graph). |
| 2 | "Prevented" counter metric | **A** — `applies_n` proxy (no new tracking infra). |
| 3 | Patterns row content | **A** — label only + `これ違う` button. |
| 4 | Patterns sort/group | **A** — single flat list, `confidence DESC`. No kind grouping or filter. |
| 5 | Lessons row content | **A** — rule text only + `忘れて` button. No category badge / applies count per row. |
| 6 | Lessons header stats | **A** — two text lines only (`{n} lessons learned`, `Applied {n} times total`). No bar chart. |
| 7 | Counter timeframe | **A** — cumulative ("Applied 28 times total"), not month-scoped. |
| 8 | Controls / refresh | **A** — auto-fetch on tab open. No refresh button, no manual `Run detection now` button. |

## 4. UI Spec

### 4.1 Settings nav

Add to `SETTINGS_NAV` in `hifi/settings-modal.jsx` (line 4-19), immediately after the existing `kioku_graph` entry:

```js
{id:'kioku_graph',    label:'KIOKU Graph',    jp:'記憶グラフ', icon:'memory'},
{id:'kioku_patterns', label:'KIOKU Patterns', jp:'常套',      icon:'clock'},
{id:'kioku_lessons',  label:'KIOKU Lessons',  jp:'教訓',      icon:'graduation'},
```

Both icon names (`clock`, `graduation`) exist in `hifi/icons.jsx`. Do not invent new icon names.

Add to the `PANE_RENDERERS` dispatch table (around line 3476):

```js
kioku_patterns: PaneKiokuPatterns,
kioku_lessons:  PaneKiokuLessons,
```

### 4.2 KIOKU Patterns pane

```
┌─ KIOKU Patterns ─────────────────────────────────────┐
│  Things SHOGUN noticed about your routine.           │
│                                                      │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                      │
│  • You usually open Slack around 09:00 on Mondays.   [これ違う]
│  • After Linear, you often switch to Slack within    [これ違う]
│    30 min.                                           │
│  • You usually open Notion around 14:00 on Wed.      [これ違う]
│  ...                                                 │
└──────────────────────────────────────────────────────┘
```

- Header: title + 1-line subtitle `Things SHOGUN noticed about your routine.`
- Body: flat list, `confidence DESC, observed_n DESC`, **max 50 items**.
- Each row = `<span>{pattern.label}</span>` + `<button>これ違う</button>`.
- Empty state: `Nothing yet — patterns appear after a few days of usage.`
- Click `これ違う` → call `patterns.invalidate({id})` → optimistically remove row from local state. On error: toast `Could not remove — try again.` and restore row.

### 4.3 KIOKU Lessons pane

```
┌─ KIOKU Lessons ──────────────────────────────────────┐
│  Things SHOGUN learned from your feedback.           │
│                                                      │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                      │
│   12 lessons learned                                 │
│   Applied 28 times total                             │
│                                                      │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│                                                      │
│  • Avoid emojis in formal replies.                   [忘れて]
│  • Keep slack messages under 3 lines.                [忘れて]
│  • Use "regards" not "best" for external email.      [忘れて]
│  ...                                                 │
└──────────────────────────────────────────────────────┘
```

- Header: title + 1-line subtitle `Things SHOGUN learned from your feedback.`
- Stats block: two text lines (no chart, no per-category breakdown).
  - `{total_active} lessons learned`
  - `Applied {applied_total} times total`
- Body: flat list, `created_at DESC`, **max 50 items**.
- Each row = `<span>{lesson.rule}</span>` + `<button>忘れて</button>`.
- Empty state: `No lessons yet — they grow as you give feedback.`
- Click `忘れて` → call `lessons.archive({id})` → optimistically remove row + decrement local `total_active`. Refetch stats after success. On error: toast + restore row.

### 4.4 Style

Reuse existing `Pane` / `Row` / `card` / `t-mono` / `t-sm` / `--text` / `--text-mute` / `--space-*` tokens from `hifi/settings-modal.jsx`. No new CSS variables. Buttons use `btn btn-sm btn-secondary`.

## 5. Backend — five new Tauri commands

All defined in `src-tauri/src/commands.rs`, registered in `src-tauri/src/lib.rs` `invoke_handler!`.

### 5.1 `shogun_patterns_list` (READ)

```rust
#[tauri::command]
pub fn shogun_patterns_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = crate::patterns::list_for_brief(50)?;
  Ok(serde_json::json!({ "items": items }))
}
```

**Modification to `patterns::list_for_brief`:** Add `"id": id` to each emitted JSON object so the UI can pass it to `invalidate`. The Morning Brief consumer ignores unknown keys, so this is backward-compatible. Update the SELECT in `list_for_brief` to include the `id` column (already in the `patterns` table).

### 5.2 `shogun_patterns_invalidate` (WRITE)

```rust
#[tauri::command]
pub fn shogun_patterns_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload.get("id").and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  crate::patterns::invalidate(id)?;
  Ok(serde_json::json!({ "ok": true }))
}
```

### 5.3 `shogun_lessons_list` (READ)

```rust
#[tauri::command]
pub fn shogun_lessons_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let items = crate::lessons::list_active(&conn, 50)?;
  let trimmed: Vec<serde_json::Value> = items.iter().map(|l| serde_json::json!({
    "id":         l.id,
    "rule":       l.rule,
    "category":   l.category,
    "applies_n":  l.applies_n,
    "created_at": l.created_at,
  })).collect();
  Ok(serde_json::json!({ "items": trimmed }))
}
```

### 5.4 `shogun_lessons_archive` (WRITE)

```rust
#[tauri::command]
pub fn shogun_lessons_archive(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload.get("id").and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  let conn = crate::memory_store::open_conn()?;
  crate::lessons::archive(&conn, id)?;
  Ok(serde_json::json!({ "ok": true }))
}
```

### 5.5 `shogun_lessons_stats` (READ)

```rust
#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let total: i64 = conn.query_row(
    "SELECT COUNT(*) FROM lessons WHERE status='active'",
    [], |r| r.get(0)
  ).map_err(|e| format!("lessons_stats count: {}", e))?;
  let applied: i64 = conn.query_row(
    "SELECT COALESCE(SUM(applies_n), 0) FROM lessons WHERE status='active'",
    [], |r| r.get(0)
  ).map_err(|e| format!("lessons_stats sum: {}", e))?;
  Ok(serde_json::json!({ "total_active": total, "applied_total": applied }))
}
```

## 6. Frontend IPC plumbing

Each command needs four entries (the standard SHOGUN pattern).

### 6.1 `hifi/lib/shogun-api.js` — bindings

```js
patternsList:       (input) => call("shogun_patterns_list",       input || {}, READ),
patternsInvalidate: (input) => call("shogun_patterns_invalidate", input,        WRITE),
lessonsList:        (input) => call("shogun_lessons_list",        input || {}, READ),
lessonsArchive:     (input) => call("shogun_lessons_archive",     input,        WRITE),
lessonsStats:       (input) => call("shogun_lessons_stats",       input || {}, READ),
```

### 6.2 `hifi/lib/action-registry.js` — action keys

```js
register("patterns.list",       (payload) => api.patternsList(payload));
register("patterns.invalidate", (payload) => api.patternsInvalidate(payload));
register("lessons.list",        (payload) => api.lessonsList(payload));
register("lessons.archive",     (payload) => api.lessonsArchive(payload));
register("lessons.stats",       (payload) => api.lessonsStats(payload));
```

### 6.3 `hifi/action-map.md` — registry doc

Append to the existing list:

```
- `patterns.list`
- `patterns.invalidate`
- `lessons.list`
- `lessons.archive`
- `lessons.stats`
```

### 6.4 `src-tauri/src/lib.rs` — `invoke_handler!`

Add after `commands::shogun_patterns_run_now,`:

```rust
commands::shogun_patterns_list,
commands::shogun_patterns_invalidate,
commands::shogun_lessons_list,
commands::shogun_lessons_archive,
commands::shogun_lessons_stats,
```

## 7. Error Handling

| Failure | UX |
|---------|----|
| `patterns.list` fails | Empty list. Console log only. |
| `lessons.list` fails | Empty list. Console log only. |
| `lessons.stats` fails | Show `—` for both numerics. Console log only. |
| `patterns.invalidate` fails | Toast `Could not remove — try again.` Restore optimistically-removed row. |
| `lessons.archive` fails | Same as above + restore stats. |
| Backend SQL error | Bubble up as `Err(String)` (existing pattern); frontend treats `r.ok === false` per above. |

No error-recovery UX beyond the toast — these are read views of derived data, not authoring surfaces.

## 8. Verification

### 8.1 Static checks

```bash
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

All must PASS. Pre-existing warnings allowed.

### 8.2 Manual walkthrough

1. Settings → KIOKU Patterns → list loads (or empty-state copy if no patterns).
2. Click `これ違う` on any row → row disappears immediately.
3. Refresh app → invalidated row stays gone (`status='stale'` persisted).
4. Settings → KIOKU Lessons → header stats + lesson list visible.
5. Click `忘れて` on any row → row disappears, `total_active` decrements by 1.
6. Refresh app → archived row stays gone (`status='archived'` persisted).
7. Inspect SQLite to confirm row state changes:
   ```bash
   sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
     "SELECT id, status FROM patterns WHERE status != 'active' LIMIT 5;"
   sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
     "SELECT id, status FROM lessons WHERE status != 'active' LIMIT 5;"
   ```

### 8.3 Empty / cold-start

- Fresh install → both panes show empty-state copy. No errors in console.
- After a few days of usage (Patterns) or after first feedback (Lessons) → content appears.

## 9. Out of Scope (Explicit)

These belong to later sub-specs or the broader KIOKU Phase 2 evaluator:

- **Per-category filter or sort UI** for either tab (revisit when categories grow to 3+).
- **`prevented_n` real implementation** — wait for KIOKU evaluator (re-occurrence tracker).
- **Depth-in screen for individual lesson / pattern** — master § 6 explicitly says summary-only.
- **`forget that lesson about emojis` natural-language command** — master § 5 exception, separate sub-spec.
- **`Run detection now` button** — DevTools console can call `runAction('patterns.run_now', {})`; not worth UI surface.
- **Per-category mini-graph** — only 2 categories in use (`user_rejection`, `tool_failure`); chart is overkill.
- **Pagination beyond 50** — well above realistic pattern/lesson counts for MVP user.
- **Confirm dialog before invalidate / archive** — destructive but easily re-learned; speed matters more than safety.
- **Bulk operations** (clear all, archive by category) — YAGNI.

## 10. File Change Summary

| File | Change | Approx LOC |
|------|--------|------------|
| `src-tauri/src/commands.rs` | +5 functions | ~70 |
| `src-tauri/src/lib.rs` | +5 invoke_handler entries | +5 |
| `src-tauri/src/patterns.rs` | `list_for_brief` adds `id` to output | +3 |
| `hifi/settings-modal.jsx` | +2 nav entries, +2 panes, +2 pane registry | ~150 |
| `hifi/lib/shogun-api.js` | +5 bindings | +5 |
| `hifi/lib/action-registry.js` | +5 register calls | +5 |
| `hifi/action-map.md` | +5 entries | +5 |
| **Total** | 7 files modified, 0 new | ~245 LOC |

## 11. Estimate

Master spec § 7 task 7 budgeted **2 days**. Backend logic is essentially zero-new (all primitives exist in `patterns.rs` / `lessons.rs`); only `lessons_stats` SQL is new. Realistic estimate: **0.5–1 day** including manual walkthrough.

---

*Approved sections: § 1 / § 2 / § 3 / § 4 / § 5 / § 6 — all approved during brainstorm.*
