# SHOGUN Phase 2.0a — Sensitive Filter Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three new capture-time exclusion signals — payment screens, incognito browser windows, and user-configured quiet-hour blocks — to the existing privacy filter, with no schema changes.

**Architecture:** A new `src-tauri/src/sensitive_filter.rs` module owns three pure detector functions (`is_payment_signal`, `is_incognito_window`, `is_inside_time_block`) plus a typed `ExclusionReason` enum and a combined `evaluate_capture` helper. `capture_sampler.rs` calls the new evaluator after the existing app/host blocklist checks; on a filter hit the loop `continue`s (same as today's `app_excluded` behavior). Settings UI gains three new cards inside `PanePrivacy` for the new rules.

**Tech Stack:** Rust (`regex` 1.x, `chrono::Local` via existing `clock` feature, `serde_json::Value`), React 19 (existing `useStateS` + `useRuntimeActions` patterns, `Toggle`, `Row`, `Pane`).

**Spec:** `docs/superpowers/specs/2026-04-30-sensitive-filter-extensions-design.md`

**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.2

---

## File Map

**Created:**
- `src-tauri/src/sensitive_filter.rs` (~280 LOC) — `ExclusionReason`, `PaymentRules`, `IncognitoRules`, `TimeBlock`, `FilterConfig`, `from_settings`, `is_payment_signal`, `is_incognito_window`, `is_inside_time_block`, `evaluate_capture`, `extract_window_title`, plus 20 unit tests (T1-T20).

**Modified:**
- `src-tauri/Cargo.toml` — add `regex = "1"` to `[dependencies]` (+1 LOC).
- `src-tauri/src/lib.rs` — `mod sensitive_filter;` declaration (+1 LOC).
- `src-tauri/src/capture_sampler.rs` — load `FilterConfig`, compute current minute-of-week, call `evaluate_capture` after existing blocklist checks, rate-limited drop log (~40 LOC across two helpers + sampler loop body).
- `hifi/settings-modal.jsx` — extend `PanePrivacy` with three new cards (Payment / Incognito / Quiet hours), extend `normalizePrivacyFromSettings` and `persistPrivacy` to round-trip the new keys (~220 LOC across helpers + JSX).

**No changes:**
- `src-tauri/src/memory_store.rs` — no schema changes (sync_status column deferred to Phase 2.0b).
- `src-tauri/src/mem_captures.rs`, `src-tauri/src/kioku_capture.rs` — captures route through the same sampler loop, so the new filter applies for free.
- IPC commands / runtime actions — none added; settings persist through existing `settings.save` with `section: 'privacy'`.

**Verification gates** (run after Task 11): `npm run check:rust` + `cargo test -p app` + `python3 hifi/scripts/check-actions.py` + manual smoke per spec § 8.2.

---

## Task 1: Add `regex` dependency, create `sensitive_filter.rs` skeleton, register module

**Files:**
- Modify: `src-tauri/Cargo.toml` (after line ~21, in `[dependencies]`)
- Create: `src-tauri/src/sensitive_filter.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod sensitive_filter;` near other `mod` declarations)

This task gives us a compiling skeleton: empty module with type definitions and stub function signatures returning `unimplemented!()`. Subsequent tasks fill in the bodies test-first.

- [ ] **Step 1: Add `regex` to `[dependencies]`**

Open `src-tauri/Cargo.toml`. Locate the `chrono = { version = "0.4", ... }` line (currently around line 24). Add `regex = "1"` immediately after it. Exact Edit:

`old_string`:
```
chrono = { version = "0.4", default-features = false, features = ["clock"] }
log = "0.4"
```

`new_string`:
```
chrono = { version = "0.4", default-features = false, features = ["clock"] }
regex = "1"
log = "0.4"
```

- [ ] **Step 2: Create the module file with type definitions and stub fns**

Create `src-tauri/src/sensitive_filter.rs` with this exact content:

```rust
//! Capture-time sensitive content detector. Pure — every detector is
//! testable on any platform. Wired into `capture_sampler` after the existing
//! app / host blocklist checks. See
//! `docs/superpowers/specs/2026-04-30-sensitive-filter-extensions-design.md`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExclusionReason {
  PasswordField,
  AppBlocklist,
  UrlBlocklist,
  PaymentScreen,
  IncognitoWindow,
  TimeBlock,
}

impl ExclusionReason {
  pub fn as_log_str(self) -> &'static str {
    match self {
      ExclusionReason::PasswordField => "password_field",
      ExclusionReason::AppBlocklist => "app_blocklist",
      ExclusionReason::UrlBlocklist => "url_blocklist",
      ExclusionReason::PaymentScreen => "payment_screen",
      ExclusionReason::IncognitoWindow => "incognito_window",
      ExclusionReason::TimeBlock => "time_block",
    }
  }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentDomain {
  pub host: String,
  pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentRules {
  pub enabled: bool,
  pub domains: Vec<PaymentDomain>,
  pub detect_card_pattern: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IncognitoRules {
  pub enabled: bool,
  pub safari: bool,
  pub chrome: bool,
  pub arc: bool,
  pub firefox: bool,
  pub edge: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeBlock {
  pub start_minute: u16,
  pub end_minute: u16,
  pub days: u8,
  pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterConfig {
  pub payment: PaymentRules,
  pub incognito: IncognitoRules,
  pub time_blocks: Vec<TimeBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureDecision {
  pub should_ingest: bool,
  pub reason: Option<ExclusionReason>,
}

impl Default for FilterConfig {
  fn default() -> Self {
    Self {
      payment: PaymentRules {
        enabled: true,
        domains: default_payment_domains(),
        detect_card_pattern: true,
      },
      incognito: IncognitoRules {
        enabled: true,
        safari: true,
        chrome: true,
        arc: true,
        firefox: true,
        edge: true,
      },
      time_blocks: Vec::new(),
    }
  }
}

pub fn default_payment_domains() -> Vec<PaymentDomain> {
  [
    "stripe.com",
    "paypal.com",
    "pay.amazon.com",
    "pay.google.com",
    "checkout.shopify.com",
    "buy.itunes.apple.com",
    "applepay.apple.com",
    "billing.stripe.com",
  ]
  .iter()
  .map(|h| PaymentDomain {
    host: (*h).to_string(),
    enabled: true,
  })
  .collect()
}

// --- Public API stubs (filled in subsequent tasks) ---

pub fn from_settings(_doc: &Value) -> FilterConfig {
  unimplemented!("Task 2")
}

pub fn is_payment_signal(_rules: &PaymentRules, _ax_text: &str) -> bool {
  unimplemented!("Task 3")
}

pub fn is_incognito_window(
  _rules: &IncognitoRules,
  _app_name: &str,
  _window_title: &str,
) -> bool {
  unimplemented!("Task 4")
}

pub fn is_inside_time_block(_blocks: &[TimeBlock], _now_local_minute_of_week: u16) -> bool {
  unimplemented!("Task 5")
}

pub fn extract_window_title(_ax_text: &str) -> Option<&str> {
  unimplemented!("Task 4")
}

pub fn evaluate_capture(
  _filter: &FilterConfig,
  _app_name: &str,
  _window_title: &str,
  _ax_text: &str,
  _now_local_minute_of_week: u16,
) -> CaptureDecision {
  unimplemented!("Task 6")
}
```

- [ ] **Step 3: Register the module in `lib.rs`**

Open `src-tauri/src/lib.rs`. Find the existing block of `mod ...;` declarations (alphabetically near `mod secrets;` or `mod settings_store;`). Insert `mod sensitive_filter;` so it stays alphabetically sorted (after `mod secrets;`, before `mod settings_store;`). Use Edit:

`old_string`:
```
mod secrets;
mod settings_store;
```

`new_string`:
```
mod secrets;
mod sensitive_filter;
mod settings_store;
```

If the alphabetical order in `lib.rs` differs, place `mod sensitive_filter;` immediately before `mod settings_store;` regardless of what comes before `secrets`.

- [ ] **Step 4: Verify the workspace still compiles**

