# SHOGUN Phase 2.0c — Emergency Stop Tray Design

**Status:** draft (2026-05-04) — awaiting user review
**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.2 (緊急停止ボタン)
**Predecessor phases:** 2.0a (PR #32 — sensitive filter), 2.0b (PR #36 — sync_status column)
**Successors:** Phase 2.0d (Memory export/import — separate spec), Phase 2.1 (Memory Mirror MVP)

---

## 1. Goal

Give the user a one-click way to stop ALL capture from the macOS menu bar without having to open the SHOGUN window. This is the master spec's "緊急停止ボタン (menu bar から1クリックで capture停止)" — non-negotiable safety feature that must ship before any cloud sync feature, so users can confidently halt capture in unexpected situations (someone walking up to the screen, sensitive document accidentally opened, etc.).

The mechanism is **deliberately simple**: a tray icon that:
1. Visually reflects whether capture is running or paused
2. Opens a small menu on click with a Pause/Resume toggle (and a couple of utility items)
3. Persists state through `sections.capture.paused` (already wired to `sampler_should_run_for` in `capture_sampler.rs`)

## 2. Why this is its own phase

The pieces already exist independently:
- `app_capture_pause` / `app_capture_resume` Tauri commands write `sections.capture.paused`
- `capture_sampler::sampler_should_run_for(doc)` reads that flag and the loop respects it (the next wakeup after toggling will not ingest new memories)

What's missing is the **menu bar surface** — without it, users have to find Settings → General → Pause Capture, which is too slow for an emergency. Adding a system tray entry to Tauri is a small, well-contained change but it touches platform setup code (Tauri builder), an icon asset, and a thin event bridge to the frontend, so it's worth its own phase rather than smuggled into 2.0b's schema work.

## 3. Scope (in / out)

**In scope:**

- Tauri 2 system tray (`tauri::tray::TrayIconBuilder`) with two icon variants — `tray-active.png` (running) and `tray-paused.png` (paused)
- A small tray menu with three items:
  - **Pause / Resume capture** (label flips based on state; clicking calls the existing `app_capture_pause` / `app_capture_resume` internally)
  - **Open SHOGUN AI** (focus / show the main window)
  - **Quit** (exit the app)
- Tray icon swap on every toggle (synchronous; happens inside the Rust handler)
- Frontend listens to a new `shogun-capture-state-changed` event and refreshes any UI that displays the paused state (Settings → General toggle, capture-status indicator if any)
- Unit tests on the platform-agnostic helpers (label computation, icon-name selection)
- Manual smoke as the primary integration test (Tauri tray binding is hard to drive from headless tests)

**Out of scope (deferred):**

- Tray on Windows / Linux — codepaths gated to `#[cfg(target_os = "macos")]` for 2.0c. Other platforms get the existing in-app pause toggle only. Cross-platform tray is Phase 2.0c.1 (or later) when there are users on those platforms.
- Tray menu submenus / accelerators / hotkeys
- Notifications / sound on toggle (intentionally silent — running capture in the background should not be loud)
- Adding ANY new Tauri command — uses `app_capture_pause` / `app_capture_resume` exactly as they exist today

## 4. Decisions Locked During Brainstorm

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Click behavior | Left-click and right-click both open the menu | Explicit menu prevents misclicks from accidentally toggling capture. With the menu open, the user sees the current state ("Pause capture" vs "Resume capture") and selects. |
| D2 | Icon variants | Two PNGs: running uses the existing brand color, paused uses a desaturated / muted version. Both rendered via Tauri's `Image::from_bytes`. | A glanceable status indicator is the whole point of the tray. |
| D3 | Persistence | Reuses `sections.capture.paused` — no new schema, no new keys. | Single source of truth; survives restarts because settings already do. |
| D4 | Confirm before Pause | None | Emergency stop is meant to be instant. |
| D5 | Confirm before Resume | None | Symmetric with D4; resuming captures a memory or two until the next sample, which is fine. |
| D6 | Menu items | Pause/Resume, Open SHOGUN AI, Quit (3 items, 2 separators) | Minimal. Settings access stays in the main window. |
| D7 | Toast on toggle | None — only the tray icon changes | Silent UX is correct for a privacy feature. The visible icon swap is the feedback. |
| D8 | Frontend sync | Emit Tauri event `shogun-capture-state-changed` after each toggle; existing capture-status UI subscribes | Matches the existing event pattern (`shogun-capture-ax-not-trusted` already used in `capture_sampler.rs`) |
| D9 | Naming | spec `2026-05-04-emergency-stop-tray-design.md`; plan same date; branch `feat/cloud-2-0c-emergency-stop-tray` | Matches 2.0a/2.0b convention. |
| D10 | Cross-platform | macOS only for 2.0c (`#[cfg(target_os = "macos")]`); Windows / Linux ship without a tray and rely on the in-app pause toggle | We have no non-Mac users today; cross-platform tray is best done when there's a real test target. |

## 5. Module Layout

### 5.1 `src-tauri/src/capture_tray.rs` (new, ~180 LOC)

New module owning the tray lifecycle:

```rust
//! macOS menu-bar tray for emergency capture stop. Reads/writes
//! `sections.capture.paused` via the existing app_capture_pause /
//! app_capture_resume commands. See spec
//! 2026-05-04-emergency-stop-tray-design.md.

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) -> Result<(), String> { /* ... */ }

#[cfg(target_os = "macos")]
fn current_paused(app: &tauri::AppHandle) -> bool { /* read settings */ }

#[cfg(target_os = "macos")]
fn refresh_icon(app: &tauri::AppHandle, paused: bool) -> Result<(), String> { /* swap PNG */ }

// Pure helpers — testable on any platform.
pub fn pause_resume_label(paused: bool) -> &'static str {
  if paused { "Resume capture" } else { "Pause capture" }
}

pub fn icon_asset_for(paused: bool) -> &'static str {
  if paused { "tray-paused.png" } else { "tray-active.png" }
}
```

The pure helpers (`pause_resume_label`, `icon_asset_for`) are unit-testable. The `install`, `current_paused`, `refresh_icon` functions are Tauri-bound and verified by manual smoke.

### 5.2 `src-tauri/icons/tray-active.png` and `src-tauri/icons/tray-paused.png` (new assets)

Two 22×22 PNGs (Apple's recommended menu-bar size for non-Retina baseline; @2x and @3x variants nice-to-have but not required for 2.0c). Mark the `tauri.conf.json` resource bundling so they ship with the .app.

### 5.3 `src-tauri/src/lib.rs` (modify, ~5 LOC)

Add `mod capture_tray;` declaration and call `capture_tray::install(app)` from the Tauri builder's `setup` callback (macOS only).

### 5.4 `src-tauri/Cargo.toml` (modify, 1 LOC)

Add `tauri = { ..., features = ["tray-icon"] }` to enable the tray feature flag if not already on. (Verify in the existing manifest; current build may already include it.)

### 5.5 `src-tauri/tauri.conf.json` (modify, ~3 LOC)

Add `tray-active.png` and `tray-paused.png` to the `bundle.resources` list and define `app.trayIcon = { iconPath: "icons/tray-active.png", iconAsTemplate: true }` for the default startup icon.

### 5.6 `hifi/lib/ipc-client.js` and `hifi/app.jsx` mock IPC (modify, ~10 LOC each)

The frontend Settings → General "Pause capture" toggle already exists and calls `app_capture_pause` / `app_capture_resume`. Add a listener for the new `shogun-capture-state-changed` Tauri event so the UI re-loads settings when the tray toggles state from outside the window. In mock mode (browser preview / E2E), the event never fires — that's fine; mock mode has no tray.

## 6. Test Strategy

| ID | Case | Setup | Assertion |
|----|------|-------|-----------|
| T1 | `pause_resume_label` reflects state | unit | `pause_resume_label(false) == "Pause capture"`; `pause_resume_label(true) == "Resume capture"` |
| T2 | `icon_asset_for` reflects state | unit | `icon_asset_for(false) == "tray-active.png"`; `icon_asset_for(true) == "tray-paused.png"` |
| T3 | Tray emits `shogun-capture-state-changed` after toggle | manual smoke | Open dev build, click tray → Pause capture, observe Settings → General toggle flip without reload |
| T4 | Capture actually stops on Pause | manual smoke | `cd src-tauri && tail -f .../shogun.log`; click tray → Pause; verify no new "capture: …" log lines appear; click → Resume; verify they resume |
| T5 | Tray icon survives app restart in paused state | manual smoke | Pause, quit, relaunch — icon comes up muted; capture stays paused until the user clicks Resume |
| T6 | Cross-platform safety | unit (compile-only) | `cargo check --target x86_64-unknown-linux-gnu` (or equivalent) compiles without `tauri::tray` references because `capture_tray::install` is gated to macOS |

T3-T5 are explicitly manual because Tauri tray bindings can't be driven by Playwright/headless. T1, T2, T6 are scriptable. The plan flags this honestly rather than pretending automated coverage replaces the manual smoke.

## 7. Risks and Mitigations

- **Tauri 2 tray API stability**: `tauri::tray` is in the public API as of Tauri 2.0. Pinning the existing `tauri = "2.10.3"` version in `Cargo.toml` is sufficient — no breaking change between minor versions in 2.x.
- **Icon assets missing on disk**: `tauri.conf.json` resource bundling enforces presence at build time. If the PNG is missing, `cargo tauri build` fails fast with a clear error.
- **Tray click handler running off-thread**: Tauri tray menu callbacks run on the main thread by default. The pause/resume helpers are synchronous file writes (settings.json) plus an event emit — fast enough for a click handler. No blocking I/O.
- **Settings race with main window**: If the user opens Settings → Pause toggle and clicks the tray Pause at the same moment, both write `paused: true` (or both could write opposing values in theory). The `settings_store::save_patch` uses a file lock; the second writer's value wins, and the tray icon refresh on the event will reconcile. Acceptable race for a manual UI surface.
- **Quit menu item bypasses graceful shutdown**: Investigate whether `app.exit(0)` triggers Tauri's existing on-close hooks (capture sampler thread cleanup, settings flush). If not, route through the existing `app_quit` command instead. Plan Task 4 verifies this.

## 8. Acceptance Criteria

| Criterion | Verified by |
|-----------|-------------|
| Tray icon appears in macOS menu bar after first launch | T5 manual |
| Click → menu → Pause → no new captures | T4 manual |
| Click → menu → Resume → captures resume | T4 manual |
| Pause/Resume label flips based on current state | T1 unit + T3 manual |
| Icon variant matches state | T2 unit + T5 manual |
| State persists across restart | T5 manual |
| Settings UI updates when tray toggles | T3 manual |
| Linux/Windows builds compile | T6 unit |
| `cargo test -p app` green | full suite |
| `npm run check:rust` green | clippy + fmt |

## 9. Open Questions for Reviewer

- **Quit menu item routing**: should it call `app_quit` (graceful) or `app.exit(0)` (immediate)? Spec recommends `app_quit` for symmetry with the consent flow's decline path; controller should confirm.
- **Icon assets**: do we want to commission custom icons for the active/paused states, or use a generic SHOGUN brand mark with a "pause" overlay for the paused variant? The plan defers asset decisions to implementation time but flags it.
- **Show tray on first launch only after consent acceptance**: should `capture_tray::install` run unconditionally at app startup, or wait until after the consent gate (PR #35) closes? Recommended **unconditional** — the tray is a privacy control, and a user who hasn't accepted ToS won't be capturing yet anyway, but having the tray visible signals "this is what stops capture" even before they're capturing. Controller to confirm.

Both can be flipped at plan-review time without re-doing the design.
