// Mock IPC transport + ensureRuntimeDeps extracted from App.tsx (Phase 2 Step 11)

/** Fallback when `ipc-client.js` is absent — keep in sync with `hifi/lib/ipc-client.js` mockTransport. */
export function mockIpcInvoke(command: string, payload: any): any {
  const echo = payload || {};
  const MOCK_SETTINGS_LS = 'shogun.hifi.mock.settings.sections.v1';
  const MOCK_LLM_KEY_LS = 'shogun.hifi.mock.llm.keyConfigured.v1';
  function readMockSettingsSections(): any {
    try {
      if (typeof localStorage === 'undefined') return {};
      const raw = localStorage.getItem(MOCK_SETTINGS_LS);
      if (!raw) return {};
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return {};
      if (Object.prototype.hasOwnProperty.call(o, 'subscription')) {
        const { subscription: _legacySubscription, ...rest } = o;
        try {
          localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(rest));
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
  function mergeMockSettingsSection(section: string, patch: any): void {
    try {
      if (typeof localStorage === 'undefined' || !section || typeof patch !== 'object') return;
      const sections = readMockSettingsSections();
      const prev = sections[section] && typeof sections[section] === 'object' ? sections[section] : {};
      sections[section] = { ...prev, ...patch };
      localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(sections));
    } catch (_) {
      /* ignore */
    }
  }
  function readMockLlmKeyConfigured(): boolean {
    try {
      if (typeof localStorage === 'undefined') return false;
      return localStorage.getItem(MOCK_LLM_KEY_LS) === '1';
    } catch (_) {
      return false;
    }
  }
  function writeMockLlmKeyConfigured(on: boolean): void {
    try {
      if (typeof localStorage === 'undefined') return;
      if (on) localStorage.setItem(MOCK_LLM_KEY_LS, '1');
      else localStorage.removeItem(MOCK_LLM_KEY_LS);
    } catch (_) {
      /* ignore */
    }
  }
  const notImpl = (message: string) => ({
    ok: true,
    data: { notImplemented: true, message, stub: false, echo },
  });
  switch (command) {
    case 'app_integration_connect':
    case 'app_integration_toggle':
    case 'app_integration_import_credentials':
    case 'app_integration_credentials_status':
    case 'shogun_google_calendar_sync':
    case 'shogun_gmail_sync': {
      const C = typeof window !== 'undefined' && (window as any).ShogunIntegrationConnectors;
      if (C && typeof C.mockIntegrationPayload === 'function') {
        const p = C.mockIntegrationPayload(command, echo);
        if (p) return { ok: true, data: p };
      }
      return notImpl('Integration mock unavailable.');
    }
    case 'shogun_oauth_google_start':
      return { ok: true, data: {
        ok: true,
        provider: echo?.provider || 'gmail',
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        refreshTokenPresent: true,
      } };
    case 'shogun_draft': {
      const mas = echo && echo.memoryAssembly;
      let memNote = '';
      if (mas && typeof mas === 'object') {
        const q = String(mas.query || '').trim();
        memNote =
          '\n\n_memoryAssembly (mock): desktop injects local hits — query ' +
          JSON.stringify(q.slice(0, 100)) +
          '._\n';
      }
      return {
        ok: true,
        data: {
          content: '# Draft\n\n_Mock Markdown (fallback mock)._' + memNote,
          title: echo.target ? `Draft · ${echo.target}` : 'Draft',
          stub: false,
          echo,
        },
      };
    }
    case 'shogun_schedule_action':
      return { ok: true, data: { scheduled: true, id: 'sch-mock', stub: false, echo } };
    case 'shogun_open_pack':
      return {
        ok: true,
        data: {
          opened: true,
          path: '(browser mock) ~/Library/Application Support/.../packs/example',
          stub: false,
          echo,
        },
      };
    case 'shogun_start_focus_session':
      return {
        ok: true,
        data: {
          started: true,
          ends_at_ms: Date.now() + 25 * 60 * 1000,
          state_path: '(browser mock) active_focus.json',
          focus_markdown: '(browser mock) FOCUS.md',
          stub: false,
          echo,
        },
      };
    case 'shogun_draft_reply': {
      const emailFmt =
        echo &&
        (echo.format === 'email' || echo.draftKind === 'email' || echo.channel === 'email');
      const src = String((echo && echo.sourceText) || '').trim();
      const meetTitle = String((echo && echo.meetingTitle) || 'Meeting').trim();
      const content = emailFmt
        ? `# 件名: ${meetTitle} · フォローアップ\n\nチームの皆様\n\n先ほどの打ち合わせの共有です。下記メモをベースにご確認ください。\n\n---\n\n${src || '（本文なし）'}\n\n---\n\n_Desktop + API キーで本番の下書き生成に接続されます。_`
        : '# Draft reply (browser mock)\n\n_Use the desktop app with an LLM API key for a real draft from your Brief + Memory._\n';
      return {
        ok: true,
        data: {
          content,
          title: emailFmt ? `Email draft · ${meetTitle}` : 'Reply draft · mock',
          stub: false,
          echo,
        },
      };
    }
    case 'app_capture_pause':
      return {
        ok: true,
        data: {
          paused: true,
          honestPreferenceOnly: true,
          message:
            'Capture sampling paused. No new focus events will be recorded until you resume.',
          stub: false,
          echo,
        },
      };
    case 'app_capture_resume':
      return {
        ok: true,
        data: {
          paused: false,
          honestPreferenceOnly: true,
          message:
            'Capture sampling resumed. On macOS, frontmost app is sampled periodically into memory (no screenshots).',
          stub: false,
          echo,
        },
      };
    case 'app_settings_load':
      return {
        ok: true,
        data: {
          settings: { sections: readMockSettingsSections() },
          stub: false,
          echo,
        },
      };
    case 'legal_docs_load':
      // Mirrors the case in ipc-client.js so the two mock IPC paths stay
      // in sync (enforced by check:ipc-mock).
      return {
        ok: true,
        data: {
          terms:
            '# Terms of Service\n\nMock terms for browser preview and tests.\n',
          privacy:
            '# Privacy Policy\n\nMock privacy policy for browser preview and tests.\n',
          lang: (echo && echo.lang) || 'en',
          stub: true,
          echo,
        },
      };
    case 'app_settings_save': {
      if (echo && echo.section) {
        const section = echo.section;
        const { section: _sec, ...rest } = echo;
        mergeMockSettingsSection(section, rest);
      }
      return { ok: true, data: { saved: true, stub: false, echo } };
    }
    case 'shogun_memory_search': {
      const DEMO = typeof window !== 'undefined' ? (window as any).SHOGUN_DEMO_SEED : null;
      if (!DEMO || !Array.isArray(DEMO.memoryHits)) {
        return { ok: true, data: { hits: [], total: 0, echo, stub: false } };
      }
      let hits = DEMO.memoryHits.slice();
      const q = String((echo && echo.query) || '')
        .trim()
        .toLowerCase();
      if (q) {
        hits = hits.filter((h: any) =>
          `${h.title || ''} ${h.snippet || ''}`.toLowerCase().includes(q),
        );
      }
      const limit = Math.min(80, Math.max(1, Number(echo.limit) || 40));
      return {
        ok: true,
        data: {
          hits: hits.slice(0, limit),
          total: hits.length,
          semanticRerank: !!(echo && echo.semantic),
          stub: false,
          echo,
        },
      };
    }
    case 'shogun_memory_ingest':
      return { ok: true, data: { ingested: true, stub: false, echo } };
    case 'shogun_memory_delete':
      return { ok: true, data: { deleted: true, stub: false, echo } };
    case 'shogun_memory_fetch':
      return {
        ok: true,
        data: {
          items: [],
          stub: false,
          echo,
        },
      };
    case 'shogun_memory_summary_get':
      return {
        ok: true,
        data: {
          summary: {
            targetKind: 'item',
            targetId: String((echo && echo.targetId) || 'm_stub'),
            title: 'Stub summary',
            keyPoints: ['This is a mocked summary'],
            sourceType: 'mail',
            priority: 'medium',
            reason: 'mock',
            model: 'mock',
            schemaVersion: 1,
            generatedAt: Date.now(),
          },
          cached: false,
        },
      };
    case 'shogun_memory_summary_batch':
      return {
        ok: true,
        data: {
          ok: ((echo && echo.items) || []).map((it: any) => ({
            targetKind: 'item',
            targetId: String((it && it.id) || 'm_stub'),
            title: `Stub: ${(it && it.title) || 'untitled'}`,
            keyPoints: ['mock point'],
            sourceType: 'mail',
            priority: 'medium',
            reason: 'mock',
            model: 'mock',
            schemaVersion: 1,
            generatedAt: Date.now(),
          })),
          failed: [],
          heuristicUsed: 0,
        },
      };
    case 'shogun_memory_summary_invalidate':
      return { ok: true, data: { deleted: true } };
    case 'shogun_memory_debug_gate':
      return { ok: true, data: { available: false, reason: 'mock_browser' } };
    case 'shogun_memory_debug_recent_calls':
      return { ok: true, data: { calls: [], capacity: 50 } };
    case 'shogun_memory_debug_query':
      return {
        ok: true,
        data: {
          hits: [],
          draft_block: '',
          brief_block: '',
          reply_block: '',
          query: (echo && echo.query) || '',
          limit: (echo && echo.limit) || 12,
          semantic: !!(echo && echo.semantic),
        },
      };
    case 'shogun_memory_debug_stats':
      return {
        ok: true,
        data: {
          total: 0,
          fts_total: 0,
          fts_integrity: true,
          by_source: [],
          by_provenance: [],
          earliest_ms: null,
          latest_ms: null,
          db_bytes: 0,
        },
      };
    case 'shogun_memory_debug_sync_status':
      return {
        ok: true,
        data: {
          google_calendar: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
          gmail: { last_sync_ms: null, last_ingested: null, last_error: null, last_duration_ms: null, credentials_present: false, auto_enabled: false },
        },
      };
    case 'shogun_stats': {
      const DEMO = typeof window !== 'undefined' ? (window as any).SHOGUN_DEMO_SEED : null;
      const empty: any = {
        eventsToday: '0',
        memoriesToday: '0',
        memoryTotal: 0,
        memoriesLast24h: 0,
        memories: '0',
        disk: '0 B',
        historyDays: '0 days',
        usagePercent: 0,
        appCoverage: [],
        echo,
        stub: false,
      };
      const base: any =
        DEMO && DEMO.stats && typeof DEMO.stats === 'object'
          ? Object.assign({}, DEMO.stats, { echo, stub: false })
          : empty;
      if (echo && echo.stage === 'capture') {
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
      if (echo && echo.section === 'storage') {
        base.memories = base.memories || String(base.memoryTotal || 0);
      }
      return { ok: true, data: base };
    }
    case 'shogun_chat_complete': {
      const msgs = (echo && echo.messages) || [];
      const last = msgs[msgs.length - 1];
      const userText = last && last.role === 'user' ? String(last.content || '') : '';
      const preview = userText.length > 120 ? userText.slice(0, 120) + '…' : userText;
      const ws = echo && echo.webSearch ? '\n\n[Web research mode: on — real builds add a system hint to the model; still no live browse without an API.]' : '';
      let ma = '';
      const mas = echo && echo.memoryAssembly;
      if (mas && typeof mas === 'object') {
        const q = String(mas.query || '').trim();
        const lim = mas.limit != null ? Number(mas.limit) : 12;
        const sem = !!mas.semantic;
        ma =
          '\n\n[memoryAssembly — mock: desktop would attach local Memory (query ' +
          JSON.stringify(q.slice(0, 100)) +
          ', limit ' +
          lim +
          ', semantic ' +
          sem +
          ').]';
      }
      return {
        ok: true,
        data: {
          message:
            '[Demo — set an API key in the desktop app for real completions.]\n\nYou asked: ' +
            (preview || '(empty)') +
            '\n\n_Mock reply (fallback transport)._' +
            ws +
            ma,
          stub: false,
          echo,
        },
      };
    }
    case 'shogun_brief_get':
      return {
        ok: true,
        data: {
          skipped: true,
          brief: null,
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_brief_signals':
      return {
        ok: true,
        data: {
          decision_graph_hits: [],
          related_kioku_hits: [],
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_edge_type_proposals':
      return {
        ok: true,
        data: {
          proposals: [],
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_edge_type_review':
      return {
        ok: true,
        data: {
          updated: 0,
          edge_type: (echo && echo.edge_type) || '',
          status: (echo && echo.status) || 0,
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_backup_db':
      return {
        ok: true,
        data: {
          source_path: '/mock/memory.db',
          dest_path: '/mock/memory.db.backup-2026-04-27-000000',
          bytes: 0,
          completed_at_ms: Date.now(),
          stub: true,
          echo,
        },
      };
    case 'shogun_kioku_stage5_dry_run':
      return {
        ok: true,
        data: {
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
          legacy_sources: ['capture_sampler', 'capture_ax'],
          grace_days: 30,
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_stage5_apply':
      return {
        ok: true,
        data: {
          applied_at_ms: Date.now(),
          actions: { soft_retire: null, cleanup_ttl: null, physical_delete: null, vacuum: null },
          stub: false,
          echo,
        },
      };
    case 'shogun_kioku_debug_stats':
      return {
        ok: true,
        data: {
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
            cap_action: 'pause_extraction',
            fallback_model: 'claude-haiku-4-5',
            extraction_model: 'claude-haiku-4-5',
            status: 'Proceed',
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
          flags: { read_path: 'legacy', capture_to_mem_captures: false, worker_enabled: false },
          now_ms: Date.now(),
          stub: false,
          echo,
        },
      };
    case 'app_open_hummingbird':
      return { ok: true, data: { opened: true, stub: false, echo } };
    case 'app_create_share_link': {
      const mode = (echo && echo.mode) || 'private';
      const rt = echo && echo.resourceType;
      let url: string | null = null;
      let shareId: string | null = null;
      const origin =
        typeof window !== 'undefined' && window.location && window.location.origin
          ? window.location.origin
          : 'https://shogun.app';
      if (rt === 'meeting_note' && echo && echo.storageKey) {
        const raw = String(echo.storageKey).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
        shareId = raw || 'mtg-local';
        const access = mode === 'public' ? 'view' : 'restricted';
        url = `${origin}/share/mtg/${encodeURIComponent(shareId)}?access=${access}`;
      } else if (echo && echo.chatId != null) {
        shareId = 'chat-' + String(echo.chatId);
        url = `${origin}/share/chat/${encodeURIComponent(shareId)}`;
      }
      return {
        ok: true,
        data: {
          exported: true,
          path: '/mock/shogun-share-export.md',
          url: url || undefined,
          shareId: shareId || undefined,
          stub: false,
          echo,
        },
      };
    }
    case 'app_permissions_manage':
      return {
        ok: true,
        data: {
          opened: true,
          note: 'Opened System Settings (Screen Recording) when supported.',
          stub: false,
          echo,
        },
      };
    case 'app_privacy_pick_app':
      return {
        ok: true,
        data: {
          cancelled: true,
          stub: false,
          note: 'Native .app picker is available in the macOS desktop build.',
          echo,
        },
      };
    case 'app_diagnostics_report':
      return {
        ok: true,
        data: {
          reportId: 'diag-mock',
          path: '/mock/diagnostics.json',
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
          echo,
        },
      };
    case 'app_frontend_error_report':
      return { ok: true, data: { logged: true, stub: false, echo } };
    case 'app_updates_check':
      return { ok: true, data: { available: false, stub: true, echo } };
    case 'app_updates_download_install':
      return { ok: true, data: { installed: true, stub: true, echo } };
    case 'app_delete_data_range':
      return {
        ok: true,
        data: { deleted: true, range: echo.range || '', stub: false, echo },
      };
    case 'app_delete_all_data':
      return { ok: true, data: { deleted: true, stub: false, echo } };
    case 'app_delete_account':
      return {
        ok: true,
        data: {
          deleted: true,
          note: 'Local data cleared. No cloud account is associated with this build.',
          stub: false,
          echo,
        },
      };
    case 'app_llm_api_key_set': {
      const hasKey = String((echo && echo.apiKey) || '').trim().length > 0;
      writeMockLlmKeyConfigured(hasKey);
      return { ok: true, data: { saved: true, stub: false, echo } };
    }
    case 'app_llm_api_key_status':
      return {
        ok: true,
        data: {
          configured: readMockLlmKeyConfigured(),
          stub: false,
          echo,
        },
      };
    case 'app_llm_api_key_clear':
      writeMockLlmKeyConfigured(false);
      return { ok: true, data: { cleared: true, echo, stub: false } };
    case 'shogun_entity_query': {
      const DEMO = typeof window !== 'undefined' ? (window as any).SHOGUN_DEMO_SEED : null;
      return {
        ok: true,
        data: {
          entities: DEMO && Array.isArray(DEMO.entities) ? DEMO.entities : [],
          echo,
          stub: false,
        },
      };
    }
    case 'auth_clerk_config':
      return {
        ok: true,
        data: {
          enabled: false,
          publishableKey: '',
          frontendApi: '',
          clerkJsUrl: '',
          redirectUrl: 'shogun-ai://clerk-callback',
          stub: true,
          echo,
        },
      };
    case 'auth_open_browser_sign_in':
    case 'auth_open_browser_sign_up':
      return {
        ok: true,
        data: {
          opened: true,
          stub: true,
          message: 'Browser sign-in requires the Tauri desktop app with CLERK_* env set.',
          echo,
        },
      };
    case 'auth_status':
      return {
        ok: true,
        data: {
          clerk: {
            enabled: false,
            publishableKey: '',
            frontendApi: '',
            clerkJsUrl: '',
            redirectUrl: 'shogun-ai://clerk-callback',
          },
          snapshot: null,
          stub: true,
          echo,
        },
      };
    case 'auth_session_save':
      return { ok: true, data: { saved: true, stub: true, echo } };
    case 'auth_sign_out':
      return { ok: true, data: { signedOut: true, stub: true, echo } };
    case 'auth_biometric_status':
      return {
        ok: true,
        data: {
          supported: false,
          enrolled: false,
          platform: 'mock',
          biometryType: 'none',
          stub: true,
          echo,
        },
      };
    case 'auth_biometric_authenticate':
      return { ok: true, data: { ok: true, stub: true, echo } };
    case 'shogun_meeting_enhance': {
      const notes = String((echo && echo.notes) || '').trim();
      const tx = String((echo && echo.transcript) || '').trim();
      const title = String((echo && echo.title) || 'Meeting').trim();
      const minutesMarkdown = [
        '## AI 議事録（Hi-Fi モック）',
        '',
        '### 要約',
        '録音の文字起こしとあなたのメモを統合したドラフトです。デスクトップアプリではモデルが本番生成します。',
        '',
        '### メモより',
        notes ? notes.slice(0, 1200) : '（メモなし）',
        '',
        '### 文字起こしより',
        tx ? tx.slice(0, 2000) : '（文字起こしなし — 録音を反映すると精度が上がります）',
        '',
        '### 次のアクション',
        '- [ ] フォローアップを確認',
        '',
        '_Meeting: ' + title + '_',
      ].join('\n');
      return {
        ok: true,
        data: {
          minutesMarkdown,
          stub: true,
          echo,
        },
      };
    }
    case 'shogun_memory_embed_backfill': {
      const lim = echo && echo.limit != null ? Number(echo.limit) : 40;
      const clamped = Number.isFinite(lim) ? Math.min(200, Math.max(1, Math.floor(lim))) : 40;
      return {
        ok: true,
        data: {
          embedded: 0,
          failed: 0,
          remaining: 0,
          attempted: clamped,
          cancelled: false,
          stub: false,
          echo,
        },
      };
    }
    case 'shogun_memory_embed_backfill_cancel':
      return {
        ok: true,
        data: {
          requested: true,
          stub: false,
          echo,
        },
      };
    case 'shogun_memory_export':
      return {
        ok: true,
        data: { exported: 0, path: '/mock/memory.shogun-memory.jsonl', stub: true, echo },
      };
    case 'shogun_memory_import': {
      // Mirrors `src-tauri/src/memory_export.rs::CONFIRM_TOKEN`.
      const confirmToken =
        (typeof window !== 'undefined' && (window as any).ShogunMemoryExport && (window as any).ShogunMemoryExport.CONFIRM_TOKEN)
        || 'REPLACE';
      if ((echo && echo.confirm) !== confirmToken) {
        return {
          ok: false,
          error: { code: 'INVALID_INPUT', message: `import requires explicit ${confirmToken} confirmation` },
        };
      }
      return {
        ok: true,
        data: { imported: 0, path: '/mock/memory.shogun-memory.jsonl', stub: true, echo },
      };
    }
    case 'mirror_register':
      return { ok: true, data: { device_id: 'mock_device_id_stub', stub: true } };
    case 'mirror_unlock':
      return { ok: true, data: { stub: true } };
    case 'mirror_status':
      return { ok: true, data: { enabled: false, queue_depth: 0, last_sync_at: null, last_error: null, locked: true, device_id: null, stub: true } };
    case 'mirror_sync_now':
      return { ok: true, data: { synced_count: 0, stub: true } };
    case 'mirror_disable':
      return { ok: true, data: { stub: true } };
    case 'mirror_reset_stuck':
      return { ok: true, data: { reset: 0, stub: true } };
    default:
      return { ok: true, data: { command, payload: echo, mock: true } };
  }
}

export function ensureRuntimeDeps(): void {
  const w = window as any;
  if (!w.ShogunIpcClient) {
    w.ShogunIpcClient = {
      createIpcClient: () => ({
        transport: 'mock',
        invoke: async (command: string, payload: any) => mockIpcInvoke(command, payload),
      }),
    };
  }
  if (!w.ShogunAPI) {
    w.ShogunAPI = {
      createApi: (client: any) => ({
        appOpenHummingbird: (input: any) => client.invoke('app_open_hummingbird', input),
        appCreateShareLink: (input: any) => client.invoke('app_create_share_link', input),
        settingsLoad: (input: any) => client.invoke('app_settings_load', input),
        settingsSave: (input: any) => client.invoke('app_settings_save', input),
        settingsExport: (input: any) => client.invoke('app_settings_export', input || {}),
        settingsImport: (input: any) => client.invoke('app_settings_import', input || {}),
        deadLetterList: (input: any) => client.invoke('shogun_dead_letter_list', input || {}),
        deadLetterRetry: (input: any) => client.invoke('shogun_dead_letter_retry', input || {}),
        deadLetterClear: (input: any) => client.invoke('shogun_dead_letter_clear', input || {}),
        deadLetterRetryOne: (input: any) => client.invoke('shogun_dead_letter_retry_one', input || {}),
        deadLetterDelete: (input: any) => client.invoke('shogun_dead_letter_delete', input || {}),
        integrationConnect: (input: any) => client.invoke('app_integration_connect', input),
        oauthGoogleStart: (input: any) => client.invoke('shogun_oauth_google_start', input),
        integrationImportCredentials: (input: any) =>
          client.invoke('app_integration_import_credentials', input),
        integrationCredentialsStatus: (input: any) =>
          client.invoke('app_integration_credentials_status', input),
        integrationToggle: (input: any) => client.invoke('app_integration_toggle', input),
        googleCalendarSync: (input: any) => client.invoke('shogun_google_calendar_sync', input),
        gmailSync: (input: any) => client.invoke('shogun_gmail_sync', input),
        slackSync: (input: any) => client.invoke('shogun_slack_sync', input),
        notionSync: (input: any) => client.invoke('shogun_notion_sync', input),
        githubSync: (input: any) => client.invoke('shogun_github_sync', input),
        linearSync: (input: any) => client.invoke('shogun_linear_sync', input),
        driveSync: (input: any) => client.invoke('shogun_drive_sync', input),
        zoomSync: (input: any) => client.invoke('shogun_zoom_sync', input),
        capturePause: (input: any) => client.invoke('app_capture_pause', input),
        captureResume: (input: any) => client.invoke('app_capture_resume', input),
        permissionsManage: (input: any) => client.invoke('app_permissions_manage', input),
        privacyPickApp: (input: any) => client.invoke('app_privacy_pick_app', input || {}),
        diagnosticsReport: (input: any) => client.invoke('app_diagnostics_report', input),
        updatesCheck: (input: any) => client.invoke('app_updates_check', input),
        updatesDownloadInstall: (input: any) => client.invoke('app_updates_download_install', input),
        frontendErrorReport: (input: any) => client.invoke('app_frontend_error_report', input),
        accountDeleteData: (input: any) => client.invoke('app_delete_data_range', input),
        accountDeleteAll: (input: any) => client.invoke('app_delete_all_data', input),
        accountDeleteSelf: (input: any) => client.invoke('app_delete_account', input),
        memorySearch: (input: any) => client.invoke('shogun_memory_search', input),
        memoryFetch: (input: any) => client.invoke('shogun_memory_fetch', input),
        memoryIngest: (input: any) => client.invoke('shogun_memory_ingest', input),
        memoryDelete: (input: any) => client.invoke('shogun_memory_delete', input),
        memorySummaryGet: (input: any) => client.invoke('shogun_memory_summary_get', input),
        memorySummaryBatch: (input: any) => client.invoke('shogun_memory_summary_batch', input),
        memorySummaryInvalidate: (input: any) => client.invoke('shogun_memory_summary_invalidate', input),
        memoryEmbedBackfill: (input: any) =>
          client.invoke('shogun_memory_embed_backfill', input, { timeoutMs: 600000 }),
        memoryEmbedBackfillCancel: (input: any) =>
          client.invoke('shogun_memory_embed_backfill_cancel', input || {}),
        entityQuery: (input: any) => client.invoke('shogun_entity_query', input),
        briefGet: (input: any) => client.invoke('shogun_brief_get', input),
        openPack: (input: any) => client.invoke('shogun_open_pack', input),
        startFocusSession: (input: any) => client.invoke('shogun_start_focus_session', input),
        draftReply: (input: any) => client.invoke('shogun_draft_reply', input),
        chatComplete: (input: any) => client.invoke('shogun_chat_complete', input),
        statsGet: (input: any) => client.invoke('shogun_stats', input),
        draftCreate: (input: any) => client.invoke('shogun_draft', input),
        llmApiKeySet: (input: any) => client.invoke('app_llm_api_key_set', input),
        llmApiKeyStatus: (input: any) => client.invoke('app_llm_api_key_status', input),
        llmApiKeyClear: (input: any) => client.invoke('app_llm_api_key_clear', input),
        scheduleAction: (input: any) => client.invoke('shogun_schedule_action', input),
        meetingStart: (input: any) => client.invoke('shogun_meeting_start', input),
        meetingStop: (input: any) => client.invoke('shogun_meeting_stop', input),
        meetingNoteAppendBlock: (input: any) => client.invoke('shogun_meeting_note_append_block', input),
        meetingNoteEditBlock: (input: any) => client.invoke('shogun_meeting_note_edit_block', input),
        meetingNoteDeleteBlock: (input: any) => client.invoke('shogun_meeting_note_delete_block', input),
        meetingEnhance: (input: any) => client.invoke('shogun_meeting_enhance', input),
        meetingReEnhance: (input: any) => client.invoke('shogun_meeting_re_enhance', input),
        meetingTranscriptForBlock: (input: any) => client.invoke('shogun_meeting_transcript_for_block', input),
        meetingTranscriptLive: (input: any) => client.invoke('shogun_meeting_transcript_live', input),
        meetingPurge: (input: any) => client.invoke('shogun_meeting_purge', input),
        meetingList: (input: any) => client.invoke('shogun_meeting_list', input),
        meetingGet: (input: any) => client.invoke('shogun_meeting_get', input),
        meetingTranscriptGet: (input: any) => client.invoke('shogun_meeting_transcript_get', input),
        meetingNotesGet: (input: any) => client.invoke('shogun_meeting_notes_get', input),
        meetingsSearch: (input: any) => client.invoke('shogun_meetings_search', input),
        meetingRecipeRun: (input: any) => client.invoke('shogun_meeting_recipe_run', input),
        meetingTemplatesList: (input: any) => client.invoke('shogun_meeting_templates_list', input),
        meetingTranscriptPush: (input: any) => client.invoke('shogun_meeting_transcript_push', input),
        meetingAudioStatus: (input: any) => client.invoke('shogun_meeting_audio_status', input),
        meetingMicStart: (input: any) => client.invoke('shogun_meeting_mic_start', input),
        meetingMicStop: (input: any) => client.invoke('shogun_meeting_mic_stop', input),
        meetingTranscribePcm: (input: any) => client.invoke('shogun_meeting_transcribe_pcm', input),
        meetingMcpTools: (input: any) => client.invoke('shogun_meeting_mcp_tools', input),
        meetingImportPick: (input: any) => client.invoke('shogun_meeting_import_pick', input || {}),
        meetingImportFile: (input: any) => client.invoke('shogun_meeting_import_file', input),
      }),
    };
  }
  if (!w.ShogunActionRegistry) {
    w.ShogunActionRegistry = {
      createActionRegistry: (api: any) => {
        const map: Record<string, any> = {
          'app.open_hummingbird': api.appOpenHummingbird,
          'app.create_share_link': api.appCreateShareLink,
          'settings.save': api.settingsSave,
          'settings.load': api.settingsLoad,
          'settings.export': api.settingsExport,
          'settings.import': api.settingsImport,
          'dead_letter.list': api.deadLetterList,
          'dead_letter.retry': api.deadLetterRetry,
          'dead_letter.clear': api.deadLetterClear,
          'dead_letter.retry_one': api.deadLetterRetryOne,
          'dead_letter.delete': api.deadLetterDelete,
          'integrations.connect': api.integrationConnect,
          'oauth.google.start': api.oauthGoogleStart,
          'integrations.import_credentials': api.integrationImportCredentials,
          'integrations.credentials_status': api.integrationCredentialsStatus,
          'integrations.toggle': api.integrationToggle,
          'calendar.sync': api.googleCalendarSync,
          'gmail.sync': api.gmailSync,
          'slack.sync': api.slackSync,
          'notion.sync': api.notionSync,
          'github.sync': api.githubSync,
          'linear.sync': api.linearSync,
          'drive.sync': api.driveSync,
          'zoom.sync': api.zoomSync,
          'capture.pause': api.capturePause,
          'capture.resume': api.captureResume,
          'permissions.manage': api.permissionsManage,
          'privacy.pick_app': api.privacyPickApp,
          'diagnostics.report': api.diagnosticsReport,
          'updates.check': api.updatesCheck,
          'updates.download_install': api.updatesDownloadInstall,
          'data.delete_range': api.accountDeleteData,
          'data.delete_all': api.accountDeleteAll,
          'account.delete': api.accountDeleteSelf,
          'memory.search': api.memorySearch,
          'memory.fetch': api.memoryFetch,
          'memory.ingest': api.memoryIngest,
          'memory.delete': api.memoryDelete,
          'memory.embed_backfill': api.memoryEmbedBackfill,
          'memory.embed_backfill_cancel': api.memoryEmbedBackfillCancel,
          'memory.summary.get': api.memorySummaryGet,
          'memory.summary.batch': api.memorySummaryBatch,
          'memory.summary.invalidate': api.memorySummaryInvalidate,
          'entity.query': api.entityQuery,
          'brief.get': api.briefGet,
          'chat.complete': api.chatComplete,
          'llm.save_api_key': api.llmApiKeySet,
          'llm.api_key_status': api.llmApiKeyStatus,
          'llm.clear_api_key': api.llmApiKeyClear,
          'shogun.open_pack': api.openPack,
          'shogun.start_focus_session': api.startFocusSession,
          'shogun.draft_reply': api.draftReply,
          'stats.get': api.statsGet,
          'draft.create': api.draftCreate,
          'schedule.create': api.scheduleAction,
          'meetings.start': api.meetingStart,
          'meetings.stop': api.meetingStop,
          'meetings.note.append_block': api.meetingNoteAppendBlock,
          'meetings.note.edit_block': api.meetingNoteEditBlock,
          'meetings.note.delete_block': api.meetingNoteDeleteBlock,
          'meetings.enhance': api.meetingEnhance,
          'meetings.re_enhance': api.meetingReEnhance,
          'meetings.transcript.for_block': api.meetingTranscriptForBlock,
          'meetings.transcript.live': api.meetingTranscriptLive,
          'meetings.purge': api.meetingPurge,
          'meetings.list': api.meetingList,
          'meetings.get': api.meetingGet,
          'meetings.transcript.get': api.meetingTranscriptGet,
          'meetings.notes.get': api.meetingNotesGet,
          'meetings.search': api.meetingsSearch,
          'meetings.recipe.run': api.meetingRecipeRun,
          'meetings.templates.list': api.meetingTemplatesList,
          'meetings.transcript.push': api.meetingTranscriptPush,
          'meetings.audio.status': api.meetingAudioStatus,
          'meetings.mic.start': api.meetingMicStart,
          'meetings.mic.stop': api.meetingMicStop,
          'meetings.transcribe.pcm': api.meetingTranscribePcm,
          'meetings.mcp.tools': api.meetingMcpTools,
          'meetings.import.pick': api.meetingImportPick,
          'meetings.import.file': api.meetingImportFile,
        };
        return {
          run: async (key: string, payload: any) => {
            const fn = map[key];
            if (!fn) return { ok:false, error:{ message:`Action not connected: ${key}` } };
            const result = await fn(payload || {});
            return result && result.ok === false ? result : { ok:true, data:result };
          },
        };
      },
    };
  }
}
