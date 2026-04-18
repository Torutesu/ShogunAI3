//! Background sampler: macOS frontmost app name ingested as memory (no screenshots).
//! Optional Accessibility-rich snapshot when `sections.capture.axRichCapture` is true.

use crate::{macos_ax, memory_store, settings_store};
use serde_json::json;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

static LAST_SIG: Mutex<Option<u64>> = Mutex::new(None);
static LAST_AX_SIG: Mutex<Option<u64>> = Mutex::new(None);

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
  let _ = memory_store::ingest(&payload);
}

fn maybe_ingest_ax(text: &str) {
  let sig = fnv_hash(text);
  if let Ok(mut last) = LAST_AX_SIG.lock() {
    if *last == Some(sig) {
      return;
    }
    *last = Some(sig);
  }
  let snippet = text.chars().take(2000).collect::<String>();
  let payload = json!({
    "title": "Focus · AX",
    "snippet": snippet,
    "source": "capture_ax",
    "kinds": ["screen", "accessibility"],
  });
  let _ = memory_store::ingest(&payload);
}

pub fn start_background_sampler() {
  std::thread::spawn(|| loop {
    std::thread::sleep(Duration::from_secs(8));
    if !pipeline_should_run() {
      continue;
    }
    #[cfg(target_os = "macos")]
    {
      if ax_rich_capture_enabled() {
        if let Some(ax) = macos_ax::focused_ax_snapshot() {
          let t = ax.trim();
          if !t.is_empty() {
            maybe_ingest_ax(t);
            continue;
          }
        }
      }
      if let Some(app) = frontmost_app_name() {
        maybe_ingest_focus(&app);
      }
    }
  });
}
