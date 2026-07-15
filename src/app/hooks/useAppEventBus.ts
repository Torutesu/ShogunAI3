import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { applySavedAppearance, isProfilePhotoDataUrl } from '@/app/lib/helpers';
import {
  applyNativeNavigation,
  historicalImportProgressNavigation,
} from '@/app/lib/native-navigation';
import { focusActionTrace } from '@/shared/context/action-trace-focus';
import { buildDraftChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { openQueueArtifactInActions } from '@/shared/context/open-queue-artifact';
import {
  clearPendingMeetingDetect,
  normalizeVideoMeetingPayload,
  type MeetingDetectDetail,
} from '@/shared/lib/meeting-detect-events';
import type { ActionResult, ExecuteActionOptions, PushToastOptions, ToastKind } from '@/app/context/ShogunRuntimeContext';

declare const window: Window & {
  SHOGUN_RUNTIME?: {
    executeAction: (key: string, payload?: unknown, options?: ExecuteActionOptions) => Promise<ActionResult>;
    setActiveScreen?: (screenId: string) => void;
  };
};

type ExecuteActionFn = (
  actionKey: string,
  payload?: unknown,
  options?: ExecuteActionOptions,
) => Promise<ActionResult>;

type PushToastFn = (message: string, kind?: ToastKind, options?: PushToastOptions) => void;

function syncProviderLabel(provider: unknown): string {
  switch (String(provider || '').trim()) {
    case 'gmail':
      return 'Gmail';
    case 'google_calendar':
      return 'Google Calendar';
    case 'google_drive':
      return 'Google Drive';
    case 'slack':
      return 'Slack';
    case 'notion':
      return 'Notion';
    case 'github':
      return 'GitHub';
    case 'linear':
      return 'Linear';
    case 'zoom':
      return 'Zoom';
    case 'figma':
      return 'Figma';
    case 'outlook':
      return 'Outlook';
    default:
      return 'Connector';
  }
}

export interface UseAppEventBusOptions {
  activeScreen: string;
  activeChat: string;
  chats: Record<string, unknown>[];
  workProjects: Record<string, unknown>[];
  hummingbirdOpen: boolean;
  contextPanelOpen: boolean;
  appDetectAlerts: boolean;
  executeAction: ExecuteActionFn;
  pushToast: PushToastFn;
  setActive: Dispatch<SetStateAction<string>>;
  setSettingsOpen: Dispatch<SetStateAction<string | null>>;
  setMeetingHud: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setHummingbirdOpen: Dispatch<SetStateAction<boolean>>;
  setContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setHistoricalImport: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  historicalImport: Record<string, unknown> | null;
  historicalImportBusy: boolean;
  setHistoricalImportBusy: Dispatch<SetStateAction<boolean>>;
  setHistoricalImportProgress: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  setAppDetectAlerts: Dispatch<SetStateAction<boolean>>;
  setMeetingPrompt: Dispatch<SetStateAction<MeetingDetectDetail | null>>;
  setMemoryHighUnreadCount: Dispatch<SetStateAction<number>>;
  setProfileDisplayName: Dispatch<SetStateAction<string>>;
  setProfileAvatarGlyph: Dispatch<SetStateAction<string>>;
  setProfileAvatarImageDataUrl: Dispatch<SetStateAction<string>>;
  setEditMode: Dispatch<SetStateAction<boolean>>;
  acceptMeetingPrompt: (detail: MeetingDetectDetail) => void;
  shouldShowMeetingPrompt: (detail: MeetingDetectDetail) => boolean;
  executeActionRef: MutableRefObject<ExecuteActionFn>;
  pushToastRef: MutableRefObject<PushToastFn>;
}

export function useAppEventBus(options: UseAppEventBusOptions): void {
  const {
    activeScreen,
    activeChat,
    chats,
    workProjects,
    hummingbirdOpen,
    contextPanelOpen,
    appDetectAlerts,
    executeAction,
    setActive,
    setSettingsOpen,
    setMeetingHud,
    setHummingbirdOpen,
    setContextPanelOpen,
    setHistoricalImport,
    historicalImport,
    historicalImportBusy,
    setHistoricalImportBusy,
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
  } = options;

  executeActionRef.current = executeAction;
  pushToastRef.current = options.pushToast;
  const historicalImportRef = useRef(historicalImport);
  historicalImportRef.current = historicalImport;
  const historicalImportBusyRef = useRef(historicalImportBusy);
  historicalImportBusyRef.current = historicalImportBusy;

  useEffect(() => {
    const onNavigate = (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      applyNativeNavigation(detail, {
        setActiveScreen: setActive,
        openSettingsPane: (paneId) => setSettingsOpen(paneId || 'general'),
      });
    };
    window.addEventListener('shogun-app-navigate', onNavigate);
    return () => window.removeEventListener('shogun-app-navigate', onNavigate);
  }, [setActive, setSettingsOpen]);

  useEffect(() => {
    const onHud = (e: Event) => {
      const d = ((e as CustomEvent).detail) || {};
      if (!d.active) {
        setMeetingHud(null);
        return;
      }
      setMeetingHud((prev) => {
        const p = prev || {};
        return {
          title: d.title || p.title || 'Untitled',
          startedAt: d.startedAt || p.startedAt || Date.now(),
          storageKey: d.storageKey != null ? d.storageKey : p.storageKey ?? null,
          backend: d.backend != null ? !!d.backend : !!p.backend,
          backendMeetingId:
            d.backendMeetingId != null ? d.backendMeetingId : p.backendMeetingId ?? null,
          micRunning: d.micRunning != null ? !!d.micRunning : p.micRunning,
          systemRunning: d.systemRunning != null ? !!d.systemRunning : p.systemRunning,
          deepgramConfigured:
            d.deepgramConfigured != null ? !!d.deepgramConfigured : p.deepgramConfigured,
          systemMode: d.systemMode != null ? d.systemMode : p.systemMode ?? null,
        };
      });
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
        } catch {
          /* ignore */
        }
      }, 0);
    };
    window.addEventListener('shogun-meeting-hud', onHud);
    return () => window.removeEventListener('shogun-meeting-hud', onHud);
  }, [setActive, setMeetingHud]);

  useEffect(() => {
    try {
      window.dispatchEvent(
        new CustomEvent('shogun-active-chat-changed', { detail: { id: activeChat } }),
      );
    } catch {
      /* ignore */
    }
  }, [activeChat]);

  useEffect(() => {
    if (!hummingbirdOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHummingbirdOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hummingbirdOpen, setHummingbirdOpen]);

  useEffect(() => {
    if (!contextPanelOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextPanelOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [contextPanelOpen, setContextPanelOpen]);

  useEffect(() => {
    const onImported = (ev: Event) => {
      const p = ((ev as CustomEvent).detail) || {};
      if (p.saved) {
        try {
          window.dispatchEvent(new CustomEvent('shogun-credentials-updated', { detail: p }));
        } catch {
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
    };
    window.addEventListener('shogun-credentials-imported', onImported);
    return () => window.removeEventListener('shogun-credentials-imported', onImported);
  }, [pushToastRef]);

  useEffect(() => {
    const HISTORICAL_PROVIDERS = new Set(['gmail', 'google_calendar', 'google_drive', 'slack', 'notion', 'github', 'linear', 'zoom']);
    const onCred = async (ev: Event) => {
      const detail = ((ev as CustomEvent).detail) || {};
      const provider = String(detail.provider || '').trim();
      if (!provider || !HISTORICAL_PROVIDERS.has(provider)) return;
      try {
        const res = await executeActionRef.current('settings.load', {}, { silentError: true });
        const sections = res?.ok && res.data?.settings && (res.data.settings as Record<string, unknown>).sections;
        const prev = sections && (sections as Record<string, unknown>)[provider];
        if (prev && typeof prev === 'object' && (prev as Record<string, unknown>).historicalSyncDays != null) return;
      } catch {
        /* ignore — show the modal anyway */
      }
      setHistoricalImport({ provider, days: 30 });
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [executeActionRef, setHistoricalImport]);

  useEffect(() => {
    const onProgress = (ev: Event) => {
      const p = ((ev as CustomEvent).detail) || {};
      const nextProgress = {
        provider: p.provider || null,
        current: Number(p.current) || 0,
        total: p.total == null ? null : Number(p.total),
        phase: p.phase || '',
      };
      const activeImport = historicalImportRef.current;
      const activeProvider = activeImport && typeof activeImport === 'object'
        ? String((activeImport as Record<string, unknown>).provider || '')
        : '';
      const navigation = historicalImportProgressNavigation(nextProgress, activeProvider);
      if (navigation && historicalImportBusyRef.current) {
        setHistoricalImportBusy(false);
        setHistoricalImport(null);
        setHistoricalImportProgress(null);
        try {
          window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));
          window.dispatchEvent(new CustomEvent('shogun-app-navigate', { detail: navigation }));
        } catch {
          /* ignore */
        }
        return;
      }
      if (
        nextProgress.phase === 'done'
        && !historicalImportBusyRef.current
        && activeScreen !== 'memory'
      ) {
        const label = syncProviderLabel(nextProgress.provider);
        pushToastRef.current(
          `${label} historical sync が完了しました`,
          'success',
          {
            durationMs: 7000,
            action: {
              label: 'Open Memory',
              onClick: () => {
                try {
                  window.dispatchEvent(
                    new CustomEvent('shogun-app-navigate', {
                      detail: { screen: 'memory' },
                    }),
                  );
                } catch {
                  /* ignore */
                }
              },
            },
          },
        );
      }
      setHistoricalImportProgress(nextProgress);
    };
    window.addEventListener('shogun-historical-sync-progress', onProgress);
    return () => window.removeEventListener('shogun-historical-sync-progress', onProgress);
  }, [activeScreen, setHistoricalImport, setHistoricalImportBusy, setHistoricalImportProgress]);

  useEffect(() => {
    const onMeetingAutoStopped = (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      const meetingId = String(detail.meeting_id || '').trim();
      if (!meetingId) return;
      setMeetingHud(null);
      if (activeScreen === 'meetings') return;

      const reason = String(detail.reason || '').trim();
      const meeting = (detail.meeting && typeof detail.meeting === 'object')
        ? detail.meeting as Record<string, unknown>
        : null;
      const title = String(meeting?.title || '').trim() || 'Meeting';
      const reasonLabel = reason === 'video_ended'
        ? 'ビデオ通話の終了により保存しました'
        : reason === 'inactivity'
          ? '無活動のため保存しました'
          : '自動停止後に保存しました';

      pushToastRef.current(
        `${title} を${reasonLabel}`,
        'info',
        {
          durationMs: 7000,
          action: {
            label: 'Open Meeting',
            onClick: () => {
              try {
                window.dispatchEvent(
                  new CustomEvent('shogun-app-navigate', {
                    detail: { screen: 'meetings', meetingId },
                  }),
                );
              } catch {
                /* ignore */
              }
            },
          },
        },
      );
    };

    window.addEventListener('shogun-meeting-auto-stopped', onMeetingAutoStopped);
    return () => window.removeEventListener('shogun-meeting-auto-stopped', onMeetingAutoStopped);
  }, [activeScreen]);

  useEffect(() => {
    const onMeetingStopped = (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      const meetingId = String(detail.meeting_id || '').trim();
      if (!meetingId) return;
      setMeetingHud(null);
      if (activeScreen === 'meetings') return;

      const meeting = (detail.meeting && typeof detail.meeting === 'object')
        ? detail.meeting as Record<string, unknown>
        : null;
      const title = String(meeting?.title || '').trim() || 'Meeting';

      pushToastRef.current(
        `${title} を保存して終了しました`,
        'success',
        {
          durationMs: 7000,
          action: {
            label: 'Open Meeting',
            onClick: () => {
              try {
                window.dispatchEvent(
                  new CustomEvent('shogun-app-navigate', {
                    detail: { screen: 'meetings', meetingId },
                  }),
                );
              } catch {
                /* ignore */
              }
            },
          },
        },
      );
    };

    window.addEventListener('shogun-meeting-stopped', onMeetingStopped);
    return () => window.removeEventListener('shogun-meeting-stopped', onMeetingStopped);
  }, [activeScreen]);

  useEffect(() => {
    const AUDIT_LS_KEY = 'shogun.integration.audit.v1';
    const onAudit = (ev: Event) => {
      const p = ((ev as CustomEvent).detail) || {};
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
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('shogun-integration-security-audit', onAudit);
    return () => window.removeEventListener('shogun-integration-security-audit', onAudit);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await executeActionRef.current('settings.load', {}, { silentError: true });
        if (cancelled || !r.ok || !r.data?.settings) return;
        const sections = (r.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined;
        const mtg = sections?.meetings as Record<string, unknown> | undefined;
        if (typeof mtg?.appDetectAlerts === 'boolean') setAppDetectAlerts(mtg.appDetectAlerts);
      } catch {
        /* ignore */
      }
    })();
    const onRefresh = () => {
      (async () => {
        try {
          const r = await executeActionRef.current('settings.load', {}, { silentError: true });
          if (!r.ok || !r.data?.settings) return;
          const sections = (r.data.settings as Record<string, unknown>).sections as Record<string, unknown> | undefined;
          const mtg = sections?.meetings as Record<string, unknown> | undefined;
          if (typeof mtg?.appDetectAlerts === 'boolean') setAppDetectAlerts(mtg.appDetectAlerts);
        } catch {
          /* ignore */
        }
      })();
    };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => {
      cancelled = true;
      window.removeEventListener('shogun-settings-refresh', onRefresh);
    };
  }, [executeActionRef, setAppDetectAlerts]);

  const acceptRef = useRef(acceptMeetingPrompt);
  acceptRef.current = acceptMeetingPrompt;
  const shouldShowRef = useRef(shouldShowMeetingPrompt);
  shouldShowRef.current = shouldShowMeetingPrompt;
  const appDetectAlertsRef = useRef(appDetectAlerts);
  appDetectAlertsRef.current = appDetectAlerts;

  useEffect(() => {
    const onVideo = (ev: Event) => {
      const detail = normalizeVideoMeetingPayload(((ev as CustomEvent).detail) || {});
      if (detail.auto_started) {
        clearPendingMeetingDetect();
        return;
      }
      if (!shouldShowRef.current(detail)) return;
      if (appDetectAlertsRef.current) {
        clearPendingMeetingDetect();
        setMeetingPrompt(detail);
        return;
      }
      acceptRef.current(detail);
    };
    window.addEventListener('shogun-video-meeting-started', onVideo);
    return () => window.removeEventListener('shogun-video-meeting-started', onVideo);
  }, [setMeetingPrompt]);

  useEffect(() => {
    const onVideoAutoStarted = (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      const meetingId = String(detail.meeting_id || '').trim();
      if (!meetingId) return;

      clearPendingMeetingDetect();
      setMeetingPrompt(null);
      const title = String(detail.title || '').trim() || 'Live Meeting';
      const startedAt = Number(detail.started_at) || Date.now();
      const micStarted = detail.mic_started !== false;
      const systemStarted = detail.system_started === true;
      const screenCaptureGranted = detail.screen_capture_granted === true;
      setMeetingHud({
        active: true,
        hudPhase: 'begin',
        title,
        startedAt,
        storageKey: null,
        backend: true,
        backendMeetingId: meetingId,
        micRunning: micStarted,
        systemRunning: systemStarted,
        deepgramConfigured: true,
        systemMode: systemStarted ? 'system_audio' : 'mic_only',
      });
      if (activeScreen === 'meetings') return;
      const suffix = systemStarted
        ? '録音も開始しています'
        : screenCaptureGranted
          ? '会議セッションを開始しました'
          : '会議セッションを開始しました（相手の声には画面収録の許可が必要です）';

      pushToastRef.current(
        `${title} を検知し、${suffix}`,
        'success',
        {
          durationMs: 7000,
          action: {
            label: 'Open Meeting',
            onClick: () => {
              try {
                window.dispatchEvent(
                  new CustomEvent('shogun-app-navigate', {
                    detail: { screen: 'meetings', meetingId },
                  }),
                );
              } catch {
                /* ignore */
              }
            },
          },
        },
      );
    };

    window.addEventListener('shogun-video-meeting-auto-started', onVideoAutoStarted);
    return () => window.removeEventListener('shogun-video-meeting-auto-started', onVideoAutoStarted);
  }, [activeScreen]);

  useEffect(() => {
    const onRefresh = () => {
      (async () => {
        try {
          const r = await executeActionRef.current('settings.load', {}, { silentError: true });
          if (r.ok && r.data?.settings) {
            const sections = (r.data.settings as Record<string, unknown>).sections;
            if (sections) applySavedAppearance(sections as Record<string, unknown>);
          }
        } catch {
          /* ignore */
        }
      })();
    };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, [executeActionRef]);

  useEffect(() => {
    const onAxNotTrusted = (ev: Event) => {
      const p = ((ev as CustomEvent).detail) || {};
      const message =
        (typeof p.message === 'string' && p.message) ||
        'Accessibility permission is required for AX-rich capture. Open System Settings → Privacy & Security → Accessibility to allow SHOGUN.';
      const runtime = window.SHOGUN_RUNTIME;
      const canOpen = !!(runtime && typeof runtime.executeAction === 'function');
      pushToastRef.current(message, 'warn', canOpen ? {
        action: {
          label: 'Open Accessibility',
          onClick: () => {
            runtime!.executeAction(
              'permissions.manage',
              { target: 'accessibility', source: 'capture.ax_not_trusted_toast' },
              { silentError: true },
            );
          },
        },
      } : {});
    };
    window.addEventListener('shogun-capture-ax-not-trusted', onAxNotTrusted);
    return () => window.removeEventListener('shogun-capture-ax-not-trusted', onAxNotTrusted);
  }, [pushToastRef]);

  useEffect(() => {
    const onActionLayerRefresh = (ev: Event) => {
      const detail = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
      const reason = String(detail.reason || '').trim();
      const payload = (detail.payload && typeof detail.payload === 'object')
        ? detail.payload as Record<string, unknown>
        : null;
      if (!reason || activeScreen === 'actions') return;

      const openActionTrace = () => {
        const item = (payload?.item && typeof payload.item === 'object')
          ? payload.item as Record<string, unknown>
          : null;
        const actionId = String(item?.id || '').trim();
        if (!actionId) return;
        focusActionTrace({
          actionId,
          aiFieldId: String(item?.sourceAiFieldId || payload?.sourceAiFieldId || '').trim() || null,
          openAudit: false,
        });
        window.SHOGUN_RUNTIME?.setActiveScreen?.('actions');
      };

      const openQueueFocus = () => {
        const item = (payload?.item && typeof payload.item === 'object')
          ? payload.item as Record<string, unknown>
          : null;
        const navigation = (payload?.navigation && typeof payload.navigation === 'object')
          ? payload.navigation as Record<string, unknown>
          : null;
        const executionResult = (item?.executionResult && typeof item.executionResult === 'object')
          ? item.executionResult as Record<string, unknown>
          : null;
        const queued = (executionResult?.queued && typeof executionResult.queued === 'object')
          ? executionResult.queued as Record<string, unknown>
          : null;
        const queueId = String(
          navigation?.queueId
          || queued?.id
          || payload?.id
          || payload?.queueId
          || '',
        ).trim();
        if (!queueId) {
          openActionTrace();
          return;
        }
        openQueueArtifactInActions({
          queueId,
          sourceActionId: String(
            navigation?.sourceActionId
            || navigation?.actionId
            || item?.id
            || payload?.sourceActionId
            || (payload?.echo && typeof payload.echo === 'object'
              ? (payload.echo as Record<string, unknown>).source_action_id
              : '')
            || '',
          ).trim() || null,
          sourceAiFieldId: String(
            navigation?.aiFieldId
            || item?.sourceAiFieldId
            || payload?.sourceAiFieldId
            || (payload?.echo && typeof payload.echo === 'object'
              ? (payload.echo as Record<string, unknown>).source_ai_field_id
              : '')
            || '',
          ).trim() || null,
          ownerEntityId: String(
            navigation?.entityId
            || item?.ownerEntityId
            || payload?.ownerEntityId
            || (payload?.echo && typeof payload.echo === 'object'
              ? (payload.echo as Record<string, unknown>).owner_entity_id
              : '')
            || '',
          ).trim() || null,
        });
      };

      const openDraftResult = () => {
        const item = (payload?.item && typeof payload.item === 'object')
          ? payload.item as Record<string, unknown>
          : null;
        const navigation = (payload?.navigation && typeof payload.navigation === 'object')
          ? payload.navigation as Record<string, unknown>
          : null;
        const executionResult = (item?.executionResult && typeof item.executionResult === 'object')
          ? item.executionResult as Record<string, unknown>
          : null;
        const navigationText = String(navigation?.text || '').trim();
        if (navigationText) {
          const memoryAssemblyQuery = String(navigation?.memoryAssemblyQuery || '').trim();
          openChatWithSeed({
            text: navigationText,
            webSearch: navigation?.webSearch === true,
            assembleMemory: navigation?.assembleMemory !== false,
            autoSend: navigation?.autoSend === true,
            newChat: navigation?.newChat === true,
            ...(Number.isFinite(Number(navigation?.memoryAssemblyLimit))
              ? { memoryAssemblyLimit: Number(navigation?.memoryAssemblyLimit) }
              : {}),
            ...(memoryAssemblyQuery ? { memoryAssemblyQuery } : {}),
            memoryAssemblySemantic: navigation?.memoryAssemblySemantic !== false,
          });
          return;
        }
        const draftContent = String(
          executionResult?.content
          || payload?.content
          || '',
        ).trim();
        if (!draftContent) {
          openActionTrace();
          return;
        }
        openChatWithSeed(buildDraftChatSeed({
          ownerEntityId: String(item?.ownerEntityId || '').trim(),
          title: String(item?.title || 'Draft').trim() || 'Draft',
          actionType: String(item?.actionType || 'follow_up_email_draft').trim() || 'follow_up_email_draft',
          detail: String(item?.detail || '').trim(),
          draftContent,
        }));
      };

      if (reason.startsWith('action-executed-')) {
        const sideEffect = String(payload?.sideEffect || '').trim();
        const item = (payload?.item && typeof payload.item === 'object')
          ? payload.item as Record<string, unknown>
          : null;
        const title = String(item?.title || 'Action').trim() || 'Action';
        if (sideEffect === 'queue_only' || sideEffect === 'crm_queue_only') {
          pushToastRef.current(`${title} を実行し、queue に追加しました`, 'success', {
            durationMs: 7000,
            action: {
              label: 'Open Queue',
              onClick: openQueueFocus,
            },
          });
          return;
        }
        if (sideEffect === 'draft_only') {
          pushToastRef.current(`${title} の draft を生成しました`, 'success', {
            durationMs: 7000,
            action: {
              label: 'Open Draft',
              onClick: openDraftResult,
            },
          });
          return;
        }
        pushToastRef.current(`${title} を実行しました`, 'success', {
          durationMs: 7000,
          action: {
            label: 'Open Action',
            onClick: openActionTrace,
          },
        });
        return;
      }

      if (reason === 'queue.tasks.append' || reason === 'queue.crm_updates.append') {
        const echo = (payload?.echo && typeof payload.echo === 'object')
          ? payload.echo as Record<string, unknown>
          : null;
        if (String(echo?.source || '').trim() === 'approved_context_action') return;
        const title = String(echo?.title || 'Queue item').trim() || 'Queue item';
        pushToastRef.current(`${title} を local queue に追加しました`, 'success', {
          durationMs: 7000,
          action: {
            label: 'Open Queue',
            onClick: openQueueFocus,
          },
        });
      }
    };
    window.addEventListener('shogun-action-layer-refresh', onActionLayerRefresh);
    return () => window.removeEventListener('shogun-action-layer-refresh', onActionLayerRefresh);
  }, [activeScreen, pushToastRef]);

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('shogun-chats-changed', { detail: { chats } }));
    } catch {
      /* ignore */
    }
  }, [chats]);

  useEffect(() => {
    try {
      window.dispatchEvent(new CustomEvent('shogun-work-projects-changed', { detail: { workProjects } }));
    } catch {
      /* ignore */
    }
  }, [workProjects]);

  useEffect(() => {
    const onProfile = (e: Event) => {
      const d = (e as CustomEvent).detail;
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
    const onAppearance = (e: Event) => {
      const a = (e as CustomEvent).detail?.appearance;
      if (!a || typeof a !== 'object') return;
      applySavedAppearance({ appearance: a });
    };
    window.addEventListener('shogun-appearance-changed', onAppearance);
    return () => window.removeEventListener('shogun-appearance-changed', onAppearance);
  }, []);

  useEffect(() => {
    const onHighCount = (e: Event) => {
      const n = Number((e as CustomEvent).detail?.count);
      setMemoryHighUnreadCount(Number.isFinite(n) && n > 0 ? n : 0);
    };
    window.addEventListener('shogun-memory-high-count', onHighCount);
    return () => window.removeEventListener('shogun-memory-high-count', onHighCount);
  }, [setMemoryHighUnreadCount]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === '__activate_edit_mode') setEditMode(true);
      if (e.data?.type === '__deactivate_edit_mode') setEditMode(false);
    };
    window.addEventListener('message', handler);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', handler);
  }, [setEditMode]);
}
