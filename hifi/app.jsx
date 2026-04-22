/* global Icon, Kamon, React, ReactDOM, ScreenHome, ScreenMemory, ScreenChat, ScreenAgents, ScreenWork, ScreenMeetings, SettingsModal, ConfirmWriteModal, ShogunIpcClient, ShogunAPI, ShogunActionRegistry, ShogunKeyboardShortcuts */
const { useState, useEffect, useRef, useCallback, useLayoutEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "language": "en",
  "accentDensity": "standard",
  "dotGrid": false,
  "goldIntensity": "standard"
}/*EDITMODE-END*/;

const NAV = [
  {id:'home',      label:'Home',         jp:'起動',   icon:'dashboard', section:'main'},
  {id:'memory',    label:'Memory',       jp:'記憶',   icon:'memory',    section:'main'},
  {id:'chat',      label:'Chat',         jp:'対話',   icon:'chat',      section:'main'},
  {id:'agents',    label:'Agents',       jp:'家臣',   icon:'agents',    section:'main'},
  {id:'work',      label:'Work',         jp:'任務',   icon:'work',      section:'workspace'},
  {id:'meetings',  label:'Meetings',     jp:'会議',   icon:'calendar',  section:'workspace'},
];

const REMOVED_NAV_IDS = new Set(['morning_brief', 'capture', 'integrations', 'settings']);

function profileStateFromSections(sections) {
  const g = sections && sections.general;
  const name = g && g.name != null ? String(g.name).trim() : '';
  const email = g && g.email != null ? String(g.email).trim() : '';
  const avatarGlyph = g && g.avatarGlyph != null ? String(g.avatarGlyph).trim() : '';
  const rawImg = g && g.avatarImageDataUrl != null ? String(g.avatarImageDataUrl).trim() : '';
  const avatarImageDataUrl = rawImg && /^data:image\//i.test(rawImg) ? rawImg : '';
  return { name, email, avatarGlyph, avatarImageDataUrl };
}

function isProfilePhotoDataUrl(s) {
  const t = s != null ? String(s).trim() : '';
  return t.length > 0 && /^data:image\//i.test(t);
}

/** One grapheme for sidebar / menu avatar: optional override, else first letter of display name. */
function shellAvatarChar(avatarGlyph, displayName) {
  const g = avatarGlyph != null ? String(avatarGlyph).trim() : '';
  if (g) {
    const ch = Array.from(g)[0];
    return ch || '?';
  }
  const n = String(displayName || '').trim();
  if (n) {
    const c = Array.from(n)[0];
    if (/^[a-z]$/i.test(c)) return c.toUpperCase();
    return c;
  }
  return '?';
}

const INITIAL_CHAT_HISTORY =
  typeof window !== 'undefined' &&
  window.SHOGUN_DEMO_SEED &&
  Array.isArray(window.SHOGUN_DEMO_SEED.chats)
    ? window.SHOGUN_DEMO_SEED.chats
    : [];

const CHAT_CONTEXT_TELEMETRY_LS = 'shogun.hifi.telemetry.chat_context.v1';
const CHAT_WORKSPACE_LS = 'shogun.hifi.chat.workspace.v1';
const SIDEBAR_WIDTH_LS = 'shogun.hifi.sidebar.width.v1';
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 420;

