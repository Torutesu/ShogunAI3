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
    .enumerate()
    .filter_map(|(i, row)| {
      let id = row.get("id").and_then(|v| v.as_str()).unwrap_or("");
      let label = row.get("label").and_then(|v| v.as_str()).unwrap_or("");
      let drop = |reason: &str| -> Option<TimeBlock> {
        log::warn!(
          "sensitive_filter: skipping time block row index={} id={:?} label={:?} reason={}",
          i, id, label, reason
        );
        None
      };
      let Some(start_minute) = row.get("startMinute").and_then(|v| v.as_u64()) else {
        return drop("missing or non-integer startMinute");
      };
      let Some(end_minute) = row.get("endMinute").and_then(|v| v.as_u64()) else {
        return drop("missing or non-integer endMinute");
      };
      if start_minute > 1439 || end_minute > 1439 {
        return drop(&format!(
          "out-of-range minute(s) start={} end={}",
          start_minute, end_minute
        ));
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
        start_minute: start_minute as u16,
        end_minute: end_minute as u16,
        days,
        enabled,
      })
    })
    .collect()
}

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

// Intentional duplication of `capture_sampler::ax_text_excluded`'s URL-parsing
// loop (per design spec § 4.1 — this module stays self-contained). Differences
// from the cousin: (1) adds a scheme-recovery preamble for AX tokens like
// `value=https://...` (no whitespace before the scheme); (2) does NOT scan for
// bare hostnames — payment screens are recognized via URLs, not body text.
//
// Known limitations of the rfind(non-alphabetic) scheme recovery:
//  - False positive: `badhttps://stripe.com` parses successfully as a URL with
//    scheme=`badhttps` and host=`stripe.com`. Acceptable; an alpha word glued
//    directly to a real URL is not a real-world AX text shape.
//  - False negative: schemes containing `+`/`-`/`.` (e.g. `coap+tcp://host`)
//    will be truncated. Not a concern for HTTPS payment sites.
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
    // The token may be prefixed with non-URL text (e.g. "value=https://...").
    // Find where the scheme starts by scanning back from "://" for ASCII alpha chars.
    let url_start = tok
      .find("://")
      .map(|sep| {
        let prefix = &tok[..sep];
        let scheme_start = prefix
          .rfind(|c: char| !c.is_ascii_alphabetic())
          .map(|i| i + 1)
          .unwrap_or(0);
        scheme_start
      })
      .unwrap_or(0);
    let raw = &tok[url_start..];
    let clean = raw.trim_end_matches(|c: char| {
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
    // English variants use \b (word boundary). Japanese alternatives are
    // bare matches because Unicode word boundaries are unreliable for CJK.
    regex::Regex::new(
      r"(?i)\b(?:cvv|cvc|cid|security[ ]?code|card[ ]?verification[ ]?value)\b|セキュリティコード|セキュリティ番号"
    )
    .unwrap()
  });
  // Run CVV first: shorter alternation, fails fast on the common no-payment case.
  cvv.is_match(ax_text) && card.is_match(ax_text)
}

pub fn is_incognito_window(
  rules: &IncognitoRules,
  app_name: &str,
  window_title: &str,
) -> bool {
  if !rules.enabled {
    return false;
  }
  let app = app_name.trim().to_ascii_lowercase();
  let title_lower = window_title.to_ascii_lowercase();
  match app.as_str() {
    "safari" | "safari technology preview" => {
      rules.safari
        && (window_title.starts_with("Private — ") || title_lower.contains("private browsing"))
    }
    "google chrome" | "chromium" | "brave browser" | "opera" | "vivaldi" => {
      rules.chrome
        && (title_lower.contains("(incognito)") || title_lower.contains("(private)"))
    }
    // Arc supports both "incognito" (Chromium roots) and "private" terminology
    // depending on version; match either.
    "arc" => {
      rules.arc && (title_lower.contains("incognito") || title_lower.contains("private"))
    }
    "firefox" | "firefox developer edition" | "firefox nightly" => {
      rules.firefox
        && (window_title.ends_with("(Private Browsing)")
          || title_lower.contains("private browsing"))
    }
    "microsoft edge" => {
      rules.edge && (window_title.contains("[InPrivate]") || title_lower.contains("inprivate"))
    }
    _ => false,
  }
}

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

pub fn extract_window_title(ax_text: &str) -> Option<&str> {
  for line in ax_text.lines() {
    if let Some(rest) = line.strip_prefix("window=") {
      return Some(rest);
    }
  }
  None
}

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

  #[test]
  fn card_pattern_with_jp_security_code_keyword_fires() {
    let r = payment_rules_with(vec![], true);
    assert!(is_payment_signal(
      &r,
      "value=4111 1111 1111 1111\nlabel=セキュリティコード"
    ));
    assert!(is_payment_signal(
      &r,
      "value=4111 1111 1111 1111\nlabel=セキュリティ番号"
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
    assert!(is_incognito_window(&r, "Brave Browser", "Search (Incognito)"));
  }

  #[test]
  fn incognito_arc_matches_both_incognito_and_private_terms() {
    let r = incognito_all_on();
    assert!(is_incognito_window(&r, "Arc", "Some tab — Incognito"));
    assert!(is_incognito_window(&r, "Arc", "Private window"));
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

  #[test]
  fn incognito_browser_disabled_in_settings_does_not_fire() {
    let mut r = incognito_all_on();
    r.chrome = false;
    assert!(!is_incognito_window(&r, "Google Chrome", "Page (Incognito)"));
    // Chromium fallback also disabled — same family.
    assert!(!is_incognito_window(&r, "Brave Browser", "Page (Incognito)"));
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
