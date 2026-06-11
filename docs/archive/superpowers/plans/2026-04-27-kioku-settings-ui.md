# KIOKU Sub-spec C — Settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two new top-level Settings tabs (`KIOKU Patterns` and `KIOKU Lessons`) that surface what SHOGUN has learned, with one-click `これ違う` / `忘れて` controls.

**Architecture:** Five thin Tauri command wrappers around existing `patterns.rs` / `lessons.rs` primitives + standard SHOGUN IPC plumbing (api binding, action registry, action-map) + two new React panes inside `hifi/settings-modal.jsx`. No new files. The only new backend logic is one SQL aggregate (`shogun_lessons_stats`).

**Tech Stack:** Rust (rusqlite, tauri::command, serde_json), React 19 (in-browser babel via existing `useStateS` / `useRuntimeActions` / `SettingsHydrationContext` patterns).

**Spec:** `docs/superpowers/specs/2026-04-27-kioku-settings-ui-design.md`

---

## File Map

**Modified:**
- `src-tauri/src/patterns.rs` — add `id` to `list_for_brief` output (3 lines: SELECT, row tuple, JSON object).
- `src-tauri/src/commands.rs` — append 5 new Tauri commands (~70 lines total).
- `src-tauri/src/lib.rs` — register 5 commands in `invoke_handler!` (5 lines).
- `hifi/lib/shogun-api.js` — 5 bindings.
- `hifi/lib/action-registry.js` — 5 register calls.
- `hifi/action-map.md` — 5 entries.
- `hifi/settings-modal.jsx` — 2 `SETTINGS_NAV` rows, 2 `PANES` map entries, `PaneKiokuPatterns` (~70 lines), `PaneKiokuLessons` (~80 lines).

**Created:** none.

**No tests in scope** (per spec § 8 — manual eye-test only). Verification = `npm run check:rust` + `npm run check:ipc-mock` + `python3 hifi/scripts/check-actions.py` + manual UI walkthrough.

---

## Task 1: `patterns::list_for_brief` — emit `id`

**Files:**
- Modify: `src-tauri/src/patterns.rs:298-335`

The existing function returns `{kind, label, trigger, action, confidence, observed_n}` for each pattern. The Settings UI needs `id` to call `invalidate`. Add `id` to the SELECT, the row tuple, and the JSON object. Morning Brief consumers ignore unknown keys — backward compatible.

- [ ] **Step 1: Update the SELECT to include `id`**

Use Edit. `old_string`:

```
      "SELECT kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' ORDER BY confidence DESC, observed_n DESC LIMIT ?1",
```

`new_string`:

```
      "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' ORDER BY confidence DESC, observed_n DESC LIMIT ?1",
```

- [ ] **Step 2: Update the row tuple to read `id` at column 0**

Use Edit. `old_string`:

```
    .query_map(params![top_n as i64], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, f32>(3)?, row.get::<_, i64>(4)?))
    })
```

`new_string`:

```
    .query_map(params![top_n as i64], |row| {
      Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, f32>(4)?, row.get::<_, i64>(5)?))
    })
```

- [ ] **Step 3: Destructure `id` and add it to the JSON output**

Use Edit. `old_string`:

```
    let (kind, trigger_str, action_str, confidence, observed_n) = r.map_err(|e| format!("patterns::list_for_brief row: {}", e))?;
    let trigger: Value = serde_json::from_str(&trigger_str).unwrap_or(Value::Null);
    let action: Value = serde_json::from_str(&action_str).unwrap_or(Value::Null);
    let label = match kind.as_str() {
```

`new_string`:

```
    let (id, kind, trigger_str, action_str, confidence, observed_n) = r.map_err(|e| format!("patterns::list_for_brief row: {}", e))?;
    let trigger: Value = serde_json::from_str(&trigger_str).unwrap_or(Value::Null);
    let action: Value = serde_json::from_str(&action_str).unwrap_or(Value::Null);
    let label = match kind.as_str() {
```

