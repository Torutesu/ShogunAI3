//! macOS Accessibility (AXUIElement) snapshot of the focused control — text only, no screenshots.

#[cfg(target_os = "macos")]
mod imp {
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
  }

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

  fn read_window_title(focused: AXUIElementRef) -> Option<String> {
    unsafe {
      let win = copy_attr(focused, "AXWindow")?;
      let title = read_string_attr(win as AXUIElementRef, "AXTitle");
      CFRelease(win);
      title
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
        let role = read_string_attr(focused, "AXRole").unwrap_or_default();
        let title = read_string_attr(focused, "AXTitle").unwrap_or_default();
        let value = read_string_attr(focused, "AXValue").unwrap_or_default();
        let role_desc = read_string_attr(focused, "AXRoleDescription").unwrap_or_default();
        let win = read_window_title(focused).unwrap_or_default();
        let mut parts: Vec<String> = Vec::new();
        if !role.is_empty() {
          parts.push(format!("role={}", role));
        }
        if !role_desc.is_empty() {
          parts.push(format!("roleDesc={}", role_desc));
        }
        if !title.is_empty() {
          parts.push(format!("title={}", title));
        }
        if !value.is_empty() {
          parts.push(format!(
            "value={}",
            value.chars().take(500).collect::<String>()
          ));
        }
        if !win.is_empty() {
          parts.push(format!("window={}", win));
        }
        if parts.is_empty() {
          None
        } else {
          Some(parts.join("\n"))
        }
      };

      if !focused_raw.is_null() {
        CFRelease(focused_raw);
      }
      CFRelease(system as CFTypeRef);
      out
    }
  }
}

#[cfg(target_os = "macos")]
pub use imp::focused_ax_snapshot;

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
pub fn accessibility_trust_status() -> Option<bool> {
  None
}
