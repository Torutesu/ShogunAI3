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

    if (command === "shogun_brief_get" && global.ShogunMorningBrief) {
      return global.ShogunMorningBrief.mockBriefGetResponse(echo);
    }

    const notImpl = (message) => ({
      notImplemented: true,
      message: message,
      stub: false,
      echo: echo,
    });

    function normalizeProvider(raw) {
      return String(raw || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
    }
    const localConnectSlugs = new Set(["arc_browser", "raycast", "obsidian"]);

    switch (command) {
      case "app_integration_connect": {
        const slug = normalizeProvider(echo.provider);
        if (localConnectSlugs.has(slug)) {
          return {
            connected: true,
            provider: slug,
            stub: false,
            echo: echo,
          };
        }
        return notImpl(
          "Third-party integrations (OAuth, calendar, mail) are not available in v1. This build is local-only; connect Arc, Raycast, or Obsidian for local-only toggles.",
        );
      }
      case "app_integration_toggle":
        return {
          saved: true,
          connected: echo.connected === true,
          provider: normalizeProvider(echo.provider),
          stub: false,
          echo: echo,
        };
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
        return notImpl("Opening packs / deep links is not available in v1.");
      case "shogun_start_focus_session":
        return notImpl("Focus sessions are not available in v1.");
      case "shogun_draft_reply":
        return notImpl("Draft-from-brief actions are not available in v1. Use Chat instead.");
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
      case "shogun_memory_search":
        return {
          hits: [],
          total: 0,
          echo: echo,
          stub: false,
        };
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
      case "shogun_entity_query":
        return {
          entities: [],
          echo: echo,
          stub: false,
        };
      case "shogun_stats":
        return {
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
      case "shogun_chat_complete":
        throw createError(
          "LLM_KEY",
          "LLM API key is not set. Open Settings → Model & API and save your key.",
        );
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
          settings: { sections: {} },
          echo: echo,
          stub: false,
        };
      case "app_settings_save":
        return {
          saved: true,
          settings: echo,
          echo: echo,
          stub: false,
        };
      case "app_llm_api_key_set":
        return { saved: true, stub: false };
      case "app_llm_api_key_status":
        return {
          configured: false,
          echo: echo,
          stub: false,
        };
      case "app_llm_api_key_clear":
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

    async function invoke(command, payload) {
      if (!command) {
        throw createError("INVALID_COMMAND", "command is required");
      }

      const request = {
        command: command,
        payload: payload || {},
      };

      try {
        const raw = transport === "tauri"
          ? await withTimeout(tauriTransport(command, payload), timeoutMs)
          : await withTimeout(mockTransport(command, payload), timeoutMs);
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
