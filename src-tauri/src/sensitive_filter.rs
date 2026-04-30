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
