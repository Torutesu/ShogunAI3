# SHOGUN Phase 2.0c — Emergency Stop Tray Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS menu-bar tray icon that lets the user pause/resume capture in one click, persisting through `sections.capture.paused`. No user-visible behavior change to the existing pause mechanism — just a new surface.

**Architecture:** New `src-tauri/src/capture_tray.rs` module owns the Tauri tray lifecycle and a small click-handler that calls into the existing `app_capture_pause` / `app_capture_resume` commands. Two PNG assets are bundled as Tauri resources. A new event `shogun-capture-state-changed` lets the frontend Settings UI stay in sync.

**Tech Stack:** Rust (Tauri 2 `tauri::tray::TrayIconBuilder`, `tauri::menu::MenuBuilder`), 2 PNG assets, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-04-emergency-stop-tray-design.md`

**Master spec:** `docs/superpowers/specs/2026-04-30-shogun-cloud-architecture.md` § 2.2

**Predecessors:** PR #32 (Phase 2.0a), PR #36 (Phase 2.0b). Independent of both technically — only depends on `app_capture_pause` / `app_capture_resume` already on `main`.

---

## File Map

**Created:**
- `src-tauri/src/capture_tray.rs` (~180 LOC) — `install`, `pause_resume_label`, `icon_asset_for`, `current_paused`, `refresh_icon`, click handler, plus 6 unit tests
- `src-tauri/icons/tray-active.png` (asset) — 22×22 menu-bar icon, brand color
- `src-tauri/icons/tray-paused.png` (asset) — 22×22 menu-bar icon, desaturated

**Modified:**
- `src-tauri/Cargo.toml` — verify / add `tray-icon` to `tauri = { features = […] }` (likely +1 LOC, possibly already present)
- `src-tauri/tauri.conf.json` — add `tray-active.png` / `tray-paused.png` to `bundle.resources`; declare `app.trayIcon` (~5 LOC)
- `src-tauri/src/lib.rs` — `mod capture_tray;` + call `capture_tray::install(app.handle())` from the Tauri builder `setup` callback (~3 LOC, macOS-gated)
- `hifi/lib/ipc-client.js` — listen for `shogun-capture-state-changed` and re-load settings on receipt (~8 LOC)
- `hifi/app.jsx` — mock IPC mockable (no-op listener registration, no event ever fires in browser preview) (~3 LOC)

**No changes:**
- `src-tauri/src/commands.rs` — uses existing `app_capture_pause` / `app_capture_resume` as-is.
- `src-tauri/src/capture_sampler.rs` — already reads `sections.capture.paused`; behavior unchanged.

**Verification gates** (run after Task 5): `npm run check:rust` + `cargo test -p app` + `cargo check --target x86_64-unknown-linux-gnu` (or fallback: confirm `#[cfg(target_os = "macos")]` gates compile clean on the host) + manual smoke per spec § 8.

---

## Task 1: Create `capture_tray.rs` skeleton with pure helpers and tests

**Files:**
- Create: `src-tauri/src/capture_tray.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod capture_tray;`)

This task is platform-agnostic: pure helper functions + their unit tests. No Tauri tray API yet; that lands in Task 3.

- [ ] **Step 1: Create `src-tauri/src/capture_tray.rs` with pure helpers**

```rust
//! macOS menu-bar tray for emergency capture stop. The user can pause / resume
//! capture in one click without opening the SHOGUN window. Reads / writes
//! `sections.capture.paused` via the existing `app_capture_pause` /
//! `app_capture_resume` commands. See spec
//! `docs/superpowers/specs/2026-05-04-emergency-stop-tray-design.md`.

/// Label shown on the tray menu item that toggles capture state.
pub fn pause_resume_label(paused: bool) -> &'static str {
  if paused {
    "Resume capture"
  } else {
    "Pause capture"
  }
}

/// Icon asset filename (relative to the bundled `icons/` resources dir).
pub fn icon_asset_for(paused: bool) -> &'static str {
  if paused {
    "tray-paused.png"
  } else {
    "tray-active.png"
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn label_running() { assert_eq!(pause_resume_label(false), "Pause capture"); }

  #[test]
  fn label_paused() { assert_eq!(pause_resume_label(true), "Resume capture"); }

  #[test]
  fn icon_running() { assert_eq!(icon_asset_for(false), "tray-active.png"); }

  #[test]
  fn icon_paused() { assert_eq!(icon_asset_for(true), "tray-paused.png"); }
}
```

- [ ] **Step 2: Wire the module into `lib.rs`**

