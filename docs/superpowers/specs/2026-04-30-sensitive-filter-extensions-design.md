# SHOGUN Phase 2.0a — Sensitive Filter Extensions Design

**Status:** draft (2026-04-30) — awaiting user review
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.2 (機密情報除外フィルタ)
**Related (later phases):**
- Phase 2.0b — `sync_status` schema column (separate spec)
- Phase 2.0c — emergency capture stop tray UI (separate spec)
- Phase 2.0d — Memory export/import (separate spec)

---

## 1. Goal

Extend the existing capture-time privacy filter to recognize three new exclusion signals **before** any cloud-sync feature ships:

1. **Payment screens** — credit-card entry URLs and a11y text containing card-number / CVV shapes
2. **Incognito / private browsing windows** — per-browser title detection
3. **Time-based blocklist** — user-configured "do not capture between HH:MM and HH:MM"

These are the missing detection signals listed in master spec § 2.2 (`payment_screen`, `incognito_window`, time-based blocklist) which today has only `password_field` (in `macos_ax.rs`) and `app_blocklist` / `url_blocklist` (in `capture_sampler.rs`).

## 2. Architecture

A new module `src-tauri/src/sensitive_filter.rs` owns three pure detector functions (`is_payment_signal`, `is_incognito_window`, `is_inside_time_block`) plus a typed `ExclusionReason` enum. Each detector takes already-normalized inputs (URL host, a11y text, frontmost app name + window title, current local time) and returns `Option<ExclusionReason>`.

`capture_sampler::start_background_sampler` calls into the new module after the existing `app_excluded` / `ax_text_excluded` checks, in a single `evaluate_capture(...)` helper that returns `CaptureDecision { should_ingest: bool, reason: Option<ExclusionReason> }`. When `should_ingest = false`, the loop `continue`s — same as today's app/host blocklist behavior.

**No sync_status column is added in 2.0a.** Master spec § 2.2 distinguishes "store locally but don't sync" from "don't store at all". 2.0a treats payment / incognito / time-block as **don't store at all** (matching current `app_blocklist` semantics) — partly because there is no cloud sync yet, and partly because users who want raw local recall can just disable the filter. The "store-but-don't-sync" distinction will be reintroduced in 2.0b alongside the schema column when there is something to sync to.

The new module emits rate-limited `log::info!` lines per fired reason (using the existing `should_trigger_now` helper from `capture_sampler.rs`) so the user can see "filter X dropped N captures in the last 2 minutes" in app logs without the count itself becoming a side channel.

## 3. Decisions Locked During Brainstorm

These need user confirmation before plan-writing. Defaults below are my recommendations.

| # | Decision | Recommended | Why |
|---|----------|-------------|-----|
| D1 | Payment-screen scope | **Drop the entire AX snapshot AND skip frontmost-app fallback** when payment signal fires (vs. only dropping AX, falling back to `Focus · <app>`) | A "Focus · Safari" memory created right while the user is paying still tells the AI "user was on a payment screen at time T" — better to skip both. |
| D2 | Card-number regex | **Match runs of 13–19 digits with optional space/hyphen separators**, must be flanked by non-digit boundaries. No Luhn check (false-positive risk on order numbers acceptable; the user can disable the heuristic per-domain via existing site blocklist) | Luhn validation adds Rust code + still misses unusual cards; bare regex is enough for the heuristic role. |
| D3 | Payment-domain default list | **stripe.com, paypal.com, pay.amazon.com, pay.google.com, checkout.shopify.com, buy.itunes.apple.com, applepay.apple.com, billing.stripe.com** (8 entries, all editable in Settings) | Curated, conservative, and easy to extend. User-editable. |
| D4 | Incognito detection signal | **Window-title pattern only** (no AXValue field probing, no separate AXWebArea attribute lookup) | Title prefix/suffix is stable across browser versions and avoids brittle private API dependencies. Misses are user-actionable via app blocklist. |
| D5 | Browsers covered initially | **Safari, Chrome, Arc, Firefox, Edge** (5) | These are the macOS browsers we have user evidence for. Brave/Opera get caught by the Chromium fallback. |
| D6 | Time-block schedule | **Per-row `{ id, label, startMinute, endMinute, days[7], enabled }`**, where minutes are 0–1439 in local time and `days` is `["sun","mon",…,"sat"]`. Cross-midnight ranges allowed (`startMinute > endMinute` means "wraps past midnight") | Avoids string parsing at filter time; days array is simpler than crontab; cross-midnight is the headline use case ("don't capture overnight"). |
| D7 | Time-block default rows | **Empty list** (off by default; user opts in) | This is the most sensitive feature for false-negatives ("why isn't capture working?") — never on by default. |
| D8 | What "fires" the filter | **AND of detectors per layer**: payment OR incognito OR time-block firing → skip. App-blocklist / host-blocklist precedence preserved (they short-circuit first, same as today) | Keeps existing behavior intact; adds new signals as additional gates. |
| D9 | Telemetry exposure | **Rate-limited app logs only**, no UI counter in 2.0a | Matches existing `maybe_log_*` pattern. UI counter belongs to 2.0b/c if surfaced. |

