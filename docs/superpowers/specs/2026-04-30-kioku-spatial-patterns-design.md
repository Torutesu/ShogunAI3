# KIOKU Sub-spec F — Spatial Patterns Design

**Status:** approved (2026-04-30)
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` § 4 Phase 2 (multi-display + focus graph), § 2 (`spatial` pattern kind)
**Predecessors:** Sub-spec B (Patterns MVP), Sub-spec C (Settings UI), Sub-spec D (Supersession), Sub-spec E (`prevented_n` verifier) — all shipped via PR #28 / #29.

---

## 1. Goal

Add a fourth pattern kind `kind='spatial'` to the KIOKU pattern detection layer. Each spatial pattern records "this app usually lives in this quadrant of this display" — picked up from window geometry the capture sampler reads via macOS Accessibility. Surfaced only in the Settings KIOKU Patterns tab; deliberately excluded from Morning Brief because spatial patterns aren't time-anchored.

## 2. Architecture

A new `spatial.rs` module owns capture-time work: read the focused window's bounds via existing `macos_ax`, enumerate displays via `CGGetActiveDisplayList`, compute the screen quadrant the window center falls in, and serialize as JSON into the existing `mem_captures.spatial_context` column. A new `spatial_patterns.rs` module owns detection: group captures by `(display_id, app_bundle_id, quadrant)` over the last 14 days and UPSERT into `patterns` when observed across 3+ distinct days. The existing `patterns::run_detection` orchestrator gains a third pass calling `spatial_patterns::detect_spatial`. `list_for_brief` is updated to accept an `include_spatial` flag so Brief can exclude spatial while Settings includes it.

## 3. Decisions Locked During Brainstorm

| # | Decision | Choice |
|---|----------|--------|
| 1 | Capture granularity | **B** — `display_id` + `window_bounds` (master spec literal). |
| 2 | Pattern detection shape | **B** — `(display_id, app_bundle_id, screen_quadrant)`; quadrant = NW/NE/SW/SE based on window center. |
| 3 | Capture sampler integration | **A** — gated on existing `axRichCapture` setting (same Accessibility permission required). |
| 4 | `display_id` format | **D revised → A** — ordinal only (`Display 0` / `Display 1`). NSScreen.localizedName requires main thread; `CGGetActiveDisplayList` does not. Trade label readability for runtime safety. |
| 5 | Brief exposure | **B** — Settings KIOKU Patterns tab only; excluded from Morning Brief. |

## 4. Module Layout

### 4.1 `src-tauri/src/spatial.rs` (new, ~110 LOC)

Public surface:

```rust
/// Capture spatial context for the currently focused window. Returns a
/// JSON string suitable for `mem_captures.spatial_context`, or `None` if
/// AX is not trusted, no window is focused, or display enumeration fails.
///
/// Caller MUST gate on `axRichCapture` setting + Accessibility permission.
pub fn capture_spatial_context() -> Option<String>;
```

JSON shape:

```json
{
  "display_id": 1,
  "display_label": "Display 1",
  "window_bounds": {"x": 1920, "y": 600, "w": 1200, "h": 480},
  "quadrant": "SW"
}
```

Internal helpers:
- `enumerate_displays() -> Vec<DisplayInfo>` — `CGGetActiveDisplayList` + `CGDisplayBounds` only (no NSScreen, no main-thread requirement).
- `find_display_for_point(displays, cx, cy) -> Option<&DisplayInfo>` — point-in-rect intersection.
- `quadrant_for_center(d, cx, cy) -> &'static str` — returns one of `"NW"`, `"NE"`, `"SW"`, `"SE"`.

### 4.2 `src-tauri/src/spatial_patterns.rs` (new, ~110 LOC)

Public surface (one entry point):

```rust
pub(crate) fn detect_spatial(
  conn: &Connection,
  captures: &[SpatialCaptureRow],
) -> Result<usize, String>;
```

Where:

```rust
pub(crate) struct SpatialCaptureRow {
  pub app_bundle_id: String,
  pub captured_at: i64,
  pub spatial_context: serde_json::Value, // already-parsed JSON or Value::Null
}
```

Internal:
- `upsert_spatial(...)` — `SELECT id WHERE kind='spatial' AND trigger_json=? AND action_json=?`, then UPDATE existing or INSERT new with `Uuid::new_v4()`.
- Trigger JSON identity: `{display_id, display_label, quadrant}`.
- Action JSON identity: `{app, label}` (matches existing patterns shape).
- Threshold: `observed_n >= 3` distinct days within the 14-day window (matches `temporal` / `sequential`).
- Confidence: `(observed_n / 14.0).min(1.0)` (matches existing).

