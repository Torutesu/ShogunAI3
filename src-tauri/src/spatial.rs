//! Spatial context capture (KIOKU Sub-spec F).
//! Reads the focused window geometry via `macos_ax::focused_window_geometry`,
//! enumerates active displays via `CGGetActiveDisplayList`, computes the
//! screen quadrant the window center falls in, and serializes as
//! `{display_id, display_label, window_bounds, quadrant}` JSON.
//!
//! No NSScreen / AppKit dependency → no main-thread constraint. The capture
//! sampler can call this from its background thread.

use serde_json::json;

#[derive(Debug, Clone)]
struct DisplayInfo {
  ordinal: u32,
  label: String, // "Display N"
  x: f64,
  y: f64,
  w: f64,
  h: f64,
}

#[cfg(target_os = "macos")]
mod imp {
  use super::DisplayInfo;

  type CGDirectDisplayID = u32;

  #[repr(C)]
  #[derive(Copy, Clone)]
  struct CGRect {
    origin: CGPoint,
    size: CGSize,
  }
  #[repr(C)]
  #[derive(Copy, Clone)]
  struct CGPoint {
    x: f64,
    y: f64,
  }
  #[repr(C)]
  #[derive(Copy, Clone)]
  struct CGSize {
    w: f64,
    h: f64,
  }

  #[link(name = "CoreGraphics", kind = "framework")]
  extern "C" {
    fn CGGetActiveDisplayList(
      max_displays: u32,
      displays: *mut CGDirectDisplayID,
      display_count: *mut u32,
    ) -> i32;
    fn CGDisplayBounds(display: CGDirectDisplayID) -> CGRect;
  }

  pub fn enumerate_displays() -> Vec<DisplayInfo> {
    const MAX: u32 = 16;
    let mut ids: [CGDirectDisplayID; MAX as usize] = [0; MAX as usize];
    let mut count: u32 = 0;
    let err = unsafe { CGGetActiveDisplayList(MAX, ids.as_mut_ptr(), &mut count) };
    if err != 0 || count == 0 {
      return Vec::new();
    }
    (0..count as usize)
      .map(|i| {
        let r = unsafe { CGDisplayBounds(ids[i]) };
        DisplayInfo {
          ordinal: i as u32,
          label: format!("Display {}", i),
          x: r.origin.x,
          y: r.origin.y,
          w: r.size.w,
          h: r.size.h,
        }
      })
      .collect()
  }
}

#[cfg(not(target_os = "macos"))]
mod imp {
  use super::DisplayInfo;
  pub fn enumerate_displays() -> Vec<DisplayInfo> {
    Vec::new()
  }
}

fn find_display_for_point<'a>(
  displays: &'a [DisplayInfo],
  cx: f64,
  cy: f64,
) -> Option<&'a DisplayInfo> {
  displays
    .iter()
    .find(|d| cx >= d.x && cx < d.x + d.w && cy >= d.y && cy < d.y + d.h)
}

fn quadrant_for_center(d: &DisplayInfo, cx: f64, cy: f64) -> &'static str {
  let mid_x = d.x + d.w / 2.0;
  let mid_y = d.y + d.h / 2.0;
  match (cx < mid_x, cy < mid_y) {
    (true, true) => "NW",
    (false, true) => "NE",
    (true, false) => "SW",
    (false, false) => "SE",
  }
}

/// Capture spatial context for the currently focused window.
/// Returns a JSON string suitable for `mem_captures.spatial_context`,
/// or `None` if no window is focused or display enumeration fails.
///
/// Caller MUST gate on `axRichCapture` setting + Accessibility permission
/// (the AX read inside `focused_window_geometry` already returns None
/// when AX is denied, so a separate trust check is not needed here).
pub fn capture_spatial_context() -> Option<String> {
  let geom = crate::macos_ax::focused_window_geometry()?;
  let displays = imp::enumerate_displays();
  if displays.is_empty() {
    return None;
  }
  let cx = geom.x + geom.w / 2.0;
  let cy = geom.y + geom.h / 2.0;
  let display = find_display_for_point(&displays, cx, cy)?;
  let quadrant = quadrant_for_center(display, cx, cy);
  Some(
    json!({
      "display_id": display.ordinal,
      "display_label": display.label,
      "window_bounds": {
        "x": geom.x,
        "y": geom.y,
        "w": geom.w,
        "h": geom.h,
      },
      "quadrant": quadrant,
    })
    .to_string(),
  )
}