## 4. Module Layout

### 4.1 `src-tauri/src/sensitive_filter.rs` (new, ~280 LOC)

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExclusionReason {
  PasswordField,   // existing — for completeness; emitted by macos_ax (see § 4.2)
  AppBlocklist,    // existing
  UrlBlocklist,    // existing
  PaymentScreen,   // new — payment domain or card/CVV pattern
  IncognitoWindow, // new — Safari Private, Chrome Incognito, etc.
  TimeBlock,       // new — captured during a user-configured quiet window
}

pub struct PaymentRules {
  pub domains: Vec<String>,        // host-suffix patterns (lowercase, no scheme)
  pub detect_card_pattern: bool,   // toggle for the regex heuristic
}

pub struct IncognitoRules {
  pub safari: bool,
  pub chrome: bool,
  pub arc: bool,
  pub firefox: bool,
  pub edge: bool,
}

pub struct TimeBlock {
  pub start_minute: u16,  // 0..1440
  pub end_minute: u16,    // 0..1440
  pub days: u8,           // bitmask: sun=1, mon=2, tue=4, ... sat=64
  pub enabled: bool,
}

pub struct FilterConfig {
  pub payment: PaymentRules,
  pub incognito: IncognitoRules,
  pub time_blocks: Vec<TimeBlock>,
}

pub fn from_settings(doc: &Value) -> FilterConfig { /* parse sections.privacy.* */ }

// Detectors — all pure, all unit-testable.
pub fn is_payment_signal(rules: &PaymentRules, ax_text: &str) -> bool;
pub fn is_incognito_window(rules: &IncognitoRules, app_name: &str, window_title: &str) -> bool;
pub fn is_inside_time_block(blocks: &[TimeBlock], now_local_minute_of_week: u16) -> bool;

// Combined evaluator used by the sampler loop.
pub struct CaptureDecision {
  pub should_ingest: bool,
  pub reason: Option<ExclusionReason>,
}

pub fn evaluate_capture(
  filter: &FilterConfig,
  app_name: &str,
  window_title: &str,
  ax_text: &str,
  now_local_minute_of_week: u16,
) -> CaptureDecision;
```

### 4.2 Existing files modified

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/lib.rs` | `mod sensitive_filter;` | +1 |
| `src-tauri/src/capture_sampler.rs:439-470` | After `load_privacy_filters`, also load `sensitive_filter::from_settings`. After `app_excluded`/`ax_text_excluded` checks, call `sensitive_filter::evaluate_capture(...)`; on `should_ingest = false`, log via rate-limited helper and `continue` | +35 |
| `src-tauri/src/macos_ax.rs:36-39` | (no logic change) — add a public `pub const SECURE_FIELD_REASON: &str = "password_field";` so the symbol can be referenced by `sensitive_filter::ExclusionReason::PasswordField` for log strings | +1 |
| `hifi/settings-modal.jsx` `PanePrivacy` (line 830-1100) | Add three new collapsible sub-sections under existing app/site lists: "Payment screens", "Private browsing", "Quiet hours" (matches the existing `excludedApps`/`excludedSites` row-editor pattern) | +180 |

### 4.3 No-touch surfaces

