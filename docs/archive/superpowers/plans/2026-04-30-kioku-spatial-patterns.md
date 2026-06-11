# KIOKU Sub-spec F — Spatial Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `kind='spatial'` to KIOKU patterns: capture each focused window's `(display_id, window_bounds, quadrant)` via macOS AX + Core Graphics, detect 14-day clusters, and surface them in the Settings KIOKU Patterns tab (excluded from Morning Brief).

**Architecture:** Two new modules — `spatial.rs` (capture-time geometry → JSON) and `spatial_patterns.rs` (detection over `mem_captures.spatial_context`). One `macos_ax::focused_window_geometry()` helper. `patterns::run_detection` gains a third pass; `list_for_brief` gains an `include_spatial: bool` parameter so Brief can filter while Settings includes. No schema changes, no new Tauri command, no frontend changes.

**Tech Stack:** Rust (rusqlite, chrono::Local, serde_json, uuid, macOS frameworks: ApplicationServices for AX, CoreGraphics for `CGGetActiveDisplayList` / `CGDisplayBounds`).

**Spec:** `docs/superpowers/specs/2026-04-30-kioku-spatial-patterns-design.md`

---

## File Map

**Created:**
- `src-tauri/src/spatial.rs` (~110 LOC) — `capture_spatial_context()` + display enumeration via `CGGetActiveDisplayList` + quadrant computation.
- `src-tauri/src/spatial_patterns.rs` (~110 LOC) — `detect_spatial(conn, captures)` + `upsert_spatial(...)`.

**Modified:**
- `src-tauri/src/macos_ax.rs` — `pub fn focused_window_geometry() -> Option<WindowGeometry>` + new struct + `AXValueGetValue` FFI bindings.
- `src-tauri/src/capture_sampler.rs` — invoke `spatial::capture_spatial_context()` when `axRichCapture` is on; pass into `IngestInput.spatial_context_json`.
- `src-tauri/src/patterns.rs` — `friendly_app_name` → `pub(crate)`; `CaptureRow` adds `spatial_context: Option<String>`; `fetch_recent_captures` SELECT extends; `run_detection` gets spatial pass; `list_for_brief` gains `include_spatial` arg + spatial label arm.
- `src-tauri/src/brief.rs` — call site uses `list_for_brief(4, false)`.
- `src-tauri/src/commands.rs:shogun_patterns_list` — call site uses `list_for_brief(50, true)`.
- `src-tauri/src/lib.rs` — `mod spatial;` + `mod spatial_patterns;`.

**No tests in scope** (per spec § 10 — manual eye-test only). Verification = `npm run check:rust` + `check:ipc-mock` + `check-actions` + manual SQLite-based walkthrough.

---

## Task 1: `macos_ax::focused_window_geometry`

**Files:**
- Modify: `src-tauri/src/macos_ax.rs`

This task adds a single new public fn to read the focused window's frame via AX. No call-sites yet — those land in Task 2.

- [ ] **Step 1: Add `WindowGeometry` struct + new FFI declarations**

Open `src-tauri/src/macos_ax.rs`. Add the public struct at the top of the file, just before the `mod imp` (or `#[cfg(target_os = "macos")] mod imp`) block. Use Edit. `old_string`:

```rust
//! macOS Accessibility (AXUIElement) snapshot of the focused control — text only, no screenshots.
```

`new_string`:

```rust
//! macOS Accessibility (AXUIElement) snapshot of the focused control — text only, no screenshots.

/// Pixel-coordinate frame of the focused window. Read via AXPosition + AXSize.
/// Coordinates are in macOS global display space (multi-monitor aware).
#[derive(Debug, Clone)]
pub struct WindowGeometry {
  pub x: f64,
  pub y: f64,
  pub w: f64,
  pub h: f64,
}
```

- [ ] **Step 2: Add `AXValue` FFI declarations to the macOS imp block**

Locate the existing `#[link(name = "ApplicationServices", kind = "framework")] extern "C" {` block (around line 88). Use Edit. `old_string`:

```rust
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
```

`new_string`:

```rust
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
```

