//! PII redaction module.
//!
//! Strips/masks personally identifiable information from captured screen text
//! before it is ingested into the memory database. The capture pipeline runs
//! text through `redact_pii` (or `redact_pii_with_config`) so we can train on
//! rich signal without persisting raw secrets.
//!
//! Detection is regex-based and conservative — we err on the side of redacting
//! when in doubt. Idempotency is guaranteed: redacted tokens (`[EMAIL]`,
//! `[PHONE]`, `[CARD]`, `[ID]`, `[IP]`, or a configured `mask_token`) do not
//! contain characters that the detectors will match a second time, so
//! `redact_pii(redact_pii(x)) == redact_pii(x)`.
//!
//! Settings shape (read via `config_from_settings`):
//!
//! ```jsonc
//! {
//!   "sections": {
//!     "privacy": {
//!       "piiRedaction": {
//!         "maskEmails": true,
//!         "maskPhones": true,
//!         "maskCreditCards": true,
//!         "maskJpMyNumber": true,
//!         "maskIpAddresses": false,
//!         "maskToken": "[REDACTED]"
//!       }
//!     }
//!   }
//! }
//! ```
//!
//! When `maskToken` is set, every category that fires uses that single token
//! instead of the per-category labels.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;

/// Runtime configuration for the redactor.
#[derive(Clone, Debug)]
pub struct PiiConfig {
  pub mask_emails: bool,
  pub mask_phones: bool,
  pub mask_credit_cards: bool,
  pub mask_jp_my_number: bool,
  pub mask_ip_addresses: bool,
  /// When non-empty, overrides the per-category labels (`[EMAIL]`, `[PHONE]`,
  /// `[CARD]`, `[ID]`, `[IP]`) with a single token. Empty string => use the
  /// per-category labels.
  pub mask_token: String,
}

impl Default for PiiConfig {
  fn default() -> Self {
    Self {
      mask_emails: true,
      mask_phones: true,
      mask_credit_cards: true,
      mask_jp_my_number: true,
      mask_ip_addresses: false,
      mask_token: String::new(),
    }
  }
}

// --- Compiled regexes (one-time init) -------------------------------------

static EMAIL_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(r"(?i)[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}").unwrap()
});

// Combined phone alternation:
//   - JP mobile  (e.g. 090-1234-5678)
//   - US         (e.g. +1 (415) 555-1234)
//   - International E.164-ish (e.g. +44 20 7946 0958)
// JP first so it claims the digits before US/intl steal them.
static PHONE_RE: Lazy<Regex> = Lazy::new(|| {
  Regex::new(
    r"(?x)
      \b 0[789]0 [\s.\-]? \d{4} [\s.\-]? \d{4} \b           # JP mobile
    | \b \+? 1? [\s.\-]? \(? \d{3} \)? [\s.\-]? \d{3} [\s.\-]? \d{4} \b   # US
    | \b \+ \d{1,3} [\s.\-]? \d{4,14} \b                    # International
    ",
  )
  .unwrap()
});

// Candidate credit card sequence: 13–19 digits with optional single
// space/hyphen separators. Luhn-validated downstream.
static CARD_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\b(?:\d[\s\-]?){12,18}\d\b").unwrap());

// Japanese 個人番号 (My Number): bare 12-digit run. False-positive prone
// but conservative.
static MY_NUMBER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\b\d{12}\b").unwrap());

// Loose IPv4. Off by default.
static IP_RE: Lazy<Regex> =
  Lazy::new(|| Regex::new(r"\b(?:\d{1,3}\.){3}\d{1,3}\b").unwrap());

// --- Public API -----------------------------------------------------------

/// Redact PII using default config (emails/phones/cards/My Number on, IP off).
pub fn redact_pii(text: &str) -> String {
  redact_pii_with_config(text, &PiiConfig::default())
}

/// Redact PII using the provided config. Order:
///   1. Emails  (so `foo@bar.com` is never partially eaten by phone digits)
///   2. Phones
///   3. Credit cards (Luhn-validated)
///   4. JP My Number (12 digits — runs AFTER cards so a 16-digit card is not
///      partially redacted as ID)
///   5. IP addresses
pub fn redact_pii_with_config(text: &str, config: &PiiConfig) -> String {
  if text.is_empty() {
    return String::new();
  }

  let mut out: String = text.to_string();

  if config.mask_emails {
    let label = pick_label(config, "[EMAIL]");
    out = EMAIL_RE.replace_all(&out, label.as_str()).into_owned();
  }

  if config.mask_phones {
    let label = pick_label(config, "[PHONE]");
    out = PHONE_RE.replace_all(&out, label.as_str()).into_owned();
  }

  if config.mask_credit_cards {
    let label = pick_label(config, "[CARD]");
    out = redact_credit_cards(&out, &label);
  }

  if config.mask_jp_my_number {
    let label = pick_label(config, "[ID]");
    out = MY_NUMBER_RE.replace_all(&out, label.as_str()).into_owned();
  }

  if config.mask_ip_addresses {
    let label = pick_label(config, "[IP]");
    out = IP_RE.replace_all(&out, label.as_str()).into_owned();
  }

  out
}

