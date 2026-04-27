//! User-defined KIOKU rules — Layer 1 of the three-layer architecture.
//!
//! Stored in `settings.json` under `sections.kioku_rules` (an array of rule
//! objects). Loaded once at startup, refreshed on every `settings.save`, and
//! injected at the top of every LLM system prompt by `context_assembly`
//! and the brief / chat / draft / pack call sites.
//!
//! Spec: `docs/memory-architecture/target-design.md` §1.1.

#![allow(dead_code)]

use serde_json::Value;
use std::sync::RwLock;

/// Maximum characters of the rules block injected into a system prompt.
/// Sized to preserve >=8,000 chars for graph context (target-design §4.3).
pub const KIOKU_RULES_BUDGET_CHARS: usize = 2_000;

/// One parsed user rule. `title` is extracted from the `yaml` frontmatter when
/// present (line "title: ..."); otherwise the first non-empty line of `body`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KiokuRule {
  pub id: String,
  pub title: String,
  pub body: String,
}

/// In-memory cache. `None` means "settings not yet loaded"; an empty Vec means
/// "loaded, no rules configured". Distinguishing the two avoids repeated disk
/// reads from inside hot LLM paths.
static RULES_CACHE: RwLock<Option<Vec<KiokuRule>>> = RwLock::new(None);

// ── Parsing (pure) ─────────────────────────────────────────────────────────

/// Best-effort line-based extraction of `title: <value>` from a YAML
/// frontmatter string. Returns `None` if no title line is present.
fn extract_yaml_title(yaml: &str) -> Option<String> {
  for raw in yaml.lines() {
    let line = raw.trim_start();
    let lower = line.trim_start_matches('-').trim_start().to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("title:") {
      // Use original case but skip the prefix length.
      let title_start = line.len() - rest.len();
      let value = line[title_start..].trim().trim_matches('"').trim_matches('\'');
      if !value.is_empty() {
        return Some(value.to_string());
      }
    }
  }
  None
}

fn first_nonempty_line(body: &str) -> Option<String> {
  body
    .lines()
    .map(|l| l.trim())
    .find(|l| !l.is_empty())
    .map(String::from)
}

/// Parse a single `kioku_rules[i]` entry from `settings.json`. Returns None
/// when the entry is malformed (missing id or both title and body empty).
pub fn parse_rule(value: &Value) -> Option<KiokuRule> {
  let id = value.get("id").and_then(|v| v.as_str())?.trim();
  if id.is_empty() {
    return None;
  }
  let body = value
    .get("body")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();
  let yaml = value
    .get("yaml")
    .and_then(|v| v.as_str())
    .unwrap_or("");
  let title = extract_yaml_title(yaml)
    .or_else(|| first_nonempty_line(&body))
    .unwrap_or_default();
  if title.is_empty() && body.is_empty() {
    return None;
  }
  Some(KiokuRule {
    id: id.to_string(),
    title,
    body,
  })
}

/// Parse the full array under `sections.kioku_rules`. Missing or non-array
/// configuration produces an empty Vec (empty kioku_rules section ≡ no rules).
pub fn parse_all_rules(settings: &Value) -> Vec<KiokuRule> {
  let arr = match settings
    .pointer("/sections/kioku_rules")
    .and_then(|v| v.as_array())
  {
    Some(a) => a,
    None => return Vec::new(),
  };
  arr.iter().filter_map(parse_rule).collect()
}

// ── Formatting (pure) ──────────────────────────────────────────────────────