Run: `cargo check -p app --manifest-path src-tauri/Cargo.toml`
Expected: success (`Finished ... in N.NNs`). The `unimplemented!` stubs compile fine — they're never called yet. Warnings about unused fields are acceptable at this stage.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/sensitive_filter.rs src-tauri/src/lib.rs
git commit -m "feat(filter): sensitive_filter.rs skeleton — types + stubs + regex dep"
```

---

## Task 2: `from_settings` parser with defaults (tests T18-T20)

**Files:**
- Modify: `src-tauri/src/sensitive_filter.rs` (replace `from_settings` stub, add helpers + tests module)

This task adds settings-doc parsing with the same resilience pattern as `capture_sampler::filters_from_settings`: missing keys → defaults, partial overrides preserved.

- [ ] **Step 1: Append the failing tests to the file**

Append at the end of `src-tauri/src/sensitive_filter.rs`:

```rust
#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  // ===== from_settings (T18-T20) =====

  #[test]
  fn from_settings_missing_payment_block_uses_defaults() {
    let cfg = from_settings(&json!({}));
    assert!(cfg.payment.enabled);
    assert!(cfg.payment.detect_card_pattern);
    assert_eq!(cfg.payment.domains.len(), 8);
    assert_eq!(cfg.payment.domains[0].host, "stripe.com");
    assert!(cfg.payment.domains[0].enabled);
    assert!(cfg.incognito.enabled);
    assert!(cfg.incognito.safari);
    assert!(cfg.time_blocks.is_empty());
  }

  #[test]
  fn from_settings_partial_overrides_merge() {
    let doc = json!({
      "sections": {
        "privacy": {
          "paymentScreens": {
            "enabled": true,
            "domains": [{ "host": "custom.example", "enabled": true }],
            "detectCardPattern": false
          }
        }
      }
    });
    let cfg = from_settings(&doc);
    // User-provided list replaces defaults entirely.
    assert_eq!(cfg.payment.domains.len(), 1);
    assert_eq!(cfg.payment.domains[0].host, "custom.example");
    assert!(!cfg.payment.detect_card_pattern);
    // Other sections still default.
    assert!(cfg.incognito.enabled);
  }

  #[test]
  fn from_settings_invalid_time_block_skipped() {
    let doc = json!({
      "sections": {
        "privacy": {
          "timeBlocks": [
            { "startMinute": 1500, "endMinute": 60, "days": 127, "enabled": true },
            { "startMinute": 60, "endMinute": 120, "days": 127, "enabled": true }
          ]
        }
      }
    });
    let cfg = from_settings(&doc);
    // Invalid (startMinute > 1439) row dropped, valid row kept.
    assert_eq!(cfg.time_blocks.len(), 1);
    assert_eq!(cfg.time_blocks[0].start_minute, 60);
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests::from_settings -- --nocapture`
Expected: 3 tests fail with `not implemented: Task 2` panics.

- [ ] **Step 3: Implement `from_settings` and helpers**

Replace the `from_settings` stub. Use Edit on `src-tauri/src/sensitive_filter.rs`:

`old_string`:
```
pub fn from_settings(_doc: &Value) -> FilterConfig {
  unimplemented!("Task 2")
}
```

`new_string`:
```
pub fn from_settings(doc: &Value) -> FilterConfig {
  let priv_sec = doc.pointer("/sections/privacy");
  let payment = parse_payment(priv_sec);
  let incognito = parse_incognito(priv_sec);
  let time_blocks = parse_time_blocks(priv_sec);
  FilterConfig {
    payment,
    incognito,
    time_blocks,
  }
}

fn parse_payment(priv_sec: Option<&Value>) -> PaymentRules {
  let defaults = PaymentRules {
    enabled: true,
    domains: default_payment_domains(),
    detect_card_pattern: true,
  };
  let Some(ps) = priv_sec.and_then(|s| s.get("paymentScreens")) else {
    return defaults;
  };
  let enabled = ps
    .get("enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let detect_card_pattern = ps
    .get("detectCardPattern")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let domains = ps
    .get("domains")
    .and_then(|v| v.as_array())
    .map(|arr| {
      arr
        .iter()
        .filter_map(|row| {
          let host = row
            .get("host")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty() && s.contains('.'))?;
          let enabled = row
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
          Some(PaymentDomain { host, enabled })
        })
        .collect::<Vec<_>>()
    })
    .unwrap_or_else(default_payment_domains);
  PaymentRules {
    enabled,
    domains,
    detect_card_pattern,
  }
}

fn parse_incognito(priv_sec: Option<&Value>) -> IncognitoRules {
  let defaults = IncognitoRules {
    enabled: true,
    safari: true,
    chrome: true,
    arc: true,
    firefox: true,
    edge: true,
  };
  let Some(inc) = priv_sec.and_then(|s| s.get("incognito")) else {
    return defaults;
  };
  let enabled = inc
    .get("enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  let browsers = inc.get("browsers");
  let read = |key: &str, fallback: bool| -> bool {
    browsers
      .and_then(|b| b.get(key))
      .and_then(|v| v.as_bool())
      .unwrap_or(fallback)
  };
  IncognitoRules {
    enabled,
    safari: read("safari", true),
    chrome: read("chrome", true),
    arc: read("arc", true),
    firefox: read("firefox", true),
    edge: read("edge", true),
  }
}

fn parse_time_blocks(priv_sec: Option<&Value>) -> Vec<TimeBlock> {
  let Some(arr) = priv_sec
    .and_then(|s| s.get("timeBlocks"))
    .and_then(|v| v.as_array())
  else {
    return Vec::new();
  };
  arr
    .iter()
    .filter_map(|row| {
      let start_minute = row.get("startMinute").and_then(|v| v.as_u64())? as u16;
      let end_minute = row.get("endMinute").and_then(|v| v.as_u64())? as u16;
      if start_minute > 1439 || end_minute > 1439 {
        log::warn!(
          "sensitive_filter: skipping time block with out-of-range minute(s) start={} end={}",
          start_minute,
          end_minute
        );
        return None;
      }
      let days = row
        .get("days")
        .and_then(|v| v.as_u64())
        .map(|d| (d & 0x7F) as u8)
        .unwrap_or(0);
      let enabled = row
        .get("enabled")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
      Some(TimeBlock {
        start_minute,
        end_minute,
        days,
        enabled,
      })
    })
    .collect()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests::from_settings -- --nocapture`
Expected: 3 tests pass (`test result: ok. 3 passed`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sensitive_filter.rs
git commit -m "feat(filter): sensitive_filter — from_settings parser + defaults (T18-T20)"
```

---

## Task 3: `is_payment_signal` (tests T1-T5)

**Files:**
- Modify: `src-tauri/src/sensitive_filter.rs` (replace `is_payment_signal` stub, append T1-T5 to `tests` module)

Two independent fire signals: payment-domain match in any URL inside the AX text, OR card-number pattern co-occurring with a CVV keyword. The OR-AND combo keeps false positives low.

- [ ] **Step 1: Append T1-T5 to the existing `tests` module**

Use Edit on `src-tauri/src/sensitive_filter.rs`. Find the closing `}` of the existing `tests` module (added in Task 2), and insert before it:

`old_string`:
```
  #[test]
  fn from_settings_invalid_time_block_skipped() {
    let doc = json!({
      "sections": {
        "privacy": {
          "timeBlocks": [
            { "startMinute": 1500, "endMinute": 60, "days": 127, "enabled": true },
            { "startMinute": 60, "endMinute": 120, "days": 127, "enabled": true }
          ]
        }
      }
    });
    let cfg = from_settings(&doc);
    // Invalid (startMinute > 1439) row dropped, valid row kept.
    assert_eq!(cfg.time_blocks.len(), 1);
    assert_eq!(cfg.time_blocks[0].start_minute, 60);
  }
}
```

`new_string`:
```
  #[test]
  fn from_settings_invalid_time_block_skipped() {
    let doc = json!({
      "sections": {
        "privacy": {
          "timeBlocks": [
            { "startMinute": 1500, "endMinute": 60, "days": 127, "enabled": true },
            { "startMinute": 60, "endMinute": 120, "days": 127, "enabled": true }
          ]
        }
      }
    });
    let cfg = from_settings(&doc);
    // Invalid (startMinute > 1439) row dropped, valid row kept.
    assert_eq!(cfg.time_blocks.len(), 1);
    assert_eq!(cfg.time_blocks[0].start_minute, 60);
  }

  // ===== is_payment_signal (T1-T5) =====

  fn payment_rules_with(domains: Vec<&str>, detect_card: bool) -> PaymentRules {
    PaymentRules {
      enabled: true,
      domains: domains
        .into_iter()
        .map(|h| PaymentDomain {
          host: h.to_string(),
          enabled: true,
        })
        .collect(),
      detect_card_pattern: detect_card,
    }
  }

  #[test]
  fn payment_domain_match_fires() {
    let r = payment_rules_with(vec!["stripe.com"], false);
    assert!(is_payment_signal(
      &r,
      "role=AXTextField\nvalue=https://checkout.stripe.com/pay/cs_xyz\nwindow=Checkout"
    ));
  }

  #[test]
  fn payment_domain_disabled_row_does_not_fire() {
    let r = PaymentRules {
      enabled: true,
      domains: vec![PaymentDomain {
        host: "stripe.com".to_string(),
        enabled: false,
      }],
      detect_card_pattern: false,
    };
    assert!(!is_payment_signal(
      &r,
      "value=https://checkout.stripe.com/pay/cs_xyz"
    ));
  }

  #[test]
  fn card_pattern_alone_does_not_fire() {
    // 16-digit run without CVV keyword — could be any long number.
    let r = payment_rules_with(vec![], true);
    assert!(!is_payment_signal(
      &r,
      "value=Order #4111 1111 1111 1111 confirmed"
    ));
  }

  #[test]
  fn card_pattern_with_cvv_keyword_fires() {
    let r = payment_rules_with(vec![], true);
    assert!(is_payment_signal(
      &r,
      "value=Card 4111 1111 1111 1111\nlabel=CVV"
    ));
  }

  #[test]
  fn card_pattern_disabled_globally_skips_regex() {
    let r = payment_rules_with(vec![], false);
    assert!(!is_payment_signal(
      &r,
      "value=Card 4111 1111 1111 1111\nlabel=CVV"
    ));
  }
}
```

- [ ] **Step 2: Run tests — verify failures**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests -- --nocapture 2>&1 | head -80`
Expected: 5 new tests fail with `not implemented: Task 3` panics; the 3 from-settings tests still pass.

- [ ] **Step 3: Implement `is_payment_signal` + helpers**

Replace the stub. Use Edit on `src-tauri/src/sensitive_filter.rs`:

`old_string`:
```
pub fn is_payment_signal(_rules: &PaymentRules, _ax_text: &str) -> bool {
  unimplemented!("Task 3")
}
```

`new_string`:
```
pub fn is_payment_signal(rules: &PaymentRules, ax_text: &str) -> bool {
  if !rules.enabled || ax_text.is_empty() {
    return false;
  }
  if payment_domain_in_text(rules, ax_text) {
    return true;
  }
  if rules.detect_card_pattern && card_and_cvv_co_occur(ax_text) {
    return true;
  }
  false
}

fn payment_domain_in_text(rules: &PaymentRules, ax_text: &str) -> bool {
  let hosts: Vec<&str> = rules
    .domains
    .iter()
    .filter(|d| d.enabled)
    .map(|d| d.host.as_str())
    .filter(|h| h.contains('.'))
    .collect();
  if hosts.is_empty() {
    return false;
  }
  let lower = ax_text.to_ascii_lowercase();
  for tok in lower.split_whitespace() {
    if !tok.contains("://") {
      continue;
    }
    let clean = tok.trim_end_matches(|c: char| {
      matches!(c, '.' | ',' | ';' | ')' | ']' | '>' | '"' | '\'' | '!' | '?')
    });
    if let Ok(url) = url::Url::parse(clean) {
      if let Some(h) = url.host_str() {
        if hosts.iter().any(|ex| host_suffix_match(h, ex)) {
          return true;
        }
      }
    }
  }
  false
}

fn host_suffix_match(actual: &str, excluded: &str) -> bool {
  if actual == excluded {
    return true;
  }
  actual.len() > excluded.len()
    && actual.as_bytes()[actual.len() - excluded.len() - 1] == b'.'
    && actual.ends_with(excluded)
}

fn card_and_cvv_co_occur(ax_text: &str) -> bool {
  use std::sync::OnceLock;
  static CARD_RE: OnceLock<regex::Regex> = OnceLock::new();
  static CVV_RE: OnceLock<regex::Regex> = OnceLock::new();
  let card = CARD_RE.get_or_init(|| {
    // 13–19 digits with optional space/hyphen separators between digits,
    // bounded by non-digit (or string start/end). The bound is enforced via
    // (?:^|\D) and (?:\D|$) — Rust `regex` does not support `\b` against
    // arbitrary character classes the way we want for digit-grouped runs.
    regex::Regex::new(r"(?:^|\D)(?:\d[ \-]?){12,18}\d(?:\D|$)").unwrap()
  });
  let cvv = CVV_RE.get_or_init(|| {
    regex::Regex::new(r"(?i)\b(?:cvv|cvc|cid|security[ ]?code)\b").unwrap()
  });
  card.is_match(ax_text) && cvv.is_match(ax_text)
}
```

Note on the regex: `(?:\d[ \-]?){12,18}\d` matches 13–19 digit characters total, with optional single space or hyphen between each digit. The leading `(?:^|\D)` and trailing `(?:\D|$)` enforce non-digit boundaries without using `\b`, which behaves unhelpfully when the run starts or ends near other digits.

- [ ] **Step 4: Run tests — verify all 8 sensitive_filter tests pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter -- --nocapture 2>&1 | tail -10`
Expected: `test result: ok. 8 passed; 0 failed` (3 from-settings + 5 payment).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sensitive_filter.rs
git commit -m "feat(filter): sensitive_filter — is_payment_signal (T1-T5)"
```

---

## Task 4: `is_incognito_window` + `extract_window_title` (tests T6-T10)

**Files:**
- Modify: `src-tauri/src/sensitive_filter.rs` (replace two stubs, append T6-T10 to `tests`)

Per-browser title patterns. `extract_window_title` is a thin helper that parses the `window=...` line out of `format_snapshot`'s output so the sampler can pass it as a separate argument.

- [ ] **Step 1: Append T6-T10 to the `tests` module**

Use Edit on `src-tauri/src/sensitive_filter.rs`. Insert before the closing `}` of the `tests` module:

`old_string`:
```
  #[test]
  fn card_pattern_disabled_globally_skips_regex() {
    let r = payment_rules_with(vec![], false);
    assert!(!is_payment_signal(
      &r,
      "value=Card 4111 1111 1111 1111\nlabel=CVV"
    ));
  }
}
```

`new_string`:
```
  #[test]
  fn card_pattern_disabled_globally_skips_regex() {
    let r = payment_rules_with(vec![], false);
    assert!(!is_payment_signal(
      &r,
      "value=Card 4111 1111 1111 1111\nlabel=CVV"
    ));
  }

  // ===== is_incognito_window (T6-T10) =====

  fn incognito_all_on() -> IncognitoRules {
    IncognitoRules {
      enabled: true,
      safari: true,
      chrome: true,
      arc: true,
      firefox: true,
      edge: true,
    }
  }

  #[test]
  fn incognito_safari_em_dash_title_fires() {
    let r = incognito_all_on();
    assert!(is_incognito_window(&r, "Safari", "Private — Apple"));
  }

  #[test]
  fn incognito_chrome_paren_title_fires() {
    let r = incognito_all_on();
    assert!(is_incognito_window(
      &r,
      "Google Chrome",
      "Some Page (Incognito)"
    ));
  }

  #[test]
  fn incognito_firefox_suffix_fires() {
    let r = incognito_all_on();
    assert!(is_incognito_window(
      &r,
      "Firefox",
      "Mozilla — News (Private Browsing)"
    ));
  }

  #[test]
  fn incognito_unsupported_browser_returns_false() {
    let r = incognito_all_on();
    // "Notes" is not a browser — even an Incognito-looking title shouldn't fire.
    assert!(!is_incognito_window(&r, "Notes", "Private — Apple"));
    // Brave is recognized via Chromium fallback.
    assert!(is_incognito_window(
      &r,
      "Brave Browser",
      "Search (Incognito)"
    ));
  }

  #[test]
  fn incognito_browser_disabled_in_settings_does_not_fire() {
    let mut r = incognito_all_on();
    r.chrome = false;
    assert!(!is_incognito_window(
      &r,
      "Google Chrome",
      "Page (Incognito)"
    ));
    // Chromium fallback also disabled — same family.
    assert!(!is_incognito_window(
      &r,
      "Brave Browser",
      "Page (Incognito)"
    ));
  }

  #[test]
  fn extract_window_title_pulls_window_line() {
    let ax = "role=AXTextField\nvalue=Hello\nwindow=My Doc — App";
    assert_eq!(extract_window_title(ax), Some("My Doc — App"));
  }

  #[test]
  fn extract_window_title_returns_none_when_absent() {
    let ax = "role=AXTextField\nvalue=Hello";
    assert_eq!(extract_window_title(ax), None);
  }
}
```

- [ ] **Step 2: Run tests — verify the 7 new tests fail**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests -- --nocapture 2>&1 | tail -20`
Expected: 7 of the new tests fail with `not implemented: Task 4` (5 incognito + 2 extract).

