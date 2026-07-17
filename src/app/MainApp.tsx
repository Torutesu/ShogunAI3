// MainApp extracted from App.tsx (Phase 2 Step 11)
// State clusters extracted to custom hooks in src/app/hooks/ (Phase 5 Step 1).
// Inline <style> block extracted to MainApp.css (Phase 5 Step 1.5).
// Handler bundles extracted to custom hooks (Phase 7 Step 1).
// Runtime context, event bus, and portal cluster extracted (Phase 5 Step 2).
import './MainApp.css';
import { t } from '@/shared/lib/i18n';
import React, { useState, useEffect, useRef, useCallback, useLayoutEffect, lazy, Suspense } from 'react';

const ScreenHome = lazy(() => import('@/features/home').then(m => ({ default: m.ScreenHome })));
const ScreenMemory = lazy(() => import('@/features/memory').then(m => ({ default: m.ScreenMemory })));
const ScreenMeetings = lazy(() => import('@/features/meetings').then(m => ({ default: m.ScreenMeetings })));
const ScreenWork = lazy(() => import('@/features/work').then(m => ({ default: m.ScreenWork })));
const ScreenAgents = lazy(() => import('@/features/agents').then(m => ({ default: m.ScreenAgents })));
const ScreenChat = lazy(() => import('@/features/chat').then(m => ({ default: m.ScreenChat })));
const ScreenMemoryDebug = lazy(() => import('@/features/memory-debug').then(m => ({ default: m.ScreenMemoryDebug })));
import {
  NAV,
  REMOVED_NAV_IDS,
  CHAT_CONTEXT_TELEMETRY_LS,
  CHAT_WORKSPACE_LS,
  SIDEBAR_WIDTH_LS,
} from './lib/constants';
import {
  profileStateFromSections,
  purgeDummyWorkProjects,
  purgeDummyChats,
  applySavedAppearance,
} from './lib/helpers';
import { ensureRuntimeDeps } from './lib/mockIpc';
import { ShogunKeyboardShortcuts } from '@/shared/lib/keyboard-shortcuts';
import { ShogunClerkAuth } from '@/shared/lib/clerk-auth';
import { MeetingMediaRecording } from '@/shared/lib/meeting-media-recording';
import { ShogunRuntimeProvider, useBuildShogunRuntime, type PushToastOptions, type ToastKind } from './context/ShogunRuntimeContext';
import { useAppEventBus } from './hooks/useAppEventBus';

import { TopBar } from './shell/TopBar';
import { Sidebar } from './shell/Sidebar';
import { MeetingHud } from './shell/MeetingHud';
import { MeetingPromptBanner } from './shell/MeetingPromptBanner';
import {
  dispatchMeetingDetected,
  stashPendingMeetingDetect,
  type MeetingDetectDetail,
} from '@/shared/lib/meeting-detect-events';
import { BioLockOverlay } from './shell/BioLockOverlay';
import { MainAppPortals } from './shell/MainAppPortals';

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
import { useChatDrag } from './hooks/useChatDrag';
import { useChatActions } from './hooks/useChatActions';

declare const window: Window & {
  __TAURI_INTERNALS__?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> };
  __SHOGUN_SHELL_ACTIVE_CHAT__?: string;
  __SHOGUN_SETTINGS_BRIEF__?: Record<string, unknown>;
  shogunBriefTelemetrySink?: (row: Record<string, unknown>) => void;
};

