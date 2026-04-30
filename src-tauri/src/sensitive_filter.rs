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