In `src-tauri/src/lib.rs`, find the existing `mod` declaration block (alphabetical area). Add `mod capture_tray;` in the right alphabetical slot. Do NOT yet call `install` from the Tauri builder — that's Task 3.

- [ ] **Step 3: Verify compile + tests pass**

```bash
cd src-tauri && cargo test -p app capture_tray 2>&1 | tail -10
```

Expected: 4/4 helper tests pass. No new warnings beyond the existing 20.

---

## Task 2: Add icon assets and Tauri resource bundling

**Files:**
- Create: `src-tauri/icons/tray-active.png`
- Create: `src-tauri/icons/tray-paused.png`
- Modify: `src-tauri/tauri.conf.json` (bundle.resources, app.trayIcon)

This task ships the visual assets. The icons should be 22×22 PNGs (Apple's menu-bar baseline). For 2.0c, generic placeholders are acceptable as long as they visually distinguish running from paused; commissioning final art is a follow-up.

- [ ] **Step 1: Source / generate PNGs**

Either (a) commission custom icons from design, or (b) use a public-domain "play"/"pause" glyph rendered to 22×22. For E2E testing this can be a simple solid-colored circle (running = green, paused = grey) — final art doesn't block the implementation.

- [ ] **Step 2: Add to `tauri.conf.json` resources**

Locate the `bundle.resources` array (likely `"resources": [...]` near the top of the bundle section). Add:

```json
"resources": [
  "icons/tray-active.png",
  "icons/tray-paused.png",
  ...existing entries...
]
```

- [ ] **Step 3: Declare default tray icon in `tauri.conf.json`**

Add an `app.trayIcon` entry:

```json
"app": {
  ...
  "trayIcon": {
    "iconPath": "icons/tray-active.png",
    "iconAsTemplate": true
  }
}
```

`iconAsTemplate: true` lets macOS apply the system menu-bar tinting (so the icon respects the user's light/dark menu-bar preference).

- [ ] **Step 4: Verify build picks up resources**

```bash
cd src-tauri && cargo build 2>&1 | tail -5
```

Expected: clean build. The PNGs themselves don't need to exist for the build to succeed (Tauri reads the conf at build time but copies the files at bundle time), but `cargo tauri build` later in CI will fail if they're missing.

---

## Task 3: Implement Tauri tray install + click handler (macOS-gated)

**Files:**
- Modify: `src-tauri/src/capture_tray.rs` (add `#[cfg(target_os = "macos")]` block)
- Modify: `src-tauri/src/lib.rs` (call `capture_tray::install` from setup)

- [ ] **Step 1: Add `current_paused` and `refresh_icon` helpers**

Inside `capture_tray.rs`, add (gated to macOS):

```rust
#[cfg(target_os = "macos")]
mod platform {
  use serde_json::Value;
  use tauri::{AppHandle, Manager};

  pub fn current_paused(app: &AppHandle) -> bool {
    crate::settings_store::load()
      .ok()
      .and_then(|d: Value| {
        d.pointer("/sections/capture/paused")
          .and_then(|v| v.as_bool())
      })
      .unwrap_or(true) // default to paused if settings missing — matches sampler_should_run_for
  }

  pub fn refresh_icon(app: &AppHandle, paused: bool) -> Result<(), String> {
    let asset = super::icon_asset_for(paused);
    let resolver = app.path();
    let icon_path = resolver
      .resolve(format!("icons/{}", asset), tauri::path::BaseDirectory::Resource)
      .map_err(|e| e.to_string())?;
    let image = tauri::image::Image::from_path(&icon_path).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("shogun-capture-tray") {
      tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
    }
    Ok(())
  }
}
```

The `tray_by_id` lookup uses the same id you'll set in Step 2. If the tray isn't yet installed, this is a no-op.

- [ ] **Step 2: Implement `install` with TrayIconBuilder**

```rust
#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
  use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager,
  };

  let paused = platform::current_paused(app);
  let initial_icon = platform::icon_asset_for_path(app, paused)?;

  let pause_resume = MenuItemBuilder::new(pause_resume_label(paused))
    .id("toggle-capture")
    .build(app)
    .map_err(|e| e.to_string())?;
  let open_window = MenuItemBuilder::new("Open SHOGUN AI")
    .id("open-window")
    .build(app)
    .map_err(|e| e.to_string())?;
  let quit = MenuItemBuilder::new("Quit")
    .id("quit")
    .build(app)
    .map_err(|e| e.to_string())?;

  let menu = MenuBuilder::new(app)
    .items(&[
      &pause_resume,
      &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
      &open_window,
      &PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?,
      &quit,
    ])
    .build()
    .map_err(|e| e.to_string())?;

  let app_handle = app.clone();
  TrayIconBuilder::with_id("shogun-capture-tray")
    .icon(initial_icon)
    .icon_as_template(true)
    .menu(&menu)
    .on_menu_event(move |app, event| {
      handle_menu_event(app, event.id().as_ref());
    })
    .build(app)
    .map_err(|e| e.to_string())?;

  Ok(())
}
```

- [ ] **Step 3: Implement `handle_menu_event`**

```rust
#[cfg(target_os = "macos")]
fn handle_menu_event(app: &tauri::AppHandle, id: &str) {
  match id {
    "toggle-capture" => {
      let paused_now = platform::current_paused(app);
      // Flip via the existing settings_store helper; no new IPC command.
      let _ = crate::settings_store::save_patch(&serde_json::json!({
        "section": "capture",
        "paused": !paused_now,
      }));
      let _ = platform::refresh_icon(app, !paused_now);
      let _ = app.emit("shogun-capture-state-changed", serde_json::json!({
        "paused": !paused_now,
      }));
      // Refresh the menu item label too — needs to rebuild the menu since
      // MenuItem labels aren't mutable in Tauri 2 directly. Acceptable cost
      // for an emergency action; do not optimize.
      let _ = install(app); // re-run install to rebuild the menu with new label
    }
    "open-window" => {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }
    "quit" => {
      // Use app_quit semantics if it exposes a programmatic path; else app.exit.
      app.exit(0);
    }
    _ => {}
  }
}
```

The `install(app)` re-call inside `toggle-capture` is intentional — Tauri 2's `MenuItem` text isn't mutable post-build, so we rebuild. Cost is negligible (the user only clicks once per emergency).

- [ ] **Step 4: Wire `install` into the Tauri builder setup**

In `src-tauri/src/lib.rs`, find the `setup` callback. Add:

```rust
#[cfg(target_os = "macos")]
{
  let handle = app.handle().clone();
  if let Err(err) = capture_tray::install(&handle) {
    log::warn!("capture_tray install failed: {}", err);
  }
}
```

The `if let Err` so a tray-install failure doesn't crash the whole app — log and continue.

- [ ] **Step 5: Compile + run dev build**

```bash
cd src-tauri && cargo check 2>&1 | tail -3
```

Expected: clean compile (only existing 20 warnings).

```bash
npm run tauri:dev
```

Expected: tray icon appears in menu bar; menu opens on click; Pause / Resume / Open / Quit visible.

---

## Task 4: Frontend event listener

**Files:**
- Modify: `hifi/lib/ipc-client.js` (add event subscription)

The Settings → General "Pause capture" toggle reads `sections.capture.paused` on mount. When the tray toggles state from outside the window, the toggle should reflect the new state without a page reload.

- [ ] **Step 1: Subscribe to `shogun-capture-state-changed`**

In `ipc-client.js`, locate the existing event subscription pattern (search for `__TAURI__.event.listen` or `Tauri.event.listen`). Add:

```js
if (global.__TAURI_INTERNALS__) {
  // Tauri runtime: listen for tray-driven capture state changes.
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen("shogun-capture-state-changed", () => {
      // Trigger a settings refresh so any UI bound to capture.paused re-reads.
      const evt = new CustomEvent("shogun-settings-refresh");
      window.dispatchEvent(evt);
    });
  });
}
```

- [ ] **Step 2: Add a settings-refresh handler in `app.jsx`**

The Settings modal's General pane already reads from the IPC client. Wire a one-line `useEffect` that listens for `shogun-settings-refresh` and triggers the same load it does on mount.

- [ ] **Step 3: Verify in mock mode**

```bash
npm run test:e2e -- hifi-smoke
```

Expected: 24 pass (no regression — the listener registration is no-op in mock mode because `__TAURI_INTERNALS__` is missing).

---

## Task 5: Verification gates

- [ ] **Step 1: `npm run check:rust`**

```bash
npm run check:rust 2>&1 | tail -5
```

- [ ] **Step 2: `cargo test -p app`**

```bash
cd src-tauri && cargo test -p app 2>&1 | tail -5
```

Expected: existing 535 + 4 new tray helper tests = 539 pass.

- [ ] **Step 3: `cargo check` for non-macOS targets (optional but recommended)**

```bash
cd src-tauri && cargo check --target x86_64-unknown-linux-gnu 2>&1 | tail -5
```

If the target isn't installed locally, a simpler heuristic: confirm the file compiles by toggling `#[cfg(target_os = "macos")]` to `#[cfg(any())]` temporarily and running `cargo check`. Revert before commit.

- [ ] **Step 4: `npm run test:e2e`**

```bash
npm run test:e2e 2>&1 | grep -E "passed|failed" | tail -3
```

Expected: 24 pass (baseline; mock mode unaffected).

- [ ] **Step 5: Manual smoke (T3, T4, T5)**

Run the dev build. Verify:
1. Tray icon appears in menu bar on launch
2. Click → menu opens; Pause capture is visible
3. Click Pause → icon swaps to muted variant; in `tail -f .../shogun.log`, no new "capture: …" lines
4. Click → menu now shows Resume capture; click → icon swaps back; capture log lines resume
5. Quit + relaunch in paused state → icon comes up muted; capture stays paused

---

## Task 6: Commit + Draft PR

- [ ] **Step 1: Commit**

Either one cohesive commit or split:

```
feat(capture): Phase 2.0c — emergency stop menu-bar tray

Add a macOS menu-bar tray icon that lets the user pause / resume
capture in one click without opening the SHOGUN window. Implements
the master spec § 2.2 "緊急停止ボタン" privacy requirement.

- New `capture_tray` module installs a Tauri 2 tray icon with a small
  menu (Pause/Resume capture, Open SHOGUN AI, Quit)
- Two PNG assets bundled as Tauri resources; iconAsTemplate so they
  follow the user's menu-bar appearance
- Click handler toggles `sections.capture.paused` via the existing
  settings_store; emits `shogun-capture-state-changed` so the
  frontend Settings UI stays in sync
- macOS only for 2.0c (#[cfg(target_os = "macos")]); other platforms
  ship without a tray and rely on the in-app pause toggle

No new IPC commands; no schema changes. Reuses app_capture_pause /
app_capture_resume's underlying settings write path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

- [ ] **Step 2: Push and open Draft PR**

```bash
git push -u origin feat/cloud-2-0c-emergency-stop-tray
gh pr create --draft --title "feat(capture): Phase 2.0c — emergency stop menu-bar tray" --body "..."
```

PR body should:
- Link the spec
- List the menu items and the macOS-only scope
- Include the verification checklist (4 manual + 4 automated)
- Acknowledge the deferred items (cross-platform, custom icon art)

---

## Acceptance Criteria (Spec Coverage Check)

| Spec criterion | Implemented in |
|----------------|----------------|
| Tray icon appears in menu bar | Task 3 (Step 4 wires `install`) |
| Click → menu opens with Pause/Resume | Task 3 (Step 2) |
| Pause/Resume label flips based on state | Task 1 (`pause_resume_label`) + T1, T2 |
| Icon variant matches state | Task 2 + Task 3 (`refresh_icon`) + T2 |
| State persists across restart | Task 3 (uses settings_store; existing persistence) + T5 manual |
| Settings UI re-syncs on tray toggle | Task 4 (event listener) + T3 manual |
| Linux/Windows compiles | Task 5 (Step 3) + T6 |
| `cargo test -p app` green | Task 5 (Step 2) |
| `npm run check:rust` green | Task 5 (Step 1) |

---

## Self-Review Notes

- **Honest limitation**: T3-T5 are explicitly manual. Tauri tray bindings cannot be driven by Playwright or any headless harness today. The plan flags this rather than pretending automated coverage replaces human verification.
- **macOS-only is deliberate**: We have no current evidence of non-Mac users; cross-platform tray would double the surface (icon assets, platform-specific tray-API quirks, test matrix) without clear benefit. Defer to a 2.0c.1 follow-up when there's a real user.
- **Re-running `install` for menu rebuild**: Task 3 Step 3 calls `install(app)` from inside `handle_menu_event` to rebuild the menu with the new label. Tauri 2's `MenuItem.text` isn't mutable; this is the documented workaround. Cost: a single allocator + Tauri menu rebuild on each toggle, well within tolerance for a once-per-emergency action.
- **`current_paused` defaults to `true`**: matches `sampler_should_run_for` semantics — missing settings means "don't capture", so the tray UI starts in the safe state and the user must explicitly enable.
- **Quit menu routing**: spec § 9 flags this for reviewer confirmation. Defaulting to `app.exit(0)` for simplicity; if `app_quit` exists with hooks (e.g., consent goodbye flow), reroute in implementation.
