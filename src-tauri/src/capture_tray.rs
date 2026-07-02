//! macOS menu-bar tray for emergency capture stop. The user can pause / resume
//! capture in one click without opening the SHOGUN window. Reads / writes
//! `sections.capture.paused` via `settings_store::save_patch`. See spec
//! `docs/superpowers/specs/2026-05-04-emergency-stop-tray-design.md`.

use serde_json::json;

/// Label shown on the tray menu item that toggles capture state.
pub(crate) fn pause_resume_label(paused: bool) -> &'static str {
    if paused {
        "Resume capture"
    } else {
        "Pause capture"
    }
}

/// Icon asset filename (relative to the bundled `icons/` resources dir).
pub(crate) fn icon_asset_for(paused: bool) -> &'static str {
    if paused {
        "tray-paused.png"
    } else {
        "tray-active.png"
    }
}

pub(crate) fn navigation_screen_for_menu_id(id: &str) -> Option<&'static str> {
    match id {
        "open-home" => Some("home"),
        "open-chat" => Some("chat"),
        "open-memory" => Some("memory"),
        "open-founder-sales" => Some("founder_sales"),
        "open-fundraising" => Some("fundraising"),
        "open-project-memory" => Some("project_memory"),
        "open-entity-context" => Some("entity_context"),
        "open-meetings" => Some("meetings"),
        "open-work" => Some("work"),
        "open-ai-fields" => Some("ai_fields"),
        "open-actions" => Some("actions"),
        "open-agents" => Some("agents"),
        _ => None,
    }
}

pub(crate) fn navigation_settings_pane_for_menu_id(id: &str) -> Option<&'static str> {
    match id {
        "open-settings" => Some("general"),
        "open-integrations-settings" => Some("integrations"),
        "open-meetings-settings" => Some("meetings"),
        "open-privacy-settings" => Some("privacy"),
        _ => None,
    }
}

pub(crate) fn navigation_payload_for_menu_id(id: &str) -> Option<serde_json::Value> {
    if let Some(screen) = navigation_screen_for_menu_id(id) {
        return Some(json!({ "screen": screen }));
    }
    navigation_settings_pane_for_menu_id(id).map(|pane| json!({ "settingsPane": pane }))
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
fn current_paused() -> bool {
    crate::settings_store::load()
        .ok()
        .and_then(|d: Value| {
            d.pointer("/sections/capture/paused")
                .and_then(|v| v.as_bool())
        })
        .unwrap_or(true) // default: paused — safe if settings missing
}

/// Build the tray menu for a given paused state.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle, paused: bool) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};

    let pause_resume = MenuItemBuilder::new(pause_resume_label(paused))
        .id("toggle-capture")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_memory = MenuItemBuilder::new("Open Memory")
        .id("open-memory")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_home = MenuItemBuilder::new("Open Home")
        .id("open-home")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_chat = MenuItemBuilder::new("Open Chat")
        .id("open-chat")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_founder_sales = MenuItemBuilder::new("Open Founder Sales")
        .id("open-founder-sales")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_fundraising = MenuItemBuilder::new("Open Fundraising")
        .id("open-fundraising")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_project_memory = MenuItemBuilder::new("Open Project Memory")
        .id("open-project-memory")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_entity_context = MenuItemBuilder::new("Open Entity Context")
        .id("open-entity-context")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_meetings = MenuItemBuilder::new("Open Meetings")
        .id("open-meetings")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_work = MenuItemBuilder::new("Open Work")
        .id("open-work")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_ai_fields = MenuItemBuilder::new("Open AI Fields")
        .id("open-ai-fields")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_actions = MenuItemBuilder::new("Open Actions")
        .id("open-actions")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_agents = MenuItemBuilder::new("Open Agents")
        .id("open-agents")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_settings = MenuItemBuilder::new("Open Settings")
        .id("open-settings")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_integrations_settings = MenuItemBuilder::new("Open Integrations Settings")
        .id("open-integrations-settings")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_meetings_settings = MenuItemBuilder::new("Open Meetings Settings")
        .id("open-meetings-settings")
        .build(app)
        .map_err(|e| e.to_string())?;
    let open_privacy_settings = MenuItemBuilder::new("Open Privacy Settings")
        .id("open-privacy-settings")
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
    let sep3 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;

    MenuBuilder::new(app)
        .items(&[
            &pause_resume,
            &sep1,
            &open_home,
            &open_chat,
            &open_memory,
            &open_founder_sales,
            &open_fundraising,
            &open_project_memory,
            &open_entity_context,
            &open_meetings,
            &open_work,
            &open_ai_fields,
            &open_actions,
            &open_agents,
            &open_settings,
            &open_integrations_settings,
            &open_meetings_settings,
            &open_privacy_settings,
            &sep2,
            &open_window,
            &sep3,
            &quit,
        ])
        .build()
        .map_err(|e| e.to_string())
}

/// Load the bundled icon for a given paused state.
#[cfg(target_os = "macos")]
fn load_icon(app: &AppHandle, paused: bool) -> Result<tauri::image::Image<'static>, String> {
    use tauri::path::BaseDirectory;
    let asset = icon_asset_for(paused);
    let icon_path = app
        .path()
        .resolve(format!("icons/{}", asset), BaseDirectory::Resource)
        .map_err(|e| e.to_string())?;
    tauri::image::Image::from_path(&icon_path).map_err(|e| e.to_string())
}

