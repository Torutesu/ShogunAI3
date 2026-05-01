# KIOKU Patterns MVP — Sub-spec B

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` (§ 2 Patterns + § 7 tasks 5-6)
**Sibling:** `docs/superpowers/specs/2026-04-27-kioku-lessons-mvp-design.md` (Sub-spec A — Lessons)

## Problem

The master KIOKU design proposes a Patterns layer to capture
"the user usually does X" — recurring shapes in their behavior so
the agent can anticipate next steps instead of inferring from
scratch every session. With Sub-spec A's Lessons loop in place
(rules from rejections), Patterns is the second half: positive
learning ("do this") to complement Lessons' negative learning
("don't do this").

This sub-spec ships the MVP: detect temporal and sequential
patterns from the existing `mem_captures` table on a daily
background batch, store them in a new `patterns` table, and
surface a "Your usual" section in the Morning Brief.

The Settings UI for browsing or invalidating patterns lives in
Sub-spec C; this one focuses solely on detection + Morning Brief
exposure.

## Goals

- A new `patterns` table in SQLite alongside `lessons`, `mem_items`,
  etc.
- Daily background batch (`spawn_background_patterns_sync`)
  scanning the last 14 days of `mem_captures` and UPSERTing
  active patterns. Wakes every 30 min, gates on 24h-elapsed.
- Two pattern kinds detected:
  - **temporal** — "user opens {app} around {hour}:00 on
    {day-of-week}" when ≥3 distinct days in the last 14 show the
    same (hour, dow, app) bucket.
  - **sequential** — "after {prev_app}, user switches to {app}
    within 30 min" when ≥3 distinct days show the transition AND
    that transition occurs in ≥30% of days the prev_app was used.
- Morning Brief surfaces top-4 active patterns (by confidence) in
  a new "YOUR USUAL" section. Frontend renders only when patterns
  exist; otherwise the section is invisible.
- Manual debug trigger via `shogun_patterns_run_now` IPC for
  Settings UI / Memory DBG hooks.

## Non-Goals

- The third pattern kind from master spec (`preference`). It needs
  feedback signal integration with Lessons and is heavier — explicit
  follow-up.
- Spatial patterns (master spec § 4 Phase 2). Single-display only
  in MVP.
- Embedding-based pattern similarity (`embedding` column exists but
  unused in MVP — kept for forward compatibility with master spec).
- Pattern-driven proactive suggestions ("Notion → Linear, want me
  to create the issue?"). MVP only renders the patterns; acting on
  them is its own design.
- LLM-generated pattern descriptions. The `label` field is built
  by deterministic Rust formatters using friendly app-name
  mappings. No LLM cost.
- Cross-day burst dedupe beyond "distinct days" counting. If the
  user opens Slack 50 times one Monday, that's still 1 day-count.
- Hard delete of stale patterns. They retain `status='stale'`
  forever in MVP; cleanup is a follow-up.
- Settings UI for browsing/invalidating. That's Sub-spec C.
- Translating `label` strings to Japanese. MVP is English-only;
  `lang="jp"` users see the same English labels.

## § 1. Schema

### 1.1 Table

Created in `kioku_graph_schema.rs::ensure_phase2_tables` alongside
the existing tables (and the `lessons` table from Sub-spec A):

```sql
CREATE TABLE IF NOT EXISTS patterns (
  id              TEXT PRIMARY KEY,           -- UUID v4
  kind            TEXT NOT NULL,              -- 'temporal' | 'sequential'
  trigger_json    TEXT NOT NULL,              -- JSON, see § 1.2
  action_json     TEXT NOT NULL,              -- JSON, see § 1.2
  outcome_json    TEXT,                       -- nullable; reserved for future
  confidence      REAL NOT NULL,              -- 0.0..1.0
  observed_n      INTEGER NOT NULL,           -- distinct days the pattern fired
  first_seen_at   INTEGER NOT NULL,           -- epoch ms of earliest contributing capture
  last_seen_at    INTEGER NOT NULL,           -- epoch ms of latest contributing capture
  embedding       BLOB,                       -- reserved; null in MVP
  embedding_dim   INTEGER,
  status          TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'stale'
);

