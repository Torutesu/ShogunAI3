//! Background sampler: macOS frontmost app name ingested as memory (no screenshots).
//! Optional Accessibility-rich snapshot when `sections.capture.axRichCapture` is true.
//! Honors `sections.privacy.excludedApps` / `excludedSites` on every sample.

use crate::{memory_store, settings_store};
#[cfg(target_os = "macos")]
use crate::macos_ax;
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Emitter;

const RATE_LIMIT_MS: u64 = 120_000;

static LAST_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_INGEST_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_EMPTY_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_NOT_TRUSTED_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);
static LAST_INGEST_ERROR_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Returns true and records `now` when at least `interval_ms` has passed since
/// the stored timestamp (or it is missing). Returns false otherwise.
fn should_trigger_now(last: &Mutex<Option<u64>>, now: u64, interval_ms: u64) -> bool {
  let Ok(mut guard) = last.lock() else {
    return false;
  };
  let ready = guard
    .map(|t| now.saturating_sub(t) >= interval_ms)
    .unwrap_or(true);
  if ready {
    *guard = Some(now);
  }
  ready
}

#[cfg(target_os = "macos")]
fn maybe_log_ax_snapshot_empty() {
  if !should_trigger_now(&LAST_AX_EMPTY_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::info!(
    "capture: axRichCapture on but AX snapshot empty — allow this app in System Settings → Privacy & Security → Accessibility, or there may be no focused AX element"
  );
}

#[cfg(target_os = "macos")]
fn maybe_warn_ax_not_trusted(app: &AppHandle) {
  if !should_trigger_now(&LAST_AX_NOT_TRUSTED_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::warn!(
    "capture: axRichCapture is enabled but Accessibility trust is missing — allow this app in System Settings → Privacy & Security → Accessibility"
  );
  let _ = app.emit(
    "shogun-capture-ax-not-trusted",
    json!({
      "message": "Accessibility permission is required for axRichCapture. Allow this app in System Settings → Privacy & Security → Accessibility.",
    }),
  );
}

fn maybe_log_ingest_error(source: &str, err: &str) {
  if !should_trigger_now(&LAST_INGEST_ERROR_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::warn!("capture: memory ingest failed (source={}): {}", source, err);
}

fn fnv_hash(s: &str) -> u64 {
  let mut h = DefaultHasher::new();
  s.hash(&mut h);
  h.finish()
}

#[cfg(target_os = "macos")]
fn frontmost_app_name() -> Option<String> {
  let script = r#"tell application "System Events" to get name of first application process whose frontmost is true"#;
  let out = Command::new("osascript").args(["-e", script]).output().ok()?;
  if !out.status.success() {
    return None;
  }
  let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if name.is_empty() {
    return None;
  }
  Some(name)
}

#[cfg(not(target_os = "macos"))]
fn frontmost_app_name() -> Option<String> {
  None
}

/// Pure check on a loaded settings document: is the sampler allowed to run?
///
/// Reads only `sections.capture.paused`. Missing or `true` means the sampler
/// stays off, which gives fresh installs a privacy-first default (the pause /
/// resume commands are the user's explicit opt-in). The legacy
/// `pipelineAvailable` key is intentionally ignored — it was always written in
/// lockstep with `paused` so no existing user state relies on it alone.
fn sampler_should_run_for(doc: &Value) -> bool {
  let paused = doc
    .pointer("/sections/capture/paused")
    .and_then(|v| v.as_bool())
    .unwrap_or(true);
  !paused
}

fn pipeline_should_run() -> bool {
  let Ok(doc) = settings_store::load() else {
    return false;
  };
  sampler_should_run_for(&doc)
}

fn ax_rich_capture_enabled() -> bool {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/axRichCapture")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(false)
}

/// Seconds between sampler wakeups (macOS capture loop). Clamped 4–600, default 8.
fn sample_interval_secs() -> u64 {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/sampleIntervalSecs")
        .and_then(|v| v.as_u64())
    })
    .unwrap_or(8)
    .clamp(4, 600)
}

/// Minimum seconds between AX memory ingests when content changes (0 = no time gate, hash dedup only).
fn ax_min_interval_secs() -> u64 {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/axMinIntervalSecs")
        .and_then(|v| v.as_u64())
    })
    .unwrap_or(0)
    .clamp(0, 600)
}

/// Normalized privacy filters derived from `sections.privacy.excludedApps` /
/// `excludedSites` with `enabled: true`. Empty collections mean "no filter".
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct PrivacyFilters {
  pub excluded_apps: Vec<String>,
  pub excluded_hosts: Vec<String>,
}

fn normalize_app(s: &str) -> String {
  s.trim().to_ascii_lowercase()
}