/// Read `PiiConfig` from a settings_store doc. Looks at
/// `sections.privacy.piiRedaction.*`. Unknown / missing fields fall back to
/// `PiiConfig::default()`.
pub fn config_from_settings(doc: &Value) -> PiiConfig {
  let defaults = PiiConfig::default();
  let Some(sec) = doc.pointer("/sections/privacy/piiRedaction") else {
    return defaults;
  };

  let get_bool = |key: &str, fallback: bool| -> bool {
    sec.get(key).and_then(|v| v.as_bool()).unwrap_or(fallback)
  };
  let mask_token = sec
    .get("maskToken")
    .and_then(|v| v.as_str())
    .map(|s| s.to_string())
    .unwrap_or_default();

  PiiConfig {
    mask_emails: get_bool("maskEmails", defaults.mask_emails),
    mask_phones: get_bool("maskPhones", defaults.mask_phones),
    mask_credit_cards: get_bool("maskCreditCards", defaults.mask_credit_cards),
    mask_jp_my_number: get_bool("maskJpMyNumber", defaults.mask_jp_my_number),
    mask_ip_addresses: get_bool("maskIpAddresses", defaults.mask_ip_addresses),
    mask_token,
  }
}

// --- Internals ------------------------------------------------------------

fn pick_label(config: &PiiConfig, default_label: &'static str) -> String {
  if config.mask_token.is_empty() {
    default_label.to_string()
  } else {
    config.mask_token.clone()
  }
}

/// Replace Luhn-valid 13–19 digit sequences with `label`. Non-Luhn matches
/// are left untouched.
fn redact_credit_cards(text: &str, label: &str) -> String {
  let mut result = String::with_capacity(text.len());
  let mut last_end = 0;
  for m in CARD_RE.find_iter(text) {
    let candidate = &text[m.start()..m.end()];
    let digits: String = candidate.chars().filter(|c| c.is_ascii_digit()).collect();
    if (13..=19).contains(&digits.len()) && luhn_valid(&digits) {
      result.push_str(&text[last_end..m.start()]);
      result.push_str(label);
      last_end = m.end();
    }
  }
  result.push_str(&text[last_end..]);
  result
}

/// Standard Luhn / mod-10 check. Input must be ASCII digits only.
fn luhn_valid(digits: &str) -> bool {
  if digits.is_empty() {
    return false;
  }
  let mut sum = 0u32;
  let mut double = false;
  for ch in digits.chars().rev() {
    let Some(d) = ch.to_digit(10) else {
      return false;
    };
    if double {
      let dd = d * 2;
      sum += if dd > 9 { dd - 9 } else { dd };
    } else {
      sum += d;
    }
    double = !double;
  }
  sum % 10 == 0
}