### 4.3 Existing files modified

| File | Change | LOC |
|------|--------|-----|
| `src-tauri/src/macos_ax.rs` | `pub fn focused_window_geometry() -> Option<WindowGeometry>` + new `WindowGeometry` struct. Reads AXFocusedApplication → AXFocusedWindow → AXPosition + AXSize via `AXValueGetValue`. | +60 |
| `src-tauri/src/capture_sampler.rs` | When `axRichCapture` ON, call `spatial::capture_spatial_context()` and pass into `IngestInput.spatial_context_json` (currently always `None`). | +6 |
| `src-tauri/src/patterns.rs` | (a) `friendly_app_name` → `pub(crate)`; (b) `CaptureRow` adds `spatial_context: Option<String>`; (c) `fetch_recent_captures` SELECT adds `spatial_context`; (d) `run_detection` adds spatial pass calling `spatial_patterns::detect_spatial`; (e) `list_for_brief` gains `include_spatial: bool` second arg + SQL WHERE adds `AND kind != 'spatial'` when false; (f) `format_spatial_label` + spatial arm in label match. | +50 |
| `src-tauri/src/brief.rs:list_for_brief(4)` call | becomes `list_for_brief(4, false)` | +1 |
| `src-tauri/src/commands.rs:shogun_patterns_list` | `list_for_brief(50)` becomes `list_for_brief(50, true)` | +1 |
| `src-tauri/src/lib.rs` | `mod spatial;` + `mod spatial_patterns;` | +2 |

No schema changes. No new Tauri command. No new IPC action. No frontend changes.

## 5. Capture Path

### 5.1 macOS-only AX read (`macos_ax::focused_window_geometry`)

```rust
#[derive(Debug, Clone)]
pub struct WindowGeometry { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

#[cfg(target_os = "macos")]
pub fn focused_window_geometry() -> Option<WindowGeometry> {
  unsafe {
    let system = AXUIElementCreateSystemWide();
    if system.is_null() { return None; }
    let focused_app = copy_attr(system, "AXFocusedApplication")?;
    let win = copy_attr(focused_app as AXUIElementRef, "AXFocusedWindow")?;
    let pos = read_point(win as AXUIElementRef, "AXPosition");
    let size = read_size(win as AXUIElementRef, "AXSize");
    CFRelease(win); CFRelease(focused_app); CFRelease(system);
    match (pos, size) {
      (Some((x, y)), Some((w, h))) => Some(WindowGeometry { x, y, w, h }),
      _ => None,
    }
  }
}

#[cfg(not(target_os = "macos"))]
pub fn focused_window_geometry() -> Option<WindowGeometry> { None }
```

`read_point` / `read_size` use `AXValueGetValue` to unwrap CGPoint / CGSize from the opaque AXValue. New FFI declarations: `AXValueGetValue`, `AXValueGetTypeID`, plus `kAXValueCGPointType=1` / `kAXValueCGSizeType=2` constants.

### 5.2 Display enumeration (Core Graphics)

```rust
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
  fn CGGetActiveDisplayList(max_displays: u32, displays: *mut u32, display_count: *mut u32) -> i32;
  fn CGDisplayBounds(display: u32) -> CGRect;
}
```

Returns up to 16 active displays. For each: `ordinal` = position in array, `label` = `format!("Display {}", ordinal)`, `bounds` from `CGDisplayBounds`. No main-thread constraint, runs anywhere.

### 5.3 Sampler integration

In `capture_sampler.rs` near the existing `axRichCapture` branch:

```rust
let spatial_context_json = if ax_rich_capture {
  crate::spatial::capture_spatial_context()
} else {
  None
};
// pass into IngestInput.spatial_context_json
```

The Accessibility permission gate is implicit: `focused_window_geometry()` returns `None` when AX is not trusted, so no separate check is needed.

## 6. Detection Path

### 6.1 `patterns.rs::CaptureRow` shape change

```rust
struct CaptureRow {
  app_bundle_id: String,
  captured_at: i64,
  spatial_context: Option<String>,  // NEW: raw JSON string from mem_captures
}
```

`fetch_recent_captures` SELECT becomes:

```sql
SELECT app_bundle_id, captured_at, spatial_context
FROM mem_captures
WHERE captured_at >= ?1 AND app_bundle_id IS NOT NULL
ORDER BY captured_at ASC
```

### 6.2 `patterns.rs::run_detection` spatial pass

After existing temporal + sequential passes:

