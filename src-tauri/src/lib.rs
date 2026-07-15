mod agents;
mod app_error;
mod app_events;
mod auth;
mod background_sync;
mod biometric;
mod brief;
mod brief_actions;
mod calendar_sync;
mod capture_events;
mod capture_sampler;
mod capture_tray;
// New-arch capture pipeline modules (OCR / PII redaction / clustering /
// strategies / AX events). Revived from an unmerged worktree snapshot; present
// but not yet wired into the live sampler, so allow dead_code until integrated.
#[allow(dead_code)]
mod ax_events;
#[allow(dead_code)]
mod capture_clustering;
#[allow(dead_code)]
mod capture_strategies;
#[allow(dead_code)]
pub mod macos_ocr;
#[allow(dead_code)]
mod pii_redactor;
mod commands;
mod connectors;
mod context_assembly;
mod cost_ledger;
mod dead_letter;
mod decay;
mod deep_link_credentials;
mod embed_backfill;
mod embeddings;
mod extraction_jobs;
mod google_oauth;
mod http_retry;
mod hummingbird;
mod integration_secrets;
mod integrations;
mod kioku;
mod legal_docs;
mod lessons;
mod lessons_verifier;
mod llm;
mod llm_providers;
mod macos_ax;
mod macos_frontmost;
mod macos_input;
mod macos_permissions;
mod macos_system_audio;
pub mod mcp_server;
mod mcp_setup;
mod meeting;
mod mem_captures;
mod memory;
mod memory_debug;
mod memory_export;
pub mod memory_mcp;
mod memory_notify;
mod memory_obs;
mod memory_store;
mod mirror;
mod oauth_flow;
mod paths;
mod patterns;
mod patterns_sync;
mod progress_emitter;
mod rollup_sync;
mod schedule_queue;
mod secrets;
mod sensitive_filter;
mod settings_store;
mod spatial;
mod spatial_patterns;
mod summarizer;
mod summarizer_store;
mod supersession;
mod supersession_sync;

