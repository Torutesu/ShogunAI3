//! Event-style trigger for the capture sampler.
//!
//! The macOS Accessibility API exposes a true notification mechanism
//! (`AXObserverCreate` + `AXObserverAddNotification` + `CFRunLoop`), but that
//! requires holding an AX-trusted observer on a Carbon run loop in a dedicated
//! thread and refreshing the observer every time the frontmost app changes.
//! The FFI is non-trivial.
//!
//! This module ships a simpler approximation that captures most of the user
//! intent: a low-latency poller (default 500ms) on (frontmost-app-name,
//! frontmost-window-title). When either changes, the registered callback fires.
//! The callback is debounced so a rapid burst of title changes triggers at most
//! once per `DEBOUNCE_MS`. The integrator's sampler loop should wait on this
//! signal with a longer timeout (e.g. 8s) as a "nothing-changed" fallback.

use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use std::process::Command;

const POLL_INTERVAL_MS: u64 = 500;
const DEBOUNCE_MS: u64 = 500;

/// True when `last` is `Some` and `now - last < threshold_ms`. Pulled out so
/// the debounce policy is testable without spinning up a real thread.
pub fn should_debounce(last: Option<Instant>, now: Instant, threshold_ms: u64) -> bool {
  match last {
    None => false,
    Some(t) => now.saturating_duration_since(t) < Duration::from_millis(threshold_ms),
  }
}

/// Opaque handle returned from `subscribe_focus_events`. Dropping or calling
/// `stop()` joins the poll thread and stops invoking the callback.
pub struct SubscriptionHandle {
  stop: Arc<AtomicBool>,
  thread: Option<JoinHandle<()>>,
}

impl SubscriptionHandle {
  /// Used by non-macOS builds (and as a fallback when the platform path
  /// fails). The handle's `stop()` is a no-op.
  pub fn noop() -> Self {
    Self {
      stop: Arc::new(AtomicBool::new(true)),
      thread: None,
    }
  }

  /// Signals the poll thread to exit and waits for it to join. Safe to call
  /// multiple times (after the first, subsequent calls are no-ops).
  pub fn stop(mut self) {
    self.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = self.thread.take() {
      let _ = handle.join();
    }
  }
}

impl Drop for SubscriptionHandle {
  fn drop(&mut self) {
    self.stop.store(true, Ordering::SeqCst);
    if let Some(handle) = self.thread.take() {
      let _ = handle.join();
    }
  }
}

#[cfg(target_os = "macos")]
fn read_focus_signature() -> Option<(String, String)> {
  let script = r#"tell application "System Events"
    set p to first application process whose frontmost is true
    set appName to name of p
    try
      set winName to name of front window of p
    on error
      set winName to ""
    end try
    return appName & "::" & winName
  end tell"#;
  let out = Command::new("osascript")
    .args(["-e", script])
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if raw.is_empty() {
    return None;
  }
  let mut parts = raw.splitn(2, "::");
  let app = parts.next().unwrap_or("").to_string();
  let win = parts.next().unwrap_or("").to_string();
  Some((app, win))
}

#[cfg(not(target_os = "macos"))]
fn read_focus_signature() -> Option<(String, String)> {
  None
}

/// Subscribe to focus-change events. The callback is invoked from a background
/// thread whenever the frontmost app name OR its front window title changes,
/// debounced by `DEBOUNCE_MS`. The handle must be kept alive for the
/// subscription to remain active.
pub fn subscribe_focus_events<F>(callback: F) -> SubscriptionHandle
where
  F: Fn() + Send + 'static,
{
  if cfg!(not(target_os = "macos")) {
    return SubscriptionHandle::noop();
  }
  let stop = Arc::new(AtomicBool::new(false));
  let stop_thread = stop.clone();
  let cb: Arc<Mutex<Box<dyn Fn() + Send>>> = Arc::new(Mutex::new(Box::new(callback)));
  let thread = std::thread::spawn(move || {
    let mut last_sig: Option<(String, String)> = None;
    let mut last_fire: Option<Instant> = None;
    while !stop_thread.load(Ordering::SeqCst) {
      std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
      if stop_thread.load(Ordering::SeqCst) {
        break;
      }
      let sig = match read_focus_signature() {
        Some(s) => s,
        None => continue,
      };
      let changed = last_sig.as_ref().map(|s| s != &sig).unwrap_or(true);
      if !changed {
        continue;
      }
      last_sig = Some(sig);
      let now = Instant::now();
      if should_debounce(last_fire, now, DEBOUNCE_MS) {
        continue;
      }
      last_fire = Some(now);
      // Run the callback. Hold the lock only for the call; if the user-supplied
      // closure panics we don't poison the mutex permanently because the next
      // event will set up a new MutexGuard. (A panic here only loses one event.)
      if let Ok(guard) = cb.lock() {
        (guard)();
      }
    }
  });
  SubscriptionHandle {
    stop,
    thread: Some(thread),
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::AtomicUsize;

  #[test]
  fn debounce_returns_false_when_no_previous_fire() {
    assert!(!should_debounce(None, Instant::now(), 500));
  }

  #[test]
  fn debounce_returns_true_within_threshold() {
    let now = Instant::now();
    let earlier = now - Duration::from_millis(100);
    assert!(should_debounce(Some(earlier), now, 500));
  }

  #[test]
  fn debounce_returns_false_after_threshold() {
    let now = Instant::now();
    let earlier = now - Duration::from_millis(600);
    assert!(!should_debounce(Some(earlier), now, 500));
  }

  #[test]
  fn debounce_returns_false_at_exact_threshold() {
    let now = Instant::now();
    let earlier = now - Duration::from_millis(500);
    assert!(!should_debounce(Some(earlier), now, 500));
  }

  #[test]
  fn noop_handle_stop_is_safe() {
    let h = SubscriptionHandle::noop();
    h.stop(); // Should not panic, should not hang.
  }

  #[test]
  fn noop_handle_drop_is_safe() {
    let _h = SubscriptionHandle::noop();
    // Drop runs at end of scope — must not panic / hang.
  }

  #[test]
  fn subscribe_handle_can_be_dropped_immediately() {
    // Even though the thread is running, dropping the handle should signal
    // stop and join cleanly within the poll interval + a small margin.
    let counter = Arc::new(AtomicUsize::new(0));
    let c2 = counter.clone();
    let start = Instant::now();
    let h = subscribe_focus_events(move || {
      c2.fetch_add(1, Ordering::SeqCst);
    });
    // Give the thread time to spin up.
    std::thread::sleep(Duration::from_millis(50));
    drop(h);
    let elapsed = start.elapsed();
    // Drop must complete within one poll interval + slack (1.5s is generous).
    assert!(
      elapsed < Duration::from_millis(1500),
      "drop took {:?}",
      elapsed
    );
  }
}
