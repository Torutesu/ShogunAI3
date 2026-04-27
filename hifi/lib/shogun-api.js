/* global window */
(function initShogunApi(global) {
  const READ = "READ";
  const WRITE = "WRITE";

  function createApi(client) {
    const ipc = client || (global.ShogunIpcClient && global.ShogunIpcClient.createIpcClient
      ? global.ShogunIpcClient.createIpcClient()
      : null);

    if (!ipc) {
      throw new Error("ShogunIpcClient is required");
    }

    async function call(command, payload, kind, invokeOpts) {
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
      memorySearch: (input) => call("shogun_memory_search", input, READ),
      memoryFetch: (input) => call("shogun_memory_fetch", input, READ),
      memoryIngest: (input) => call("shogun_memory_ingest", input, WRITE),
      memorySummaryGet: (input) => call("shogun_memory_summary_get", input, READ),
      memorySummaryBatch: (input) => call("shogun_memory_summary_batch", input, READ),
      memorySummaryInvalidate: (input) => call("shogun_memory_summary_invalidate", input, WRITE),
      memoryRollupGet: (input) => call("shogun_memory_rollup_get", input, READ),
      memoryDayRollupGet: (input) => call("shogun_memory_day_rollup_get", input, READ),
      lessonCaptureRejection: (input) => call("shogun_lesson_capture_rejection", input, WRITE),
      lessonCaptureToolFailure: (input) => call("shogun_lesson_capture_tool_failure", input, WRITE),
      patternsRunNow: (input) => call("shogun_patterns_run_now", input, WRITE),
      patternsList: (input) => call("shogun_patterns_list", input || {}, READ),
      patternsInvalidate: (input) => call("shogun_patterns_invalidate", input, WRITE),
      lessonsList: (input) => call("shogun_lessons_list", input || {}, READ),
      lessonsArchive: (input) => call("shogun_lessons_archive", input, WRITE),
      lessonsStats: (input) => call("shogun_lessons_stats", input || {}, READ),
      memoryMonthRollupGet: (input) => call("shogun_memory_month_rollup_get", input, READ),
      memoryYearRollupGet: (input) => call("shogun_memory_year_rollup_get", input, READ),
      memorySummarySetPriority: (input) => call("shogun_memory_summary_set_priority", input, WRITE),
      memorySummaryAcknowledge: (input) => call("shogun_memory_summary_acknowledge", input, WRITE),
      memoryEntityRollupGet: (input) => call("shogun_memory_entity_rollup_get", input, READ),
      memorySummarySnooze: (input) => call("shogun_memory_summary_snooze", input, WRITE),
      memoryDelete: (input) => call("shogun_memory_delete", input, WRITE),
      memoryEmbedBackfill: (input) =>
        call("shogun_memory_embed_backfill", input, WRITE, { timeoutMs: 600000 }),
      memoryEmbedBackfillCancel: (input) =>
        call("shogun_memory_embed_backfill_cancel", input || {}, WRITE),
      memoryDebugRecentCalls: (input) => call("shogun_memory_debug_recent_calls", input || { limit: 50 }, READ),
      memoryDebugQuery: (input) => call("shogun_memory_debug_query", input, READ),
      memoryDebugStats: () => call("shogun_memory_debug_stats", {}, READ),
      memoryDebugSyncStatus: () => call("shogun_memory_debug_sync_status", {}, READ),
      memoryDebugGate: () => call("shogun_memory_debug_gate", {}, READ),
      entityQuery: (input) => call("shogun_entity_query", input, READ),
      briefGet: (input) => call("shogun_brief_get", input, READ),
      kiokuBriefSignals: (input) =>
        call("shogun_kioku_brief_signals", input || {}, READ),
      kiokuDebugStats: () => call("shogun_kioku_debug_stats", {}, READ),
      kiokuBackupDb: (input) =>
        call("shogun_kioku_backup_db", input || {}, WRITE),
      kiokuEdgeTypeProposals: (input) =>
        call("shogun_kioku_edge_type_proposals", input || {}, READ),
      kiokuEdgeTypeReview: (input) =>
        call("shogun_kioku_edge_type_review", input, WRITE),
      openPack: (input) => call("shogun_open_pack", input, WRITE),
      draftReply: (input) => call("shogun_draft_reply", input, WRITE),
      startFocusSession: (input) => call("shogun_start_focus_session", input, WRITE),
      chatComplete: (input) => call("shogun_chat_complete", input, WRITE),
      draftCreate: (input) => call("shogun_draft", input, WRITE),
      scheduleAction: (input) => call("shogun_schedule_action", input, WRITE),
      statsGet: (input) => call("shogun_stats", input, READ),
      appOpenHummingbird: (input) => call("app_open_hummingbird", input, WRITE),
      appCreateShareLink: (input) => call("app_create_share_link", input, WRITE),
      settingsLoad: (input) => call("app_settings_load", input, READ),
      settingsSave: (input) => call("app_settings_save", input, WRITE),
      settingsExport: (input) => call("app_settings_export", input || {}, WRITE),
      settingsImport: (input) => call("app_settings_import", input || {}, WRITE),
      deadLetterList: (input) => call("shogun_dead_letter_list", input || {}, READ),
      deadLetterRetry: (input) => call("shogun_dead_letter_retry", input || {}, WRITE),
      deadLetterClear: (input) => call("shogun_dead_letter_clear", input || {}, WRITE),
      deadLetterRetryOne: (input) => call("shogun_dead_letter_retry_one", input || {}, WRITE),
      deadLetterDelete: (input) => call("shogun_dead_letter_delete", input || {}, WRITE),
      llmApiKeySet: (input) => call("app_llm_api_key_set", input, WRITE),
      llmApiKeyStatus: (input) => call("app_llm_api_key_status", input, READ),
      llmApiKeyClear: (input) => call("app_llm_api_key_clear", input, WRITE),
      integrationConnect: (input) => call("app_integration_connect", input, WRITE),
      oauthGoogleStart: (input) => call("shogun_oauth_google_start", input, WRITE),
      integrationImportCredentials: (input) =>
        call("app_integration_import_credentials", input, WRITE),
      integrationCredentialsStatus: (input) =>
        call("app_integration_credentials_status", input, READ),
      integrationToggle: (input) => call("app_integration_toggle", input, WRITE),
      googleCalendarSync: (input) => call("shogun_google_calendar_sync", input, WRITE),
      gmailSync: (input) => call("shogun_gmail_sync", input, WRITE),
      slackSync: (input) => call("shogun_slack_sync", input, WRITE, { timeoutMs: 900000 }),
      notionSync: (input) => call("shogun_notion_sync", input, WRITE, { timeoutMs: 900000 }),
      githubSync: (input) => call("shogun_github_sync", input, WRITE, { timeoutMs: 900000 }),
      linearSync: (input) => call("shogun_linear_sync", input, WRITE, { timeoutMs: 900000 }),
      driveSync: (input) => call("shogun_drive_sync", input, WRITE, { timeoutMs: 900000 }),
      zoomSync: (input) => call("shogun_zoom_sync", input, WRITE, { timeoutMs: 900000 }),
      capturePause: (input) => call("app_capture_pause", input, WRITE),
      captureResume: (input) => call("app_capture_resume", input, WRITE),
      permissionsManage: (input) => call("app_permissions_manage", input, WRITE),
      privacyPickApp: (input) => call("app_privacy_pick_app", input || {}, WRITE),
      diagnosticsReport: (input) => call("app_diagnostics_report", input, WRITE),
      updatesCheck: (input) => call("app_updates_check", input || {}, READ),
      updatesDownloadInstall: (input) => call("app_updates_download_install", input || {}, WRITE),
      frontendErrorReport: (input) => call("app_frontend_error_report", input, WRITE),
      accountDeleteData: (input) => call("app_delete_data_range", input, WRITE),
      accountDeleteAll: (input) => call("app_delete_all_data", input, WRITE),
      accountDeleteSelf: (input) => call("app_delete_account", input, WRITE),
      authClerkConfig: (input) => call("auth_clerk_config", input || {}, READ),
      authOpenBrowserSignIn: (input) => call("auth_open_browser_sign_in", input || {}, WRITE),
      authOpenBrowserSignUp: (input) => call("auth_open_browser_sign_up", input || {}, WRITE),
      authStatus: (input) => call("auth_status", input || {}, READ),
      authSessionSave: (input) => call("auth_session_save", input, WRITE),
      authSignOut: (input) => call("auth_sign_out", input || {}, WRITE),
      authBiometricStatus: (input) => call("auth_biometric_status", input || {}, READ),
      authBiometricAuthenticate: (input) =>
        call("auth_biometric_authenticate", input || {}, WRITE),
      meetingStart: (input) => call("shogun_meeting_start", input, WRITE),
      meetingStop: (input) => call("shogun_meeting_stop", input, WRITE),
      meetingNoteAppendBlock: (input) => call("shogun_meeting_note_append_block", input, WRITE),
      meetingNoteEditBlock: (input) => call("shogun_meeting_note_edit_block", input, WRITE),
      meetingNoteDeleteBlock: (input) => call("shogun_meeting_note_delete_block", input, WRITE),
      meetingEnhance: (input) => call("shogun_meeting_enhance", input, WRITE),
      meetingReEnhance: (input) => call("shogun_meeting_re_enhance", input, WRITE),
      meetingTranscriptForBlock: (input) => call("shogun_meeting_transcript_for_block", input, READ),
      meetingTranscriptLive: (input) => call("shogun_meeting_transcript_live", input, READ),
      meetingPurge: (input) => call("shogun_meeting_purge", input, WRITE),
      meetingList: (input) => call("shogun_meeting_list", input, READ),
      meetingGet: (input) => call("shogun_meeting_get", input, READ),
      meetingTranscriptGet: (input) => call("shogun_meeting_transcript_get", input, READ),
      meetingNotesGet: (input) => call("shogun_meeting_notes_get", input, READ),
      meetingsSearch: (input) => call("shogun_meetings_search", input, READ),
      meetingRecipeRun: (input) => call("shogun_meeting_recipe_run", input, WRITE),
      meetingTemplatesList: (input) => call("shogun_meeting_templates_list", input, READ),
      meetingTranscriptPush: (input) => call("shogun_meeting_transcript_push", input, WRITE),
      meetingAudioStatus: (input) => call("shogun_meeting_audio_status", input, READ),
      meetingMicStart: (input) => call("shogun_meeting_mic_start", input, WRITE),
      meetingMicStop: (input) => call("shogun_meeting_mic_stop", input, WRITE),
      meetingTranscribePcm: (input) => call("shogun_meeting_transcribe_pcm", input, WRITE),
      meetingMcpTools: (input) => call("shogun_meeting_mcp_tools", input, READ),
      meetingImportPick: (input) => call("shogun_meeting_import_pick", input || {}, WRITE),
      meetingImportFile: (input) => call("shogun_meeting_import_file", input, WRITE),
    };
  }

  global.ShogunAPI = { createApi: createApi, READ: READ, WRITE: WRITE };
})(window);