- [ ] **Step 3: Implement `is_incognito_window` and `extract_window_title`**

Replace both stubs. Use Edit on `src-tauri/src/sensitive_filter.rs`:

`old_string`:
```
pub fn is_incognito_window(
  _rules: &IncognitoRules,
  _app_name: &str,
  _window_title: &str,
) -> bool {
  unimplemented!("Task 4")
}
```

`new_string`:
```
pub fn is_incognito_window(
  rules: &IncognitoRules,
  app_name: &str,
  window_title: &str,
) -> bool {
  if !rules.enabled {
    return false;
  }
  let app = app_name.trim().to_ascii_lowercase();
  let title = window_title.to_string();
  let title_lower = title.to_ascii_lowercase();
  match app.as_str() {
    "safari" | "safari technology preview" => {
      rules.safari
        && (title.starts_with("Private — ") || title_lower.contains("private browsing"))
    }
    "google chrome" | "chromium" | "brave browser" | "opera" | "vivaldi" => {
      rules.chrome
        && (title_lower.contains("(incognito)") || title_lower.contains("(private)"))
    }
    "arc" => rules.arc && title_lower.contains("incognito"),
    "firefox" | "firefox developer edition" | "firefox nightly" => {
      rules.firefox
        && (title.ends_with("(Private Browsing)") || title_lower.contains("private browsing"))
    }
    "microsoft edge" => {
      rules.edge && (title.contains("[InPrivate]") || title_lower.contains("inprivate"))
    }
    _ => false,
  }
}
```

Then replace the `extract_window_title` stub:

`old_string`:
```
pub fn extract_window_title(_ax_text: &str) -> Option<&str> {
  unimplemented!("Task 4")
}
```

`new_string`:
```
pub fn extract_window_title(ax_text: &str) -> Option<&str> {
  for line in ax_text.lines() {
    if let Some(rest) = line.strip_prefix("window=") {
      return Some(rest);
    }
  }
  None
}
```

- [ ] **Step 4: Run tests — verify all 15 sensitive_filter tests pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter -- --nocapture 2>&1 | tail -10`
Expected: `test result: ok. 15 passed; 0 failed` (3 settings + 5 payment + 5 incognito + 2 extract).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sensitive_filter.rs
git commit -m "feat(filter): sensitive_filter — is_incognito_window + extract_window_title (T6-T10)"
```

---

## Task 5: `is_inside_time_block` (tests T11-T15)

**Files:**
- Modify: `src-tauri/src/sensitive_filter.rs` (replace stub, append T11-T15)

Cross-midnight handling is the subtle part: when `start > end`, the block wraps. Today's tail (`minute >= start`) fires regardless of the bitmask's "today" bit if "today" was the start day, and yesterday's morning tail (`minute < end`) fires if yesterday's bit was set.

- [ ] **Step 1: Append T11-T15 to the `tests` module**

Use Edit on `src-tauri/src/sensitive_filter.rs`. Insert before the closing `}` of the `tests` module:

`old_string`:
```
  #[test]
  fn extract_window_title_returns_none_when_absent() {
    let ax = "role=AXTextField\nvalue=Hello";
    assert_eq!(extract_window_title(ax), None);
  }
}
```

