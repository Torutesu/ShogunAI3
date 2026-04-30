/* global window */
(function initActionRegistry(global) {
  function createActionRegistry(api, options) {
    const opts = options || {};
    const onMissing = opts.onMissing || function noop() {};
    const onExecute = opts.onExecute || function noop() {};

    const handlers = {};

    function register(key, action) {
      handlers[key] = action;
    }

    async function run(key, payload) {
      const action = handlers[key];
      if (!action) {
        onMissing(key, payload);
        return {
          ok: false,
          error: { code: "ACTION_NOT_REGISTERED", message: "Action is not registered" },
        };
      }
      onExecute(key, payload);
      return action(payload || {});
    }

    register("app.open_hummingbird", () => api.appOpenHummingbird({ source: "topbar" }));
    register("app.create_share_link", (payload) => api.appCreateShareLink(payload));
    register("settings.save", (payload) => api.settingsSave(payload));
    register("settings.load", (payload) => api.settingsLoad(payload));
    register("kioku.backup_db", (payload) => api.kiokuBackupDb(payload));
    register("kioku.edge_type_proposals", (payload) => api.kiokuEdgeTypeProposals(payload));
    register("kioku.edge_type_review", (payload) => api.kiokuEdgeTypeReview(payload));
    register("kioku.cost_summary", (payload) => api.kiokuCostSummary(payload));
    register("settings.export", (payload) => api.settingsExport(payload));
    register("settings.import", (payload) => api.settingsImport(payload));
    register("dead_letter.list", (payload) => api.deadLetterList(payload));
    register("dead_letter.retry", (payload) => api.deadLetterRetry(payload));
    register("dead_letter.clear", (payload) => api.deadLetterClear(payload));
    register("dead_letter.retry_one", (payload) => api.deadLetterRetryOne(payload));
    register("dead_letter.delete", (payload) => api.deadLetterDelete(payload));
    register("integrations.connect", (payload) => api.integrationConnect(payload));
    register("oauth.google.start", (payload) => api.oauthGoogleStart(payload));
    register("integrations.import_credentials", (payload) =>
      api.integrationImportCredentials(payload),
    );
    register("integrations.credentials_status", (payload) =>
      api.integrationCredentialsStatus(payload),
    );
    register("integrations.toggle", (payload) => api.integrationToggle(payload));
    register("calendar.sync", (payload) => api.googleCalendarSync(payload));
    register("gmail.sync", (payload) => api.gmailSync(payload));
    register("slack.sync", (payload) => api.slackSync(payload));
    register("notion.sync", (payload) => api.notionSync(payload));
    register("github.sync", (payload) => api.githubSync(payload));
    register("linear.sync", (payload) => api.linearSync(payload));
    register("drive.sync", (payload) => api.driveSync(payload));
    register("zoom.sync", (payload) => api.zoomSync(payload));
    register("capture.pause", () => api.capturePause({ reason: "user_request" }));
    register("capture.resume", () => api.captureResume({ reason: "user_request" }));
    register("permissions.manage", (payload) => api.permissionsManage(payload));
    register("privacy.pick_app", (payload) => api.privacyPickApp(payload));
    register("diagnostics.report", (payload) => api.diagnosticsReport(payload));
    register("updates.check", (payload) => api.updatesCheck(payload));
    register("updates.download_install", (payload) => api.updatesDownloadInstall(payload));
    register("data.delete_range", (payload) => api.accountDeleteData(payload));
    register("data.delete_all", () => api.accountDeleteAll({}));
    register("account.delete", () => api.accountDeleteSelf({}));
    register("memory.search", (payload) => api.memorySearch(payload));
    register("memory.fetch", (payload) => api.memoryFetch(payload));
    register("memory.ingest", (payload) => api.memoryIngest(payload));
    register("memory.delete", (payload) => api.memoryDelete(payload));
    register("memory.embed_backfill", (payload) => api.memoryEmbedBackfill(payload));
    register("memory.embed_backfill_cancel", () => api.memoryEmbedBackfillCancel({}));
    register("memory.summary.get", (payload) => api.memorySummaryGet(payload));
    register("memory.summary.batch", (payload) => api.memorySummaryBatch(payload));
    register("memory.summary.invalidate", (payload) => api.memorySummaryInvalidate(payload));
    register("memory.rollup.get", (payload) => api.memoryRollupGet(payload));
    register("memory.rollup.day.get", (payload) => api.memoryDayRollupGet(payload));
    register("lesson.capture.rejection", (payload) => api.lessonCaptureRejection(payload));
    register("lesson.capture.tool_failure", (payload) => api.lessonCaptureToolFailure(payload));
    register("patterns.run_now", (payload) => api.patternsRunNow(payload));
    register("supersession.run_now", (payload) => api.supersessionRunNow(payload));
    register("patterns.list", (payload) => api.patternsList(payload));
    register("patterns.invalidate", (payload) => api.patternsInvalidate(payload));
    register("lessons.list", (payload) => api.lessonsList(payload));
    register("lessons.archive", (payload) => api.lessonsArchive(payload));
    register("lessons.stats", (payload) => api.lessonsStats(payload));
    register("memory.rollup.month.get", (payload) => api.memoryMonthRollupGet(payload));
    register("memory.rollup.year.get", (payload) => api.memoryYearRollupGet(payload));
    register("memory.summary.set_priority", (payload) => api.memorySummarySetPriority(payload));
    register("memory.summary.acknowledge", (payload) => api.memorySummaryAcknowledge(payload));
    register("memory.rollup.entity.get", (payload) => api.memoryEntityRollupGet(payload));
    register("memory.summary.snooze", (payload) => api.memorySummarySnooze(payload));
    register("entity.query", (payload) => api.entityQuery(payload));
    register("brief.get", (payload) => api.briefGet(payload));
    register("chat.complete", (payload) => api.chatComplete(payload));
    register("llm.save_api_key", (payload) => api.llmApiKeySet(payload));
    register("llm.api_key_status", (payload) => api.llmApiKeyStatus(payload));
    register("llm.clear_api_key", (payload) => api.llmApiKeyClear(payload));
    register("shogun.open_pack", (payload) => api.openPack(payload));
    register("shogun.draft_reply", (payload) => api.draftReply(payload));
    register("shogun.start_focus_session", (payload) => api.startFocusSession(payload));
    register("stats.get", (payload) => api.statsGet(payload));
    register("draft.create", (payload) => api.draftCreate(payload));
    register("schedule.create", (payload) => api.scheduleAction(payload));
    register("auth.status", (payload) => api.authStatus(payload));
    register("auth.clerk_sign_in", async () => {
      if (global.ShogunClerkAuth && typeof global.ShogunClerkAuth.openSignIn === "function") {
        return global.ShogunClerkAuth.openSignIn();
      }
      return api.authOpenBrowserSignIn({});
    });
    register("auth.clerk_sign_up", async () => {
      if (global.ShogunClerkAuth && typeof global.ShogunClerkAuth.openSignUp === "function") {
        return global.ShogunClerkAuth.openSignUp();
      }
      return api.authOpenBrowserSignUp({});
    });
    register("auth.clerk_sign_out", () => {
      if (global.ShogunClerkAuth && typeof global.ShogunClerkAuth.signOut === "function") {
        return global.ShogunClerkAuth.signOut();
      }
      return api.authSignOut({});
    });
    register("auth.biometric.status", (payload) => api.authBiometricStatus(payload));
    register("auth.biometric.authenticate", (payload) => api.authBiometricAuthenticate(payload));
    register("meetings.start", (payload) => api.meetingStart(payload));
    register("meetings.stop", (payload) => api.meetingStop(payload));
    register("meetings.note.append_block", (payload) => api.meetingNoteAppendBlock(payload));
    register("meetings.note.edit_block", (payload) => api.meetingNoteEditBlock(payload));
    register("meetings.note.delete_block", (payload) => api.meetingNoteDeleteBlock(payload));
    register("meetings.enhance", (payload) => api.meetingEnhance(payload));
    register("meetings.re_enhance", (payload) => api.meetingReEnhance(payload));
    register("meetings.transcript.for_block", (payload) => api.meetingTranscriptForBlock(payload));
    register("meetings.transcript.live", (payload) => api.meetingTranscriptLive(payload));
    register("meetings.purge", (payload) => api.meetingPurge(payload));
    register("meetings.list", (payload) => api.meetingList(payload));
    register("meetings.get", (payload) => api.meetingGet(payload));
    register("meetings.transcript.get", (payload) => api.meetingTranscriptGet(payload));
    register("meetings.notes.get", (payload) => api.meetingNotesGet(payload));
    register("meetings.search", (payload) => api.meetingsSearch(payload));
    register("meetings.recipe.run", (payload) => api.meetingRecipeRun(payload));
    register("meetings.templates.list", (payload) => api.meetingTemplatesList(payload));
    register("meetings.transcript.push", (payload) => api.meetingTranscriptPush(payload));
    register("meetings.audio.status", (payload) => api.meetingAudioStatus(payload));
    register("meetings.mic.start", (payload) => api.meetingMicStart(payload));
    register("meetings.mic.stop", (payload) => api.meetingMicStop(payload));
    register("meetings.transcribe.pcm", (payload) => api.meetingTranscribePcm(payload));
    register("meetings.mcp.tools", (payload) => api.meetingMcpTools(payload));
    register("meetings.import.pick", (payload) => api.meetingImportPick(payload));
    register("meetings.import.file", (payload) => api.meetingImportFile(payload));

    return {
      run: run,
      register: register,
      keys: function keys() { return Object.keys(handlers); },
    };
  }

  global.ShogunActionRegistry = { createActionRegistry: createActionRegistry };
})(window);
