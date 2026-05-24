//! macOS privacy permission probes and System Settings deep links.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

#[cfg(target_os = "macos")]
mod imp {
  use std::process::Command;

  #[link(name = "CoreGraphics", kind = "framework")]
  extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
  }

  #[link(name = "IOKit", kind = "framework")]
  extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
  }

  const K_IOHID_REQUEST_TYPE_LISTEN_EVENT: u32 = 1;
  const K_IOHID_ACCESS_TYPE_GRANTED: u32 = 0;

  pub fn screen_capture_granted() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
  }

  pub fn request_screen_capture_access() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
  }

  pub fn input_monitoring_granted() -> bool {
    unsafe { IOHIDCheckAccess(K_IOHID_REQUEST_TYPE_LISTEN_EVENT) == K_IOHID_ACCESS_TYPE_GRANTED }
  }

  pub fn open_privacy_pane(target: &str) -> bool {
    let url = match target {
      "accessibility" => {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
      }
      "input_monitoring" | "listening_event" => {
        "x-apple.systempreferences:com.apple.preference.security?Privacy_ListeningEvent"
      }
      _ => "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    };
    Command::new("open")
      .arg(url)
      .spawn()
      .map(|_| true)
      .unwrap_or(false)
  }
}

#[cfg(target_os = "macos")]
pub use imp::*;

#[cfg(not(target_os = "macos"))]
pub fn screen_capture_granted() -> bool {
  false
}

#[cfg(not(target_os = "macos"))]
pub fn request_screen_capture_access() -> bool {
  false
}

#[cfg(not(target_os = "macos"))]
pub fn input_monitoring_granted() -> bool {
  false
}

#[cfg(not(target_os = "macos"))]
pub fn open_privacy_pane(_target: &str) -> bool {
  false
}

pub fn accessibility_trusted() -> bool {
  crate::macos_ax::accessibility_trust_status().unwrap_or(false)
}

pub fn status_snapshot() -> serde_json::Value {
  serde_json::json!({
    "accessibilityTrusted": accessibility_trusted(),
    "screenCaptureGranted": screen_capture_granted(),
    "inputMonitoringGranted": input_monitoring_granted(),
  })
}