// --- Tests ----------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[test]
  fn redacts_email() {
    let out = redact_pii("Contact me at foo@bar.com please");
    assert!(out.contains("[EMAIL]"), "got: {out}");
    assert!(!out.contains("foo@bar.com"), "got: {out}");
  }

  #[test]
  fn redacts_jp_mobile() {
    let out = redact_pii("Call 090-1234-5678 tonight");
    assert!(out.contains("[PHONE]"), "got: {out}");
    assert!(!out.contains("090-1234-5678"), "got: {out}");
  }

  #[test]
  fn redacts_us_phone() {
    let out = redact_pii("Reach me at +1 (415) 555-1234 weekdays");
    assert!(out.contains("[PHONE]"), "got: {out}");
  }

  #[test]
  fn redacts_valid_credit_card() {
    // 4111 1111 1111 1111 is the classic Visa test card (Luhn-valid).
    let out = redact_pii("My card 4111 1111 1111 1111 is fine");
    assert!(out.contains("[CARD]"), "got: {out}");
    assert!(!out.contains("4111 1111 1111 1111"), "got: {out}");
  }

  #[test]
  fn skips_invalid_credit_card() {
    // 4111 1111 1111 1112 fails Luhn — must NOT be redacted as a card.
    let raw = "Not a card 4111 1111 1111 1112 here";
    let out = redact_pii(raw);
    assert!(!out.contains("[CARD]"), "got: {out}");
  }

  #[test]
  fn redacts_jp_my_number() {
    let out = redact_pii("マイナンバー 123456789012 を保存");
    assert!(out.contains("[ID]"), "got: {out}");
    assert!(!out.contains("123456789012"), "got: {out}");
  }

  #[test]
  fn ip_off_by_default() {
    let out = redact_pii("Server at 192.168.1.1 is up");
    assert!(!out.contains("[IP]"), "got: {out}");
    assert!(out.contains("192.168.1.1"), "got: {out}");
  }

  #[test]
  fn ip_on_via_config() {
    let cfg = PiiConfig {
      mask_ip_addresses: true,
      ..Default::default()
    };
    let out = redact_pii_with_config("Server at 192.168.1.1 is up", &cfg);
    assert!(out.contains("[IP]"), "got: {out}");
    assert!(!out.contains("192.168.1.1"), "got: {out}");
  }

  #[test]
  fn multiline_multi_pii() {
    let input = "\
Email: alice@example.com
Phone: 090-1234-5678
Card: 4111 1111 1111 1111
ID: 123456789012
";
    let out = redact_pii(input);
    assert!(out.contains("[EMAIL]"), "got: {out}");
    assert!(out.contains("[PHONE]"), "got: {out}");
    assert!(out.contains("[CARD]"), "got: {out}");
    assert!(out.contains("[ID]"), "got: {out}");
    assert!(!out.contains("alice@example.com"));
    assert!(!out.contains("090-1234-5678"));
    assert!(!out.contains("4111 1111 1111 1111"));
    assert!(!out.contains("123456789012"));
  }

  #[test]
  fn japanese_email_midstring_utf8_safe() {
    let out = redact_pii("私のメールは foo@bar.com です");
    assert_eq!(out, "私のメールは [EMAIL] です");
  }

  #[test]
  fn idempotent() {
    let input = "Email alice@example.com phone 090-1234-5678 card 4111 1111 1111 1111 id 123456789012";
    let once = redact_pii(input);
    let twice = redact_pii(&once);
    assert_eq!(once, twice, "redact must be idempotent");
  }

  #[test]
  fn empty_input() {
    assert_eq!(redact_pii(""), "");
  }

  #[test]
  fn custom_mask_token_overrides_all_labels() {
    let cfg = PiiConfig {
      mask_token: "[REDACTED]".to_string(),
      mask_ip_addresses: true,
      ..Default::default()
    };
    let out = redact_pii_with_config(
      "alice@example.com 090-1234-5678 192.168.1.1 123456789012",
      &cfg,
    );
    assert!(out.contains("[REDACTED]"));
    assert!(!out.contains("[EMAIL]"));
    assert!(!out.contains("[PHONE]"));
    assert!(!out.contains("[IP]"));
    assert!(!out.contains("[ID]"));
  }

  #[test]
  fn config_from_settings_defaults_when_absent() {
    let cfg = config_from_settings(&json!({}));
    assert!(cfg.mask_emails);
    assert!(cfg.mask_phones);
    assert!(cfg.mask_credit_cards);
    assert!(cfg.mask_jp_my_number);
    assert!(!cfg.mask_ip_addresses);
    assert_eq!(cfg.mask_token, "");
  }

  #[test]
  fn config_from_settings_reads_flags() {
    let doc = json!({
      "sections": {
        "privacy": {
          "piiRedaction": {
            "maskEmails": false,
            "maskIpAddresses": true,
            "maskToken": "[X]"
          }
        }
      }
    });
    let cfg = config_from_settings(&doc);
    assert!(!cfg.mask_emails);
    assert!(cfg.mask_phones); // default preserved
    assert!(cfg.mask_ip_addresses);
    assert_eq!(cfg.mask_token, "[X]");
  }

  #[test]
  fn luhn_check() {
    assert!(luhn_valid("4111111111111111"));
    assert!(luhn_valid("5500000000000004"));
    assert!(!luhn_valid("4111111111111112"));
    assert!(!luhn_valid(""));
    assert!(!luhn_valid("abcd"));
  }

  #[test]
  fn does_not_redact_short_digit_run_as_card() {
    // 12 digits — too short for a card (min 13), should not produce [CARD].
    let out = redact_pii("ref 123456789012 ok"); // 12 digits => My Number, not card
    assert!(!out.contains("[CARD]"), "got: {out}");
    assert!(out.contains("[ID]"));
  }

  #[test]
  fn email_inside_japanese_text_no_panic() {
    // Mixed multi-byte input — ensure no slicing panic.
    let s = "連絡先：太郎 <taro@例.com> 090-1234-5678 までどうぞ";
    let _ = redact_pii(s); // ASCII-domain email won't match here, but must not panic
  }
}