// Backward-compatible re-exports after kioku/ meeting/ connectors/ folderization.
pub use connectors::{
    apple_local, claude, connector_sync, figma, github, gmail, google_calendar, google_drive,
    linear, notion, outlook, slack, zoom,
};
pub use kioku::{
    backup as kioku_backup, capture as kioku_capture, debug_stats as kioku_debug_stats,
    decision_graph as kioku_decision_graph, edge_types as kioku_edge_types, eval as kioku_eval,
    extraction as kioku_extraction, graph_schema as kioku_graph_schema,
    graph_traversal as kioku_graph_traversal, mcp as kioku_mcp, rules as kioku_rules,
    stage5 as kioku_stage5,
};
pub use meeting::{
    auto as meeting_auto, commands as meeting_commands,
    context_timeline as meeting_context_timeline, enhance as meeting_enhance,
    import as meeting_import, kioku as meeting_kioku, lifecycle as meeting_lifecycle,
    mcp as meeting_mcp, memory as meeting_memory, mic as meeting_mic, recipes as meeting_recipes,
    session as meeting_session, store as meeting_store, stt as meeting_stt,
    stt_live as meeting_stt_live, video_detect as meeting_video_detect,
};

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
                        log::warn!(
                            "deep-link register_all failed (dev or unpackaged build?): {}",
                            e
                        );
                    }
                }
            }
            capture_sampler::start_background_sampler(app.handle().clone());
            meeting_video_detect::start_poller(app.handle().clone());
            app_events::init(app.handle());
            memory_notify::init(app.handle().clone());
            mirror::sync::spawn_scheduler(app.handle().clone());
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                if let Err(err) = capture_tray::install(&handle) {
                    log::warn!("capture_tray install failed: {}", err);
                }
            }
            calendar_sync::spawn_background_calendar_sync();
            connector_sync::spawn_background_connector_sync();
            rollup_sync::spawn_background_rollup_sync();
            patterns_sync::spawn_background_patterns_sync();
            supersession_sync::spawn_background_supersession_sync();
            // KIOKU extraction worker (Phase 2 Stage 2). The thread runs from
            // boot but each tick checks `kioku_graph.worker_enabled` so it stays
            // idle until the user (or settings migration) flips the flag.
            kioku_extraction::start_extraction_worker(app.handle().clone());
            // Phase 2 Stage 3 (T8.2): warm the kioku_rules cache so the first
            // chat / brief call doesn't pay a settings round-trip.
            kioku_rules::reload_from_settings_now();
            progress_emitter::set_app_handle(app.handle().clone());
            hummingbird::register_app(app.handle().clone()); // also idempotent via app_events::init
            meeting_lifecycle::spawn_inactivity_watcher(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::memory::shogun_memory_search,
            commands::memory::shogun_memory_fetch,
            commands::memory::shogun_memory_ingest,
            commands::memory::shogun_memory_delete,
            commands::memory::shogun_memory_embed_backfill,
            commands::memory::shogun_memory_embed_backfill_cancel,
            commands::memory::shogun_memory_export,
            commands::memory::shogun_memory_import,
            commands::memory::shogun_entity_query,
            commands::llm::shogun_brief_get,
            commands::llm::shogun_open_pack,
            commands::llm::shogun_start_focus_session,
            commands::llm::shogun_draft_reply,
            commands::llm::shogun_chat_complete,
            commands::llm::shogun_draft,
            commands::llm::shogun_schedule_action,
            commands::kioku::shogun_kioku_brief_signals,
            commands::kioku::shogun_kioku_debug_stats,
            commands::kioku::shogun_kioku_pipeline_smoke,
            commands::kioku::shogun_kioku_extraction_requeue,
            commands::kioku::shogun_kioku_stage5_dry_run,
            commands::kioku::shogun_kioku_stage5_apply,
            commands::kioku::shogun_kioku_backup_db,
            commands::kioku::shogun_kioku_edge_type_proposals,
            commands::kioku::shogun_kioku_edge_type_review,
            commands::app::shogun_stats,
            commands::app::app_open_hummingbird,
            commands::app::app_create_share_link,
            commands::app::app_settings_load,
            commands::app::app_settings_save,
            commands::app::app_settings_export,
            commands::app::app_settings_import,
            commands::app::app_llm_api_key_set,
            commands::app::app_llm_api_key_status,
            commands::app::app_llm_api_key_clear,
            commands::integrations::app_integration_connect,
            commands::integrations::app_integration_import_credentials,
            commands::integrations::app_integration_credentials_status,
            commands::integrations::shogun_oauth_google_start,
            commands::integrations::shogun_oauth_google_app_status,
            commands::integrations::shogun_oauth_google_app_set,
            commands::integrations::shogun_agent_run_now,
            commands::app::shogun_hummingbird_context,
            commands::integrations::app_integration_toggle,
            commands::integrations::shogun_google_calendar_sync,
            commands::integrations::shogun_gmail_sync,
            commands::integrations::shogun_slack_sync,
            commands::integrations::shogun_notion_sync,
            commands::integrations::shogun_github_sync,
            commands::integrations::shogun_linear_sync,
            commands::integrations::shogun_drive_sync,
            commands::integrations::shogun_zoom_sync,
            commands::integrations::shogun_outlook_sync,
            commands::integrations::shogun_figma_sync,
            commands::integrations::shogun_claude_sync,
            commands::integrations::shogun_apple_calendar_sync,
            commands::integrations::shogun_apple_reminders_sync,
            commands::app::shogun_dead_letter_list,
            commands::app::shogun_dead_letter_retry,
            commands::app::shogun_dead_letter_clear,
            commands::app::shogun_dead_letter_retry_one,
            commands::app::shogun_dead_letter_delete,
            commands::app::app_capture_pause,
            commands::app::app_capture_resume,
            commands::app::shogun_capture_live_events,
            commands::app::shogun_capture_status,
            commands::app::shogun_screen_context_probe,
            commands::app::app_onboarding_complete,
            commands::app::app_permissions_manage,
            commands::app::app_privacy_pick_app,
            commands::app::app_diagnostics_report,
            commands::app::app_frontend_error_report,
            commands::app::app_updates_check,
            commands::app::app_updates_download_install,
            commands::app::app_quit,
            commands::app::app_delete_data_range,
            commands::app::app_delete_all_data,
            commands::app::app_delete_account,
            commands::auth::auth_clerk_config,
            commands::auth::auth_open_browser_sign_in,
            commands::auth::auth_open_browser_sign_up,
            commands::auth::billing_config,
            commands::auth::billing_open_url,
            commands::auth::auth_status,
            commands::auth::auth_session_save,
            commands::auth::auth_sign_out,
            commands::auth::auth_biometric_status,
            commands::auth::auth_biometric_authenticate,
            commands::mcp::mcp_setup_detect,
            commands::mcp::mcp_setup_write_config,
            commands::mcp::mcp_setup_verify,
            commands::mcp::mcp_setup_complete,
            commands::mcp::mcp_setup_open_claude_config,
            commands::mcp::mcp_setup_open_claude_app,
            meeting_commands::shogun_meeting_start,
            meeting_commands::shogun_meeting_link_client_note,
            meeting_commands::shogun_meeting_resolve_by_storage_key,
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
            meeting_commands::shogun_meeting_context_timeline,
            #[cfg(debug_assertions)]
            commands::memory::shogun_memory_debug_query,
            #[cfg(debug_assertions)]
            commands::memory::shogun_memory_debug_recent_calls,
            #[cfg(debug_assertions)]
            commands::memory::shogun_memory_debug_stats,
            #[cfg(debug_assertions)]
            commands::memory::shogun_memory_debug_sync_status,
            commands::memory::shogun_memory_debug_gate,
            commands::summaries::shogun_memory_summary_get,
            commands::summaries::shogun_memory_summary_batch,
            commands::summaries::shogun_memory_summary_invalidate,
            commands::summaries::shogun_memory_summary_acknowledge,
            commands::summaries::shogun_memory_summary_snooze,
            commands::summaries::shogun_memory_entity_rollup_get,
            commands::summaries::shogun_memory_rollup_get,
            commands::summaries::shogun_memory_day_rollup_get,
            commands::summaries::shogun_memory_month_rollup_get,
            commands::summaries::shogun_memory_year_rollup_get,
            commands::mirror::mirror_delete_device,
            commands::mirror::mirror_disable,
            commands::mirror::mirror_list_devices,
            commands::mirror::mirror_register,
            commands::mirror::mirror_rename_device,
            commands::mirror::mirror_reset_stuck,
            commands::mirror::mirror_search_blobs,
            commands::mirror::mirror_status,
            commands::mirror::mirror_sync_now,
            commands::mirror::mirror_unlock,
            commands::lessons::shogun_lesson_capture_rejection,
            commands::lessons::shogun_lesson_capture_tool_failure,
            commands::lessons::shogun_patterns_run_now,
            commands::lessons::shogun_supersession_run_now,
            commands::lessons::shogun_patterns_list,
            commands::lessons::shogun_patterns_invalidate,
            commands::lessons::shogun_lessons_list,
            commands::lessons::shogun_lessons_archive,
            commands::lessons::shogun_lessons_stats,
            commands::summaries::shogun_memory_summary_set_priority,
            legal_docs::legal_docs_load,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