fn normalize_host(s: &str) -> String {
  s.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn row_enabled(row: &Value) -> bool {
  // Treat missing `enabled` as true: rows without the key default to active.
  row
    .get("enabled")
    .and_then(|v| v.as_bool())
    .unwrap_or(true)
}

fn collect_enabled_strings(
  arr: &[Value],
  key: &str,
  normalize: fn(&str) -> String,
) -> Vec<String> {
  arr
    .iter()
    .filter(|row| row_enabled(row))
    .filter_map(|row| row.get(key).and_then(|v| v.as_str()))
    .map(normalize)
    .filter(|s| !s.is_empty())
    .collect()
}

pub fn filters_from_settings(doc: &Value) -> PrivacyFilters {
  let excluded_apps = doc
    .pointer("/sections/privacy/excludedApps")
    .and_then(|v| v.as_array())
    .map(|arr| collect_enabled_strings(arr, "name", normalize_app))
    .unwrap_or_default();
  let excluded_hosts = doc
    .pointer("/sections/privacy/excludedSites")
    .and_then(|v| v.as_array())
    .map(|arr| collect_enabled_strings(arr, "host", normalize_host))
    .unwrap_or_default();
  PrivacyFilters {
    excluded_apps,
    excluded_hosts,
  }
}

fn load_privacy_filters() -> PrivacyFilters {
  settings_store::load()
    .ok()
    .as_ref()
    .map(filters_from_settings)
    .unwrap_or_default()
}

pub fn app_excluded(filters: &PrivacyFilters, app_name: &str) -> bool {
  let needle = normalize_app(app_name);
  if needle.is_empty() {
    return false;
  }
  filters.excluded_apps.iter().any(|a| a == &needle)
}

/// Checks whether any excluded host appears in the AX text. Matches bare
/// occurrences as well as URLs: we lowercase both sides and look for a
/// substring hit. To reduce false positives we only match hosts that contain a
/// dot (which all real DNS names do).
pub fn ax_text_excluded(filters: &PrivacyFilters, text: &str) -> bool {
  if filters.excluded_hosts.is_empty() || text.is_empty() {
    return false;
  }
  let lower = text.to_ascii_lowercase();
  filters
    .excluded_hosts
    .iter()
    .filter(|h| h.contains('.'))
    .any(|host| lower.contains(host.as_str()))
}

fn maybe_ingest_focus(app: &str) {
  let sig = fnv_hash(app);
  if let Ok(mut last) = LAST_SIG.lock() {
    if *last == Some(sig) {
      return;
    }
    *last = Some(sig);
  }
  let title = format!("Focus · {}", app);
  let snippet = format!("Frontmost app (capture sampler): {}", app);
  let payload = json!({
    "title": title,
    "snippet": snippet,
    "source": "capture_sampler",
    "kinds": ["screen"],
  });
  if let Err(e) = memory_store::ingest(&payload) {
    maybe_log_ingest_error("capture_sampler", &e);
  }
}

fn maybe_ingest_ax(text: &str) {
  let sig = fnv_hash(text);
  if let Ok(last_sig) = LAST_AX_SIG.lock() {
    if *last_sig == Some(sig) {
      return;
    }
  }
  let min_iv = ax_min_interval_secs();
  if min_iv > 0 {
    let now = now_ms();
    if let Ok(last_t) = LAST_AX_INGEST_MS.lock() {
      if last_t
        .map(|t| now.saturating_sub(t) < min_iv.saturating_mul(1000))
        .unwrap_or(false)
      {
        return;
      }
    }
  }
  if let Ok(mut last_sig) = LAST_AX_SIG.lock() {
    *last_sig = Some(sig);
  }
  if min_iv > 0 {
    if let Ok(mut last_t) = LAST_AX_INGEST_MS.lock() {
      *last_t = Some(now_ms());
    }
  }
  let snippet = text.chars().take(2000).collect::<String>();
  let payload = json!({
    "title": "Focus · AX",
    "snippet": snippet,
    "source": "capture_ax",
    "kinds": ["screen", "accessibility"],
  });
  if let Err(e) = memory_store::ingest(&payload) {
    maybe_log_ingest_error("capture_ax", &e);
  }
}

pub fn start_background_sampler(app: AppHandle) {
  std::thread::spawn(move || loop {
    let wait = if pipeline_should_run() {
      sample_interval_secs()
    } else {
      8
    };
    std::thread::sleep(Duration::from_secs(wait));
    if !pipeline_should_run() {
      continue;
    }
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

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn doc_with_privacy(privacy: Value) -> Value {
    json!({ "sections": { "privacy": privacy } })
  }

  #[test]
  fn filters_from_settings_reads_enabled_rows_only() {
    let doc = doc_with_privacy(json!({
      "excludedApps": [
        { "name": "Finder", "enabled": true },
        { "name": "1Password", "enabled": true },
        { "name": "Banking", "enabled": false },
        { "name": "", "enabled": true },
      ],
      "excludedSites": [
        { "host": "internal.corp.example", "enabled": true },
        { "host": "pay.vendor.example", "enabled": false },
      ],
    }));
    let f = filters_from_settings(&doc);
    assert_eq!(f.excluded_apps, vec!["finder", "1password"]);
    assert_eq!(f.excluded_hosts, vec!["internal.corp.example"]);
  }

  #[test]
  fn filters_from_settings_tolerates_missing_privacy() {
    assert_eq!(
      filters_from_settings(&json!({})),
      PrivacyFilters::default()
    );
    assert_eq!(
      filters_from_settings(&json!({ "sections": {} })),
      PrivacyFilters::default()
    );
  }

  #[test]
  fn filters_from_settings_defaults_missing_enabled_to_true() {
    let doc = doc_with_privacy(json!({
      "excludedApps": [{ "name": "Finder" }],
    }));
    let f = filters_from_settings(&doc);
    assert_eq!(f.excluded_apps, vec!["finder"]);
  }

  #[test]
  fn app_excluded_matches_case_insensitive() {
    let f = PrivacyFilters {
      excluded_apps: vec!["finder".to_string()],
      excluded_hosts: vec![],
    };
    assert!(app_excluded(&f, "Finder"));
    assert!(app_excluded(&f, "  FINDER  "));
    assert!(!app_excluded(&f, "Safari"));
  }

  #[test]
  fn app_excluded_returns_false_for_empty_input() {
    let f = PrivacyFilters {
      excluded_apps: vec!["finder".to_string()],
      excluded_hosts: vec![],
    };
    assert!(!app_excluded(&f, ""));
    assert!(!app_excluded(&f, "   "));
  }

  #[test]
  fn ax_text_excluded_matches_url_host() {
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(ax_text_excluded(
      &f,
      "role=AXTextField\nvalue=Visit https://Internal.Corp.Example/path today"
    ));
  }

  #[test]
  fn ax_text_excluded_matches_bare_host() {
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(ax_text_excluded(
      &f,
      "window=Internal docs — internal.corp.example"
    ));
  }

  #[test]
  fn ax_text_excluded_ignores_non_matching_host() {
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(!ax_text_excluded(&f, "role=AXButton\nvalue=github.com/foo"));
  }

  #[test]
  fn ax_text_excluded_skips_dotless_hosts() {
    // Dotless entries are rejected to avoid matching arbitrary words.
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal".to_string()],
    };
    assert!(!ax_text_excluded(&f, "internal notes about this project"));
  }

  #[test]
  fn ax_text_excluded_respects_disabled_rows() {
    let doc = doc_with_privacy(json!({
      "excludedSites": [
        { "host": "internal.corp.example", "enabled": false },
      ],
    }));
    let f = filters_from_settings(&doc);
    assert!(!ax_text_excluded(
      &f,
      "value=https://internal.corp.example/"
    ));
  }

  #[test]
  fn ax_text_excluded_returns_false_when_no_hosts() {
    let f = PrivacyFilters::default();
    assert!(!ax_text_excluded(&f, "anything"));
  }

  #[test]
  fn should_trigger_now_fires_on_first_call() {
    let slot: Mutex<Option<u64>> = Mutex::new(None);
    assert!(should_trigger_now(&slot, 1_000, 120_000));
    assert_eq!(*slot.lock().unwrap(), Some(1_000));
  }

  #[test]
  fn should_trigger_now_suppresses_within_interval() {
    let slot: Mutex<Option<u64>> = Mutex::new(None);
    assert!(should_trigger_now(&slot, 1_000, 120_000));
    assert!(!should_trigger_now(&slot, 1_000 + 119_999, 120_000));
    assert_eq!(*slot.lock().unwrap(), Some(1_000));
  }

  #[test]
  fn should_trigger_now_fires_again_after_interval() {
    let slot: Mutex<Option<u64>> = Mutex::new(None);
    assert!(should_trigger_now(&slot, 1_000, 120_000));
    assert!(should_trigger_now(&slot, 1_000 + 120_000, 120_000));
    assert_eq!(*slot.lock().unwrap(), Some(121_000));
  }

  #[test]
  fn sampler_off_on_fresh_install() {
    // No capture section at all — privacy-first default wins.
    assert!(!sampler_should_run_for(&json!({})));
    assert!(!sampler_should_run_for(&json!({ "sections": {} })));
    assert!(!sampler_should_run_for(
      &json!({ "sections": { "capture": {} } })
    ));
  }

  #[test]
  fn sampler_respects_paused_flag() {
    assert!(!sampler_should_run_for(
      &json!({ "sections": { "capture": { "paused": true } } })
    ));
    assert!(sampler_should_run_for(
      &json!({ "sections": { "capture": { "paused": false } } })
    ));
  }

  #[test]
  fn sampler_ignores_legacy_pipeline_available() {
    // Legacy key should have no effect: user's `paused` decision governs.
    assert!(sampler_should_run_for(&json!({
      "sections": { "capture": { "paused": false, "pipelineAvailable": false } }
    })));
    assert!(!sampler_should_run_for(&json!({
      "sections": { "capture": { "paused": true, "pipelineAvailable": true } }
    })));
  }

  #[test]
  fn sampler_off_when_paused_is_non_bool() {
    // Unparseable value → treat as missing → privacy-first default (off).
    assert!(!sampler_should_run_for(
      &json!({ "sections": { "capture": { "paused": "yes" } } })
    ));
  }
}