CREATE INDEX IF NOT EXISTS idx_patterns_kind      ON patterns(kind);
CREATE INDEX IF NOT EXISTS idx_patterns_active    ON patterns(status);
CREATE INDEX IF NOT EXISTS idx_patterns_last_seen ON patterns(last_seen_at);
```

### 1.2 trigger_json / action_json shapes

Discriminated by `kind`:

```ts
// kind = 'temporal'
trigger_json: { hour: number /* 0..23 */, dow: number /* 0..6, 0=Sun */ }
action_json:  { app: string /* bundle id */, label: string /* friendly */ }

// kind = 'sequential'
trigger_json: { prev_app: string, prev_label: string }
action_json:  { app: string, label: string }
```

### 1.3 Identity / dedupe key

The table has no UNIQUE constraint; UPSERT is application-side:

- temporal identity: `(kind='temporal', trigger.hour, trigger.dow, action.app)`
- sequential identity: `(kind='sequential', trigger.prev_app, action.app)`

`run_detection` queries by these tuples before INSERTing; on hit,
it UPDATEs (`observed_n`, `last_seen_at`, `confidence`, status='active').

## § 2. Detection algorithms

### 2.1 Common data source

```rust
struct CaptureRow {
  id: i64,
  app_bundle_id: String,           // filtered NOT NULL
  window_title: Option<String>,    // unused in MVP
  captured_at: i64,                // epoch ms
}
```

Query:
```sql
SELECT id, app_bundle_id, window_title, captured_at
FROM mem_captures
WHERE captured_at >= ?  -- now - 14 days
  AND app_bundle_id IS NOT NULL
ORDER BY captured_at ASC
```

Uses local timezone for hour/dow derivation (chrono::Local).

### 2.2 Temporal detection

Bucket key: `(hour: u8, dow: u8, app: String)`.

```
buckets: HashMap<(u8, u8, String), HashSet<NaiveDate>>

for each capture in captures:
  let dt = chrono::Local.timestamp_millis(capture.captured_at);
  let hour = dt.hour() as u8;
  let dow = dt.weekday().num_days_from_sunday() as u8;
  let date_key = dt.date_naive();
  let app = capture.app_bundle_id;
  buckets.entry((hour, dow, app)).or_default().insert(date_key);

for ((hour, dow, app), days) in buckets:
  if days.len() >= 3:
    let observed_n = days.len() as i64;
    let confidence = (observed_n as f32 / 14.0).min(1.0);
    let label_app = friendly_app_name(&app);
    let label = format!(
      "You usually open {} around {:02}:00 {}.",
      label_app, hour, dow_label(dow),
    );
    upsert_pattern(NewPattern {
      kind: "temporal",
      trigger_json: json!({ "hour": hour, "dow": dow }),
      action_json:  json!({ "app": app, "label": label_app }),
      confidence,
      observed_n,
      first_seen_at: bucket_first_capture_ms,
      last_seen_at:  bucket_last_capture_ms,
    });
```

`dow_label` maps `0..6` to `"Sundays" / "Mondays" / ...`.

### 2.3 Sequential detection

**Step 1 — compress to app sessions:**
Walk captures in time order, collapse consecutive captures with the
same `app_bundle_id` into a single session `(app, t_start, t_end)`.

**Step 2 — count cross-app transitions:**
```
transitions: HashMap<(String, String), HashSet<NaiveDate>>
prev_app_days: HashMap<String, HashSet<NaiveDate>>

for each consecutive session pair (s_i, s_{i+1}):
  prev_app_days.entry(s_i.app).or_default().insert(date_only(s_i.end));
  let gap_ms = s_{i+1}.t_start - s_i.t_end;
  if gap_ms <= 30 * 60 * 1000 && s_i.app != s_{i+1}.app:
    let date_key = date_only(s_i.end);
    transitions.entry((s_i.app, s_{i+1}.app)).or_default().insert(date_key);