/// Render the Layer 1 system-prompt header. Returns `None` when no rules are
/// configured so callers can skip emitting the prefix entirely. The block is
/// clipped to `max_chars` total characters; rules that don't fit are dropped
/// rather than truncated mid-line.
pub fn format_rules_for_system_prompt(rules: &[KiokuRule], max_chars: usize) -> Option<String> {
  if rules.is_empty() {
    return None;
  }
  let header = "User-defined rules (always honored, do not contradict):\n";
  if max_chars <= header.chars().count() {
    return None;
  }
  let mut out = String::from(header);
  let mut used = header.chars().count();
  for r in rules {
    // Body's first paragraph is most useful; keep it under 240 chars per rule.
    let body_summary = first_nonempty_line(&r.body)
      .unwrap_or_default();
    let body_clipped = if body_summary.chars().count() > 240 {
      let mut s: String = body_summary.chars().take(239).collect();
      s.push('…');
      s
    } else {
      body_summary
    };
    let line = if body_clipped.is_empty() {
      format!("- {}\n", r.title)
    } else if r.title.is_empty() {
      format!("- {}\n", body_clipped)
    } else {
      format!("- {}: {}\n", r.title, body_clipped)
    };
    let line_len = line.chars().count();
    if used + line_len > max_chars {
      // Drop this rule rather than emit a half-line.
      break;
    }
    out.push_str(&line);
    used += line_len;
  }
  if out == header {
    None
  } else {
    Some(out)
  }
}

// ── Cache (production) ─────────────────────────────────────────────────────

/// Replace the in-memory cache with `rules`. Used by both the startup loader
/// and the `settings.save` listener so the next LLM call sees the update
/// without an extra disk read.
pub fn set_cached_rules(rules: Vec<KiokuRule>) {
  if let Ok(mut guard) = RULES_CACHE.write() {
    *guard = Some(rules);
  }
}

/// Return the cached rules, falling back to a fresh disk read when the cache
/// has not been populated yet. The fallback path is intentional for tests
/// and for code paths that run before the startup loader fires.
pub fn cached_rules_or_load() -> Vec<KiokuRule> {
  if let Ok(guard) = RULES_CACHE.read() {
    if let Some(v) = guard.as_ref() {
      return v.clone();
    }
  }
  let settings = crate::settings_store::load().unwrap_or_else(|_| Value::Null);
  let rules = parse_all_rules(&settings);
  set_cached_rules(rules.clone());
  rules
}

/// Reload from disk. Called from `app_settings_save` once `kioku_rules` is
/// observed in the saved payload.
pub fn reload_from_settings_now() {
  let settings = crate::settings_store::load().unwrap_or_else(|_| Value::Null);
  let rules = parse_all_rules(&settings);
  set_cached_rules(rules);
}

