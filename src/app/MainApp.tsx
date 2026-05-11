/* eslint-disable max-lines -- Phase 2 Step 11: monolith carved out from App.tsx. Phase 3 will further decompose. */
// MainApp extracted from App.tsx (Phase 2 Step 11)
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import * as ReactDOM from 'react-dom';
import { Icon, Kamon } from '@/shared/icons';
import { ScreenHome } from '@/features/home';
import { ScreenMemory } from '@/features/memory';
import { ScreenMeetings } from '@/features/meetings';
import { SettingsModal } from '@/features/settings';
import { ScreenWork } from '@/features/work';
import { ScreenAgents } from '@/features/agents';
import { ScreenChat } from '@/features/chat';
import { ScreenMemoryDebug } from '@/features/memory-debug';
import { ConfirmWriteModal } from '@/shared/modals';
import { ShogunIpcClient, ShogunAPI, ShogunActionRegistry } from '@/shared/ipc';
import {
  TWEAK_DEFAULTS,
  NAV,
  REMOVED_NAV_IDS,
  INITIAL_CHAT_HISTORY,
  CHAT_CONTEXT_TELEMETRY_LS,
  CHAT_WORKSPACE_LS,
  SIDEBAR_WIDTH_LS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './lib/constants';
import {
  profileStateFromSections,
  isProfilePhotoDataUrl,
  shellAvatarChar,
  purgeDummyWorkProjects,
  purgeDummyChats,
  applySavedAppearance,
} from './lib/helpers';
import { ensureRuntimeDeps } from './lib/mockIpc';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const window: any;

/** Renders only after `legalGate.status === "ok"`. Do NOT mount this
 *  component directly — it must come through `App` so the consent gate
 *  invariant holds. The body lives in its own component (rather than
 *  inline below the gate's early returns) so that React sees a stable
 *  hook count for App across renders: App always calls the gate hooks,
 *  MainApp always calls the body hooks. Inlining would grow the hook
 *  count from ~6 to 100+ on the gate→ok transition and trigger
 *  "Rendered more hooks than during the previous render." */
export function MainApp(): React.ReactElement {
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
  const [activeChat, setActiveChat] = useState<any>(() => (INITIAL_CHAT_HISTORY[0] ? INITIAL_CHAT_HISTORY[0].id : null));
  const [chats, setChats] = useState<any[]>(INITIAL_CHAT_HISTORY);
  const [dragId, setDragId] = useState<any>(null);
  const [dragOver, setDragOver] = useState<any>(null); // {id, pos:'before'|'after'|'fav'|'chats'}
  const dragIdRef = useRef<any>(null);
  const dragOverRef = useRef<any>(null);
  const suppressChatRowClickRef = useRef(false);
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  const [editMode, setEditMode] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMode, setShareMode] = useState('private');
  const [shareTip, setShareTip] = useState<any>(null); // 'popout' | 'star' | 'share' | null
  const [hummingbirdOpen, setHummingbirdOpen] = useState(false);
  const [hummingbirdInput, setHummingbirdInput] = useState('');
  const [userOpen, setUserOpen] = useState(false);
  const [userAnchor, setUserAnchor] = useState({left:0, bottom:0, width:220, maxHeight:600});
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [contextPanelAnchor, setContextPanelAnchor] = useState({ left: 0, bottom: 0, width: 320 });
  const [chatMenu, setChatMenu] = useState<any>({ open:false, chatId:null, x:0, y:0, width:240 });
  const [chatRenameModal, setChatRenameModal] = useState<any>({ open:false, chatId:null, value:'' });
  const [chatDeleteModal, setChatDeleteModal] = useState<any>({ open:false, chatId:null });
  const [chatWorkModal, setChatWorkModal] = useState<any>({ open:false, chatId:null, query:'' });
  const [chatGroupsOpen, setChatGroupsOpen] = useState<any>({ favorite: true, chats: true });
  const [workProjects, setWorkProjects] = useState<any[]>([]);
  const chatWorkspaceHydratedRef = useRef(false);
  const userBtnRef = React.useRef<any>(null);
  const contextBtnRef = React.useRef<any>(null);
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [profileAvatarGlyph, setProfileAvatarGlyph] = useState('');
  const [profileAvatarImageDataUrl, setProfileAvatarImageDataUrl] = useState('');
  const [settingsOpen, setSettingsOpen] = useState<any>(null); // null | 'general' | 'system' | 'appearance' | 'privacy' | 'data' | 'hummingbird' | 'meetings' | 'chat' | 'integrations' | 'shortcuts' | 'team' | 'support' | 'api' | 'upgrade' | 'changelog' | 'feedback'
  // { provider: 'gmail' | 'google_calendar', days: 30 } when prompting; null when hidden.
  const [historicalImport, setHistoricalImport] = useState<any>(null);
  const [historicalImportBusy, setHistoricalImportBusy] = useState(false);
  // { current, total, phase } — live status from the backend `historical-sync-progress` event.
  const [historicalImportProgress, setHistoricalImportProgress] = useState<any>(null);
  // { provider, token, busy } when the Paste-token modal is open (Slack / Notion / GitHub).
  const [pasteTokenModal, setPasteTokenModal] = useState<any>(null);
  const [toast, setToast] = useState<any>(null);
  const [writeConfirm, setWriteConfirm] = useState<any>({ open:false, actionKey:null, payload:null, title:null, description:null });
  const [writePending, setWritePending] = useState(false);
  const [devGate, setDevGate] = useState({ available: false });
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        // Call the backend command directly via Tauri v2 bridge. The devGate
        // only exists inside runtimeRef.current once it's built — we need
        // this at mount time, so skip the runtime layer.
        const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
        if (!invoke) return;
        const out = await invoke('shogun_memory_debug_gate', { payload: {} });
        if (!cancel && out && typeof out === 'object') setDevGate(out);
      } catch (_) { /* ignore — release build returns available:false anyway */ }
    })();
    return () => { cancel = true; };
  }, []);
  const runtimeRef = useRef<any>(null);
  const toastTimerRef = useRef<any>(null);
  const bioWantLockRef = useRef(false);
  const [bioGate, setBioGate] = useState({ ready: false, open: false });
  // Sidebar Memory nav badge — count of HIGH-priority items from the last
  // 7 days. Updated by ScreenHome's brief.get callback via a window event.
  const [memoryHighUnreadCount, setMemoryHighUnreadCount] = useState(0);
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
  const [meetingHud, setMeetingHud] = useState<any>(null);
  const [meetingHudTick, setMeetingHudTick] = useState(0);
  const navHistRef = useRef<any>(null);
  const skipNavHistRef = useRef(false);
  const shortcutBindingsRef = useRef(
    typeof window !== 'undefined' && window.ShogunKeyboardShortcuts
      ? window.ShogunKeyboardShortcuts.mergeShortcutBindings()
      : {},
  );

  const openUser = () => {
    const r = userBtnRef.current?.getBoundingClientRect();
    if (r) {
      // Cap the upward-growing menu at exactly the space between viewport top
      // (with 8px margin) and the pill. With bottom = innerHeight - r.top + 8
      // and maxHeight = r.top - 16, the menu's computed top is always 8px —
      // so the first row (Settings) is guaranteed inside the viewport even
      // when Playwright scrolls the sidebar so the pill is near viewport top.
      // No hard floor here; when space is tiny the menu scrolls internally.
      // Match the pill's width so the popup stays inside the sidebar column
      // (i.e. within the "wall" the user pill lives in).
      setUserAnchor({
        left: r.left,
        bottom: window.innerHeight - r.top + 8,
        width: Math.round(r.width),
        maxHeight: Math.max(0, r.top - 16),
      });
    }
    setContextPanelOpen(false);
    setUserOpen(v => !v);
  };

  const openContextPanel = () => {
    const r = contextBtnRef.current?.getBoundingClientRect();
    if (r) {
      // Match the pill's width so the popup stays inside the sidebar column
      // (i.e. within the "wall" the Context-enabled pill lives in).
      setContextPanelAnchor({
        left: Math.max(12, r.left),
        bottom: window.innerHeight - r.top + 10,
        width: Math.round(r.width),
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
    const onHud = (e: any) => {
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
    const onKey = (e: any) => {
      if (e.key === 'Escape') setHummingbirdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hummingbirdOpen]);

  useEffect(() => {
    if (!contextPanelOpen) return undefined;
    const onKey = (e: any) => {
      if (e.key === 'Escape') setContextPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextPanelOpen]);

  const pushToast = (message: any, kind: any = 'info', options: any = {}) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    const action =
      options.action && typeof options.action.onClick === 'function' && options.action.label
        ? { label: String(options.action.label), onClick: options.action.onClick }
        : null;
    setToast({ message, kind, action });
    // Actionable toasts stick around longer so the user can reach the button.
    const ttl = action ? (options.durationMs || 8000) : (options.durationMs || 2200);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ttl);
  };
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  useEffect(() => {
    let unlisten: any;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    (async () => {
      try {
        unlisten = await listen('credentials-imported', (e: any) => {
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

  // Prompt the user to import historical data the first time they connect
  // Gmail or Google Calendar. Choice is persisted so we don't re-ask.
  useEffect(() => {
    const HISTORICAL_PROVIDERS = new Set(['gmail', 'google_calendar', 'google_drive', 'slack', 'notion', 'github', 'linear', 'zoom']);
    const onCred = async (ev: any) => {
      const detail = (ev && ev.detail) || {};
      const provider = String(detail.provider || '').trim();
      if (!provider || !HISTORICAL_PROVIDERS.has(provider)) return;
      try {
        const res = await executeAction('settings.load', {}, { silentError: true });
        const sections = res && res.ok && res.data && res.data.settings && res.data.settings.sections;
        const prev = sections && sections[provider];
        // Already decided (0 = skipped, >0 = imported) — don't re-prompt.
        if (prev && typeof prev === 'object' && prev.historicalSyncDays != null) return;
      } catch (_) {
        /* ignore — show the modal anyway */
      }
      setHistoricalImport({ provider, days: 30 });
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Live progress from the backend while a historical sync runs.
  useEffect(() => {
    let unlisten: any;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    (async () => {
      try {
        unlisten = await listen('historical-sync-progress', (e: any) => {
          const p = (e && e.payload) || {};
          setHistoricalImportProgress({
            provider: p.provider || null,
            current: Number(p.current) || 0,
            total: p.total == null ? null : Number(p.total),
            phase: p.phase || '',
          });
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
    let unlisten: any;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    const AUDIT_LS_KEY = 'shogun.integration.audit.v1';
    (async () => {
      try {
        unlisten = await listen('integration-security-audit', (e: any) => {
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
    let unlistenVideo: any;
    (async () => {
      try {
        unlistenVideo = await listen('video-meeting-started', (e: any) => {
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

  /** Tray-driven capture toggle: ipc-client.js dispatches shogun-settings-refresh when the
   *  macOS tray menu changes sections.capture.paused. Re-load and re-apply settings so any
   *  open Settings pane or capture-status UI reflects the new state without a page reload.
   *  No-op in mock mode because the event is never dispatched there.
   *  Routed through executeActionRef so the closure stays valid across re-renders without
   *  having to re-subscribe on every render or list non-stable dependencies. */
  useEffect(() => {
    const onRefresh = () => {
      (async () => {
        try {
          const r = await executeActionRef.current('settings.load', {}, { silentError: true });
          if (r.ok && r.data?.settings?.sections) {
            applySavedAppearance(r.data.settings.sections);
          }
        } catch (_) {
          /* ignore */
        }
      })();
    };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, []);

  /** Desktop: Rust emits when axRichCapture is on but macOS Accessibility trust is missing. Backend rate-limits to once per 120s. */
  useEffect(() => {
    let unlisten: any;
    const listen = typeof window !== 'undefined' && window.__TAURI__?.event?.listen;
    if (typeof listen !== 'function') return undefined;
    (async () => {
      try {
        unlisten = await listen('shogun-capture-ax-not-trusted', (e: any) => {
          const p = (e && e.payload) || {};
          const message =
            (typeof p.message === 'string' && p.message) ||
            'Accessibility permission is required for AX-rich capture. Open System Settings → Privacy & Security → Accessibility to allow SHOGUN.';
          const runtime = window.SHOGUN_RUNTIME;
          const canOpen = !!(runtime && typeof runtime.executeAction === 'function');
          pushToastRef.current(message, 'warn', canOpen ? {
            action: {
              label: 'Open Accessibility',
              onClick: () => {
                runtime.executeAction(
                  'permissions.manage',
                  { target: 'accessibility', source: 'capture.ax_not_trusted_toast' },
                  { silentError: true },
                );
              },
            },
          } : {});
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
      onMissing: (key: any) => pushToast(`Action not connected: ${key}`, 'warn'),
      onExecute: () => {},
    });
    runtimeRef.current = { client, api, registry };
  }

  const executeAction = async (actionKey: any, payload: any, options: any = {}) => {
    if (!runtimeRef.current) {
      pushToast('IPC runtime unavailable', 'error');
      return { ok:false };
    }
    let res;
    try {
      res = await runtimeRef.current.registry.run(actionKey, payload);
    } catch (err: any) {
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

  const requestWriteAction = (actionKey: any, payload: any, title: any, description: any) => {
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
      createWorkProject: (name: any) => {
        const n = String(name || '').trim();
        if (!n) return null;
        const id = `w-${Date.now()}`;
        setWorkProjects((prev) => [...prev, { id, name: n }]);
        pushToast(`Workspaceを作成: ${n}`, 'success');
        return id;
      },
      renameWorkProject: (projectId: any, nextName: any) => {
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
      deleteWorkProject: (projectId: any) => {
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
      archiveWorkProject: (projectId: any, archivedOn: any) => {
        const id = String(projectId || '').trim();
        if (!id) return false;
        const on = archivedOn !== false;
        setWorkProjects((prev) => prev.map((p) => (
          p.id === id ? { ...p, archived: on } : p
        )));
        pushToast(on ? 'Workプロジェクトをアーカイブしました' : 'Workプロジェクトを復元しました', 'success');
        return true;
      },
      moveWorkProject: (projectId: any, direction: any) => {
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
      openSettingsPane: (paneId: any) => setSettingsOpen(paneId || 'general'),
      setActiveScreen: (id: any) => {
        if (id && typeof id === 'string') setActive(id);
      },
      createNewChat: () => createNewChat(),
      openWorkPickerForNewChat: () => {
        setChatWorkModal({ open: true, chatId: null, query: '' });
      },
      openHistoricalImport: (provider: any, defaultDays: any) => {
        const p = String(provider || '').trim();
        const allowed = new Set(['gmail', 'google_calendar', 'google_drive', 'slack', 'notion', 'github', 'linear', 'zoom']);
        if (!allowed.has(p)) return false;
        const d = Number.isFinite(Number(defaultDays)) ? Number(defaultDays) : 30;
        setHistoricalImport({ provider: p, days: d });
        return true;
      },
      openPasteToken: (provider: any) => {
        const p = String(provider || '').trim();
        const allowed = new Set(['slack', 'notion', 'github', 'linear', 'zoom']);
        if (!allowed.has(p)) return false;
        setPasteTokenModal({ provider: p, token: '', busy: false });
        return true;
      },
      applyShortcutBindings: (raw: any) => {
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
            setChats(purgeDummyChats(ws.chats));
            loaded = true;
          }
          if (Array.isArray(ws.workProjects)) {
            setWorkProjects(purgeDummyWorkProjects(ws.workProjects));
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
                setChats(purgeDummyChats(parsed.chats));
                loaded = true;
              }
              if (Array.isArray(parsed.workProjects)) {
                setWorkProjects(purgeDummyWorkProjects(parsed.workProjects));
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
    window.shogunBriefTelemetrySink = (row: any) => {
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

  const toggleFav = (id: any) => setChats(cs => cs.map(c => c.id===id ? {...c, favorite: !c.favorite} : c));
  const openChatMenuAt = useCallback((chatId: any, x: any, y: any) => {
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
  const openRenameModal = useCallback((id: any) => {
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
  const openDeleteModal = useCallback((id: any) => {
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
  const openWorkModal = useCallback((id: any) => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setChatWorkModal({ open:true, chatId:id, query:'' });
  }, [chats]);
  const assignChatToWork = useCallback((workId: any, workName: any) => {
    let id = chatWorkModal.chatId;
    const newChat = !id;
    if (newChat) {
      id = `c${Date.now()}`;
      const item = { id, title: 'New Chat', time: '', when: 'TODAY', jp: '今日', favorite: false, workProjectId: workId, workProjectName: workName };
      setChats((prev) => [item, ...prev]);
      setActiveChat(id);
    } else {
      setChats((cs) => cs.map((c) => (c.id === id ? { ...c, workProjectId:workId, workProjectName:workName } : c)));
    }
    setChatWorkModal({ open:false, chatId:null, query:'' });
    setActive(newChat ? 'chat' : 'work');
    pushToast(`Workに追加: ${workName}`, 'success');
  }, [chatWorkModal.chatId]);
  const createAndAssignWork = useCallback(() => {
    const name = String(chatWorkModal.query || '').trim();
    if (!name) return;
    const id = `w-${Date.now()}`;
    setWorkProjects((prev) => [...prev, { id, name }]);
    assignChatToWork(id, name);
  }, [assignChatToWork, chatWorkModal.query]);
  const toggleWorkArchiveForChat = useCallback((id: any) => {
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
  const runChatMenuAction = useCallback((action: any, id: any) => {
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
    const onKey = (e: any) => {
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
  const updateDragOverFromPoint = useCallback((clientX: any, clientY: any) => {
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
    (id: any) => (e: any) => {
      if (e.button !== 0) return;
      if (e.target.closest?.('button')) return;
      const sx = e.clientX;
      const sy = e.clientY;
      let armed = false;
      const move = (ev: any) => {
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
    const onProfile = (e: any) => {
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
    const onAppearance = (e: any) => {
      const a = e.detail && e.detail.appearance;
      if (!a || typeof a !== 'object') return;
      applySavedAppearance({ appearance: a });
    };
    window.addEventListener('shogun-appearance-changed', onAppearance);
    return () => window.removeEventListener('shogun-appearance-changed', onAppearance);
  }, []);

  // Keep the sidebar Memory badge in sync with ScreenHome's digest load.
  useEffect(() => {
    const onHighCount = (e: any) => {
      const n = Number(e && e.detail && e.detail.count);
      setMemoryHighUnreadCount(Number.isFinite(n) && n > 0 ? n : 0);
    };
    window.addEventListener('shogun-memory-high-count', onHighCount);
    return () => window.removeEventListener('shogun-memory-high-count', onHighCount);
  }, []);

  const executeActionRef = useRef(executeAction);
  executeActionRef.current = executeAction;

  useEffect(() => {
    if (bioGate.ready && bioGate.open) return undefined;
    const onKey = (e: any) => {
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


  useEffect(() => {
    const handler = (e: any) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({type:'__edit_mode_available'}, '*');
    return () => window.removeEventListener('message', handler);
  }, []);

  const update = (k: any, v: any) => {
    const next = {...tweaks, [k]: v};
    setTweaks(next);
    window.parent.postMessage({type:'__edit_mode_set_keys', edits:{[k]: v}}, '*');
  };

  const sections = [
    {id:'main', label:'', jp:''},
    {id:'workspace', label:'', jp:''},
  ];
  const toggleChatGroup = (groupKey: any) => {
    setChatGroupsOpen((prev: any) => ({ ...prev, [groupKey]: !prev[groupKey] }));
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
    memory_debug: ScreenMemoryDebug,
  }[active] || ScreenHome;

  if (typeof window !== 'undefined') {
    window.__SHOGUN_SHELL_ACTIVE_CHAT__ = activeChat;
  }

  const fmtHudElapsed = (startedAt: any) => {
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

  const beginSidebarResize = (e: any) => {
    if (!e || typeof e.clientX !== 'number') return;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    resizeStateRef.current = { active: true, moved: false, startX, startWidth };
    setSidebarResizeHint(true);
    const prevBodySelect = document.body.style.userSelect;
    const prevBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: any) => {
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

  // Include memory_debug nav entry only when the dev gate returns available.
  // Also inject the HIGH-priority unread count onto the Memory item so the
  // sidebar surfaces "you have N important things waiting" at a glance.
  const effectiveNav: any[] = (() => {
    const base: any[] = devGate.available
      ? [...NAV, { id: "memory_debug", label: "Memory DBG", jp: "DBG", icon: "memory", section: "workspace" }]
      : NAV;
    if (!memoryHighUnreadCount) return base;
    return base.map((n) => (n.id === 'memory' ? { ...n, count: memoryHighUnreadCount } : n));
  })();

  return (
    <div
      className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}
      data-screen-label={active}
      style={{
        gridTemplateColumns: sidebarCollapsed ? '0 minmax(0, 1fr)' : `${sidebarWidth}px minmax(0, 1fr)`,
        ...({ '--sidebar-w': sidebarCollapsed ? '0px' : `${sidebarWidth}px` } as any),
      }}
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
            {effectiveNav.filter(n => n.section === sec.id).map(n => (
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
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {React.createElement(Icon as any, { name: "chevronDown", size: 12, style: { transform: chatGroupsOpen.favorite ? 'rotate(0deg)' : 'rotate(-90deg)' } })}
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
                          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                          {React.createElement(Icon as any, { name: "chevronDown", size: 12, style: { transform: chatGroupsOpen.chats ? 'rotate(0deg)' : 'rotate(-90deg)' } })}
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
              <button
                type="button"
                className="hummingbird-icon-btn"
                title="Bad response"
                aria-label="Bad response"
                onClick={() => {
                  const ja = tweaks.language === 'jp';
                  const assistantText = ja
                    ? [
                        'データバックアップの期限やプラン確認が近づいています。カレンダーに時間を確保して取りこぼしを防ぎましょう。',
                        '',
                        '求人・案件情報: LinkedIn や YOUTRUST で AI リードエンジニアや役員クラスの求人が目立ちます。ざっと確認する価値ありです。',
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
                  const userText = ja ? '今日の優先事項を教えて' : "What are today's priorities?";
                  if (!assistantText || !userText) return;
                  executeAction('lesson.capture.rejection', {
                    userMsg: userText,
                    assistantMsg: assistantText,
                    chatId: activeChat || undefined,
                  }, { silentError: true, successMessage: "Got it — won't do that again." });
                }}
              >
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
            style={{
              left: userAnchor.left,
              bottom: userAnchor.bottom,
              width: userAnchor.width,
              maxHeight: userAnchor.maxHeight,
            }}
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
              <div className="context-awareness-heading">Context Awareness</div>
              <div className="context-panel-body-copy">
                SHOGUN AI remembers your work across apps, no integrations needed.
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
              onChange={(e) => setChatRenameModal((s: any) => ({ ...s, value: e.target.value }))}
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
                onChange={(e) => setChatWorkModal((s: any) => ({ ...s, query: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (filteredWorkProjects[0]) assignChatToWork(filteredWorkProjects[0].id, filteredWorkProjects[0].name);
                    else createAndAssignWork();
                  }
                }}
              />
            </div>
            {filteredWorkProjects.length > 0 ? (
              <div className="work-list">
                {filteredWorkProjects.map((p) => (
                  <button key={p.id} type="button" className="work-list-item" onClick={() => assignChatToWork(p.id, p.name)}>
                    <Icon name="folder" size={14}/>
                    <span>{p.name}</span>
                  </button>
                ))}
              </div>
            ) : chatWorkModal.query.trim() ? (
              <button type="button" className="work-list-item create" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }} onClick={createAndAssignWork}>
                <Icon name="plus" size={14}/>
                <span>「{chatWorkModal.query.trim()}」を作成して追加</span>
              </button>
            ) : (
              <div className="work-list-empty">プロジェクトはまだありません。名前を入力して作成してください。</div>
            )}
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

      {historicalImport && ReactDOM.createPortal(
        <div
          style={{
            position:'fixed', inset:0, zIndex:1090,
            background:'color-mix(in srgb, var(--bg) 78%, transparent)',
            backdropFilter:'blur(4px)',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !historicalImportBusy) setHistoricalImport(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width:'min(460px, 100%)',
              background:'var(--surface)',
              border:'1px solid var(--border-hi)',
              borderRadius:16,
              boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
              padding:22,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{fontSize:16, fontWeight:500, marginBottom:6}}>
              {historicalImport.provider === 'gmail'
                ? 'Import past Gmail'
                : historicalImport.provider === 'slack'
                  ? 'Import past Slack messages'
                  : historicalImport.provider === 'notion'
                    ? 'Import past Notion pages'
                    : historicalImport.provider === 'github'
                      ? 'Import past GitHub activity'
                      : historicalImport.provider === 'linear'
                        ? 'Import past Linear issues'
                        : historicalImport.provider === 'google_drive'
                          ? 'Import past Drive files'
                          : historicalImport.provider === 'zoom'
                            ? 'Import past Zoom recordings'
                            : 'Import past Calendar events'}
            </div>
            <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.5, marginBottom:16}}>
              How far back should SHOGUN pull history into Memory? You can change this later in Settings. Up to 1 year.
            </div>

            <div style={{display:'flex', flexDirection:'column', gap:8}}>
              {[
                { d: 7,   label: 'Past 7 days' },
                { d: 30,  label: 'Past 30 days' },
                { d: 90,  label: 'Past 3 months' },
                { d: 180, label: 'Past 6 months' },
                { d: 365, label: 'Past 1 year (max)' },
              ].map((opt) => {
                const selected = historicalImport.days === opt.d;
                return (
                  <button
                    key={opt.d}
                    type="button"
                    disabled={historicalImportBusy}
                    onClick={() => setHistoricalImport((prev: any) => (prev ? { ...prev, days: opt.d } : prev))}
                    style={{
                      display:'flex', alignItems:'center', gap:10,
                      padding:'10px 12px',
                      borderRadius:10,
                      border: selected
                        ? '1px solid color-mix(in srgb, var(--gold) 65%, var(--border))'
                        : '1px solid var(--border)',
                      background: selected
                        ? 'color-mix(in srgb, var(--gold) 8%, var(--surface))'
                        : 'var(--surface)',
                      color:'var(--text)',
                      fontSize:13,
                      cursor: historicalImportBusy ? 'default' : 'pointer',
                      fontFamily:'inherit',
                      textAlign:'left',
                    }}
                  >
                    <span style={{
                      width:14, height:14, borderRadius:'50%',
                      border:'1px solid ' + (selected ? 'var(--gold)' : 'var(--border-hi)'),
                      background: selected ? 'var(--gold)' : 'transparent',
                      flexShrink:0,
                    }}/>
                    <span>{opt.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="row" style={{marginTop:18, gap:8, justifyContent:'flex-end'}}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={historicalImportBusy}
                onClick={async () => {
                  const provider = historicalImport.provider;
                  setHistoricalImportBusy(true);
                  await executeAction(
                    'settings.save',
                    { section: provider, historicalSyncDays: 0 },
                    { silentError: true },
                  );
                  setHistoricalImportBusy(false);
                  setHistoricalImport(null);
                }}
              >
                Skip
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={historicalImportBusy}
                onClick={async () => {
                  const { provider, days } = historicalImport;
                  const providerLabels = {
                    gmail: 'Gmail',
                    google_calendar: 'Calendar',
                    google_drive: 'Drive',
                    slack: 'Slack',
                    notion: 'Notion',
                    github: 'GitHub',
                    linear: 'Linear',
                    zoom: 'Zoom',
                  };
                  const actionKeys = {
                    gmail: 'gmail.sync',
                    google_calendar: 'calendar.sync',
                    google_drive: 'drive.sync',
                    slack: 'slack.sync',
                    notion: 'notion.sync',
                    github: 'github.sync',
                    linear: 'linear.sync',
                    zoom: 'zoom.sync',
                  };
                  const label = (providerLabels as any)[provider] || provider;
                  const actionKey = (actionKeys as any)[provider] || `${provider}.sync`;
                  setHistoricalImportBusy(true);
                  pushToast(`${label}: importing past ${days} days…`, 'info');
                  const syncPayload = provider === 'google_calendar'
                    ? { calendarId: 'primary', days }
                    : { days };
                  const res = await executeAction(actionKey, syncPayload, { silentError: true });
                  if (res && res.ok) {
                    const n = (res.data && res.data.ingested) || 0;
                    const skipped = (res.data && res.data.skipped) || 0;
                    const msgSuffix = skipped > 0
                      ? ` (${skipped} already in memory)`
                      : '';
                    pushToast(
                      `${label}: imported ${n} item(s)${msgSuffix}`,
                      'success',
                    );
                  } else {
                    const msg = (res && res.error && res.error.message) || 'Import failed';
                    pushToast(msg, 'error');
                  }
                  await executeAction(
                    'settings.save',
                    { section: provider, historicalSyncDays: days },
                    { silentError: true },
                  );
                  setHistoricalImportBusy(false);
                  setHistoricalImport(null);
                  setHistoricalImportProgress(null);
                  window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
                }}
              >
                {historicalImportBusy ? (
                  historicalImportProgress &&
                  historicalImportProgress.provider === historicalImport.provider
                    ? (
                        historicalImportProgress.total != null && historicalImportProgress.total > 0
                          ? `Importing… ${historicalImportProgress.current}/${historicalImportProgress.total}`
                          : `Importing… ${historicalImportProgress.current}`
                      )
                    : 'Importing…'
                ) : 'Import'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {pasteTokenModal && ReactDOM.createPortal(
        <div
          style={{
            position:'fixed', inset:0, zIndex:1091,
            background:'color-mix(in srgb, var(--bg) 78%, transparent)',
            backdropFilter:'blur(4px)',
            display:'flex', alignItems:'center', justifyContent:'center',
            padding:20,
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !pasteTokenModal.busy) setPasteTokenModal(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            style={{
              width:'min(480px, 100%)',
              background:'var(--surface)',
              border:'1px solid var(--border-hi)',
              borderRadius:16,
              boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
              padding:22,
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{fontSize:16, fontWeight:500, marginBottom:6}}>
              {pasteTokenModal.provider === 'slack'
                ? 'Connect Slack'
                : pasteTokenModal.provider === 'notion'
                  ? 'Connect Notion'
                  : pasteTokenModal.provider === 'linear'
                    ? 'Connect Linear'
                    : pasteTokenModal.provider === 'zoom'
                      ? 'Connect Zoom'
                      : 'Connect GitHub'}
            </div>
            <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.55, marginBottom:14}}>
              {pasteTokenModal.provider === 'slack' ? (
                <>Paste a Slack Bot token (<code>xoxb-…</code>) or User token (<code>xoxp-…</code>). Required scopes: <code>channels:history</code>, <code>groups:history</code>, <code>im:history</code>, <code>channels:read</code>.</>
              ) : pasteTokenModal.provider === 'notion' ? (
                <>Paste a Notion <em>Internal Integration Token</em> (<code>ntn_…</code> / <code>secret_…</code>). Share each page/database with the integration from Notion.</>
              ) : pasteTokenModal.provider === 'linear' ? (
                <>Paste a Linear <em>Personal API Key</em> (starts with <code>lin_api_…</code>) from Linear → Settings → API, or a Linear OAuth access token.</>
              ) : pasteTokenModal.provider === 'zoom' ? (
                <>Paste a Zoom OAuth access token. Required scope: <code>cloud_recording:read</code> (User OAuth) or the Server-to-Server equivalent. Only cloud-recorded meetings are accessible.</>
              ) : (
                <>Paste a GitHub Personal Access Token. Recommended scopes: <code>repo</code>, <code>read:user</code>. Fine-grained PATs work too with read permissions on your repos.</>
              )}
            </div>

            <label style={{display:'block', fontSize:11, color:'var(--text-dim)', marginBottom:4}}>Token</label>
            <input
              type="password"
              value={pasteTokenModal.token}
              onChange={(e) => setPasteTokenModal((prev: any) => (prev ? { ...prev, token: e.target.value } : prev))}
              placeholder="Paste token here"
              autoFocus
              style={{
                width:'100%',
                padding:'10px 12px',
                borderRadius:8,
                border:'1px solid var(--border-hi)',
                background:'var(--bg)',
                color:'var(--text)',
                fontSize:13,
                fontFamily:'var(--font-mono)',
              }}
              disabled={pasteTokenModal.busy}
            />

            <div className="row" style={{marginTop:18, gap:8, justifyContent:'flex-end'}}>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={pasteTokenModal.busy}
                onClick={() => setPasteTokenModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={pasteTokenModal.busy || !pasteTokenModal.token.trim()}
                style={(pasteTokenModal.busy || !pasteTokenModal.token.trim()) ? {opacity:0.5, cursor:'not-allowed'} : undefined}
                onClick={async () => {
                  const provider = pasteTokenModal.provider;
                  const token = pasteTokenModal.token.trim();
                  if (!token) return;
                  setPasteTokenModal((prev: any) => (prev ? { ...prev, busy: true } : prev));
                  const res = await executeAction(
                    'integrations.import_credentials',
                    { provider, accessToken: token },
                    { silentError: true },
                  );
                  if (res && res.ok) {
                    pushToast(`${provider}: token saved`, 'success');
                    setPasteTokenModal(null);
                    // credentials-imported event from Tauri will fire
                    // `shogun-credentials-updated` which triggers the
                    // historical-import prompt automatically.
                  } else {
                    const msg = (res && res.error && res.error.message) || 'Save failed';
                    pushToast(msg, 'error');
                    setPasteTokenModal((prev: any) => (prev ? { ...prev, busy: false } : prev));
                  }
                }}
              >
                {pasteTokenModal.busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {toast && (
        <div className={'app-toast '+toast.kind+(toast.action?' has-action':'')}>
          <span className="app-toast__msg">{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              className="app-toast__action"
              onClick={() => {
                try { toast.action.onClick(); } catch (_) { /* ignore */ }
                if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
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
          width:min(400px, calc(100vw - 32px));
          background:var(--surface);
          border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:var(--shadow-lg);
          padding:18px 20px 16px;
          position:relative;
        }
        .chat-dialog.rename { width:min(380px, calc(100vw - 32px)); }
        .chat-dialog.work { width:min(440px, calc(100vw - 32px)); padding:16px 18px 14px; }
        .chat-dialog-title {
          font-size:15px; line-height:1.3; letter-spacing:-0.005em; color:var(--text); font-weight:600;
        }
        .chat-dialog.rename .chat-dialog-title { font-size:14px; letter-spacing:0; }
        .chat-dialog.work .chat-dialog-title { font-size:15px; letter-spacing:0; }
        .chat-dialog-desc {
          margin-top:6px; color:var(--text-dim); font-size:12.5px; line-height:1.5;
        }
        .chat-dialog-actions {
          margin-top:16px; display:flex; gap:8px; justify-content:flex-end;
        }
        .chat-dialog-btn {
          min-width:72px; height:32px; border-radius:var(--radius-sm); border:1px solid transparent;
          cursor:pointer; font-size:13px; font-weight:500; color:var(--text);
          background:var(--surface-2);
          padding:0 14px;
          transition:background 120ms, border-color 120ms, color 120ms;
        }
        .chat-dialog-btn:hover { background:color-mix(in srgb, var(--surface-2) 80%, var(--border-hi)); }
        .chat-dialog-btn.ghost { border-color:var(--border-hi); background:transparent; }
        .chat-dialog-btn.ghost:hover { background:var(--surface-2); }
        .chat-dialog-btn.solid { background:var(--gold); color:var(--bg); border-color:var(--gold); }
        .chat-dialog-btn.solid:hover { background:var(--gold-hover); border-color:var(--gold-hover); }
        .chat-dialog-btn.danger { background:var(--danger); color:#fff; border-color:var(--danger); }
        .chat-dialog-btn.danger:hover { background:color-mix(in srgb, var(--danger) 80%, #000); }
        .chat-dialog-input {
          width:100%; margin-top:10px; height:34px; border-radius:var(--radius-sm);
          border:1px solid var(--border-hi);
          background:var(--surface-2);
          color:var(--text); font-size:13px; padding:0 10px;
          outline:none;
          transition:border-color 120ms, box-shadow 120ms;
        }
        .chat-dialog-input:focus {
          border-color:var(--gold);
          box-shadow:0 0 0 2px color-mix(in srgb, var(--gold) 28%, transparent);
        }
        .chat-dialog-close {
          position:absolute; right:10px; top:10px; width:24px; height:24px;
          border:0; background:transparent; color:var(--text-dim); border-radius:var(--radius-sm); cursor:pointer;
          display:flex; align-items:center; justify-content:center;
          transition:background 120ms, color 120ms;
        }
        .chat-dialog-close:hover { color:var(--text); background:var(--surface-2); }
        .work-search-wrap {
          margin-top:10px; height:34px; border-radius:var(--radius-sm);
          border:1px solid var(--border-hi);
          display:flex; align-items:center; gap:8px; padding:0 10px;
          color:var(--text-dim); background:var(--surface-2);
        }
        .work-search-input {
          flex:1; min-width:0; border:0; background:transparent; outline:none; color:var(--text); font-size:13px;
        }
        .work-list {
          margin-top:8px;
          border:1px solid var(--border);
          border-radius:var(--radius-sm);
          overflow:auto;
          max-height:220px;
          background:var(--surface);
        }
        .work-list:empty { display:none; }
        .work-list-item {
          width:100%; border:0; border-top:1px solid color-mix(in srgb, var(--border) 85%, transparent);
          background:transparent; color:var(--text); cursor:pointer; text-align:left;
          display:flex; align-items:center; gap:10px; padding:8px 12px; font-size:13px;
          transition:background 120ms;
        }
        .work-list-item:first-child { border-top:0; }
        .work-list-item:hover { background:var(--surface-2); }
        .work-list-item.create { color:var(--gold); }
        .work-list-empty {
          padding:16px 12px; text-align:center; color:var(--text-dim); font-size:12.5px;
          border:1px dashed var(--border); border-radius:var(--radius-sm);
          margin-top:8px;
        }

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
        .user-cluster { padding:10px; margin-top:auto; }
        .context-enabled-pill {
          display:flex; align-items:center; justify-content:space-between; gap:10px;
          box-sizing:border-box;
          width:100%;
          min-height:44px;
          padding:0 14px;
          border-radius:13px;
          border:1px solid color-mix(in srgb, var(--border-hi) 58%, transparent);
          background:color-mix(in srgb, var(--surface) 78%, var(--pill-tint) 22%);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.02);
          color:var(--text);
          font-size:13px;
          font-weight:480;
          letter-spacing:0.01em;
          margin:0 0 8px;
          text-align:left;
          cursor:pointer;
          transition:border-color 120ms, background 120ms;
        }
        .context-enabled-pill:hover {
          border-color:color-mix(in srgb, var(--border-hi) 88%, var(--gold-dim) 12%);
          background:color-mix(in srgb, var(--surface) 72%, var(--pill-tint-hover) 28%);
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
          background:color-mix(in srgb, var(--surface) 86%, var(--pill-tint-panel) 14%);
          border:1px solid color-mix(in srgb, var(--border-hi) 78%, transparent);
          border-radius:14px;
          box-shadow:0 26px 54px -16px rgba(0,0,0,0.65), 0 4px 12px rgba(0,0,0,0.36);
          padding:10px;
          animation:contextPanelIn 140ms var(--ease-out);
        }
        @keyframes contextPanelIn {
          from { opacity:0; transform:translateY(8px) scale(0.985); }
          to { opacity:1; transform:translateY(0) scale(1); }
        }
        .context-panel-title {
          color:var(--text-dim);
          font-size:10.5px;
          margin-bottom:8px;
          padding:0 2px;
        }
        .context-awareness-card {
          position:relative;
          border-radius:12px;
          border:1px solid color-mix(in srgb, var(--border-hi) 70%, transparent);
          background:linear-gradient(180deg, color-mix(in srgb, var(--surface-2) 80%, var(--pill-tint) 20%), color-mix(in srgb, var(--surface) 86%, var(--pill-tint) 14%));
          padding:10px 12px 9px;
          margin-bottom:6px;
        }
        .context-awareness-close {
          position:absolute;
          right:8px;
          top:8px;
          width:20px;
          height:20px;
          border:0;
          border-radius:6px;
          background:transparent;
          color:var(--text-mute);
          display:flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
        }
        .context-awareness-close:hover { background:var(--surface-2); color:var(--text); }
        .context-awareness-heading {
          font-size:13px;
          font-weight:500;
          letter-spacing:0;
          margin-bottom:4px;
          padding-right:22px;
        }
        .context-panel-body-copy {
          color:var(--text-mute);
          line-height:1.45;
          font-size:11.5px;
        }
        .context-link-btn {
          margin-top:6px;
          padding:0;
          border:0;
          background:transparent;
          color:var(--text);
          display:inline-flex;
          gap:4px;
          align-items:center;
          font-size:11.5px;
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
          font-size:12px;
          padding:8px 4px;
          cursor:pointer;
        }
        .context-panel-row:hover { color:var(--gold); }
        .context-panel-foot {
          margin-top:2px;
          padding-top:8px;
          border-top:1px solid var(--border);
          display:flex;
          align-items:center;
          justify-content:flex-end;
          gap:10px;
        }
        .context-manage-btn {
          border:1px solid var(--border-hi);
          background:var(--surface-2);
          color:var(--text);
          font-size:11.5px;
          border-radius:10px;
          padding:6px 10px;
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
          background:color-mix(in srgb, var(--surface) 78%, var(--pill-tint) 22%);
          border:1px solid color-mix(in srgb, var(--border-hi) 58%, transparent);
          border-radius:13px;
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.02);
          cursor:pointer;
          transition:border-color 120ms, background 120ms;
        }
        .user-pill:hover {
          border-color:color-mix(in srgb, var(--border-hi) 88%, var(--gold-dim) 12%);
          background:color-mix(in srgb, var(--surface) 72%, var(--pill-tint-hover) 28%);
        }

        /* User floating menu */
        .user-float {
          position:fixed; z-index:1081;
          background:var(--surface); border:1px solid var(--border-hi);
          border-radius:18px;
          box-shadow:0 26px 56px -16px rgba(0,0,0,0.62), 0 2px 0 rgba(0,0,0,0.32);
          padding:6px 0;
          overflow-x:hidden;
          overflow-y:auto;
          /* width is pinned to the user-pill's width by setUserAnchor — no min */
        }
        .user-float-row .en-only,
        .user-float-row .jp {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
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
        .app-toast.has-action { display:flex; align-items:center; gap:10px; max-width:420px; }
        .app-toast__msg { flex:1 1 auto; min-width:0; }
        .app-toast__action {
          flex:0 0 auto;
          padding:4px 10px; border-radius:999px;
          border:1px solid color-mix(in srgb, var(--gold) 45%, var(--border-hi));
          background:color-mix(in srgb, var(--gold) 10%, var(--surface));
          color:var(--text); font-size:11px; font-weight:600; cursor:pointer;
          white-space:nowrap;
        }
        .app-toast__action:hover { background:color-mix(in srgb, var(--gold) 18%, var(--surface)); }
        .app-toast__action:focus-visible { outline:2px solid var(--gold); outline-offset:2px; }

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