- [ ] **Step 3: Add `read_point` / `read_size` helpers**

Locate the existing `fn read_string_attr` (around line 132). Use Edit to add two new helpers AFTER it. `old_string`:

```rust
  fn read_string_attr(element: AXUIElementRef, key: &str) -> Option<String> {
    unsafe {
      let cf = copy_attr(element, key)?;
      string_from_cf(cf)
    }
  }
```

`new_string`:

```rust
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
```

- [ ] **Step 4: Add `focused_window_geometry` macOS implementation**

Locate the existing `pub fn focused_ax_snapshot` inside the `mod imp` block (around line 161). Add the new function AFTER it. Use Edit. `old_string`:

```rust
  pub fn focused_ax_snapshot() -> Option<String> {
```

(Read the surrounding ~30 lines first to confirm the closing `}` of `focused_ax_snapshot`.) Locate the closing `}` of that function. Then insert the new function after it.

The cleanest path: locate `pub fn accessibility_trust_status` (line 197 outside imp block). Insert the new function before it. Use Edit. `old_string`:

```rust
pub fn accessibility_trust_status() -> Option<bool> {
```

`new_string`:

```rust
#[cfg(target_os = "macos")]
pub fn focused_window_geometry() -> Option<crate::macos_ax::WindowGeometry> {
  use core_foundation::base::CFRelease;
  unsafe {
    let system = imp::AXUIElementCreateSystemWide();
    if system.is_null() {
      return None;
    }
    let focused_app = imp::copy_attr(system, "AXFocusedApplication")?;
    let win = imp::copy_attr(focused_app as imp::AXUIElementRef, "AXFocusedWindow");
    let geom = match win {
      Some(w) => {
        let pos = imp::read_point(w as imp::AXUIElementRef, "AXPosition");
        let size = imp::read_size(w as imp::AXUIElementRef, "AXSize");
        CFRelease(w);
        match (pos, size) {
          (Some((x, y)), Some((w, h))) => Some(WindowGeometry { x, y, w, h }),
          _ => None,
        }
      }
      None => None,
    };
    CFRelease(focused_app);
    CFRelease(system);
    geom
  }
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_geometry() -> Option<WindowGeometry> {
  None
}

pub fn accessibility_trust_status() -> Option<bool> {
```

NOTE: this requires `imp::AXUIElementRef`, `imp::copy_attr`, `imp::read_point`, `imp::read_size` to be visible from outside the `imp` module. If they are currently private, change `mod imp` to `pub(crate) mod imp` and mark the relevant types/fns `pub(super)` or `pub(crate)` so they can be referenced from the outer macOS function.

If exposing `imp` internals feels too invasive, **alternative**: place `focused_window_geometry` INSIDE the `imp` module (matching the pattern of `focused_ax_snapshot`), and re-export it via `pub use imp::focused_window_geometry;` at the bottom (matching `pub use imp::accessibility_trust_status` if that pattern exists, otherwise add it).

The alternative is safer. Concrete approach:

(a) Inside `mod imp { ... }`, add the macOS impl fn body:

```rust
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
      CFRelease(system);
      geom
    }
  }
```

(b) Outside the `mod imp` block, add the public re-export and the non-macOS stub:

```rust
#[cfg(target_os = "macos")]
pub use imp::focused_window_geometry;

#[cfg(not(target_os = "macos"))]
pub fn focused_window_geometry() -> Option<WindowGeometry> {
  None
}
```

Pick the alternative path (b). It is the smaller diff.

- [ ] **Step 5: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. A `warning: function focused_window_geometry is never used` is EXPECTED (consumed in Task 2).

If you see "private item leaked through public type" for `WindowGeometry`, ensure the struct is at the top-level (outside `mod imp`) and `pub`. If you see FFI type mismatches, double-check that `AXValueGetValue` returns `u8` (Boolean in C is 1 byte on macOS).