- `mem_captures.rs`, `memory_store.rs` — no schema or write-path changes (no `sync_status` column in 2.0a)
- `kioku_capture.rs` — flag-gated capture path passes through the same sampler loop, so the new filter applies for free
- IPC commands — no new commands. Settings flow through existing `settings.save` (privacy section)

## 5. Settings schema additions

Extends `sections.privacy` (current keys: `excludedApps[]`, `excludedSites[]`, `allowChatServerMemoryAssembly`).

```json
{
  "sections": {
    "privacy": {
      "excludedApps": [ /* existing */ ],
      "excludedSites": [ /* existing */ ],
      "paymentScreens": {
        "enabled": true,
        "domains": [
          { "id": "pd-stripe",     "host": "stripe.com",            "label": "Stripe",            "enabled": true },
          { "id": "pd-paypal",     "host": "paypal.com",            "label": "PayPal",            "enabled": true },
          { "id": "pd-amazonpay",  "host": "pay.amazon.com",        "label": "Amazon Pay",        "enabled": true },
          { "id": "pd-googlepay",  "host": "pay.google.com",        "label": "Google Pay",        "enabled": true },
          { "id": "pd-shopify",    "host": "checkout.shopify.com",  "label": "Shopify Checkout",  "enabled": true },
          { "id": "pd-itunes",     "host": "buy.itunes.apple.com",  "label": "iTunes Store",      "enabled": true },
          { "id": "pd-applepay",   "host": "applepay.apple.com",    "label": "Apple Pay",         "enabled": true },
          { "id": "pd-billing",    "host": "billing.stripe.com",    "label": "Stripe Billing",    "enabled": true }
        ],
        "detectCardPattern": true
      },
      "incognito": {
        "enabled": true,
        "browsers": {
          "safari":  true,
          "chrome":  true,
          "arc":     true,
          "firefox": true,
          "edge":    true
        }
      },
      "timeBlocks": []
    }
  }
}
```

### Defaults applied at parse time

`from_settings` is **resilient to missing keys** (matches `filters_from_settings` style):
- Missing `paymentScreens` → enabled=true, default domain list as above, detectCardPattern=true
- Missing `paymentScreens.enabled` → true
- Missing `incognito` → enabled=true, all 5 browsers true
- Missing `timeBlocks` → empty list (off)
- Missing `enabled` on a time block row → defaults to true (same as `excludedApps` row convention)

This means existing user settings keep working unchanged — the new gates start active on upgrade with conservative defaults.

## 6. Detection details

### 6.1 Payment screen detection

Two independent signals; either fires `PaymentScreen`.

**(a) Domain match.** The existing `ax_text_excluded` already extracts URL hosts from a11y text via `url::Url::parse`. We reuse the same helper logic in `sensitive_filter` but match against the payment-domain list instead of the user's host blocklist. Suffix matching with the same hyphen-prefix and TLD-lookalike rejections (`host_suffix_match`).

**(b) Card-number / CVV pattern.** Pure regex on the AX text snapshot:

```
\b(?:\d[ -]?){13,19}\b      → card number candidate
\b(?:cvv|cvc|cid|security[ ]?code)\b   → CVV keyword (case-insensitive)
```

Either `(a)` OR (`(b1)` AND `(b2)` co-occur in the same snapshot) → `PaymentScreen`.

The "AND" for the regex pair keeps the false-positive rate down: a long order number on a confirmation page won't fire because there's no "CVV" nearby; a CVV label on an unrelated screen won't fire because there's no card-shaped digit run.

### 6.2 Incognito detection

Per-browser title patterns (case-insensitive, anchored or substring as noted):

| Browser (`app_name` match) | Window-title pattern |
|----------------------------|----------------------|
| Safari, Safari Technology Preview | starts with `Private — ` (em-dash) OR contains `Private Browsing` |
| Google Chrome, Chromium, Brave Browser, Opera, Vivaldi | contains `(Incognito)` OR contains `(Private)` |
| Arc | contains `Incognito` (Arc uses Chromium-style title) |
| Firefox, Firefox Developer Edition, Firefox Nightly | ends with `(Private Browsing)` OR contains `Private Browsing` |
| Microsoft Edge | contains `[InPrivate]` OR contains `InPrivate` |