- [ ] **Step 4: Include `id` in the `out.push(json!(...))` block**

Use Edit. `old_string`:

```
    out.push(json!({
      "kind": kind, "label": label, "trigger": trigger, "action": action,
      "confidence": confidence, "observed_n": observed_n,
    }));
```

`new_string`:

```
    out.push(json!({
      "id": id, "kind": kind, "label": label, "trigger": trigger, "action": action,
      "confidence": confidence, "observed_n": observed_n,
    }));
```

- [ ] **Step 5: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS, no new errors. The brief.rs consumer (`crate::patterns::list_for_brief(4)` in `morning_brief_v2_stub`) ignores extra keys.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/patterns.rs
git diff --cached --stat
git commit -m "feat(kioku): include id in patterns::list_for_brief output"
git show HEAD --stat
```

`git show HEAD --stat` MUST show exactly 1 file. Otherwise REVERT (`git reset HEAD~1 --soft` then unstage extras) and report BLOCKED.

---

## Task 2: Backend commands — list / invalidate / archive / stats

**Files:**
- Modify: `src-tauri/src/commands.rs` — append 5 new `#[tauri::command]` functions
- Modify: `src-tauri/src/lib.rs` — register 5 commands in `invoke_handler!`

The five commands are thin wrappers; the only new SQL is in `shogun_lessons_stats`.

- [ ] **Step 1: Append 5 commands to `commands.rs`**

Locate the existing `shogun_patterns_run_now` function (`src-tauri/src/commands.rs:2253`). Append the 5 new commands AFTER its closing `}` (around line 2256), BEFORE the next existing fn. Use Edit.

`old_string`:

```rust
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}
```

`new_string`:

```rust
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}

/// Sub-spec C: list active patterns for the Settings UI.
#[tauri::command]
pub fn shogun_patterns_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let items = crate::patterns::list_for_brief(50)?;
  Ok(serde_json::json!({ "items": items }))
}

/// Sub-spec C: invalidate a pattern (`これ違う`). Sets status='stale'.
#[tauri::command]
pub fn shogun_patterns_invalidate(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload
    .get("id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  crate::patterns::invalidate(id)?;
  Ok(serde_json::json!({ "ok": true }))
}

/// Sub-spec C: list active lessons for the Settings UI.
#[tauri::command]
pub fn shogun_lessons_list(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let items = crate::lessons::list_active(&conn, 50)?;
  let trimmed: Vec<serde_json::Value> = items
    .iter()
    .map(|l| {
      serde_json::json!({
        "id": l.id,
        "rule": l.rule,
        "category": l.category,
        "applies_n": l.applies_n,
        "created_at": l.created_at,
      })
    })
    .collect();
  Ok(serde_json::json!({ "items": trimmed }))
}

/// Sub-spec C: archive a lesson (`忘れて`). Sets status='archived'.
#[tauri::command]
pub fn shogun_lessons_archive(payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let id = payload
    .get("id")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "id required".to_string())?;
  let conn = crate::memory_store::open_conn()?;
  crate::lessons::archive(&conn, id)?;
  Ok(serde_json::json!({ "ok": true }))
}

/// Sub-spec C: cumulative stats for the Lessons header.
/// Returns total active lessons + cumulative applies_n sum.
#[tauri::command]
pub fn shogun_lessons_stats(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let conn = crate::memory_store::open_conn()?;
  let total: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats count: {}", e))?;
  let applied: i64 = conn
    .query_row(
      "SELECT COALESCE(SUM(applies_n), 0) FROM lessons WHERE status='active'",
      [],
      |r| r.get(0),
    )
    .map_err(|e| format!("lessons_stats sum: {}", e))?;
  Ok(serde_json::json!({ "total_active": total, "applied_total": applied }))
}
```

- [ ] **Step 2: Register the 5 commands in `lib.rs` `invoke_handler!`**