- [ ] **Step 6: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/macos_ax.rs
git diff --cached --stat
git commit -m "feat(kioku): macos_ax::focused_window_geometry"
git show HEAD --stat
```

Must show exactly 1 file. Otherwise REVERT and report BLOCKED.

---

## Task 2: `spatial.rs` module

**Files:**
- Create: `src-tauri/src/spatial.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod spatial;`

- [ ] **Step 1: Create `src-tauri/src/spatial.rs`**

Write this full file:

```rust
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
```

- [ ] **Step 2: Register the module in `src-tauri/src/lib.rs`**

Locate the existing `mod patterns_sync;` line (line 44). Use Edit. `old_string`:

```
mod patterns_sync;
```

`new_string`:

```
mod patterns_sync;
mod spatial;
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. Warnings on `capture_spatial_context`, `find_display_for_point`, `quadrant_for_center`, `DisplayInfo` are EXPECTED (consumed in Task 3 / 4).

The `focused_window_geometry` warning from Task 1 should be GONE (consumed here).

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/spatial.rs src-tauri/src/lib.rs
git diff --cached --stat
git commit -m "feat(kioku): spatial.rs — display enumeration + spatial JSON"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 3: capture_sampler integration

**Files:**
- Modify: `src-tauri/src/capture_sampler.rs:448-466` — invoke `spatial::capture_spatial_context()` when `axRichCapture` is on.

Currently the sampler reads `focused_ax_snapshot` and ingests it as `mem_captures` text. We need to also fetch spatial context in the same `axRichCapture` branch, plumb it through the existing ingest helper.

- [ ] **Step 1: Inspect current ingest path**

```bash
grep -n "fn maybe_ingest_ax\|fn maybe_ingest_focus\|spatial_context_json\|IngestInput" src-tauri/src/capture_sampler.rs src-tauri/src/mem_captures.rs | head -20
```

Read the existing `maybe_ingest_ax(t)` and `maybe_ingest_focus(name)` helpers (`capture_sampler.rs:316` and `capture_sampler.rs:365`). Each builds an `IngestInput` and calls `mem_captures::ingest(...)`.

- [ ] **Step 2: Extend `maybe_ingest_ax` to accept spatial_context**

Find the existing `fn maybe_ingest_ax(text: &str)`. Read its body to identify where `IngestInput` is constructed. Use Edit to change the signature and body.

The change pattern:
- Add a parameter `spatial_context_json: Option<String>` to the function signature.
- Pass that into `IngestInput.spatial_context_json` (which currently always gets `None`).

The exact `old_string` / `new_string` depends on the current function shape. Read it first:

```bash
sed -n '365,400p' src-tauri/src/capture_sampler.rs
```

Then construct an Edit that:
- Changes `fn maybe_ingest_ax(text: &str) {` to `fn maybe_ingest_ax(text: &str, spatial_context_json: Option<String>) {`
- Changes the inline `spatial_context_json: None,` (in the `IngestInput { ... }` literal) to `spatial_context_json,`

Likewise for `maybe_ingest_focus`:
- Change `fn maybe_ingest_focus(app: &str) {` to `fn maybe_ingest_focus(app: &str, spatial_context_json: Option<String>) {`
- Same `spatial_context_json: None,` → `spatial_context_json,` swap inside the literal.

- [ ] **Step 3: Wire spatial capture into the sampler loop**

Locate the sampler loop body around line 442-470 (the `#[cfg(target_os = "macos")]` block that calls `frontmost_app_name`, `ax_rich_capture_enabled`, etc).

Use Edit. `old_string`:

```rust
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
```

`new_string`:

```rust
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
              maybe_ingest_ax(t, spatial_for_ingest.clone());
              continue;
            }
            maybe_log_ax_snapshot_empty();
          }
          None => maybe_log_ax_snapshot_empty(),
        }
      }
      if let Some(name) = frontmost {
        maybe_ingest_focus(&name, spatial_for_ingest);
      }
```

- [ ] **Step 4: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. The `capture_spatial_context` warning from Task 2 should be GONE.