```rust
let spatial_rows: Vec<SpatialCaptureRow> = captures.iter().filter_map(|cap| {
  let raw = cap.spatial_context.as_deref()?;
  let ctx: serde_json::Value = serde_json::from_str(raw).ok()?;
  Some(SpatialCaptureRow {
    app_bundle_id: cap.app_bundle_id.clone(),
    captured_at: cap.captured_at,
    spatial_context: ctx,
  })
}).collect();
emitted += spatial_patterns::detect_spatial(&conn, &spatial_rows)?;
```

Captures without `spatial_context` (axRichCapture off, or pre-Sub-spec-F rows) are silently skipped via the `?` chain.

### 6.3 Detection algorithm (`spatial_patterns::detect_spatial`)

```
1. Group captures by (display_id: u32, app_bundle_id: String, quadrant: String)
2. For each group, count distinct days (chrono::Local::date_naive)
3. If days.len() >= 3:
     observed_n = days.len()
     friendly_app_name(app_bundle_id) → app_label
     display_label from any row in this group
     upsert_spatial(...) sets confidence = (observed_n / 14).min(1.0)
4. Return total UPSERTed count
```

Identical structure to `patterns::detect_temporal` minus the time-of-day fields.

## 7. UI Surface

### 7.1 Brief exclusion

`brief.rs::morning_brief_v2_stub`:

```rust
let patterns_for_brief = crate::patterns::list_for_brief(4, false).unwrap_or_default();
```

`list_for_brief` SQL when `include_spatial == false`:

```sql
SELECT id, kind, trigger_json, action_json, confidence, observed_n
FROM patterns
WHERE status = 'active' AND kind != 'spatial'
ORDER BY confidence DESC, observed_n DESC LIMIT ?1
```

### 7.2 Settings inclusion

`commands.rs::shogun_patterns_list`:

```rust
let items = crate::patterns::list_for_brief(50, true)?;
```

`include_spatial == true` → no kind filter, all 3 kinds included in confidence-sorted list. Existing Settings `KIOKU Patterns` tab renders them in the same flat list as temporal/sequential (Sub-spec C decision). The same `これ違う` button works for spatial via existing `patterns::invalidate(id)`.

### 7.3 Spatial label

In `patterns::list_for_brief` label match (after temporal / sequential arms):

```rust
"spatial" => {
  let display_label = trigger.get("display_label").and_then(|v| v.as_str()).unwrap_or("a display");
  let quadrant = trigger.get("quadrant").and_then(|v| v.as_str()).unwrap_or("");
  let app_label = action.get("label").and_then(|v| v.as_str()).unwrap_or("an app");
  format!("You usually keep {} in the {} quadrant of {}.", app_label, quadrant, display_label)
}
```

Example: `You usually keep Slack in the SE quadrant of Display 0.`

## 8. Error Handling

| Situation | Behaviour |
|-----------|-----------|
| `axRichCapture` OFF | `spatial_context_json = None`; spatial patterns never detected. |
| Accessibility permission denied | `focused_window_geometry()` → None → `capture_spatial_context()` → None. No log noise. |
| `CGGetActiveDisplayList` fails | `enumerate_displays()` returns empty vec → `capture_spatial_context()` → None. |
| Window center outside any display rect | `find_display_for_point` → None → `capture_spatial_context()` → None. |
| Malformed `spatial_context` JSON | `serde_json::from_str` returns `None` via `?`; the row is skipped from spatial detection only. |
| `display_id` overflow (theoretical >16) | Capped by `MAX=16` in `enumerate_displays`; ordinal stays `usize`-bounded. Use `u32` in `SpatialCaptureRow.display_id` for safety. |
| `upsert_spatial` SQL error | Bubbles up as `Err(...)`; `run_detection` returns Err; worker logs warn and retries on next tick. |
| Re-UPSERT same `(display_id, app, quadrant)` | SELECT-then-UPDATE/INSERT pattern is idempotent; status forced back to `'active'`. |

No retries inside the verifier path. No queue persistence. No user-facing surface.

## 9. Privacy

The capture sampler already collects:
- `frontmost_app_name` (process name)
- `axRichCapture` ON: `focused_ax_snapshot` (AX role/title/value text)

This sub-spec adds:
- Window bounds (4 floats: x, y, w, h)
- Display ordinal (0/1/2…) + bounds

Both are **metadata about geometry**, not screen content. Same Accessibility permission gate as existing AX text capture. BYOK posture unchanged: nothing leaves the device unless the user runs an LLM-driven flow that already touches their data.

## 10. Verification

### 10.1 Static checks

```bash
npm run check:rust 2>&1 | tail -5
npm run check:ipc-mock 2>&1 | tail -5
python3 hifi/scripts/check-actions.py 2>&1 | tail -5
```

All must PASS. Pre-existing warnings allowed.

### 10.2 Manual walkthrough

