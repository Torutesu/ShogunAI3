//! macOS Accessibility (AXUIElement) snapshot of the focused control — text only, no screenshots.
//!
//! Types and helpers here serve the macOS-only `imp` submodule and the
//! pure-formatter unit tests. On non-macOS builds every item is reachable
//! only from `#[cfg(test)]`, so the top-level definitions look dead —
//! silence that per-platform so Mac CI still flags truly dead code.

#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

/// Pixel-coordinate frame of the focused window. Read via AXPosition + AXSize.
/// Coordinates are in macOS global display space (multi-monitor aware).
#[derive(Debug, Clone)]
pub struct WindowGeometry {
  pub x: f64,
  pub y: f64,
  pub w: f64,
  pub h: f64,
}

/// Raw strings copied from the focused AX element. All fields are owned so
/// the formatter stays pure and testable on any platform.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct AxFields {
  pub role: String,
  pub role_desc: String,
  pub title: String,
  pub value: String,
  pub help: String,
  pub description: String,
  pub selected_text: String,
  pub window: String,
}

/// Hard cap on any single user-content field so a giant textarea cannot bloat
/// the memory snippet.
const AX_VALUE_CHAR_CAP: usize = 500;

fn clip(s: &str, max: usize) -> String {
  s.chars().take(max).collect()
}

/// Format an [`AxFields`] into the newline-joined snapshot string the sampler
/// ingests. Returns `None` when the focused element is a secure text field
/// (password input) or when every field is empty. Secure inputs are dropped
/// before any ingest so passwords never reach the memory store.
pub fn format_snapshot(fields: &AxFields) -> Option<String> {
  if fields.role == "AXSecureTextField" {
    return None;
  }
  let mut parts: Vec<String> = Vec::new();
  if !fields.role.is_empty() {
    parts.push(format!("role={}", fields.role));
  }
  if !fields.role_desc.is_empty() {
    parts.push(format!("roleDesc={}", fields.role_desc));
  }
  if !fields.title.is_empty() {
    parts.push(format!("title={}", fields.title));
  }
  if !fields.value.is_empty() {
    parts.push(format!("value={}", clip(&fields.value, AX_VALUE_CHAR_CAP)));
  }
  if !fields.help.is_empty() {
    parts.push(format!("help={}", clip(&fields.help, AX_VALUE_CHAR_CAP)));
  }
  if !fields.description.is_empty() {
    parts.push(format!(
      "description={}",
      clip(&fields.description, AX_VALUE_CHAR_CAP)
    ));
  }
  if !fields.selected_text.is_empty() {
    parts.push(format!(
      "selected={}",
      clip(&fields.selected_text, AX_VALUE_CHAR_CAP)
    ));
  }
  if !fields.window.is_empty() {
    parts.push(format!("window={}", fields.window));
  }
  if parts.is_empty() {
    None
  } else {
    Some(parts.join("\n"))
  }
}

#[cfg(target_os = "macos")]
mod imp {
  use super::{format_snapshot, AxFields};
  use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
  use core_foundation::string::CFString;

