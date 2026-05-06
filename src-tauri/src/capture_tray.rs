//! macOS menu-bar tray for emergency capture stop. The user can pause / resume
//! capture in one click without opening the SHOGUN window. Reads / writes
//! `sections.capture.paused` via `settings_store::save_patch`. See spec
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

// ── macOS-only: Tauri tray lifecycle ──────────────────────────────────────

#[cfg(target_os = "macos")]
use serde_json::Value;
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager};

/// Read current paused state from settings. Defaults to `true` (paused) if the
/// settings file is missing or the key is absent — matches
/// `sampler_should_run_for` privacy-first semantics.
#[cfg(target_os = "macos")]
fn current_paused(app: &AppHandle) -> bool {
  let _ = app; // app not needed; settings are file-based
  crate::settings_store::load()
    .ok()
    .and_then(|d: Value| {
      d.pointer("/sections/capture/paused")
        .and_then(|v| v.as_bool())
    })
    .unwrap_or(true) // default: paused — safe if settings missing
}

/// Swap the tray icon to reflect the new paused state.
#[cfg(target_os = "macos")]
fn refresh_icon(app: &AppHandle, paused: bool) -> Result<(), String> {
  use tauri::path::BaseDirectory;
  let asset = icon_asset_for(paused);
  let icon_path = app
    .path()
    .resolve(format!("icons/{}", asset), BaseDirectory::Resource)
    .map_err(|e| e.to_string())?;
  let image = tauri::image::Image::from_path(&icon_path).map_err(|e| e.to_string())?;
  if let Some(tray) = app.tray_by_id("shogun-capture-tray") {
    tray.set_icon(Some(image)).map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// Handle a tray menu-item click.
#[cfg(target_os = "macos")]
fn handle_menu_event(app: &AppHandle, id: &str) {
  match id {
    "toggle-capture" => {
      let paused_now = current_paused(app);
      let next_paused = !paused_now;
      // Write directly to settings (self-contained; no new IPC command).
      let _ = crate::settings_store::save_patch(&serde_json::json!({
        "section": "capture",
        "paused": next_paused,
      }));
      let _ = refresh_icon(app, next_paused);
      let _ = app.emit(
        "shogun-capture-state-changed",
        serde_json::json!({ "paused": next_paused }),
      );
      // Tauri 2 MenuItem text is not mutable post-build — rebuild the whole
      // tray so the Pause/Resume label flips. Acceptable cost for a once-per-
      // emergency action; do not optimize.
      let _ = install(app);
    }
    "open-window" => {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
      }
    }
    "quit" => {
      app.exit(0);
    }
    _ => {}
  }
}

/// Install the macOS tray icon and menu. Safe to call again to rebuild the
/// menu (e.g., after toggling capture to flip the Pause/Resume label).
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) -> Result<(), String> {
  use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder,
  };

  let paused = current_paused(app);

  // Resolve the initial icon from bundled resources.
  let icon_path = app
    .path()
    .resolve(format!("icons/{}", icon_asset_for(paused)), BaseDirectory::Resource)
    .map_err(|e| e.to_string())?;
  let initial_icon = tauri::image::Image::from_path(&icon_path).map_err(|e| e.to_string())?;

  // Build menu items.
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

  let sep1 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
  let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

  let menu = MenuBuilder::new(app)
    .items(&[&pause_resume, &sep1, &open_window, &sep2, &quit])
    .build()
    .map_err(|e| e.to_string())?;

  TrayIconBuilder::with_id("shogun-capture-tray")
    .icon(initial_icon)
    .icon_as_template(true)
    .menu(&menu)
    .on_menu_event(move |tray_app, event| {
      handle_menu_event(tray_app, event.id().as_ref());
    })
    .build(app)
    .map_err(|e| e.to_string())?;

  Ok(())
}

// ── Tests (platform-agnostic pure helpers) ─────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn label_running() {
    assert_eq!(pause_resume_label(false), "Pause capture");
  }

  #[test]
  fn label_paused() {
    assert_eq!(pause_resume_label(true), "Resume capture");
  }

  #[test]
  fn icon_running() {
    assert_eq!(icon_asset_for(false), "tray-active.png");
  }

  #[test]
  fn icon_paused() {
    assert_eq!(icon_asset_for(true), "tray-paused.png");
  }
}
