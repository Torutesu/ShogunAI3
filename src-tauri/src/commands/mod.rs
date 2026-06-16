//! IPC handlers aligned with `hifi/lib/shogun-api.js` invoke names.

pub mod app;
pub mod auth;
pub mod integrations;
pub mod kioku;
pub mod lessons;
pub mod llm;
pub mod mcp;
pub mod memory;
pub mod mirror;
pub mod summaries;

pub(crate) use app::{redact_sensitive_text, ts};
pub use app::{
  app_capture_pause, app_capture_resume, app_create_share_link, app_delete_account,
  app_delete_all_data, app_delete_data_range, app_diagnostics_report,
  app_frontend_error_report, app_llm_api_key_clear, app_llm_api_key_set,
  app_llm_api_key_status, app_onboarding_complete, app_open_hummingbird,
  app_permissions_manage, app_privacy_pick_app, app_quit, app_settings_export,
  app_settings_import, app_settings_load, app_settings_save, app_updates_check,
  app_updates_download_install, shogun_capture_live_events, shogun_capture_status,
  shogun_dead_letter_clear, shogun_dead_letter_delete, shogun_dead_letter_list,
  shogun_dead_letter_retry, shogun_dead_letter_retry_one, shogun_hummingbird_context,
  shogun_stats,
};
pub use auth::{
  auth_biometric_authenticate, auth_biometric_status, auth_clerk_config,
  auth_open_browser_sign_in, auth_open_browser_sign_up, auth_session_save, auth_sign_out,
  auth_status, billing_config, billing_open_url,
};
pub use mcp::{
  mcp_setup_complete, mcp_setup_detect, mcp_setup_open_claude_app, mcp_setup_open_claude_config,
  mcp_setup_verify, mcp_setup_write_config,
};
pub(crate) use integrations::persist_integration_credentials_inner;
pub use integrations::{
  app_integration_connect, app_integration_credentials_status,
  app_integration_import_credentials, app_integration_toggle,
  shogun_agent_run_now, shogun_apple_calendar_sync,
  shogun_apple_reminders_sync, shogun_claude_sync, shogun_drive_sync, shogun_figma_sync,
  shogun_github_sync, shogun_gmail_sync, shogun_google_calendar_sync, shogun_linear_sync,
  shogun_notion_sync, shogun_oauth_google_app_set, shogun_oauth_google_app_status,
  shogun_oauth_google_start, shogun_outlook_sync, shogun_slack_sync, shogun_zoom_sync,
};
pub use kioku::{
  shogun_kioku_backup_db, shogun_kioku_brief_signals, shogun_kioku_debug_stats,
  shogun_kioku_edge_type_proposals, shogun_kioku_edge_type_review,
  shogun_kioku_extraction_requeue, shogun_kioku_pipeline_smoke, shogun_kioku_stage5_apply, shogun_kioku_stage5_dry_run,
};
pub use lessons::{
  shogun_lesson_capture_rejection, shogun_lesson_capture_tool_failure, shogun_lessons_archive,
  shogun_lessons_list, shogun_lessons_stats, shogun_patterns_invalidate, shogun_patterns_list,
  shogun_patterns_run_now, shogun_supersession_run_now,
};
pub use llm::{
  shogun_brief_get, shogun_chat_complete, shogun_draft, shogun_draft_reply, shogun_open_pack,
  shogun_schedule_action, shogun_start_focus_session,
};
pub use memory::{
  shogun_entity_query, shogun_memory_debug_gate, shogun_memory_delete, shogun_memory_embed_backfill,
  shogun_memory_embed_backfill_cancel, shogun_memory_export, shogun_memory_fetch,
  shogun_memory_import, shogun_memory_ingest, shogun_memory_search,
};
#[cfg(debug_assertions)]
pub use memory::{
  shogun_memory_debug_query, shogun_memory_debug_recent_calls, shogun_memory_debug_stats,
  shogun_memory_debug_sync_status,
};
pub use mirror::{
  mirror_delete_device, mirror_disable, mirror_list_devices, mirror_register, mirror_rename_device,
  mirror_reset_stuck, mirror_search_blobs, mirror_status, mirror_sync_now, mirror_unlock,
};
pub use summaries::{
  shogun_memory_day_rollup_get, shogun_memory_entity_rollup_get, shogun_memory_month_rollup_get,
  shogun_memory_rollup_get, shogun_memory_summary_acknowledge, shogun_memory_summary_batch,
  shogun_memory_summary_get, shogun_memory_summary_invalidate, shogun_memory_summary_set_priority,
  shogun_memory_summary_snooze, shogun_memory_year_rollup_get,
};