  type AXUIElementRef = *const std::ffi::c_void;
  type AXError = i32;
  const AX_ERROR_SUCCESS: AXError = 0;

  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
      element: AXUIElementRef,
      attribute: core_foundation::string::CFStringRef,
      value: *mut CFTypeRef,
    ) -> AXError;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    /// Returns whether this process is trusted for accessibility (System Settings).
    fn AXIsProcessTrusted() -> u8;
    /// AXValue is an opaque container for CGPoint / CGSize / etc.
    fn AXValueGetValue(
      value: CFTypeRef,
      type_: i32,
      valuePtr: *mut std::ffi::c_void,
    ) -> u8;
    fn AXValueGetTypeID() -> usize;
  }

  const K_AX_VALUE_CG_POINT_TYPE: i32 = 1;
  const K_AX_VALUE_CG_SIZE_TYPE: i32 = 2;

  pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
  }

  unsafe fn copy_attr(element: AXUIElementRef, key: &str) -> Option<CFTypeRef> {
    if element.is_null() {
      return None;
    }
    let attr = CFString::new(key);
    let mut out: CFTypeRef = std::ptr::null();
    if AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out) != AX_ERROR_SUCCESS
      || out.is_null()
    {
      return None;
    }
    Some(out)
  }

  unsafe fn string_from_cf(cf: CFTypeRef) -> Option<String> {
    if cf.is_null() {
      return None;
    }
    if CFGetTypeID(cf) != CFStringGetTypeID() {
      CFRelease(cf);
      return None;
    }
    let s = CFString::wrap_under_create_rule(cf as *const _);
    Some(s.to_string())
  }

  fn read_string_attr(element: AXUIElementRef, key: &str) -> Option<String> {
    unsafe {
      let cf = copy_attr(element, key)?;
      string_from_cf(cf)
    }
  }

  unsafe fn read_point(element: AXUIElementRef, key: &str) -> Option<(f64, f64)> {
    let cf = copy_attr(element, key)?;
    if CFGetTypeID(cf) != AXValueGetTypeID() {
      CFRelease(cf);
      return None;
    }
    #[repr(C)]
    struct CGPoint {
      x: f64,
      y: f64,
    }
    let mut pt = CGPoint { x: 0.0, y: 0.0 };
    let ok = AXValueGetValue(cf, K_AX_VALUE_CG_POINT_TYPE, &mut pt as *mut _ as *mut _);
    CFRelease(cf);
    if ok != 0 {
      Some((pt.x, pt.y))
    } else {
      None
    }
  }

  unsafe fn read_size(element: AXUIElementRef, key: &str) -> Option<(f64, f64)> {
    let cf = copy_attr(element, key)?;
    if CFGetTypeID(cf) != AXValueGetTypeID() {
      CFRelease(cf);
      return None;
    }
    #[repr(C)]
    struct CGSize {
      w: f64,
      h: f64,
    }
    let mut sz = CGSize { w: 0.0, h: 0.0 };
    let ok = AXValueGetValue(cf, K_AX_VALUE_CG_SIZE_TYPE, &mut sz as *mut _ as *mut _);
    CFRelease(cf);
    if ok != 0 {
      Some((sz.w, sz.h))
    } else {
      None
    }
  }

  fn read_window_title(focused: AXUIElementRef) -> Option<String> {
    unsafe {
      let win = copy_attr(focused, "AXWindow")?;
      let title = read_string_attr(win as AXUIElementRef, "AXTitle");
      CFRelease(win);
      title
    }
  }

  fn read_focused_fields(focused: AXUIElementRef) -> AxFields {
    AxFields {
      role: read_string_attr(focused, "AXRole").unwrap_or_default(),
      role_desc: read_string_attr(focused, "AXRoleDescription").unwrap_or_default(),
      title: read_string_attr(focused, "AXTitle").unwrap_or_default(),
      value: read_string_attr(focused, "AXValue").unwrap_or_default(),
      help: read_string_attr(focused, "AXHelp").unwrap_or_default(),
      description: read_string_attr(focused, "AXDescription").unwrap_or_default(),
      selected_text: read_string_attr(focused, "AXSelectedText").unwrap_or_default(),
      window: read_window_title(focused).unwrap_or_default(),
    }
  }

  pub fn focused_ax_snapshot() -> Option<String> {
    unsafe {
      let system = AXUIElementCreateSystemWide();
      if system.is_null() {
        return None;
      }
      let attr = CFString::new("AXFocusedUIElement");
      let mut focused_raw: CFTypeRef = std::ptr::null();
      let err = AXUIElementCopyAttributeValue(
        system,
        attr.as_concrete_TypeRef(),
        &mut focused_raw,
      );

      let out = if err != AX_ERROR_SUCCESS || focused_raw.is_null() {
        None
      } else {
        let focused = focused_raw as AXUIElementRef;
        let fields = read_focused_fields(focused);
        format_snapshot(&fields)
      };

      if !focused_raw.is_null() {
        CFRelease(focused_raw);
      }
      CFRelease(system as CFTypeRef);
      out
    }
  }

  pub fn focused_window_geometry() -> Option<super::WindowGeometry> {
    unsafe {
      let system = AXUIElementCreateSystemWide();
      if system.is_null() {
        return None;
      }
      let focused_app = match copy_attr(system, "AXFocusedApplication") {
        Some(v) => v,
        None => return None,
      };
      let win = copy_attr(focused_app as AXUIElementRef, "AXFocusedWindow");
      let geom = match win {
        Some(w) => {
          let pos = read_point(w as AXUIElementRef, "AXPosition");
          let size = read_size(w as AXUIElementRef, "AXSize");
          CFRelease(w);
          match (pos, size) {
            (Some((x, y)), Some((w, h))) => Some(super::WindowGeometry { x, y, w, h }),
            _ => None,
          }
        }
        None => None,
      };
      CFRelease(focused_app);
      CFRelease(system as CFTypeRef);
      geom
    }
  }
}

