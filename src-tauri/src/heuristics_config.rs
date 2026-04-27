//! Loads `heuristic_patterns.toml` from the user's app-data directory at
//! startup, copying the bundled default on first launch. Cached in a
//! `OnceCell` for the rest of the process lifetime — restart-only reload.
//!
//! See spec: docs/superpowers/specs/2026-04-27-memory-digest-heuristic-externalization-design.md

use once_cell::sync::OnceCell;
use serde::Deserialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub const SCHEMA_VERSION: u32 = 1;

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
  pub priority: String,
  pub reason: String,
  #[serde(default)]
  pub reason_jp: Option<String>,
}

fn default_schema_version() -> u32 { SCHEMA_VERSION }

static CONFIG: OnceCell<HeuristicConfig> = OnceCell::new();
// The OnceCell prevents multiple writes; the Mutex lets test code reset it
// even though OnceCell itself is set-once. set_for_test bypasses CONFIG and
// uses a separate test-only override map (see TEST_OVERRIDE).
#[cfg(test)]
static TEST_OVERRIDE: Mutex<Option<&'static HeuristicConfig>> = Mutex::new(None);

fn empty_config() -> HeuristicConfig {
  HeuristicConfig {
    schema_version: SCHEMA_VERSION,
    gmail: GmailRules { sender_contains: Vec::new() },
  }
}

/// Strip rules that are obviously invalid (empty pattern, bad priority).
/// Logs warnings naming the offending rule's pattern. Returns the cleaned
/// config (caller passes it on to OnceCell).
fn validate(mut cfg: HeuristicConfig) -> HeuristicConfig {
  if cfg.schema_version != SCHEMA_VERSION {
    log::warn!(
      "heuristic_patterns.toml schema_version={} not supported (expected {}); using empty config",
      cfg.schema_version, SCHEMA_VERSION,
    );
    return empty_config();
  }
  cfg.gmail.sender_contains.retain(|r| {
    if r.pattern.trim().is_empty() {
      log::warn!("heuristic_patterns.toml: dropping rule with empty pattern");
      return false;
    }
    if !matches!(r.priority.as_str(), "high" | "medium" | "low") {
      log::warn!(
        "heuristic_patterns.toml: dropping rule pattern={} with invalid priority={}",
        r.pattern, r.priority,
      );
      return false;
    }
    true
  });
  cfg
}

/// Resolve the user TOML path, copy the bundled default if absent, parse,
/// validate, and cache. Idempotent — calling twice is a no-op.
/// On any error, caches an empty config and returns Ok (so the app boots).
pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
  if CONFIG.get().is_some() {
    return Ok(());
  }
  let cfg = match try_load(app) {
    Ok(c) => validate(c),
    Err(e) => {
      log::warn!("heuristic_patterns load failed: {}; using empty config", e);
      empty_config()
    }
  };
  // OnceCell::set returns Err if already set — race with another init() call;
  // ignore (idempotent semantics).
  let _ = CONFIG.set(cfg);
  Ok(())
}

fn try_load(app: &tauri::AppHandle) -> Result<HeuristicConfig, String> {
  let app_data = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("app_data_dir: {}", e))?;
  std::fs::create_dir_all(&app_data)
    .map_err(|e| format!("create app_data dir: {}", e))?;
  let user_path: PathBuf = app_data.join("heuristic_patterns.toml");

  if !user_path.exists() {
    let default_path = app
      .path()
      .resolve(
        "resources/heuristic_patterns.default.toml",
        tauri::path::BaseDirectory::Resource,
      )
      .map_err(|e| format!("resolve bundled default: {}", e))?;
    std::fs::copy(&default_path, &user_path)
      .map_err(|e| format!("copy default to user file: {}", e))?;
  }

  let contents = std::fs::read_to_string(&user_path)
    .map_err(|e| format!("read user file: {}", e))?;
  let cfg: HeuristicConfig = toml::from_str(&contents)
    .map_err(|e| format!("parse user file: {}", e))?;
  Ok(cfg)
}