```

**Step 3 — emit patterns that pass both thresholds:**
```
for ((prev, curr), trans_days) in transitions:
  let prev_days = prev_app_days.get(prev).map_or(0, |s| s.len());
  if trans_days.len() >= 3 && prev_days >= 1 {
    let ratio = trans_days.len() as f32 / prev_days as f32;
    if ratio >= 0.30 {
      let observed_n = trans_days.len() as i64;
      let confidence = (observed_n as f32 / 14.0).min(1.0);
      let prev_label = friendly_app_name(prev);
      let curr_label = friendly_app_name(curr);
      let label = format!(
        "After {}, you often switch to {} within 30 min.",
        prev_label, curr_label
      );
      upsert_pattern(NewPattern {
        kind: "sequential",
        trigger_json: json!({ "prev_app": prev, "prev_label": prev_label }),
        action_json:  json!({ "app": curr, "label": curr_label }),
        confidence,
        observed_n,
        first_seen_at: bucket_first_ms,
        last_seen_at:  bucket_last_ms,
      });
    }
  }
```

The 30% ratio guard prevents incidental coincidences (e.g. user
flips to a browser between any two apps — that's noise, not a
pattern about the prev_app specifically).

### 2.4 Friendly app name mapping

Hardcoded HashMap in `patterns.rs`:

```rust
const FRIENDLY_APP_NAMES: &[(&str, &str)] = &[
  ("com.tinyspeck.slackmacgap", "Slack"),
  ("notion.id", "Notion"),
  ("co.linear.linear", "Linear"),
  ("com.google.Chrome", "Chrome"),
  ("company.thebrowser.Browser", "Arc"),
  ("com.googlecode.iterm2", "iTerm"),
  ("com.apple.Terminal", "Terminal"),
  ("com.apple.mail", "Mail"),
  ("com.apple.MobileSMS", "Messages"),
  ("com.apple.iCal", "Calendar"),
  ("com.apple.Safari", "Safari"),
  ("com.microsoft.VSCode", "VS Code"),
  ("com.figma.Desktop", "Figma"),
  ("com.spotify.client", "Spotify"),
  // … extend as needed
];

fn friendly_app_name(bundle: &str) -> String {
  for (k, v) in FRIENDLY_APP_NAMES {
    if *k == bundle { return v.to_string(); }
  }
  bundle.to_string()  // fallback: raw bundle id
}
```

Unmapped apps surface as their bundle ids — readable for debugging,
clearly opt-in to add a friendly name later.

### 2.5 Invalidation (status='stale')

After UPSERTing all currently-detected patterns, sweep the rest:

```sql
UPDATE patterns
SET status = 'stale'
WHERE status = 'active'
  AND last_seen_at < ?  -- now - 30d (60d if observed_n >= 10)
```

Implementation does this in two passes (one for the < 10 cohort with
30d cutoff, one for the >= 10 cohort with 60d cutoff). Hard delete
is out of scope for MVP.

### 2.6 Cost

- Zero LLM calls.
- DB scan: ~50k rows over 14 days × O(1) per row = ~50ms typical.
- Daily wake → ~50ms work + UPSERT/UPDATE statements.

## § 3. Scheduler

New file: `src-tauri/src/patterns_sync.rs` (~80 lines), modeled
after `rollup_sync.rs`.

### 3.1 `spawn_background_patterns_sync`

```rust
use std::sync::Mutex;

#[derive(Clone, Default)]
pub struct PatternsSyncState {
  pub last_run_ms: Option<i64>,
  pub last_error: Option<String>,
  pub last_emitted_count: usize,
}

static STATE: Mutex<PatternsSyncState> = Mutex::new(PatternsSyncState {
  last_run_ms: None, last_error: None, last_emitted_count: 0,
});

pub fn snapshot_state() -> PatternsSyncState {
  STATE.lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn spawn_background_patterns_sync() {
  tokio::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    loop {
      if patterns_enabled() && should_run() {
        match crate::patterns::run_detection().await {
          Ok(emitted) => {
            if let Ok(mut s) = STATE.lock() {
              s.last_run_ms = Some(crate::memory_store::now_ms() as i64);
              s.last_emitted_count = emitted;
              s.last_error = None;
            }
            crate::memory_obs::emit("patterns_sync_done", &[("emitted", emitted.to_string())]);
          }
          Err(e) => {
            log::warn!("patterns_sync failed: {}", e);
            if let Ok(mut s) = STATE.lock() {
              s.last_error = Some(e.clone());
            }
            crate::memory_obs::emit("patterns_sync_error", &[("error", e)]);
          }
        }
      }
      tokio::time::sleep(std::time::Duration::from_secs(30 * 60)).await;
    }
  });
}

