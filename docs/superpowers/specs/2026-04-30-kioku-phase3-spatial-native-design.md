# KIOKU Phase 3 — Spatial-Native Design (visionOS-First)

**Status:** design exercise (2026-04-30) — **NOT for implementation**
**Master spec:** `docs/superpowers/specs/2026-04-27-kioku-lessons-patterns-master-design.md` § 4 Phase 3 (visionOS spatial-native)
**Predecessors (foundation):** Sub-spec A (Lessons MVP) · Sub-spec B (Patterns MVP) · Sub-spec C (Settings UI) · Sub-spec D (Supersession) · Sub-spec E (`prevented_n` verifier) · Sub-spec F (Spatial Patterns — display × quadrant × app) · Sub-spec H (cost visibility)

> **Reading guide:** This is a **design exercise**, not a launch plan. It maps Phase 3 territory so future implementation can decompose cleanly. No code is provided. Each Sub-spec candidate is a one-screen sketch — when one is picked up, it should be expanded into a full Sub-spec design (matching Sub-spec D / E / F / H granularity) and then a writing-plans implementation plan.

---

## 1. Goal

Extend KIOKU's `mem_captures.spatial_context` and `patterns.kind='spatial'` to incorporate the new spatial signals available on **Apple Vision Pro / visionOS**: `gaze_target`, `dwell_ms`, `window_pose`. Open the door to a new lesson source — "this window layout breaks focus" — captured automatically when gaze leaves the work surface.

**What this is NOT:** a hardware-agnostic spatial engine. Phase 3 commits to visionOS-first (per master spec). Other platforms (Quest, future Pixel/Android XR) are accommodated via JSON-shape forward compatibility, not first-class API support.

## 2. Architecture

The whole Phase 2 stack — `mem_captures`, `patterns`, `lessons`, `cost_ledger`, capture sampler, `patterns_sync`, `supersession_sync`, `lessons_verifier`, Settings UI — stays unchanged. Phase 3 layers four extension points on top:

1. **JSON shape extension** (`spatial_context` adds `gaze_target` / `dwell_ms` / `window_pose` / `device_class` fields).
2. **Capture path extension** (visionOS-only sampler that fills the new fields when the new `spatialGazeCapture` setting is on).
3. **Pattern detection extension** (`kind='spatial'` detector grows new sub-categories — gaze attention, window pose).
4. **Lesson source extension** (low-quality session detector emits new lessons with the new spatial fields in `trigger_context`).

No schema migration. No new database tables. The existing `spatial_context TEXT` column already accepts arbitrary JSON; new fields are added to the JSON envelope, not the SQL schema.

## 3. Schema Extension (no migration)

Sub-spec F's `spatial_context` JSON shape:

```json
{
  "display_id": 0,
  "display_label": "Display 0",
  "window_bounds": {"x": 100, "y": 80, "w": 1200, "h": 900},
  "quadrant": "SE"
}
```

Phase 3 adds optional fields — all NULL-able, all readable by existing Sub-spec F detectors as no-ops:

```json
{
  "display_id": 0,
  "display_label": "Display 0",
  "window_bounds": {"x": 100, "y": 80, "w": 1200, "h": 900},
  "quadrant": "SE",

  "device_class": "vision_pro",
  "gaze_target": {
    "kind": "window",
    "id": "com.tinyspeck.slackmacgap",
    "dwell_ms": 5400,
    "since_ms": 1714521600000
  },
  "window_pose": {
    "position": [1.2, -0.3, -2.0],
    "orientation": [0.0, 0.707, 0.0, 0.707],
    "size_meters": [1.6, 0.9]
  }
}
```

