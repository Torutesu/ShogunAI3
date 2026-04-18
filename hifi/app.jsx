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

const INITIAL_CHAT_HISTORY =
  typeof window !== 'undefined' &&
  window.SHOGUN_DEMO_SEED &&
  Array.isArray(window.SHOGUN_DEMO_SEED.chats)
    ? window.SHOGUN_DEMO_SEED.chats
    : [];

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
      return o && typeof o === 'object' ? o : {};
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
  const normalizeProvider = (raw) =>
    String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
  const localConnectSlugs = new Set(['arc_browser', 'raycast', 'obsidian']);
  switch (command) {
    case 'app_integration_connect': {
      const slug = normalizeProvider(echo.provider);
      if (localConnectSlugs.has(slug)) {
        return { ok: true, data: { connected: true, provider: slug, stub: false, echo } };
      }
      return notImpl(
        'Third-party integrations (OAuth, calendar, mail) are not available in v1. This build is local-only; connect Arc, Raycast, or Obsidian for local-only toggles.',
      );
    }
    case 'app_integration_toggle':
      return {
        ok: true,
        data: {
          saved: true,
          connected: echo.connected === true,
          provider: normalizeProvider(echo.provider),
          stub: false,
          echo,
        },
      };
    case 'app_integration_import_credentials':
      return {
        ok: true,
        data: {
          saved: true,
          provider: normalizeProvider(echo.provider),
          stub: false,
          echo,
        },
      };
    case 'app_integration_credentials_status':
      return {
        ok: true,
        data: {
          configured: false,
          tokenRefreshReady: false,
          provider: normalizeProvider(echo.provider || 'google_calendar'),
          stub: false,
          echo,
        },
      };
    case 'shogun_google_calendar_sync':
      return {
        ok: true,
        data: {
          ingested: 0,
          calendarId: echo.calendarId || 'primary',
          stub: false,
          echo,
        },
      };
    case 'shogun_draft':
      return {
        ok: true,
        data: {
          content: '# Draft\n\n_Mock Markdown (fallback mock)._',
          title: echo.target ? `Draft · ${echo.target}` : 'Draft',
          stub: false,
          echo,
        },
      };
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
    case 'shogun_draft_reply':
      return {
        ok: true,
        data: {
          content:
            '# Draft reply (browser mock)\n\n_Use the desktop app with an LLM API key for a real draft from your Brief + Memory._\n',
          title: 'Reply draft · mock',
          stub: false,
          echo,
        },
      };
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
      return {
        ok: true,
        data: {
          message:
            '[Demo — set an API key in the desktop app for real completions.]\n\nYou asked: ' +
            (preview || '(empty)') +
            '\n\n_Mock reply (fallback transport)._',
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
    case 'app_create_share_link':
      return {
        ok: true,
        data: {
          exported: true,
          path: '/mock/shogun-share-export.md',
          stub: false,
          echo,
        },
      };
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
        capturePause: (input) => client.invoke('app_capture_pause', input),
        captureResume: (input) => client.invoke('app_capture_resume', input),
        permissionsManage: (input) => client.invoke('app_permissions_manage', input),
        diagnosticsReport: (input) => client.invoke('app_diagnostics_report', input),
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
          'capture.pause': api.capturePause,
          'capture.resume': api.captureResume,
          'permissions.manage': api.permissionsManage,
          'diagnostics.report': api.diagnosticsReport,
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
  const [userOpen, setUserOpen] = useState(false);
  const [userAnchor, setUserAnchor] = useState({left:0, bottom:0, width:220});
  const userBtnRef = React.useRef(null);
  const [settingsOpen, setSettingsOpen] = useState(null); // null | 'general' | 'system' | 'appearance' | 'privacy' | 'data' | 'hummingbird' | 'meetings' | 'chat' | 'integrations' | 'shortcuts' | 'subscription' | 'team' | 'support' | 'api' | 'upgrade' | 'changelog' | 'feedback'
  const [toast, setToast] = useState(null);
  const [writeConfirm, setWriteConfirm] = useState({ open:false, actionKey:null, payload:null, title:null, description:null });
  const [writePending, setWritePending] = useState(false);
  const runtimeRef = useRef(null);
  const toastTimerRef = useRef(null);
  const bioWantLockRef = useRef(false);
  const [bioGate, setBioGate] = useState({ ready: false, open: false });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
    setUserOpen(v => !v);
  };

  useEffect(() => { localStorage.setItem('shogun-active', active); }, [active]);

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
  }, [activeChat, chats]); // eslint-disable-line react-hooks/exhaustive-deps

  const createNewChat = useCallback(() => {
    const id = `c${Date.now()}`;
    const item = { id, title: 'New conversation', time: '', when: 'TODAY', jp: '今日', favorite: false };
    setChats((prev) => [item, ...prev]);
    setActiveChat(id);
    setActive('chat');
    pushToast('New conversation created', 'success');
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
          case A.CHAT_VOICE_TOGGLE:
            window.dispatchEvent(new CustomEvent('shogun-voice-toggle'));
            break;
          case A.CHAT_VOICE_CANCEL:
            window.dispatchEvent(new CustomEvent('shogun-voice-cancel'));
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
    {id:'main', label:'Core', jp:'核'},
    {id:'workspace', label:'Workspace', jp:'作業'},
  ];
  const favChats = chats.filter(c => c.favorite);
  const restChats = chats.filter(c => !c.favorite);

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

  return (
    <div className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')} data-screen-label={active}>
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
      {/* Topbar */}
      <div className="topbar">
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
          {/* 3 page actions: Hummingbird · favorite · share */}
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
            <button className={'page-action'+(favorited?' on':'')} onMouseEnter={()=>setShareTip('star')} onMouseLeave={()=>setShareTip(null)} onClick={()=>setFavorited(v=>!v)}>
              <Icon name="star" size={15}/>
              {shareTip==='star' && <span className="tip">{favorited?'Unfavorite':'Favorite chat'}</span>}
            </button>
            <button className={'page-action'+(shareOpen?' active':'')} onMouseEnter={()=>setShareTip('share')} onMouseLeave={()=>setShareTip(null)} onClick={()=>setShareOpen(v=>!v)}>
              <Icon name="upload" size={15}/>
              {shareTip==='share' && !shareOpen && <span className="tip">Share chat</span>}
            </button>
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <div className="sidebar" data-screen-label="sidebar">
        {sections.map(sec => (
          <div key={sec.id}>
            <div className="section-label"><span className="en-only">{sec.label}</span><span className="en-only"> · </span><span className="jp">{sec.jp}</span></div>
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
                    ><Icon name="plus" size={12}/>New conversation</button>

                    {/* Favorites bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='fav'?'drop':'')}
                      data-chat-bucket="fav"
                    >
                      <div className="chat-subgroup t-mono">
                        <span className="gold" style={{fontSize:9, marginRight:4}}>★</span>
                        <span className="en-only">FAVORITES</span>
                        <span className="jp" style={{marginLeft:6}}>お気に入り</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{favChats.length}</span>
                      </div>
                      {favChats.length===0 && (
                        <div className="chat-empty">
                          <span className="en-only">Drop a chat here</span>
                          <span className="jp">ここへ</span>
                        </div>
                      )}
                      {favChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
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
                          <span className="gold dot-fav">★</span>
                          <span className="chat-sub-title">{it.title}</span>
                          <button type="button" draggable={false} className="chat-fav-btn" onClick={(e)=>{e.stopPropagation(); toggleFav(it.id);}} title="Unfavorite">★</button>
                        </div>
                      ))}
                    </div>

                    {/* All chats bucket */}
                    <div
                      className={'chat-bucket '+(dragOver?.pos==='chats'?'drop':'')}
                      data-chat-bucket="chats"
                    >
                      <div className="chat-subgroup t-mono">
                        <span className="en-only">CHATS</span>
                        <span className="jp" style={{marginLeft:6}}>対話</span>
                        <span className="spacer"/>
                        <span style={{fontSize:9, color:'var(--text-dim)'}}>{restChats.length}</span>
                      </div>
                      {restChats.length === 0 && (
                        <div className="chat-empty" style={{padding:'6px 10px 10px'}}>
                          <span className="en-only">New conversation to start</span>
                          <span className="jp">新しい対話</span>
                        </div>
                      )}
                      {restChats.map(it => (
                        <div
                          key={it.id}
                          data-chat-row={it.id}
                          onPointerDown={onChatRowPointerDown(it.id)}
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
                          <span className="dot"/>
                          <span className="chat-sub-title">{it.title}</span>
                          {it.time && <span className="t-mono chat-sub-time">{it.time}</span>}
                          <button type="button" draggable={false} className="chat-fav-btn fav-hover" onClick={(e)=>{e.stopPropagation(); toggleFav(it.id);}} title="Favorite">☆</button>
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
          <div className="user-row" style={{padding:'0 8px 6px'}}>
            <span className="s-field-hint" style={{fontSize:10}}><span className="en-only">Local preview</span><span className="jp">ローカル</span></span>
          </div>
          <div ref={userBtnRef} className="user-row user-pill" onClick={openUser}>
            <div className="avatar" style={{width:26, height:26, fontSize:11}}>Y</div>
            <div style={{flex:1, minWidth:0}}>
              <div style={{fontSize:12, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}><span className="en-only">You</span><span className="jp">ユーザー</span></div>
              <div className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>LOCAL</div>
            </div>
            <Icon name={userOpen?'chevronDown':'chevronRight'} size={11} className="dim"/>
          </div>
        </div>
      </div>

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
              className="btn"
              style={{width:'100%', marginTop:18, background:'var(--gold-bg, #EFE5D3)', color:'#151212', borderColor:'var(--gold-dim)', height:44, fontSize:14}}
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
              <div style={{fontSize:12, color:'var(--text-dim)'}}>kazu@shogun.local</div>
            </div>
            <div className="user-float-section">
              <div className="user-float-row" onClick={()=>{setSettingsOpen('general'); setUserOpen(false);}}>
                <Icon name="settings" size={13}/><span className="en-only">Settings</span><span className="jp">設定</span>
                <span className="spacer"/><span className="kbd-mini">⌘,</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('subscription'); setUserOpen(false);}}>
                <Icon name="arrowUpRight" size={13}/><span className="en-only">Upgrade Plan</span><span className="jp">昇格</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('download'); setUserOpen(false);}}>
                <Icon name="download" size={13}/><span className="en-only">Download Mobile App</span><span className="jp">携帯</span>
              </div>
            </div>
            <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('feedback'); setUserOpen(false);}}>
                <Icon name="chat" size={13}/><span className="en-only">Give Feedback</span><span className="jp">意見</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('support'); setUserOpen(false);}}>
                <Icon name="info" size={13}/><span className="en-only">Help Center</span><span className="jp">案内</span>
              </div>
              <div className="user-float-row" onClick={()=>{setSettingsOpen('changelog'); setUserOpen(false);}}>
                <Icon name="clock" size={13}/><span className="en-only">Changelog</span><span className="jp">更新</span>
              </div>
              <div className="user-float-row gold" onClick={()=>{setSettingsOpen('referral'); setUserOpen(false);}}>
                <Icon name="gift" size={13}/><span className="en-only">Get 2 Months Free</span><span className="jp">贈</span>
              </div>
            </div>
            <div className="user-float-section" style={{borderTop:'1px solid var(--border)'}}>
              <div className="user-float-row" style={{color:'var(--text-mute)'}}>
                <Icon name="logout" size={13}/><span className="en-only">Logout</span><span className="jp">退出</span>
              </div>
            </div>
            {/* Profile chip at bottom, like reference */}
            <div className="user-float-profile">
              <div className="avatar">T</div>
              <div style={{flex:1, minWidth:0}}>
                <div style={{fontSize:12, fontWeight:500}}>Toru Tano</div>
                <div style={{fontSize:10, color:'var(--text-dim)'}}>Pro · Local</div>
              </div>
            </div>
          </div>
        </>,
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
              if (r.ok && r.data?.settings?.sections) applySavedAppearance(r.data.settings.sections);
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
        body[data-density=minimal] .sidebar .nav-item .nav-label { display:none; }
        body[data-density=rich] .nav-item { padding:10px 12px; }
        .lang-pill { min-width:44px; font-family:var(--font-mono); font-size:11px; letter-spacing:0.08em; padding:0 10px; }

        /* Chat sub-nav under Chat */
        .chat-subnav { margin:2px 0 8px 8px; padding-left:10px; border-left:1px solid var(--border); }
        .chat-subgroup { padding:10px 0 4px 8px; font-size:9px; display:flex; align-items:center; }
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
        .chat-fav-btn {
          background:transparent; border:0; color:var(--text-dim); cursor:pointer;
          font-size:11px; padding:2px 4px; border-radius:3px; flex-shrink:0;
          transition:color 120ms, opacity 120ms;
        }
        .chat-fav-btn.fav-hover { opacity:0; }
        .chat-sub-item:hover .chat-fav-btn.fav-hover { opacity:1; }
        .chat-fav-btn:hover { color:var(--gold); background:var(--surface-2); }
        .chat-sub-item { display:flex; align-items:center; gap:8px; padding:6px 8px; margin:1px 0; border-radius:var(--radius-sm); cursor:pointer; color:var(--text-mute); font-size:12px; }
        .chat-sub-item:hover { background:var(--surface-2); color:var(--text); }
        .chat-sub-item.active { background:var(--surface-2); color:var(--text); }
        .chat-sub-item.active .dot { background:var(--gold); box-shadow:0 0 0 2px color-mix(in srgb, var(--gold) 25%, transparent); }
        .chat-sub-item .dot { width:5px; height:5px; border-radius:50%; background:var(--border-hi); flex-shrink:0; }
        .chat-sub-title { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
        .chat-sub-time { font-size:9px; color:var(--text-dim); flex-shrink:0; }

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

        /* User cluster (bottom-left sidebar) */
        .user-cluster { padding:10px; border-top:1px solid var(--border); margin-top:8px; }
        .user-row { display:flex; align-items:center; gap:6px; padding:2px 0; }
        .user-row + .user-row { margin-top:8px; }
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
          padding:8px 10px; background:var(--surface); border:1px solid var(--border);
          border-radius:var(--radius-md); cursor:pointer; transition:all 120ms;
        }
        .user-pill:hover { border-color:var(--border-hi); background:var(--surface-2); }

        /* User floating menu */
        .user-float {
          position:fixed; z-index:1081;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:0 24px 48px -12px rgba(0,0,0,0.6), 0 2px 0 rgba(0,0,0,0.3);
          padding:4px 0;
          overflow:hidden;
          min-width:220px;
        }
        @keyframes userFloatIn {
          from { opacity:0; transform:translateY(8px) scale(0.98); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        .user-float-head { padding:10px 12px 8px; border-bottom:1px solid var(--border); }
        .user-float-section { padding:4px 4px; }
        .user-float-row {
          display:flex; align-items:center; gap:10px;
          padding:7px 10px; border-radius:var(--radius-sm);
          color:var(--text); font-size:12.5px; cursor:pointer;
        }
        .user-float-row:hover { background:var(--surface-2); }
        .user-float-row.gold { color:var(--gold); }
        .user-float-row .jp { font-family:var(--font-jp); font-weight:300; font-size:10.5px; color:var(--text-dim); margin-left:-4px; }
        .user-float-row .kbd-mini {
          font-family:var(--font-mono); font-size:10px;
          color:var(--text-dim); letter-spacing:0.05em;
        }
        .user-float-profile {
          display:flex; align-items:center; gap:10px;
          padding:10px 12px; border-top:1px solid var(--border);
          background:var(--bg);
        }
        .user-float-profile .avatar {
          width:26px; height:26px; border-radius:50%;
          background:var(--surface-2); border:1px solid var(--border);
          display:flex; align-items:center; justify-content:center;
          font-size:11px; font-weight:500; color:var(--text);
        }
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

ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
