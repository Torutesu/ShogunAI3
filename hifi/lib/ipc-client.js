/* global window */
(function initIpcClient(global) {
  const DEFAULT_TIMEOUT_MS = 8000;

  function createError(code, message, details) {
    const err = new Error(message);
    err.code = code;
    err.details = details || null;
    return err;
  }

  function tauriInvokeFn() {
    // Tauri v2: invoke lives under window.__TAURI_INTERNALS__.
    // Tauri v1 kept it at window.__TAURI__.core.invoke — supported as a fallback
    // so this code still works if the runtime is downgraded.
    if (global.__TAURI_INTERNALS__ && typeof global.__TAURI_INTERNALS__.invoke === "function") {
      return global.__TAURI_INTERNALS__.invoke;
    }
    if (global.__TAURI__ && global.__TAURI__.core && typeof global.__TAURI__.core.invoke === "function") {
      return global.__TAURI__.core.invoke;
    }
    return null;
  }

  function hasTauriInvoke() {
    return tauriInvokeFn() !== null;
  }

  const HTTP_BACKEND_BASE_LS = "shogun.hifi.backend.baseUrl.v1";
  const HTTP_BACKEND_TOKEN_LS = "shogun.hifi.backend.token.v1";

  function readHttpBackendBase() {
    try {
      if (typeof global.SHOGUN_HTTP_BACKEND_BASE === "string") {
        const s = global.SHOGUN_HTTP_BACKEND_BASE.trim();
        if (s) return s.replace(/\/+$/, "");
      }
      if (!global.localStorage) return "";
      const raw = global.localStorage.getItem(HTTP_BACKEND_BASE_LS);
      const s = String(raw || "").trim();
      return s ? s.replace(/\/+$/, "") : "";
    } catch (_) {
      return "";
    }
  }

  function readHttpBackendToken() {
    try {
      if (typeof global.SHOGUN_HTTP_BACKEND_TOKEN === "string") {
        const s = global.SHOGUN_HTTP_BACKEND_TOKEN.trim();
        if (s) return s;
      }
      if (!global.localStorage) return "";
      return String(global.localStorage.getItem(HTTP_BACKEND_TOKEN_LS) || "").trim();
    } catch (_) {
      return "";
    }
  }

  async function tauriTransport(command, payload) {
    const invoke = tauriInvokeFn();
    if (!invoke) {
      throw createError("TRANSPORT_UNAVAILABLE", "Tauri invoke is unavailable");
    }
    // Rust side uniformly uses `fn shogun_*(payload: Value)` (see
    // src-tauri/src/commands.rs), so args must be wrapped as { payload: X }
    // for Tauri's named-argument deserializer. Commands with no user args
    // still accept this — the extra key is ignored.
    return invoke(command, { payload: payload || {} });
  }

  async function httpTransport(command, payload, timeoutMs) {
    const base = readHttpBackendBase();
    if (!base) {
      throw createError("TRANSPORT_UNAVAILABLE", "HTTP backend base URL is missing");
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
      : null;
    const token = readHttpBackendToken();
    const headers = { "content-type": "application/json" };
    if (token) headers["x-shogun-token"] = token;
    try {
      const res = await fetch(base + "/ipc/invoke", {
        method: "POST",
        headers,
        body: JSON.stringify({ command: command, payload: payload || {} }),
        signal: controller ? controller.signal : undefined,
      });
      if (!res.ok) {
        throw createError("HTTP_ERROR", "HTTP transport failed: " + res.status, { status: res.status });
      }
      const json = await res.json();
      if (!json || json.ok !== true) {
        throw createError(
          "HTTP_BACKEND_ERROR",
          (json && json.error && json.error.message) || "HTTP backend returned an error",
          json && json.error ? json.error : null,
        );
      }
      return json.data;
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw createError("TIMEOUT", "HTTP request timed out");
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
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
        if (!o || typeof o !== "object") return {};
        if (Object.prototype.hasOwnProperty.call(o, "subscription")) {
          const { subscription: _legacySubscription, ...rest } = o;
          try {
            global.localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(rest));
          } catch (_) {
            /* ignore */
          }
          return rest;
        }
        return o;
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
    const MOCK_MEMORY_INDEX_LS = "shogun.hifi.mock.memory.index.v1";
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

    function nowIso() {
      return new Date().toISOString();
    }

    function clampLimit(raw, fallback) {
      const n = Number(raw);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(80, Math.max(1, Math.floor(n)));
    }

    function scoreMemoryHit(hit, queryLower) {
      if (!queryLower) return 0;
      const title = String(hit && hit.title ? hit.title : "").toLowerCase();
      const snippet = String(hit && hit.snippet ? hit.snippet : "").toLowerCase();
      let score = 0;
      if (title.includes(queryLower)) score += 10;
      if (snippet.includes(queryLower)) score += 6;
      const terms = queryLower.split(/\s+/).filter(Boolean);
      for (let i = 0; i < terms.length; i += 1) {
        const t = terms[i];
        if (title.includes(t)) score += 2;
        if (snippet.includes(t)) score += 1;
      }
      return score;
    }

    function readMemoryIndex() {
      try {
        if (!global.localStorage) {
          return DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
        }
        const raw = global.localStorage.getItem(MOCK_MEMORY_INDEX_LS);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parsed;
        }
        const seed = DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
        global.localStorage.setItem(MOCK_MEMORY_INDEX_LS, JSON.stringify(seed));
        return seed;
      } catch (_) {
        return DEMO && Array.isArray(DEMO.memoryHits) ? DEMO.memoryHits.slice() : [];
      }
    }

    function writeMemoryIndex(items) {
      try {
        if (!global.localStorage) return;
        global.localStorage.setItem(MOCK_MEMORY_INDEX_LS, JSON.stringify(Array.isArray(items) ? items : []));
      } catch (_) {
        /* ignore */
      }
    }

    function normalizeMemoryHit(hit, fallbackId) {
      const source = String((hit && hit.source) || "note");
      return {
        id: String((hit && hit.id) || fallbackId || ("mock-" + Date.now())),
        title: String((hit && hit.title) || "Untitled memory"),
        snippet: String((hit && hit.snippet) || ""),
        source: source,
        provenance: String((hit && hit.provenance) || source),
        kinds: Array.isArray(hit && hit.kinds) ? hit.kinds.slice(0, 8) : ["input"],
        ts: String((hit && hit.ts) || nowIso()),
        entity_id: hit && hit.entity_id != null ? String(hit.entity_id) : null,
      };
    }

    function searchMemoryIndex(query, limit, semantic) {
      const items = readMemoryIndex().map((h, i) => normalizeMemoryHit(h, "mock-seed-" + i));
      const q = String(query || "").trim().toLowerCase();
      let filtered = items;
      if (q) {
        filtered = items.filter((h) => scoreMemoryHit(h, q) > 0);
      }
      if (semantic && q) {
        filtered = filtered
          .slice()
          .sort((a, b) => scoreMemoryHit(b, q) - scoreMemoryHit(a, q));
      }
      const lim = clampLimit(limit, 40);
      return {
        hits: filtered.slice(0, lim),
        total: filtered.length,
      };
    }

    function buildMemoryAssemblyBlock(memoryAssembly) {
      if (!memoryAssembly || typeof memoryAssembly !== "object") return null;
      const q = String(memoryAssembly.query || "").trim();
      if (!q) return null;
      const limit = clampLimit(memoryAssembly.limit, 12);
      const semantic = memoryAssembly.semantic !== false;
      const res = searchMemoryIndex(q, limit, semantic);
      const lines = res.hits.map((h, idx) => {
        const label = h.provenance || h.source || "memory";
        return `${idx + 1}. [${label}] ${h.title}: ${h.snippet}`;
      });
      return {
        query: q,
        limit: limit,
        semantic: semantic,
        total: res.total,
        hits: res.hits,
        text: lines.length
          ? lines.join("\n")
          : "(no relevant local memory hits)",
      };
    }

    if (command === "shogun_brief_get" && global.ShogunMorningBrief) {
      return global.ShogunMorningBrief.mockBriefGetResponse(echo);
    }

    if (command === "shogun_kioku_brief_signals") {
      return {
        decision_graph_hits: [],
        related_kioku_hits: [],
        stub: false,
        echo,
      };
    }

    if (command === "shogun_kioku_edge_type_proposals") {
      return {
        proposals: [],
        stub: false,
        echo,
      };
    }
    if (command === "shogun_kioku_edge_type_review") {
      return {
        updated: 0,
        edge_type: (echo && echo.edge_type) || "",
        status: (echo && echo.status) || 0,
        stub: false,
        echo,
      };
    }
    if (command === "shogun_kioku_backup_db") {
      return {
        source_path: "/mock/memory.db",
        dest_path: "/mock/memory.db.backup-2026-04-27-000000",
        bytes: 0,
        completed_at_ms: Date.now(),
        stub: true,
        echo,
      };
    }
    if (command === "shogun_kioku_stage5_dry_run") {
      return {
        generated_at_ms: Date.now(),
        soft_retire: {
          matching_rows: 0,
          already_retired: 0,
          oldest_created_at_ms: null,
          newest_created_at_ms: null,
          embedding_blob_count: 0,
        },
        ttl_expired: {
          rows_with_raw_to_clean: 0,
          raw_path_files_to_unlink: 0,
          raw_text_rows_to_null: 0,
        },
        physical_delete: { eligible_rows: 0, cascade_edges: 0, orphaned_summaries: 0 },
        storage: { db_size_before_bytes: 0, raw_path_bytes: 0 },
        legacy_sources: ["capture_sampler", "capture_ax"],
        grace_days: 30,
        stub: false,
        echo,
      };
    }
    if (command === "shogun_kioku_stage5_apply") {
      return {
        applied_at_ms: Date.now(),
        actions: { soft_retire: null, cleanup_ttl: null, physical_delete: null, vacuum: null },
        stub: false,
        echo,
      };
    }
    if (command === "shogun_kioku_debug_stats") {
      return {
        queue: {
          captures_pending: 0,
          captures_running: 0,
          captures_done: 0,
          captures_failed: 0,
          captures_expired: 0,
          captures_skipped: 0,
          jobs_queued: 0,
          jobs_running: 0,
          jobs_done: 0,
          jobs_failed: 0,
          jobs_expired: 0,
          oldest_pending_capture_ms: null,
        },
        cost: {
          month_start_ms: 0,
          spent_usd: 0,
          monthly_cap_usd: 10,
          cap_action: "pause_extraction",
          fallback_model: "claude-haiku-4-5",
          extraction_model: "claude-haiku-4-5",
          status: "Proceed",
        },
        graph: {
          mem_items_total: 0,
          mem_items_active: 0,
          mem_items_retired: 0,
          edges_total: 0,
          edges_active: 0,
          captures_total: 0,
          by_node_kind: [],
          by_edge_type: [],
        },
        rules: { count: 0, titles: [] },
        flags: {
          read_path: "legacy",
          capture_to_mem_captures: false,
          worker_enabled: false,
        },
        now_ms: Date.now(),
        stub: false,
        echo,
      };
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
      case "shogun_google_calendar_sync":
      case "shogun_gmail_sync": {
        const C = global.ShogunIntegrationConnectors;
        if (C && typeof C.mockIntegrationPayload === "function") {
          const payload = C.mockIntegrationPayload(command, echo);
          if (payload) return payload;
        }
        return notImpl("Integration mock unavailable.", echo);
      }
      case "shogun_draft": {
        const asb = buildMemoryAssemblyBlock(echo && echo.memoryAssembly);
        let memNote = "";
        if (asb) {
          memNote =
            "\n\n_Local Memory context (assembled)_\n\n" +
            asb.text +
            "\n";
        }
        return {
          content:
            "# Draft\n\n_Mock Markdown from browser transport. Tauri uses your LLM key._\n" + memNote,
          title: echo.target ? `Draft · ${echo.target}` : "Draft",
          stub: false,
          echo: echo,
        };
      }
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
      case "shogun_draft_reply": {
        const emailFmt =
          echo &&
          (echo.format === "email" || echo.draftKind === "email" || echo.channel === "email");
        const src = String((echo && echo.sourceText) || "").trim();
        const meetTitle = String((echo && echo.meetingTitle) || "Meeting").trim();
        const content = emailFmt
          ? `# 件名: ${meetTitle} · フォローアップ\n\nチームの皆様\n\n先ほどの打ち合わせの共有です。下記メモをベースにご確認ください。\n\n---\n\n${src || "（本文なし）"}\n\n---\n\n_Desktop + API キーで本番の下書き生成に接続されます。_`
          : "# Draft reply (browser mock)\n\nUse Tauri + LLM key for Brief-aware drafts.\n";
        return {
          ok: true,
          data: {
            content,
            title: emailFmt ? `Email draft · ${meetTitle}` : "Reply draft · mock",
            stub: false,
            echo: echo,
          },
        };
      }
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
        const q = String((echo && echo.query) || "");
        const semantic = !!(echo && echo.semantic);
        const result = searchMemoryIndex(q, echo && echo.limit, semantic);
        return {
          hits: result.hits,
          total: result.total,
          semanticRerank: semantic,
          echo: echo,
          stub: false,
        };
      }
      case "shogun_memory_fetch":
        return {
          items: readMemoryIndex().map((h, i) => normalizeMemoryHit(h, "mock-fetch-" + i)),
          echo: echo,
          stub: false,
        };
      case "shogun_memory_ingest":
        {
          const cur = readMemoryIndex().map((h, i) => normalizeMemoryHit(h, "mock-cur-" + i));
          const id = String((echo && echo.id) || ("mock-" + Date.now()));
          const item = normalizeMemoryHit(
            {
              id: id,
              title: (echo && echo.title) || "Quick memory",
              snippet: (echo && echo.snippet) || "",
              source: (echo && echo.source) || "note",
              provenance: (echo && echo.provenance) || (echo && echo.source) || "note",
              kinds: echo && echo.kinds,
              entity_id: echo && echo.entity_id,
              ts: nowIso(),
            },
            id,
          );
          cur.unshift(item);
          writeMemoryIndex(cur);
        }
        return {
          ingested: true,
          echo: echo,
          stub: false,
        };
      case "shogun_memory_delete":
        {
          const id = String((echo && echo.id) || "").trim();
          if (id) {
            const cur = readMemoryIndex().map((h, i) => normalizeMemoryHit(h, "mock-del-" + i));
            const next = cur.filter((h) => String(h.id) !== id);
            writeMemoryIndex(next);
          }
        }
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
      case "shogun_memory_debug_gate":
        return { available: false, reason: "mock_browser" };
      case "shogun_memory_debug_recent_calls":
        return { calls: [], capacity: 50 };
      case "shogun_memory_debug_query":
        return {
          hits: [],
          draft_block: "",
          brief_block: "",
          reply_block: "",
          query: (echo && echo.query) || "",
          limit: (echo && echo.limit) || 12,
          semantic: !!(echo && echo.semantic),
        };
      case "shogun_memory_debug_stats":
        return {
          total: 0,
          fts_total: 0,
          fts_integrity: true,
          by_source: [],
          by_provenance: [],
          earliest_ms: null,
          latest_ms: null,
          db_bytes: 0,
        };
      case "shogun_memory_debug_sync_status":
        return {
          google_calendar: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
          gmail: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
        };
      case "shogun_memory_summary_get":
        return {
          summary: {
            targetKind: "item",
            targetId: String((echo && echo.targetId) || "m_stub"),
            title: "Stub summary",
            keyPoints: ["This is a mocked summary"],
            sourceType: "mail",
            priority: "medium",
            reason: "mock",
            model: "mock",
            schemaVersion: 1,
            generatedAt: Date.now(),
          },
          cached: false,
        };
      case "shogun_memory_summary_batch":
        return {
          ok: ((echo && echo.items) || []).map((it) => ({
            targetKind: "item",
            targetId: String((it && it.id) || "m_stub"),
            title: `Stub: ${(it && it.title) || "untitled"}`,
            keyPoints: ["mock point"],
            sourceType: "mail",
            priority: "medium",
            reason: "mock",
            model: "mock",
            schemaVersion: 1,
            generatedAt: Date.now(),
          })),
          failed: [],
          heuristicUsed: 0,
        };
      case "shogun_memory_summary_invalidate":
        return { deleted: true };
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
        const liveTotal = readMemoryIndex().length;
        base.memoryTotal = liveTotal;
        base.memories = String(liveTotal);
        return base;
      }
      case "shogun_chat_complete": {
        const msgs = (echo && echo.messages) || [];
        const last = msgs[msgs.length - 1];
        const userText =
          last && last.role === "user" ? String(last.content || "") : "";
        const preview = userText.length > 120 ? userText.slice(0, 120) + "…" : userText;
        const ws =
          echo && echo.webSearch
            ? "\n\n[Web research mode: on — desktop app adds a system hint; live browse still requires a search API or pasted URLs.]"
            : "";
        let ma = "";
        const asb = buildMemoryAssemblyBlock(echo && echo.memoryAssembly);
        if (asb) {
          ma =
            "\n\n[Local Memory context assembled]\n" +
            asb.text +
            "\n\n(query: " +
            JSON.stringify(asb.query.slice(0, 100)) +
            ", limit: " +
            asb.limit +
            ", semantic: " +
            asb.semantic +
            ", hits: " +
            asb.total +
            ")";
        }
        return {
          message:
            "[Demo — set an API key in the desktop app for real completions.]\n\nYou asked: " +
            (preview || "(empty)") +
            "\n\nFor **Kitazawa / Aurora**, a sensible next step is to pin the beta scope (DPIA + onboarding) and keep investor slides to three proof points until metrics land." +
            ws +
            ma,
          memoryAssembly: asb
            ? {
                query: asb.query,
                limit: asb.limit,
                semantic: asb.semantic,
                total: asb.total,
                hits: asb.hits,
              }
            : null,
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
      case "app_create_share_link": {
        const mode = (echo && echo.mode) || "private";
        const rt = echo && echo.resourceType;
        let url = null;
        let shareId = null;
        const origin =
          typeof global.window !== "undefined" &&
          global.window.location &&
          global.window.location.origin
            ? global.window.location.origin
            : "https://shogun.app";
        if (rt === "meeting_note" && echo && echo.storageKey) {
          const raw = String(echo.storageKey).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48);
          shareId = raw || "mtg-local";
          const access = mode === "public" ? "view" : "restricted";
          url = `${origin}/share/mtg/${encodeURIComponent(shareId)}?access=${access}`;
        } else if (echo && echo.chatId != null) {
          shareId = "chat-" + String(echo.chatId);
          url = `${origin}/share/chat/${encodeURIComponent(shareId)}`;
        }
        return {
          exported: true,
          path: "/mock/shogun-share-export.md",
          url: url || undefined,
          shareId: shareId || undefined,
          stub: false,
          echo: echo,
        };
      }
      case "app_settings_load":
        return {
          settings: { sections: readMockSettingsSections() },
          echo: echo,
          stub: false,
        };
      case "legal_docs_load":
        // Stub markdown so the consent modal renders in browser/E2E mode.
        // The Tauri build reads real bundled docs in src-tauri/legal_docs.rs.
        return {
          terms:
            "# Terms of Service\n\nMock terms for browser preview and tests.\n",
          privacy:
            "# Privacy Policy\n\nMock privacy policy for browser preview and tests.\n",
          lang: (echo && echo.lang) || "en",
          stub: true,
          echo: echo,
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
      case "app_privacy_pick_app":
        return {
          cancelled: true,
          stub: false,
          note: "Native .app picker is available in the macOS desktop build.",
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
      case "app_frontend_error_report":
        return { logged: true, stub: false, echo: echo };
      case "app_updates_check":
        return { available: false, stub: true, echo: echo };
      case "app_updates_download_install":
        return { installed: true, stub: true, echo: echo };
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
      case "shogun_meeting_enhance": {
        const notes = String((echo && echo.notes) || "").trim();
        const tx = String((echo && echo.transcript) || "").trim();
        const title = String((echo && echo.title) || "Meeting").trim();
        const minutesMarkdown = [
          "## AI 議事録（Hi-Fi モック）",
          "",
          "### 要約",
          "録音の文字起こしとあなたのメモを統合したドラフトです。デスクトップアプリではモデルが本番生成します。",
          "",
          "### メモより",
          notes ? notes.slice(0, 1200) : "（メモなし）",
          "",
          "### 文字起こしより",
          tx ? tx.slice(0, 2000) : "（文字起こしなし — 録音を反映すると精度が上がります）",
          "",
          "### 次のアクション",
          "- [ ] フォローアップを確認",
          "",
          "_Meeting: " + title + "_",
        ].join("\n");
        return {
          minutesMarkdown: minutesMarkdown,
          stub: true,
          echo: echo,
        };
      }
      case "shogun_oauth_google_start": {
        // Mock: simulate a successful in-app OAuth flow without the actual
        // browser round-trip. Real backend launches a localhost server +
        // system browser; the mock just returns metadata immediately.
        return {
          ok: true,
          provider: (echo && echo.provider) || "gmail",
          scopes: [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/calendar.readonly",
          ],
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          refreshTokenPresent: true,
        };
      }
      case "shogun_memory_export":
        return { exported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
      case "shogun_memory_import": {
        // Mirrors `src-tauri/src/memory_export.rs::CONFIRM_TOKEN`.
        const confirmToken = (global.ShogunMemoryExport && global.ShogunMemoryExport.CONFIRM_TOKEN) || "REPLACE";
        if ((echo && echo.confirm) !== confirmToken) {
          throw createError(
            "INVALID_INPUT",
            `import requires explicit ${confirmToken} confirmation`,
          );
        }
        return { imported: 0, path: "/mock/memory.shogun-memory.jsonl", stub: true, echo };
      }
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
    const autoTransport = hasTauriInvoke() ? "tauri" : (readHttpBackendBase() ? "http" : "mock");
    const transport = opts.transport || autoTransport;

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
          : transport === "http"
            ? await withTimeout(httpTransport(command, payload, perTimeoutMs), perTimeoutMs)
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

  // Desktop Tauri runtime: listen for tray-driven capture state changes and
  // dispatch a custom DOM event so any open Settings UI can re-read the toggle.
  // In mock / browser mode __TAURI_INTERNALS__ is absent so this is a no-op.
  if (global.__TAURI_INTERNALS__) {
    import("@tauri-apps/api/event").then(function (mod) {
      mod.listen("shogun-capture-state-changed", function () {
        try {
          global.dispatchEvent(new CustomEvent("shogun-settings-refresh"));
        } catch (_) {
          /* ignore */
        }
      });
    }).catch(function () {
      /* ignore — Tauri APIs may not be available in all build targets */
    });
  }

  global.ShogunIpcClient = { createIpcClient: createIpcClient };
})(window);
