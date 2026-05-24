//! macOS keyboard / mouse event tap (listen-only) for capture memory.
//!
//! Requires Accessibility trust and Input Monitoring approval on recent macOS.
//! Secure text fields are skipped via `macos_ax::is_secure_focus()`.
//!
//! Event-driven wake (screenpipe-inspired debounce):
//! - focus change → immediate wake + focus ingest
//! - click → 200ms debounce
//! - typing pause → 500ms after last keydown
//! - scroll stop → 400ms after last scroll wheel event

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static WAKE_SAMPLER: AtomicBool = AtomicBool::new(false);
static LAST_FOCUS_APP: Mutex<Option<String>> = Mutex::new(None);
static LAST_CLICK_MS: AtomicU64 = AtomicU64::new(0);
static LAST_CLICK_WAKE_MS: AtomicU64 = AtomicU64::new(0);
static LAST_KEY_DOWN_MS: AtomicU64 = AtomicU64::new(0);
static LAST_TYPING_WAKE_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SCROLL_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SCROLL_WAKE_MS: AtomicU64 = AtomicU64::new(0);

pub fn request_sampler_wake() {
  WAKE_SAMPLER.store(true, Ordering::SeqCst);
}

pub fn take_sampler_wake() -> bool {
  WAKE_SAMPLER.swap(false, Ordering::SeqCst)
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Debounce thresholds (ms), aligned with screenpipe capture docs.
pub(crate) const CLICK_DEBOUNCE_MS: u64 = 200;
pub(crate) const TYPING_PAUSE_MS: u64 = 500;
pub(crate) const SCROLL_STOP_MS: u64 = 400;

/// Returns true when `event_ms` is far enough after the previous wake for `kind`.
pub(crate) fn should_wake_after_debounce(
  event_ms: u64,
  last_wake_ms: u64,
  debounce_ms: u64,
) -> bool {
  event_ms.saturating_sub(last_wake_ms) >= debounce_ms
}

/// Typing-pause / scroll-stop coordinator: fires one sampler wake per burst.
pub(crate) fn poll_idle_event_wakes(now_ms: u64) {
  let key_ms = LAST_KEY_DOWN_MS.load(Ordering::Relaxed);
  if key_ms > 0 {
    let since = now_ms.saturating_sub(key_ms);
    if since >= TYPING_PAUSE_MS {
      let last_wake = LAST_TYPING_WAKE_MS.load(Ordering::Relaxed);
      if key_ms > last_wake {
        LAST_TYPING_WAKE_MS.store(key_ms, Ordering::Relaxed);
        request_sampler_wake();
        crate::capture_events::record_live("", "typing_pause", "typing paused");
      }
    }
  }

  let scroll_ms = LAST_SCROLL_MS.load(Ordering::Relaxed);
  if scroll_ms > 0 {
    let since = now_ms.saturating_sub(scroll_ms);
    if since >= SCROLL_STOP_MS {
      let last_wake = LAST_SCROLL_WAKE_MS.load(Ordering::Relaxed);
      if scroll_ms > last_wake {
        LAST_SCROLL_WAKE_MS.store(scroll_ms, Ordering::Relaxed);
        request_sampler_wake();
        crate::capture_events::record_live("", "scroll_stop", "scroll stopped");
      }
    }
  }
}

fn maybe_wake_click(now: u64) {
  let prev = LAST_CLICK_MS.load(Ordering::Relaxed);
  if prev > 0 && !should_wake_after_debounce(now, LAST_CLICK_WAKE_MS.load(Ordering::Relaxed), CLICK_DEBOUNCE_MS) {
    return;
  }
  LAST_CLICK_MS.store(now, Ordering::Relaxed);
  if prev > 0 && now.saturating_sub(prev) < CLICK_DEBOUNCE_MS {
    return;
  }
  LAST_CLICK_WAKE_MS.store(now, Ordering::Relaxed);
  request_sampler_wake();
  crate::capture_events::record_live("", "click", "mouse click");
}

#[cfg(target_os = "macos")]
mod imp {
  use super::*;
  use core_foundation::base::CFRelease;
  use core_foundation::mach_port::CFMachPortRef;
  use core_foundation::runloop::{
    kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRun,
  };
  use core_foundation::runloop::CFRunLoopSourceRef;
  use std::ffi::c_void;
  use std::process::Command;

  type CGEventTapProxy = *mut c_void;
  type CGEventRef = *mut c_void;

  const K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT: u64 = 0xFFFF_FFFF_FFFF_FFFE;
  const K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT: u64 = 0xFFFF_FFFF_FFFF_FFFD;
  const K_CG_HEAD_INSERT_EVENT_TAP: u32 = 0;
  const K_CG_SESSION_EVENT_TAP: u32 = 0;
  const K_CG_EVENT_TAP_OPTION_LISTEN_ONLY: u32 = 0x0000_0001;

  const K_CG_EVENT_LEFT_MOUSE_DOWN: u64 = 1;
  const K_CG_EVENT_RIGHT_MOUSE_DOWN: u64 = 3;
  const K_CG_EVENT_KEY_DOWN: u64 = 10;
  const K_CG_EVENT_SCROLL_WHEEL: u64 = 22;

  const K_CG_KEYBOARD_EVENT_KEYCODE: u32 = 9;
  const K_CG_LEFT_OPTION_KEYCODE: i64 = 58;
  const K_CG_RIGHT_OPTION_KEYCODE: i64 = 61;

  static OPTION_TAP_LAST_MS: AtomicU64 = AtomicU64::new(0);
  static OPTION_TAP_COUNT: AtomicU64 = AtomicU64::new(0);
  static TAP_ENABLED: AtomicBool = AtomicBool::new(false);
  static DEBOUNCE_THREAD_STARTED: AtomicBool = AtomicBool::new(false);

  #[link(name = "CoreFoundation", kind = "framework")]
  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn CGEventTapCreate(
      tap: u32,
      place: u32,
      options: u32,
      events_of_interest: u64,
      callback: extern "C" fn(CGEventTapProxy, u64, CGEventRef, *mut c_void) -> CGEventRef,
      user_info: *mut c_void,
    ) -> CFMachPortRef;
    fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    fn CFMachPortCreateRunLoopSource(
      allocator: *const c_void,
      port: CFMachPortRef,
      order: i64,
    ) -> CFRunLoopSourceRef;
  }

  fn frontmost_app_name() -> Option<String> {
    let script = r#"tell application "System Events" to get name of first application process whose frontmost is true"#;
    let out = Command::new("osascript").args(["-e", script]).output().ok()?;
    if !out.status.success() {
      return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if name.is_empty() {
      None
    } else {
      Some(name)
    }
  }

  fn maybe_hummingbird_option_double_tap(keycode: i64) {
    if keycode != K_CG_LEFT_OPTION_KEYCODE && keycode != K_CG_RIGHT_OPTION_KEYCODE {
      return;
    }
    let now = now_ms();
    let prev = OPTION_TAP_LAST_MS.load(Ordering::Relaxed);
    let count = if now.saturating_sub(prev) < 450 {
      OPTION_TAP_COUNT.fetch_add(1, Ordering::Relaxed) + 1
    } else {
      OPTION_TAP_COUNT.store(1, Ordering::Relaxed);
      1
    };
    OPTION_TAP_LAST_MS.store(now, Ordering::Relaxed);
    if count >= 2 {
      OPTION_TAP_COUNT.store(0, Ordering::Relaxed);
      crate::hummingbird::on_global_option_double_tap();
    }
  }

  fn maybe_focus_change(app: &str) {
    let changed = if let Ok(mut last) = LAST_FOCUS_APP.lock() {
      if last.as_deref() == Some(app) {
        false
      } else {
        *last = Some(app.to_string());
        true
      }
    } else {
      false
    };
    if !changed {
      return;
    }
    let filters = crate::capture_sampler::load_privacy_filters();
    if crate::capture_sampler::app_excluded(&filters, app) {
      return;
    }
    request_sampler_wake();
    let detail = format!("focus → {app}");
    crate::capture_events::record_live(app, "focus", &detail);
    let entity = format!("focus:{}", app.to_ascii_lowercase());
    let _ = crate::memory_store::ingest_capture_upsert(&serde_json::json!({
      "title": format!("Focus · {app}"),
      "snippet": detail,
      "source": "capture_focus",
      "kinds": ["screen", "focus"],
      "entity_id": entity,
    }));
  }

  extern "C" fn tap_callback(
    proxy: CGEventTapProxy,
    event_type: u64,
    event: CGEventRef,
    _user_info: *mut c_void,
  ) -> CGEventRef {
    if event_type == K_CG_EVENT_TAP_DISABLED_BY_TIMEOUT
      || event_type == K_CG_EVENT_TAP_DISABLED_BY_USER_INPUT
    {
      unsafe {
        CGEventTapEnable(proxy as CFMachPortRef, true);
      }
      return event;
    }

    if !crate::capture_sampler::pipeline_should_run_public() {
      return event;
    }

    if crate::macos_ax::is_secure_focus() {
      return event;
    }

    let app = frontmost_app_name().unwrap_or_else(|| "unknown".to_string());
    let filters = crate::capture_sampler::load_privacy_filters();
    if crate::capture_sampler::app_excluded(&filters, &app) {
      return event;
    }

    maybe_focus_change(&app);

    let now = now_ms();
    match event_type {
      K_CG_EVENT_KEY_DOWN => {
        unsafe {
          let keycode = CGEventGetIntegerValueField(event, K_CG_KEYBOARD_EVENT_KEYCODE);
          maybe_hummingbird_option_double_tap(keycode);
        }
        LAST_KEY_DOWN_MS.store(now, Ordering::Relaxed);
      }
      K_CG_EVENT_LEFT_MOUSE_DOWN | K_CG_EVENT_RIGHT_MOUSE_DOWN => {
        maybe_wake_click(now);
      }
      K_CG_EVENT_SCROLL_WHEEL => {
        LAST_SCROLL_MS.store(now, Ordering::Relaxed);
      }
      _ => {}
    }

    event
  }

  fn start_debounce_thread() {
    if DEBOUNCE_THREAD_STARTED.swap(true, Ordering::SeqCst) {
      return;
    }
    std::thread::spawn(|| loop {
      std::thread::sleep(Duration::from_millis(100));
      if !crate::capture_sampler::pipeline_should_run_public() {
        continue;
      }
      poll_idle_event_wakes(now_ms());
    });
  }

  pub fn start_event_tap_thread() {
    start_debounce_thread();
    std::thread::spawn(|| {
      let mask = (1u64 << K_CG_EVENT_LEFT_MOUSE_DOWN)
        | (1u64 << K_CG_EVENT_RIGHT_MOUSE_DOWN)
        | (1u64 << K_CG_EVENT_KEY_DOWN)
        | (1u64 << K_CG_EVENT_SCROLL_WHEEL);

      let tap = unsafe {
        CGEventTapCreate(
          K_CG_SESSION_EVENT_TAP,
          K_CG_HEAD_INSERT_EVENT_TAP,
          K_CG_EVENT_TAP_OPTION_LISTEN_ONLY,
          mask,
          tap_callback,
          std::ptr::null_mut(),
        )
      };

      if tap.is_null() {
        log::warn!("macos_input: CGEventTapCreate failed — grant Accessibility + Input Monitoring");
        return;
      }

      unsafe {
        CGEventTapEnable(tap, true);
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        if source.is_null() {
          log::warn!("macos_input: CFMachPortCreateRunLoopSource failed");
          CFRelease(tap as _);
          return;
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        TAP_ENABLED.store(true, Ordering::SeqCst);
        log::info!("macos_input: event tap running (click/typing-pause/scroll-stop wake)");
        CFRunLoopRun();
        CFRelease(source as _);
        CFRelease(tap as _);
      }
    });
  }

  pub fn tap_running() -> bool {
    TAP_ENABLED.load(Ordering::SeqCst)
  }
}

#[cfg(target_os = "macos")]
pub use imp::{start_event_tap_thread, tap_running};

#[cfg(not(target_os = "macos"))]
pub fn start_event_tap_thread() {}

#[cfg(not(target_os = "macos"))]
pub fn tap_running() -> bool {
  false
}

pub fn start_if_macos() {
  #[cfg(target_os = "macos")]
  {
    start_event_tap_thread();
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn click_debounce_requires_gap() {
    assert!(should_wake_after_debounce(500, 0, CLICK_DEBOUNCE_MS));
    assert!(!should_wake_after_debounce(250, 100, CLICK_DEBOUNCE_MS));
  }

  #[test]
  fn typing_pause_fires_once_per_burst() {
    LAST_KEY_DOWN_MS.store(1000, Ordering::Relaxed);
    LAST_TYPING_WAKE_MS.store(0, Ordering::Relaxed);
    poll_idle_event_wakes(1600);
    assert!(take_sampler_wake());
    assert!(!take_sampler_wake());
    poll_idle_event_wakes(1700);
    assert!(!take_sampler_wake());
  }
}