**`device_class`** acts as the abstraction hook chosen during brainstorm (decision #1, option C). When this field is missing → assume `macos` (Sub-spec F captures). When present and `==vision_pro` → use Phase 3 detectors. Future device classes (`quest`, `android_xr`) join via the same field.

**`gaze_target.kind`**: `window` | `panel` | `surface` | `nothing`. Quantized values; raw eye coordinates are deliberately never stored (visionOS doesn't expose them, and we wouldn't store them if it did).

**`window_pose.position` / `orientation`**: standard ARKit conventions. `position` is meters relative to the user's "home" anchor at app launch. `orientation` is a quaternion `[x, y, z, w]`. `size_meters` is the window's rendered dimensions in physical space.

Existing Sub-spec F label `"You usually keep Slack in the SE quadrant of Display 0"` stays valid for `device_class='macos'` rows. Phase 3 detectors emit different labels (see § 5).

## 4. Privacy: `spatialGazeCapture` Setting

Per brainstorm decision #2 (option B): a **dedicated** `sections.capture.spatialGazeCapture` toggle, distinct from existing `axRichCapture`. Default OFF.

**Why separate from axRichCapture:**
- Eye tracking is among the most sensitive user signals. Apple positions it as the most-protected modality. A blanket "Accessibility metadata" consent doesn't cover gaze.
- visionOS already shows a system permission prompt for attention-based APIs. SHOGUN's toggle is the **second consent layer** — "OS-level access granted, AND I want SHOGUN to record this into KIOKU."
- Future device families may not even surface a system-level prompt. The SHOGUN-side toggle gives us a portable contract.

**Setting JSON shape** (`settings.json`):

```json
{
  "sections": {
    "capture": {
      "axRichCapture": true,
      "spatialGazeCapture": false
    }
  }
}
```

**UI surface** (Settings → Capture pane, immediately after `axRichCapture` row): single toggle + a one-sentence description hinting at the visionOS-only nature.

When OFF → all `gaze_target` / `window_pose` / `device_class='vision_pro'` fields stay null in `spatial_context`. Existing macOS spatial flow (Sub-spec F) is unaffected.

## 5. Sub-spec Candidates (decompose-when-implementing)

When Phase 3 is picked up, expand each candidate below into a full Sub-spec design (matching D/E/F/H granularity). Below: each candidate has a one-paragraph description, dependencies, and rough sizing.

### Sub-spec I (candidate) — Capture infra: visionOS spatial sampler

**Scope:** Add a visionOS-only capture path that fills `device_class`, `gaze_target`, `window_pose` into `mem_captures.spatial_context`. Mirrors `capture_sampler.rs` flow, but uses visionOS APIs (`attentionTransform`, Hover Effect proxies, RealityKit window pose) instead of macOS AX. New `spatialGazeCapture` setting gates the new fields.

**Dependencies:** Sub-spec F (existing spatial_context shape). visionOS SDK availability.

**Hardware prerequisite:** Apple Vision Pro device + Tauri visionOS support (currently experimental). May require waiting for upstream Tauri visionOS support or building a parallel native path.

**Estimate (when implementable):** ~5 days (most uncertainty is in the Tauri/visionOS bridge layer).

**Out of scope:** Pattern detection — that's Sub-spec J. Lesson source — that's Sub-spec L.

---

### Sub-spec J (candidate) — Pattern: gaze attention

**Scope:** New `patterns.kind='spatial'` sub-category that emits patterns like "You usually focus on Slack for 4-6 minutes before switching." Group `mem_captures` rows by `(gaze_target.id, dwell_bucket)` where `dwell_bucket` is a quantized range (e.g., `0-1m`, `1-3m`, `3-10m`, `10m+`). Detection threshold and confidence formula match Sub-spec F.

**Dependencies:** Sub-spec I (capture path producing `gaze_target`). Sub-spec F (pattern detection orchestrator).

**JSON shape addition** in `patterns.trigger_json`:

```json
{
  "kind": "gaze_attention",
  "gaze_target_kind": "window",
  "gaze_target_id": "com.tinyspeck.slackmacgap",
  "dwell_bucket": "1-3m"
}
```

**Estimate:** ~3 days.

**Brief / Settings exposure:** Same rules as Sub-spec F (excluded from Brief, included in Settings KIOKU Patterns). Label: `"You usually focus on Slack for 1-3 min sessions."`

---

### Sub-spec K (candidate) — Pattern: window pose habits

**Scope:** Detect "you usually place X window roughly here in 3D space." Quantize `window_pose.position` into a coarse 3D grid (e.g., 0.5m cubes around the user origin). Group by `(app_bundle_id, position_cell, orientation_facing)` over 14 days × 3+ days threshold.

**Dependencies:** Sub-spec I. Sub-spec F.

**Quantization design point:** The hardest part. Position is continuous; users don't put windows in pixel-exact spots. Cell size 0.5m is an initial guess — needs Vision Pro field testing to validate. Orientation can be quantized to "facing user" / "facing left" / "facing right" / "facing away" via dot-product against the head-forward vector at sample time.

**Estimate:** ~5 days (quantization tuning is the variable).

**Label example:** `"You usually keep Slack on your right (~1.5m, facing you)."`

---

### Sub-spec L (candidate) — Lesson source: low-quality session detector

**Scope:** A new lesson `category='low_quality_session'` source. When the user's gaze leaves the focused window early (e.g., within 30 seconds of dwell start) and stays away (e.g., 90+ seconds elsewhere), capture a lesson candidate with `trigger_context = {layout, time_of_day, prior_app}`. LLM generates the rule (e.g., `"Avoid placing Slack near focus area during deep work."`).

**Dependencies:** Sub-spec I. Sub-spec A (lesson capture machinery). Sub-spec E (verifier — though semantics for "respected vs violated" need rethinking for spatial lessons).

**Threshold tuning:** "Early gaze departure" is the trigger but the boundary is fuzzy. Conservative defaults: dwell < 30s on intended target, then >90s away → 1 candidate event. Cluster 3+ events with similar layout → emit lesson. All thresholds need Vision Pro field calibration.

**Estimate:** ~5 days (the LLM rule prompt + threshold calibration are the work).

**Privacy note:** This sub-spec sends gaze-departure metadata + spatial layout to the LLM rule generator. Falls under the existing BYOK contract (master spec § 5). `gaze_target.id` (window/app id) is shared, but no eye coordinates.

---

### Sub-spec M (candidate) — UI: KIOKU Patterns spatial filtering

**Scope:** Settings → KIOKU Patterns tab gains a `device_class` filter chip(s) so users can filter spatial patterns to "Mac only" / "Vision Pro only" / "Both." Pure UX polish; backend support is automatic since `device_class` is in the JSON.

**Dependencies:** Sub-spec C (existing tab). Phase 3 sub-specs J / K (which produce `device_class='vision_pro'` rows).

**Estimate:** ~1 day.

**Out of scope:** Per-device-class statistics breakdown ("how many patterns per device"). Saved for later.

---

### Sub-spec N (candidate) — visionOS Settings panel

**Scope:** A new Settings tab `KIOKU Spatial` that surfaces visionOS-specific signals: `spatialGazeCapture` toggle, gaze permission status, "current dwell session" live indicator, reset-window-pose-baseline button. Read-only by default; mutates only via existing actions.

**Dependencies:** Sub-spec I. Sub-spec C (Settings tab pattern).

**Estimate:** ~2 days.

**Out of scope:** Settings tab on macOS (the tab only renders on visionOS devices — gated by runtime detection, not just OS).

## 6. Suggested Implementation Order (when Phase 3 starts)

1. **I (capture infra)** — first, because nothing else has signal without it.
2. **M (UI filter chip)** — simultaneously, low-cost, surfaces I's data immediately.
3. **N (visionOS Settings panel)** — third, gives the user a control surface before adding more learning loops.
4. **J (gaze attention pattern)** — fourth, the simplest detector, validates the pipeline.
5. **K (window pose pattern)** — fifth, depends on quantization tuning that benefits from J's lessons.
6. **L (low-quality lesson source)** — last, depends on I/J/K maturity for trustworthy signals to drive lesson generation.

Total est. when consecutively implemented: **~21 days** of focused engineering, plus uncalibrated threshold tuning time on real Vision Pro hardware.

## 7. Out of Scope (Phase 3 master design — explicit non-goals)

- **Multi-platform first-class support** — Quest / Android XR are accommodated via `device_class` extensibility but not designed-against here.
- **Foveated rendering integration** — no GPU / rendering changes. KIOKU is metadata-only.
- **Eye biometrics for identification** — gaze data is observational, not authentication.
- **Cross-session gaze replay or gaze video** — strictly aggregate counts (dwell_ms, target_id), no temporal trace.
- **Public-facing "spatial profile" sharing** — Phase 3 stays consistent with master spec § 5 (no cross-user data sharing).
- **Pure spatial chat surfacing** — Brief / Hummingbird stay 2D-rendering for Phase 3.
- **Cost estimation for Phase 3 LLM calls** — Sub-spec H already records all KIOKU LLM costs; new purpose constants for spatial lessons inherit the existing pattern when L is implemented.
- **VisionOS Tauri wrapper itself** — out of scope of this design. Assume some bridge exists (Tauri-visionOS or a parallel native target).
- **Code-level FFI specifics** — design exercise only (per user direction), no Rust / Swift snippets.
- **Hardware procurement timeline** — Vision Pro availability in Japan / target markets is a separate operational concern.

## 8. Triggers for Implementation Start

This design is dormant until at least one of the following is true:

- **Trigger A:** A SHOGUN team member (or contributing user) has a Vision Pro device and can run + test on it.
- **Trigger B:** Tauri's visionOS bridge reaches stable status (currently experimental as of Tauri 2.x).
- **Trigger C:** Master spec § 9 success metrics for Phase 1-2 (lessons applies_n / sessions ≥ 30%, user_rejection halved) are validated, indicating KIOKU's foundation is solid enough to invest in spatial extension.

Until then, this document is the marker that says "we know what to build when the time comes."

## 9. Decisions Locked During Brainstorm (for future reference)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Hardware scope | Apple Vision Pro specific + abstraction hooks (`device_class` field, JSON-shape extensibility) | Specificity for first impl, forward-compat for Quest / future. |
| 2 | Gaze privacy | New `spatialGazeCapture` toggle, default OFF, distinct from `axRichCapture` | Eye tracking is more sensitive than AX metadata; second consent layer. |
| 3 | Decomposition | One master design (this doc) + 6 sub-spec candidates inside | Avoids premature detail while preserving structure. |
| 4 | Scope-out | All implementation specifics (Rust code, visionOS API exact usage, performance models, migration plans, cost estimates) excluded | Design-only exercise per user direction. |

---

*This design is intentionally a frozen marker. When Phase 3 implementation begins, expand candidate sub-specs (I-N) into full design docs matching Sub-spec D / E / F / H granularity, then proceed via the standard brainstorming → writing-plans → subagent-driven-development loop.*