/// Convenience for LLM call sites: produce a `{"role": "system", "content": ...}`
/// message containing the rules block, or `None` when no rules are configured.
/// Always reads from cache + falls back to disk when cold.
pub fn leading_system_message() -> Option<Value> {
  let rules = cached_rules_or_load();
  let block = format_rules_for_system_prompt(&rules, KIOKU_RULES_BUDGET_CHARS)?;
  Some(serde_json::json!({
    "role": "system",
    "content": block,
  }))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  // ── parse_rule ─────────────────────────────────────────────────────────
  #[test]
  fn parse_rule_extracts_title_from_yaml_frontmatter() {
    let v = json!({
      "id": "rule_1",
      "yaml": "title: Work in JST\nscope: [chat, brief]\nalways_inject: true",
      "body": "Interpret bare times as Asia/Tokyo unless stated."
    });
    let r = parse_rule(&v).expect("parse");
    assert_eq!(r.id, "rule_1");
    assert_eq!(r.title, "Work in JST");
    assert_eq!(r.body, "Interpret bare times as Asia/Tokyo unless stated.");
  }

  #[test]
  fn parse_rule_falls_back_to_first_body_line_when_no_yaml_title() {
    let v = json!({
      "id": "rule_2",
      "body": "Use JST.\n\nMore details below."
    });
    let r = parse_rule(&v).expect("parse");
    assert_eq!(r.title, "Use JST.");
  }

  #[test]
  fn parse_rule_handles_quoted_yaml_title() {
    let v = json!({
      "id": "rule_3",
      "yaml": "title: \"Quoted Title\"",
      "body": "x"
    });
    let r = parse_rule(&v).expect("parse");
    assert_eq!(r.title, "Quoted Title");
  }

  #[test]
  fn parse_rule_rejects_missing_id() {
    assert!(parse_rule(&json!({ "body": "x" })).is_none());
    assert!(parse_rule(&json!({ "id": "", "body": "x" })).is_none());
    assert!(parse_rule(&json!({ "id": "   ", "body": "x" })).is_none());
  }

  #[test]
  fn parse_rule_rejects_when_title_and_body_both_empty() {
    let v = json!({ "id": "rule_x", "yaml": "scope: []", "body": "  " });
    assert!(parse_rule(&v).is_none());
  }

  // ── parse_all_rules ────────────────────────────────────────────────────
  #[test]
  fn parse_all_rules_returns_empty_when_section_missing() {
    let s = json!({ "sections": { "memory": {} } });
    assert!(parse_all_rules(&s).is_empty());
  }

  #[test]
  fn parse_all_rules_returns_empty_when_section_is_not_array() {
    let s = json!({ "sections": { "kioku_rules": { "id": "rule_1" } } });
    assert!(parse_all_rules(&s).is_empty());
  }

  #[test]
  fn parse_all_rules_filters_malformed_entries() {
    let s = json!({
      "sections": {
        "kioku_rules": [
          { "id": "rule_1", "yaml": "title: A", "body": "ok" },
          { "id": "", "body": "missing id" },
          { "id": "rule_2", "yaml": "title: B", "body": "ok" }
        ]
      }
    });
    let rules = parse_all_rules(&s);
    assert_eq!(rules.len(), 2);
    assert_eq!(rules[0].id, "rule_1");
    assert_eq!(rules[1].id, "rule_2");
  }

  // ── format_rules_for_system_prompt ─────────────────────────────────────
  fn rule(id: &str, title: &str, body: &str) -> KiokuRule {
    KiokuRule {
      id: id.into(),
      title: title.into(),
      body: body.into(),
    }
  }

  #[test]
  fn format_returns_none_for_empty_rules() {
    assert!(format_rules_for_system_prompt(&[], 1000).is_none());
  }

  #[test]
  fn format_emits_header_and_bulleted_rules() {
    let rules = vec![
      rule("r1", "JST", "Interpret bare times as Asia/Tokyo."),
      rule("r2", "Concise", "Reply tersely; no extra preamble."),
    ];
    let out = format_rules_for_system_prompt(&rules, 1000).expect("formatted");
    assert!(out.starts_with("User-defined rules (always honored, do not contradict):\n"));
    assert!(out.contains("- JST: Interpret bare times as Asia/Tokyo."));
    assert!(out.contains("- Concise: Reply tersely; no extra preamble."));
  }

  #[test]
  fn format_drops_rules_that_overflow_budget() {
    let rules = vec![
      rule("r1", "SHORT", "tiny"),
      rule("r2", "LONG", &"x".repeat(2000)),
    ];
    let out = format_rules_for_system_prompt(&rules, 200).expect("formatted");
    assert!(out.contains("SHORT"));
    assert!(!out.contains("LONG"));
    assert!(out.chars().count() <= 200);
  }

  #[test]
  fn format_returns_none_when_only_rule_overflows_budget() {
    let rules = vec![rule("r1", "LONG", &"x".repeat(2000))];
    let out = format_rules_for_system_prompt(&rules, 100);
    assert!(out.is_none(), "got: {:?}", out);
  }

  #[test]
  fn format_handles_rule_with_no_body() {
    let rules = vec![rule("r1", "Title only", "")];
    let out = format_rules_for_system_prompt(&rules, 1000).expect("formatted");
    assert!(out.contains("- Title only\n"));
  }

  // ── set_cached_rules / cached_rules_or_load (in-memory) ────────────────
  #[test]
  fn set_cached_rules_overrides_subsequent_reads() {
    set_cached_rules(vec![rule("r1", "T", "B")]);
    let got = cached_rules_or_load();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].id, "r1");
    // Reset for other tests.
    set_cached_rules(Vec::new());
  }
}