/// Return the cached config. Before init or on init failure, returns a
/// reference to a static empty config.
pub fn get() -> &'static HeuristicConfig {
  static EMPTY: OnceCell<HeuristicConfig> = OnceCell::new();
  // Tests bypass the OnceCell to allow per-test overrides.
  #[cfg(test)]
  {
    if let Ok(g) = TEST_OVERRIDE.lock() {
      if let Some(c) = *g {
        // Pointer is already 'static — set_for_test leaked the box once
        // when the override was installed.
        return c;
      }
    }
  }
  if let Some(c) = CONFIG.get() {
    return c;
  }
  EMPTY.get_or_init(empty_config)
}

#[cfg(test)]
pub fn set_for_test(c: HeuristicConfig) {
  // Leak the box once when the override is installed; subsequent get()
  // calls just dereference the static pointer (no per-call allocation).
  let leaked: &'static HeuristicConfig = Box::leak(Box::new(c));
  let mut g = TEST_OVERRIDE.lock().unwrap();
  *g = Some(leaked);
}

#[cfg(test)]
pub fn clear_for_test() {
  let mut g = TEST_OVERRIDE.lock().unwrap();
  *g = None;
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parse_full_toml() {
    let raw = r#"
schema_version = 1

[[gmail.sender_contains]]
pattern = "no-reply@"
priority = "low"
reason = "Auto"
reason_jp = "自動"

[[gmail.sender_contains]]
pattern = "ci@"
priority = "low"
reason = "CI"
"#;
    let cfg: HeuristicConfig = toml::from_str(raw).expect("parse");
    let cfg = validate(cfg);
    assert_eq!(cfg.gmail.sender_contains.len(), 2);
    assert_eq!(cfg.gmail.sender_contains[0].pattern, "no-reply@");
    assert_eq!(cfg.gmail.sender_contains[0].reason_jp.as_deref(), Some("自動"));
    assert!(cfg.gmail.sender_contains[1].reason_jp.is_none());
  }

  #[test]
  fn schema_mismatch_returns_empty() {
    let raw = r#"
schema_version = 99
[[gmail.sender_contains]]
pattern = "no-reply@"
priority = "low"
reason = "Auto"
"#;
    let cfg: HeuristicConfig = toml::from_str(raw).expect("parse");
    let cfg = validate(cfg);
    assert_eq!(cfg.schema_version, SCHEMA_VERSION);
    assert_eq!(cfg.gmail.sender_contains.len(), 0);
  }

  #[test]
  fn invalid_priority_drops_just_that_rule() {
    let raw = r#"
schema_version = 1
[[gmail.sender_contains]]
pattern = "ok@"
priority = "low"
reason = "Auto"

[[gmail.sender_contains]]
pattern = "bad@"
priority = "urgent"
reason = "Auto"
"#;
    let cfg: HeuristicConfig = toml::from_str(raw).expect("parse");
    let cfg = validate(cfg);
    assert_eq!(cfg.gmail.sender_contains.len(), 1);
    assert_eq!(cfg.gmail.sender_contains[0].pattern, "ok@");
  }

  #[test]
  fn empty_pattern_dropped() {
    let raw = r#"
schema_version = 1
[[gmail.sender_contains]]
pattern = ""
priority = "low"
reason = "Auto"

[[gmail.sender_contains]]
pattern = "  "
priority = "low"
reason = "Auto"

[[gmail.sender_contains]]
pattern = "ok@"
priority = "low"
reason = "Auto"
"#;
    let cfg: HeuristicConfig = toml::from_str(raw).expect("parse");
    let cfg = validate(cfg);
    assert_eq!(cfg.gmail.sender_contains.len(), 1);
    assert_eq!(cfg.gmail.sender_contains[0].pattern, "ok@");
  }

  #[test]
  fn malformed_toml_errors() {
    let raw = "schema_version = not a number";
    let r: Result<HeuristicConfig, _> = toml::from_str(raw);
    assert!(r.is_err());
  }

  #[test]
  fn set_for_test_overrides_get() {
    let mut c = empty_config();
    c.gmail.sender_contains.push(SenderRule {
      pattern: "test@".into(),
      priority: "low".into(),
      reason: "test".into(),
      reason_jp: None,
    });
    set_for_test(c);
    let g = get();
    assert_eq!(g.gmail.sender_contains.len(), 1);
    clear_for_test();
  }
}