/** Fallback when `ipc-client.js` is absent — keep in sync with `hifi/lib/ipc-client.js` mockTransport. */
function mockIpcInvoke(command, payload) {
  const echo = payload || {};
  const MOCK_SETTINGS_LS = 'shogun.hifi.mock.settings.sections.v1';
  const MOCK_LLM_KEY_LS = 'shogun.hifi.mock.llm.keyConfigured.v1';
  function readMockSettingsSections() {
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
  function mergeMockSettingsSection(section, patch) {
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
  function readMockLlmKeyConfigured() {
    try {
      if (typeof localStorage === 'undefined') return false;
      return localStorage.getItem(MOCK_LLM_KEY_LS) === '1';
    } catch (_) {
      return false;
    }
  }
  function writeMockLlmKeyConfigured(on) {
    try {
      if (typeof localStorage === 'undefined') return;
      if (on) localStorage.setItem(MOCK_LLM_KEY_LS, '1');
      else localStorage.removeItem(MOCK_LLM_KEY_LS);
    } catch (_) {
      /* ignore */
    }
  }
  const notImpl = (message) => ({
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
      const C = typeof window !== 'undefined' && window.ShogunIntegrationConnectors;
      if (C && typeof C.mockIntegrationPayload === 'function') {
        const payload = C.mockIntegrationPayload(command, echo);
        if (payload) return { ok: true, data: payload };
      }
      return notImpl('Integration mock unavailable.');
    }
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
    case 'app_settings_save': {
      if (echo && echo.section) {
        const section = echo.section;
        const { section: _sec, ...rest } = echo;
        mergeMockSettingsSection(section, rest);
      }
      return { ok: true, data: { saved: true, stub: false, echo } };
    }
    case 'shogun_memory_search': {
      const DEMO = typeof window !== 'undefined' ? window.SHOGUN_DEMO_SEED : null;
      if (!DEMO || !Array.isArray(DEMO.memoryHits)) {
        return { ok: true, data: { hits: [], total: 0, echo, stub: false } };
      }
      let hits = DEMO.memoryHits.slice();
      const q = String((echo && echo.query) || '')
        .trim()
        .toLowerCase();
      if (q) {
        hits = hits.filter((h) =>
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
    case 'shogun_stats': {
      const DEMO = typeof window !== 'undefined' ? window.SHOGUN_DEMO_SEED : null;
      const empty = {
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
      const base =
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
              pipelineAvailable: true,
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
    case 'app_open_hummingbird':
      return { ok: true, data: { opened: true, stub: false, echo } };
    case 'app_create_share_link': {
      const mode = (echo && echo.mode) || 'private';
      const rt = echo && echo.resourceType;
      let url = null;
      let shareId = null;
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
      const DEMO = typeof window !== 'undefined' ? window.SHOGUN_DEMO_SEED : null;
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
    default:
      return { ok: true, data: { command, payload: echo, mock: true } };
  }
}

function ensureRuntimeDeps() {
  if (!window.ShogunIpcClient) {
    window.ShogunIpcClient = {
      createIpcClient: () => ({
        transport: 'mock',
        invoke: async (command, payload) => mockIpcInvoke(command, payload),
      }),
    };
  }
  if (!window.ShogunAPI) {
    window.ShogunAPI = {
      createApi: (client) => ({
        appOpenHummingbird: (input) => client.invoke('app_open_hummingbird', input),
        appCreateShareLink: (input) => client.invoke('app_create_share_link', input),
        settingsLoad: (input) => client.invoke('app_settings_load', input),
        settingsSave: (input) => client.invoke('app_settings_save', input),
        integrationConnect: (input) => client.invoke('app_integration_connect', input),
        integrationImportCredentials: (input) =>
          client.invoke('app_integration_import_credentials', input),
        integrationCredentialsStatus: (input) =>
          client.invoke('app_integration_credentials_status', input),
        integrationToggle: (input) => client.invoke('app_integration_toggle', input),
        googleCalendarSync: (input) => client.invoke('shogun_google_calendar_sync', input),
        gmailSync: (input) => client.invoke('shogun_gmail_sync', input),
        capturePause: (input) => client.invoke('app_capture_pause', input),
        captureResume: (input) => client.invoke('app_capture_resume', input),
        permissionsManage: (input) => client.invoke('app_permissions_manage', input),
        privacyPickApp: (input) => client.invoke('app_privacy_pick_app', input || {}),
        diagnosticsReport: (input) => client.invoke('app_diagnostics_report', input),
        updatesCheck: (input) => client.invoke('app_updates_check', input),
        updatesDownloadInstall: (input) => client.invoke('app_updates_download_install', input),
        frontendErrorReport: (input) => client.invoke('app_frontend_error_report', input),
        accountDeleteData: (input) => client.invoke('app_delete_data_range', input),
        accountDeleteAll: (input) => client.invoke('app_delete_all_data', input),
        accountDeleteSelf: (input) => client.invoke('app_delete_account', input),
        memorySearch: (input) => client.invoke('shogun_memory_search', input),
        memoryIngest: (input) => client.invoke('shogun_memory_ingest', input),
        memoryDelete: (input) => client.invoke('shogun_memory_delete', input),
        memoryEmbedBackfill: (input) =>
          client.invoke('shogun_memory_embed_backfill', input, { timeoutMs: 600000 }),
        memoryEmbedBackfillCancel: (input) =>
          client.invoke('shogun_memory_embed_backfill_cancel', input || {}),
        entityQuery: (input) => client.invoke('shogun_entity_query', input),
        briefGet: (input) => client.invoke('shogun_brief_get', input),
        openPack: (input) => client.invoke('shogun_open_pack', input),
        startFocusSession: (input) => client.invoke('shogun_start_focus_session', input),
        draftReply: (input) => client.invoke('shogun_draft_reply', input),
        chatComplete: (input) => client.invoke('shogun_chat_complete', input),
        statsGet: (input) => client.invoke('shogun_stats', input),
        draftCreate: (input) => client.invoke('shogun_draft', input),
        llmApiKeySet: (input) => client.invoke('app_llm_api_key_set', input),
        llmApiKeyStatus: (input) => client.invoke('app_llm_api_key_status', input),
        llmApiKeyClear: (input) => client.invoke('app_llm_api_key_clear', input),
        scheduleAction: (input) => client.invoke('shogun_schedule_action', input),
        meetingStart: (input) => client.invoke('shogun_meeting_start', input),
        meetingStop: (input) => client.invoke('shogun_meeting_stop', input),
        meetingNoteAppendBlock: (input) => client.invoke('shogun_meeting_note_append_block', input),
        meetingNoteEditBlock: (input) => client.invoke('shogun_meeting_note_edit_block', input),
        meetingNoteDeleteBlock: (input) => client.invoke('shogun_meeting_note_delete_block', input),
        meetingEnhance: (input) => client.invoke('shogun_meeting_enhance', input),
        meetingReEnhance: (input) => client.invoke('shogun_meeting_re_enhance', input),
        meetingTranscriptForBlock: (input) => client.invoke('shogun_meeting_transcript_for_block', input),
        meetingTranscriptLive: (input) => client.invoke('shogun_meeting_transcript_live', input),
        meetingPurge: (input) => client.invoke('shogun_meeting_purge', input),
        meetingList: (input) => client.invoke('shogun_meeting_list', input),
        meetingGet: (input) => client.invoke('shogun_meeting_get', input),
        meetingTranscriptGet: (input) => client.invoke('shogun_meeting_transcript_get', input),
        meetingNotesGet: (input) => client.invoke('shogun_meeting_notes_get', input),
        meetingsSearch: (input) => client.invoke('shogun_meetings_search', input),
        meetingRecipeRun: (input) => client.invoke('shogun_meeting_recipe_run', input),
        meetingTemplatesList: (input) => client.invoke('shogun_meeting_templates_list', input),
        meetingTranscriptPush: (input) => client.invoke('shogun_meeting_transcript_push', input),
        meetingAudioStatus: (input) => client.invoke('shogun_meeting_audio_status', input),
        meetingMicStart: (input) => client.invoke('shogun_meeting_mic_start', input),
        meetingMicStop: (input) => client.invoke('shogun_meeting_mic_stop', input),
        meetingTranscribePcm: (input) => client.invoke('shogun_meeting_transcribe_pcm', input),
        meetingMcpTools: (input) => client.invoke('shogun_meeting_mcp_tools', input),
      }),
    };
  }
  if (!window.ShogunActionRegistry) {
    window.ShogunActionRegistry = {
      createActionRegistry: (api) => {
        const map = {
          'app.open_hummingbird': api.appOpenHummingbird,
          'app.create_share_link': api.appCreateShareLink,
          'settings.save': api.settingsSave,
          'settings.load': api.settingsLoad,
          'integrations.connect': api.integrationConnect,
          'integrations.import_credentials': api.integrationImportCredentials,
          'integrations.credentials_status': api.integrationCredentialsStatus,
          'integrations.toggle': api.integrationToggle,
          'calendar.sync': api.googleCalendarSync,
          'gmail.sync': api.gmailSync,
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
          'memory.ingest': api.memoryIngest,
          'memory.delete': api.memoryDelete,
          'memory.embed_backfill': api.memoryEmbedBackfill,
          'memory.embed_backfill_cancel': api.memoryEmbedBackfillCancel,
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
        };
        return {
          run: async (key, payload) => {
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

/** Apply `sections.appearance` from settings JSON to `<html>` (color mode, font size). */
function applySavedAppearance(sections) {
  if (!sections || typeof sections !== 'object') return;
  const a = sections.appearance;
  if (!a || typeof a !== 'object') return;
  const pref = a.colorMode != null ? String(a.colorMode) : '';
  if (pref === 'light' || pref === 'dark' || pref === 'auto') {
    document.documentElement.setAttribute('data-appearance', pref);
    const effective = pref === 'auto'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : pref;
    document.documentElement.setAttribute('data-color-mode', effective);
  }
  if (a.fontSize != null) {
    const fs = String(a.fontSize).toLowerCase();
    if (fs === 'normal' || fs === 'compact' || fs === 'comfortable') {
      document.documentElement.setAttribute('data-font-size', fs);
    }
  } else {
    document.documentElement.removeAttribute('data-font-size');
  }
}

function App() {
  ensureRuntimeDeps();
  const WriteModal = ConfirmWriteModal || function FallbackWriteModal(props) {
    if (!props.open) return null;
    return ReactDOM.createPortal(
      <>
        <div
          role="presentation"
          style={{ position: 'fixed', inset: 0, zIndex: 1150, background: 'rgba(10,9,8,0.55)' }}
          onMouseDown={(e) => {
            if (props.pending) return;
            e.preventDefault();
            props.onCancel();
          }}
        />
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%,-50%)',
            zIndex: 1151,
            boxSizing: 'border-box',
            width: 'min(520px, calc(100vw - 32px))',
            maxHeight: 'calc(100vh - 32px)',
            overflow: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--border-hi)',
            borderRadius: 'var(--radius-lg)',
            padding: 16,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{props.title || 'Confirm action'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10 }}>{props.description || 'This action may change local state.'}</div>
          <pre style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 10, margin: 0, fontSize: 11, fontFamily: 'var(--font-mono)' }}>{JSON.stringify(props.payload || {}, null, 2)}</pre>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={props.onCancel}>Cancel</button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={props.onConfirm}>{props.pending ? 'Running...' : 'Confirm'}</button>
          </div>
        </div>
      </>,
      document.body,
    );
  };
  const [active, setActive] = useState(() => {
    const saved = localStorage.getItem('shogun-active') || 'home';
    return REMOVED_NAV_IDS.has(saved) ? 'home' : saved;
  });
  const [activeChat, setActiveChat] = useState(() => (INITIAL_CHAT_HISTORY[0] ? INITIAL_CHAT_HISTORY[0].id : null));
  const [chats, setChats] = useState(INITIAL_CHAT_HISTORY);
  const [dragId, setDragId] = useState(null);
  const [dragOver, setDragOver] = useState(null); // {id, pos:'before'|'after'|'fav'|'chats'}
  const dragIdRef = useRef(null);
  const dragOverRef = useRef(null);
  const suppressChatRowClickRef = useRef(false);
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  const [editMode, setEditMode] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMode, setShareMode] = useState('private');
  const [shareTip, setShareTip] = useState(null); // 'popout' | 'star' | 'share' | null
  const [hummingbirdOpen, setHummingbirdOpen] = useState(false);
  const [hummingbirdInput, setHummingbirdInput] = useState('');
  const [userOpen, setUserOpen] = useState(false);
  const [userAnchor, setUserAnchor] = useState({left:0, bottom:0, width:220});
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [contextPanelAnchor, setContextPanelAnchor] = useState({ left: 0, bottom: 0, width: 320 });
  const [chatMenu, setChatMenu] = useState({ open:false, chatId:null, x:0, y:0, width:240 });
  const [chatRenameModal, setChatRenameModal] = useState({ open:false, chatId:null, value:'' });
  const [chatDeleteModal, setChatDeleteModal] = useState({ open:false, chatId:null });
  const [chatWorkModal, setChatWorkModal] = useState({ open:false, chatId:null, query:'' });
  const [chatGroupsOpen, setChatGroupsOpen] = useState({ favorite: true, chats: true });
  const [workProjects, setWorkProjects] = useState([
    { id:'w-steal', name:'スチールカウント' },
    { id:'w-grop', name:'GROP Internal Chatbot Project' },
    { id:'w-cluely', name:'cluely' },
    { id:'w-kakei', name:'家系図OCR' },
    { id:'w-hojo', name:'補助金,助成金' },
    { id:'w-chrome', name:'chrome自動化' },
  ]);
  const chatWorkspaceHydratedRef = useRef(false);
  const userBtnRef = React.useRef(null);
  const contextBtnRef = React.useRef(null);
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [profileAvatarGlyph, setProfileAvatarGlyph] = useState('');
  const [profileAvatarImageDataUrl, setProfileAvatarImageDataUrl] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(null); // null | 'general' | 'system' | 'appearance' | 'privacy' | 'data' | 'hummingbird' | 'meetings' | 'chat' | 'integrations' | 'shortcuts' | 'team' | 'support' | 'api' | 'upgrade' | 'changelog' | 'feedback'
  const [toast, setToast] = useState(null);
  const [writeConfirm, setWriteConfirm] = useState({ open:false, actionKey:null, payload:null, title:null, description:null });
  const [writePending, setWritePending] = useState(false);
  const runtimeRef = useRef(null);
  const toastTimerRef = useRef(null);
  const bioWantLockRef = useRef(false);
  const [bioGate, setBioGate] = useState({ ready: false, open: false });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_LS));
      if (Number.isFinite(raw)) return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(raw)));
    } catch (_) {
      /* ignore */
    }
    return 240;
  });
  const [sidebarResizeHint, setSidebarResizeHint] = useState(false);
  const resizeStateRef = useRef({ active: false, moved: false, startX: 0, startWidth: 240 });
  const [meetingHud, setMeetingHud] = useState(null);
  const [meetingHudTick, setMeetingHudTick] = useState(0);
  const navHistRef = useRef(null);
  const skipNavHistRef = useRef(false);
  const shortcutBindingsRef = useRef(
    typeof window !== 'undefined' && window.ShogunKeyboardShortcuts
      ? window.ShogunKeyboardShortcuts.mergeShortcutBindings()
      : {},
  );

  const openUser = () => {
    const r = userBtnRef.current?.getBoundingClientRect();
    if (r) setUserAnchor({left: r.left, bottom: window.innerHeight - r.top + 8, width: r.width});
    setContextPanelOpen(false);
    setUserOpen(v => !v);
  };

  const openContextPanel = () => {
    const r = contextBtnRef.current?.getBoundingClientRect();
    if (r) {
      const targetWidth = Math.round(r.width);
      setContextPanelAnchor({
        left: Math.max(12, r.left),
        bottom: window.innerHeight - r.top + 10,
        width: targetWidth,
      });
    }
    setUserOpen(false);
    setContextPanelOpen((v) => !v);
  };

  useEffect(() => { localStorage.setItem('shogun-active', active); }, [active]);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_LS, String(sidebarWidth));
    } catch (_) {
      /* ignore */
    }
  }, [sidebarWidth]);

  useEffect(() => {
    const onHud = (e) => {
      const d = (e && e.detail) || {};
      if (!d.active) {
        setMeetingHud(null);
        return;
      }
      setMeetingHud({
        title: d.title || 'Untitled',
        startedAt: d.startedAt || Date.now(),
      });
      // Title updates during recording emit hudPhase "tick"; only "begin" should steal focus / reopen tabs.
      if (d.hudPhase !== 'begin') return;
      setActive('meetings');
      window.setTimeout(() => {
        try {
          window.dispatchEvent(
            new CustomEvent('shogun-auto-open-meeting-minutes', {
              detail: {
                title: d.title || 'Untitled',
                startedAt: d.startedAt || Date.now(),
                storageKey: d.storageKey != null ? d.storageKey : null,
              },
            }),
          );
        } catch (_) {
          /* ignore */
        }
      }, 0);
    };
    window.addEventListener('shogun-meeting-hud', onHud);
    return () => window.removeEventListener('shogun-meeting-hud', onHud);
  }, [setActive]);

  useEffect(() => {
    if (!meetingHud) return undefined;
    const id = window.setInterval(() => setMeetingHudTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [meetingHud]);

  useEffect(() => {
    try {
      window.dispatchEvent(
        new CustomEvent('shogun-active-chat-changed', { detail: { id: activeChat } }),
      );
    } catch (_) {
      /* ignore */
    }
  }, [activeChat]);
  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  useEffect(() => {
    if (!hummingbirdOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setHummingbirdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hummingbirdOpen]);

  useEffect(() => {
    if (!contextPanelOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setContextPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextPanelOpen]);

  const pushToast = (message, kind='info') => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast({ message, kind });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2200);
  };
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    let unlisten;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    (async () => {
      try {
        unlisten = await listen('credentials-imported', (e) => {
          const p = (e && e.payload) || {};
          if (p.saved) {
            try {
              window.dispatchEvent(new CustomEvent('shogun-credentials-updated', { detail: p }));
            } catch (_) {
              /* ignore */
            }
            const who = p.provider ? `（${p.provider}）` : '';
            const via = p.via === 'invoke' ? 'Invoke' : 'Deep link';
            pushToastRef.current(`${via}: 連携資格情報を保存しました${who}`, 'success');
          } else {
            const err = typeof p.error === 'string' ? p.error : '不明なエラー';
            const via = p.via === 'deep-link' ? 'Deep link' : '';
            pushToastRef.current(`${via ? `${via}: ` : ''}取り込み失敗 — ${err}`, 'error');
          }
        });
      } catch (_) {
        /* ignore */
      }
    })();
    return () => {
      if (typeof unlisten === 'function') unlisten();
    };
  }, []);

  useEffect(() => {
    let unlisten;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    const AUDIT_LS_KEY = 'shogun.integration.audit.v1';
    (async () => {
      try {
        unlisten = await listen('integration-security-audit', (e) => {
          const p = (e && e.payload) || {};
          const row = {
            event: String(p.event || ''),
            provider: String(p.provider || ''),
            via: String(p.via || ''),
            reason: String(p.reason || ''),
            ts: Date.now(),
          };
          try {
            const raw = localStorage.getItem(AUDIT_LS_KEY);
            const prev = raw ? JSON.parse(raw) : [];
            const arr = Array.isArray(prev) ? prev : [];
            const next = [row].concat(arr).slice(0, 20);
            localStorage.setItem(AUDIT_LS_KEY, JSON.stringify(next));
          } catch (_) {
            /* ignore */
          }
          try {
            window.dispatchEvent(
              new CustomEvent('shogun-integration-security-audit', { detail: row }),
            );
          } catch (_) {
            /* ignore */
          }
        });
      } catch (_) {
        /* ignore */
      }
    })();
    return () => {
      if (typeof unlisten === 'function') unlisten();
    };
  }, []);

  /** Desktop: Rust emits when Meet/Zoom (or browser with those URLs) is detected — opens Meetings + Granola via `shogun-meeting-detected`. */
  useEffect(() => {
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    let unlistenVideo;
    (async () => {
      try {
        unlistenVideo = await listen('video-meeting-started', (e) => {
          const p = (e && e.payload) || {};
          const url = String(p.url || p.meetingUrl || '').toLowerCase();
          const raw = String(p.provider || p.app || '').toLowerCase();
          let provider = 'google_meet';
          if (url.indexOf('zoom.us') !== -1 || url.indexOf('zoomgov.com') !== -1) provider = 'zoom';
          else if (url.indexOf('meet.google') !== -1) provider = 'google_meet';
          else if (raw === 'zoom' || raw.indexOf('zoom') !== -1) provider = 'zoom';
          else if (raw.indexOf('meet') !== -1 || raw.indexOf('google') !== -1) provider = 'google_meet';
          try {
            window.dispatchEvent(
              new CustomEvent('shogun-meeting-detected', {
                detail: {
                  title: p.title || p.summary || 'Meeting',
                  eventId: p.eventId || p.id || 'video-' + String(Date.now()),
                  provider,
                  source: 'native',
                  url: p.url || p.meetingUrl || null,
                },
              }),
            );
          } catch (_) {
            /* ignore */
          }
          setActive('meetings');
        });
      } catch (_) {
        /* ignore */
      }
    })();
    return () => {
      if (typeof unlistenVideo === 'function') unlistenVideo();
    };
  }, [setActive]);

  if (!runtimeRef.current && ShogunIpcClient && ShogunAPI && ShogunActionRegistry) {
    const client = ShogunIpcClient.createIpcClient();
    const api = ShogunAPI.createApi(client);
    const registry = ShogunActionRegistry.createActionRegistry(api, {
      onMissing: (key) => pushToast(`Action not connected: ${key}`, 'warn'),
      onExecute: () => {},
    });
    runtimeRef.current = { client, api, registry };
  }

  const executeAction = async (actionKey, payload, options={}) => {
    if (!runtimeRef.current) {
      pushToast('IPC runtime unavailable', 'error');
      return { ok:false };
    }
    let res;
    try {
      res = await runtimeRef.current.registry.run(actionKey, payload);
    } catch (err) {
      const msg = err && err.message ? String(err.message) : 'Action failed unexpectedly';
      if (!options.silentError) pushToast(msg, 'error');
      return { ok: false, error: { code: 'RUNTIME_EXCEPTION', message: msg } };
    }
    if (res.ok && res.data && res.data.notImplemented) {
      pushToast(res.data.message || 'Not available in this version', 'warn');
      return res;
    }
    if (res.ok && res.data && res.data.honestPreferenceOnly) {
      pushToast(res.data.message || 'Preference saved locally only.', 'info');
      return res;
    }
    if (res.ok) {
      if (options.successMessage) pushToast(options.successMessage, 'success');
    } else if (!options.silentError) {
      pushToast(res.error?.message || 'Action failed', 'error');
    }
    return res;
  };

  const requestWriteAction = (actionKey, payload, title, description) => {
    setWriteConfirm({ open:true, actionKey, payload, title, description });
  };

  useEffect(() => {
    window.SHOGUN_RUNTIME = {
      executeAction,
      requestWriteAction,
      pushToast,
      getActiveChat: () => chats.find(c => c.id === activeChat) || null,
      getChats: () => chats.slice(),
      getWorkProjects: () => workProjects.slice(),
      renameWorkProject: (projectId, nextName) => {
        const id = String(projectId || '').trim();
        const name = String(nextName || '').trim();
        if (!id || !name) return false;
        setWorkProjects((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)));
        setChats((prev) => prev.map((c) => (
          c.workProjectId === id ? { ...c, workProjectName: name } : c
        )));
        pushToast(`Work名を変更: ${name}`, 'success');
        return true;
      },
      deleteWorkProject: (projectId) => {
        const id = String(projectId || '').trim();
        if (!id) return false;
        setWorkProjects((prev) => prev.filter((p) => p.id !== id));
        setChats((prev) => prev.map((c) => (
          c.workProjectId === id
            ? { ...c, workProjectId: null, workProjectName: null }
            : c
        )));
        pushToast('Workプロジェクトを削除しました', 'success');
        return true;
      },
      archiveWorkProject: (projectId, archivedOn) => {
        const id = String(projectId || '').trim();
        if (!id) return false;
        const on = archivedOn !== false;
        setWorkProjects((prev) => prev.map((p) => (
          p.id === id ? { ...p, archived: on } : p
        )));
        pushToast(on ? 'Workプロジェクトをアーカイブしました' : 'Workプロジェクトを復元しました', 'success');
        return true;
      },
      moveWorkProject: (projectId, direction) => {
        const id = String(projectId || '').trim();
        const dir = Number(direction);
        if (!id || !Number.isFinite(dir) || (dir !== -1 && dir !== 1)) return false;
        let moved = false;
        setWorkProjects((prev) => {
          const idx = prev.findIndex((p) => p.id === id);
          if (idx < 0) return prev;
          const to = idx + dir;
          if (to < 0 || to >= prev.length) return prev;
          const out = prev.slice();
          const item = out[idx];
          out.splice(idx, 1);
          out.splice(to, 0, item);
          moved = true;
          return out;
        });
        if (moved) pushToast('Workプロジェクトの順序を更新しました', 'success');
        return moved;
      },
      __activeChatId: activeChat,
      openSettingsPane: (paneId) => setSettingsOpen(paneId || 'general'),
      setActiveScreen: (id) => {
        if (id && typeof id === 'string') setActive(id);
      },
      applyShortcutBindings: (raw) => {
        if (window.ShogunKeyboardShortcuts) {
          shortcutBindingsRef.current = window.ShogunKeyboardShortcuts.mergeShortcutBindings(raw);
        }
      },
    };
    return () => { delete window.SHOGUN_RUNTIME; };
  }, [activeChat, chats, workProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('shogun-chats-changed', { detail: { chats } }));
    } catch (_) {
      /* ignore */
    }
  }, [chats]);
  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('shogun-work-projects-changed', { detail: { workProjects } }));
    } catch (_) {
      /* ignore */
    }
  }, [workProjects]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = false;
      try {
        const r = await executeAction('settings.load', {}, { silentError: true });
        const sec = r && r.ok && r.data && r.data.settings && r.data.settings.sections
          ? r.data.settings.sections
          : null;
        const ws = sec && sec.chat_workspace && typeof sec.chat_workspace === 'object' ? sec.chat_workspace : null;
        if (ws) {
          if (Array.isArray(ws.chats)) {
            setChats(ws.chats);
            loaded = true;
          }
          if (Array.isArray(ws.workProjects)) {
            setWorkProjects(ws.workProjects);
            loaded = true;
          }
        }
      } catch (_) {
        /* ignore */
      }
      if (!loaded) {
        try {
          const raw = localStorage.getItem(CHAT_WORKSPACE_LS);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
              if (Array.isArray(parsed.chats)) {
                setChats(parsed.chats);
                loaded = true;
              }
              if (Array.isArray(parsed.workProjects)) {
                setWorkProjects(parsed.workProjects);
                loaded = true;
              }
            }
          }
        } catch (_) {
          /* ignore */
        }
      }
      if (!cancelled) chatWorkspaceHydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chatWorkspaceHydratedRef.current) return;
    const payload = { section:'chat_workspace', chats, workProjects };
    try {
      localStorage.setItem(CHAT_WORKSPACE_LS, JSON.stringify({ chats, workProjects }));
    } catch (_) {
      /* ignore */
    }
    void executeAction('settings.save', payload, { silentError: true });
  }, [chats, workProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    /**
     * Sink for `BriefTelemetry` chat context events.
     * - Keeps a tiny local ring buffer for quick inspection in browser/mock.
     * - Also ingests a compact telemetry row into local Memory (`source: telemetry_chat_context`).
     */
    window.shogunBriefTelemetrySink = (row) => {
      try {
        if (!row || row.name !== 'chat.completion.context') return;
        const payload = row && typeof row.payload === 'object' ? row.payload : {};
        const compact = {
          t: row.t || new Date().toISOString(),
          hasManualMemoryContext: payload.hasManualMemoryContext === true,
          manualMemoryContextChars: Number(payload.manualMemoryContextChars) || 0,
          memoryAssemblyRequested: payload.memoryAssemblyRequested === true,
          memoryAssemblySent: payload.memoryAssemblySent === true,
          memoryAssemblyPreset: payload.memoryAssemblyPreset === true,
          privacyAllowsServerAssembly: payload.privacyAllowsServerAssembly !== false,
        };
        try {
          if (typeof localStorage !== 'undefined') {
            const prevRaw = localStorage.getItem(CHAT_CONTEXT_TELEMETRY_LS);
            const prev = prevRaw ? JSON.parse(prevRaw) : [];
            const arr = Array.isArray(prev) ? prev : [];
            arr.push(compact);
            while (arr.length > 100) arr.shift();
            localStorage.setItem(CHAT_CONTEXT_TELEMETRY_LS, JSON.stringify(arr));
          }
        } catch (_) {
          /* ignore localStorage failures */
        }
        void executeAction(
          'memory.ingest',
          {
            title: 'Telemetry: chat context routing',
            snippet: JSON.stringify(compact).slice(0, 4000),
            source: 'telemetry_chat_context',
            kinds: ['telemetry', 'chat'],
            provenance: 'user',
          },
          { silentError: true },
        );
      } catch (_) {
        /* never throw from telemetry sink */
      }
    };
    return () => {
      try {
        delete window.shogunBriefTelemetrySink;
      } catch (_) {}
    };
  }, [executeAction]);

  const createNewChat = useCallback(() => {
    const id = `c${Date.now()}`;
    const item = { id, title: 'New Chat', time: '', when: 'TODAY', jp: '今日', favorite: false };
    setChats((prev) => [item, ...prev]);
    setActiveChat(id);
    setActive('chat');
    pushToast('New Chat created', 'success');
  }, []);

  useLayoutEffect(() => {
    if (!navHistRef.current) {
      navHistRef.current = { entries: [active], cursor: 0 };
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const h = navHistRef.current;
    if (!h) return;
    if (skipNavHistRef.current) {
      skipNavHistRef.current = false;
      return;
    }
    if (h.entries[h.cursor] === active) return;
    const next = h.entries.slice(0, h.cursor + 1);
    next.push(active);
    navHistRef.current = { entries: next, cursor: next.length - 1 };
  }, [active]);

  const toggleFav = (id) => setChats(cs => cs.map(c => c.id===id ? {...c, favorite: !c.favorite} : c));
  const openChatMenuAt = useCallback((chatId, x, y) => {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    let menuW = 248;
    const menuH = 220;
    const edgePad = 8;
    let minX = edgePad;
    let maxX = vw - menuW - edgePad;
    let minY = edgePad;
    let maxY = vh - menuH - edgePad;
    const sidebarEl = document.querySelector('.sidebar');
    if (sidebarEl && typeof sidebarEl.getBoundingClientRect === 'function') {
      const r = sidebarEl.getBoundingClientRect();
      const availableW = Math.max(180, Math.floor(r.width) - edgePad * 2);
      menuW = Math.min(menuW, availableW);
      minX = Math.max(edgePad, Math.floor(r.left) + edgePad);
      maxX = Math.min(vw - menuW - edgePad, Math.floor(r.right) - menuW - edgePad);
      minY = Math.max(edgePad, Math.floor(r.top) + edgePad);
      maxY = Math.min(vh - menuH - edgePad, Math.floor(r.bottom) - menuH - edgePad);
    }
    if (maxX < minX) maxX = minX;
    if (maxY < minY) maxY = minY;
    const clampedX = Math.max(minX, Math.min(x, maxX));
    const clampedY = Math.max(minY, Math.min(y, maxY));
    setChatMenu({ open:true, chatId, x:clampedX, y:clampedY, width:menuW });
  }, []);
  const closeChatMenu = useCallback(() => setChatMenu({ open:false, chatId:null, x:0, y:0, width:240 }), []);
  const openRenameModal = useCallback((id) => {
    const current = chats.find((c) => c.id === id);
    if (!current) return;
    setChatRenameModal({ open:true, chatId:id, value:current.title || '' });
  }, [chats]);
  const submitRenameModal = useCallback(() => {
    const id = chatRenameModal.chatId;
    const trimmed = String(chatRenameModal.value || '').trim();
    if (!id || !trimmed) return;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    setChatRenameModal({ open:false, chatId:null, value:'' });
    pushToast('チャット名を更新しました', 'success');
  }, [chatRenameModal]);
  const openDeleteModal = useCallback((id) => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setChatDeleteModal({ open:true, chatId:id });
  }, [chats]);
  const confirmDeleteChat = useCallback(() => {
    const id = chatDeleteModal.chatId;
    if (!id) return;
    setChats((cs) => {
      const next = cs.filter((c) => c.id !== id);
      if (activeChat === id) {
        setActiveChat(next[0] ? next[0].id : null);
      }
      return next;
    });
    setChatDeleteModal({ open:false, chatId:null });
    pushToast('チャットを削除しました', 'success');
  }, [activeChat, chatDeleteModal.chatId]);
  const openWorkModal = useCallback((id) => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setChatWorkModal({ open:true, chatId:id, query:'' });
  }, [chats]);
  const assignChatToWork = useCallback((workId, workName) => {
    const id = chatWorkModal.chatId;
    if (!id) return;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, workProjectId:workId, workProjectName:workName } : c)));
    setChatWorkModal({ open:false, chatId:null, query:'' });
    setActive('work');
    pushToast(`Workに追加: ${workName}`, 'success');
  }, [chatWorkModal.chatId]);
  const createAndAssignWork = useCallback(() => {
    const name = String(chatWorkModal.query || '').trim();
    if (!name) return;
    const id = `w-${Date.now()}`;
    setWorkProjects((prev) => [...prev, { id, name }]);
    assignChatToWork(id, name);
  }, [assignChatToWork, chatWorkModal.query]);
  const toggleWorkArchiveForChat = useCallback((id) => {
    const target = chats.find((c) => c.id === id);
    if (!target || !target.workProjectId) return;
    let nextArchived = false;
    setWorkProjects((prev) => prev.map((p) => {
      if (p.id !== target.workProjectId) return p;
      nextArchived = p.archived !== true;
      return { ...p, archived: nextArchived };
    }));
    pushToast(nextArchived ? 'Workをアーカイブしました' : 'Workを復元しました', 'success');
  }, [chats]);
  const runChatMenuAction = useCallback((action, id) => {
    if (!id) return;
    if (action === 'pin') {
      toggleFav(id);
      pushToast('Favoriteを更新しました', 'success');
    } else if (action === 'rename') {
      openRenameModal(id);
    } else if (action === 'work') {
      openWorkModal(id);
    } else if (action === 'workArchive') {
      toggleWorkArchiveForChat(id);
    } else if (action === 'delete') {
      openDeleteModal(id);
    }
    closeChatMenu();
  }, [closeChatMenu, openDeleteModal, openRenameModal, openWorkModal, toggleWorkArchiveForChat]);
  useEffect(() => {
    if (!chatMenu.open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') closeChatMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatMenu.open, closeChatMenu]);
  const clearChatDrag = () => {
    dragIdRef.current = null;
    dragOverRef.current = null;
    setDragId(null);
    setDragOver(null);
  };
  /** HTML5 drag/drop is unreliable in Tauri/WKWebView; reorder uses pointer events instead. */
  const applyChatDragReorder = useCallback(() => {
    const did = dragIdRef.current;
    const over = dragOverRef.current;
    if (!did || !over) return;
    setChats((cs) => {
      const src = cs.find((c) => c.id === did);
      if (!src) return cs;
      const rest = cs.filter((c) => c.id !== did);
      if (over.id === null) {
        const moved = { ...src, favorite: over.pos === 'fav' };
        return [...rest, moved];
      }
      const target = rest.find((c) => c.id === over.id);
      if (!target) return cs;
      const moved = { ...src, favorite: target.favorite };
      const idx = rest.findIndex((c) => c.id === over.id);
      const insertAt = over.pos === 'before' ? idx : idx + 1;
      const out = [...rest];
      out.splice(insertAt, 0, moved);
      return out;
    });
  }, []);
  const updateDragOverFromPoint = useCallback((clientX, clientY) => {
    const did = dragIdRef.current;
    let root;
    try {
      root = document.elementFromPoint(clientX, clientY);
    } catch (_) {
      return;
    }
    if (!root) return;
    const row = root.closest?.('[data-chat-row]');
    if (row) {
      const rid = row.getAttribute('data-chat-row');
      if (rid === did) {
        dragOverRef.current = null;
        setDragOver(null);
        return;
      }
      if (rid) {
        const rect = row.getBoundingClientRect();
        const pos = clientY - rect.top < rect.height / 2 ? 'before' : 'after';
        const next = { id: rid, pos };
        dragOverRef.current = next;
        setDragOver(next);
        return;
      }
    }
    const bucket = root.closest?.('[data-chat-bucket]');
    if (bucket) {
      const b = bucket.getAttribute('data-chat-bucket');
      if (b === 'fav' || b === 'chats') {
        const next = { id: null, pos: b };
        dragOverRef.current = next;
        setDragOver(next);
      }
    }
  }, []);
  const CHAT_DRAG_THRESHOLD_PX = 6;
  const onChatRowPointerDown = useCallback(
    (id) => (e) => {
      if (e.button !== 0) return;
      if (e.target.closest?.('button')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let armed = false;
      const move = (ev) => {
        if (!armed) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < CHAT_DRAG_THRESHOLD_PX) return;
          armed = true;
          dragIdRef.current = id;
          setDragId(id);
          dragOverRef.current = null;
          setDragOver(null);
          document.body.classList.add('chat-reorder-active');
        }
        updateDragOverFromPoint(ev.clientX, ev.clientY);
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        document.body.classList.remove('chat-reorder-active');
        if (armed) {
          applyChatDragReorder();
          suppressChatRowClickRef.current = true;
        }
        clearChatDrag();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [applyChatDragReorder, updateDragOverFromPoint],
  );

  useEffect(() => {
    document.body.classList.toggle('dot-grid', tweaks.dotGrid);
    document.body.setAttribute('data-lang', tweaks.language);
    document.body.setAttribute('data-density', tweaks.accentDensity);
    document.body.setAttribute('data-gold', tweaks.goldIntensity);
  }, [tweaks]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      if (document.documentElement.getAttribute('data-appearance') !== 'auto') return;
      document.documentElement.setAttribute('data-color-mode', mq.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', onScheme);
    return () => mq.removeEventListener('change', onScheme);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!runtimeRef.current?.client?.hasTauriInvoke?.()) {
        if (!cancelled) setBioGate({ ready: true, open: false });
        return;
      }
      const settingsRes = await executeAction('settings.load', {}, { silentError: true });
      const wantLock = !!(settingsRes.data?.settings?.sections?.security?.biometricLockEnabled);
      if (!wantLock) {
        bioWantLockRef.current = false;
        if (!cancelled) setBioGate({ ready: true, open: false });
        return;
      }
      const st = await executeAction('auth.biometric.status', {}, { silentError: true });
      const d = st?.data || {};
      const can = d.supported && d.enrolled;
      if (!can) {
        bioWantLockRef.current = false;
        if (!cancelled) {
          setBioGate({ ready: true, open: false });
          pushToast(
            '生体ロックが有効ですが、この端末では認証できません。設定の守秘でオフにするか、Touch ID 等を登録してください。',
            'warn',
          );
        }
        return;
      }
      bioWantLockRef.current = true;
      if (!cancelled) setBioGate({ ready: true, open: true });
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onVis = () => {
      if (document.hidden) return;
      if (!bioWantLockRef.current) return;
      if (!runtimeRef.current?.client?.hasTauriInvoke?.()) return;
      setBioGate((g) => (g.ready ? { ...g, open: true } : g));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await executeAction('settings.load', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data?.settings?.sections) return;
      const sec = r.data.settings.sections;
      applySavedAppearance(sec);
      const p = profileStateFromSections(sec);
      setProfileDisplayName(p.name);
      setProfileAvatarGlyph(p.avatarGlyph);
      setProfileAvatarImageDataUrl(p.avatarImageDataUrl);
      if (window.ShogunKeyboardShortcuts) {
        shortcutBindingsRef.current = window.ShogunKeyboardShortcuts.mergeShortcutBindings(
          sec.shortcuts && sec.shortcuts.bindings,
        );
      }
      if (sec.brief && typeof sec.brief === 'object') {
        window.__SHOGUN_SETTINGS_BRIEF__ = sec.brief;
      } else {
        window.__SHOGUN_SETTINGS_BRIEF__ = {};
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onProfile = (e) => {
      const d = e && e.detail;
      if (!d || typeof d !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(d, 'name')) {
        setProfileDisplayName(d.name == null ? '' : String(d.name).trim());
      }
      if (Object.prototype.hasOwnProperty.call(d, 'avatarGlyph')) {
        setProfileAvatarGlyph(d.avatarGlyph == null ? '' : String(d.avatarGlyph).trim());
      }
      if (Object.prototype.hasOwnProperty.call(d, 'avatarImageDataUrl')) {
        const u = d.avatarImageDataUrl == null ? '' : String(d.avatarImageDataUrl).trim();
        setProfileAvatarImageDataUrl(isProfilePhotoDataUrl(u) ? u : '');
      }
    };
    window.addEventListener('shogun-profile-changed', onProfile);
    return () => window.removeEventListener('shogun-profile-changed', onProfile);
  }, []);

  useEffect(() => {
    if (window.ShogunClerkAuth && typeof window.ShogunClerkAuth.init === 'function') {
      void window.ShogunClerkAuth.init();
    }
  }, []);

  useEffect(() => {
    const onAppearance = (e) => {
      const a = e.detail && e.detail.appearance;
      if (!a || typeof a !== 'object') return;
      applySavedAppearance({ appearance: a });
    };
    window.addEventListener('shogun-appearance-changed', onAppearance);
    return () => window.removeEventListener('shogun-appearance-changed', onAppearance);
  }, []);

  const executeActionRef = useRef(executeAction);
  executeActionRef.current = executeAction;

  useEffect(() => {
    if (bioGate.ready && bioGate.open) return undefined;
    const onKey = (e) => {
      const Kbd = window.ShogunKeyboardShortcuts;
      const t = e.target;
      const tag = t && t.tagName;
      const editable = t && t.isContentEditable;
      const inField =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable;

      const goBack = () => {
        const h = navHistRef.current;
        if (!h || h.cursor <= 0) return;
        skipNavHistRef.current = true;
        h.cursor -= 1;
        setActive(h.entries[h.cursor]);
      };
      const goForward = () => {
        const h = navHistRef.current;
        if (!h || h.cursor >= h.entries.length - 1) return;
        skipNavHistRef.current = true;
        h.cursor += 1;
        setActive(h.entries[h.cursor]);
      };

      // Keep native undo in text fields; outside fields, Cmd/Ctrl+Z navigates one step back.
      const plainUndoCombo =
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        String(e.key || '').toLowerCase() === 'z';
      if (!inField && plainUndoCombo) {
        e.preventDefault();
        goBack();
        return;
      }

      if (!Kbd) {
        if (inField) return;
        return;
      }

      const actionId = Kbd.findMatchingAction(e, shortcutBindingsRef.current, active);
      if (actionId) {
        e.preventDefault();
        const A = Kbd.ACTION_IDS;
        switch (actionId) {
          case A.MEMORY_CAPTURE:
            void executeActionRef.current(
              'memory.ingest',
              {
                title: `Capture moment · ${new Date().toLocaleTimeString()}`,
                snippet: 'Saved from keyboard shortcut.',
                source: 'shortcut',
                kinds: ['input'],
              },
              { silentError: true, successMessage: 'Moment captured' },
            );
            window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
            break;
          case A.MEMORY_JUMP_TIMELINE:
            setActive('memory');
            window.dispatchEvent(new CustomEvent('shogun-jump-memory-timeline'));
            break;
          case A.OPEN_SETTINGS:
            setSettingsOpen('general');
            break;
          case A.OPEN_CHAT_SEARCH:
            setActive('chat');
            break;
          case A.NEW_CHAT:
            createNewChat();
            break;
          case A.TOGGLE_SIDEBAR:
            setSidebarCollapsed((v) => !v);
            break;
          case A.NAVIGATE_BACK:
            goBack();
            break;
          case A.NAVIGATE_FORWARD:
            goForward();
            break;
          case A.CHAT_TOGGLE_MAX:
            window.dispatchEvent(new CustomEvent('shogun-chat-toggle-max'));
            break;
          default:
            break;
        }
        return;
      }

      if (inField) return;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [bioGate.ready, bioGate.open, active, createNewChat]);

  const cycleLang = () => {
    const order = ['en','jp','bi'];
    const next = order[(order.indexOf(tweaks.language)+1) % order.length];
    update('language', next);
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({type:'__edit_mode_available'}, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  const update = (k,v) => {
    const next = {...tweaks, [k]: v};
    setTweaks(next);
    window.parent.postMessage({type:'__edit_mode_set_keys', edits:{[k]: v}}, '*');
  };

  const sections = [
    {id:'main', label:'', jp:''},
    {id:'workspace', label:'', jp:''},
  ];
  const toggleChatGroup = (groupKey) => {
    setChatGroupsOpen((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
  };
  const favChats = chats.filter(c => c.favorite);
  const restChats = chats.filter(c => !c.favorite);
  const chatMenuTarget = chats.find((c) => c.id === chatMenu.chatId) || null;
  const chatMenuTargetWork = chatMenuTarget && chatMenuTarget.workProjectId
    ? workProjects.find((p) => p.id === chatMenuTarget.workProjectId) || null
    : null;
  const chatDeleteTarget = chats.find((c) => c.id === chatDeleteModal.chatId) || null;
  const workQuery = String(chatWorkModal.query || '').trim().toLowerCase();
  const filteredWorkProjects = workProjects.filter((p) => {
    if (!workQuery) return true;
    return String(p.name || '').toLowerCase().indexOf(workQuery) !== -1;
  });

  const Screen = {
    home: ScreenHome,
    memory: ScreenMemory,
    chat: ScreenChat,
    agents: ScreenAgents,
    work: ScreenWork,
    meetings: ScreenMeetings,
  }[active] || ScreenHome;

  if (typeof window !== 'undefined') {
    window.__SHOGUN_SHELL_ACTIVE_CHAT__ = activeChat;
  }

  const fmtHudElapsed = (startedAt) => {
    void meetingHudTick;
    if (!startedAt) return '';
    const ms = Date.now() - startedAt;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const dismissMeetingHud = () => {
    const M = typeof window !== 'undefined' && window.MeetingMediaRecording;
    if (!M || typeof M.stop !== 'function') {
      pushToast('録音モジュールが読み込まれていません', 'warn');
      setMeetingHud(null);
      return;
    }
    if (M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting()) {
      M.stop();
    } else {
      setMeetingHud(null);
    }
  };

  const beginSidebarResize = (e) => {
    if (!e || typeof e.clientX !== 'number') return;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    resizeStateRef.current = { active: true, moved: false, startX, startWidth };
    setSidebarResizeHint(true);
    const prevBodySelect = document.body.style.userSelect;
    const prevBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev) => {
      if (!resizeStateRef.current.active || !ev || typeof ev.clientX !== 'number') return;
      const dx = ev.clientX - resizeStateRef.current.startX;
      if (Math.abs(dx) > 3) resizeStateRef.current.moved = true;
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, Math.round(resizeStateRef.current.startWidth + dx)),
      );
      setSidebarWidth(next);
      if (sidebarCollapsed && next > SIDEBAR_MIN_WIDTH) setSidebarCollapsed(false);
    };
    const endResize = () => {
      const moved = resizeStateRef.current.moved;
      resizeStateRef.current.active = false;
      document.body.style.userSelect = prevBodySelect;
      document.body.style.cursor = prevBodyCursor;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      if (!moved) setSidebarCollapsed((v) => !v);
      setSidebarResizeHint(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  };

  return (
    <div
      className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}
      data-screen-label={active}
      style={{ gridTemplateColumns: sidebarCollapsed ? '0 minmax(0, 1fr)' : `${sidebarWidth}px minmax(0, 1fr)` }}
    >
      {bioGate.ready && bioGate.open && (
        <div
          className="bio-lock-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(10,9,8,0.92)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 20,
          }}
        >
          <Kamon size={56} color="var(--gold)" />
          <div style={{ fontSize: 18, fontWeight: 600 }} className="en-only">
            Unlock SHOGUN
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }} className="jp">
            SHOGUN を解除
          </div>
          <div className="s-field-hint" style={{ textAlign: 'center', maxWidth: 320, padding: '0 20px' }}>
            <span className="en-only">Continue with Touch ID or Face ID.</span>
            <span className="jp">Touch ID または Face ID で続行してください。</span>
          </div>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={async () => {
              const r = await executeAction(
                'auth.biometric.authenticate',
                { reason: 'Unlock SHOGUN' },
                { silentError: true },
              );
              if (r.ok && r.data?.ok) {
                setBioGate((g) => ({ ...g, open: false }));
              } else {
                pushToast(r.data?.message || '認証に失敗しました', 'error');
              }
            }}
          >
            <span className="en-only">Unlock with biometrics</span>
            <span className="jp">生体認証で解除</span>
          </button>
        </div>
      )}
      {meetingHud && (
        <div className="shogun-meeting-hud-host" role="status" aria-live="polite">
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              padding: '7px 6px 7px 14px',
              borderRadius: 999,
              border: '1px solid var(--border-hi)',
              background: 'color-mix(in srgb, var(--surface) 92%, #0a0a0a)',
              boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
              maxWidth: '100%',
              width: '100%',
              justifyContent: 'center',
              boxSizing: 'border-box',
            }}
          >
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexShrink: 0 }} aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 999,
                    background: 'var(--success)',
                    animation: 'mtgStripDotPulse 1.25s ease-in-out infinite',
                    animationDelay: `${i * 0.2}s`,
                  }}
                />
              ))}
            </span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 500,
                letterSpacing: '-0.02em',
                color: 'var(--text)',
                minWidth: 0,
                flex: '1 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-sans, system-ui, sans-serif)',
              }}
            >
              {meetingHud.title || 'Untitled'}
            </span>
            <span className="t-mono" style={{ fontSize: 11, color: 'var(--text-mute)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
              {fmtHudElapsed(meetingHud.startedAt)}
            </span>
            <button
              type="button"
              onClick={dismissMeetingHud}
              aria-label="Stop recording"
              title="録音を終了"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                borderRadius: 999,
                border: 'none',
                background: 'transparent',
                color: 'var(--text-mute)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}
      {/* Topbar */}
      <div className="topbar">
        <button
          type="button"
          className={'sidebar-toggle-btn' + (sidebarCollapsed ? ' collapsed' : '')}
          onClick={() => setSidebarCollapsed((v) => !v)}
          aria-label={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ'}
          title={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ'}
        >
          <span className="sidebar-toggle-glyph" aria-hidden="true">
            <span className="pane" />
            <span className="divider" />
          </span>
        </button>
        <div className="brand" onClick={()=>setActive('home')} style={{cursor:'pointer'}} title="Shogun AI · Home">
          <Kamon size={26} color="var(--text)"/>
          <div>
            <div className="brand-title en-only">Shogun AI</div>
            <div className="brand-jp jp">Shogun AI</div>
          </div>
        </div>
        <div
          className="cmdk"
          role="button"
          tabIndex={0}
          style={{ cursor: 'pointer' }}
          onClick={() => setActive('chat')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setActive('chat');
            }
          }}
        >
          <Icon name="search" size={14}/>
          <span className="cmdk-label">Open Chat…</span>
          <span className="kbd">⌘K</span>
        </div>
        <div className="right">
          {/* Hummingbird · favorite · share — chat screen only */}
          {active === 'chat' && (
          <div className="page-actions">
            <button
              className="page-action"
              onMouseEnter={()=>setShareTip('popout')}
              onMouseLeave={()=>setShareTip(null)}
              onClick={() => requestWriteAction(
                'app.open_hummingbird',
                { source:'topbar', activeScreen:active },
                'Open Hummingbird',
                'This triggers a native app-level action.'
              )}
            >
              <Icon name="popout" size={15}/>
              {shareTip==='popout' && <span className="tip">Open in Hummingbird</span>}
            </button>
            <button
              type="button"
              className={'page-action'+(favorited?' on':'')}
              onMouseEnter={()=>setShareTip('star')}
              onMouseLeave={()=>setShareTip(null)}
              onClick={(e) => {
                if (e.shiftKey) {
                  setFavorited((v) => !v);
                  return;
                }
                setHummingbirdOpen(true);
              }}
            >
              <Icon name="star" size={15}/>
              {shareTip==='star' && (
                <span className="tip">
                  <span className="en-only">Hummingbird · Shift+click to favorite</span>
                  <span className="jp">Hummingbird（Shift+お気に入り）</span>
                </span>
              )}
            </button>
            <button className={'page-action'+(shareOpen?' active':'')} onMouseEnter={()=>setShareTip('share')} onMouseLeave={()=>setShareTip(null)} onClick={()=>setShareOpen(v=>!v)}>
              <Icon name="upload" size={15}/>
              {shareTip==='share' && !shareOpen && <span className="tip">Share chat</span>}
            </button>
          </div>
          )}
        </div>
      </div>

      {/* Sidebar */}
      <div className="sidebar" data-screen-label="sidebar">
        {sections.map(sec => (
          <div key={sec.id}>
            {(sec.label || sec.jp) && (
              <div className="section-label"><span className="en-only">{sec.label}</span><span className="en-only"> · </span><span className="jp">{sec.jp}</span></div>
            )}
            {NAV.filter(n => n.section === sec.id).map(n => (
              <React.Fragment key={n.id}>
                <div className={'nav-item '+(active===n.id?'active':'')} onClick={() => setActive(n.id)}>
                  <Icon name={n.icon} size={16}/>
                  <span className="nav-label en-only">{n.label}</span>
                  {n.star && <span className="gold" style={{fontSize:8, marginLeft:-4}}>★</span>}
                  <span className="jp">{n.jp}</span>
                  {n.count && <span className="count">{n.count}</span>}
                </div>
                {/* Chat history sub-nav */}
                {n.id==='chat' && active==='chat' && (
                  <div className="chat-subnav">
                    <button
                      className="btn btn-sm btn-secondary"
                      style={{width:'calc(100% - 14px)', margin:'6px 7px 10px', justifyContent:'flex-start'}}
                      onClick={createNewChat}
                    ><Icon name="plus" size={12}/>New Chat</button>

                    {/* Favorites bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='fav'?'drop':'')}
                      data-chat-bucket="fav"
                    >
                      <button
                        type="button"
                        className="chat-subgroup chat-subgroup-header"
                        onClick={() => toggleChatGroup('favorite')}
                        aria-expanded={chatGroupsOpen.favorite}
                        aria-label="Toggle Favorite"
                      >
                        <span className="chat-subgroup-toggle" aria-hidden="true">
                          <Icon
                            name="chevronDown"
                            size={12}
                            style={{ transform: chatGroupsOpen.favorite ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                          />
                        </span>
                        <span className="en-only">Favorite</span>
                        <span className="jp" style={{marginLeft:6}}>お気に入り</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{favChats.length}</span>
                      </button>
                      {chatGroupsOpen.favorite && favChats.length===0 && (
                        <div className="chat-empty">
                          <span className="en-only">Drop a chat here</span>
                          <span className="jp">ここへ</span>
                        </div>
                      )}
                      {chatGroupsOpen.favorite && favChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openChatMenuAt(it.id, e.clientX, e.clientY);
                          }}
                          className={'chat-sub-item '+(activeChat===it.id?'active':'')+(dragId===it.id?' dragging':'')+(dragOver?.id===it.id?(' dz-'+dragOver.pos):'')}
                          onClick={() => {
                            if (suppressChatRowClickRef.current) {
                              suppressChatRowClickRef.current = false;
                              return;
                            }
                            setActiveChat(it.id);
                          }}
                          title={it.title}
                        >
                          <Icon name="grip" size={10} className="grip"/>
                          <span className="chat-sub-title">{it.title}</span>
                          <button
                            type="button"
                            draggable={false}
                            className="chat-row-menu-btn"
                            onClick={(e)=>{
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              openChatMenuAt(it.id, r.right - 6, r.bottom + 6);
                            }}
                            title="Chat options"
                            aria-label="Chat options"
                          >
                            <span className="chat-row-menu-dots" aria-hidden="true">⋮</span>
                          </button>
                        </div>
                      ))}
                    </div>

                    {/* All chats bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='chats'?'drop':'')}
                      data-chat-bucket="chats"
                    >
                      <button
                        type="button"
                        className="chat-subgroup chat-subgroup-header"
                        onClick={() => toggleChatGroup('chats')}
                        aria-expanded={chatGroupsOpen.chats}
                        aria-label="Toggle Chats"
                      >
                        <span className="chat-subgroup-toggle" aria-hidden="true">
                          <Icon
                            name="chevronDown"
                            size={12}
                            style={{ transform: chatGroupsOpen.chats ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                          />
                        </span>
                        <span className="en-only">Chats</span>
                        <span className="jp" style={{marginLeft:6}}>対話</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{restChats.length}</span>
                      </button>
                      {chatGroupsOpen.chats && restChats.length === 0 && (
                        <div className="chat-empty" style={{padding:'6px 10px 10px'}}>
                          <span className="en-only">New Chat to start</span>
                          <span className="jp">新しい対話</span>
                        </div>
                      )}
                      {chatGroupsOpen.chats && restChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openChatMenuAt(it.id, e.clientX, e.clientY);
                          }}
                          className={'chat-sub-item '+(activeChat===it.id?'active':'')+(dragId===it.id?' dragging':'')+(dragOver?.id===it.id?(' dz-'+dragOver.pos):'')}
                          onClick={() => {
                            if (suppressChatRowClickRef.current) {
                              suppressChatRowClickRef.current = false;
                              return;
                            }
                            setActiveChat(it.id);
                          }}
                          title={it.title}
                        >
                          <Icon name="grip" size={10} className="grip"/>
                          <span className="chat-sub-title">{it.title}</span>
                          <button
                            type="button"
                            draggable={false}
                            className="chat-row-menu-btn"
                            onClick={(e)=>{
                              e.stopPropagation();
                              const r = e.currentTarget.getBoundingClientRect();
                              openChatMenuAt(it.id, r.right - 6, r.bottom + 6);
                            }}
                            title="Chat options"
                            aria-label="Chat options"
                          >
                            <span className="chat-row-menu-dots" aria-hidden="true">⋮</span>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
          </div>
        ))}

        {/* System section removed — items live under Workspace */}
        <div className="spacer" style={{flex:1}}/>

        {/* User cluster */}
        <div className="user-cluster">
          <button
            type="button"
            ref={contextBtnRef}
            className="context-enabled-pill"
            aria-live="polite"
            aria-expanded={contextPanelOpen}
            onClick={openContextPanel}
          >
            <span className="en-only">Context enabled</span>
            <span className="jp">コンテキスト有効</span>
            <span className="context-enabled-dot" aria-hidden="true" />
          </button>
          <div className="user-row local-preview-row">
            <span className="s-field-hint local-preview-label" style={{fontSize:10}}><span className="en-only">Local preview</span><span className="jp">ローカルプレビュー</span></span>
          </div>
          <div ref={userBtnRef} className="user-row user-pill" onClick={openUser}>
            <div
              className="avatar"
              style={{
                width: 26,
                height: 26,
                fontSize: 11,
                overflow: 'hidden',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {isProfilePhotoDataUrl(profileAvatarImageDataUrl) ? (
                <img
                  src={profileAvatarImageDataUrl}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                shellAvatarChar(profileAvatarGlyph, profileDisplayName)
              )}
            </div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {profileDisplayName.trim() || 'You'}
              </div>
              <div className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>LOCAL</div>
            </div>
            <Icon name={userOpen?'chevronDown':'chevronRight'} size={11} className="dim"/>
          </div>
        </div>
      </div>
      <button
        type="button"
        className={'sidebar-resizer' + (sidebarResizeHint ? ' show-hint' : '')}
        aria-label="Sidebar width resizer"
        style={{ left: (sidebarCollapsed ? 0 : sidebarWidth) - 3 }}
        onMouseEnter={() => setSidebarResizeHint(true)}
        onMouseLeave={() => {
          if (!resizeStateRef.current.active) setSidebarResizeHint(false);
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          beginSidebarResize(e);
        }}
      >
        <span className="sidebar-resizer-hit" />
        {sidebarResizeHint && (
          <span className="sidebar-resizer-tip">
            クリックして折りたたむ <span className="sidebar-resizer-kbd">⌘B</span>
            <br />
            ドラッグしてサイズ変更
          </span>
        )}
      </button>

      {/* Content — chat needs a flex column parent so L3 fills the viewport */}
      <div
        className={
          'content' +
          (active === 'chat' ? ' content-chat' : '') +
          (active === 'meetings' ? ' content-meetings' : '')
        }
      >
        <Screen/>
      </div>

      {/* Share modal — portaled so it is not clipped by .app overflow */}
      {shareOpen && ReactDOM.createPortal(
        <>
          <div
            role="presentation"
            style={{ position: 'fixed', inset: 0, zIndex: 1120 }}
            onMouseDown={(e) => {
              e.preventDefault();
              setShareOpen(false);
            }}
          />
          <div className="share-modal" onMouseDown={(e) => e.stopPropagation()}>
            <div style={{fontSize:18, fontWeight:600, marginBottom:4}}>
              <span className="en-only">Share chat</span>
              <span className="jp" style={{marginLeft:8, fontSize:14, color:'var(--text-mute)'}}>共有</span>
            </div>
            <div style={{fontSize:13, color:'var(--text-mute)', marginBottom:18}}>Only messages up until now will be shared</div>
            <div className="share-choices">
              <div className={'share-choice '+(shareMode==='private'?'on':'')} onClick={()=>setShareMode('private')}>
                <Icon name="lock" size={18} className={shareMode==='private'?'gold':'dim'}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:14, fontWeight:500}}>
                    Private
                    <span className="jp" style={{marginLeft:8, fontSize:11, color:'var(--text-dim)'}}>非公開</span>
                  </div>
                  <div style={{fontSize:12, color:'var(--text-mute)', marginTop:2}}>Only you have access</div>
                </div>
                {shareMode==='private' && <Icon name="check" size={16} className="gold"/>}
              </div>
              <div className={'share-choice '+(shareMode==='public'?'on':'')} onClick={()=>setShareMode('public')}>
                <Icon name="globe" size={18} className={shareMode==='public'?'gold':'dim'}/>
                <div style={{flex:1}}>
                  <div style={{fontSize:14, fontWeight:500}}>
                    Public access
                    <span className="jp" style={{marginLeft:8, fontSize:11, color:'var(--text-dim)'}}>公開</span>
                  </div>
                  <div style={{fontSize:12, color:'var(--text-mute)', marginTop:2}}>Anyone with the link can view</div>
                </div>
                {shareMode==='public' && <Icon name="check" size={16} className="gold"/>}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{width:'100%', marginTop:18, height:'var(--control-lg)', fontSize:'var(--text-md)'}}
              onClick={async () => {
                const chatTitle = chats.find(c => c.id === activeChat)?.title || 'Untitled chat';
                const res = await executeAction('app.create_share_link', {
                  mode: shareMode,
                  chatId: activeChat,
                  title: chatTitle,
                  markdown: `Shared chat: **${chatTitle}**\n\n(Transcript is not attached in this export; use Chat on desktop for full history.)`,
                }, { successMessage:'Chat exported to file' });
                if (res.ok && !res.data?.cancelled) setShareOpen(false);
              }}
            >
              <Icon name="link" size={14}/> Export to file…
            </button>
          </div>
        </>,
        document.body,
      )}

      {hummingbirdOpen && ReactDOM.createPortal(
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1130,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
            background: 'rgba(10, 9, 8, 0.58)',
            boxSizing: 'border-box',
          }}
          onMouseDown={() => setHummingbirdOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="hummingbird-title"
            className="hummingbird-panel"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="hummingbird-panel-head">
              <button
                type="button"
                className="hummingbird-close"
                aria-label="Close"
                onClick={() => setHummingbirdOpen(false)}
              >
                <Icon name="x" size={16} />
              </button>
              <h2 id="hummingbird-title" className="hummingbird-title">
                <span className="en-only">Today&apos;s Priorities</span>
                <span className="jp">今日の優先</span>
              </h2>
              <span className="hummingbird-actions-hint t-mono">
                <span className="en-only">Actions</span>
                <span className="jp">操作</span>
                {' '}
                <span className="kbd">⌘K</span>
              </span>
            </div>
            <div className="hummingbird-scroll">
              <p className="hummingbird-p">
                <span className="en-only">
                  Data backup deadlines and plan reviews are coming up—block time on your calendar so nothing slips.
                </span>
                <span className="jp">
                  データバックアップの期限やプラン確認が近づいています。カレンダーに時間を確保して取りこぼしを防ぎましょう。
                </span>
              </p>
              <ul className="hummingbird-ul">
                <li>
                  <strong>求人・案件情報:</strong>{' '}
                  <span className="en-only">
                    AI lead engineer roles and executive positions surfaced on LinkedIn and YOUTRUST—worth a skim.
                  </span>
                  <span className="jp">
                    LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。ざっと確認する価値ありです。
                  </span>
                </li>
              </ul>
              <hr className="hummingbird-rule" />
              <p className="hummingbird-p">
                <strong>Hummingbirdからの提案:</strong>
              </p>
              <p className="hummingbird-p">
                <span className="en-only">
                  From your calendar, the <strong>15:00</strong> slot lines up with a match—consider pairing it with light technical
                  research into <strong>Lovable</strong> or <strong>Railway</strong> for the <strong>SHOGUN</strong> build.
                </span>
                <span className="jp">
                  カレンダーでは <strong>15時</strong> 前後が空いています。{' '}
                  <strong>SHOGUN</strong> 向けに <strong>Lovable</strong> や <strong>Railway</strong> の技術調査を軽く挟むのはどうでしょう。
                </span>
              </p>
              <p className="hummingbird-p hummingbird-muted">
                <span className="en-only">Are there any specific tasks you want to proceed with first?</span>
                <span className="jp">まず手を付けたいタスクはありますか？</span>
              </p>
            </div>
            <div className="hummingbird-feedback">
              <button
                type="button"
                className="hummingbird-icon-btn"
                title="Copy"
                aria-label="Copy"
                onClick={() => {
                  const ja = tweaks.language === 'jp';
                  const text = ja
                    ? [
                        'データバックアップの期限やプラン確認が近づいています。',
                        '',
                        '求人・案件情報: LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。',
                        '',
                        'Hummingbirdからの提案: カレンダーでは 15時 前後が空いています。SHOGUN 向けに Lovable や Railway の技術調査を軽く挟むのはどうでしょう。',
                        '',
                        'まず手を付けたいタスクはありますか？',
                      ].join('\n')
                    : [
                        'Data backup deadlines and plan reviews are coming up.',
                        '',
                        'Job leads: AI lead engineer and executive roles on LinkedIn and YOUTRUST.',
                        '',
                        'Hummingbird proposal: the 15:00 slot fits—consider research into Lovable or Railway for SHOGUN.',
                        '',
                        'Any specific tasks you want to proceed with first?',
                      ].join('\n');
                  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(text).then(
                      () => pushToastRef.current(ja ? 'コピーしました' : 'Copied', 'success'),
                      () => pushToastRef.current(ja ? 'コピーに失敗しました' : 'Copy failed', 'error'),
                    );
                  }
                }}
              >
                <Icon name="copy" size={15} />
              </button>
              <button type="button" className="hummingbird-icon-btn" title="Good response" aria-label="Good response">
                <Icon name="thumbsUp" size={15} />
              </button>
              <button type="button" className="hummingbird-icon-btn" title="Bad response" aria-label="Bad response">
                <Icon name="thumbsDown" size={15} />
              </button>
            </div>
            <div className="hummingbird-composer">
              <input
                type="text"
                className="hummingbird-input"
                placeholder="Ask anything…"
                value={hummingbirdInput}
                onChange={(e) => setHummingbirdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if ((hummingbirdInput || '').trim()) {
                      pushToastRef.current(
                        tweaks.language === 'jp' ? '送信（プレビュー）' : 'Send (preview)',
                        'info',
                      );
                      setHummingbirdInput('');
                    }
                  }
                }}
                aria-label="Ask Hummingbird"
              />
              <button
                type="button"
                className="hummingbird-send"
                aria-label="Send"
                onClick={() => {
                  if ((hummingbirdInput || '').trim()) {
                    pushToastRef.current(
                      tweaks.language === 'jp' ? '送信（プレビュー）' : 'Send (preview)',
                      'info',
                    );
                    setHummingbirdInput('');
                  }
                }}
              >
                <Icon name="arrowUp" size={16} />
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* User floating menu — portaled for correct hit-testing over the shell */}
      {userOpen && ReactDOM.createPortal(
        <>
          <div
            role="presentation"
            style={{ position: 'fixed', inset: 0, zIndex: 1080 }}
            onMouseDown={() => setUserOpen(false)}
          />
          <div
            className="user-float"
            style={{ left: userAnchor.left, bottom: userAnchor.bottom, width: userAnchor.width }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="user-float-head">
              <div style={{fontSize:13, color:'var(--text-dim)'}}>
                {profileDisplayName.trim() || 'You'}
              </div>
            </div>
            <div className="user-float-section">
              <div className="user-float-row" onClick={()=>{setSettingsOpen('general'); setUserOpen(false);}}>
                <Icon name="settings" size={16}/><span className="en-only">Settings</span><span className="jp">設定</span>
                <span className="spacer"/><span className="kbd-mini">⌘,</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('download'); setUserOpen(false);}}>
                <Icon name="download" size={16}/><span className="en-only">Download Mobile App</span><span className="jp">モバイルアプリ</span>
              </div>
            </div>
            <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('feedback'); setUserOpen(false);}}>
                <Icon name="chat" size={16}/><span className="en-only">Give Feedback</span><span className="jp">フィードバック</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('support'); setUserOpen(false);}}>
                <Icon name="info" size={16}/><span className="en-only">Help Center</span><span className="jp">ヘルプ</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('changelog'); setUserOpen(false);}}>
                <Icon name="clock" size={16}/><span className="en-only">Changelog</span><span className="jp">更新履歴</span>
              </div>
              <div className="user-float-row gold" onClick={()=>{setSettingsOpen('referral'); setUserOpen(false);}}>
                <Icon name="gift" size={16}/><span className="en-only">Get 2 Months Free</span><span className="jp">2か月無料</span>
              </div>
            </div>
            <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
              <div className="user-float-row" style={{color:'var(--text-mute)'}}>
                <Icon name="logout" size={16}/><span className="en-only">Logout</span><span className="jp">ログアウト</span>
              </div>
            </div>
            {/* Profile chip at bottom, like reference */}
            <div className="user-float-profile">
              <div
                className="avatar"
                style={{ overflow: 'hidden', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {isProfilePhotoDataUrl(profileAvatarImageDataUrl) ? (
                  <img
                    src={profileAvatarImageDataUrl}
                    alt=""
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  shellAvatarChar(profileAvatarGlyph, profileDisplayName)
                )}
              </div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:12, fontWeight:500}}>{profileDisplayName.trim() || 'You'}</div>
                <div style={{fontSize:10, color:'var(--text-dim)'}}>Pro · Local</div>
              </div>
            </div>
          </div>
        </>,
        document.body,
      )}

      {contextPanelOpen && ReactDOM.createPortal(
        <>
          <div
            role="presentation"
            style={{ position: 'fixed', inset: 0, zIndex: 1078 }}
            onMouseDown={() => setContextPanelOpen(false)}
          />
          <div
            className="context-panel"
            style={{ left: contextPanelAnchor.left, bottom: contextPanelAnchor.bottom, width: contextPanelAnchor.width }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="context-panel-title">Data and Privacy</div>
            <div className="context-awareness-card">
              <button type="button" className="context-awareness-close" onClick={() => setContextPanelOpen(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
              <div style={{ fontSize: 22, fontWeight: 520, marginBottom: 6 }}>Context Awareness</div>
              <div className="context-panel-body-copy">
                Littlebird remembers your work across apps,
                <br />
                no integrations needed.
              </div>
              <button type="button" className="context-link-btn" onClick={() => { setSettingsOpen('privacy'); setContextPanelOpen(false); }}>
                Learn more <Icon name="arrowUpRight" size={14} />
              </button>
            </div>
            <button type="button" className="context-panel-row" onClick={() => { setSettingsOpen('privacy'); setContextPanelOpen(false); }}>
              <span>Pause Context Awareness</span>
              <Icon name="chevronRight" size={14} />
            </button>
            <button type="button" className="context-panel-row" onClick={() => { setSettingsOpen('data'); setContextPanelOpen(false); }}>
              <span>Delete Data</span>
              <Icon name="chevronRight" size={14} />
            </button>
            <div className="context-panel-foot">
              <span className="context-panel-body-copy" style={{ fontSize: 14 }}>
                Exclude apps and websites Littlebird
                <br />
                can access context from
              </span>
              <button type="button" className="context-manage-btn" onClick={() => { setSettingsOpen('privacy'); setContextPanelOpen(false); }}>
                Manage
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}

      {chatMenu.open && ReactDOM.createPortal(
        <>
          <div
            role="presentation"
            style={{ position:'fixed', inset:0, zIndex:1090 }}
            onMouseDown={closeChatMenu}
          />
          <div
            className="chat-row-menu"
            style={{ left: chatMenu.x, top: chatMenu.y, width: chatMenu.width }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button type="button" className="chat-row-menu-item" onClick={() => runChatMenuAction('pin', chatMenu.chatId)}>
              <Icon name="pin" size={16}/>
              <span>{chatMenuTarget?.favorite ? 'Favoriteから外す' : 'Favoriteに追加'}</span>
            </button>
            <button type="button" className="chat-row-menu-item" onClick={() => runChatMenuAction('rename', chatMenu.chatId)}>
              <Icon name="edit" size={16}/>
              <span>名前を変更</span>
            </button>
            <button type="button" className="chat-row-menu-item" onClick={() => runChatMenuAction('work', chatMenu.chatId)}>
              <Icon name="folder" size={16}/>
              <span>Workに追加</span>
            </button>
            {chatMenuTargetWork && (
              <button type="button" className="chat-row-menu-item" onClick={() => runChatMenuAction('workArchive', chatMenu.chatId)}>
                <Icon name={chatMenuTargetWork.archived === true ? 'eye' : 'folder'} size={16}/>
                <span>{chatMenuTargetWork.archived === true ? 'Workを復元' : 'Workをアーカイブ'}</span>
              </button>
            )}
            <div className="chat-row-menu-sep"/>
            <button type="button" className="chat-row-menu-item danger" onClick={() => runChatMenuAction('delete', chatMenu.chatId)}>
              <Icon name="trash" size={16}/>
              <span>削除</span>
            </button>
          </div>
        </>,
        document.body,
      )}

      {chatDeleteModal.open && ReactDOM.createPortal(
        <div className="chat-modal-backdrop" role="presentation" onMouseDown={() => setChatDeleteModal({ open:false, chatId:null })}>
          <div className="chat-dialog" role="dialog" aria-modal="true" aria-label="チャット削除確認" onMouseDown={(e) => e.stopPropagation()}>
            <div className="chat-dialog-title">チャットを削除</div>
            <div className="chat-dialog-desc">
              {chatDeleteTarget ? `「${chatDeleteTarget.title}」を削除してもよろしいですか？` : 'このチャットを削除してもよろしいですか？'}
            </div>
            <div className="chat-dialog-actions">
              <button type="button" className="chat-dialog-btn ghost" onClick={() => setChatDeleteModal({ open:false, chatId:null })}>Cancel</button>
              <button type="button" className="chat-dialog-btn danger" onClick={confirmDeleteChat}>削除</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {chatRenameModal.open && ReactDOM.createPortal(
        <div className="chat-modal-backdrop" role="presentation" onMouseDown={() => setChatRenameModal({ open:false, chatId:null, value:'' })}>
          <div className="chat-dialog rename" role="dialog" aria-modal="true" aria-label="チャット名変更" onMouseDown={(e) => e.stopPropagation()}>
            <div className="chat-dialog-title small">チャットの名前を変更</div>
            <input
              type="text"
              className="chat-dialog-input"
              value={chatRenameModal.value}
              autoFocus
              onChange={(e) => setChatRenameModal((s) => ({ ...s, value: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRenameModal();
                if (e.key === 'Escape') setChatRenameModal({ open:false, chatId:null, value:'' });
              }}
            />
            <div className="chat-dialog-actions">
              <button type="button" className="chat-dialog-btn ghost" onClick={() => setChatRenameModal({ open:false, chatId:null, value:'' })}>キャンセル</button>
              <button type="button" className="chat-dialog-btn solid" onClick={submitRenameModal}>保存</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {chatWorkModal.open && ReactDOM.createPortal(
        <div className="chat-modal-backdrop" role="presentation" onMouseDown={() => setChatWorkModal({ open:false, chatId:null, query:'' })}>
          <div className="chat-dialog work" role="dialog" aria-modal="true" aria-label="Workに追加" onMouseDown={(e) => e.stopPropagation()}>
            <button type="button" className="chat-dialog-close" onClick={() => setChatWorkModal({ open:false, chatId:null, query:'' })} aria-label="閉じる">
              <Icon name="x" size={16}/>
            </button>
            <div className="chat-dialog-title">チャットを移動</div>
            <div className="chat-dialog-desc">このチャットを移動するプロジェクトを選択してください。</div>
            <div className="work-search-wrap">
              <Icon name="search" size={16}/>
              <input
                type="text"
                className="work-search-input"
                placeholder="プロジェクトを検索または作成"
                value={chatWorkModal.query}
                autoFocus
                onChange={(e) => setChatWorkModal((s) => ({ ...s, query: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (filteredWorkProjects[0]) assignChatToWork(filteredWorkProjects[0].id, filteredWorkProjects[0].name);
                    else createAndAssignWork();
                  }
                }}
              />
            </div>
            <div className="work-list">
              {filteredWorkProjects.map((p) => (
                <button key={p.id} type="button" className="work-list-item" onClick={() => assignChatToWork(p.id, p.name)}>
                  <Icon name="folder" size={16}/>
                  <span>{p.name}</span>
                </button>
              ))}
              {filteredWorkProjects.length === 0 && (
                <button type="button" className="work-list-item create" onClick={createAndAssignWork}>
                  <Icon name="plus" size={16}/>
                  <span>「{chatWorkModal.query.trim()}」を作成して追加</span>
                </button>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* Settings modal — floating with semi-transparent backdrop */}
      {settingsOpen && (
        <SettingsModal
          pane={settingsOpen}
          setPane={setSettingsOpen}
          close={() => {
            setSettingsOpen(null);
            (async () => {
              const r = await executeAction('settings.load', {}, { silentError: true });
              if (r.ok && r.data?.settings?.sections) {
                const sec = r.data.settings.sections;
                applySavedAppearance(sec);
                const p = profileStateFromSections(sec);
                setProfileDisplayName(p.name);
                setProfileAvatarGlyph(p.avatarGlyph);
                setProfileAvatarImageDataUrl(p.avatarImageDataUrl);
              }
            })();
          }}
        />
      )}

      <WriteModal
        open={writeConfirm.open}
        title={writeConfirm.title}
        description={writeConfirm.description}
        actionName={writeConfirm.actionKey}
        payload={writeConfirm.payload}
        pending={writePending}
        onCancel={() => setWriteConfirm({ open:false, actionKey:null, payload:null, title:null, description:null })}
        onConfirm={async () => {
          if (!writeConfirm.actionKey) return;
          const actionKey = writeConfirm.actionKey;
          const payload = writeConfirm.payload;
          setWritePending(true);
          const res = await executeAction(actionKey, payload, { successMessage:'Action completed' });
          setWritePending(false);
          setWriteConfirm({ open:false, actionKey:null, payload:null, title:null, description:null });
          if (actionKey === 'memory.delete' && res && res.ok) {
            window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
          }
        }}
      />

      {toast && (
        <div className={'app-toast '+toast.kind}>{toast.message}</div>
      )}

      {/* System floating menu removed */}

      {/* Tweaks */}
      <div id="tweaks-panel" className={editMode?'show':''}>
        <h6>TWEAKS · 調整 <Kamon size={12} color="var(--gold)"/></h6>
        <div className="tweak-row">
          <label>Language</label>
          <select value={tweaks.language} onChange={e=>update('language', e.target.value)}>
            <option value="en">English</option>
            <option value="jp">日本語</option>
            <option value="bi">Bilingual</option>
          </select>
        </div>
        <div className="tweak-row">
          <label>Accent density</label>
          <select value={tweaks.accentDensity} onChange={e=>update('accentDensity', e.target.value)}>
            <option value="minimal">Minimal</option>
            <option value="standard">Standard</option>
            <option value="rich">Rich</option>
          </select>
        </div>
        <div className="tweak-row">
          <label>Gold intensity</label>
          <select value={tweaks.goldIntensity} onChange={e=>update('goldIntensity', e.target.value)}>
            <option value="muted">Muted</option>
            <option value="standard">Standard</option>
            <option value="bright">Bright</option>
          </select>
        </div>
        <div className="tweak-row">
          <label>Dot-grid background</label>
          <div className={'switch '+(tweaks.dotGrid?'on':'')} onClick={()=>update('dotGrid', !tweaks.dotGrid)}/>
        </div>
      </div>

      <style>{`
        /* EN only: hide all JP flourishes */
        body[data-lang=en] .jp, body[data-lang=en] .brand-jp { display:none !important; }
        /* JP only: hide EN-marked elements, keep JP */
        body[data-lang=jp] .en-only { display:none !important; }
        body[data-gold=muted] { --gold:#A88F5F; --gold-hover:#B89C6A; }
        body[data-gold=bright] { --gold:#D9BC7F; --gold-hover:#E5C88C; }
        /* Minimal: hide redundant EN label only when JP line is visible (EN+minimal would hide both). */
        body[data-density=minimal][data-lang=jp] .sidebar .nav-item .nav-label { display:none; }
        body[data-density=minimal][data-lang=bi] .sidebar .nav-item .nav-label { display:none; }
        body[data-density=rich] .nav-item { padding:10px 12px; }
        .lang-pill { min-width:44px; font-family:var(--font-mono); font-size:11px; letter-spacing:0.08em; padding:0 10px; }

        /* Chat sub-nav under Chat */
        .chat-subnav { margin:2px 0 8px 8px; padding-left:10px; border-left:1px solid var(--border); }
        .chat-subgroup { padding:10px 0 4px 8px; font-size:12px; display:flex; align-items:center; gap:4px; color:var(--text-dim); }
        .chat-subgroup-header {
          width:100%;
          border:0;
          background:transparent;
          cursor:pointer;
          text-align:left;
          border-radius:6px;
          padding-right:6px;
        }
        .chat-subgroup-header:hover { color:var(--text); background:var(--surface-1); }
        .chat-subgroup-toggle {
          width:16px; height:16px; min-width:16px;
          background:transparent; color:var(--text-dim);
          border-radius:4px; display:flex; align-items:center; justify-content:center;
          padding:0; margin-right:2px;
        }
        .chat-subgroup-header:hover .chat-subgroup-toggle { color:var(--text); background:var(--surface-2); }
        body.chat-reorder-active { user-select:none; -webkit-user-select:none; cursor:grabbing; }
        body.chat-reorder-active .chat-sub-item { cursor:grabbing; }
        .chat-bucket { border-radius:var(--radius-sm); padding:2px 0 6px; transition:background 120ms; }
        .chat-bucket.drop { background:color-mix(in srgb, var(--gold) 8%, transparent); outline:1px dashed var(--gold-dim); }
        .chat-empty { padding:10px 10px; font-size:11px; color:var(--text-dim); font-style:italic; }
        .chat-empty .jp { margin-left:6px; font-size:10px; }
        .chat-sub-item { position:relative; -webkit-user-drag:none; }
        .chat-sub-item .grip { opacity:0; color:var(--text-dim); cursor:grab; margin-right:-2px; transition:opacity 120ms; }
        .chat-sub-item:hover .grip { opacity:0.5; }
        .chat-sub-item.dragging { opacity:0.4; }
        .chat-sub-item .dot-fav { font-size:8px; }
        .chat-sub-item.dz-before::before, .chat-sub-item.dz-after::after {
          content:''; position:absolute; left:6px; right:6px; height:2px;
          background:var(--gold); border-radius:1px;
        }
        .chat-sub-item.dz-before::before { top:-1px; }
        .chat-sub-item.dz-after::after { bottom:-1px; }
        .chat-sub-item { display:flex; align-items:center; gap:6px; padding:6px 6px; margin:1px 0; border-radius:var(--radius-sm); cursor:pointer; color:var(--text-mute); font-size:12px; }
        .chat-sub-item:hover { background:var(--surface-2); color:var(--text); }
        .chat-sub-item.active { background:var(--surface-2); color:var(--text); }
        .chat-sub-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
        .chat-row-menu-btn {
          width:16px; height:20px; min-width:16px;
          border:0; background:transparent; color:var(--text-dim);
          border-radius:6px; display:flex; align-items:center; justify-content:center;
          cursor:pointer; opacity:0.3; transition:opacity 120ms, color 120ms, background 120ms;
        }
        .chat-row-menu-dots {
          font-size:14px;
          line-height:1;
          transform: translateY(-0.5px);
        }
        .chat-sub-item:hover .chat-row-menu-btn, .chat-row-menu-btn:focus-visible { opacity:1; }
        .chat-row-menu-btn:hover { color:var(--text); background:var(--surface-2); }
        .chat-row-menu {
          position:fixed; z-index:1091;
          padding:4px;
          border-radius:var(--radius-lg);
          background:var(--surface);
          border:1px solid var(--border-hi);
          box-shadow:0 24px 48px -12px rgba(0,0,0,0.6), 0 2px 0 rgba(0,0,0,0.3);
          overflow:hidden;
        }
        .chat-row-menu-item {
          width:100%; border:0; background:transparent; color:var(--text);
          font-size:12.5px;
          display:flex; align-items:center; gap:10px;
          padding:7px 10px; border-radius:var(--radius-sm); cursor:pointer; text-align:left;
        }
        .chat-row-menu-item span { font-size:12.5px; line-height:1.2; }
        .chat-row-menu-item:hover { background:var(--surface-2); }
        .chat-row-menu-item.danger { color:var(--danger-soft); }
        .chat-row-menu-item.danger:hover { background:color-mix(in srgb, var(--danger-soft) 10%, transparent); }
        .chat-row-menu-sep { height:1px; background:var(--border); margin:4px; }
        .chat-modal-backdrop {
          position:fixed; inset:0; z-index:1120;
          background:rgba(5, 6, 9, 0.56);
          backdrop-filter: blur(1.5px);
          display:flex; align-items:center; justify-content:center;
          padding:18px;
        }
        .chat-dialog {
          width:min(620px, calc(100vw - 36px));
          background:color-mix(in srgb, var(--surface) 90%, #272727 10%);
          border:1px solid var(--border-hi);
          border-radius:24px;
          box-shadow:0 30px 70px -12px rgba(0,0,0,0.7), 0 4px 14px rgba(0,0,0,0.35);
          padding:34px 38px 30px;
          position:relative;
        }
        .chat-dialog.rename { width:min(560px, calc(100vw - 36px)); border-radius:16px; padding:24px 22px 18px; }
        .chat-dialog.work { width:min(760px, calc(100vw - 36px)); border-radius:22px; padding:30px 28px 24px; }
        .chat-dialog-title {
          font-size:21px; line-height:1.2; letter-spacing:-0.01em; color:var(--text); font-weight:600;
        }
        .chat-dialog.rename .chat-dialog-title { font-size:18px; letter-spacing:0; }
        .chat-dialog.work .chat-dialog-title { font-size:42px; line-height:1.08; letter-spacing:-0.02em; }
        .chat-dialog-desc {
          margin-top:14px; color:var(--text-dim); font-size:14px; line-height:1.45;
        }
        .chat-dialog-actions {
          margin-top:30px; display:flex; gap:12px; justify-content:flex-end;
        }
        .chat-dialog-btn {
          min-width:122px; height:52px; border-radius:14px; border:1px solid transparent;
          cursor:pointer; font-size:16px; font-weight:550; color:var(--text);
          background:var(--surface-2);
        }
        .chat-dialog-btn.ghost { border-color:var(--border-hi); background:transparent; }
        .chat-dialog-btn.solid { background:var(--text); color:var(--bg); }
        .chat-dialog-btn.danger { background:var(--danger); color:var(--white); }
        .chat-dialog-input {
          width:100%; margin-top:14px; height:50px; border-radius:12px;
          border:1px solid color-mix(in srgb, var(--gold) 35%, var(--border-hi));
          background:color-mix(in srgb, var(--surface-2) 86%, #101010 14%);
          color:var(--text); font-size:14px; padding:0 14px;
          outline:none;
        }
        .chat-dialog-input:focus {
          border-color:var(--gold);
          box-shadow:0 0 0 2px color-mix(in srgb, var(--gold) 30%, transparent);
        }
        .chat-dialog-close {
          position:absolute; right:18px; top:16px; width:30px; height:30px;
          border:0; background:transparent; color:var(--text-dim); border-radius:8px; cursor:pointer;
          display:flex; align-items:center; justify-content:center;
        }
        .chat-dialog-close:hover { color:var(--text); background:var(--surface-2); }
        .work-search-wrap {
          margin-top:18px; height:56px; border-radius:14px;
          border:1px solid var(--border);
          display:flex; align-items:center; gap:10px; padding:0 14px;
          color:var(--text-dim); background:var(--surface-2);
        }
        .work-search-input {
          flex:1; min-width:0; border:0; background:transparent; outline:none; color:var(--text); font-size:17px;
        }
        .work-list {
          margin-top:0; border:1px solid var(--border); border-top:0;
          border-radius:0 0 14px 14px; overflow:auto; max-height:320px; background:var(--surface);
        }
        .work-list-item {
          width:100%; border:0; border-top:1px solid color-mix(in srgb, var(--border) 85%, transparent);
          background:transparent; color:var(--text); cursor:pointer; text-align:left;
          display:flex; align-items:center; gap:12px; padding:13px 14px; font-size:16px;
        }
        .work-list-item:first-child { border-top:0; }
        .work-list-item:hover { background:var(--surface-2); }
        .work-list-item.create { color:var(--gold); }

        /* Floating system menu */
        .system-float {
          position:fixed;
          width:240px;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:var(--radius-md);
          box-shadow:0 18px 40px -8px rgba(0,0,0,0.6), 0 2px 6px rgba(0,0,0,0.3);
          padding:4px 0 4px;
          animation: sysFloatIn 140ms var(--ease-out);
        }
        @keyframes sysFloatIn {
          from { opacity:0; transform: translateX(-4px) translateY(2px); }
          to { opacity:1; transform: translateX(0) translateY(0); }
        }

        /* Topbar page actions */
        .page-actions { display:flex; align-items:center; gap:4px; padding:4px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-md); }
        .page-action {
          position:relative; width:30px; height:28px;
          display:flex; align-items:center; justify-content:center;
          background:transparent; border:0; color:var(--text-mute); cursor:pointer;
          border-radius:var(--radius-sm); transition:all 120ms;
        }
        .page-action:hover { background:var(--surface-2); color:var(--text); }
        .page-action.on, .page-action.active { color:var(--gold); background:var(--surface-2); }
        .page-action .tip {
          position:absolute; top:calc(100% + 8px); right:0;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:var(--radius-sm); padding:5px 10px;
          font-size:11px; color:var(--text); white-space:nowrap;
          box-shadow:0 6px 16px rgba(0,0,0,0.4); z-index:60;
          pointer-events:none;
        }

        /* Sidebar toggle (left of the brand) */
        .sidebar-toggle-btn {
          display:inline-flex; align-items:center; justify-content:center;
          width:32px; height:32px;
          margin-right:4px;
          padding:0;
          border:1px solid transparent;
          border-radius:var(--radius-sm);
          background:transparent;
          color:var(--text-mute);
          cursor:pointer;
          transition:background 120ms, color 120ms, border-color 120ms;
        }
        .sidebar-toggle-btn:hover {
          color:var(--text);
          background:var(--surface);
          border-color:var(--border);
        }
        .sidebar-toggle-btn:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .sidebar-toggle-glyph {
          position:relative;
          display:inline-block;
          width:16px; height:14px;
          border:1.5px solid currentColor;
          border-radius:3px;
        }
        .sidebar-toggle-glyph .pane {
          position:absolute; inset:0 auto 0 0;
          width:5px;
          background:currentColor;
          border-top-left-radius:1.5px;
          border-bottom-left-radius:1.5px;
          opacity:0.9;
        }
        .sidebar-toggle-glyph .divider {
          position:absolute; top:1px; bottom:1px; left:5px;
          width:1.5px;
          background:currentColor;
          opacity:0.5;
        }
        .sidebar-toggle-btn.collapsed .sidebar-toggle-glyph .pane { opacity:0.35; }

        /* Sidebar resizer — pulled out of the grid flow so it never steals a cell */
        .app { position:relative; }
        .sidebar-resizer {
          position:absolute;
          top:56px;
          bottom:0;
          width:6px;
          padding:0;
          border:0;
          background:transparent;
          cursor:col-resize;
          z-index:40;
          display:block;
        }
        .app.sidebar-collapsed .sidebar-resizer { display:none; }
        .sidebar-resizer-hit {
          position:absolute; inset:0;
          background:transparent;
        }
        .sidebar-resizer:hover .sidebar-resizer-hit,
        .sidebar-resizer.show-hint .sidebar-resizer-hit {
          background:color-mix(in srgb, var(--gold) 35%, transparent);
        }
        .sidebar-resizer-tip {
          position:absolute; left:12px; top:20px;
          padding:6px 10px;
          background:var(--surface);
          border:1px solid var(--border-hi);
          border-radius:8px;
          font-size:11px; color:var(--text-mute);
          white-space:nowrap;
          box-shadow:0 6px 18px rgba(0,0,0,0.4);
          pointer-events:none;
        }
        .sidebar-resizer-kbd {
          display:inline-block;
          margin-left:4px;
          padding:1px 5px;
          border:1px solid var(--border);
          border-radius:4px;
          font-family:var(--font-mono);
          font-size:10px;
        }

        /* User cluster (bottom-left sidebar) */
        .user-cluster { padding:10px; border-top:1px solid var(--border); margin-top:8px; }
        .context-enabled-pill {
          display:flex; align-items:center; justify-content:space-between; gap:10px;
          box-sizing:border-box;
          width:100%;
          min-height:44px;
          padding:0 14px;
          border-radius:13px;
          border:1px solid color-mix(in srgb, var(--border-hi) 58%, transparent);
          background:color-mix(in srgb, var(--surface) 78%, #0b0f16 22%);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.02);
          color:color-mix(in srgb, var(--text) 92%, #dfe3ea 8%);
          font-size:13px;
          font-weight:480;
          letter-spacing:0.01em;
          margin:0 0 8px;
          text-align:left;
          cursor:pointer;
          transition:border-color 120ms, background 120ms;
        }
        .context-enabled-pill:hover {
          border-color:color-mix(in srgb, var(--border-hi) 88%, #8ea8ff 12%);
          background:color-mix(in srgb, var(--surface) 72%, #101726 28%);
        }
        .context-enabled-dot {
          width:9px; height:9px; border-radius:50%;
          background:#1bcf6e;
          box-shadow:0 0 0 1px rgba(27, 207, 110, 0.2), 0 0 8px rgba(27, 207, 110, 0.32);
          flex-shrink:0;
        }
        .context-panel {
          position:fixed;
          z-index:1079;
          max-width:min(420px, calc(100vw - 24px));
          background:color-mix(in srgb, var(--surface) 86%, #070b13 14%);
          border:1px solid color-mix(in srgb, var(--border-hi) 78%, transparent);
          border-radius:16px;
          box-shadow:0 26px 54px -16px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.36);
          padding:14px;
          animation:contextPanelIn 140ms var(--ease-out);
        }
        @keyframes contextPanelIn {
          from { opacity:0; transform:translateY(8px) scale(0.985); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        .context-panel-title {
          color:var(--text-dim);
          font-size:11px;
          margin-bottom:10px;
        }
        .context-awareness-card {
          position:relative;
          border-radius:12px;
          border:1px solid color-mix(in srgb, var(--border-hi) 70%, transparent);
          background:linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 80%, #111827 20%), color-mix(in srgb, var(--surface) 86%, #111827 14%));
          padding:12px 14px 10px;
          margin-bottom:8px;
        }
        .context-awareness-close {
          position:absolute;
          right:10px;
          top:10px;
          width:24px;
          height:24px;
          border:0;
          border-radius:8px;
          background:transparent;
          color:var(--text-mute);
          display:flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
        }
        .context-awareness-close:hover { background:var(--surface-2); color:var(--text); }
        .context-panel-body-copy {
          color:var(--text-mute);
          line-height:1.45;
          font-size:13px;
        }
        .context-link-btn {
          margin-top:8px;
          padding:0;
          border:0;
          background:transparent;
          color:var(--text);
          display:inline-flex;
          gap:6px;
          align-items:center;
          font-size:13px;
          font-weight:500;
          cursor:pointer;
        }
        .context-link-btn:hover { color:var(--gold); }
        .context-panel-row {
          width:100%;
          border:0;
          background:transparent;
          color:var(--text);
          display:flex;
          align-items:center;
          justify-content:space-between;
          font-size:13px;
          padding:11px 4px;
          cursor:pointer;
        }
        .context-panel-row:hover { color:var(--gold); }
        .context-panel-foot {
          margin-top:4px;
          padding-top:12px;
          border-top:1px solid var(--border);
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
        }
        .context-manage-btn {
          border:1px solid var(--border-hi);
          background:var(--surface-2);
          color:var(--text);
          font-size:13px;
          border-radius:12px;
          padding:8px 12px;
          cursor:pointer;
        }
        .context-manage-btn:hover { border-color:var(--gold-dim); color:var(--gold); }
        .local-preview-row {
          padding:6px 2px 4px;
          margin:0 0 4px;
          border:0;
        }
        .local-preview-label {
          font-size:10px;
          letter-spacing:0.04em;
          text-transform:uppercase;
          color:var(--text-dim);
        }
        .user-row { display:flex; align-items:center; gap:6px; padding:0; }
        .user-row + .user-row { margin-top:0; }
        .capturing-pill {
          display:inline-flex; align-items:center; gap:6px;
          font-family:var(--font-mono); font-size:9px; letter-spacing:0.12em;
          color:var(--text-mute); padding:3px 8px;
          border:1px solid var(--border); border-radius:999px;
          background:var(--surface);
        }
        .mini-btn {
          width:26px; height:26px; min-width:26px;
          display:flex; align-items:center; justify-content:center;
          background:var(--surface); border:1px solid var(--border);
          border-radius:var(--radius-sm); cursor:pointer;
          color:var(--text-mute); font-family:var(--font-mono); font-size:10px; letter-spacing:0.05em;
          padding:0 6px;
        }
        .mini-btn:hover { color:var(--text); border-color:var(--border-hi); background:var(--surface-2); }
        .user-pill {
          box-sizing:border-box;
          width:100%;
          min-height:44px;
          padding:6px 14px;
          margin:0;
          background:color-mix(in srgb, var(--surface) 78%, #0b0f16 22%);
          border:1px solid color-mix(in srgb, var(--border-hi) 58%, transparent);
          border-radius:13px;
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.02);
          cursor:pointer;
          transition:border-color 120ms, background 120ms;
        }
        .user-pill:hover {
          border-color:color-mix(in srgb, var(--border-hi) 88%, #8ea8ff 12%);
          background:color-mix(in srgb, var(--surface) 72%, #101726 28%);
        }

        /* User floating menu */
        .user-float {
          position:fixed; z-index:1081;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:18px;
          box-shadow:0 26px 56px -16px rgba(0,0,0,0.62), 0 2px 0 rgba(0,0,0,0.32);
          padding:6px 0;
          overflow:hidden;
          min-width:220px;
        }
        @keyframes userFloatIn {
          from { opacity:0; transform:translateY(8px) scale(0.98); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        .user-float-head { padding:12px 14px 10px; border-bottom:1px solid var(--border); }
        .user-float-section { padding:6px; }
        .user-float-row {
          display:flex; align-items:center; gap:12px;
          padding:10px 12px; border-radius:12px;
          color:var(--text); font-size:13.5px; line-height:1.25; cursor:pointer;
        }
        .user-float-row:hover { background:color-mix(in srgb, var(--surface-2) 85%, #1a202a 15%); }
        .user-float-row.gold { color:var(--gold); }
        .user-float-row .jp { font-family:var(--font-jp); font-weight:300; font-size:10.5px; color:var(--text-dim); margin-left:-4px; }
        .user-float-row .kbd-mini {
          font-family:var(--font-mono); font-size:10px;
          color:color-mix(in srgb, var(--text-dim) 80%, #a7adba 20%); letter-spacing:0.05em;
        }
        .user-float-profile {
          display:flex; align-items:center; gap:10px;
          padding:12px 14px; border-top:1px solid var(--border);
          background:var(--bg);
        }
        .user-float-profile .avatar {
          width:26px; height:26px; border-radius:50%;
          background:var(--surface-2); border:1px solid var(--border);
          display:flex; align-items:center; justify-content:center;
          font-size:11px; font-weight:500; color:var(--text);
          overflow:hidden;
        }
        .user-float-profile .avatar img { display:block; }
        /* Share modal */
        .share-modal {
          position:fixed; top:56px; right:16px;
          width:min(440px, calc(100vw - 32px)); z-index:1121;
          max-height:calc(100vh - 72px);
          max-height:calc(100dvh - 72px);
          overflow-y:auto;
          box-sizing:border-box;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:0 30px 70px -12px rgba(0,0,0,0.7), 0 4px 12px rgba(0,0,0,0.4);
          padding:20px 22px;
          animation: sysFloatIn 160ms var(--ease-out);
        }
        .share-choices {
          border:1px solid var(--border); border-radius:var(--radius-md);
          overflow:hidden;
        }
        .share-choice {
          display:flex; align-items:center; gap:14px;
          padding:16px 18px; cursor:pointer;
          transition:background 120ms;
        }
        .share-choice + .share-choice { border-top:1px solid var(--border); }
        .share-choice:hover { background:var(--surface-2); }
        .share-choice.on { background:color-mix(in srgb, var(--gold) 6%, var(--surface)); }
        .app-toast {
          position:fixed; right:16px; bottom:16px; z-index:1180;
          padding:10px 12px; border-radius:var(--radius-sm);
          border:1px solid var(--border-hi); background:var(--surface);
          color:var(--text); font-size:12px; box-shadow:0 10px 24px rgba(0,0,0,0.4);
        }
        .app-toast.success { border-color:color-mix(in srgb, var(--success) 40%, var(--border)); }
        .app-toast.warn { border-color:color-mix(in srgb, #d9a85a 45%, var(--border)); }
        .app-toast.error { border-color:color-mix(in srgb, #d96b5a 45%, var(--border)); }

        /* Hummingbird assistant (chat topbar 2nd action) */
        .hummingbird-panel {
          width: min(520px, calc(100vw - 40px));
          max-height: min(640px, calc(100dvh - 48px));
          display: flex;
          flex-direction: column;
          background: #1e1e1e;
          border: 1px solid color-mix(in srgb, var(--border-hi) 70%, #2a2a2a);
          border-radius: 14px;
          box-shadow: 0 32px 80px -16px rgba(0,0,0,0.75);
          overflow: hidden;
          animation: sysFloatIn 160ms var(--ease-out);
        }
        .hummingbird-panel-head {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px 10px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          flex-shrink: 0;
        }
        .hummingbird-close {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border: 0;
          border-radius: var(--radius-sm);
          background: transparent;
          color: var(--text-mute);
          cursor: pointer;
        }
        .hummingbird-close:hover { background: rgba(255,255,255,0.06); color: var(--text); }
        .hummingbird-title {
          flex: 1;
          margin: 0;
          font-size: 14px;
          font-weight: 500;
          letter-spacing: -0.02em;
          color: rgba(255,255,255,0.72);
        }
        .hummingbird-actions-hint {
          font-size: 11px;
          color: var(--text-dim);
        }
        .hummingbird-scroll {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 16px 18px 8px;
          font-size: 13px;
          line-height: 1.55;
          color: rgba(255,255,255,0.78);
        }
        .hummingbird-p { margin: 0 0 12px; }
        .hummingbird-p strong { color: #fff; font-weight: 600; }
        .hummingbird-ul { margin: 0 0 14px 1rem; padding: 0; }
        .hummingbird-ul li { margin-bottom: 6px; }
        .hummingbird-rule {
          border: 0;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 14px 0 16px;
        }
        .hummingbird-muted { color: rgba(255,255,255,0.5); font-size: 12.5px; }
        .hummingbird-feedback {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 14px 10px;
        }
        .hummingbird-icon-btn {
          width: 32px;
          height: 32px;
          border: 0;
          border-radius: var(--radius-sm);
          background: transparent;
          color: rgba(255,255,255,0.35);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hummingbird-icon-btn:hover { color: rgba(255,255,255,0.65); background: rgba(255,255,255,0.05); }
        .hummingbird-composer {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px 14px;
          border-top: 1px solid rgba(255,255,255,0.06);
          flex-shrink: 0;
        }
        .hummingbird-input {
          flex: 1;
          min-width: 0;
          height: 40px;
          border-radius: 10px;
          border: 1px solid rgba(255,255,255,0.1);
          background: rgba(0,0,0,0.35);
          color: rgba(255,255,255,0.92);
          font-size: 13px;
          padding: 0 14px;
          outline: none;
          font-family: inherit;
        }
        .hummingbird-input::placeholder { color: rgba(255,255,255,0.35); }
        .hummingbird-input:focus { border-color: rgba(255,255,255,0.22); }
        .hummingbird-mic {
          width: 38px;
          height: 38px;
          border: 0;
          border-radius: 10px;
          background: transparent;
          color: rgba(255,255,255,0.45);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hummingbird-mic:hover { color: rgba(255,255,255,0.75); }
        .hummingbird-send {
          width: 40px;
          height: 40px;
          border-radius: 999px;
          border: 0;
          background: rgba(255,255,255,0.12);
          color: rgba(255,255,255,0.92);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .hummingbird-send:hover { background: rgba(255,255,255,0.2); }

        @media (max-width: 720px) {
          .share-modal {
            left: 12px;
            right: 12px;
            top: 52px;
            width: auto;
            max-width: none;
          }
        }
      `}</style>
    </div>
  );
}

class ShogunErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, err: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, err: error };
  }
  componentDidCatch(error, info) {
    try {
      if (
        window.ShogunErrorReporting &&
        typeof window.ShogunErrorReporting.reportReactError === 'function'
      ) {
        window.ShogunErrorReporting.reportReactError(error, info);
      }
    } catch (_) {
      /* ignore */
    }
  }
  render() {
    if (this.state.hasError && this.state.err) {
      const e = this.state.err;
      const msg = e && e.message ? String(e.message) : String(e);
      return (
        <div
          style={{
            padding: 32,
            fontFamily: 'var(--font-sans, system-ui, sans-serif)',
            maxWidth: 520,
            margin: '8vh auto',
            color: 'var(--text, #e8e8e8)',
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Something went wrong</div>
          <div
            className="en-only"
            style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--text-dim, rgba(255,255,255,0.65))' }}
          >
            {msg}
          </div>
          <div
            className="jp"
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: 'var(--text-dim, rgba(255,255,255,0.65))',
              marginTop: 8,
            }}
          >
            予期しないエラーが発生しました。下部のボタンで再試行できます。
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: 20 }}
            onClick={() => this.setState({ hasError: false, err: null })}
          >
            Try again / 再試行
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ShogunErrorBoundary>
    <App />
  </ShogunErrorBoundary>,
);
