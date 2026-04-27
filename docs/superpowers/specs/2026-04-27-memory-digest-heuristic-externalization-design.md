# Memory Digest Phase 4-b — Heuristic Pre-Filter Externalization Design

**Status:** Draft
**Date:** 2026-04-27
**Spec parent:** `docs/superpowers/specs/2026-04-24-memory-digest-design.md` (line 236 — "heuristic_patterns.toml に外出しして ship 後も改修容易にする"; § Open Questions: heuristic externalization)
**Related:** `docs/superpowers/specs/2026-04-26-memory-digest-summary-edit-design.md` (PR #19, ships `user_edits[]`)

## Problem

The Memory Digest pre-filter heuristics that classify items as `low` before
calling the LLM live as hardcoded Rust functions in
`src-tauri/src/summarizer.rs`:

- `gmail_heuristic` — sender substring matches (`no-reply@`, `noreply@`,
  `donotreply@`, GitHub `noreply@github.com`, GitHub `notifications@github.com`,
  `builds@`, `ci@`, `actions@github.com`) plus a body match for `unsubscribe`
  / `配信停止`.
- `calendar_heuristic` — calendar events whose start is more than 24 hours in
  the past.

Adding or refining a sender pattern requires a code change, a release, and a
user upgrade. Per-user customization is impossible — every user gets the
same filter.

We move the sender-substring rules into a per-user TOML file shipped with a
default. Users can edit the file directly; restart applies changes. Body
matches and time-based rules stay hardcoded (they're not naturally
expressible as substring patterns and don't need user customization).

We also expose a hidden developer-only "Edit Insights" screen that
aggregates the `user_edits[]` data added by PR #19 into per-sender LOW-edit
counts, so we can see which senders users keep manually downgrading and
inform future rule additions. No automatic TOML modification.

## Goals

- Sender-substring heuristic rules editable by users without recompiling.
- Default rules shipped with the binary, copied on first launch.
- Same runtime behavior as today for users who don't touch the file.
- A debug-only screen surfaces aggregated `user_edits[]` data so we can
  observe which senders users override.
- No new feature flag, no DB migration, no behavior change at the
  `mem_summaries` level.

## Non-Goals

- **Body-match externalization** (e.g., `unsubscribe`). Body matches stay
  hardcoded; the choice was made because (a) the existing list is small,
  (b) substring-on-body is more error-prone for users to author, and (c)
  TOML schema stays simpler.
- **Time-based rule externalization** (`calendar_heuristic` past-event).
  Stays hardcoded — not a substring pattern.
- **Regex / boolean / weighted matching.** Out of scope; would complicate
  the TOML schema and is not justified by current pain points.
- **Automatic TOML modification from user_edits[].** This phase is
  observation only. The Insights screen surfaces aggregated edits; users
  must add patterns to the TOML manually.
- **Hot reload of TOML changes.** Restart-only.
- **Per-source rule expansion to `chat`/`work`/`note`/`meetings`.** Only
  `gmail` is moved into TOML. The other sources had no heuristics before,
  so this phase introduces nothing new for them.
- **Settings UI for editing the TOML inside the app.** File-system editing
  via the user's preferred text editor.

## § 1. Architecture & Data Flow

### File layout

| File | Purpose |
|---|---|
| `src-tauri/resources/heuristic_patterns.default.toml` | Bundled default. Existing hardcoded sender rules expressed in TOML. Added to `tauri.conf.json` `bundle.resources`. |
| `<app data>/heuristic_patterns.toml` | User's editable copy. Created from default on first launch. |
| `src-tauri/src/heuristics_config.rs` (new) | TOML parser + struct definitions + `OnceCell`-cached config + `init` / `get` API. |
| `src-tauri/src/summarizer.rs` (modify) | `gmail_heuristic` reads sender rules from `heuristics_config::get()`. Body match (`unsubscribe`) and `calendar_heuristic` unchanged. |
| `src-tauri/src/lib.rs` (modify) | In `tauri::Builder::setup`, call `heuristics_config::init(&app.handle())`. |
| `src-tauri/src/commands.rs` (modify) | Add `shogun_memory_summary_edit_insights` command. |
| `src-tauri/src/summarizer_store.rs` (modify) | Add `aggregate_user_edits()` helper that walks `mem_summaries` rows and aggregates `raw_json.user_edits[]`. |
| `src-tauri/src/lib.rs` (modify) | Register the new command in `tauri::generate_handler!`. |
| `hifi/lib/shogun-api.js` + `action-registry.js` + `app.jsx` + `ipc-client.js` | Wire `memory.summary.edit_insights` action. |
| `hifi/screens-?.jsx` (likely `screens-b.jsx` or new `screens-debug.jsx`) | Insights debug screen. Reachable only via `setActiveScreen('insights-debug')` (no sidebar/cmdk entry). |

### Startup flow

1. `tauri::Builder::default().setup(|app| { ... })` runs once on app boot.
2. Inside `setup`, call `heuristics_config::init(&app.handle())`:
   - Resolve `<app data>/heuristic_patterns.toml`.
   - If absent, copy the bundled `resources/heuristic_patterns.default.toml`
     into place (`create_dir_all` first if needed).
   - Read the TOML file as a string.
   - `toml::from_str::<HeuristicConfig>` to parse.
   - Validate `schema_version`, drop invalid rules, log issues.
   - Store the parsed config in a `OnceCell<HeuristicConfig>`.
3. If anything fails (file missing, parse error, schema mismatch), log a
   warning and store an empty `HeuristicConfig`. The app continues
   functioning — every gmail item just goes to the LLM (no pre-filter,
   correct fallback, costs more tokens).

### Runtime flow (per item)

`summarizer::summarize_item` → `heuristic_priority_guess` → `gmail_heuristic`:

1. Body check: `unsubscribe` / `配信停止` (built-in, unchanged).
2. Sender check: iterate `heuristics_config::get().gmail.sender_contains`
   in array order; for each rule with valid `priority` and non-empty
   `pattern`, check whether the item's `From:` line (lowercased) contains
   `pattern.to_lowercase()`. First hit wins.
3. No hit → `None` → LLM is called as today.

### Insights data flow

- `aggregate_user_edits()` (Rust): single SQL `SELECT raw_json FROM
  mem_summaries`, parse each `raw_json.user_edits[]`, group by
  `(source_raw, entity_id)`, count edits per group with the field types
  edited. Returns a JSON-friendly tree.
- `shogun_memory_summary_edit_insights` IPC wraps it.
- Insights screen calls `runRuntimeActionA('memory.summary.edit_insights',
  {})` on mount and on Reload-button click; renders the table.

## § 2. TOML Schema

### `heuristic_patterns.default.toml`

```toml
# Memory Digest heuristic pre-filter rules.
# Edited copy lives at <app data>/heuristic_patterns.toml.
# Restart the app to apply changes.
#
# Each rule matches an item BEFORE LLM summarization. A hit sets the item's
# priority and skips the LLM call (cost saving). Sender substring matches
# are case-insensitive against the "From:" line in the message snippet.
#
# Built-in rules NOT representable here (still hardcoded in summarizer.rs):
#   - body contains "unsubscribe" / "配信停止" → low (gmail)
#   - calendar event whose start is >24h in the past → low

schema_version = 1

[[gmail.sender_contains]]
pattern = "no-reply@"
priority = "low"
reason = "Automated notification"
reason_jp = "自動通知"

[[gmail.sender_contains]]
pattern = "noreply@"
priority = "low"
reason = "Automated notification"
reason_jp = "自動通知"

[[gmail.sender_contains]]
pattern = "donotreply@"
priority = "low"
reason = "Automated notification"
reason_jp = "自動通知"

[[gmail.sender_contains]]
pattern = "noreply@github.com"
priority = "low"
reason = "GitHub notification"
reason_jp = "GitHub 通知"

[[gmail.sender_contains]]
pattern = "notifications@github.com"
priority = "low"
reason = "GitHub notification"
reason_jp = "GitHub 通知"

[[gmail.sender_contains]]
pattern = "builds@"
priority = "low"
reason = "CI build"
reason_jp = "CI ビルド"

[[gmail.sender_contains]]
pattern = "ci@"
priority = "low"
reason = "CI build"
reason_jp = "CI ビルド"

[[gmail.sender_contains]]
pattern = "actions@github.com"
priority = "low"
reason = "GitHub Actions"
reason_jp = "GitHub Actions"
```

### Rust types

```rust
#[derive(Debug, Clone, Deserialize, Default)]
pub struct HeuristicConfig {
  #[serde(default = "default_schema_version")]
  pub schema_version: u32,
  #[serde(default)]
  pub gmail: GmailRules,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GmailRules {
  #[serde(default)]
  pub sender_contains: Vec<SenderRule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SenderRule {
  pub pattern: String,
  pub priority: String,    // "high" | "medium" | "low" — validated at use site
  pub reason: String,
  #[serde(default)]
  pub reason_jp: Option<String>,
}

fn default_schema_version() -> u32 { 1 }
```

### Validation rules

- `schema_version != 1` → log warning, drop the entire config (return empty).
  Forward-compat: a future binary that knows schema_version=2 can read
  schema_version=1 by mapping fields; this binary refuses unknown versions
  to avoid misinterpreting newer fields.
- `priority` not in `{"high", "medium", "low"}` → drop just that one rule
  with a warning, keep the rest.
- `pattern` empty or whitespace-only → drop just that rule.
- `reason` is required (no default); a missing `reason` is a hard parse
  error from `serde`.
- `reason_jp` optional. If missing and language is `jp`, fall back to `reason`.

## § 3. Rust Implementation

### `heuristics_config.rs` (~100 lines)

Public API:

```rust
/// Load the user TOML (or copy the bundled default if missing) and cache
/// it in a static OnceCell. Idempotent — calling twice is a no-op. On any
/// failure, an empty config is cached so the app continues to function.
pub fn init(app: &tauri::AppHandle) -> Result<(), String>;

/// Return a reference to the cached config. Before init or on init failure,
/// returns &EMPTY_CONFIG.
pub fn get() -> &'static HeuristicConfig;

/// Test-only: replace the cached config (uses a Mutex internally for
/// safety in the test harness).
#[cfg(test)]
pub fn set_for_test(c: HeuristicConfig);
```

Internals:

- `static CONFIG: OnceCell<HeuristicConfig> = OnceCell::new();`
- `static EMPTY: HeuristicConfig = HeuristicConfig { schema_version: 1, gmail: GmailRules { sender_contains: Vec::new() } };` (built lazily via `Lazy` since `Vec::new()` isn't const).
- `init` resolves the user-data path via `app.path().app_data_dir()`, ensures
  the directory exists, copies from `resources/heuristic_patterns.default.toml`
  (resolved via `app.path().resolve("resources/heuristic_patterns.default.toml", BaseDirectory::Resource)`)
  if the user file doesn't exist, then `fs::read_to_string` + `toml::from_str`.
- Validation step strips invalid rules in place (empty pattern, bad priority).

### `summarizer.rs::gmail_heuristic` rewrite

```rust
fn gmail_heuristic(title: &str, snippet: &str, lang: &str) -> Option<PriorityGuess> {
  let lower_body = snippet.to_lowercase();

  // Built-in: body match (not representable in TOML by design).
  if lower_body.contains("unsubscribe") || lower_body.contains("配信停止") {
    return Some(PriorityGuess {
      priority: "low".into(),
      reason: loc(lang, "Automated notification", "自動通知"),
      title_hint: title_first_line(title, 60),
    });
  }

  // Config-driven: sender substring rules.
  let from_line_lower = snippet
    .lines()
    .find(|l| l.starts_with("From:"))
    .map(|l| l.to_lowercase())
    .unwrap_or_default();

  if from_line_lower.is_empty() {
    return None;
  }

  let cfg = crate::heuristics_config::get();
  for rule in &cfg.gmail.sender_contains {
    if rule.pattern.trim().is_empty() { continue; }
    if !matches!(rule.priority.as_str(), "high" | "medium" | "low") { continue; }
    if from_line_lower.contains(&rule.pattern.to_lowercase()) {
      let reason = if lang == "jp" {
        rule.reason_jp.clone().unwrap_or_else(|| rule.reason.clone())
      } else {
        rule.reason.clone()
      };
      return Some(PriorityGuess {
        priority: rule.priority.clone(),
        reason,
        title_hint: title_first_line(title, 60),
      });
    }
  }
  None
}
```

### `lib.rs` startup hook

Inside the existing `tauri::Builder::default().setup(|app| { ... })`:

```rust
if let Err(e) = crate::heuristics_config::init(&app.handle()) {
  log::warn!("heuristics config init failed: {}", e);
}
```

### `tauri.conf.json` update

Add `"resources/heuristic_patterns.default.toml"` to `bundle.resources`.

### `summarizer_store::aggregate_user_edits` (~60 lines)

```rust
#[derive(Debug, Clone, Serialize)]
pub struct EditInsights {
  pub by_source: HashMap<String, SourceInsights>, // source_raw -> ...
  pub total_edits: u64,
  pub total_user_priority_changes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SourceInsights {
  pub senders: Vec<SenderInsight>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SenderInsight {
  pub entity_id: Option<String>, // None when not captured
  pub count: u64,
  pub fields: HashMap<String, u64>, // "title" -> 8, "keyPoints" -> 4, etc.
}

pub fn aggregate_user_edits() -> Result<EditInsights, String>;
```

The function does a single `SELECT raw_json, user_priority FROM mem_summaries`,
parses each row's `raw_json.user_edits[]`, and accumulates counts. Sorts the
`senders` vec by `count` descending in the response.

### `commands.rs` IPC wrapper

```rust
#[tauri::command]
pub fn shogun_memory_summary_edit_insights(
  _payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
  let insights = crate::summarizer_store::aggregate_user_edits()?;
  Ok(serde_json::to_value(&insights).map_err(|e| e.to_string())?)
}
```

Register in `lib.rs::tauri::generate_handler!` next to the existing summary
commands.

## § 4. Frontend Insights Screen

### Reachability

- `setActiveScreen('insights-debug')` from a debug context (browser console
  in Hi-Fi preview, or `window.SHOGUN_RUNTIME?.setActiveScreen?.(...)` in
  the Tauri console).
- Optional: a `hashchange` listener on `#insights-debug` could trigger the
  switch automatically. Out of scope unless trivial.
- No sidebar entry, no command-palette entry, no keyboard shortcut.

### Layout

```
+-------------------------------------------------------+
| Memory · Edit Insights (debug)               [Reload] |
+-------------------------------------------------------+
| Total edits: 42 · Total userPriority changes: 18      |
+-------------------------------------------------------+
| By source:                                            |
|                                                       |
|   gmail                                               |
|     notifications@github.com  12 edits  title (8),    |
|                                          keyPoints (4)|
|     ci-bot@example.com         3 edits  title (3)     |
|     (no entity_id)             1 edit   reason (1)    |
|                                                       |
|   meetings                                            |
|     meeting:abc123             5 edits  title (5)     |
|                                                       |
+-------------------------------------------------------+
| Hint: To suppress an aggressive sender, add to your   |
|       TOML: open <app data>/heuristic_patterns.toml   |
|       and add:                                        |
|                                                       |
|   [[gmail.sender_contains]]                           |
|   pattern = "notifications@github.com"                |
|   priority = "low"                                    |
|   reason = "Frequently downgraded by user"            |
|                                                       |
| [Show raw aggregation JSON ▾]                          |
+-------------------------------------------------------+
```

The hint targets the most-edited sender for each source.

### IPC wiring

- `hifi/lib/shogun-api.js` — `memorySummaryEditInsights: (input) => call("shogun_memory_summary_edit_insights", input, READ)`
- `hifi/lib/action-registry.js` — `register("memory.summary.edit_insights", ...)`
- `hifi/app.jsx` — runtime API export + action map entry + mockIpcInvoke stub
- `hifi/lib/ipc-client.js` — mock that returns a small dummy aggregation

### React component

A new function component (location: `hifi/screens-b.jsx` or a new `hifi/screens-debug.jsx`; the executor decides). State: `useState(null)` for the data, `useState(false)` for loading. Effect on mount fetches via `runRuntimeActionA('memory.summary.edit_insights', {})`. No persistence, no caching.

### Screen registration

Add `'insights-debug'` to whatever enum/switch in `app.jsx` decides which screen to render. Sidebar selection handlers should NOT highlight any sidebar item when this screen is active.

## § 5. Edge Cases

| Scenario | Behavior |
|---|---|
| Bundled default TOML has a parse error (release-time bug) | `init` fails, empty config cached, all gmail items go to LLM. App continues. Log warning. |
| User TOML has a syntax error (manual-edit typo) | Parse fails. Empty config cached. Toast at startup: "heuristic_patterns.toml syntax error". Log full error. Persists across restarts until the user fixes the file. |
| User TOML missing (manually deleted) | `init` re-copies the bundled default. User customizations lost — this is acceptable; no protection mechanism. |
| `priority` set to an unknown value (e.g., `"urgent"`) | That single rule is dropped at validation; other rules still active. Log warning naming the offending rule's `pattern`. |
| `pattern` empty or whitespace-only | Rule dropped silently. |
| Multiple rules match the same sender | Array-order evaluation; first match wins. Documented in the TOML header comment. |
| `schema_version` ≠ 1 | Empty config + log warning. Forward-compat. |
| `app_data` directory doesn't exist on first run | `init` calls `create_dir_all`. |
| Bundled default not in `bundle.resources` (build misconfig) | Resource resolve returns None → empty config → log warning. App continues but with no pre-filter. |
| `mem_summaries` empty (new user) → Insights screen | Render "No edits yet" placeholder. |
| Very large `mem_summaries` (5000+ rows) → aggregate | Scan + parse all rows in-memory; ~100ms per 1000 rows expected. If this becomes a real perf problem, add SQL-side aggregation (defer per YAGNI). |
| `unsubscribe` body match interaction | gmail_heuristic evaluates the body match BEFORE the config rules. Built-in fires first. |
| Calendar past-event interaction | `calendar_heuristic` is a separate function and never reads the config. Behavior unchanged. |
| Item from a non-gmail source (`chat`, `work`, `note`, `meetings`) | Config has no sections for those; `heuristic_priority_guess` dispatch returns `None` for them as before. |
| Pattern matches but `From:` line missing | gmail_heuristic returns early before the loop (`from_line_lower.is_empty() → None`). LLM is called. |
| Insights aggregation includes screen captures (provenance=screen) | Should they appear? Per Phase 4 cluster decision, screen captures are excluded from edit/summary flow. Their `user_edits[]` would be empty, so they naturally don't appear in the aggregation. |

## § 6. Testing

### Rust unit tests (`heuristics_config.rs`)

- Fully populated TOML parses into the expected structs.
- `schema_version != 1` → empty config returned.
- Invalid `priority` → just that rule dropped.
- Empty `pattern` → just that rule dropped.
- `reason_jp` is optional; struct field is `None` when absent.
- Bare-syntax-error TOML → `Err(_)`.
- `init` is idempotent (call twice, second is no-op).

### Rust unit tests (`summarizer.rs::gmail_heuristic`)

- With `set_for_test` to inject a specific config:
  - Rule matches → `PriorityGuess` with the expected `priority` + `reason`.
  - Case insensitivity: `From: NoReply@Foo.com` matches `noreply@`.
  - Multiple matching rules → first one in array order wins.
  - No `From:` line in snippet → returns `None` regardless of config.
  - Empty config → returns `None` for non-`unsubscribe` items.
  - Body has `unsubscribe` → returns `low` regardless of config (built-in
    fires before config loop).

### Rust integration tests (DB roundtrip, `#[ignore]`)

- `aggregate_user_edits()`:
  - Empty `mem_summaries` → empty result.
  - Multiple rows with `user_edits[]` → aggregated counts match expectations.
  - Rows with no `user_edits` → not contributing to counts.
  - Rows with malformed `raw_json` → silently skipped.

### Frontend Playwright (new: `tests/e2e/memory-edit-insights.spec.js`)

- Navigate via `setActiveScreen('insights-debug')` → screen renders.
- Mock IPC returns dummy aggregation → table visible with expected entries.
- Reload button click → IPC re-fetched.
- May be `test.fixme`'d if the same async-summarize race blocks the test (cluster precedent).

### Mock IPC

- `hifi/lib/ipc-client.js` mock for `shogun_memory_summary_edit_insights`:
  returns a small fixed-shape stub, e.g., `{ bySource: { gmail: { senders: [{ entityId: 'noreply@example.com', count: 3, fields: { title: 3 } }] } }, totalEdits: 3, totalUserPriorityChanges: 1 }`.

### Static checks

- `npm run check:actions` — confirms `memory.summary.edit_insights` is in the action registry.
- `npm run check:ipc-mock` — confirms mock matches the action map.

### Manual smoke

- `npm run dev:desktop`
- Edit `<app data>/heuristic_patterns.toml`, add a new sender pattern (e.g., a personal `@spammy-newsletter.com` substring with `priority = "low"`).
- Restart the app.
- Trigger a Gmail sync (or use mocked items in dev) — confirm matching items render with the new reason and `priority = "low"` in the river.
- In the dev console, run `window.SHOGUN_RUNTIME?.setActiveScreen?.('insights-debug')` — confirm the Insights screen renders.

## § 7. Rollout

No feature flag. No DB migration. The bundled default TOML is added to `bundle.resources` and copied on first launch — equivalent behavior to today (same patterns evaluated, just routed through the loader). Existing users get the new TOML the first time they open the app after this ships; no upgrade prompt needed.

## Open Questions / Future Work

- **Hot reload**: a `Reload heuristics` button in Settings (calling a dedicated IPC that re-runs `heuristics_config::init` with `set` instead of `set_or_init`) would skip the restart. Defer until users complain.
- **Schema v2** with body-match support, regex, or rule weights: defer until pain points emerge. Schema versioning is in place to make this possible.
- **Auto-suggest rule additions** from the Insights screen: when a sender has ≥N user-LOW edits, show an "Add to TOML" button that copies the TOML snippet to clipboard. Considered but out of scope for this phase.
- **Settings UI for editing the TOML**: an in-app editor with syntax validation. Defer; file-system editing is fine for power users.
- **Per-source rule expansion**: add `chat`, `work`, `note`, `meetings` sections in TOML when patterns become apparent from the Insights data.

## Success Criteria

1. Existing heuristic behavior is preserved — the same items get
   pre-filtered as today (verified by manual smoke or by the Rust unit
   tests with `set_for_test` + the bundled default's contents).
2. A user can add a new sender pattern by editing their TOML and
   restarting. The new pattern fires on matching items.
3. Invalid TOML doesn't crash the app — empty-config fallback keeps things
   working.
4. The Insights screen aggregates `user_edits[]` correctly and is
   reachable only from the dev console (not from the sidebar/cmdk).
5. Zero new IPC failures in `check:actions` / `check:ipc-mock`.