Locate `commands::shogun_patterns_run_now,` (`src-tauri/src/lib.rs:263`). Use Edit. `old_string`:

```
      commands::shogun_patterns_run_now,
```

`new_string`:

```
      commands::shogun_patterns_run_now,
      commands::shogun_patterns_list,
      commands::shogun_patterns_invalidate,
      commands::shogun_lessons_list,
      commands::shogun_lessons_archive,
      commands::shogun_lessons_stats,
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. New `dead_code` warnings on the 5 commands are EXPECTED at this stage (consumed in Task 3 onward).

If you see hard errors:
- "no method named `archive`" → confirm `pub fn archive(conn: &Connection, id: &str)` exists in `src-tauri/src/lessons.rs:217`. It does.
- "no method named `list_active`" on lessons → same file, line 194. Should be there.
- "no method named `invalidate`" on patterns → `src-tauri/src/patterns.rs:368`. Should be there.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): Settings UI backend — patterns/lessons list, invalidate, archive, stats"
git show HEAD --stat
```

Must show exactly 2 files. Otherwise REVERT.

---

## Task 3: Frontend IPC plumbing — api / registry / action-map

**Files:**
- Modify: `hifi/lib/shogun-api.js` — 5 bindings after `patternsRunNow`
- Modify: `hifi/lib/action-registry.js` — 5 register calls after `patterns.run_now`
- Modify: `hifi/action-map.md` — 5 entries after `patterns.run_now`

- [ ] **Step 1: Add 5 bindings to `hifi/lib/shogun-api.js`**

Locate `patternsRunNow` (`hifi/lib/shogun-api.js:41`). Use Edit. `old_string`:

```
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
```

`new_string`:

```
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
      patternsList: (input) => call("shogun_patterns_list", input || {}, READ),
      patternsInvalidate: (input) => call("shogun_patterns_invalidate", input, WRITE),
      lessonsList: (input) => call("shogun_lessons_list", input || {}, READ),
      lessonsArchive: (input) => call("shogun_lessons_archive", input, WRITE),
      lessonsStats: (input) => call("shogun_lessons_stats", input || {}, READ),
```

- [ ] **Step 2: Add 5 register calls to `hifi/lib/action-registry.js`**

Locate the existing `patterns.run_now` register (`hifi/lib/action-registry.js:80`). Use Edit. `old_string`:

```
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
```

`new_string`:

```
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
    register("patterns.list", (payload) => api.patternsList(payload));
    register("patterns.invalidate", (payload) => api.patternsInvalidate(payload));
    register("lessons.list", (payload) => api.lessonsList(payload));
    register("lessons.archive", (payload) => api.lessonsArchive(payload));
    register("lessons.stats", (payload) => api.lessonsStats(payload));
```

- [ ] **Step 3: Add 5 entries to `hifi/action-map.md`**

Locate the existing `patterns.run_now` entry (`hifi/action-map.md:153`). Use Edit. `old_string`:

```
- `patterns.run_now`
```

`new_string`:

```
- `patterns.run_now`
- `patterns.list`
- `patterns.invalidate`
- `lessons.list`
- `lessons.archive`
- `lessons.stats`
```

- [ ] **Step 4: Verify**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -10
```

Expected:
- `check:ipc-mock`: PASS — 5 new mock IPC commands appear in both files.
- `check-actions.py`: PASS — `patterns.list`, `patterns.invalidate`, `lessons.list`, `lessons.archive`, `lessons.stats` are in registry.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/lib/shogun-api.js hifi/lib/action-registry.js hifi/action-map.md
git diff --cached --stat
git commit -m "feat(kioku): wire patterns/lessons Settings UI IPC actions"
git show HEAD --stat
```

Must show exactly 3 files.

---

## Task 4: `PaneKiokuPatterns` + nav entry

**Files:**
- Modify: `hifi/settings-modal.jsx` — add 1 SETTINGS_NAV row, add `PaneKiokuPatterns` function, add 1 PANES entry