`new_string`:
```
  #[test]
  fn extract_window_title_returns_none_when_absent() {
    let ax = "role=AXTextField\nvalue=Hello";
    assert_eq!(extract_window_title(ax), None);
  }

  // ===== is_inside_time_block (T11-T15) =====

  // Day bitmask helpers: sun=1, mon=2, tue=4, wed=8, thu=16, fri=32, sat=64.
  const SUN: u8 = 1;
  const MON: u8 = 2;
  const TUE: u8 = 4;
  const WED: u8 = 8;
  const THU: u8 = 16;
  const FRI: u8 = 32;
  const SAT: u8 = 64;

  fn minute_of_week(day: u16, hour: u16, minute: u16) -> u16 {
    day * 1440 + hour * 60 + minute
  }

  #[test]
  fn time_block_simple_range_fires() {
    let blocks = vec![TimeBlock {
      start_minute: 600,
      end_minute: 660,
      days: MON,
      enabled: true,
    }];
    // Mon 10:30 → inside [10:00, 11:00) on Monday.
    assert!(is_inside_time_block(&blocks, minute_of_week(1, 10, 30)));
    // Mon 09:59 → outside.
    assert!(!is_inside_time_block(&blocks, minute_of_week(1, 9, 59)));
    // Mon 11:00 → outside (half-open).
    assert!(!is_inside_time_block(&blocks, minute_of_week(1, 11, 0)));
  }

  #[test]
  fn time_block_wrap_midnight_fires_in_tail() {
    // 22:00–07:00 active Mon–Fri.
    let blocks = vec![TimeBlock {
      start_minute: 22 * 60,
      end_minute: 7 * 60,
      days: MON | TUE | WED | THU | FRI,
      enabled: true,
    }];
    // Tue 23:30 → today's tail (today=Tue, in MON|TUE|...).
    assert!(is_inside_time_block(&blocks, minute_of_week(2, 23, 30)));
  }

  #[test]
  fn time_block_wrap_midnight_fires_in_morning_when_yesterday_selected() {
    // Same rule as T12.
    let blocks = vec![TimeBlock {
      start_minute: 22 * 60,
      end_minute: 7 * 60,
      days: MON | TUE | WED | THU | FRI,
      enabled: true,
    }];
    // Tue 02:00 → yesterday=Mon, which IS in the bitmask.
    assert!(is_inside_time_block(&blocks, minute_of_week(2, 2, 0)));
  }

  #[test]
  fn time_block_wrap_midnight_does_not_fire_when_yesterday_unselected() {
    // 22:00–07:00 active Tue–Fri only.
    let blocks = vec![TimeBlock {
      start_minute: 22 * 60,
      end_minute: 7 * 60,
      days: TUE | WED | THU | FRI,
      enabled: true,
    }];
    // Tue 02:00 → yesterday=Mon, not in mask → must not fire.
    assert!(!is_inside_time_block(&blocks, minute_of_week(2, 2, 0)));
    // Tue 23:30 → today=Tue, in mask → fires.
    assert!(is_inside_time_block(&blocks, minute_of_week(2, 23, 30)));
  }

  #[test]
  fn time_block_disabled_rows_skipped() {
    let blocks = vec![TimeBlock {
      start_minute: 600,
      end_minute: 660,
      days: MON,
      enabled: false,
    }];
    // Mon 10:30 → would match if enabled, but it's not.
    assert!(!is_inside_time_block(&blocks, minute_of_week(1, 10, 30)));
  }

  // Force-use SUN|SAT constants so they're not flagged as dead code in this test module.
  #[test]
  fn weekend_constants_are_distinct() {
    assert_ne!(SUN, SAT);
  }
}
```

- [ ] **Step 2: Run tests — verify the 5 new test functions fail**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests::time_block -- --nocapture 2>&1 | tail -20`
Expected: 5 tests panic with `not implemented: Task 5`.

- [ ] **Step 3: Implement `is_inside_time_block`**

Replace the stub. Use Edit on `src-tauri/src/sensitive_filter.rs`:

`old_string`:
```
pub fn is_inside_time_block(_blocks: &[TimeBlock], _now_local_minute_of_week: u16) -> bool {
  unimplemented!("Task 5")
}
```

`new_string`:
```
pub fn is_inside_time_block(blocks: &[TimeBlock], now_local_minute_of_week: u16) -> bool {
  let day = (now_local_minute_of_week / 1440) as u8;
  let minute = now_local_minute_of_week % 1440;
  let yesterday = (day + 6) % 7;
  for block in blocks.iter().filter(|b| b.enabled) {
    let today_bit = 1u8 << day;
    let yesterday_bit = 1u8 << yesterday;
    if block.start_minute <= block.end_minute {
      if (block.days & today_bit) != 0
        && minute >= block.start_minute
        && minute < block.end_minute
      {
        return true;
      }
    } else {
      let in_today_tail = (block.days & today_bit) != 0 && minute >= block.start_minute;
      let in_yesterday_morning =
        (block.days & yesterday_bit) != 0 && minute < block.end_minute;
      if in_today_tail || in_yesterday_morning {
        return true;
      }
    }
  }
  false
}
```

- [ ] **Step 4: Run tests — verify all 21 sensitive_filter tests pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter -- --nocapture 2>&1 | tail -10`
Expected: `test result: ok. 21 passed; 0 failed` (15 prior + 5 time_block + 1 weekend_constants).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sensitive_filter.rs
git commit -m "feat(filter): sensitive_filter — is_inside_time_block (T11-T15)"
```

---

## Task 6: `evaluate_capture` integration helper (tests T16-T17)

**Files:**
- Modify: `src-tauri/src/sensitive_filter.rs` (replace stub, append T16-T17)

Combines the three detectors into one decision used by the sampler. Order matters: cheap checks (time-block) run first, payment short-circuits before incognito, etc.

- [ ] **Step 1: Append T16-T17 to the `tests` module**

Use Edit on `src-tauri/src/sensitive_filter.rs`. Insert before the closing `}` of the `tests` module:

`old_string`:
```
  // Force-use SUN|SAT constants so they're not flagged as dead code in this test module.
  #[test]
  fn weekend_constants_are_distinct() {
    assert_ne!(SUN, SAT);
  }
}
```

`new_string`:
```
  // Force-use SUN|SAT constants so they're not flagged as dead code in this test module.
  #[test]
  fn weekend_constants_are_distinct() {
    assert_ne!(SUN, SAT);
  }

  // ===== evaluate_capture (T16-T17) =====

  #[test]
  fn evaluate_capture_payment_short_circuits() {
    let mut cfg = FilterConfig::default();
    // Add a time-block that would fire if checked — payment must short-circuit before it.
    cfg.time_blocks = vec![TimeBlock {
      start_minute: 0,
      end_minute: 1440,
      days: 0x7F,
      enabled: true,
    }];
    let decision = evaluate_capture(
      &cfg,
      "Safari",
      "Stripe Checkout",
      "value=https://checkout.stripe.com/pay/cs_xyz\nwindow=Stripe Checkout",
      minute_of_week(2, 10, 30),
    );
    assert!(!decision.should_ingest);
    assert_eq!(decision.reason, Some(ExclusionReason::PaymentScreen));
  }

  #[test]
  fn evaluate_capture_pass_through() {
    let cfg = FilterConfig {
      payment: PaymentRules {
        enabled: false,
        domains: vec![],
        detect_card_pattern: false,
      },
      incognito: IncognitoRules {
        enabled: false,
        safari: false,
        chrome: false,
        arc: false,
        firefox: false,
        edge: false,
      },
      time_blocks: vec![],
    };
    let decision = evaluate_capture(
      &cfg,
      "Safari",
      "GitHub",
      "value=https://github.com/foo/bar",
      minute_of_week(1, 14, 0),
    );
    assert!(decision.should_ingest);
    assert_eq!(decision.reason, None);
  }
}
```

- [ ] **Step 2: Run tests — verify the 2 new tests fail**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter::tests::evaluate_capture -- --nocapture 2>&1 | tail -15`
Expected: 2 tests panic with `not implemented: Task 6`.

- [ ] **Step 3: Implement `evaluate_capture`**

Replace the stub. Use Edit on `src-tauri/src/sensitive_filter.rs`:

`old_string`:
```
pub fn evaluate_capture(
  _filter: &FilterConfig,
  _app_name: &str,
  _window_title: &str,
  _ax_text: &str,
  _now_local_minute_of_week: u16,
) -> CaptureDecision {
  unimplemented!("Task 6")
}
```

`new_string`:
```
pub fn evaluate_capture(
  filter: &FilterConfig,
  app_name: &str,
  window_title: &str,
  ax_text: &str,
  now_local_minute_of_week: u16,
) -> CaptureDecision {
  if is_payment_signal(&filter.payment, ax_text) {
    return CaptureDecision {
      should_ingest: false,
      reason: Some(ExclusionReason::PaymentScreen),
    };
  }
  if is_incognito_window(&filter.incognito, app_name, window_title) {
    return CaptureDecision {
      should_ingest: false,
      reason: Some(ExclusionReason::IncognitoWindow),
    };
  }
  if is_inside_time_block(&filter.time_blocks, now_local_minute_of_week) {
    return CaptureDecision {
      should_ingest: false,
      reason: Some(ExclusionReason::TimeBlock),
    };
  }
  CaptureDecision {
    should_ingest: true,
    reason: None,
  }
}
```

The order (payment → incognito → time-block) matches the spec § 6: payment is the highest-precedence exclusion (most user-sensitive), incognito is second, time-block is third (cheapest, but applies even when AX text is empty so the sampler will check it again in the integration step).

- [ ] **Step 4: Run all sensitive_filter tests — verify 23 pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml sensitive_filter -- --nocapture 2>&1 | tail -10`
Expected: `test result: ok. 23 passed; 0 failed` (21 prior + 2 evaluate_capture).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sensitive_filter.rs
git commit -m "feat(filter): sensitive_filter — evaluate_capture (T16-T17, all 23 tests passing)"
```

---

## Task 7: Wire `evaluate_capture` into `capture_sampler`

**Files:**
- Modify: `src-tauri/src/capture_sampler.rs:33-35` (add a static for filter-drop rate-limit)
- Modify: `src-tauri/src/capture_sampler.rs:228-234` (add `load_filter_config` next to `load_privacy_filters`)
- Modify: `src-tauri/src/capture_sampler.rs:84-90` (add `maybe_log_filter_drop` next to `maybe_log_ingest_error`)
- Modify: `src-tauri/src/capture_sampler.rs:439-470` (the macOS sampler-loop body — call `evaluate_capture` after the existing host-blocklist check; add a time-block pre-check that runs even when axRichCapture is off)