/// Apply a new paused state to an already-installed tray: swap the menu and icon
/// in place. Safer than rebuilding the tray (which would leak menu listeners
/// in Tauri 2.10's tray manager — see the `install` re-call avoidance comment).
#[cfg(target_os = "macos")]
fn apply_paused_state(app: &AppHandle, paused: bool) -> Result<(), String> {
    let menu = build_menu(app, paused)?;
    let icon = load_icon(app, paused)?;
    if let Some(tray) = app.tray_by_id("shogun-capture-tray") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Handle a tray menu-item click.
#[cfg(target_os = "macos")]
fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(payload) = navigation_payload_for_menu_id(id) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        if let Err(err) = app.emit("shogun-app-navigate", payload) {
            log::warn!("capture_tray: navigation event emit failed: {}", err);
        }
        return;
    }
    match id {
        "toggle-capture" => {
            let paused_now = current_paused();
            let next_paused = !paused_now;
            // Write directly to settings (self-contained; no new IPC command).
            // Surface failures so the user can see why an emergency-stop click
            // didn't take effect — silent failure is the worst UX for this feature.
            if let Err(err) = crate::settings_store::save_patch(&serde_json::json!({
              "section": "capture",
              "paused": next_paused,
            })) {
                log::warn!("capture_tray: settings save failed: {}", err);
                return;
            }
            if let Err(err) = apply_paused_state(app, next_paused) {
                log::warn!("capture_tray: tray refresh failed: {}", err);
            }
            if let Err(err) = app.emit(
                "shogun-capture-state-changed",
                serde_json::json!({ "paused": next_paused }),
            ) {
                log::warn!("capture_tray: event emit failed: {}", err);
            }
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

/// Install the macOS tray icon and menu. Called once from the Tauri builder
/// `setup` callback. To update the tray afterwards (label / icon for state
/// changes) use `apply_paused_state` — DO NOT call `install` again, since
/// Tauri 2.10's tray manager pushes registered menu-event listeners into a
/// global vec without removing prior entries with the same id, which would
/// duplicate every subsequent click.
#[cfg(target_os = "macos")]
pub(crate) fn install(app: &AppHandle) -> Result<(), String> {
    use tauri::tray::TrayIconBuilder;

    let paused = current_paused();
    let initial_icon = load_icon(app, paused)?;
    let menu = build_menu(app, paused)?;

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

    #[test]
    fn maps_surface_menu_ids_to_screens() {
        assert_eq!(navigation_screen_for_menu_id("open-home"), Some("home"));
        assert_eq!(navigation_screen_for_menu_id("open-chat"), Some("chat"));
        assert_eq!(navigation_screen_for_menu_id("open-memory"), Some("memory"));
        assert_eq!(
            navigation_screen_for_menu_id("open-founder-sales"),
            Some("founder_sales")
        );
        assert_eq!(
            navigation_screen_for_menu_id("open-fundraising"),
            Some("fundraising")
        );
        assert_eq!(
            navigation_screen_for_menu_id("open-project-memory"),
            Some("project_memory")
        );
        assert_eq!(
            navigation_screen_for_menu_id("open-entity-context"),
            Some("entity_context")
        );
        assert_eq!(
            navigation_screen_for_menu_id("open-meetings"),
            Some("meetings")
        );
        assert_eq!(navigation_screen_for_menu_id("open-work"), Some("work"));
        assert_eq!(
            navigation_screen_for_menu_id("open-ai-fields"),
            Some("ai_fields")
        );
        assert_eq!(
            navigation_screen_for_menu_id("open-actions"),
            Some("actions")
        );
        assert_eq!(navigation_screen_for_menu_id("open-agents"), Some("agents"));
        assert_eq!(navigation_screen_for_menu_id("open-window"), None);
    }

    #[test]
    fn maps_settings_menu_ids_to_panes() {
        assert_eq!(
            navigation_settings_pane_for_menu_id("open-settings"),
            Some("general")
        );
        assert_eq!(
            navigation_settings_pane_for_menu_id("open-integrations-settings"),
            Some("integrations")
        );
        assert_eq!(
            navigation_settings_pane_for_menu_id("open-meetings-settings"),
            Some("meetings")
        );
        assert_eq!(
            navigation_settings_pane_for_menu_id("open-privacy-settings"),
            Some("privacy")
        );
        assert_eq!(navigation_settings_pane_for_menu_id("open-memory"), None);
    }

    #[test]
    fn builds_navigation_payloads_for_surface_menu_ids() {
        assert_eq!(
            navigation_payload_for_menu_id("open-home"),
            Some(json!({ "screen": "home" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-chat"),
            Some(json!({ "screen": "chat" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-memory"),
            Some(json!({ "screen": "memory" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-founder-sales"),
            Some(json!({ "screen": "founder_sales" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-actions"),
            Some(json!({ "screen": "actions" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-agents"),
            Some(json!({ "screen": "agents" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-settings"),
            Some(json!({ "settingsPane": "general" }))
        );
        assert_eq!(
            navigation_payload_for_menu_id("open-integrations-settings"),
            Some(json!({ "settingsPane": "integrations" }))
        );
        assert_eq!(navigation_payload_for_menu_id("quit"), None);
    }
}