The pane fetches patterns on mount and renders a flat list with `これ違う` buttons. Each click is optimistic — remove from local state, restore + toast on error.

- [ ] **Step 1: Add the `kioku_patterns` nav row**

Locate the existing `kioku_graph` row (`hifi/settings-modal.jsx:14`). Use Edit. `old_string`:

```
  {id:'kioku_graph',  label:'KIOKU Graph',        jp:'記憶グラフ', icon:'memory'},
  {id:'integrations', label:'Integrations',       jp:'連携', icon:'plug'},
```

`new_string`:

```
  {id:'kioku_graph',    label:'KIOKU Graph',        jp:'記憶グラフ', icon:'memory'},
  {id:'kioku_patterns', label:'KIOKU Patterns',     jp:'常套',     icon:'clock'},
  {id:'integrations',   label:'Integrations',       jp:'連携', icon:'plug'},
```

- [ ] **Step 2: Add `PaneKiokuPatterns` function**

Locate the existing `function PaneKiokuGraph()` declaration (`hifi/settings-modal.jsx:2948`). Find a clean insertion point AFTER the `PaneKiokuGraph` function returns. The cleanest anchor is the line `function PaneKiokuGraph() {` — but the closing `}` of that function is far away. Instead use the `const PANES = {` block (line 3470) as the downward anchor: insert the new function BEFORE `const PANES = {`.

Use Edit. `old_string`:

```
const PANES = {
```

`new_string`:

```
function PaneKiokuPatterns() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useStateS([]);
  const [loaded, setLoaded] = useStateS(false);
  const [busyId, setBusyId] = useStateS(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await run('patterns.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run]);

  const invalidate = async (id) => {
    setBusyId(id);
    const prev = items;
    setItems(items.filter((p) => p.id !== id));
    const r = await run('patterns.invalidate', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      toast('Could not remove — try again.', 'error');
    }
  };

  return (
    <Pane title="KIOKU Patterns">
      <div className="t-sm" style={{color:'var(--text-mute)', marginBottom:'var(--space-4)'}}>
        Things SHOGUN noticed about your routine.
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)'}}>
        {!loaded ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>
            Nothing yet — patterns appear after a few days of usage.
          </div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            {items.map((p) => (
              <div key={p.id} style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'var(--space-3)'}}>
                <div className="t-sm" style={{color:'var(--text)'}}>• {p.label}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === p.id}
                  onClick={() => invalidate(p.id)}
                >これ違う</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

const PANES = {
```

- [ ] **Step 3: Register `PaneKiokuPatterns` in the `PANES` map**

Locate the existing `kioku_graph: PaneKiokuGraph,` line (`hifi/settings-modal.jsx:3476`, now shifted by the new function above). Use Edit. `old_string`:

```
  kioku_graph: PaneKiokuGraph,
};
```

`new_string`:

```
  kioku_graph: PaneKiokuGraph,
  kioku_patterns: PaneKiokuPatterns,
};
```

- [ ] **Step 4: Verify static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -3
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

Expected: both PASS.

- [ ] **Step 5: Manual smoke test**

The Tauri app should already be running. Refresh with Cmd+R, then:

1. Open Settings (gear icon or `,` shortcut).
2. Click `KIOKU Patterns` in the left sidebar.
3. Expect either the list of patterns OR the empty-state copy `Nothing yet — patterns appear after a few days of usage.` (depends on whether `patterns` table has active rows).
4. If list has items: click `これ違う` on one row → row disappears immediately.
5. Refresh app (Cmd+R) → re-open Settings → `KIOKU Patterns` → invalidated row stays gone.

If you can't drive the UI from this session, skip to Step 6 — the implementer's check is just compile + static. Final verification happens in Task 6.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/settings-modal.jsx
git diff --cached --stat
git commit -m "feat(kioku): KIOKU Patterns settings tab — list + invalidate"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 5: `PaneKiokuLessons` + nav entry

