/* eslint-disable max-lines -- App shell: state clusters extracted to src/app/hooks/ + style to MainApp.css (Phase 5 Step 1). Remaining bulk is ~1900 lines of JSX + effects + handlers. */
// MainApp extracted from App.tsx (Phase 2 Step 11)
// State clusters extracted to custom hooks in src/app/hooks/ (Phase 5 Step 1).
// Inline <style> block extracted to MainApp.css (Phase 5 Step 1.5).
import './MainApp.css';
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
  NAV,
  REMOVED_NAV_IDS,
  CHAT_CONTEXT_TELEMETRY_LS,
  CHAT_WORKSPACE_LS,
  SIDEBAR_WIDTH_LS,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
} from './lib/constants';
import {
  profileStateFromSections,
  isProfilePhotoDataUrl,
  purgeDummyWorkProjects,
  purgeDummyChats,
  applySavedAppearance,
} from './lib/helpers';
import { ensureRuntimeDeps } from './lib/mockIpc';
import { ShogunKeyboardShortcuts } from '@/shared/lib/keyboard-shortcuts';
import { ShogunClerkAuth } from '@/shared/lib/clerk-auth';
import { MeetingMediaRecording } from '@/shared/lib/meeting-media-recording';

import { ShareModal } from './shell/ShareModal';
import { TopBar } from './shell/TopBar';
import { Sidebar } from './shell/Sidebar';
import { ChatDeleteModal } from './shell/portals/ChatDeleteModal';
import { ChatRenameModal } from './shell/portals/ChatRenameModal';
import { ChatMenu } from './shell/portals/ChatMenu';
import { ChatWorkModal } from './shell/portals/ChatWorkModal';
import { ContextPanel } from './shell/portals/ContextPanel';
import { HistoricalImportModal } from './shell/portals/HistoricalImportModal';
import { UserFloatMenu } from './shell/portals/UserFloatMenu';
import { PasteTokenModal } from './shell/portals/PasteTokenModal';
import { HummingbirdOverlay } from './shell/portals/HummingbirdOverlay';