#[cfg(target_os = "macos")]
pub use imp::focused_ax_snapshot;

#[cfg(target_os = "macos")]
pub use imp::focused_window_geometry;

/// `Some(true/false)` on macOS (whether this app is allowed in Accessibility settings). `None` on other platforms.
#[cfg(target_os = "macos")]
pub fn accessibility_trust_status() -> Option<bool> {
  Some(imp::accessibility_trusted())
}

#[cfg(not(target_os = "macos"))]
pub fn focused_ax_snapshot() -> Option<String> {
  None
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_geometry() -> Option<WindowGeometry> {
  None
}

#[cfg(not(target_os = "macos"))]
pub fn accessibility_trust_status() -> Option<bool> {
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  fn base_fields() -> AxFields {
    AxFields {
      role: "AXTextField".into(),
      role_desc: "text field".into(),
      title: "Email".into(),
      value: "alice@example.com".into(),
      help: "Enter your email".into(),
      description: "Primary email address".into(),
      selected_text: "alice".into(),
      window: "Compose".into(),
    }
  }

  #[test]
  fn format_snapshot_emits_all_non_empty_fields_in_order() {
    let s = format_snapshot(&base_fields()).expect("some");
    let lines: Vec<&str> = s.split('\n').collect();
    assert_eq!(
      lines,
      vec![
        "role=AXTextField",
        "roleDesc=text field",
        "title=Email",
        "value=alice@example.com",
        "help=Enter your email",
        "description=Primary email address",
        "selected=alice",
        "window=Compose",
      ]
    );
  }

  #[test]
  fn format_snapshot_skips_secure_text_field() {
    let mut f = base_fields();
    f.role = "AXSecureTextField".into();
    f.value = "hunter2".into();
    assert_eq!(format_snapshot(&f), None);
  }

  #[test]
  fn format_snapshot_returns_none_when_all_empty() {
    assert_eq!(format_snapshot(&AxFields::default()), None);
  }

  #[test]
  fn format_snapshot_omits_empty_fields() {
    let f = AxFields {
      role: "AXButton".into(),
      title: "Send".into(),
      ..AxFields::default()
    };
    assert_eq!(format_snapshot(&f), Some("role=AXButton\ntitle=Send".into()));
  }

  #[test]
  fn format_snapshot_clips_long_value() {
    let long: String = "x".repeat(1_000);
    let f = AxFields {
      role: "AXTextArea".into(),
      value: long,
      ..AxFields::default()
    };
    let s = format_snapshot(&f).expect("some");
    let value_line = s.lines().find(|l| l.starts_with("value=")).expect("value line");
    // "value=" prefix (6) + 500 clipped chars.
    assert_eq!(value_line.chars().count(), 6 + AX_VALUE_CHAR_CAP);
  }

  #[test]
  fn format_snapshot_clips_help_description_selected_independently() {
    let long: String = "y".repeat(1_000);
    let f = AxFields {
      role: "AXTextField".into(),
      help: long.clone(),
      description: long.clone(),
      selected_text: long,
      ..AxFields::default()
    };
    let s = format_snapshot(&f).expect("some");
    for prefix in ["help=", "description=", "selected="] {
      let line = s.lines().find(|l| l.starts_with(prefix)).expect("line");
      assert_eq!(
        line.chars().count(),
        prefix.chars().count() + AX_VALUE_CHAR_CAP
      );
    }
  }
}