export function MainApp(): React.ReactElement {
  ensureRuntimeDeps();
  const [active, setActive] = useState(() => {
    const saved = localStorage.getItem('shogun-active') || 'home';
    return REMOVED_NAV_IDS.has(saved) ? 'home' : saved;
  });
  const {
    activeChat, chats, dragId, dragOver, chatGroupsOpen,
    setActiveChat, setChats, setDragId, setDragOver, setChatGroupsOpen,
  } = useChatHistory();
  const { suppressChatRowClickRef, onChatRowPointerDown } = useChatDrag(setChats, setDragId, setDragOver);
  const { tweaks, setTweaks } = useTweaks();
  const {
    shareOpen, shareMode, shareTip, editMode, favorited,
    setShareOpen, setShareMode, setShareTip, setEditMode, setFavorited,
  } = useShareControls();
  const { hummingbirdOpen, hummingbirdInput, setHummingbirdOpen, setHummingbirdInput } = useHummingbird();
  const {
    userOpen, userAnchor, contextPanelOpen, contextPanelAnchor,
    setUserOpen, setUserAnchor, setContextPanelOpen, setContextPanelAnchor,
  } = useFloatMenus();
  const {
    chatMenu, chatRenameModal, chatDeleteModal, chatWorkModal,
    setChatMenu, setChatRenameModal, setChatDeleteModal, setChatWorkModal,
  } = useChatModals();
  const [workProjects, setWorkProjects] = useState<Record<string, unknown>[]>([]);
  const chatWorkspaceHydratedRef = useRef(false);
  const userBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const contextBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const {
    profileDisplayName, profileAvatarGlyph, profileAvatarImageDataUrl,
    setProfileDisplayName, setProfileAvatarGlyph, setProfileAvatarImageDataUrl,
  } = useProfile();
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const {
    historicalImport, historicalImportBusy, historicalImportProgress,
    setHistoricalImport, setHistoricalImportBusy, setHistoricalImportProgress,
  } = useHistoricalImport();
  const [pasteTokenModal, setPasteTokenModal] = useState<Record<string, unknown> | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; action?: { label: string; onClick: () => void } } | null>(null);
  const { writeConfirm, writePending, setWriteConfirm, setWritePending } = useWriteConfirm();

  const toastTimerRef = useRef<number | null>(null);
  const bioWantLockRef = useRef(false);
  const [bioGate, setBioGate] = useState({ ready: false, open: false });
  const [memoryHighUnreadCount, setMemoryHighUnreadCount] = useState(0);
  const {
    sidebarCollapsed, sidebarWidth, sidebarResizeHint,
    setSidebarCollapsed, setSidebarResizeHint, resizeStateRef, beginSidebarResize,
  } = useSidebarLayout();
  const { meetingHud, meetingHudTick, setMeetingHud, setMeetingHudTick } = useMeetingHud();
  const [meetingPrompt, setMeetingPrompt] = useState<MeetingDetectDetail | null>(null);
  const [appDetectAlerts, setAppDetectAlerts] = useState(true);
  const lastMeetingPromptKeyRef = useRef<{ key: string; at: number } | null>(null);
  const navHistRef = useRef<{ entries: string[]; cursor: number } | null>(null);
  const skipNavHistRef = useRef(false);
  const shortcutBindingsRef = useRef(
    ShogunKeyboardShortcuts
      ? ShogunKeyboardShortcuts.mergeShortcutBindings()
      : {},
  );
  const ipcRuntimeRef = useRef<{ client: { hasTauriInvoke?: () => boolean } } | null>(null);
  const executeActionRef = useRef<ReturnType<typeof useBuildShogunRuntime>['executeAction']>(() => Promise.resolve({ ok: false }));
  const pushToastRef = useRef<(message: string, kind?: ToastKind, options?: PushToastOptions) => void>(() => {});

  const openUser = () => {
    const r = userBtnRef.current?.getBoundingClientRect();
    if (r) {
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
    } catch { /* ignore */ }
  }, [sidebarWidth]);

  useEffect(() => {
    if (!meetingHud) return undefined;
    const id = window.setInterval(() => setMeetingHudTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [meetingHud, setMeetingHudTick]);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const pushToast = useCallback((message: string, kind: ToastKind = 'info', options: PushToastOptions = {}) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    const action =
      options.action && typeof options.action.onClick === 'function' && options.action.label
        ? { label: String(options.action.label), onClick: options.action.onClick }
        : null;
    setToast(action ? { message, kind, action } : { message, kind });
    const ttl = action ? (options.durationMs || 8000) : (options.durationMs || 2200);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ttl);
  }, []);

  const createNewChat = useCallback(() => {
    const id = `c${Date.now()}`;
    const item = { id, title: 'New Chat', time: '', when: 'TODAY', jp: '今日', favorite: false };
    setChats((prev) => [item, ...prev]);
    setActiveChat(id);
    setActive('chat');
    pushToast('New Chat created', 'success');
  }, [pushToast, setActiveChat, setChats]);

  const { executeAction, requestWriteAction, runtimeValue } = useBuildShogunRuntime({
    activeChat,
    chats,
    workProjects,
    setChats,
    setWorkProjects,
    setSettingsOpen,
    setActive,
    setChatWorkModal,
    setHistoricalImport,
    setPasteTokenModal,
    setWriteConfirm,
    pushToast,
    createNewChat,
    shortcutBindingsRef,
    ipcRuntimeRef,
  });

  const acceptMeetingPrompt = useCallback(
    (detail: MeetingDetectDetail) => {
      setMeetingPrompt(null);
      stashPendingMeetingDetect(detail);
      setActive('meetings');
      dispatchMeetingDetected({
        ...detail,
        openNotes: true,
        autoRecord: true,
      });
    },
    [setActive],
  );

  const shouldShowMeetingPrompt = useCallback((detail: MeetingDetectDetail) => {
    const key = String(detail.meeting_id || `${detail.provider}:${detail.url || detail.eventId}`);
    const now = Date.now();
    const prev = lastMeetingPromptKeyRef.current;
    if (prev && prev.key === key && now - prev.at < 300_000) return false;
    lastMeetingPromptKeyRef.current = { key, at: now };
    return true;
  }, []);

  useAppEventBus({
    activeChat,
    chats,
    workProjects,
    hummingbirdOpen,
    contextPanelOpen,
    appDetectAlerts,
    executeAction,
    pushToast,
    setActive,
    setMeetingHud,
    setHummingbirdOpen,
    setContextPanelOpen,
    setHistoricalImport,
    setHistoricalImportProgress,
    setAppDetectAlerts,
    setMeetingPrompt,
    setMemoryHighUnreadCount,
    setProfileDisplayName,
    setProfileAvatarGlyph,
    setProfileAvatarImageDataUrl,
    setEditMode,
    acceptMeetingPrompt,
    shouldShowMeetingPrompt,
    executeActionRef,
    pushToastRef,
  });

  const [devGate, setDevGate] = useState({ available: false });
  const devGateMountedRef = useRef(false);
  const refreshDevGate = useCallback(async () => {
    try {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (invoke) {
        const out = await invoke('shogun_memory_debug_gate', { payload: {} });
        if (devGateMountedRef.current && out && typeof out === 'object') setDevGate(out as { available: boolean });
        return;
      }
      const r = await executeAction('settings.load', {}, { silentError: true });
      const sec = r.ok && r.data?.settings
        ? (r.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined
        : undefined;
      const developer = sec?.developer as Record<string, unknown> | undefined;
      if (devGateMountedRef.current) setDevGate({ available: !!developer?.memoryDebugger });
    } catch { /* ignore */ }
  }, [executeAction]);
  useEffect(() => {
    devGateMountedRef.current = true;
    void refreshDevGate();
    return () => {
      devGateMountedRef.current = false;
    };
  }, [refreshDevGate]);
  useEffect(() => {
    const onRefresh = () => { void refreshDevGate(); };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, [refreshDevGate]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let loaded = false;
      try {
        const r = await executeAction('settings.load', {}, { silentError: true });
        const sec = r?.ok && r.data?.settings
          ? (r.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined
          : null;
        const ws = sec?.chat_workspace && typeof sec.chat_workspace === 'object'
          ? sec.chat_workspace as Record<string, unknown>
          : null;
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
      } catch { /* ignore */ }
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
        } catch { /* ignore */ }
      }
      if (!cancelled) chatWorkspaceHydratedRef.current = true;
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chatWorkspaceHydratedRef.current) return;
    try {
      localStorage.setItem(CHAT_WORKSPACE_LS, JSON.stringify({ chats, workProjects }));
    } catch { /* ignore */ }
    void executeAction('settings.save', { section: 'chat_workspace', chats, workProjects }, { silentError: true });
  }, [chats, workProjects]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.shogunBriefTelemetrySink = (row: Record<string, unknown>) => {
      try {
        if (!row || row.name !== 'chat.completion.context') return;
        const payload = row && typeof row.payload === 'object' ? row.payload as Record<string, unknown> : {};
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
          const prevRaw = localStorage.getItem(CHAT_CONTEXT_TELEMETRY_LS);
          const prev = prevRaw ? JSON.parse(prevRaw) : [];
          const arr = Array.isArray(prev) ? prev : [];
          arr.push(compact);
          while (arr.length > 100) arr.shift();
          localStorage.setItem(CHAT_CONTEXT_TELEMETRY_LS, JSON.stringify(arr));
        } catch { /* ignore */ }
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
      } catch { /* never throw from telemetry sink */ }
    };
    return () => {
      try { delete window.shogunBriefTelemetrySink; } catch { /* ignore */ }
    };
  }, [executeAction]);

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

  const {
    openChatMenuAt,
    closeChatMenu,
    submitRenameModal,
    confirmDeleteChat,
    assignChatToWork,
    createAndAssignWork,
    runChatMenuAction,
  } = useChatActions(
    chats, setChats,
    activeChat, setActiveChat,
    setActive,
    workProjects, setWorkProjects,
    chatMenu, setChatMenu,
    chatRenameModal, setChatRenameModal,
    chatDeleteModal, setChatDeleteModal,
    chatWorkModal, setChatWorkModal,
    pushToast,
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
      if (!ipcRuntimeRef.current?.client?.hasTauriInvoke?.()) {
        if (!cancelled) setBioGate({ ready: true, open: false });
        return;
      }
      const settingsRes = await executeAction('settings.load', {}, { silentError: true });
      const sections = settingsRes.data?.settings
        ? (settingsRes.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined
        : undefined;
      const security = sections?.security as Record<string, unknown> | undefined;
      const wantLock = !!security?.biometricLockEnabled;
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
      if (!ipcRuntimeRef.current?.client?.hasTauriInvoke?.()) return;
      setBioGate((g) => (g.ready ? { ...g, open: true } : g));
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await executeAction('settings.load', {}, { silentError: true });
      if (cancelled || !r.ok || !r.data?.settings) return;
      const sec = (r.data.settings as Record<string, unknown>).sections as Record<string, unknown>;
      applySavedAppearance(sec);
      const p = profileStateFromSections(sec);
      setProfileDisplayName(p.name);
      setProfileAvatarGlyph(p.avatarGlyph);
      setProfileAvatarImageDataUrl(p.avatarImageDataUrl);
      if (ShogunKeyboardShortcuts) {
        shortcutBindingsRef.current = ShogunKeyboardShortcuts.mergeShortcutBindings(
          (sec.shortcuts as Record<string, unknown> | undefined)?.bindings,
        );
      }
      if (sec.brief && typeof sec.brief === 'object') {
        window.__SHOGUN_SETTINGS_BRIEF__ = sec.brief as Record<string, unknown>;
      } else {
        window.__SHOGUN_SETTINGS_BRIEF__ = {};
      }
    })();
    return () => { cancelled = true; };
  }, [executeAction, setProfileAvatarGlyph, setProfileAvatarImageDataUrl, setProfileDisplayName]);

  useEffect(() => {
    if (ShogunClerkAuth && typeof ShogunClerkAuth.init === 'function') {
      void ShogunClerkAuth.init();
    }
  }, []);

  useEffect(() => {
    if (bioGate.ready && bioGate.open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const Kbd = ShogunKeyboardShortcuts;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const editable = t?.isContentEditable;
      const inField =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || editable;

      const goBack = () => {
        const h = navHistRef.current;
        if (!h || h.cursor <= 0) return;
        skipNavHistRef.current = true;
        h.cursor -= 1;
        const prevScreen = h.entries[h.cursor];
        if (prevScreen) setActive(prevScreen);
      };
      const goForward = () => {
        const h = navHistRef.current;
        if (!h || h.cursor >= h.entries.length - 1) return;
        skipNavHistRef.current = true;
        h.cursor += 1;
        const nextScreen = h.entries[h.cursor];
        if (nextScreen) setActive(nextScreen);
      };

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

  const update = (k: string, v: unknown) => {
    const next = { ...tweaks, [k]: v };
    setTweaks(next);
    window.parent.postMessage({ type: '__edit_mode_set_keys', edits: { [k]: v } }, '*');
  };

  const sections = [
    { id: 'main', label: '', jp: '' },
    { id: 'workspace', label: '', jp: '' },
  ];
  const toggleChatGroup = (groupKey: string) => {
    setChatGroupsOpen((prev: Record<string, boolean>) => ({ ...prev, [groupKey]: !prev[groupKey] }));
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

  window.__SHOGUN_SHELL_ACTIVE_CHAT__ = activeChat;

  const dismissMeetingHud = async () => {
    const hud = meetingHud as Record<string, unknown> | null;
    if (hud?.backend && hud.backendMeetingId) {
      const r = await executeAction(
        'meetings.stop',
        { meeting_id: hud.backendMeetingId },
        { silentError: true },
      );
      setMeetingHud(null);
      try {
        window.dispatchEvent(new CustomEvent('shogun-meeting-recording-ended'));
        window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));
      } catch { /* ignore */ }
      if (r.ok) {
        pushToast(t('Meeting saved and ended', '会議を保存して終了しました'), 'success');
      } else {
        pushToast(String(r.error || t('Could not stop the meeting', '会議の停止に失敗しました')), 'error');
      }
      return;
    }
    const M = MeetingMediaRecording;
    if (!M || typeof M.stop !== 'function') {
      pushToast(t('The recording module is not loaded', '録音モジュールが読み込まれていません'), 'warn');
      setMeetingHud(null);
      return;
    }
    if (M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting()) {
      M.stop();
    } else {
      setMeetingHud(null);
    }
  };

  const effectiveNav = (() => {
    const base = devGate.available
      ? [...NAV, { id: 'memory_debug', label: 'Memory DBG', jp: 'DBG', icon: 'memory', section: 'workspace' }]
      : NAV;
    if (!memoryHighUnreadCount) return base;
    return base.map((n) => (n.id === 'memory' ? { ...n, count: memoryHighUnreadCount } : n));
  })();

  return (
    <ShogunRuntimeProvider value={runtimeValue}>
      <div
        className={'app' + (sidebarCollapsed ? ' sidebar-collapsed' : '')}
        data-screen-label={active}
        style={{
          gridTemplateColumns: sidebarCollapsed ? '0 minmax(0, 1fr)' : `${sidebarWidth}px minmax(0, 1fr)`,
          ...({ '--sidebar-w': sidebarCollapsed ? '0px' : `${sidebarWidth}px` } as React.CSSProperties),
        }}
      >
        <BioLockOverlay
          open={bioGate.ready && bioGate.open}
          onUnlock={async () => {
            const r = await executeAction(
              'auth.biometric.authenticate',
              { reason: 'Unlock SHOGUN' },
              { silentError: true },
            );
            if (r.ok && r.data?.ok) {
              setBioGate((g) => ({ ...g, open: false }));
            } else {
              pushToast(String(r.data?.message || t('Authentication failed', '認証に失敗しました')), 'error');
            }
          }}
        />
        <MeetingHud
          meetingHud={meetingHud}
          meetingHudTick={meetingHudTick}
          onDismiss={dismissMeetingHud}
        />
        <MeetingPromptBanner
          prompt={meetingPrompt}
          onTakeNotes={() => {
            if (meetingPrompt) acceptMeetingPrompt(meetingPrompt);
          }}
          onDismiss={() => setMeetingPrompt(null)}
        />
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
        <div
          className={
            'content' +
            (active === 'chat' ? ' content-chat' : '') +
            (active === 'meetings' ? ' content-meetings' : '')
          }
        >
          <Suspense fallback={<div style={{ padding: 40, color: 'var(--text-mute)' }}>Loading…</div>}>
            <Screen />
          </Suspense>
        </div>

        <MainAppPortals
          shareOpen={shareOpen}
          setShareOpen={setShareOpen}
          shareMode={shareMode}
          setShareMode={setShareMode}
          chats={chats}
          activeChat={activeChat}
          hummingbirdOpen={hummingbirdOpen}
          language={tweaks.language}
          hummingbirdInput={hummingbirdInput}
          setHummingbirdOpen={setHummingbirdOpen}
          setHummingbirdInput={setHummingbirdInput}
          userOpen={userOpen}
          userAnchor={userAnchor}
          profileDisplayName={profileDisplayName}
          profileAvatarGlyph={profileAvatarGlyph}
          profileAvatarImageDataUrl={profileAvatarImageDataUrl}
          setUserOpen={setUserOpen}
          setSettingsOpen={setSettingsOpen}
          contextPanelOpen={contextPanelOpen}
          contextPanelAnchor={contextPanelAnchor}
          setContextPanelOpen={setContextPanelOpen}
          chatMenu={chatMenu}
          chatMenuTarget={chatMenuTarget}
          chatMenuTargetWork={chatMenuTargetWork}
          closeChatMenu={closeChatMenu}
          runChatMenuAction={runChatMenuAction}
          chatDeleteModal={chatDeleteModal}
          chatDeleteTarget={chatDeleteTarget}
          setChatDeleteModal={setChatDeleteModal}
          confirmDeleteChat={confirmDeleteChat}
          chatRenameModal={chatRenameModal}
          setChatRenameModal={setChatRenameModal}
          submitRenameModal={submitRenameModal}
          chatWorkModal={chatWorkModal}
          filteredWorkProjects={filteredWorkProjects}
          setChatWorkModal={setChatWorkModal}
          assignChatToWork={assignChatToWork}
          createAndAssignWork={createAndAssignWork}
          settingsOpen={settingsOpen}
          setProfileDisplayName={setProfileDisplayName}
          setProfileAvatarGlyph={setProfileAvatarGlyph}
          setProfileAvatarImageDataUrl={setProfileAvatarImageDataUrl}
          writeConfirm={writeConfirm}
          writePending={writePending}
          setWriteConfirm={setWriteConfirm}
          setWritePending={setWritePending}
          requestWriteAction={requestWriteAction}
          historicalImport={historicalImport}
          historicalImportBusy={historicalImportBusy}
          historicalImportProgress={historicalImportProgress}
          setHistoricalImport={setHistoricalImport}
          setHistoricalImportBusy={setHistoricalImportBusy}
          setHistoricalImportProgress={setHistoricalImportProgress}
          pasteTokenModal={pasteTokenModal}
          setPasteTokenModal={setPasteTokenModal}
          toast={toast}
          setToast={setToast}
          toastTimerRef={toastTimerRef}
          editMode={editMode}
          tweaks={tweaks}
          onTweakUpdate={update}
        />
      </div>
    </ShogunRuntimeProvider>
  );
}