If you see "function takes 1 argument but 2 were supplied" on `maybe_ingest_*` calls, the Step 2 signature change wasn't applied to the helpers themselves.

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/capture_sampler.rs
git diff --cached --stat
git commit -m "feat(kioku): capture_sampler captures spatial_context when axRichCapture is on"
git show HEAD --stat
```

Must show exactly 1 file.

---

## Task 4: `spatial_patterns.rs` module

**Files:**
- Create: `src-tauri/src/spatial_patterns.rs`
- Modify: `src-tauri/src/lib.rs` — add `mod spatial_patterns;`
- Modify: `src-tauri/src/patterns.rs` — `friendly_app_name` → `pub(crate) fn`.

- [ ] **Step 1: Expose `friendly_app_name` to the crate**

In `src-tauri/src/patterns.rs:64`, change `fn friendly_app_name` → `pub(crate) fn friendly_app_name`. Use Edit. `old_string`:

```
fn friendly_app_name(bundle: &str) -> String {
```

`new_string`:

```
pub(crate) fn friendly_app_name(bundle: &str) -> String {
```

- [ ] **Step 2: Create `src-tauri/src/spatial_patterns.rs`**

Write this full file:

```rust
//! Spatial pattern detection (KIOKU Sub-spec F).
//! Groups recent captures by (display_id, app_bundle_id, quadrant) and
//! UPSERTs into `patterns` with kind='spatial' when observed across 3+
//! distinct days in the last 14 days.

use chrono::{Local, TimeZone};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub(crate) struct SpatialCaptureRow {
  pub app_bundle_id: String,
  pub captured_at: i64,
  pub spatial_context: Value, // pre-parsed JSON
}

fn now_ms() -> i64 {
  use std::time::{SystemTime, UNIX_EPOCH};
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0)
}

#[allow(clippy::too_many_arguments)]
fn upsert_spatial(
  conn: &Connection,
  display_id: u32,
  display_label: &str,
  app_bundle: &str,
  app_label: &str,
  quadrant: &str,
  observed_n: i64,
  first_seen_at: i64,
  last_seen_at: i64,
) -> Result<(), String> {
  let confidence = ((observed_n as f32) / 14.0).min(1.0);
  let trigger_json = json!({
    "display_id": display_id,
    "display_label": display_label,
    "quadrant": quadrant,
  })
  .to_string();
  let action_json = json!({
    "app": app_bundle,
    "label": app_label,
  })
  .to_string();

  let existing: Option<String> = conn
    .query_row(
      "SELECT id FROM patterns WHERE kind='spatial' AND trigger_json=?1 AND action_json=?2 LIMIT 1",
      params![&trigger_json, &action_json],
      |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| format!("spatial_patterns::upsert_spatial select: {}", e))?;

  if let Some(id) = existing {
    conn
      .execute(
        "UPDATE patterns SET observed_n=?1, confidence=?2, last_seen_at=?3, status='active' WHERE id=?4",
        params![observed_n, confidence, last_seen_at, id],
      )
      .map_err(|e| format!("spatial_patterns::upsert_spatial update: {}", e))?;
  } else {
    let id = Uuid::new_v4().to_string();
    conn
      .execute(
        "INSERT INTO patterns (id, kind, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at, status) VALUES (?1, 'spatial', ?2, ?3, ?4, ?5, ?6, ?7, 'active')",
        params![id, trigger_json, action_json, confidence, observed_n, first_seen_at, last_seen_at],
      )
      .map_err(|e| format!("spatial_patterns::upsert_spatial insert: {}", e))?;
  }
  Ok(())
}

/// Detect spatial patterns from recent captures. Returns the count of
/// patterns UPSERTed.
pub(crate) fn detect_spatial(
  conn: &Connection,
  captures: &[SpatialCaptureRow],
) -> Result<usize, String> {
  if captures.is_empty() {
    return Ok(0);
  }

  type Key = (u32, String, String);
  let mut buckets: HashMap<Key, HashSet<chrono::NaiveDate>> = HashMap::new();
  let mut display_labels: HashMap<u32, String> = HashMap::new();
  let mut first_last: HashMap<Key, (i64, i64)> = HashMap::new();

  for cap in captures {
    let ctx = match cap.spatial_context.as_object() {
      Some(o) => o,
      None => continue,
    };
    let display_id = match ctx.get("display_id").and_then(|v| v.as_u64()) {
      Some(n) => n as u32,
      None => continue,
    };
    let display_label = ctx
      .get("display_label")
      .and_then(|v| v.as_str())
      .unwrap_or("")
      .to_string();
    let quadrant = match ctx.get("quadrant").and_then(|v| v.as_str()) {
      Some(s) => s.to_string(),
      None => continue,
    };
    let app = cap.app_bundle_id.clone();
    let dt = match Local.timestamp_millis_opt(cap.captured_at).single() {
      Some(d) => d,
      None => continue,
    };
    let key = (display_id, app, quadrant);
    buckets.entry(key.clone()).or_default().insert(dt.date_naive());
    display_labels.entry(display_id).or_insert(display_label);
    let entry = first_last
      .entry(key)
      .or_insert((cap.captured_at, cap.captured_at));
    if cap.captured_at < entry.0 {
      entry.0 = cap.captured_at;
    }
    if cap.captured_at > entry.1 {
      entry.1 = cap.captured_at;
    }
  }

  let mut emitted = 0usize;
  for ((display_id, app, quadrant), days) in buckets {
    if days.len() >= 3 {
      let observed_n = days.len() as i64;
      let app_label = crate::patterns::friendly_app_name(&app);
      let display_label = display_labels
        .get(&display_id)
        .cloned()
        .unwrap_or_else(|| format!("Display {}", display_id));
      let (first_seen_at, last_seen_at) = first_last
        .get(&(display_id, app.clone(), quadrant.clone()))
        .copied()
        .unwrap_or((now_ms(), now_ms()));
      upsert_spatial(
        conn,
        display_id,
        &display_label,
        &app,
        &app_label,
        &quadrant,
        observed_n,
        first_seen_at,
        last_seen_at,
      )?;
      emitted += 1;
    }
  }
  Ok(emitted)
}
```

- [ ] **Step 3: Register module in `lib.rs`**

Locate `mod spatial;` (added in Task 2). Use Edit. `old_string`:

```
mod spatial;
```

`new_string`:

```
mod spatial;
mod spatial_patterns;
```

- [ ] **Step 4: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. Warnings on `detect_spatial`, `upsert_spatial`, `SpatialCaptureRow` are EXPECTED (consumed in Task 5). The `friendly_app_name` warning shape changes (was unreferenced from outside, now `pub(crate)` and consumed by spatial_patterns).

- [ ] **Step 5: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/spatial_patterns.rs src-tauri/src/lib.rs src-tauri/src/patterns.rs
git diff --cached --stat
git commit -m "feat(kioku): spatial_patterns.rs — detection + UPSERT for kind='spatial'"
git show HEAD --stat
```

Must show exactly 3 files.

---

## Task 5: Wire spatial pass + `include_spatial` flag in patterns.rs

**Files:**
- Modify: `src-tauri/src/patterns.rs` — `CaptureRow` adds `spatial_context`; `fetch_recent_captures` SELECT extends; `run_detection` adds spatial pass; `list_for_brief` gains `include_spatial` arg + spatial label.

- [ ] **Step 1: Extend `CaptureRow` and `fetch_recent_captures`**

Use Edit on `src-tauri/src/patterns.rs`. `old_string`:

```rust
struct CaptureRow {
  app_bundle_id: String,
  captured_at: i64,
}

fn fetch_recent_captures(conn: &Connection, since_ms: i64) -> Result<Vec<CaptureRow>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT app_bundle_id, captured_at
      FROM mem_captures
      WHERE captured_at >= ?1 AND app_bundle_id IS NOT NULL
      ORDER BY captured_at ASC
      "#,
    )
    .map_err(|e| format!("patterns::fetch_recent_captures prepare: {}", e))?;
  let rows = stmt
    .query_map(params![since_ms], |row| {
      Ok(CaptureRow { app_bundle_id: row.get::<_, String>(0)?, captured_at: row.get::<_, i64>(1)? })
    })
    .map_err(|e| format!("patterns::fetch_recent_captures query: {}", e))?;
```

`new_string`:

```rust
struct CaptureRow {
  app_bundle_id: String,
  captured_at: i64,
  spatial_context: Option<String>,
}

fn fetch_recent_captures(conn: &Connection, since_ms: i64) -> Result<Vec<CaptureRow>, String> {
  let mut stmt = conn
    .prepare(
      r#"
      SELECT app_bundle_id, captured_at, spatial_context
      FROM mem_captures
      WHERE captured_at >= ?1 AND app_bundle_id IS NOT NULL
      ORDER BY captured_at ASC
      "#,
    )
    .map_err(|e| format!("patterns::fetch_recent_captures prepare: {}", e))?;
  let rows = stmt
    .query_map(params![since_ms], |row| {
      Ok(CaptureRow {
        app_bundle_id: row.get::<_, String>(0)?,
        captured_at: row.get::<_, i64>(1)?,
        spatial_context: row.get::<_, Option<String>>(2)?,
      })
    })
    .map_err(|e| format!("patterns::fetch_recent_captures query: {}", e))?;
```

- [ ] **Step 2: Add spatial pass to `run_detection`**

Locate the end of `run_detection` (around line 285-295) — find where temporal/sequential passes finish and the function returns `Ok(emitted)`.

Read 30 lines around the end of `run_detection`:

```bash
sed -n '270,300p' src-tauri/src/patterns.rs
```

The body should end with something like:

```rust
  // (sequential pass code)
  Ok(emitted)
}
```

Use Edit. `old_string`:

```rust
  Ok(emitted)
}

pub fn list_for_brief(top_n: usize) -> Result<Vec<Value>, String> {
```

`new_string`:

```rust
  // ---- Spatial pass (Sub-spec F) ----
  let spatial_rows: Vec<crate::spatial_patterns::SpatialCaptureRow> = captures
    .iter()
    .filter_map(|cap| {
      let raw = cap.spatial_context.as_deref()?;
      let ctx: Value = serde_json::from_str(raw).ok()?;
      Some(crate::spatial_patterns::SpatialCaptureRow {
        app_bundle_id: cap.app_bundle_id.clone(),
        captured_at: cap.captured_at,
        spatial_context: ctx,
      })
    })
    .collect();
  emitted += crate::spatial_patterns::detect_spatial(&conn, &spatial_rows)?;

  Ok(emitted)
}

pub fn list_for_brief(top_n: usize, include_spatial: bool) -> Result<Vec<Value>, String> {
```

- [ ] **Step 3: Update `list_for_brief` SQL + label match**

Now find the body of `list_for_brief`. The SQL prepare statement filters by `status='active'` only. Add a kind filter when `!include_spatial`. Use Edit. `old_string` (the prepare statement — read it from the file first to get exact text):

```rust
      "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' ORDER BY confidence DESC, observed_n DESC LIMIT ?1",
```

`new_string`:

```rust
      if include_spatial {
        "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' ORDER BY confidence DESC, observed_n DESC LIMIT ?1"
      } else {
        "SELECT id, kind, trigger_json, action_json, confidence, observed_n FROM patterns WHERE status = 'active' AND kind != 'spatial' ORDER BY confidence DESC, observed_n DESC LIMIT ?1"
      },
```

This requires the `.prepare(...)` call to wrap a conditional expression. Verify by reading the surrounding code first:

```bash
sed -n '296,320p' src-tauri/src/patterns.rs
```

If the prepare call is `.prepare("SELECT ...",)` directly inline, the Edit above plugs in correctly. If it's `.prepare(r#"SELECT ..."#,)` with a raw string, the Edit needs to use the raw string form. Adjust accordingly — the SQL text content is the same.

- [ ] **Step 4: Add spatial label arm**

Find the existing `match kind.as_str() { "temporal" => ..., "sequential" => ..., _ => ... }` block in `list_for_brief`. Add a `"spatial"` arm. Use Edit. `old_string`:

```rust
      "sequential" => {
        let prev_label = trigger.get("prev_label").and_then(|v| v.as_str()).unwrap_or("an app");
        let action_label = action.get("label").and_then(|v| v.as_str()).unwrap_or("another app");
        format_sequential_label(prev_label, action_label)
      }
      _ => "Unknown pattern.".to_string(),
```

`new_string`:

```rust
      "sequential" => {
        let prev_label = trigger.get("prev_label").and_then(|v| v.as_str()).unwrap_or("an app");
        let action_label = action.get("label").and_then(|v| v.as_str()).unwrap_or("another app");
        format_sequential_label(prev_label, action_label)
      }
      "spatial" => {
        let display_label = trigger
          .get("display_label")
          .and_then(|v| v.as_str())
          .unwrap_or("a display");
        let quadrant = trigger
          .get("quadrant")
          .and_then(|v| v.as_str())
          .unwrap_or("");
        let app_label = action
          .get("label")
          .and_then(|v| v.as_str())
          .unwrap_or("an app");
        format!(
          "You usually keep {} in the {} quadrant of {}.",
          app_label, quadrant, display_label
        )
      }
      _ => "Unknown pattern.".to_string(),
```

- [ ] **Step 5: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: ERROR. Two callers of `list_for_brief` (in `brief.rs` and `commands.rs`) now have arity mismatch — they pass 1 arg but the signature requires 2. This is FIXED in Task 6.

If you see different errors:
- "no field `spatial_context` on `CaptureRow`" → Step 1 wasn't applied.
- "function `detect_spatial` is private" — confirm Task 4 made it `pub(crate)`.

- [ ] **Step 6: Commit (with known caller breakage)**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/patterns.rs
git diff --cached --stat
git commit -m "feat(kioku): patterns.rs spatial pass + list_for_brief include_spatial arg"
git show HEAD --stat
```

Must show exactly 1 file. Note: this commit alone leaves the build broken — that's OK, Task 6 fixes the two callers.

---

## Task 6: Update callers in brief.rs + commands.rs

**Files:**
- Modify: `src-tauri/src/brief.rs:220` — `list_for_brief(4)` → `list_for_brief(4, false)`.
- Modify: `src-tauri/src/commands.rs:2335` — `list_for_brief(50)` → `list_for_brief(50, true)`.

- [ ] **Step 1: Fix brief.rs caller**

Use Edit on `src-tauri/src/brief.rs`. `old_string`:

```rust
  let patterns_for_brief = crate::patterns::list_for_brief(4).unwrap_or_default();
```

`new_string`:

```rust
  let patterns_for_brief = crate::patterns::list_for_brief(4, false).unwrap_or_default();
```

- [ ] **Step 2: Fix commands.rs caller**

Use Edit on `src-tauri/src/commands.rs`. `old_string`:

```rust
  let items = crate::patterns::list_for_brief(50)?;
```

`new_string`:

```rust
  let items = crate::patterns::list_for_brief(50, true)?;
```

- [ ] **Step 3: Verify rust compiles**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -10
```

Expected: PASS. Pre-existing warnings only.

- [ ] **Step 4: Commit**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
git add src-tauri/src/brief.rs src-tauri/src/commands.rs
git diff --cached --stat
git commit -m "feat(kioku): brief excludes spatial; Settings includes spatial"
git show HEAD --stat
```

Must show exactly 2 files.

---

## Task 7: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Static checks**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All should PASS. Pre-existing warnings allowed.

- [ ] **Step 2: Spec § 10.2 manual walkthrough**

Prerequisite: Tauri app rebuilt with this branch's code, Accessibility permission granted, `axRichCapture` ON in Settings.

1. Rebuild and launch:
   ```bash
   cd /Users/torutano/ShogunAI3/ShogunAI3
   pgrep -f "target/debug/app" | xargs -r kill 2>&1
   sleep 2
   cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3
   bash scripts/tauri-dev-static-server.sh > /tmp/shogun-static-server.log 2>&1 &
   sleep 2
   nohup ./src-tauri/target/debug/app > /tmp/shogun3-app.log 2>&1 &
   sleep 4
   pgrep -fla "target/debug/app" | head -3
   ```

2. Use the app for ~5 minutes with windows scattered across displays/quadrants. The capture sampler runs every ~8 seconds, so 5 minutes should produce 30+ samples.

3. Inspect spatial captures:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT app_bundle_id, json_extract(spatial_context, '\$.display_id'), json_extract(spatial_context, '\$.quadrant') FROM mem_captures WHERE spatial_context IS NOT NULL ORDER BY captured_at DESC LIMIT 10;"
   ```
   Expect rows with non-null spatial_context, e.g. `com.tinyspeck.slackmacgap | 0 | NW`.

4. Force a detection run:
   ```js
   await window.SHOGUN_RUNTIME.executeAction('patterns.run_now', {})
   ```

5. Verify spatial patterns landed (will only appear with 3+ distinct days of capture):
   ```bash
   sqlite3 "$DB" "SELECT json_extract(trigger_json, '\$.quadrant'), json_extract(action_json, '\$.label'), confidence, observed_n FROM patterns WHERE kind='spatial' ORDER BY confidence DESC LIMIT 10;"
   ```

6. Settings → KIOKU Patterns → spatial entries should appear in the flat list, e.g. `You usually keep Slack in the SE quadrant of Display 0.` (Note: depends on having 3+ distinct days of data; use the synthetic seed in Step 3 to bypass.)

7. Refresh Home → Morning Brief → confirm spatial entries do **NOT** appear in `YOUR USUAL`. Only temporal/sequential should be visible there.

- [ ] **Step 3: Synthetic seed**

If you don't have 3+ days of real captures yet:

```bash
DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
sqlite3 "$DB" <<'SQL'
INSERT INTO mem_captures (type, app_bundle_id, captured_at, ttl_expires_at, spatial_context)
WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM cnt WHERE n<7)
SELECT
  'app',
  'com.tinyspeck.slackmacgap',
  ((unixepoch() - (n*86400)) * 1000 + (10*3600*1000)),
  ((unixepoch() + (90*86400)) * 1000),
  '{"display_id":0,"display_label":"Display 0","window_bounds":{"x":100,"y":100,"w":1000,"h":800},"quadrant":"SE"}'
FROM cnt;
SQL
```

This inserts 7 synthetic Slack samples on past 7 days, all in display 0 SE quadrant. Then re-run `patterns.run_now`:

```js
await window.SHOGUN_RUNTIME.executeAction('patterns.run_now', {})
```

Verify a spatial pattern appears:

```bash
sqlite3 "$DB" "SELECT kind, json_extract(trigger_json, '\$.quadrant'), json_extract(action_json, '\$.label'), observed_n FROM patterns WHERE kind='spatial';"
```

Expect at least 1 row: `spatial | SE | Slack | 7`.

Settings → KIOKU Patterns → confirm `You usually keep Slack in the SE quadrant of Display 0.` appears.

Cleanup synthetic seed:

```bash
sqlite3 "$DB" "DELETE FROM mem_captures WHERE app_bundle_id='com.tinyspeck.slackmacgap' AND raw_text IS NULL AND raw_path IS NULL AND spatial_context LIKE '%display_label%';"
sqlite3 "$DB" "DELETE FROM patterns WHERE kind='spatial' AND json_extract(action_json, '\$.app')='com.tinyspeck.slackmacgap';"
```

- [ ] **Step 4: Negative test**

- Toggle `axRichCapture` OFF → continue using app for 1 minute → confirm new mem_captures rows have `spatial_context IS NULL`.
- Restore `axRichCapture` ON.

- [ ] **Step 5: Orphan / leftover check**

```bash
cd /Users/torutano/ShogunAI3/ShogunAI3
grep -nE "TODO.*spatial|FIXME.*spatial" hifi/ src-tauri/src/ -r 2>/dev/null | grep -v node_modules | grep -v target | head -5
```

Expected: 0 hits.

- [ ] **Step 6: No commit (verification only)**

If all steps pass, Sub-spec F is complete. Report DONE with the SHA range from Tasks 1-6 (`git log --oneline HEAD~6..HEAD`).

If a step fails, fix the underlying cause as a follow-up commit on the appropriate file.
