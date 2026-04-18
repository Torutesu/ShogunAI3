mod auth;
mod brief;
mod capture_sampler;
mod commands;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let _ = dotenvy::dotenv();
  tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      capture_sampler::start_background_sampler();
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::shogun_memory_search,
      commands::shogun_memory_fetch,
      commands::shogun_memory_ingest,
      commands::shogun_memory_delete,
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
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