fn should_run() -> bool {
  let last = STATE.lock().ok().and_then(|s| s.last_run_ms);
  match last {
    None => true,
    Some(t) => (crate::memory_store::now_ms() as i64 - t) >= 24 * 60 * 60 * 1000,
  }
}

fn patterns_enabled() -> bool {
  crate::settings_store::load()
    .ok()
    .and_then(|d| d.pointer("/sections/kioku_graph/patterns_enabled").and_then(|v| v.as_bool()))
    .unwrap_or(true)  // default ON
}
```

### 3.2 lib.rs wiring

In `setup()` block alongside the existing `spawn_background_*` calls:

```rust
patterns_sync::spawn_background_patterns_sync();
```

mod declarations:

```rust
mod patterns;
mod patterns_sync;
```

### 3.3 Manual trigger command

`commands.rs::shogun_patterns_run_now`:

```rust
#[tauri::command]
pub async fn shogun_patterns_run_now(_payload: serde_json::Value) -> Result<serde_json::Value, String> {
  let emitted = crate::patterns::run_detection().await?;
  Ok(serde_json::json!({ "emitted": emitted }))
}
```

Registered in `lib.rs` invoke_handler. Action key
`patterns.run_now` (used by Sub-spec C settings UI / Memory DBG).

## § 4. Morning Brief integration

### 4.1 `brief.rs` extension

`brief.rs::morning_brief_v2_stub` (and the production v2 builder
when wired) gains a `patterns` field:

```rust
pub fn morning_brief_v2_stub(...) -> Value {
  // ... existing fields ...
  let patterns_for_brief = crate::patterns::list_for_brief(4)
    .unwrap_or_default();
  // ... in the json! body, add:
  //   "patterns": patterns_for_brief,
}
```

`crate::patterns::list_for_brief(top_n: usize)` returns
`Vec<serde_json::Value>` of:

```json
{
  "kind": "temporal" | "sequential",
  "label": "You usually open Slack around 09:00 weekdays.",
  "trigger": { ... },
  "action": { ... },
  "confidence": 0.85,
  "observed_n": 12
}
```

ORDER BY `confidence DESC, observed_n DESC` over `status='active'`,
limit 4.

### 4.2 Frontend render (`hifi/screens-a.jsx`)

The existing Morning Brief render block (around line 555 — after
`setMorningBrief(inner.brief)`) already renders the brief. Add a
new section AFTER the existing items render, BEFORE any closing
container:

```jsx
{Array.isArray(morningBrief?.patterns) && morningBrief.patterns.length > 0 && (
  <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginTop:'var(--space-4)'}}>
    <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>
      YOUR USUAL
    </div>
    <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
      {morningBrief.patterns.slice(0, 4).map((p, i) => (
        <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
          • <span style={{color:'var(--text)'}}>{p.label}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

No interactivity (read-only display). Sub-spec C's Settings UI is
where invalidation/inspection lives.

## § 5. New Rust module — `src-tauri/src/patterns.rs`

Public API (~250 lines total):

```rust
pub struct NewPattern {
  pub kind: String,                         // 'temporal' | 'sequential'
  pub trigger_json: serde_json::Value,
  pub action_json: serde_json::Value,
  pub confidence: f32,
  pub observed_n: i64,
  pub first_seen_at: i64,
  pub last_seen_at: i64,
}

pub struct Pattern {
  pub id: String,
  pub kind: String,
  pub trigger_json: serde_json::Value,
  pub action_json: serde_json::Value,
  pub confidence: f32,
  pub observed_n: i64,
  pub first_seen_at: i64,
  pub last_seen_at: i64,
  pub status: String,
}

/// Top-level entry for the daily batch and the manual trigger.
/// Returns the count of patterns UPSERTed (active, not stale).
pub async fn run_detection() -> Result<usize, String>;

/// Used by Morning Brief.
pub fn list_for_brief(top_n: usize) -> Result<Vec<serde_json::Value>, String>;

/// Future use (Sub-spec C):
pub fn list_active(limit: usize) -> Result<Vec<Pattern>, String>;
pub fn invalidate(id: &str) -> Result<(), String>;
```

Internals:

- `friendly_app_name`, `dow_label`, `format_temporal_label`, `format_sequential_label`
- `upsert_temporal`, `upsert_sequential` (each does identity-key SELECT then INSERT or UPDATE)
- `mark_stale_pass` (the 30d/60d sweep)

`run_detection` orchestrates: open conn → fetch captures → run
temporal pass → run sequential pass → mark stale → return total
emitted count.

## § 6. Implementation surface

| File | Change | Approx LOC |
|------|--------|-----------|
| `src-tauri/src/patterns.rs` | NEW | ~250 |
| `src-tauri/src/patterns_sync.rs` | NEW | ~80 |
| `src-tauri/src/kioku_graph_schema.rs` | + patterns CREATE TABLE + indexes | ~15 |
| `src-tauri/src/lib.rs` | + 2 mod, + spawn call, + 1 invoke_handler entry | ~5 |
| `src-tauri/src/commands.rs` | + shogun_patterns_run_now | ~15 |
| `src-tauri/src/brief.rs` | + patterns field in v2 brief | ~30 |
| `hifi/lib/shogun-api.js` | + 1 method binding | ~1 |
| `hifi/lib/action-registry.js` | + 1 register call | ~1 |
| `hifi/action-map.md` | + 1 entry | ~1 |
| `hifi/screens-a.jsx` | + YOUR USUAL section render | ~15 |

Total ~410 lines / 10 files.

## § 7. Testing & verification

Static checks (no automated tests this round — manual eye-test only):

```bash
npm run check:rust
npm run check:ipc-mock
python3 hifi/scripts/check-actions.py
```

Manual eye-test:

1. Refresh Tauri app. Wait for `patterns_sync_done` log entry (or
   trigger manually via DevTools console → `executeAction('patterns.run_now')`
   if that helper is exposed).
2. Inspect the patterns table:
   ```bash
   sqlite3 ~/Library/Application\ Support/ai.shogun.desktop/memory.db \
     "SELECT kind, substr(action_json,1,80), confidence, observed_n FROM patterns WHERE status='active' ORDER BY confidence DESC LIMIT 10;"
   ```
   You should see 0+ rows depending on how much real `mem_captures`
   data exists. With <14 days of usage you may see nothing — that's
   expected. To force-seed: temporarily insert synthetic captures via
   a SQL script (see § 7.1 below).
3. Open Home (Morning Brief) → if patterns exist, the "YOUR USUAL"
   section appears below the brief items with up to 4 bullets in
   gold/text colors. If patterns is empty, the section is invisible.
4. Manually trigger via DevTools:
   ```js
   await window.SHOGUN_RUNTIME?.runAction?.('patterns.run_now', {})
   // → returns { ok: true, data: { emitted: N } }
   ```
   Then refresh Home.

### 7.1 Synthetic capture seed (for testing without real data)

Run from a SQL shell:

```sql
INSERT INTO mem_captures (type, app_bundle_id, captured_at, ttl_expires_at)
SELECT
  'app',
  'com.tinyspeck.slackmacgap',
  ((unixepoch() - (n*86400)) * 1000 + (9*3600*1000)),  -- 9:00 each of last n days
  (unixepoch() * 1000) + (90*86400*1000)
FROM (
  WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n<7)
  SELECT n FROM cnt
);
```

(Inserts 7 synthetic 9:00am Slack events on the past 7 weekdays.)

After seeding, run `patterns.run_now` → expect 1 temporal pattern
emitted ("You usually open Slack around 09:00 weekdays.").

## § 8. Rollout

Single change, no migration risks (patterns table is new, additive).
No flag at boot — `patterns_sync_done` event fires in the
observability ring buffer for sanity. The settings flag
`kioku_graph.patterns_enabled` defaults true; users can flip it off
via settings.json edit (Sub-spec C exposes a UI toggle).
