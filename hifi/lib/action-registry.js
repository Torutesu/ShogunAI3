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
    register("integrations.connect", (payload) => api.integrationConnect(payload));
    register("integrations.import_credentials", (payload) =>
      api.integrationImportCredentials(payload),
    );
    register("integrations.credentials_status", (payload) =>
      api.integrationCredentialsStatus(payload),
    );
    register("integrations.toggle", (payload) => api.integrationToggle(payload));
    register("calendar.sync", (payload) => api.googleCalendarSync(payload));
    register("capture.pause", () => api.capturePause({ reason: "user_request" }));
    register("capture.resume", () => api.captureResume({ reason: "user_request" }));
    register("permissions.manage", (payload) => api.permissionsManage(payload));
    register("diagnostics.report", (payload) => api.diagnosticsReport(payload));
    register("data.delete_range", (payload) => api.accountDeleteData(payload));
    register("data.delete_all", () => api.accountDeleteAll({}));
    register("account.delete", () => api.accountDeleteSelf({}));
    register("memory.search", (payload) => api.memorySearch(payload));
    register("memory.ingest", (payload) => api.memoryIngest(payload));
    register("memory.delete", (payload) => api.memoryDelete(payload));
    register("memory.embed_backfill", (payload) => api.memoryEmbedBackfill(payload));
    register("memory.embed_backfill_cancel", () => api.memoryEmbedBackfillCancel({}));
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

    return {
      run: run,
      register: register,
      keys: function keys() { return Object.keys(handlers); },
    };
  }

  global.ShogunActionRegistry = { createActionRegistry: createActionRegistry };
})(window);
