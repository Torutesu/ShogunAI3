//! Background sampler: macOS frontmost app name ingested as memory (no screenshots).
//! Optional Accessibility-rich snapshot when `sections.capture.axRichCapture` is true.
//! Honors `sections.privacy.excludedApps` / `excludedSites` on every sample.
//!
//! Most helpers here are only reachable through the macOS sampler loop or
//! from unit tests; non-macOS library builds see them as dead. Silencing
//! `dead_code` there keeps `cargo check` quiet on Linux / Windows without
//! hiding genuine dead code on the Mac (where CI runs).

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

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
use tauri::Manager;
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
static LAST_FILTER_DROP_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);

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

fn maybe_log_filter_drop(reason: &str) {
  if !should_trigger_now(&LAST_FILTER_DROP_LOG_MS, now_ms(), RATE_LIMIT_MS) {
    return;
  }
  log::info!("capture: dropped by sensitive_filter (reason={})", reason);
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
/// Reads only `sections.capture.paused`. Missing defaults to **running** for MVP
/// ship (install → leave → search). Explicit `paused: true` stops capture.
fn sampler_should_run_for(doc: &Value) -> bool {
  let paused = doc
    .pointer("/sections/capture/paused")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  !paused
}

fn pipeline_should_run() -> bool {
  let Ok(doc) = settings_store::load() else {
    return false;
  };
  sampler_should_run_for(&doc)
}

/// Public wrapper for macOS input helpers.
pub fn pipeline_should_run_public() -> bool {
  pipeline_should_run()
}

fn capture_retention_days() -> u64 {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/retentionDays")
        .and_then(|v| v.as_u64())
    })
    .unwrap_or(30)
    .clamp(1, 3650)
}

fn ax_rich_capture_enabled() -> bool {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/axRichCapture")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true)
}