**Files:**
- Modify: `hifi/settings-modal.jsx` — add 1 SETTINGS_NAV row, add `PaneKiokuLessons` function, add 1 PANES entry

Same shape as Task 4, plus the stats header (two text lines from `lessons.stats`).

- [ ] **Step 1: Add the `kioku_lessons` nav row**

Locate the `kioku_patterns` row added in Task 4. Use Edit. `old_string`:

```
  {id:'kioku_patterns', label:'KIOKU Patterns',     jp:'常套',     icon:'clock'},
  {id:'integrations',   label:'Integrations',       jp:'連携', icon:'plug'},
```

`new_string`:

```
  {id:'kioku_patterns', label:'KIOKU Patterns',     jp:'常套',     icon:'clock'},
  {id:'kioku_lessons',  label:'KIOKU Lessons',      jp:'教訓',     icon:'graduation'},
  {id:'integrations',   label:'Integrations',       jp:'連携', icon:'plug'},
```

- [ ] **Step 2: Add `PaneKiokuLessons` function**

Insert immediately AFTER the `PaneKiokuPatterns` function (added in Task 4) and BEFORE the `const PANES = {` block. Use Edit. `old_string`:

```
const PANES = {
```

`new_string`:

```
function PaneKiokuLessons() {
  const { run, toast } = useRuntimeActions();
  const [items, setItems] = useStateS([]);
  const [stats, setStats] = useStateS({ total_active: 0, applied_total: 0 });
  const [statsLoaded, setStatsLoaded] = useStateS(false);
  const [loaded, setLoaded] = useStateS(false);
  const [busyId, setBusyId] = useStateS(null);

  const fetchStats = React.useCallback(async () => {
    const r = await run('lessons.stats', {}, { silentError: true });
    if (r.ok && r.data && typeof r.data === 'object') {
      setStats({
        total_active: Number(r.data.total_active || 0),
        applied_total: Number(r.data.applied_total || 0),
      });
    }
    setStatsLoaded(true);
  }, [run]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await fetchStats();
      if (cancelled) return;
      const r = await run('lessons.list', {}, { silentError: true });
      if (cancelled) return;
      if (r.ok && Array.isArray(r.data?.items)) setItems(r.data.items);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [run, fetchStats]);

  const archive = async (id) => {
    setBusyId(id);
    const prev = items;
    const prevStats = stats;
    setItems(items.filter((l) => l.id !== id));
    setStats({ ...stats, total_active: Math.max(0, stats.total_active - 1) });
    const r = await run('lessons.archive', { id }, { silentError: true });
    setBusyId(null);
    if (!r.ok) {
      setItems(prev);
      setStats(prevStats);
      toast('Could not remove — try again.', 'error');
    } else {
      // Re-sync stats (applied_total may have ticked, total_active is authoritative now)
      void fetchStats();
    }
  };

  return (
    <Pane title="KIOKU Lessons">
      <div className="t-sm" style={{color:'var(--text-mute)', marginBottom:'var(--space-4)'}}>
        Things SHOGUN learned from your feedback.
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginBottom:'var(--space-4)'}}>
        <div className="t-sm" style={{color:'var(--text)'}}>
          {statsLoaded ? `${stats.total_active} lessons learned` : '— lessons learned'}
        </div>
        <div className="t-sm" style={{color:'var(--text-mute)', marginTop:'var(--space-1)'}}>
          {statsLoaded ? `Applied ${stats.applied_total} times total` : 'Applied — times total'}
        </div>
      </div>
      <div className="card" style={{padding:'var(--space-4) var(--space-5)'}}>
        {!loaded ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>Loading…</div>
        ) : items.length === 0 ? (
          <div className="t-sm" style={{color:'var(--text-mute)'}}>
            No lessons yet — they grow as you give feedback.
          </div>
        ) : (
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
            {items.map((l) => (
              <div key={l.id} style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:'var(--space-3)'}}>
                <div className="t-sm" style={{color:'var(--text)'}}>• {l.rule}</div>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={busyId === l.id}
                  onClick={() => archive(l.id)}
                >忘れて</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Pane>
  );
}

const PANES = {
```

