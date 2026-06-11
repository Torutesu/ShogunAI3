import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { ShogunIpcClient, ShogunAPI, ShogunActionRegistry } from '@/shared/ipc';
import { ShogunKeyboardShortcuts } from '@/shared/lib/keyboard-shortcuts';

declare const window: Window & {
  SHOGUN_RUNTIME?: ShogunRuntimeValue;
};

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface PushToastOptions {
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

export interface ExecuteActionOptions {
  silentError?: boolean;
  successMessage?: string;
}

export interface ActionResult {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface ShogunRuntimeValue {
  executeAction: (
    actionKey: string,
    payload?: unknown,
    options?: ExecuteActionOptions,
  ) => Promise<ActionResult>;
  requestWriteAction: (
    actionKey: string,
    payload: unknown,
    title: string,
    description: string,
  ) => void;
  pushToast: (message: string, kind?: ToastKind, options?: PushToastOptions) => void;
  getActiveChat: () => Record<string, unknown> | null;
  getChats: () => Record<string, unknown>[];
  getWorkProjects: () => Record<string, unknown>[];
  createWorkProject: (name: string) => string | null;
  renameWorkProject: (projectId: string, nextName: string) => boolean;
  deleteWorkProject: (projectId: string) => boolean;
  archiveWorkProject: (projectId: string, archivedOn?: boolean) => boolean;
  moveWorkProject: (projectId: string, direction: number) => boolean;
  __activeChatId: string;
  openSettingsPane: (paneId: string) => void;
  setActiveScreen: (id: string) => void;
  createNewChat: () => void;
  openWorkPickerForNewChat: () => void;
  openHistoricalImport: (provider: string, defaultDays?: number) => boolean;
  openPasteToken: (provider: string) => boolean;
  applyShortcutBindings: (raw: unknown) => void;
}

export interface BuildShogunRuntimeDeps {
  activeChat: string;
  chats: Record<string, unknown>[];
  workProjects: Record<string, unknown>[];
  setChats: React.Dispatch<React.SetStateAction<Record<string, unknown>[]>>;
  setWorkProjects: React.Dispatch<React.SetStateAction<Record<string, unknown>[]>>;
  setSettingsOpen: React.Dispatch<React.SetStateAction<string | null>>;
  setActive: React.Dispatch<React.SetStateAction<string>>;
  setChatWorkModal: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  setHistoricalImport: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>;
  setPasteTokenModal: React.Dispatch<React.SetStateAction<Record<string, unknown> | null>>;
  setWriteConfirm: React.Dispatch<React.SetStateAction<Record<string, unknown>>>;
  pushToast: (message: string, kind?: ToastKind, options?: PushToastOptions) => void;
  createNewChat: () => void;
  shortcutBindingsRef: MutableRefObject<Record<string, unknown>>;
  ipcRuntimeRef: MutableRefObject<{ client: { hasTauriInvoke?: () => boolean } } | null>;
}

export interface BuildShogunRuntimeResult {
  executeAction: ShogunRuntimeValue['executeAction'];
  requestWriteAction: ShogunRuntimeValue['requestWriteAction'];
  runtimeValue: ShogunRuntimeValue;
}

const ShogunRuntimeContext = createContext<ShogunRuntimeValue | null>(null);

export function useShogunRuntime(): ShogunRuntimeValue {
  const ctx = useContext(ShogunRuntimeContext);
  if (!ctx) {
    throw new Error('useShogunRuntime must be used within ShogunRuntimeProvider');
  }
  return ctx;
}

export function useBuildShogunRuntime(deps: BuildShogunRuntimeDeps): BuildShogunRuntimeResult {
  const {
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
  } = deps;

  const runtimeRef = useRef<{ client: { hasTauriInvoke?: () => boolean }; api: unknown; registry: { run: (key: string, payload: unknown) => Promise<ActionResult> } } | null>(null);
  const pushToastRef = useRef(pushToast);
  pushToastRef.current = pushToast;

  if (!runtimeRef.current && ShogunIpcClient && ShogunAPI && ShogunActionRegistry) {
    const client = ShogunIpcClient.createIpcClient();
    const api = ShogunAPI.createApi(client);
    const registry = ShogunActionRegistry.createActionRegistry(api, {
      onMissing: (key: string) => pushToastRef.current(`Action not connected: ${key}`, 'warn'),
      onExecute: () => {},
    });
    runtimeRef.current = { client, api, registry };
  }

  ipcRuntimeRef.current = runtimeRef.current;

  const executeAction = useCallback(async (
    actionKey: string,
    payload: unknown = {},
    options: ExecuteActionOptions = {},
  ): Promise<ActionResult> => {
    if (!runtimeRef.current) {
      pushToastRef.current('IPC runtime unavailable', 'error');
      return { ok: false };
    }
    let res: ActionResult;
    try {
      res = await runtimeRef.current.registry.run(actionKey, payload);
    } catch (err: unknown) {
      const msg = err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'Action failed unexpectedly';
      if (!options.silentError) pushToastRef.current(msg, 'error');
      return { ok: false, error: { code: 'RUNTIME_EXCEPTION', message: msg } };
    }
    if (res.ok && res.data?.notImplemented) {
      pushToastRef.current(String(res.data.message || 'Not available in this version'), 'warn');
      return res;
    }
    if (res.ok && res.data?.honestPreferenceOnly) {
      pushToastRef.current(String(res.data.message || 'Preference saved locally only.'), 'info');
      return res;
    }
    if (res.ok) {
      if (options.successMessage) pushToastRef.current(options.successMessage, 'success');
    } else if (!options.silentError) {
      pushToastRef.current(res.error?.message || 'Action failed', 'error');
    }
    return res;
  }, []);

  const requestWriteAction = useCallback((
    actionKey: string,
    payload: unknown,
    title: string,
    description: string,
  ) => {
    setWriteConfirm({ open: true, actionKey, payload, title, description });
  }, [setWriteConfirm]);

  const runtimeValue = useMemo((): ShogunRuntimeValue => ({
    executeAction,
    requestWriteAction,
    pushToast,
    getActiveChat: () => chats.find((c) => c.id === activeChat) || null,
    getChats: () => chats.slice(),
    getWorkProjects: () => workProjects.slice(),
    createWorkProject: (name: string) => {
      const n = String(name || '').trim();
      if (!n) return null;
      const id = `w-${Date.now()}`;
      setWorkProjects((prev) => [...prev, { id, name: n }]);
      pushToast(`Workspaceを作成: ${n}`, 'success');
      return id;
    },
    renameWorkProject: (projectId: string, nextName: string) => {
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
    deleteWorkProject: (projectId: string) => {
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
    archiveWorkProject: (projectId: string, archivedOn?: boolean) => {
      const id = String(projectId || '').trim();
      if (!id) return false;
      const on = archivedOn !== false;
      setWorkProjects((prev) => prev.map((p) => (
        p.id === id ? { ...p, archived: on } : p
      )));
      pushToast(on ? 'Workプロジェクトをアーカイブしました' : 'Workプロジェクトを復元しました', 'success');
      return true;
    },
    moveWorkProject: (projectId: string, direction: number) => {
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
        if (!item) return prev;
        out.splice(idx, 1);
        out.splice(to, 0, item);
        moved = true;
        return out;
      });
      if (moved) pushToast('Workプロジェクトの順序を更新しました', 'success');
      return moved;
    },
    __activeChatId: activeChat,
    openSettingsPane: (paneId: string) => setSettingsOpen(paneId || 'general'),
    setActiveScreen: (id: string) => {
      if (id && typeof id === 'string') setActive(id);
    },
    createNewChat,
    openWorkPickerForNewChat: () => {
      setChatWorkModal({ open: true, chatId: null, query: '' });
    },
    openHistoricalImport: (provider: string, defaultDays?: number) => {
      const p = String(provider || '').trim();
      const allowed = new Set(['gmail', 'google_calendar', 'google_drive', 'slack', 'notion', 'github', 'linear', 'zoom']);
      if (!allowed.has(p)) return false;
      const d = Number.isFinite(Number(defaultDays)) ? Number(defaultDays) : 30;
      setHistoricalImport({ provider: p, days: d });
      return true;
    },
    openPasteToken: (provider: string) => {
      const p = String(provider || '').trim();
      const allowed = new Set(['slack', 'notion', 'github', 'linear', 'zoom']);
      if (!allowed.has(p)) return false;
      setPasteTokenModal({ provider: p, token: '', busy: false });
      return true;
    },
    applyShortcutBindings: (raw: unknown) => {
      if (ShogunKeyboardShortcuts) {
        shortcutBindingsRef.current = ShogunKeyboardShortcuts.mergeShortcutBindings(raw);
      }
    },
  }), [
    activeChat,
    chats,
    workProjects,
    createNewChat,
    executeAction,
    pushToast,
    requestWriteAction,
    setActive,
    setChatWorkModal,
    setChats,
    setHistoricalImport,
    setPasteTokenModal,
    setSettingsOpen,
    setWorkProjects,
    shortcutBindingsRef,
  ]);

  return { executeAction, requestWriteAction, runtimeValue };
}

export interface ShogunRuntimeProviderProps {
  value: ShogunRuntimeValue;
  children: ReactNode;
}

/** Syncs typed runtime to React context and legacy window.SHOGUN_RUNTIME. */
export function ShogunRuntimeProvider({ value, children }: ShogunRuntimeProviderProps): React.ReactElement {
  useEffect(() => {
    window.SHOGUN_RUNTIME = value;
    return () => {
      delete window.SHOGUN_RUNTIME;
    };
  }, [value]);

  return (
    <ShogunRuntimeContext.Provider value={value}>
      {children}
    </ShogunRuntimeContext.Provider>
  );
}