/// Seconds between sampler wakeups when no input event fired (idle fallback).
/// Clamped 4–600, default 5 (screenpipe-style passive capture).
fn idle_sample_interval_secs() -> u64 {
  settings_store::load()
    .ok()
    .and_then(|d| {
      d.pointer("/sections/capture/sampleIntervalSecs")
        .or_else(|| d.pointer("/sections/capture/idleSampleIntervalSecs"))
        .and_then(|v| v.as_u64())
    })
    .unwrap_or(5)
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

pub fn load_privacy_filters() -> PrivacyFilters {
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

pub fn app_excluded(filters: &PrivacyFilters, app_name: &str) -> bool {
  let needle = normalize_app(app_name);
  if needle.is_empty() {
    return false;
  }
  filters.excluded_apps.iter().any(|a| a == &needle)
}

/// Checks whether any excluded host appears in the AX text. Matches the host
/// of any parseable URL as well as bounded bare-hostname tokens, using suffix
/// matching so `internal.corp.example` excludes `mail.internal.corp.example`
/// too. Dotless entries are ignored so a list entry like `internal` cannot
/// accidentally match the English word. `not-internal.corp.example` is
/// rejected because the token before the excluded suffix must end on a label
/// boundary (a dot), not a hyphen.
pub fn ax_text_excluded(filters: &PrivacyFilters, text: &str) -> bool {
  if filters.excluded_hosts.is_empty() || text.is_empty() {
    return false;
  }
  let hosts: Vec<&str> = filters
    .excluded_hosts
    .iter()
    .filter(|h| h.contains('.'))
    .map(String::as_str)
    .collect();
  if hosts.is_empty() {
    return false;
  }
  let lower = text.to_ascii_lowercase();

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

  let bytes = lower.as_bytes();
  let mut i = 0;
  while i < bytes.len() {
    if !is_host_byte(bytes[i]) {
      i += 1;
      continue;
    }
    let start = i;
    while i < bytes.len() && is_host_byte(bytes[i]) {
      i += 1;
    }
    let token = lower[start..i].trim_matches(|c: char| c == '.' || c == '-');
    if token.contains('.') && hosts.iter().any(|ex| host_suffix_match(token, ex)) {
      return true;
    }
  }
  false
}

fn is_host_byte(b: u8) -> bool {
  b.is_ascii_alphanumeric() || b == b'-' || b == b'.'
}

/// Returns true when `actual` equals `excluded` or is a subdomain of it
/// (ends with `.<excluded>`). All inputs are expected to be lower-case.
fn host_suffix_match(actual: &str, excluded: &str) -> bool {
  if actual == excluded {
    return true;
  }
  actual.len() > excluded.len()
    && actual.as_bytes()[actual.len() - excluded.len() - 1] == b'.'
    && actual.ends_with(excluded)
}

fn capture_entity_id(prefix: &str, content: &str) -> String {
  format!("{prefix}:{:016x}", fnv_hash(content))
}

fn build_ax_capture_text() -> Option<String> {
  let mut parts: Vec<String> = Vec::new();
  if let Some(focus) = macos_ax::focused_ax_snapshot() {
    let t = focus.trim();
    if !t.is_empty() {
      parts.push(t.to_string());
    }
  }
  if let Some(tree) = macos_ax::focused_ax_tree(3, 48, 4_000) {
    let t = tree.trim();
    if !t.is_empty() {
      parts.push(t.to_string());
    }
  }
  if parts.is_empty() {
    None
  } else {
    Some(parts.join("\n\n"))
  }
}

fn snippet_with_spatial(base: &str, spatial: Option<&str>) -> String {
  let spatial = spatial.map(str::trim).filter(|s| !s.is_empty());
  match spatial {
    Some(s) => format!("spatial={s}\n\n{base}"),
    None => base.to_string(),
  }
}

fn upsert_capture_row(
  app: Option<&AppHandle>,
  app_label: &str,
  source: &str,
  title: &str,
  snippet: &str,
  entity_id: &str,
  kinds: &[&str],
  live_kind: &str,
  live_detail: &str,
) {
  crate::capture_events::record_live(app_label, live_kind, live_detail);
  let mut payload = json!({
    "title": title,
    "snippet": snippet,
    "source": source,
    "kinds": kinds,
    "entity_id": entity_id,
  });
  if let Some(handle) = app {
    if let Some(state) = handle.try_state::<crate::meeting_session::MeetingSessionState>() {
      if let Ok(Some((_id, _started, offset_ms))) = state.active_capture_offset() {
        if let Some(obj) = payload.as_object_mut() {
          obj.insert("meeting_id".to_string(), json!(_id));
          obj.insert("meeting_offset_ms".to_string(), json!(offset_ms));
        }
      }
    }
  }
  if let Err(e) = memory_store::ingest_capture_upsert(&payload) {
    maybe_log_ingest_error(source, &e);
  }
}

fn meeting_tags_for_mem_captures(app: Option<&AppHandle>) -> Option<(String, u64)> {
  let handle = app?;
  let state = handle.try_state::<crate::meeting_session::MeetingSessionState>()?;
  let (id, _started, offset) = state.active_capture_offset().ok()??;
  Some((id, offset))
}

fn maybe_ingest_focus(
  app_handle: Option<&AppHandle>,
  app: &str,
  spatial_context_json: Option<String>,
) {
  let sig = fnv_hash(app);
  if let Ok(mut last) = LAST_SIG.lock() {
    if *last == Some(sig) {
      return;
    }
    *last = Some(sig);
  }

  let settings = settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
  if crate::kioku_capture::capture_to_mem_captures_flag(&settings) {
    let snippet = format!("Frontmost app (capture sampler): {}", app);
    let meeting_meta = meeting_tags_for_mem_captures(app_handle)
      .map(|(id, offset)| json!({ "meeting_id": id, "meeting_offset_ms": offset }).to_string());
    let input = crate::mem_captures::CaptureInput {
      kind: "screen_app".into(),
      raw_text: Some(snippet),
      app_bundle_id: None,
      window_title: Some(app.to_string()),
      url: None,
      captured_at_ms: now_ms() as i64,
      spatial_context_json: spatial_context_json.clone(),
      filter_meta_json: meeting_meta,
      ..Default::default()
    };
    match memory_store::open_conn() {
      Ok(conn) => {
        if let Err(e) = crate::kioku_capture::route_capture(&input, &conn) {
          maybe_log_ingest_error("capture_sampler", &e);
        }
      }
      Err(e) => maybe_log_ingest_error("capture_sampler", &e),
    }
    return;
  }

  let entity = capture_entity_id("app", app);
  let snippet = snippet_with_spatial(
    &format!("Frontmost app: {app}"),
    spatial_context_json.as_deref(),
  );
  upsert_capture_row(
    app_handle,
    app,
    "capture_sampler",
    &format!("Focus · {app}"),
    &snippet,
    &entity,
    &["screen", "focus"],
    "app",
    app,
  );
}

fn maybe_ingest_ax(app: &AppHandle, text: &str, app_label: &str, spatial_context_json: Option<String>) {
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
  let snippet_body = text.chars().take(4000).collect::<String>();

  let settings = settings_store::load().unwrap_or_else(|_| serde_json::json!({}));
  if crate::kioku_capture::capture_to_mem_captures_flag(&settings) {
    let meeting_meta = meeting_tags_for_mem_captures(Some(app))
      .map(|(id, offset)| json!({ "meeting_id": id, "meeting_offset_ms": offset }).to_string());
    let input = crate::mem_captures::CaptureInput {
      kind: "screen_ax".into(),
      raw_text: Some(snippet_body.clone()),
      app_bundle_id: None,
      window_title: None,
      url: None,
      captured_at_ms: now_ms() as i64,
      spatial_context_json: spatial_context_json.clone(),
      filter_meta_json: meeting_meta,
      ..Default::default()
    };
    match memory_store::open_conn() {
      Ok(conn) => {
        if let Err(e) = crate::kioku_capture::route_capture(&input, &conn) {
          maybe_log_ingest_error("capture_ax", &e);
        }
      }
      Err(e) => maybe_log_ingest_error("capture_ax", &e),
    }
    return;
  }

  let entity = capture_entity_id("ax", text);
  let snippet = snippet_with_spatial(&snippet_body, spatial_context_json.as_deref());
  let preview = snippet.lines().next().unwrap_or("AX snapshot").chars().take(80).collect::<String>();
  upsert_capture_row(
    Some(app),
    app_label,
    "capture_ax",
    &format!("Focus · {app_label}"),
    &snippet,
    &entity,
    &["screen", "accessibility"],
    "ax",
    &preview,
  );
}

fn run_capture_tick(app: &AppHandle) {
  let filters = load_privacy_filters();
  #[cfg(target_os = "macos")]
  {
    let frontmost = frontmost_app_name();
    let app_label = frontmost.clone().unwrap_or_else(|| "unknown".to_string());
    if let Some(ref name) = frontmost {
      if app_excluded(&filters, name) {
        return;
      }
    }
    let spatial_for_ingest = if ax_rich_capture_enabled() {
      crate::spatial::capture_spatial_context()
    } else {
      None
    };
    if ax_rich_capture_enabled() {
      if macos_ax::accessibility_trust_status() == Some(false) {
        maybe_warn_ax_not_trusted(app);
      }
      if let Some(ax) = build_ax_capture_text() {
        let t = ax.trim();
        if !t.is_empty() {
          if ax_text_excluded(&filters, t) {
            return;
          }
          maybe_ingest_ax(app, t, &app_label, spatial_for_ingest.clone());
          return;
        }
        maybe_log_ax_snapshot_empty();
      } else {
        maybe_log_ax_snapshot_empty();
      }
    }
      if let Some(name) = frontmost {
        maybe_ingest_focus(Some(app), &name, spatial_for_ingest.clone());
      }
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = (&filters, app);
  }
}

fn start_retention_cleanup_thread() {
  std::thread::spawn(|| loop {
    std::thread::sleep(Duration::from_secs(3600));
    let days = capture_retention_days();
    match memory_store::cleanup_capture_retention(days) {
      Ok(n) if n > 0 => log::info!("capture: retention cleanup removed {n} rows"),
      Err(e) => log::warn!("capture: retention cleanup failed: {e}"),
      _ => {}
    }
  });
}

pub fn start_background_sampler(app: AppHandle) {
  crate::macos_input::start_if_macos();
  start_retention_cleanup_thread();

  std::thread::spawn(move || loop {
    let wake = crate::macos_input::take_sampler_wake();
    let wait = if pipeline_should_run() {
      if wake {
        1
      } else {
        idle_sample_interval_secs()
      }
    } else {
      4
    };
    std::thread::sleep(Duration::from_secs(wait));
    if !pipeline_should_run() {
      continue;
    }
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
      let spatial_for_ingest = if ax_rich_capture_enabled() {
        crate::spatial::capture_spatial_context()
      } else {
        None
      };
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
              maybe_ingest_ax(&app, t, app_name, spatial_for_ingest.clone());
              continue;
            }
            maybe_log_ax_snapshot_empty();
          }
          None => maybe_log_ax_snapshot_empty(),
        }
      }
      if let Some(name) = frontmost {
        maybe_ingest_focus(Some(&app), &name, spatial_for_ingest);
      }
    }
    #[cfg(not(target_os = "macos"))]
    {
      let _ = (&filters, &filter_cfg, &now_minute_of_week, &app);
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
  fn snippet_with_spatial_prefixes_json() {
    let out = snippet_with_spatial("Frontmost app: Safari", Some(r#"{"quadrant":"NE"}"#));
    assert!(out.starts_with("spatial="));
    assert!(out.contains("Frontmost app: Safari"));
  }

  #[test]
  fn snippet_with_spatial_empty_is_unchanged() {
    assert_eq!(snippet_with_spatial("hello", None), "hello");
    assert_eq!(snippet_with_spatial("hello", Some("  ")), "hello");
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
  fn ax_text_excluded_matches_subdomain_of_excluded_host() {
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(ax_text_excluded(
      &f,
      "value=https://mail.internal.corp.example/inbox"
    ));
    assert!(ax_text_excluded(
      &f,
      "window=Docs — mail.internal.corp.example"
    ));
  }

  #[test]
  fn ax_text_excluded_rejects_hyphen_prefixed_lookalike() {
    // `not-internal.corp.example` must NOT match `internal.corp.example`:
    // the character before the excluded suffix is a hyphen, not a label
    // boundary.
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(!ax_text_excluded(
      &f,
      "value=https://not-internal.corp.example/"
    ));
    assert!(!ax_text_excluded(&f, "window=not-internal.corp.example"));
  }

  #[test]
  fn ax_text_excluded_rejects_longer_tld_lookalike() {
    // `internal.corp.example.gov` is a different domain.
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(!ax_text_excluded(
      &f,
      "value=https://internal.corp.example.gov/"
    ));
    assert!(!ax_text_excluded(
      &f,
      "window=Public site internal.corp.example.gov"
    ));
  }

  #[test]
  fn ax_text_excluded_strips_trailing_url_punctuation() {
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(ax_text_excluded(
      &f,
      "value=See https://internal.corp.example/path."
    ));
    assert!(ax_text_excluded(
      &f,
      "value=(see https://internal.corp.example)"
    ));
  }

  #[test]
  fn ax_text_excluded_tolerates_non_ascii_separators() {
    // Em dash and Japanese punctuation must be treated as non-host bytes
    // without panicking on UTF-8 boundaries.
    let f = PrivacyFilters {
      excluded_apps: vec![],
      excluded_hosts: vec!["internal.corp.example".to_string()],
    };
    assert!(ax_text_excluded(
      &f,
      "window=社内 — internal.corp.example を開く"
    ));
    assert!(!ax_text_excluded(&f, "window=社内 — 別のドメイン"));
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
  fn sampler_on_on_fresh_install() {
    assert!(sampler_should_run_for(&json!({})));
    assert!(sampler_should_run_for(&json!({ "sections": {} })));
    assert!(sampler_should_run_for(
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
    // Unparseable value → treat as missing → MVP default (on).
    assert!(sampler_should_run_for(
      &json!({ "sections": { "capture": { "paused": "yes" } } })
    ));
  }
}
