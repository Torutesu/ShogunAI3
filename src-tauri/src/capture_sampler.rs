//! Background sampler: macOS frontmost app name ingested as memory (no screenshots).
//! Optional Accessibility-rich snapshot when `sections.capture.axRichCapture` is true.

use crate::{diagnostics, macos_ax, memory_store, settings_store};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static LAST_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_INGEST_MS: Mutex<Option<u64>> = Mutex::new(None);
#[cfg(target_os = "macos")]
static LAST_AX_EMPTY_LOG_MS: Mutex<Option<u64>> = Mutex::new(None);

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn maybe_log_ax_snapshot_empty() {
  let now = now_ms();
  if let Ok(mut last) = LAST_AX_EMPTY_LOG_MS.lock() {
    if last.map(|t| now.saturating_sub(t) < 120_000).unwrap_or(false) {
      return;
    }
    *last = Some(now);
  }
  log::info!(
    "capture: axRichCapture on but AX snapshot empty — allow this app in System Settings → Privacy & Security → Accessibility, or there may be no focused AX element"
  );
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

fn pipeline_should_run() -> bool {
  let Ok(doc) = settings_store::load() else {
    return false;
  };
  let paused = doc
    .pointer("/sections/capture/paused")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  let pipe = doc
    .pointer("/sections/capture/pipelineAvailable")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
  !paused && pipe
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
    diagnostics::record("capture_sampler.focus_ingest", e);
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
    diagnostics::record("capture_sampler.ax_ingest", e);
  }
}

pub fn start_background_sampler() {
  std::thread::spawn(|| loop {
    let wait = if pipeline_should_run() {
      sample_interval_secs()
    } else {
      8
    };
    std::thread::sleep(Duration::from_secs(wait));
    if !pipeline_should_run() {
      continue;
    }
    #[cfg(target_os = "macos")]
    {
      if ax_rich_capture_enabled() {
        match macos_ax::focused_ax_snapshot() {
          Some(ax) => {
            let t = ax.trim();
            if !t.is_empty() {
              maybe_ingest_ax(t);
              continue;
            }
            maybe_log_ax_snapshot_empty();
          }
          None => maybe_log_ax_snapshot_empty(),
        }
      }
      if let Some(app) = frontmost_app_name() {
        maybe_ingest_focus(&app);
      }
    }
  });
}
