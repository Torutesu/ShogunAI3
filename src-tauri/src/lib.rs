mod auth;
mod biometric;
mod brief;
mod brief_actions;
mod calendar_sync;
mod capture_sampler;
mod connector_sync;
mod context_assembly;
mod dead_letter;
mod commands;
mod deep_link_credentials;
mod embed_backfill;
mod embeddings;
mod gmail;
mod google_calendar;
mod google_drive;
mod google_oauth;
mod http_retry;
mod integration_secrets;
mod integrations;
mod linear;
mod llm;
mod llm_providers;
mod macos_ax;
mod meeting_commands;
mod meeting_enhance;
mod meeting_import;
mod meeting_mic;
mod meeting_mcp;
mod meeting_recipes;
mod meeting_session;
mod meeting_store;
mod meeting_stt;
mod memory_debug;
mod memory_obs;
mod memory_store;
mod kioku_graph_schema;
mod kioku_eval;
mod decay;
mod kioku_capture;
mod lessons;
mod patterns;
mod patterns_sync;
mod supersession;
mod mem_captures;
mod extraction_jobs;
mod cost_ledger;
mod kioku_extraction;
mod kioku_decision_graph;
mod kioku_rules;
mod kioku_graph_traversal;
mod kioku_debug_stats;
mod kioku_edge_types;
mod kioku_stage5;
mod kioku_backup;
mod rollup_sync;
mod summarizer_store;
mod summarizer;
mod paths;
mod progress_emitter;
mod schedule_queue;
mod secrets;
mod settings_store;
mod slack;
mod notion;
mod oauth_flow;
mod github;
mod zoom;

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

  // The updater plugin requires a `plugins.updater` config block in
  // tauri.conf.json (with an endpoint + pubkey). Dev builds ship without
  // update servers, so gate registration to release builds to avoid a
  // startup panic on `cargo run`.
  #[cfg(not(debug_assertions))]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .manage(embed_backfill::EmbedBackfillState::default())
    .manage(memory_debug::RingBuffer::default())
    .manage(meeting_session::MeetingSessionState::default())
    .manage(meeting_mic::MeetingMicController::default())
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
      capture_sampler::start_background_sampler(app.handle().clone());
      calendar_sync::spawn_background_calendar_sync();
      connector_sync::spawn_background_connector_sync();
      rollup_sync::spawn_background_rollup_sync();
      patterns_sync::spawn_background_patterns_sync();
      // KIOKU extraction worker (Phase 2 Stage 2). The thread runs from
      // boot but each tick checks `kioku_graph.worker_enabled` so it stays
      // idle until the user (or settings migration) flips the flag.
      kioku_extraction::start_extraction_worker(app.handle().clone());
      // Phase 2 Stage 3 (T8.2): warm the kioku_rules cache so the first
      // chat / brief call doesn't pay a settings round-trip.
      kioku_rules::reload_from_settings_now();
      progress_emitter::set_app_handle(app.handle().clone());
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
      commands::shogun_kioku_brief_signals,
      commands::shogun_kioku_debug_stats,
      commands::shogun_kioku_stage5_dry_run,
      commands::shogun_kioku_stage5_apply,
      commands::shogun_kioku_backup_db,
      commands::shogun_kioku_edge_type_proposals,
      commands::shogun_kioku_edge_type_review,
      commands::shogun_stats,
      commands::app_open_hummingbird,
      commands::app_create_share_link,
      commands::app_settings_load,
      commands::app_settings_save,
      commands::app_settings_export,
      commands::app_settings_import,
      commands::app_llm_api_key_set,
      commands::app_llm_api_key_status,
      commands::app_llm_api_key_clear,
      commands::app_integration_connect,
      commands::app_integration_import_credentials,
      commands::app_integration_credentials_status,
      commands::shogun_oauth_google_start,
      commands::app_integration_toggle,
      commands::shogun_google_calendar_sync,
      commands::shogun_gmail_sync,
      commands::shogun_slack_sync,
      commands::shogun_notion_sync,
      commands::shogun_github_sync,
      commands::shogun_linear_sync,
      commands::shogun_drive_sync,
      commands::shogun_zoom_sync,
      commands::shogun_dead_letter_list,
      commands::shogun_dead_letter_retry,
      commands::shogun_dead_letter_clear,
      commands::shogun_dead_letter_retry_one,
      commands::shogun_dead_letter_delete,
      commands::app_capture_pause,
      commands::app_capture_resume,
      commands::app_permissions_manage,
      commands::app_privacy_pick_app,
      commands::app_diagnostics_report,
      commands::app_frontend_error_report,
      commands::app_updates_check,
      commands::app_updates_download_install,
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
      meeting_commands::shogun_meeting_start,
      meeting_commands::shogun_meeting_stop,
      meeting_commands::shogun_meeting_note_append_block,
      meeting_commands::shogun_meeting_note_edit_block,
      meeting_commands::shogun_meeting_note_delete_block,
      meeting_commands::shogun_meeting_enhance,
      meeting_commands::shogun_meeting_re_enhance,
      meeting_commands::shogun_meeting_transcript_for_block,
      meeting_commands::shogun_meeting_transcript_live,
      meeting_commands::shogun_meeting_purge,
      meeting_commands::shogun_meeting_list,
      meeting_commands::shogun_meeting_get,
      meeting_commands::shogun_meeting_transcript_get,
      meeting_commands::shogun_meeting_notes_get,
      meeting_commands::shogun_meetings_search,
      meeting_commands::shogun_meeting_recipe_run,
      meeting_commands::shogun_meeting_templates_list,
      meeting_commands::shogun_meeting_transcript_push,
      meeting_commands::shogun_meeting_audio_status,
      meeting_commands::shogun_meeting_mic_start,
      meeting_commands::shogun_meeting_mic_stop,
      meeting_commands::shogun_meeting_transcribe_pcm,
      meeting_commands::shogun_meeting_mcp_tools,
      meeting_commands::shogun_meeting_import_pick,
      meeting_commands::shogun_meeting_import_file,
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_query,
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_recent_calls,
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_stats,
      #[cfg(debug_assertions)]
      commands::shogun_memory_debug_sync_status,
      commands::shogun_memory_debug_gate,
      commands::shogun_memory_summary_get,
      commands::shogun_memory_summary_batch,
      commands::shogun_memory_summary_invalidate,
      commands::shogun_memory_summary_acknowledge,
      commands::shogun_memory_summary_snooze,
      commands::shogun_memory_entity_rollup_get,
      commands::shogun_memory_rollup_get,
      commands::shogun_memory_day_rollup_get,
      commands::shogun_memory_month_rollup_get,
      commands::shogun_memory_year_rollup_get,
      commands::shogun_lesson_capture_rejection,
      commands::shogun_lesson_capture_tool_failure,
      commands::shogun_patterns_run_now,
      commands::shogun_patterns_list,
      commands::shogun_patterns_invalidate,
      commands::shogun_lessons_list,
      commands::shogun_lessons_archive,
      commands::shogun_lessons_stats,
      commands::shogun_memory_summary_set_priority,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