1. Grant Accessibility permission to the Tauri app via System Settings.
2. Settings → Capture → enable `axRichCapture`.
3. Use the app for ~5 minutes with windows scattered across displays/quadrants.
4. SQLite check:
   ```bash
   DB="$HOME/Library/Application Support/ai.Shogun.ShogunAI3/memory.db"
   sqlite3 "$DB" "SELECT app_bundle_id, json_extract(spatial_context, '$.display_id'), json_extract(spatial_context, '$.quadrant') FROM mem_captures WHERE spatial_context IS NOT NULL ORDER BY captured_at DESC LIMIT 10;"
   ```
   Expect rows with non-null `spatial_context`.
5. Force a detection run via DevTools console:
   ```js
   await window.SHOGUN_RUNTIME.executeAction('patterns.run_now', {})
   ```
6. SQLite check for spatial patterns:
   ```bash
   sqlite3 "$DB" "SELECT json_extract(trigger_json, '$.quadrant'), json_extract(action_json, '$.label'), confidence, observed_n FROM patterns WHERE kind='spatial' ORDER BY confidence DESC LIMIT 10;"
   ```
7. Settings → KIOKU Patterns → spatial rows should appear in the flat list, e.g. `You usually keep Slack in the SE quadrant of Display 0.`
8. Refresh Home → Morning Brief → confirm spatial rows do **NOT** appear in `YOUR USUAL`.

### 10.3 Negative test

- `axRichCapture` OFF: `spatial_context` should remain NULL across new mem_captures. No log warnings.
- Accessibility denied: same — no spatial_context, no errors.

### 10.4 Synthetic seed

For testing without 3 days of real usage:

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

7 synthetic Slack samples across 7 days, all in display 0 SE quadrant. After running `patterns.run_now`, expect a spatial pattern to appear with `observed_n >= 3`.

## 11. Out of Scope (Explicit)

- **`lessons.spatial_context` column** — `lessons.trigger_context` is JSONB, so spatial fields can be added there directly without ALTER. No schema change needed; lesson-side spatial usage is a future sub-spec.
- **Human-readable display label via NSScreen.localizedName** — main-thread requirement makes it incompatible with capture_sampler thread. Future: IOKit-based MfgID lookup (no thread constraint), or dispatch via `tauri::async_runtime`. Not blocking MVP.
- **Phase 3 spatial fields** (`gaze_target`, `dwell_ms`, `window_pose`) — visionOS-specific, separate sub-spec.
- **Full layout snapshot** (all visible windows per sample) — Section 1 option C; YAGNI for Phase 2.
- **User-side manual spatial pattern entry / edit** — patterns are observation-only.
- **Re-enabling spatial in Brief** — future toggle if user demand emerges.
- **Higher-resolution `window_bounds` bucketing** (10% increments etc.) — quadrant-4 quantization is the deliberate Phase 2 choice; finer granularity is a future iteration.
- **Independent spatial sync schedule** — rides existing `patterns_sync` 24h cadence.
- **AX-free spatial estimation** (NSWorkspace + `CGWindowListCopyWindowInfo`) — Phase 3 fallback for AX-denied environments.
- **Per-kind UI separation in Settings** — Sub-spec C committed to a single flat list; spatial appears alongside temporal/sequential.

## 12. File Change Summary

| File | Created / Modified | LOC |
|------|--------------------|-----|
| `src-tauri/src/spatial.rs` | Created | ~110 |
| `src-tauri/src/spatial_patterns.rs` | Created | ~110 |
| `src-tauri/src/macos_ax.rs` | Modified | +60 |
| `src-tauri/src/capture_sampler.rs` | Modified | +6 |
| `src-tauri/src/patterns.rs` | Modified | +50 |
| `src-tauri/src/brief.rs` | Modified | +1 |
| `src-tauri/src/commands.rs` | Modified | +1 |
| `src-tauri/src/lib.rs` | Modified | +2 |
| **Total** | 2 created, 6 modified | ~340 LOC |

## 13. Estimate

**~3 days**, including:
- macOS AX FFI verification (CGPoint / CGSize via AXValueGetValue)
- CG display enumeration sanity checks (multi-monitor & rotated displays)
- Quadrant boundary tests (window center exactly on midpoint)
- Synthetic seed walkthrough + manual eye-test

Shorter than the master spec's 5-7 day estimate because:
- `mem_captures.spatial_context` schema already exists (Phase 1 added the column).
- NSScreen complexity sidestepped via Core Graphics-only approach.
- No new Tauri command or frontend wiring required.

---

*Approved sections: § 1 / § 2 / § 3 (revised) / § 4 / § 5 / § 6 — all approved during brainstorm.*