Time-block fires regardless of AX availability (it doesn't need any AX content). Payment / incognito only run when there's AX text to inspect — they sit inside the existing `if ax_rich_capture_enabled() { ... }` branch right after the existing `ax_text_excluded` check.

- [ ] **Step 1: Add the rate-limit static for filter-drop logs**

Use Edit on `src-tauri/src/capture_sampler.rs`:

`old_string`:
```
static LAST_INGEST_ERROR_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
```

`new_string`:
```
static LAST_INGEST_ERROR_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
static LAST_FILTER_DROP_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
```

- [ ] **Step 2: Add the `maybe_log_filter_drop` helper**

Use Edit on `src-tauri/src/capture_sampler.rs`:

`old_string`:
```
fn maybe_log_ingest_error(source: &str, err: &str) {
  if !should_trigger_now(&LAST_INGEST_ERROR_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::warn!("capture: memory ingest failed (source={}): {}", source, err);
}
```

`new_string`:
```
fn maybe_log_ingest_error(source: &str, err: &str) {
  if !should_trigger_now(&LAST_INGEST_ERROR_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::warn!("capture: memory ingest failed (source={}): {}", source, err);
}

fn maybe_log_filter_drop(reason: &str) {
  if !should_trigger_now(&LAST_FILTER_DROP_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::info!("capture: dropped by sensitive_filter (reason={})", reason);
}
```

- [ ] **Step 3: Add `load_filter_config` next to `load_privacy_filters`**

Use Edit on `src-tauri/src/capture_sampler.rs`:

`old_string`:
```
fn load_privacy_filters() -> PrivacyFilters {
  settings_store::load()
    .ok()
    .as_ref()
    .map(filters_from_settings)
    .unwrap_or_default()
}
```

`new_string`:
```
fn load_privacy_filters() -> PrivacyFilters {
  settings_store::load()
    .ok()
    .as_ref()
    .map(filters_from_settings)
    .unwrap_or_default()
}

fn load_filter_config() -> crate::sensitive_filter::FilterConfig {
  settings_store::load()
    .ok()
    .as_ref()
    .map(crate::sensitive_filter::from_settings)
    .unwrap_or_default()
}

fn current_local_minute_of_week() -> u16 {
  use chrono::{Datelike, Local, Timelike};
  let now = Local::now();
  let day = now.weekday().num_days_from_sunday() as u16; // 0=Sun..6=Sat
  let minute = (now.hour() * 60 + now.minute()) as u16;
  day * 1440 + minute
}
```

- [ ] **Step 4: Update the macOS sampler-loop body**

This is the biggest single edit in this task. Use Edit on `src-tauri/src/capture_sampler.rs` to replace the macOS branch of the sampler-loop body with the new gated version:

`old_string`:
```
    let filters = load_privacy_filters();
    #[cfg(target_os = "macos")]
    {
      let frontmost = frontmost_app_name();
      if let Some(ref name) = frontmost {
        if app_excluded(&filters, name) {
          continue;
        }
      }
      if ax_rich_capture_enabled() {
        if macos_ax::accessibility_trust_status() == Some(false) {
          maybe_warn_ax_not_trusted(&app);
        }
        match macos_ax::focused_ax_snapshot() {
          Some(ax) => {
            let t = ax.trim();
            if !t.is_empty() {
              if ax_text_excluded(&filters, t) {
                continue;
              }
              maybe_ingest_ax(t);
              continue;
            }
            maybe_log_ax_snapshot_empty();
          }
          None => maybe_log_ax_snapshot_empty(),
        }
      }
      if let Some(name) = frontmost {
        maybe_ingest_focus(&name);
      }
    }
    #[cfg(not(target_os = "macos"))]
    {
      let _ = (&filters, &app);
    }
  });
}
```

`new_string`:
```
    let filters = load_privacy_filters();
    let filter_cfg = load_filter_config();
    let now_minute_of_week = current_local_minute_of_week();
    if crate::sensitive_filter::is_inside_time_block(&filter_cfg.time_blocks, now_minute_of_week) {
      maybe_log_filter_drop(crate::sensitive_filter::ExclusionReason::TimeBlock.as_log_str());
      continue;
    }
    #[cfg(target_os = "macos")]
    {
      let frontmost = frontmost_app_name();
      if let Some(ref name) = frontmost {
        if app_excluded(&filters, name) {
          continue;
        }
      }
      if ax_rich_capture_enabled() {
        if macos_ax::accessibility_trust_status() == Some(false) {
          maybe_warn_ax_not_trusted(&app);
        }
        match macos_ax::focused_ax_snapshot() {
          Some(ax) => {
            let t = ax.trim();
            if !t.is_empty() {
              if ax_text_excluded(&filters, t) {
                continue;
              }
              let app_name = frontmost.as_deref().unwrap_or("");
              let window_title =
                crate::sensitive_filter::extract_window_title(t).unwrap_or("");
              let decision = crate::sensitive_filter::evaluate_capture(
                &filter_cfg,
                app_name,
                window_title,
                t,
                now_minute_of_week,
              );
              if !decision.should_ingest {
                if let Some(reason) = decision.reason {
                  maybe_log_filter_drop(reason.as_log_str());
                }
                continue;
              }
              maybe_ingest_ax(t);
              continue;
            }
            maybe_log_ax_snapshot_empty();
          }
          None => maybe_log_ax_snapshot_empty(),
        }
      }
      if let Some(name) = frontmost {
        maybe_ingest_focus(&name);
      }
    }
    #[cfg(not(target_os = "macos"))]
    {
      let _ = (&filters, &filter_cfg, &now_minute_of_week, &app);
    }
  });
}
```

- [ ] **Step 5: Verify the workspace compiles and all tests still pass**

Run: `cargo test -p app --manifest-path src-tauri/Cargo.toml 2>&1 | tail -20`
Expected: success across all crates; the existing capture_sampler tests still pass; the 23 sensitive_filter tests still pass. Watch for unused-import warnings — there should be none new.

Also run the project's lint gate: `npm run check:rust 2>&1 | tail -20`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/capture_sampler.rs
git commit -m "feat(filter): wire sensitive_filter into capture_sampler loop"
```

---

## Task 8: Settings UI — Payment Screens card

**Files:**
- Modify: `hifi/settings-modal.jsx` (extend `normalizePrivacyFromSettings` ~line 185, add new state in `PanePrivacy` ~line 840, extend `persistPrivacy` ~line 855, append the new card JSX before the existing tab control ~line 1169)

Three settings cards land in three separate tasks (8, 9, 10) so each one is small enough to review on its own. After Task 10 the `PanePrivacy` body has the existing app/site tab control plus three new cards above it.

- [ ] **Step 1: Extend `normalizePrivacyFromSettings` to round-trip payment fields**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
  return {
    excludedApps: apps.map((r) => ({
      id: String(r.id || r.name || 'app'),
      name: String(r.name || 'App'),
      icon: r.icon != null ? String(r.icon) : '⬚',
      enabled: !!r.enabled,
      path: r.path ? String(r.path) : undefined,
    })),
    excludedSites: sites.map((r) => ({
      id: String(r.id || r.host || 'site'),
      host: String(r.host || '').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0],
      label: r.label != null ? String(r.label) : String(r.host || ''),
      enabled: !!r.enabled,
    })),
  };
}
```

`new_string`:
```
  const ps = sec && sec.paymentScreens && typeof sec.paymentScreens === 'object'
    ? sec.paymentScreens
    : null;
  const paymentScreens = {
    enabled: ps && typeof ps.enabled === 'boolean' ? ps.enabled : true,
    detectCardPattern:
      ps && typeof ps.detectCardPattern === 'boolean' ? ps.detectCardPattern : true,
    domains: Array.isArray(ps && ps.domains)
      ? ps.domains
          .filter((r) => r && typeof r.host === 'string')
          .map((r, i) => ({
            id: String(r.id || `pd-${i}`),
            host: String(r.host).toLowerCase(),
            label: r.label != null ? String(r.label) : String(r.host),
            enabled: r.enabled !== false,
          }))
      : DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  };
  return {
    excludedApps: apps.map((r) => ({
      id: String(r.id || r.name || 'app'),
      name: String(r.name || 'App'),
      icon: r.icon != null ? String(r.icon) : '⬚',
      enabled: !!r.enabled,
      path: r.path ? String(r.path) : undefined,
    })),
    excludedSites: sites.map((r) => ({
      id: String(r.id || r.host || 'site'),
      host: String(r.host || '').toLowerCase().replace(/^https?:\/\//i, '').split('/')[0],
      label: r.label != null ? String(r.label) : String(r.host || ''),
      enabled: !!r.enabled,
    })),
    paymentScreens,
  };
}
```

- [ ] **Step 2: Add `DEFAULT_PAYMENT_DOMAINS` constant near the existing `PRIVACY_DEFAULT_*` constants**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
const PRIVACY_DEFAULT_SITES = [
  { id: 'site-ex1', host: 'internal.corp.example', label: 'Corporate SSO (example)', enabled: true },
  { id: 'site-ex2', host: 'pay.vendor.example', label: 'Vendor payments (example)', enabled: false },
];
```

`new_string`:
```
const PRIVACY_DEFAULT_SITES = [
  { id: 'site-ex1', host: 'internal.corp.example', label: 'Corporate SSO (example)', enabled: true },
  { id: 'site-ex2', host: 'pay.vendor.example', label: 'Vendor payments (example)', enabled: false },
];

const DEFAULT_PAYMENT_DOMAINS = [
  { id: 'pd-stripe',     host: 'stripe.com',            label: 'Stripe',           enabled: true },
  { id: 'pd-paypal',     host: 'paypal.com',            label: 'PayPal',           enabled: true },
  { id: 'pd-amazonpay',  host: 'pay.amazon.com',        label: 'Amazon Pay',       enabled: true },
  { id: 'pd-googlepay',  host: 'pay.google.com',        label: 'Google Pay',       enabled: true },
  { id: 'pd-shopify',    host: 'checkout.shopify.com',  label: 'Shopify Checkout', enabled: true },
  { id: 'pd-itunes',     host: 'buy.itunes.apple.com',  label: 'iTunes Store',     enabled: true },
  { id: 'pd-applepay',   host: 'applepay.apple.com',    label: 'Apple Pay',        enabled: true },
  { id: 'pd-billing',    host: 'billing.stripe.com',    label: 'Stripe Billing',   enabled: true },
];
```

- [ ] **Step 3: Add payment state + handlers inside `PanePrivacy`**

Use Edit on `hifi/settings-modal.jsx`. Find the existing `useStateS` block at the top of `PanePrivacy` (line ~840):

`old_string`:
```
  const [tab, setTab] = useStateS('apps');
  const [apps, setApps] = useStateS(() => PRIVACY_DEFAULT_APPS.map((r) => ({ ...r })));
  const [sites, setSites] = useStateS(() => PRIVACY_DEFAULT_SITES.map((r) => ({ ...r })));
```

`new_string`:
```
  const [tab, setTab] = useStateS('apps');
  const [apps, setApps] = useStateS(() => PRIVACY_DEFAULT_APPS.map((r) => ({ ...r })));
  const [sites, setSites] = useStateS(() => PRIVACY_DEFAULT_SITES.map((r) => ({ ...r })));
  const [paymentEnabled, setPaymentEnabled] = useStateS(true);
  const [paymentDetectCard, setPaymentDetectCard] = useStateS(true);
  const [paymentDomains, setPaymentDomains] = useStateS(() =>
    DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  );
  const [paymentDraft, setPaymentDraft] = useStateS('');
```

- [ ] **Step 4: Extend `persistPrivacy` to include payment in the save payload**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
  const persistPrivacy = React.useCallback(
    async (nextApps, nextSites) => {
      const r = await run(
        'settings.save',
        {
          section: 'privacy',
          excludedApps: nextApps,
          excludedSites: nextSites,
          allowChatServerMemoryAssembly: allowServerMemoryAssembly,
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [run, refreshSections, allowServerMemoryAssembly],
  );
```

`new_string`:
```
  const persistPrivacy = React.useCallback(
    async (nextApps, nextSites, overrides) => {
      const o = overrides || {};
      const r = await run(
        'settings.save',
        {
          section: 'privacy',
          excludedApps: nextApps,
          excludedSites: nextSites,
          allowChatServerMemoryAssembly: allowServerMemoryAssembly,
          paymentScreens: {
            enabled: 'paymentEnabled' in o ? o.paymentEnabled : paymentEnabled,
            detectCardPattern:
              'paymentDetectCard' in o ? o.paymentDetectCard : paymentDetectCard,
            domains: 'paymentDomains' in o ? o.paymentDomains : paymentDomains,
          },
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [run, refreshSections, allowServerMemoryAssembly, paymentEnabled, paymentDetectCard, paymentDomains],
  );
```

- [ ] **Step 5: Hydrate payment state from settings**

Use Edit on `hifi/settings-modal.jsx`. Find the existing hydration `useEffect`:

`old_string`:
```
  const privacyKey = JSON.stringify(privacySec);
  React.useEffect(() => {
    const { excludedApps, excludedSites } = normalizePrivacyFromSettings(privacySec);
    setApps(excludedApps);
    setSites(excludedSites);
    setAllowServerMemoryAssembly(privacySec.allowChatServerMemoryAssembly !== false);
  }, [privacyKey]);
```

`new_string`:
```
  const privacyKey = JSON.stringify(privacySec);
  React.useEffect(() => {
    const { excludedApps, excludedSites, paymentScreens } = normalizePrivacyFromSettings(privacySec);
    setApps(excludedApps);
    setSites(excludedSites);
    setAllowServerMemoryAssembly(privacySec.allowChatServerMemoryAssembly !== false);
    setPaymentEnabled(paymentScreens.enabled);
    setPaymentDetectCard(paymentScreens.detectCardPattern);
    setPaymentDomains(paymentScreens.domains);
  }, [privacyKey]);
```

- [ ] **Step 6: Insert the Payment Screens card before the existing tab control**

Use Edit on `hifi/settings-modal.jsx`. Find the marker `<div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>` (the start of the apps/sites tab control, around line 1169) and insert the new card *before* it:

`old_string`:
```
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
        <button
          type="button"
          className="btn btn-sm"
          style={{background:tab==='apps'?'var(--surface-2)':'transparent', borderColor:'transparent'}}
          onClick={()=>setTab('apps')}
        >
          Exclude Apps <span style={{color:'var(--text-dim)', marginLeft:4}}>{apps.length}</span>
        </button>
```

`new_string`:
```
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title="Payment screens"
          desc="Skip captures when the screen looks like a payment page (URL or card-shaped digits next to a CVV label)."
        >
          <Toggle
            on={paymentEnabled}
            onClick={async () => {
              const next = !paymentEnabled;
              setPaymentEnabled(next);
              await persistPrivacy(apps, sites, { paymentEnabled: next });
            }}
          />
        </Row>
        <Row
          title="Also detect card-number patterns"
          desc="Heuristic: 13–19 digit runs co-occurring with a CVV/CVC label. Disable if you see false positives."
          last
        >
          <Toggle
            on={paymentDetectCard}
            onClick={async () => {
              const next = !paymentDetectCard;
              setPaymentDetectCard(next);
              await persistPrivacy(apps, sites, { paymentDetectCard: next });
            }}
          />
        </Row>
        <div style={{ padding: '0 16px 14px' }}>
          <div className="s-field-hint" style={{ marginBottom: 8, fontSize: 11 }}>
            Payment domains (suffix-matched, e.g. <code>stripe.com</code> also covers <code>checkout.stripe.com</code>):
          </div>
          {paymentDomains.length === 0 ? (
            <div className="s-field-hint" style={{ padding: 8 }}>No domains.</div>
          ) : (
            <div className="s-card" style={{ marginBottom: 8 }}>
              {paymentDomains.map((d, i, arr) => (
                <div key={d.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                  <div style={{ flex: 1, fontSize: 13 }}>
                    <div style={{ fontWeight: 500 }}>{d.host}</div>
                    {d.label && d.label !== d.host ? (
                      <div className="s-field-hint" style={{ fontSize: 11 }}>{d.label}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    style={{ marginRight: 8 }}
                    title="Remove from list"
                    onClick={async () => {
                      const next = paymentDomains.filter((x) => x.id !== d.id);
                      setPaymentDomains(next);
                      await persistPrivacy(apps, sites, { paymentDomains: next });
                    }}
                  >
                    ×
                  </button>
                  <Toggle
                    on={d.enabled}
                    onClick={async () => {
                      const next = paymentDomains.map((x) =>
                        x.id === d.id ? { ...x, enabled: !x.enabled } : x,
                      );
                      setPaymentDomains(next);
                      await persistPrivacy(apps, sites, { paymentDomains: next });
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <input
              className="s-input"
              style={{ flex: 1 }}
              placeholder="e.g. checkout.example.com"
              value={paymentDraft}
              onChange={(e) => setPaymentDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void (async () => {
                    let host = paymentDraft.trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0].trim();
                    if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) {
                      toast('有効なホスト名を入力してください', 'warn');
                      return;
                    }
                    if (paymentDomains.some((x) => x.host === host)) {
                      toast('そのドメインは既にあります', 'info');
                      return;
                    }
                    const next = paymentDomains.concat([
                      { id: `pd-${host}`, host, label: host, enabled: true },
                    ]);
                    setPaymentDomains(next);
                    setPaymentDraft('');
                    await persistPrivacy(apps, sites, { paymentDomains: next });
                  })();
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={async () => {
                let host = paymentDraft.trim().toLowerCase().replace(/^https?:\/\//i, '').split('/')[0].trim();
                if (!host || !host.includes('.') || !/^[a-z0-9.-]+$/i.test(host)) {
                  toast('有効なホスト名を入力してください', 'warn');
                  return;
                }
                if (paymentDomains.some((x) => x.host === host)) {
                  toast('そのドメインは既にあります', 'info');
                  return;
                }
                const next = paymentDomains.concat([
                  { id: `pd-${host}`, host, label: host, enabled: true },
                ]);
                setPaymentDomains(next);
                setPaymentDraft('');
                await persistPrivacy(apps, sites, { paymentDomains: next });
              }}
            >
              Add domain
            </button>
          </div>
        </div>
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
        <button
          type="button"
          className="btn btn-sm"
          style={{background:tab==='apps'?'var(--surface-2)':'transparent', borderColor:'transparent'}}
          onClick={()=>setTab('apps')}
        >
          Exclude Apps <span style={{color:'var(--text-dim)', marginLeft:4}}>{apps.length}</span>
        </button>
```

- [ ] **Step 7: Verify the frontend lints**

Run: `python3 hifi/scripts/check-actions.py 2>&1 | tail -10`
Expected: success — no new IPC actions added, only an extended payload to existing `settings.save`.

If the project has an eslint or tsc gate, run it: `npm run lint 2>&1 | tail -20` (skip if the script does not exist).

- [ ] **Step 8: Commit**

```bash
git add hifi/settings-modal.jsx
git commit -m "feat(filter): PanePrivacy — Payment screens card"
```

---

## Task 9: Settings UI — Incognito card

**Files:**
- Modify: `hifi/settings-modal.jsx` (extend `normalizePrivacyFromSettings`, add state, extend `persistPrivacy`, hydrate, append the new card)

Same pattern as Task 8 but for incognito browser detection.

- [ ] **Step 1: Extend `normalizePrivacyFromSettings` to round-trip incognito fields**

Use Edit on `hifi/settings-modal.jsx`. Find the `paymentScreens` object built in Task 8 step 1 and add the `incognito` object next to it:

`old_string`:
```
  const paymentScreens = {
    enabled: ps && typeof ps.enabled === 'boolean' ? ps.enabled : true,
    detectCardPattern:
      ps && typeof ps.detectCardPattern === 'boolean' ? ps.detectCardPattern : true,
    domains: Array.isArray(ps && ps.domains)
      ? ps.domains
          .filter((r) => r && typeof r.host === 'string')
          .map((r, i) => ({
            id: String(r.id || `pd-${i}`),
            host: String(r.host).toLowerCase(),
            label: r.label != null ? String(r.label) : String(r.host),
            enabled: r.enabled !== false,
          }))
      : DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  };
  return {
```

`new_string`:
```
  const paymentScreens = {
    enabled: ps && typeof ps.enabled === 'boolean' ? ps.enabled : true,
    detectCardPattern:
      ps && typeof ps.detectCardPattern === 'boolean' ? ps.detectCardPattern : true,
    domains: Array.isArray(ps && ps.domains)
      ? ps.domains
          .filter((r) => r && typeof r.host === 'string')
          .map((r, i) => ({
            id: String(r.id || `pd-${i}`),
            host: String(r.host).toLowerCase(),
            label: r.label != null ? String(r.label) : String(r.host),
            enabled: r.enabled !== false,
          }))
      : DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  };
  const inc = sec && sec.incognito && typeof sec.incognito === 'object' ? sec.incognito : null;
  const incBrowsers = inc && inc.browsers && typeof inc.browsers === 'object' ? inc.browsers : {};
  const readBool = (v, fb) => (typeof v === 'boolean' ? v : fb);
  const incognito = {
    enabled: inc && typeof inc.enabled === 'boolean' ? inc.enabled : true,
    browsers: {
      safari: readBool(incBrowsers.safari, true),
      chrome: readBool(incBrowsers.chrome, true),
      arc: readBool(incBrowsers.arc, true),
      firefox: readBool(incBrowsers.firefox, true),
      edge: readBool(incBrowsers.edge, true),
    },
  };
  return {
```

Then update the returned object to include `incognito`:

`old_string`:
```
    paymentScreens,
  };
}
```

`new_string`:
```
    paymentScreens,
    incognito,
  };
}
```

- [ ] **Step 2: Add incognito state inside `PanePrivacy`**

Use Edit on `hifi/settings-modal.jsx`. Find the payment-state block added in Task 8 step 3:

`old_string`:
```
  const [paymentEnabled, setPaymentEnabled] = useStateS(true);
  const [paymentDetectCard, setPaymentDetectCard] = useStateS(true);
  const [paymentDomains, setPaymentDomains] = useStateS(() =>
    DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  );
  const [paymentDraft, setPaymentDraft] = useStateS('');
```

`new_string`:
```
  const [paymentEnabled, setPaymentEnabled] = useStateS(true);
  const [paymentDetectCard, setPaymentDetectCard] = useStateS(true);
  const [paymentDomains, setPaymentDomains] = useStateS(() =>
    DEFAULT_PAYMENT_DOMAINS.map((d) => ({ ...d })),
  );
  const [paymentDraft, setPaymentDraft] = useStateS('');
  const [incognitoEnabled, setIncognitoEnabled] = useStateS(true);
  const [incognitoBrowsers, setIncognitoBrowsers] = useStateS({
    safari: true, chrome: true, arc: true, firefox: true, edge: true,
  });
```

- [ ] **Step 3: Extend `persistPrivacy` to include incognito**

Use Edit on `hifi/settings-modal.jsx`. Find the `paymentScreens` block in `persistPrivacy`:

`old_string`:
```
          paymentScreens: {
            enabled: 'paymentEnabled' in o ? o.paymentEnabled : paymentEnabled,
            detectCardPattern:
              'paymentDetectCard' in o ? o.paymentDetectCard : paymentDetectCard,
            domains: 'paymentDomains' in o ? o.paymentDomains : paymentDomains,
          },
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [run, refreshSections, allowServerMemoryAssembly, paymentEnabled, paymentDetectCard, paymentDomains],
  );
```

`new_string`:
```
          paymentScreens: {
            enabled: 'paymentEnabled' in o ? o.paymentEnabled : paymentEnabled,
            detectCardPattern:
              'paymentDetectCard' in o ? o.paymentDetectCard : paymentDetectCard,
            domains: 'paymentDomains' in o ? o.paymentDomains : paymentDomains,
          },
          incognito: {
            enabled: 'incognitoEnabled' in o ? o.incognitoEnabled : incognitoEnabled,
            browsers: 'incognitoBrowsers' in o ? o.incognitoBrowsers : incognitoBrowsers,
          },
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [
      run,
      refreshSections,
      allowServerMemoryAssembly,
      paymentEnabled,
      paymentDetectCard,
      paymentDomains,
      incognitoEnabled,
      incognitoBrowsers,
    ],
  );
```

- [ ] **Step 4: Hydrate incognito state**

Use Edit on `hifi/settings-modal.jsx`. Find the hydration `useEffect` extended in Task 8 step 5:

`old_string`:
```
    setPaymentEnabled(paymentScreens.enabled);
    setPaymentDetectCard(paymentScreens.detectCardPattern);
    setPaymentDomains(paymentScreens.domains);
  }, [privacyKey]);
```

`new_string`:
```
    setPaymentEnabled(paymentScreens.enabled);
    setPaymentDetectCard(paymentScreens.detectCardPattern);
    setPaymentDomains(paymentScreens.domains);
    setIncognitoEnabled(incognito.enabled);
    setIncognitoBrowsers(incognito.browsers);
  }, [privacyKey]);
```

Then update the destructuring:

`old_string`:
```
    const { excludedApps, excludedSites, paymentScreens } = normalizePrivacyFromSettings(privacySec);
```

`new_string`:
```
    const { excludedApps, excludedSites, paymentScreens, incognito } = normalizePrivacyFromSettings(privacySec);
```

- [ ] **Step 5: Insert the Incognito card immediately after the Payment Screens card**

Use Edit on `hifi/settings-modal.jsx`. Find the closing `</div>` of the Payment Screens card from Task 8 (the one immediately before the tab control row) and insert the Incognito card between them. The tab-control row starts with `<div className="row" style={{gap:4, background:'var(--surface)', ...`. Use the unique end-of-payment marker:

`old_string`:
```
            >
              Add domain
            </button>
          </div>
        </div>
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
```

`new_string`:
```
            >
              Add domain
            </button>
          </div>
        </div>
      </div>
      <div className="s-card" style={{ marginBottom: 14 }}>
        <Row
          title="Private browsing"
          desc="Skip captures when a supported browser's window is in incognito / private mode (detected from the window title)."
        >
          <Toggle
            on={incognitoEnabled}
            onClick={async () => {
              const next = !incognitoEnabled;
              setIncognitoEnabled(next);
              await persistPrivacy(apps, sites, { incognitoEnabled: next });
            }}
          />
        </Row>
        {[
          { key: 'safari',  label: 'Safari (and Technology Preview)' },
          { key: 'chrome',  label: 'Chrome / Chromium / Brave / Opera / Vivaldi' },
          { key: 'arc',     label: 'Arc' },
          { key: 'firefox', label: 'Firefox (and Developer / Nightly)' },
          { key: 'edge',    label: 'Microsoft Edge' },
        ].map((row, i, arr) => (
          <Row
            key={row.key}
            title={row.label}
            desc={`Match incognito titles for ${row.label}.`}
            last={i === arr.length - 1}
          >
            <Toggle
              on={!!incognitoBrowsers[row.key]}
              onClick={async () => {
                const next = { ...incognitoBrowsers, [row.key]: !incognitoBrowsers[row.key] };
                setIncognitoBrowsers(next);
                await persistPrivacy(apps, sites, { incognitoBrowsers: next });
              }}
            />
          </Row>
        ))}
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
```

- [ ] **Step 6: Verify**

Run: `python3 hifi/scripts/check-actions.py 2>&1 | tail -10`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add hifi/settings-modal.jsx
git commit -m "feat(filter): PanePrivacy — Private browsing card"
```

---

## Task 10: Settings UI — Quiet Hours card

**Files:**
- Modify: `hifi/settings-modal.jsx` (extend `normalizePrivacyFromSettings`, add state, extend `persistPrivacy`, hydrate, append the new card)

Quiet-hours rows are a list with a "+ Add" button. Each row: label input + start/end `<input type="time">` + 7 day toggles + enable + remove.

- [ ] **Step 1: Add the day-bitmask helpers and a default-row factory near the existing privacy constants**

Use Edit on `hifi/settings-modal.jsx`. Insert immediately after the `DEFAULT_PAYMENT_DOMAINS` constant added in Task 8 step 2:

`old_string`:
```
  { id: 'pd-billing',    host: 'billing.stripe.com',    label: 'Stripe Billing',   enabled: true },
];
```

`new_string`:
```
  { id: 'pd-billing',    host: 'billing.stripe.com',    label: 'Stripe Billing',   enabled: true },
];

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function timeBlockMinutesToHHMM(m) {
  const mm = Math.max(0, Math.min(1439, Number(m) || 0));
  const h = Math.floor(mm / 60);
  const min = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function hhmmToMinutes(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return 0;
  const h = Math.max(0, Math.min(23, parseInt(m[1], 10)));
  const min = Math.max(0, Math.min(59, parseInt(m[2], 10)));
  return h * 60 + min;
}

function newQuietBlock() {
  return {
    id: `tb-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    label: '',
    startMinute: 22 * 60,
    endMinute: 7 * 60,
    days: 0x7F,
    enabled: true,
  };
}
```

- [ ] **Step 2: Extend `normalizePrivacyFromSettings` to round-trip time blocks**

Use Edit on `hifi/settings-modal.jsx`. Find the `incognito` object from Task 9 step 1:

`old_string`:
```
  const incognito = {
    enabled: inc && typeof inc.enabled === 'boolean' ? inc.enabled : true,
    browsers: {
      safari: readBool(incBrowsers.safari, true),
      chrome: readBool(incBrowsers.chrome, true),
      arc: readBool(incBrowsers.arc, true),
      firefox: readBool(incBrowsers.firefox, true),
      edge: readBool(incBrowsers.edge, true),
    },
  };
  return {
```

`new_string`:
```
  const incognito = {
    enabled: inc && typeof inc.enabled === 'boolean' ? inc.enabled : true,
    browsers: {
      safari: readBool(incBrowsers.safari, true),
      chrome: readBool(incBrowsers.chrome, true),
      arc: readBool(incBrowsers.arc, true),
      firefox: readBool(incBrowsers.firefox, true),
      edge: readBool(incBrowsers.edge, true),
    },
  };
  const rawBlocks = Array.isArray(sec && sec.timeBlocks) ? sec.timeBlocks : [];
  const timeBlocks = rawBlocks
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => {
      const sm = Math.max(0, Math.min(1439, Number(r.startMinute) || 0));
      const em = Math.max(0, Math.min(1439, Number(r.endMinute) || 0));
      const days = (Number(r.days) || 0) & 0x7F;
      return {
        id: String(r.id || `tb-${i}`),
        label: r.label != null ? String(r.label) : '',
        startMinute: sm,
        endMinute: em,
        days,
        enabled: r.enabled !== false,
      };
    });
  return {
```

Then update the returned object:

`old_string`:
```
    paymentScreens,
    incognito,
  };
}
```

`new_string`:
```
    paymentScreens,
    incognito,
    timeBlocks,
  };
}
```

- [ ] **Step 3: Add quiet-hours state inside `PanePrivacy`**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
  const [incognitoEnabled, setIncognitoEnabled] = useStateS(true);
  const [incognitoBrowsers, setIncognitoBrowsers] = useStateS({
    safari: true, chrome: true, arc: true, firefox: true, edge: true,
  });
```

`new_string`:
```
  const [incognitoEnabled, setIncognitoEnabled] = useStateS(true);
  const [incognitoBrowsers, setIncognitoBrowsers] = useStateS({
    safari: true, chrome: true, arc: true, firefox: true, edge: true,
  });
  const [timeBlocks, setTimeBlocks] = useStateS([]);
```

- [ ] **Step 4: Extend `persistPrivacy` to include time blocks**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
          incognito: {
            enabled: 'incognitoEnabled' in o ? o.incognitoEnabled : incognitoEnabled,
            browsers: 'incognitoBrowsers' in o ? o.incognitoBrowsers : incognitoBrowsers,
          },
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [
      run,
      refreshSections,
      allowServerMemoryAssembly,
      paymentEnabled,
      paymentDetectCard,
      paymentDomains,
      incognitoEnabled,
      incognitoBrowsers,
    ],
  );
```

`new_string`:
```
          incognito: {
            enabled: 'incognitoEnabled' in o ? o.incognitoEnabled : incognitoEnabled,
            browsers: 'incognitoBrowsers' in o ? o.incognitoBrowsers : incognitoBrowsers,
          },
          timeBlocks: 'timeBlocks' in o ? o.timeBlocks : timeBlocks,
        },
        { silentError: true },
      );
      if (r && r.ok && refreshSections) await refreshSections();
      if (r && r.ok) notifyPrivacySettingsChanged({ allowChatServerMemoryAssembly: allowServerMemoryAssembly });
      return r;
    },
    [
      run,
      refreshSections,
      allowServerMemoryAssembly,
      paymentEnabled,
      paymentDetectCard,
      paymentDomains,
      incognitoEnabled,
      incognitoBrowsers,
      timeBlocks,
    ],
  );
```

- [ ] **Step 5: Hydrate time blocks**

Use Edit on `hifi/settings-modal.jsx`:

`old_string`:
```
    const { excludedApps, excludedSites, paymentScreens, incognito } = normalizePrivacyFromSettings(privacySec);
```

`new_string`:
```
    const { excludedApps, excludedSites, paymentScreens, incognito, timeBlocks: tb } = normalizePrivacyFromSettings(privacySec);
```

`old_string`:
```
    setIncognitoEnabled(incognito.enabled);
    setIncognitoBrowsers(incognito.browsers);
  }, [privacyKey]);
```

`new_string`:
```
    setIncognitoEnabled(incognito.enabled);
    setIncognitoBrowsers(incognito.browsers);
    setTimeBlocks(tb);
  }, [privacyKey]);
```

- [ ] **Step 6: Insert the Quiet Hours card immediately after the Incognito card**

Use Edit on `hifi/settings-modal.jsx`. Find the end of the Incognito card (closes with `</div>` before the tab-control row) — the unique anchor is the `Microsoft Edge` row mapping ending. Insert the new card before the tab-control row:

`old_string`:
```
            <Toggle
              on={!!incognitoBrowsers[row.key]}
              onClick={async () => {
                const next = { ...incognitoBrowsers, [row.key]: !incognitoBrowsers[row.key] };
                setIncognitoBrowsers(next);
                await persistPrivacy(apps, sites, { incognitoBrowsers: next });
              }}
            />
          </Row>
        ))}
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
```

`new_string`:
```
            <Toggle
              on={!!incognitoBrowsers[row.key]}
              onClick={async () => {
                const next = { ...incognitoBrowsers, [row.key]: !incognitoBrowsers[row.key] };
                setIncognitoBrowsers(next);
                await persistPrivacy(apps, sites, { incognitoBrowsers: next });
              }}
            />
          </Row>
        ))}
      </div>
      <div className="s-card" style={{ marginBottom: 14, padding: '12px 16px 14px' }}>
        <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Quiet hours</div>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const next = timeBlocks.concat([newQuietBlock()]);
              setTimeBlocks(next);
              await persistPrivacy(apps, sites, { timeBlocks: next });
            }}
          >
            + Add quiet block
          </button>
        </div>
        <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 11 }}>
          Captures are skipped during these windows. Cross-midnight ranges (e.g. 22:00–07:00) are supported and applied based on the selected days.
        </div>
        {timeBlocks.length === 0 ? (
          <div className="s-field-hint" style={{ padding: 8 }}>No quiet blocks configured.</div>
        ) : (
          <div className="s-card">
            {timeBlocks.map((tb, i, arr) => (
              <div key={tb.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <input
                    className="s-input"
                    style={{ flex: 1 }}
                    placeholder="Label (optional)"
                    value={tb.label}
                    onChange={(e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, label: e.target.value } : x);
                      setTimeBlocks(next);
                    }}
                    onBlur={async () => {
                      await persistPrivacy(apps, sites, { timeBlocks });
                    }}
                  />
                  <input
                    type="time"
                    className="s-input"
                    style={{ width: 110 }}
                    value={timeBlockMinutesToHHMM(tb.startMinute)}
                    onChange={async (e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, startMinute: hhmmToMinutes(e.target.value) } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                  <span style={{ color: 'var(--text-dim)' }}>–</span>
                  <input
                    type="time"
                    className="s-input"
                    style={{ width: 110 }}
                    value={timeBlockMinutesToHHMM(tb.endMinute)}
                    onChange={async (e) => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, endMinute: hhmmToMinutes(e.target.value) } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="Remove quiet block"
                    onClick={async () => {
                      const next = timeBlocks.filter((x) => x.id !== tb.id);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  >
                    ×
                  </button>
                  <Toggle
                    on={tb.enabled}
                    onClick={async () => {
                      const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, enabled: !x.enabled } : x);
                      setTimeBlocks(next);
                      await persistPrivacy(apps, sites, { timeBlocks: next });
                    }}
                  />
                </div>
                <div className="row" style={{ gap: 4, marginTop: 8 }}>
                  {DAY_LABELS.map((lbl, dayIdx) => {
                    const bit = 1 << dayIdx;
                    const on = (tb.days & bit) !== 0;
                    return (
                      <button
                        key={dayIdx}
                        type="button"
                        className="btn btn-sm"
                        style={{ width: 28, padding: 0, background: on ? 'var(--accent)' : 'var(--surface-2)', color: on ? 'var(--on-accent)' : 'inherit' }}
                        onClick={async () => {
                          const nextDays = on ? tb.days & ~bit : tb.days | bit;
                          const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, days: nextDays & 0x7F } : x);
                          setTimeBlocks(next);
                          await persistPrivacy(apps, sites, { timeBlocks: next });
                        }}
                      >
                        {lbl}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="row" style={{gap:4, background:'var(--surface)', border:'1px solid var(--border)', padding:3, borderRadius:'var(--radius-md)', width:'fit-content', marginBottom:14}}>
```

- [ ] **Step 7: Verify**

Run: `python3 hifi/scripts/check-actions.py 2>&1 | tail -10`
Expected: success.

- [ ] **Step 8: Commit**

```bash
git add hifi/settings-modal.jsx
git commit -m "feat(filter): PanePrivacy — Quiet hours card"
```

---

## Task 11: Final verification + manual smoke + plan completion

**Files:** none

This task runs the full project verification gates and the manual smoke per spec § 8.2. No code changes — just the green-light commit if everything holds.

- [ ] **Step 1: Run the full Rust gate**

Run: `npm run check:rust 2>&1 | tail -30`
Expected: success — no clippy warnings introduced, all tests pass. If `npm run check:rust` does not exist, run `cargo clippy -p app --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings 2>&1 | tail -30` and `cargo test -p app --manifest-path src-tauri/Cargo.toml 2>&1 | tail -30`.

- [ ] **Step 2: Run the IPC-action audit**

Run: `python3 hifi/scripts/check-actions.py 2>&1 | tail -10`
Expected: no new actions added; existing actions still pass.

- [ ] **Step 3: Build the frontend**

Run: `npm run build 2>&1 | tail -15`
Expected: build succeeds. If a separate dev server is required for manual smoke, also run `npm run dev` in another terminal.

- [ ] **Step 4: Manual smoke per spec § 8.2 (record results in commit message)**

Walk these four scenarios and record pass/fail:

1. Open Stripe checkout in Safari (e.g. https://checkout.stripe.com/c/pay/cs_test_anything). Wait one sample interval (~8s, see Settings → Capture). Verify nothing related to that window appears in `mem_items` — query via the existing memory-debug pane or via `kioku_debug_stats` IPC.
2. Open a Safari Private window and visit any site. Verify nothing from that window is captured.
3. Add a Quiet Hours block covering the next 5 minutes (any day-of-week including today). Verify no captures during that window. Then disable the block and verify captures resume.
4. Open Settings → Privacy → toggle "Payment screens" off. Re-test (1) — captures should resume.

Stop and investigate before declaring "Done" if any scenario fails.

- [ ] **Step 5: Final commit (only if smoke passes)**

```bash
git commit --allow-empty -m "chore(filter): Phase 2.0a complete — manual smoke green (4/4 scenarios)"
```

If smoke fails, do NOT commit this. File a follow-up issue describing the failing scenario, fix it, re-run from Step 4.

- [ ] **Step 6: Push the branch and open a draft PR**

```bash
git push -u origin feat/cloud-2-0a-sensitive-filter 2>&1 | tail -5
```

Open a PR via `gh pr create --draft --title "feat(privacy): Phase 2.0a — sensitive filter extensions" --body-file - <<'EOF'
## Summary
- Adds payment-screen / incognito-window / quiet-hours capture filters as the cloud-prerequisites slice of Phase 2.x
- New `src-tauri/src/sensitive_filter.rs` (~280 LOC, 23 unit tests)
- Extends `PanePrivacy` with three new settings cards
- No schema changes (sync_status column deferred to Phase 2.0b)

## Spec
- Phase 2.0a design: `docs/superpowers/specs/2026-04-30-sensitive-filter-extensions-design.md`
- Master architecture: `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.2

## Test plan
- [x] `cargo test -p app sensitive_filter` — 23/23 passing
- [x] `npm run check:rust` — clean
- [x] `python3 hifi/scripts/check-actions.py` — no new IPC actions
- [x] Manual smoke (4 scenarios from spec § 8.2)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF`
