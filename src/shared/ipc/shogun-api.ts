import { ShogunIpcClient } from './ipc-client';

(function initShogunApi(global: any) {
  const READ = "READ";
  const WRITE = "WRITE";

  function createApi(client?: any) {
    const ipc = client || (global.ShogunIpcClient && global.ShogunIpcClient.createIpcClient
      ? global.ShogunIpcClient.createIpcClient()
      : ShogunIpcClient
        ? ShogunIpcClient.createIpcClient()
        : null);

    if (!ipc) {
      throw new Error("ShogunIpcClient is required");
    }

    async function call(command: string, payload: any, kind: string, invokeOpts?: any) {
      const res = await ipc.invoke(command, payload, invokeOpts);
      return {
        ok: res.ok,
        kind: kind,
        command: command,
        data: res.data || null,
        error: res.error || null,
      };
    }

    return {
      meta: {
        READ: READ,
        WRITE: WRITE,
      },
      memorySearch: (input: any) => call("shogun_memory_search", input, READ),
      memoryTimelineSearch: (input: any) =>
        call("shogun_memory_search", { ...(input || {}), scope: "timeline" }, READ),
      memoryFetch: (input: any) => call("shogun_memory_fetch", input, READ),
      memoryIngest: (input: any) => call("shogun_memory_ingest", input, WRITE),
      memorySummaryGet: (input: any) => call("shogun_memory_summary_get", input, READ),
      memorySummaryBatch: (input: any) => call("shogun_memory_summary_batch", input, READ),
      memorySummaryInvalidate: (input: any) => call("shogun_memory_summary_invalidate", input, WRITE),
      memoryRollupGet: (input: any) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input: any) => call("shogun_memory_day_rollup_get", input, READ),
      lessonCaptureRejection: (input: any) => call("shogun_lesson_capture_rejection", input, WRITE),
      lessonCaptureToolFailure: (input: any) => call("shogun_lesson_capture_tool_failure", input, WRITE),
      patternsRunNow: (input: any) => call("shogun_patterns_run_now", input, WRITE),
      supersessionRunNow: (input: any) => call("shogun_supersession_run_now", input || {}, WRITE),
      patternsList: (input: any) => call("shogun_patterns_list", input || {}, READ),
      patternsInvalidate: (input: any) => call("shogun_patterns_invalidate", input, WRITE),
      lessonsList: (input: any) => call("shogun_lessons_list", input || {}, READ),
      lessonsArchive: (input: any) => call("shogun_lessons_archive", input, WRITE),
      lessonsStats: (input: any) => call("shogun_lessons_stats", input || {}, READ),
      memoryMonthRollupGet: (input: any) => call("shogun_memory_month_rollup_get", input, READ),
      memoryYearRollupGet: (input: any) => call("shogun_memory_year_rollup_get", input, READ),
      memorySummarySetPriority: (input: any) => call("shogun_memory_summary_set_priority", input, WRITE),
      memorySummaryAcknowledge: (input: any) => call("shogun_memory_summary_acknowledge", input, WRITE),
      memoryEntityRollupGet: (input: any) => call("shogun_memory_entity_rollup_get", input, READ),
      memorySummarySnooze: (input: any) => call("shogun_memory_summary_snooze", input, WRITE),
      memoryDelete: (input: any) => call("shogun_memory_delete", input, WRITE),
      memoryExport: (input: any) => call("shogun_memory_export", input, WRITE),
      memoryImport: (input: any) => call("shogun_memory_import", input, WRITE),
      memoryEmbedBackfill: (input: any) =>
        call("shogun_memory_embed_backfill", input, WRITE, { timeoutMs: 600000 }),
      memoryEmbedBackfillCancel: (input: any) =>
        call("shogun_memory_embed_backfill_cancel", input || {}, WRITE),
      memoryDebugRecentCalls: (input: any) => call("shogun_memory_debug_recent_calls", input || { limit: 50 }, READ),
      memoryDebugQuery: (input: any) => call("shogun_memory_debug_query", input, READ),
      memoryDebugStats: () => call("shogun_memory_debug_stats", {}, READ),
      memoryDebugSyncStatus: () => call("shogun_memory_debug_sync_status", {}, READ),
      memoryDebugGate: () => call("shogun_memory_debug_gate", {}, READ),
      entityQuery: (input: any) => call("shogun_entity_query", input, READ),
      briefGet: (input: any) => call("shogun_brief_get", input, READ),
      kiokuBriefSignals: (input: any) =>
        call("shogun_kioku_brief_signals", input || {}, READ),
      kiokuDebugStats: () => call("shogun_kioku_debug_stats", {}, READ),
      kiokuPipelineSmoke: () => call("shogun_kioku_pipeline_smoke", {}, READ),
      kiokuExtractionRequeue: (input: any) =>
        call("shogun_kioku_extraction_requeue", input || {}, WRITE),
      kiokuBackupDb: (input: any) =>
        call("shogun_kioku_backup_db", input || {}, WRITE),
      kiokuEdgeTypeProposals: (input: any) =>
        call("shogun_kioku_edge_type_proposals", input || {}, READ),
      kiokuEdgeTypeReview: (input: any) =>
        call("shogun_kioku_edge_type_review", input, WRITE),
      openPack: (input: any) => call("shogun_open_pack", input, WRITE),
      draftReply: (input: any) => call("shogun_draft_reply", input, WRITE),
      startFocusSession: (input: any) => call("shogun_start_focus_session", input, WRITE),
      chatComplete: (input: any) => call("shogun_chat_complete", input, WRITE),
      draftCreate: (input: any) => call("shogun_draft", input, WRITE),
      scheduleAction: (input: any) => call("shogun_schedule_action", input, WRITE),
      statsGet: (input: any) => call("shogun_stats", input, READ),
      appOpenHummingbird: (input: any) => call("app_open_hummingbird", input, WRITE),
      appCreateShareLink: (input: any) => call("app_create_share_link", input, WRITE),
      settingsLoad: (input: any) => call("app_settings_load", input, READ),
      settingsSave: (input: any) => call("app_settings_save", input, WRITE),
      settingsExport: (input: any) => call("app_settings_export", input || {}, WRITE),
      settingsImport: (input: any) => call("app_settings_import", input || {}, WRITE),
      deadLetterList: (input: any) => call("shogun_dead_letter_list", input || {}, READ),
      deadLetterRetry: (input: any) => call("shogun_dead_letter_retry", input || {}, WRITE),
      deadLetterClear: (input: any) => call("shogun_dead_letter_clear", input || {}, WRITE),
      deadLetterRetryOne: (input: any) => call("shogun_dead_letter_retry_one", input || {}, WRITE),
      deadLetterDelete: (input: any) => call("shogun_dead_letter_delete", input || {}, WRITE),
      llmApiKeySet: (input: any) => call("app_llm_api_key_set", input, WRITE),
      llmApiKeyStatus: (input: any) => call("app_llm_api_key_status", input, READ),
      llmApiKeyClear: (input: any) => call("app_llm_api_key_clear", input, WRITE),
      integrationConnect: (input: any) => call("app_integration_connect", input, WRITE),
      oauthGoogleStart: (input: any) => call("shogun_oauth_google_start", input, WRITE),
      integrationImportCredentials: (input: any) =>
        call("app_integration_import_credentials", input, WRITE),
      integrationCredentialsStatus: (input: any) =>
        call("app_integration_credentials_status", input, READ),
      integrationToggle: (input: any) => call("app_integration_toggle", input, WRITE),
      googleCalendarSync: (input: any) => call("shogun_google_calendar_sync", input, WRITE),
      gmailSync: (input: any) => call("shogun_gmail_sync", input, WRITE),
      slackSync: (input: any) => call("shogun_slack_sync", input, WRITE, { timeoutMs: 900000 }),
      notionSync: (input: any) => call("shogun_notion_sync", input, WRITE, { timeoutMs: 900000 }),
      githubSync: (input: any) => call("shogun_github_sync", input, WRITE, { timeoutMs: 900000 }),
      linearSync: (input: any) => call("shogun_linear_sync", input, WRITE, { timeoutMs: 900000 }),
      driveSync: (input: any) => call("shogun_drive_sync", input, WRITE, { timeoutMs: 900000 }),
      zoomSync: (input: any) => call("shogun_zoom_sync", input, WRITE, { timeoutMs: 900000 }),
      capturePause: (input: any) => call("app_capture_pause", input, WRITE),
      captureResume: (input: any) => call("app_capture_resume", input, WRITE),
      permissionsManage: (input: any) => call("app_permissions_manage", input, WRITE),
      privacyPickApp: (input: any) => call("app_privacy_pick_app", input || {}, WRITE),
      diagnosticsReport: (input: any) => call("app_diagnostics_report", input, WRITE),
      updatesCheck: (input: any) => call("app_updates_check", input || {}, READ),
      updatesDownloadInstall: (input: any) => call("app_updates_download_install", input || {}, WRITE),
      frontendErrorReport: (input: any) => call("app_frontend_error_report", input, WRITE),
      accountDeleteData: (input: any) => call("app_delete_data_range", input, WRITE),
      accountDeleteAll: (input: any) => call("app_delete_all_data", input, WRITE),
      accountDeleteSelf: (input: any) => call("app_delete_account", input, WRITE),
      authClerkConfig: (input: any) => call("auth_clerk_config", input || {}, READ),
      authOpenBrowserSignIn: (input: any) => call("auth_open_browser_sign_in", input || {}, WRITE),
      authOpenBrowserSignUp: (input: any) => call("auth_open_browser_sign_up", input || {}, WRITE),
      authStatus: (input: any) => call("auth_status", input || {}, READ),
      authSessionSave: (input: any) => call("auth_session_save", input, WRITE),
      authSignOut: (input: any) => call("auth_sign_out", input || {}, WRITE),
      authBiometricStatus: (input: any) => call("auth_biometric_status", input || {}, READ),
      authBiometricAuthenticate: (input: any) =>
        call("auth_biometric_authenticate", input || {}, WRITE),
      meetingStart: (input: any) => call("shogun_meeting_start", input, WRITE),
      meetingLinkClientNote: (input: any) => call("shogun_meeting_link_client_note", input, WRITE),
      meetingResolveByStorageKey: (input: any) =>
        call("shogun_meeting_resolve_by_storage_key", input, READ),
      meetingStop: (input: any) => call("shogun_meeting_stop", input, WRITE),
      meetingNoteAppendBlock: (input: any) => call("shogun_meeting_note_append_block", input, WRITE),
      meetingNoteEditBlock: (input: any) => call("shogun_meeting_note_edit_block", input, WRITE),
      meetingNoteDeleteBlock: (input: any) => call("shogun_meeting_note_delete_block", input, WRITE),
      meetingEnhance: (input: any) => call("shogun_meeting_enhance", input, WRITE),
      meetingReEnhance: (input: any) => call("shogun_meeting_re_enhance", input, WRITE),
      meetingTranscriptForBlock: (input: any) => call("shogun_meeting_transcript_for_block", input, READ),
      meetingTranscriptLive: (input: any) => call("shogun_meeting_transcript_live", input, READ),
      meetingPurge: (input: any) => call("shogun_meeting_purge", input, WRITE),
      meetingList: (input: any) => call("shogun_meeting_list", input, READ),
      meetingGet: (input: any) => call("shogun_meeting_get", input, READ),
      meetingTranscriptGet: (input: any) => call("shogun_meeting_transcript_get", input, READ),
      meetingNotesGet: (input: any) => call("shogun_meeting_notes_get", input, READ),
      meetingsSearch: (input: any) => call("shogun_meetings_search", input, READ),
      meetingRecipeRun: (input: any) => call("shogun_meeting_recipe_run", input, WRITE),
      meetingTemplatesList: (input: any) => call("shogun_meeting_templates_list", input, READ),
      meetingTranscriptPush: (input: any) => call("shogun_meeting_transcript_push", input, WRITE),
      meetingAudioStatus: (input: any) => call("shogun_meeting_audio_status", input, READ),
      meetingMicStart: (input: any) => call("shogun_meeting_mic_start", input, WRITE),
      meetingMicStop: (input: any) => call("shogun_meeting_mic_stop", input, WRITE),
      meetingTranscribePcm: (input: any) => call("shogun_meeting_transcribe_pcm", input, WRITE),
      meetingMcpTools: (input: any) => call("shogun_meeting_mcp_tools", input, READ),
      meetingImportPick: (input: any) => call("shogun_meeting_import_pick", input || {}, WRITE),
      meetingImportFile: (input: any) => call("shogun_meeting_import_file", input, WRITE),
      meetingContextTimeline: (input: any) => call("shogun_meeting_context_timeline", input, READ),
      mirror: {
        register: (input: any) => call("mirror_register", input, WRITE),
        unlock: (input: any) => call("mirror_unlock", input, WRITE),
        status: (input: any) => call("mirror_status", input || {}, READ),
        syncNow: (input: any) => call("mirror_sync_now", input || {}, WRITE),
        disable: (input: any) => call("mirror_disable", input || {}, WRITE),
        resetStuck: (input: any) => call("mirror_reset_stuck", input || {}, WRITE),
        // Phase 2.1.4: search blobs + device management.
        searchBlobs: (input: any) => call("mirror_search_blobs", input || {}, READ),
        listDevices: (input: any) => call("mirror_list_devices", input || {}, READ),
        renameDevice: (input: any) => call("mirror_rename_device", input, WRITE),
        deleteDevice: (input: any) => call("mirror_delete_device", input, WRITE),
      },
    };
  }

  global.ShogunAPI = { createApi: createApi, READ: READ, WRITE: WRITE };

  // Memory export/import constants — kept in lockstep with the Rust side
  // (`src-tauri/src/memory_export.rs::CONFIRM_TOKEN`). Update both if you
  // ever change the literal.
  global.ShogunMemoryExport = { CONFIRM_TOKEN: "REPLACE" };
})(typeof window !== 'undefined' ? window : globalThis);

export const ShogunAPI: { createApi: (client?: any) => any; READ: string; WRITE: string } =
  (typeof window !== 'undefined' ? (window as any) : (globalThis as any)).ShogunAPI;

export const ShogunMemoryExport: { CONFIRM_TOKEN: string } =
  (typeof window !== 'undefined' ? (window as any) : (globalThis as any)).ShogunMemoryExport;
