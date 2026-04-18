mod auth;
mod biometric;
mod brief;
mod brief_actions;
mod calendar_sync;
mod capture_sampler;
mod commands;
mod deep_link_credentials;
mod embed_backfill;
mod embeddings;
mod google_calendar;
mod integration_secrets;
mod integrations;
mod llm;
mod macos_ax;
mod memory_store;
mod paths;
mod schedule_queue;
mod secrets;
mod settings_store;

fn load_dotenv() {
  let _ = dotenvy::dotenv();
  let _ = dotenvy::from_filename("../.env");
  // Always load repo-root `.env` next to `package.json` (parent of `src-tauri/`), regardless of process cwd.
  let root_env = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
  let _ = dotenvy::from_path(root_env);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  load_dotenv();
  let mut builder = tauri::Builder::default();

  #[cfg(desktop)]
  {
    use tauri::Manager;
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
      if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
      }
    }));
  }

  builder
    .manage(embed_backfill::EmbedBackfillState::default())
    .plugin(tauri_plugin_deep_link::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      #[cfg(desktop)]
      {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
          deep_link_credentials::handle_urls(&handle, &event.urls());
        });
        if let Ok(Some(urls)) = app.deep_link().get_current() {
          if !urls.is_empty() {
            deep_link_credentials::handle_urls(app.handle(), &urls);
          }
        }
        #[cfg(any(windows, target_os = "linux"))]
        {
          if let Err(e) = app.deep_link().register_all() {
            log::warn!("deep-link register_all failed (dev or unpackaged build?): {}", e);
          }
        }
      }
      capture_sampler::start_background_sampler();
      calendar_sync::spawn_background_calendar_sync();
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::shogun_memory_search,
      commands::shogun_memory_fetch,
      commands::shogun_memory_ingest,
      commands::shogun_memory_delete,
      commands::shogun_memory_embed_backfill,
      commands::shogun_memory_embed_backfill_cancel,
      commands::shogun_entity_query,
      commands::shogun_brief_get,
      commands::shogun_open_pack,
      commands::shogun_start_focus_session,
      commands::shogun_draft_reply,
      commands::shogun_chat_complete,
      commands::shogun_draft,
      commands::shogun_schedule_action,
      commands::shogun_stats,
      commands::app_open_hummingbird,
      commands::app_create_share_link,
      commands::app_settings_load,
      commands::app_settings_save,
      commands::app_llm_api_key_set,
      commands::app_llm_api_key_status,
      commands::app_llm_api_key_clear,
      commands::app_integration_connect,
      commands::app_integration_import_credentials,
      commands::app_integration_credentials_status,
      commands::app_integration_toggle,
      commands::shogun_google_calendar_sync,
      commands::app_capture_pause,
      commands::app_capture_resume,
      commands::app_permissions_manage,
      commands::app_diagnostics_report,
      commands::app_delete_data_range,
      commands::app_delete_all_data,
      commands::app_delete_account,
      commands::auth_clerk_config,
      commands::auth_open_browser_sign_in,
      commands::auth_open_browser_sign_up,
      commands::auth_status,
      commands::auth_session_save,
      commands::auth_sign_out,
      commands::auth_biometric_status,
      commands::auth_biometric_authenticate,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
