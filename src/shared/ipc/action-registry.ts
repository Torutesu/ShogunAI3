import { ShogunAPI } from './shogun-api';
import { ShogunClerkAuth } from '@/shared/lib/clerk-auth';

(function initActionRegistry(global: any) {
  function createActionRegistry(api: any, options?: any) {
    const opts = options || {};
    const onMissing = opts.onMissing || function noop() {};
    const onExecute = opts.onExecute || function noop() {};

    const handlers: Record<string, (payload: any) => any> = {};

    function register(key: string, action: (payload: any) => any) {
      handlers[key] = action;
    }

    async function run(key: string, payload?: any) {
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
    register("kioku.pipeline_smoke", () => api.kiokuPipelineSmoke());
    register("kioku.edge_type_proposals", (payload) => api.kiokuEdgeTypeProposals(payload));
    register("kioku.edge_type_review", (payload) => api.kiokuEdgeTypeReview(payload));
    register("settings.export", (payload) => api.settingsExport(payload));
    register("settings.import", (payload) => api.settingsImport(payload));
    register("dead_letter.list", (payload) => api.deadLetterList(payload));
    register("dead_letter.retry", (payload) => api.deadLetterRetry(payload));
    register("dead_letter.clear", (payload) => api.deadLetterClear(payload));
    register("dead_letter.retry_one", (payload) => api.deadLetterRetryOne(payload));
    register("dead_letter.delete", (payload) => api.deadLetterDelete(payload));
    register("integrations.connect", (payload) => api.integrationConnect(payload));
    register("oauth.google.start", (payload) => api.oauthGoogleStart(payload));
    register("oauth.google.app_status", (payload) => api.oauthGoogleAppStatus(payload));
    register("oauth.google.app_set", (payload) => api.oauthGoogleAppSet(payload));
    register("agent.run_now", (payload) => api.agentRunNow(payload));
    register("hummingbird.context", (payload) => api.hummingbirdContext(payload));
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
    register("outlook.sync", (payload) => api.outlookSync(payload));
    register("figma.sync", (payload) => api.figmaSync(payload));
    register("claude.sync", (payload) => api.claudeSync(payload));
    register("apple_calendar.sync", (payload) => api.appleCalendarSync(payload));
    register("apple_reminders.sync", (payload) => api.appleRemindersSync(payload));
    register("capture.pause", () => api.capturePause({ reason: "user_request" }));
    register("capture.resume", () => api.captureResume({ reason: "user_request" }));
    register("capture.live_events", (payload) => api.captureLiveEvents(payload));
    register("capture.status", (payload) => api.captureStatus(payload));
    register("onboarding.complete", (payload) => api.onboardingComplete(payload));
    register("permissions.manage", (payload) => api.permissionsManage(payload));
    register("privacy.pick_app", (payload) => api.privacyPickApp(payload));
    register("diagnostics.report", (payload) => api.diagnosticsReport(payload));
    register("updates.check", (payload) => api.updatesCheck(payload));
    register("updates.download_install", (payload) => api.updatesDownloadInstall(payload));
    register("data.delete_range", (payload) => api.accountDeleteData(payload));
    register("data.delete_all", () => api.accountDeleteAll({}));
    register("account.delete", () => api.accountDeleteSelf({}));
    register("memory.search", (payload) => {
      const merge = global.ShogunMemorySearch;
      if (merge && typeof merge.runMemorySearchMerged === "function") {
        return merge.runMemorySearchMerged(api, payload);
      }
      return api.memorySearch(payload);
    });
    register("memory.timelineSearch", (payload) => api.memoryTimelineSearch(payload));
    register("memory.fetch", (payload) => api.memoryFetch(payload));
    register("memory.ingest", (payload) => api.memoryIngest(payload));
    register("memory.delete", (payload) => api.memoryDelete(payload));
    register("memory.export", (payload) => api.memoryExport(payload));
    register("memory.import", (payload) => api.memoryImport(payload));
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
      if (ShogunClerkAuth && typeof ShogunClerkAuth.openSignIn === "function") {
        return ShogunClerkAuth.openSignIn();
      }
      return api.authOpenBrowserSignIn({});
    });
    register("auth.clerk_sign_up", async () => {
      if (ShogunClerkAuth && typeof ShogunClerkAuth.openSignUp === "function") {
        return ShogunClerkAuth.openSignUp();
      }
      return api.authOpenBrowserSignUp({});
    });
    register("auth.clerk_sign_out", () => {
      if (ShogunClerkAuth && typeof ShogunClerkAuth.signOut === "function") {
        return ShogunClerkAuth.signOut();
      }
      return api.authSignOut({});
    });
    register("auth.biometric.status", (payload) => api.authBiometricStatus(payload));
    register("auth.biometric.authenticate", (payload) => api.authBiometricAuthenticate(payload));
    register("meetings.start", (payload) => api.meetingStart(payload));
    register("meetings.link_client_note", (payload) => api.meetingLinkClientNote(payload));
    register("meetings.resolve_by_storage_key", (payload) => api.meetingResolveByStorageKey(payload));
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
    register("meetings.context_timeline", (payload) => api.meetingContextTimeline(payload));

    // Phase 2.1.2: Mirror cloud sync actions.
    register("mirror.register", (payload) => api.mirror.register(payload));
    register("mirror.unlock", (payload) => api.mirror.unlock(payload));
    register("mirror.status", (payload) => api.mirror.status(payload));
    register("mirror.sync_now", (payload) => api.mirror.syncNow(payload));
    register("mirror.disable", (payload) => api.mirror.disable(payload));
    register("mirror.reset_stuck", (payload) => api.mirror.resetStuck(payload));

    // Phase 2.1.4: Mirror search + device management actions.
    register("mirror.search_blobs", (payload) => api.mirror.searchBlobs(payload));
    register("mirror.list_devices", (payload) => api.mirror.listDevices(payload));
    register("mirror.rename_device", (payload) => api.mirror.renameDevice(payload));
    register("mirror.delete_device", (payload) => api.mirror.deleteDevice(payload));

    return {
      run: run,
      register: register,
      keys: function keys() { return Object.keys(handlers); },
    };
  }

  global.ShogunActionRegistry = { createActionRegistry: createActionRegistry };
})(typeof window !== 'undefined' ? window : globalThis);

export const ShogunActionRegistry: { createActionRegistry: (api: typeof ShogunAPI, options?: any) => any } =
  (typeof window !== 'undefined' ? (window as any) : (globalThis as any)).ShogunActionRegistry;

// SHOGUN_RUNTIME is set by the app bootstrap (e.g. main.tsx), not here.
// We export the type so callers can reference it; the actual value is window.SHOGUN_RUNTIME.
export type ShogunRuntime = {
  executeAction: (key: string, payload?: any, options?: any) => Promise<any>;
  setActiveScreen: (screen: string, params?: any) => void;
  [key: string]: any;
};

export const SHOGUN_RUNTIME: ShogunRuntime | undefined =
  typeof window !== 'undefined' ? (window as any).SHOGUN_RUNTIME : undefined;