App-name match is case-insensitive trim, identical to `app_excluded`. Browsers not in the table return false (not incognito).

If `frontmost_app_name` is one of the supported browsers but the title doesn't match, we **do not** assume incognito — we capture normally. Users who are paranoid can add the browser to `excludedApps`.

### 6.3 Time-block check

Convert each rule to a half-open `[start, end)` range in "minutes since Sunday 00:00 local". A range like Mon 22:00 → Tue 07:00 spans Sunday-week minutes `[1320 + 1440 = 2760, 1860 + 1440 = 3300)` — but practically we evaluate only the **current** minute against the rule's day bitmask + start/end:

```rust
pub fn is_inside_time_block(blocks: &[TimeBlock], now_local_minute_of_week: u16) -> bool {
  let day = now_local_minute_of_week / 1440;       // 0=Sun .. 6=Sat
  let minute = now_local_minute_of_week % 1440;    // 0..1439
  for block in blocks.iter().filter(|b| b.enabled) {
    if (block.days & (1 << day)) == 0 { continue; }
    if block.start_minute <= block.end_minute {
      // simple range — same day
      if minute >= block.start_minute && minute < block.end_minute { return true; }
    } else {
      // wraps midnight — also check that "yesterday" was selected
      let yesterday = (day + 6) % 7;
      let in_today_tail = minute >= block.start_minute;
      let in_yesterday_morning = minute < block.end_minute && (block.days & (1 << yesterday)) != 0;
      if in_today_tail || in_yesterday_morning { return true; }
    }
  }
  false
}
```