import { useHummingbird } from './hooks/useHummingbird';
import { useShareControls } from './hooks/useShareControls';
import { useFloatMenus } from './hooks/useFloatMenus';
import { useSidebarLayout } from './hooks/useSidebarLayout';
import { useProfile } from './hooks/useProfile';
import { useHistoricalImport } from './hooks/useHistoricalImport';
import { useWriteConfirm } from './hooks/useWriteConfirm';
import { useChatModals } from './hooks/useChatModals';
import { useChatHistory } from './hooks/useChatHistory';
import { useMeetingHud } from './hooks/useMeetingHud';
import { useTweaks } from './hooks/useTweaks';

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
  // Chat history cluster
  const {
    activeChat, chats, dragId, dragOver, chatGroupsOpen,
    setActiveChat, setChats, setDragId, setDragOver, setChatGroupsOpen,
  } = useChatHistory();
  const dragIdRef = useRef<any>(null);
  const dragOverRef = useRef<any>(null);
  const suppressChatRowClickRef = useRef(false);
  // Tweaks cluster
  const { tweaks, setTweaks } = useTweaks();
  // Share controls cluster (includes editMode + favorited)
  const {
    shareOpen, shareMode, shareTip, editMode, favorited,
    setShareOpen, setShareMode, setShareTip, setEditMode, setFavorited,
  } = useShareControls();
  // Hummingbird cluster
  const { hummingbirdOpen, hummingbirdInput, setHummingbirdOpen, setHummingbirdInput } = useHummingbird();
  // Float menus cluster
  const {
    userOpen, userAnchor, contextPanelOpen, contextPanelAnchor,
    setUserOpen, setUserAnchor, setContextPanelOpen, setContextPanelAnchor,
  } = useFloatMenus();
  // Chat modals cluster
  const {
    chatMenu, chatRenameModal, chatDeleteModal, chatWorkModal,
    setChatMenu, setChatRenameModal, setChatDeleteModal, setChatWorkModal,
  } = useChatModals();
  const [workProjects, setWorkProjects] = useState<any[]>([]);
  const chatWorkspaceHydratedRef = useRef(false);
  const userBtnRef = React.useRef<any>(null);
  const contextBtnRef = React.useRef<any>(null);
  // Profile cluster
  const {
    profileDisplayName, profileAvatarGlyph, profileAvatarImageDataUrl,
    setProfileDisplayName, setProfileAvatarGlyph, setProfileAvatarImageDataUrl,
  } = useProfile();
  const [settingsOpen, setSettingsOpen] = useState<any>(null); // null | 'general' | 'system' | 'appearance' | 'privacy' | 'data' | 'hummingbird' | 'meetings' | 'chat' | 'integrations' | 'shortcuts' | 'team' | 'support' | 'api' | 'upgrade' | 'changelog' | 'feedback'
  // Historical import cluster
  const {
    historicalImport, historicalImportBusy, historicalImportProgress,
    setHistoricalImport, setHistoricalImportBusy, setHistoricalImportProgress,
  } = useHistoricalImport();
  // { provider, token, busy } when the Paste-token modal is open (Slack / Notion / GitHub).
  const [pasteTokenModal, setPasteTokenModal] = useState<any>(null);
  const [toast, setToast] = useState<any>(null);
  // Write confirm cluster
  const { writeConfirm, writePending, setWriteConfirm, setWritePending } = useWriteConfirm();
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
  // Sidebar layout cluster
  const { sidebarCollapsed, sidebarWidth, sidebarResizeHint, setSidebarCollapsed, setSidebarWidth, setSidebarResizeHint } = useSidebarLayout();
  const resizeStateRef = useRef({ active: false, moved: false, startX: 0, startWidth: 240 });
  // Meeting HUD cluster
  const { meetingHud, meetingHudTick, setMeetingHud, setMeetingHudTick } = useMeetingHud();
  const navHistRef = useRef<any>(null);
  const skipNavHistRef = useRef(false);
  const shortcutBindingsRef = useRef(
    ShogunKeyboardShortcuts
      ? ShogunKeyboardShortcuts.mergeShortcutBindings()
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
  }, [setActive, setMeetingHud]);

  useEffect(() => {
    if (!meetingHud) return undefined;
    const id = window.setInterval(() => setMeetingHudTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [meetingHud, setMeetingHudTick]);

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
  }, [hummingbirdOpen, setHummingbirdOpen]);

  useEffect(() => {
    if (!contextPanelOpen) return undefined;
    const onKey = (e: any) => {
      if (e.key === 'Escape') setContextPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextPanelOpen, setContextPanelOpen]);

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
  }, [setHistoricalImportProgress]);

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

  const executeAction = useCallback(async (actionKey: any, payload: any, options: any = {}) => {
    if (!runtimeRef.current) {
      pushToastRef.current('IPC runtime unavailable', 'error');
      return { ok:false };
    }
    let res;
    try {
      res = await runtimeRef.current.registry.run(actionKey, payload);
    } catch (err: any) {
      const msg = err && err.message ? String(err.message) : 'Action failed unexpectedly';
      if (!options.silentError) pushToastRef.current(msg, 'error');
      return { ok: false, error: { code: 'RUNTIME_EXCEPTION', message: msg } };
    }
    if (res.ok && res.data && res.data.notImplemented) {
      pushToastRef.current(res.data.message || 'Not available in this version', 'warn');
      return res;
    }
    if (res.ok && res.data && res.data.honestPreferenceOnly) {
      pushToastRef.current(res.data.message || 'Preference saved locally only.', 'info');
      return res;
    }
    if (res.ok) {
      if (options.successMessage) pushToastRef.current(options.successMessage, 'success');
    } else if (!options.silentError) {
      pushToastRef.current(res.error?.message || 'Action failed', 'error');
    }
    return res;
  }, []);

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
        if (ShogunKeyboardShortcuts) {
          shortcutBindingsRef.current = ShogunKeyboardShortcuts.mergeShortcutBindings(raw);
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
  }, [setActiveChat, setChats]);

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

  const toggleFav = useCallback((id: any) => setChats(cs => cs.map(c => c.id===id ? {...c, favorite: !c.favorite} : c)), [setChats]);
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
  }, [setChatMenu]);
  const closeChatMenu = useCallback(() => setChatMenu({ open:false, chatId:null, x:0, y:0, width:240 }), [setChatMenu]);
  const openRenameModal = useCallback((id: any) => {
    const current = chats.find((c) => c.id === id);
    if (!current) return;
    setChatRenameModal({ open:true, chatId:id, value:current.title || '' });
  }, [chats, setChatRenameModal]);
  const submitRenameModal = useCallback(() => {
    const id = chatRenameModal.chatId;
    const trimmed = String(chatRenameModal.value || '').trim();
    if (!id || !trimmed) return;
    setChats((cs) => cs.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    setChatRenameModal({ open:false, chatId:null, value:'' });
    pushToast('チャット名を更新しました', 'success');
  }, [chatRenameModal, setChatRenameModal, setChats]);
  const openDeleteModal = useCallback((id: any) => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setChatDeleteModal({ open:true, chatId:id });
  }, [chats, setChatDeleteModal]);
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
  }, [activeChat, chatDeleteModal.chatId, setActiveChat, setChatDeleteModal, setChats]);
  const openWorkModal = useCallback((id: any) => {
    const target = chats.find((c) => c.id === id);
    if (!target) return;
    setChatWorkModal({ open:true, chatId:id, query:'' });
  }, [chats, setChatWorkModal]);
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
  }, [chatWorkModal.chatId, setActiveChat, setChatWorkModal, setChats]);
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
  }, [closeChatMenu, openDeleteModal, openRenameModal, openWorkModal, toggleFav, toggleWorkArchiveForChat]);
  useEffect(() => {
    if (!chatMenu.open) return undefined;
    const onKey = (e: any) => {
      if (e.key === 'Escape') closeChatMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatMenu.open, closeChatMenu]);
  const clearChatDrag = useCallback(() => {
    dragIdRef.current = null;
    dragOverRef.current = null;
    setDragId(null);
    setDragOver(null);
  }, [setDragId, setDragOver]);
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
  }, [setChats]);
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
  }, [setDragOver]);
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
    [applyChatDragReorder, clearChatDrag, setDragId, setDragOver, updateDragOverFromPoint],
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
      if (ShogunKeyboardShortcuts) {
        shortcutBindingsRef.current = ShogunKeyboardShortcuts.mergeShortcutBindings(
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
  }, [executeAction, setProfileAvatarGlyph, setProfileAvatarImageDataUrl, setProfileDisplayName]);

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
  }, [setProfileAvatarGlyph, setProfileAvatarImageDataUrl, setProfileDisplayName]);

  useEffect(() => {
    if (ShogunClerkAuth && typeof ShogunClerkAuth.init === 'function') {
      void ShogunClerkAuth.init();
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
      const Kbd = ShogunKeyboardShortcuts;
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
  }, [bioGate.ready, bioGate.open, active, createNewChat, setSidebarCollapsed]);


  useEffect(() => {
    const handler = (e: any) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({type:'__edit_mode_available'}, '*');
    return () => window.removeEventListener('message', handler);
  }, [setEditMode]);

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
    const M = MeetingMediaRecording;
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
      <TopBar
        active={active}
        setActive={setActive}
        shareTip={shareTip}
        setShareTip={setShareTip}
        requestWriteAction={requestWriteAction}
        favorited={favorited}
        setFavorited={setFavorited}
        setHummingbirdOpen={setHummingbirdOpen}
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
      />

      {/* Sidebar */}
      <Sidebar
        sections={sections}
        effectiveNav={effectiveNav}
        active={active}
        setActive={setActive}
        createNewChat={createNewChat}
        dragOver={dragOver}
        toggleChatGroup={toggleChatGroup}
        chatGroupsOpen={chatGroupsOpen}
        favChats={favChats}
        restChats={restChats}
        onChatRowPointerDown={onChatRowPointerDown}
        openChatMenuAt={openChatMenuAt}
        activeChat={activeChat}
        suppressChatRowClickRef={suppressChatRowClickRef}
        setActiveChat={setActiveChat}
        dragId={dragId}
        contextBtnRef={contextBtnRef}
        contextPanelOpen={contextPanelOpen}
        openContextPanel={openContextPanel}
        userBtnRef={userBtnRef}
        openUser={openUser}
        profileAvatarImageDataUrl={profileAvatarImageDataUrl}
        profileAvatarGlyph={profileAvatarGlyph}
        profileDisplayName={profileDisplayName}
        userOpen={userOpen}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        sidebarWidth={sidebarWidth}
        sidebarResizeHint={sidebarResizeHint}
        setSidebarResizeHint={setSidebarResizeHint}
        resizeStateRef={resizeStateRef}
        beginSidebarResize={beginSidebarResize}
      />

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
      <ShareModal
        shareOpen={shareOpen}
        setShareOpen={setShareOpen}
        shareMode={shareMode}
        setShareMode={setShareMode}
        chats={chats}
        activeChat={activeChat}
        executeAction={executeAction}
      />

      <HummingbirdOverlay
        open={hummingbirdOpen}
        language={tweaks.language}
        input={hummingbirdInput}
        activeChat={activeChat}
        onClose={() => setHummingbirdOpen(false)}
        onInputChange={setHummingbirdInput}
        pushToast={pushToastRef.current}
        executeAction={executeAction}
      />

      {/* User floating menu — portaled for correct hit-testing over the shell */}
      <UserFloatMenu
        open={userOpen}
        anchor={userAnchor}
        profileDisplayName={profileDisplayName}
        profileAvatarGlyph={profileAvatarGlyph}
        profileAvatarImageDataUrl={profileAvatarImageDataUrl}
        onClose={() => setUserOpen(false)}
        onOpenSettings={(pane) => setSettingsOpen(pane)}
      />

      <ContextPanel
        open={contextPanelOpen}
        anchor={contextPanelAnchor}
        onClose={() => setContextPanelOpen(false)}
        onOpenSettings={(pane) => setSettingsOpen(pane)}
      />

      <ChatMenu
        open={chatMenu.open}
        chatId={chatMenu.chatId}
        x={chatMenu.x}
        y={chatMenu.y}
        width={chatMenu.width}
        chatMenuTarget={chatMenuTarget}
        chatMenuTargetWork={chatMenuTargetWork}
        onClose={closeChatMenu}
        onAction={runChatMenuAction}
      />

      <ChatDeleteModal
        open={chatDeleteModal.open}
        chatDeleteTarget={chatDeleteTarget}
        onClose={() => setChatDeleteModal({ open:false, chatId:null })}
        onConfirm={confirmDeleteChat}
      />

      <ChatRenameModal
        open={chatRenameModal.open}
        value={chatRenameModal.value}
        onClose={() => setChatRenameModal({ open:false, chatId:null, value:'' })}
        onChange={(value) => setChatRenameModal((s: any) => ({ ...s, value }))}
        onSubmit={submitRenameModal}
      />

      <ChatWorkModal
        open={chatWorkModal.open}
        query={chatWorkModal.query}
        filteredWorkProjects={filteredWorkProjects}
        onClose={() => setChatWorkModal({ open:false, chatId:null, query:'' })}
        onQueryChange={(query) => setChatWorkModal((s: any) => ({ ...s, query }))}
        onAssignToWork={assignChatToWork}
        onCreateAndAssign={createAndAssignWork}
      />

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

      <HistoricalImportModal
        historicalImport={historicalImport}
        historicalImportBusy={historicalImportBusy}
        historicalImportProgress={historicalImportProgress}
        onClose={() => setHistoricalImport(null)}
        onDaysChange={(days) => setHistoricalImport((prev: any) => (prev ? { ...prev, days } : prev))}
        onSkip={async () => {
          const provider = historicalImport!.provider;
          setHistoricalImportBusy(true);
          await executeAction(
            'settings.save',
            { section: provider, historicalSyncDays: 0 },
            { silentError: true },
          );
          setHistoricalImportBusy(false);
          setHistoricalImport(null);
        }}
        onImport={async () => {
          const { provider, days } = historicalImport!;
          const providerLabels: Record<string, string> = {
            gmail: 'Gmail',
            google_calendar: 'Calendar',
            google_drive: 'Drive',
            slack: 'Slack',
            notion: 'Notion',
            github: 'GitHub',
            linear: 'Linear',
            zoom: 'Zoom',
          };
          const actionKeys: Record<string, string> = {
            gmail: 'gmail.sync',
            google_calendar: 'calendar.sync',
            google_drive: 'drive.sync',
            slack: 'slack.sync',
            notion: 'notion.sync',
            github: 'github.sync',
            linear: 'linear.sync',
            zoom: 'zoom.sync',
          };
          const label = providerLabels[provider] || provider;
          const actionKey = actionKeys[provider] || `${provider}.sync`;
          setHistoricalImportBusy(true);
          pushToast(`${label}: importing past ${days} days…`, 'info');
          const syncPayload = provider === 'google_calendar'
            ? { calendarId: 'primary', days }
            : { days };
          const res = await executeAction(actionKey, syncPayload, { silentError: true });
          if (res && res.ok) {
            const n = (res.data && res.data.ingested) || 0;
            const skipped = (res.data && res.data.skipped) || 0;
            const msgSuffix = skipped > 0 ? ` (${skipped} already in memory)` : '';
            pushToast(`${label}: imported ${n} item(s)${msgSuffix}`, 'success');
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
      />

      <PasteTokenModal
        pasteTokenModal={pasteTokenModal}
        onClose={() => setPasteTokenModal(null)}
        onTokenChange={(token) => setPasteTokenModal((prev: any) => (prev ? { ...prev, token } : prev))}
        onSave={async () => {
          const provider = pasteTokenModal!.provider;
          const token = pasteTokenModal!.token.trim();
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
      />

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

    </div>
  );
}
