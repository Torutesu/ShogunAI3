/* global window */
(function initIpcClient(global) {
  const DEFAULT_TIMEOUT_MS = 8000;

  function createError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    err.details = details || null;
    return err;
  }

  function hasTauriInvoke() {
    return Boolean(global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function");
  }

  async function tauriTransport(command, payload) {
    if (!hasTauriInvoke()) {
      throw createError("TRANSPORT_UNAVAILABLE", "Tauri invoke is unavailable");
    }
    return global.__TAURI__.core.invoke(command, payload || {});
  }

  /**
   * Browser mock: JSON bodies aligned with `src-tauri/src/commands.rs` success values.
   * Returned value becomes `invoke().data` (same as Tauri deserialize into JS).
   */
  async function mockTransport(command, payload) {
    const echo = payload || {};
    const DEMO = global.SHOGUN_DEMO_SEED || null;

    const MOCK_SETTINGS_LS = "shogun.hifi.mock.settings.sections.v1";
    function readMockSettingsSections() {
      try {
        if (!global.localStorage) return {};
        const raw = global.localStorage.getItem(MOCK_SETTINGS_LS);
        if (!raw) return {};
        const o = JSON.parse(raw);
        return o && typeof o === "object" ? o : {};
      } catch (_) {
        return {};
      }
    }
    function mergeMockSettingsSection(section, patch) {
      if (!global.localStorage || !section || typeof patch !== "object") return;
      const sections = readMockSettingsSections();
      const prev = sections[section] && typeof sections[section] === "object" ? sections[section] : {};
      sections[section] = { ...prev, ...patch };
      global.localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(sections));
    }

    const MOCK_LLM_KEY_LS = "shogun.hifi.mock.llm.keyConfigured.v1";
    function readMockLlmKeyConfigured() {
      try {
        if (!global.localStorage) return false;
        return global.localStorage.getItem(MOCK_LLM_KEY_LS) === "1";
      } catch (_) {
        return false;
      }
    }
    function writeMockLlmKeyConfigured(on) {
      try {
        if (!global.localStorage) return;
        if (on) global.localStorage.setItem(MOCK_LLM_KEY_LS, "1");
        else global.localStorage.removeItem(MOCK_LLM_KEY_LS);
      } catch (_) {
        /* ignore */
      }
    }

    if (command === "shogun_brief_get" && global.ShogunMorningBrief) {
      return global.ShogunMorningBrief.mockBriefGetResponse(echo);
    }

    const notImpl = (message) => ({
      notImplemented: true,
      message: message,
      stub: false,
      echo: echo,
    });

    switch (command) {
      case "app_integration_connect":
      case "app_integration_toggle":
      case "app_integration_import_credentials":
      case "app_integration_credentials_status":
      case "shogun_google_calendar_sync": {
        const C = global.ShogunIntegrationConnectors;
        if (C && typeof C.mockIntegrationPayload === "function") {
          const payload = C.mockIntegrationPayload(command, echo);
          if (payload) return payload;
        }
        return notImpl("Integration mock unavailable.", echo);
      }
      case "shogun_draft":
        return {
          content: "# Draft\n\n_Mock Markdown from browser transport. Tauri uses your LLM key._\n",
          title: echo.target ? `Draft · ${echo.target}` : "Draft",
          stub: false,
          echo: echo,
        };
      case "shogun_schedule_action":
        return {
          scheduled: true,
          id: "sch-mock",
          stub: false,
          echo: echo,
        };
      case "shogun_open_pack":
        return {
          ok: true,
          data: {
            opened: true,
            path: "(browser mock) packs/example",
            stub: false,
            echo: echo,
          },
        };
      case "shogun_start_focus_session":
        return {
          ok: true,
          data: {
            started: true,
            ends_at_ms: Date.now() + 25 * 60 * 1000,
            state_path: "(browser mock) active_focus.json",
            focus_markdown: "(browser mock) FOCUS.md",
            stub: false,
            echo: echo,
          },
        };
      case "shogun_draft_reply":
        return {
          ok: true,
          data: {
            content:
              "# Draft reply (browser mock)\n\nUse Tauri + LLM key for Brief-aware drafts.\n",
            title: "Reply draft · mock",
            stub: false,
            echo: echo,
          },
        };
      case "app_capture_pause":
        return {
          paused: true,
          honestPreferenceOnly: true,
          message:
            "Capture sampling paused. No new focus events will be recorded until you resume.",
          stub: false,
          echo: echo,
        };
      case "app_capture_resume":
        return {
          paused: false,
          honestPreferenceOnly: true,
          message:
            "Capture sampling resumed. On macOS, frontmost app is sampled periodically into memory (no screenshots).",
          stub: false,
          echo: echo,
        };
      case "shogun_memory_search": {
        if (!DEMO || !Array.isArray(DEMO.memoryHits)) {
          return { hits: [], total: 0, echo: echo, stub: false };
        }
        let hits = DEMO.memoryHits.slice();
        const q = String((echo && echo.query) || "")
          .trim()
          .toLowerCase();
        if (q) {
          hits = hits.filter((h) =>
            `${h.title || ""} ${h.snippet || ""}`.toLowerCase().includes(q),
          );
        }
        const limit = Math.min(80, Math.max(1, Number(echo.limit) || 40));
        return {
          hits: hits.slice(0, limit),
          total: hits.length,
          semanticRerank: !!(echo && echo.semantic),
          echo: echo,
          stub: false,
        };
      }
      case "shogun_memory_fetch":
        return {
          items: [],
          echo: echo,
          stub: false,
        };
      case "shogun_memory_ingest":
        return {
          ingested: true,
          echo: echo,
          stub: false,
        };
      case "shogun_memory_delete":
        return {
          deleted: true,
          echo: echo,
          stub: false,
        };
      case "shogun_memory_embed_backfill": {
        const lim = echo && echo.limit != null ? Number(echo.limit) : 40;
        const clamped = Number.isFinite(lim) ? Math.min(200, Math.max(1, Math.floor(lim))) : 40;
        return {
          embedded: 0,
          failed: 0,
          remaining: 0,
          attempted: clamped,
          cancelled: false,
          echo: echo,
          stub: false,
        };
      }
      case "shogun_memory_embed_backfill_cancel":
        return {
          requested: true,
          echo: echo,
          stub: false,
        };
      case "shogun_entity_query":
        return {
          entities: DEMO && Array.isArray(DEMO.entities) ? DEMO.entities : [],
          echo: echo,
          stub: false,
        };
      case "shogun_stats": {
        const empty = {
          eventsToday: "0",
          memoriesToday: "0",
          memoryTotal: 0,
          memoriesLast24h: 0,
          memories: "0",
          disk: "0 B",
          historyDays: "0 days",
          usagePercent: 0,
          appCoverage: [],
          echo: echo,
          stub: false,
        };
        const base =
          DEMO && DEMO.stats && typeof DEMO.stats === "object"
            ? Object.assign({}, DEMO.stats, { echo: echo, stub: false })
            : empty;
        if (echo && echo.stage === "capture") {
          base.settings = {
            sections: {
              capture: {
                axRichCapture: false,
                sampleIntervalSecs: 8,
                axMinIntervalSecs: 0,
                paused: false,
                pipelineAvailable: true,
              },
              integrations: {
                googleCalendarAutoSync: false,
                googleCalendarSyncIntervalMins: 15,
              },
            },
          };
        }
        if (echo && echo.section === "storage") {
          base.memories = base.memories || String(base.memoryTotal || 0);
        }
        return base;
      }
      case "shogun_chat_complete": {
        const msgs = (echo && echo.messages) || [];
        const last = msgs[msgs.length - 1];
        const userText =
          last && last.role === "user" ? String(last.content || "") : "";
        const preview = userText.length > 120 ? userText.slice(0, 120) + "…" : userText;
        return {
          message:
            "[Demo — set an API key in the desktop app for real completions.]\n\nYou asked: " +
            (preview || "(empty)") +
            "\n\nFor **Kitazawa / Aurora**, a sensible next step is to pin the beta scope (DPIA + onboarding) and keep investor slides to three proof points until metrics land.",
          stub: false,
          echo: echo,
        };
      }
      case "app_open_hummingbird":
        return {
          opened: true,
          stub: false,
          echo: echo,
        };
      case "app_create_share_link":
        return {
          exported: true,
          path: "/mock/shogun-share-export.md",
          stub: false,
          echo: echo,
        };
      case "app_settings_load":
        return {
          settings: { sections: readMockSettingsSections() },
          echo: echo,
          stub: false,
        };
      case "app_settings_save": {
        if (echo && echo.section) {
          const section = echo.section;
          const { section: _s, ...rest } = echo;
          mergeMockSettingsSection(section, rest);
        }
        return {
          saved: true,
          stub: false,
          echo: echo,
        };
      }
      case "app_llm_api_key_set": {
        const hasKey = String((echo && echo.apiKey) || "").trim().length > 0;
        writeMockLlmKeyConfigured(hasKey);
        return { saved: true, stub: false, echo: echo };
      }
      case "app_llm_api_key_status":
        return {
          configured: readMockLlmKeyConfigured(),
          echo: echo,
          stub: false,
        };
      case "app_llm_api_key_clear":
        writeMockLlmKeyConfigured(false);
        return { cleared: true, echo: echo, stub: false };
      case "app_permissions_manage":
        return {
          opened: true,
          note: "Opened System Settings (Screen Recording) when supported.",
          stub: false,
          echo: echo,
        };
      case "app_diagnostics_report":
        return {
          reportId: "diag-mock",
          path: "/mock/diagnostics.json",
          summary: {
            capture: {},
            macosAccessibilityTrusted: null,
            integrations: {
              google_calendar: {
                configured: false,
                tokenRefreshReady: false,
              },
              calendarAutoSync: {
                autoSyncEnabled: false,
                autoSyncIntervalMins: 15,
              },
            },
          },
          stub: false,
          echo: echo,
        };
      case "app_delete_data_range":
        return {
          deleted: true,
          range: echo.range || "",
          stub: false,
          echo: echo,
        };
      case "app_delete_all_data":
        return { deleted: true, stub: false, echo: echo };
      case "app_delete_account":
        return {
          deleted: true,
          note: "Local data cleared. No cloud account is associated with this build.",
          stub: false,
          echo: echo,
        };
      case "auth_clerk_config":
        return {
          enabled: false,
          publishableKey: "",
          frontendApi: "",
          clerkJsUrl: "",
          redirectUrl: "shogun-ai://clerk-callback",
          stub: true,
          echo: echo,
        };
      case "auth_open_browser_sign_in":
        return {
          opened: true,
          stub: true,
          message: "Mock: set CLERK_* in .env and run the desktop app to open the real sign-in URL.",
          echo: echo,
        };
      case "auth_open_browser_sign_up":
        return {
          opened: true,
          stub: true,
          message: "Mock: set CLERK_* in .env and run the desktop app for sign-up.",
          echo: echo,
        };
      case "auth_status":
        return {
          clerk: {
            enabled: false,
            publishableKey: "",
            frontendApi: "",
            clerkJsUrl: "",
            redirectUrl: "shogun-ai://clerk-callback",
          },
          snapshot: null,
          stub: true,
          echo: echo,
        };
      case "auth_session_save":
        return { saved: true, stub: true, echo: echo };
      case "auth_sign_out":
        return { signedOut: true, stub: true, echo: echo };
      case "auth_biometric_status":
        return {
          supported: false,
          enrolled: false,
          platform: "mock",
          biometryType: "none",
          stub: true,
          echo: echo,
        };
      case "auth_biometric_authenticate":
        return { ok: true, stub: true, echo: echo };
      default:
        return {
          stub: true,
          mock: true,
          echo: echo,
          command: command,
        };
    }
  }

  function withTimeout(promise, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(createError("TIMEOUT", "IPC request timed out"));
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function createIpcClient(options) {
    const opts = options || {};
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const transport = opts.transport || (hasTauriInvoke() ? "tauri" : "mock");

    async function invoke(command, payload, invokeOpts) {
      if (!command) {
        throw createError("INVALID_COMMAND", "command is required");
      }

      const request = {
        command: command,
        payload: payload || {},
      };

      const perTimeoutMs =
        invokeOpts && typeof invokeOpts.timeoutMs === "number"
          ? invokeOpts.timeoutMs
          : timeoutMs;

      try {
        const raw = transport === "tauri"
          ? await withTimeout(tauriTransport(command, payload), perTimeoutMs)
          : await withTimeout(mockTransport(command, payload), perTimeoutMs);
        return { ok: true, data: raw, request: request };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error.code || "IPC_ERROR",
            message: error.message || "Unknown IPC error",
            details: error.details || null,
          },
          request: request,
        };
      }
    }

    return {
      invoke: invoke,
      transport: transport,
      hasTauriInvoke: hasTauriInvoke,
    };
  }

  global.ShogunIpcClient = { createIpcClient: createIpcClient };
})(window);