- [ ] **Step 3: Register `PaneKiokuLessons` in the `PANES` map**

Locate the `kioku_patterns: PaneKiokuPatterns,` line added in Task 4. Use Edit. `old_string`:

```
  kioku_patterns: PaneKiokuPatterns,
};
```

`new_string`:

```
  kioku_patterns: PaneKiokuPatterns,
  kioku_lessons: PaneKiokuLessons,
};
```

- [ ] **Step 4: Verify static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:ipc-mock 2>&1 | tail -3
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

Expected: both PASS.

- [ ] **Step 5: Manual smoke test**

Refresh app with Cmd+R, then:

1. Open Settings.
2. Click `KIOKU Lessons` in the left sidebar.
3. Expect the stats card with two lines (`X lessons learned` / `Applied Y times total`).
4. Below the stats: either lesson list OR empty-state copy.
5. If list has items: click `忘れて` on one row → row disappears immediately, `total_active` drops by 1.
6. Refresh app → re-open Settings → `KIOKU Lessons` → archived lesson stays gone.

If you can't drive the UI, defer to Task 6 verification.

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add hifi/settings-modal.jsx
git diff --cached --stat
git commit -m "feat(kioku): KIOKU Lessons settings tab — stats + list + archive"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 6: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All should PASS. Pre-existing warnings allowed.

- [ ] **Step 2: Spec § 8.2 manual walkthrough**

The Tauri app should already be running. Refresh with Cmd+R.

1. Open Settings → click `KIOKU Patterns` in left sidebar.
2. List loads (or empty-state copy if no patterns).
3. Click `これ違う` on any row → row disappears immediately.
4. Refresh app → re-open `KIOKU Patterns` → invalidated row stays gone.
5. Open Settings → click `KIOKU Lessons`.
6. Stats card shows `X lessons learned` and `Applied Y times total`.
7. List loads below.
8. Click `忘れて` on any row → row disappears, `total_active` drops by 1.
9. Refresh app → re-open `KIOKU Lessons` → archived row stays gone, stats are smaller.

- [ ] **Step 3: SQLite-level confirmation**

```bash
DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"
sqlite3 "$DB" "SELECT id, status FROM patterns WHERE status != 'active' LIMIT 5;"
sqlite3 "$DB" "SELECT id, status FROM lessons WHERE status != 'active' LIMIT 5;"
```

Expected: rows appear (status='stale' for patterns invalidated above, status='archived' for lessons archived).

- [ ] **Step 4: Empty-state synthetic test (optional)**

If you want to verify the empty-state copy without wiping production data:

```bash
DB="$HOME/Library/Application Support/ai.shogun.desktop/memory.db"
# Temporarily suppress all rows (do NOT run on real user data)
# sqlite3 "$DB" "UPDATE patterns SET status='_test_hidden' WHERE status='active';"
# sqlite3 "$DB" "UPDATE lessons SET status='_test_hidden' WHERE status='active';"
```

Refresh, confirm empty-state copy renders. Then restore:

```bash
# sqlite3 "$DB" "UPDATE patterns SET status='active' WHERE status='_test_hidden';"
# sqlite3 "$DB" "UPDATE lessons SET status='active' WHERE status='_test_hidden';"
```

Skip if you have no patterns/lessons to begin with — the empty state will render naturally.

- [ ] **Step 5: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*kioku.*settings|FIXME.*kioku.*settings" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits.

- [ ] **Step 6: No commit (verification only)**

If all steps pass, Sub-spec C is complete. Report DONE with the SHA range from Tasks 1-5 (`git log --oneline HEAD~5..HEAD`).

If any step fails, fix the underlying cause as a follow-up commit on the appropriate file.