Local time is computed via `chrono::Local` (already a transitive dep in the workspace via tauri's `time` ecosystem). Caller passes the precomputed `minute_of_week` so the function stays pure & testable.

## 7. Settings UI extensions

Three new sections appended to `PanePrivacy` in `hifi/settings-modal.jsx`, each styled to match the existing "Excluded apps" / "Excluded sites" row editors:

1. **Payment screens** — top toggle (`paymentScreens.enabled`), then the editable domain list (same row component as `excludedSites`), then a sub-toggle "Also detect card-number patterns" (`detectCardPattern`).
2. **Private browsing** — top toggle (`incognito.enabled`), then 5 per-browser switches.
3. **Quiet hours** — top heading, then editable list of time-block rows. Each row: label text input + start/end time inputs (HTML `type="time"`) + day-of-week toggle pills + enabled switch. New "+ Add quiet block" button.

UI is purely a thin layer over the JSON shape in § 5. State management uses the existing `useStateS` / batched-save pattern (`runRuntimeAction('settings.save', { section: 'privacy', ... })`).

## 8. Test plan

### 8.1 Rust unit tests (in `sensitive_filter.rs`, mirror `capture_sampler.rs` test style)

| # | Test | Asserts |
|---|------|---------|
| T1 | `payment_domain_match_fires` | Stripe URL in AX text → `PaymentScreen` |
| T2 | `payment_domain_disabled_row_does_not_fire` | Disabled row in domain list ignored |
| T3 | `card_pattern_alone_does_not_fire` | 16-digit run without CVV keyword → no fire (kept conservative) |
| T4 | `card_pattern_with_cvv_keyword_fires` | 16-digit run + "CVV" in same snapshot → `PaymentScreen` |
| T5 | `card_pattern_disabled_globally_skips_regex` | `detectCardPattern=false` ignores even matching runs |
| T6 | `incognito_safari_em_dash_title_fires` | `app=Safari, title="Private — Apple"` → `IncognitoWindow` |
| T7 | `incognito_chrome_paren_title_fires` | `app=Google Chrome, title="X (Incognito)"` → `IncognitoWindow` |
| T8 | `incognito_firefox_suffix_fires` | `app=Firefox, title="X (Private Browsing)"` → `IncognitoWindow` |
| T9 | `incognito_unsupported_browser_returns_false` | `app=Brave Browser, title="(Incognito)"` → fires (Chromium fallback) |
| T10 | `incognito_browser_disabled_in_settings_does_not_fire` | `incognito.browsers.chrome=false` → returns false even with matching title |
| T11 | `time_block_simple_range_fires` | 10:00-11:00 Mon, now=Mon 10:30 → fires |
| T12 | `time_block_wrap_midnight_fires_in_tail` | 22:00-07:00 Mon-Fri, now=Tue 23:30 → fires (today's tail) |
| T13 | `time_block_wrap_midnight_fires_in_morning_when_yesterday_selected` | 22:00-07:00 Mon-Fri, now=Tue 02:00 → fires (yesterday=Mon enabled) |
| T14 | `time_block_wrap_midnight_does_not_fire_when_yesterday_unselected` | 22:00-07:00 Tue-Fri only, now=Tue 02:00 → does not fire |
| T15 | `time_block_disabled_rows_skipped` | Row with `enabled=false` ignored |
| T16 | `evaluate_capture_payment_short_circuits` | `evaluate_capture` returns `should_ingest=false, reason=PaymentScreen` and does not check time blocks |
| T17 | `evaluate_capture_pass_through` | All filters off → `should_ingest=true, reason=None` |
| T18 | `from_settings_missing_payment_block_uses_defaults` | Empty settings doc → 8 default domains, detectCardPattern=true, enabled=true |
| T19 | `from_settings_partial_overrides_merge` | User overrides one domain → user list used, defaults not silently re-added |
| T20 | `from_settings_invalid_time_block_skipped` | Row with `startMinute > 1439` discarded with a warn log |

### 8.2 Integration check (manual)

After implementation, walk:
1. Open Stripe checkout in Safari → verify nothing in `mem_items` for that window (check via debug pane or `kioku_debug_stats` IPC).
2. Open a Safari Private window with the same site → same expectation.
3. Set a time block 22:00-23:00 today → run sampler → no captures during that window.
4. Disable `paymentScreens.enabled` in Settings → re-test (1) → captures resume.

### 8.3 Verification

`npm run check:rust && cargo test -p shogun_ai_3 sensitive_filter` (no new lints, all unit tests pass).
Frontend: `python3 hifi/scripts/check-actions.py` (no new IPC actions, but verifies nothing broke).

## 9. Out of scope (explicitly deferred)

| Item | Defer to | Why |
|------|----------|-----|
| `sync_status` column on `mem_items` | Phase 2.0b | No cloud sync writer exists yet; column without writer is dead schema |
| "Store locally but don't sync" semantics | Phase 2.0b | Requires the schema column + sync engine to make sense |
| Emergency-stop tray menu item | Phase 2.0c | Independent UX surface; uses existing `sections.capture.paused` toggle |
| Memory export/import | Phase 2.0d | Independent data flow; touches `kioku_backup.rs` |
| UI counter for filter hits | Phase 2.0c or later | Rate-limited logs are sufficient for 2.0a — counter UI is its own design problem |
| Luhn validation on card numbers | None (deferred indefinitely) | Heuristic role does not require it; user can disable via global toggle if false-positives become noisy |
| Browser-extension-based incognito signal | None (deferred indefinitely) | Title heuristic is good enough; native API is brittle |
| Per-domain `should_sync vs should_store` granularity | Phase 2.1+ | Belongs to the sync UI, not the local filter |

## 10. Open questions for user

Before plan-writing, confirm:

- **Q1 (D1 / D8 in § 3):** Agree that payment / incognito / time-block all → "drop the capture entirely" in 2.0a (not "store locally but don't sync")? This punts the master spec § 2.2 distinction to 2.0b. **(this is the biggest architectural deviation from the master spec; everything else is mechanical)**
- **Q2 (D3):** Are the 8 default payment domains right? Add Square, Klarna, Stripe Identity?
- **Q3 (D5):** Anything missing from the 5-browser incognito list? (Vivaldi/Opera fall under Chromium fallback.)
- **Q4 (D7):** Any default time-block rows shipped on first install (e.g. 0:00-6:00 every day) — or strictly empty?
- **Q5 (§ 7):** Is the proposed Settings UI structure (3 collapsible sub-sections in PanePrivacy) acceptable, or should "Quiet hours" become its own top-level pane?

Once these are confirmed, the implementation plan can be written with no placeholders.
