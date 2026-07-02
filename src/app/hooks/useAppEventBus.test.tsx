import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppEventBus, type UseAppEventBusOptions } from './useAppEventBus';

const focusActionTraceMock = vi.fn();
const openQueueArtifactInActionsMock = vi.fn();
const buildDraftChatSeedMock = vi.fn((input) => ({ text: `draft:${input.ownerEntityId}`, body: input.draftContent }));
const openChatWithSeedMock = vi.fn();
const clearPendingMeetingDetectMock = vi.fn();
const normalizeVideoMeetingPayloadMock = vi.fn((input) => input);

vi.mock('@/shared/context/action-trace-focus', () => ({
  focusActionTrace: (...args: unknown[]) => focusActionTraceMock(...args),
}));

vi.mock('@/shared/context/open-queue-artifact', () => ({
  openQueueArtifactInActions: (...args: unknown[]) => openQueueArtifactInActionsMock(...args),
}));

vi.mock('@/shared/context/chat-composer-seed', () => ({
  buildDraftChatSeed: (...args: unknown[]) => buildDraftChatSeedMock((args as any[])[0]),
  openChatWithSeed: (...args: unknown[]) => openChatWithSeedMock((args as any[])[0]),
}));

vi.mock('@/shared/lib/meeting-detect-events', () => ({
  clearPendingMeetingDetect: (...args: unknown[]) => clearPendingMeetingDetectMock(...args),
  normalizeVideoMeetingPayload: (...args: unknown[]) => normalizeVideoMeetingPayloadMock((args as any[])[0]),
  stashPendingMeetingDetect: vi.fn(),
}));

function createOptions(
  overrides: Partial<UseAppEventBusOptions> = {},
): UseAppEventBusOptions {
  const executeAction = vi.fn(async () => ({ ok: true, data: {} }));
  const pushToast = vi.fn();

  return {
    activeScreen: 'home',
    activeChat: 'chat-1',
    chats: [],
    workProjects: [],
    hummingbirdOpen: false,
    contextPanelOpen: false,
    appDetectAlerts: false,
    executeAction,
    pushToast,
    setActive: vi.fn(),
    setSettingsOpen: vi.fn(),
    setMeetingHud: vi.fn(),
    setHummingbirdOpen: vi.fn(),
    setContextPanelOpen: vi.fn(),
    setHistoricalImport: vi.fn(),
    historicalImport: { provider: 'gmail', days: 30 },
    historicalImportBusy: true,
    setHistoricalImportBusy: vi.fn(),
    setHistoricalImportProgress: vi.fn(),
    setAppDetectAlerts: vi.fn(),
    setMeetingPrompt: vi.fn(),
    setMemoryHighUnreadCount: vi.fn(),
    setProfileDisplayName: vi.fn(),
    setProfileAvatarGlyph: vi.fn(),
    setProfileAvatarImageDataUrl: vi.fn(),
    setEditMode: vi.fn(),
    acceptMeetingPrompt: vi.fn(),
    shouldShowMeetingPrompt: vi.fn(() => false),
    executeActionRef: { current: executeAction },
    pushToastRef: { current: pushToast },
    ...overrides,
  };
}

describe('useAppEventBus historical import navigation', () => {
  beforeEach(() => {
    focusActionTraceMock.mockReset();
    openQueueArtifactInActionsMock.mockReset();
    buildDraftChatSeedMock.mockClear();
    openChatWithSeedMock.mockReset();
    clearPendingMeetingDetectMock.mockReset();
    normalizeVideoMeetingPayloadMock.mockClear();
  });

  it('shows an actionable queue toast for native action execution outside the Actions screen', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-action-layer-refresh', {
          detail: {
            reason: 'action-executed-act-1',
            payload: {
              sideEffect: 'queue_only',
              item: {
                id: 'act-1',
                title: 'Create onboarding task',
                ownerEntityId: 'company:aurora',
                sourceAiFieldId: 'af-1',
                executionResult: {
                  queued: {
                    id: 'sch-1',
                  },
                },
              },
            },
          },
        }),
      );
    });

    const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;

    expect(pushToastMock).toHaveBeenCalledTimes(1);
    expect(pushToastMock).toHaveBeenCalledWith(
      'Create onboarding task を実行し、queue に追加しました',
      'success',
      expect.objectContaining({
        durationMs: 7000,
        action: expect.objectContaining({
          label: 'Open Queue',
          onClick: expect.any(Function),
        }),
      }),
    );

    const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
      action?: { onClick?: () => void };
    };
    act(() => {
      toastOptions.action?.onClick?.();
    });
    expect(openQueueArtifactInActionsMock).toHaveBeenCalledWith({
      queueId: 'sch-1',
      sourceActionId: 'act-1',
      sourceAiFieldId: 'af-1',
      ownerEntityId: 'company:aurora',
    });
  });

  it('prefers explicit navigation payloads when opening queue results from native execution', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-action-layer-refresh', {
          detail: {
            reason: 'action-executed-act-nav-1',
            payload: {
              sideEffect: 'queue_only',
              item: {
                id: 'act-nav-1',
                title: 'Create diligence follow-up',
                ownerEntityId: 'company:aurora',
                sourceAiFieldId: 'af-legacy',
                executionResult: {},
              },
              navigation: {
                screen: 'actions',
                queueId: 'sch-nav-1',
                sourceActionId: 'act-nav-1',
                entityId: 'workspace:apollo',
                aiFieldId: 'af-nav-1',
              },
            },
          },
        }),
      );
    });

    const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
    const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
      action?: { onClick?: () => void };
    };
    act(() => {
      toastOptions.action?.onClick?.();
    });

    expect(openQueueArtifactInActionsMock).toHaveBeenCalledWith({
      queueId: 'sch-nav-1',
      sourceActionId: 'act-nav-1',
      sourceAiFieldId: 'af-nav-1',
      ownerEntityId: 'workspace:apollo',
    });
  });

  it('does not show native action-layer toasts while the Actions screen is already open', () => {
    const options = createOptions({ activeScreen: 'actions' });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-action-layer-refresh', {
          detail: {
            reason: 'action-executed-act-1',
            payload: {
              sideEffect: 'queue_only',
              item: {
                id: 'act-1',
                title: 'Create onboarding task',
                ownerEntityId: 'company:aurora',
                sourceAiFieldId: 'af-1',
                executionResult: {
                  queued: {
                    id: 'sch-1',
                  },
                },
              },
            },
          },
        }),
      );
    });

    expect(options.pushToast as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('shows an actionable draft toast for native draft execution outside the Actions screen', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-action-layer-refresh', {
          detail: {
            reason: 'action-executed-act-draft-1',
            payload: {
              sideEffect: 'draft_only',
              item: {
                id: 'act-draft-1',
                title: 'Draft security follow-up',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                detail: 'Include the security FAQ and next step.',
                executionResult: {
                  content: '# Draft\n\nSecurity follow-up body',
                },
              },
            },
          },
        }),
      );
    });

    const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
    expect(pushToastMock).toHaveBeenCalledWith(
      'Draft security follow-up の draft を生成しました',
      'success',
      expect.objectContaining({
        durationMs: 7000,
        action: expect.objectContaining({
          label: 'Open Draft',
          onClick: expect.any(Function),
        }),
      }),
    );

    const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
      action?: { onClick?: () => void };
    };
    act(() => {
      toastOptions.action?.onClick?.();
    });

    expect(buildDraftChatSeedMock).toHaveBeenCalledWith({
      ownerEntityId: 'company:aurora',
      title: 'Draft security follow-up',
      actionType: 'follow_up_email_draft',
      detail: 'Include the security FAQ and next step.',
      draftContent: '# Draft\n\nSecurity follow-up body',
    });
    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'draft:company:aurora',
      body: '# Draft\n\nSecurity follow-up body',
    });
  });

  it('prefers explicit navigation payloads when opening draft results from native execution', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-action-layer-refresh', {
          detail: {
            reason: 'action-executed-act-draft-nav-1',
            payload: {
              sideEffect: 'draft_only',
              item: {
                id: 'act-draft-nav-1',
                title: 'Draft diligence recap',
                ownerEntityId: 'company:aurora',
                actionType: 'follow_up_email_draft',
                detail: 'Reference the diligence packet.',
                executionResult: {
                  content: '# Draft\n\nLegacy draft body',
                },
              },
              navigation: {
                screen: 'chat',
                text: 'Review the normalized draft payload.',
                newChat: true,
                assembleMemory: true,
                memoryAssemblyQuery: 'workspace:apollo',
                memoryAssemblyLimit: 9,
                memoryAssemblySemantic: false,
              },
            },
          },
        }),
      );
    });

    const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
    const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
      action?: { onClick?: () => void };
    };
    act(() => {
      toastOptions.action?.onClick?.();
    });

    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'Review the normalized draft payload.',
      webSearch: false,
      assembleMemory: true,
      autoSend: false,
      newChat: true,
      memoryAssemblyQuery: 'workspace:apollo',
      memoryAssemblyLimit: 9,
      memoryAssemblySemantic: false,
    });
    expect(buildDraftChatSeedMock).not.toHaveBeenCalled();
  });

  it('routes app.navigate chat payloads into the seeded chat composer', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-app-navigate', {
          detail: {
            screen: 'chat',
            text: 'Review the founder update.',
            newChat: true,
            autoSend: false,
            assembleMemory: true,
            memoryAssemblyQuery: 'company:aurora',
            memoryAssemblyLimit: 10,
          },
        }),
      );
    });

    expect(openChatWithSeedMock).toHaveBeenCalledWith({
      text: 'Review the founder update.',
      webSearch: false,
      assembleMemory: true,
      autoSend: false,
      newChat: true,
      memoryAssemblyQuery: 'company:aurora',
      memoryAssemblyLimit: 10,
      memoryAssemblySemantic: true,
    });
    expect(options.setActive).not.toHaveBeenCalled();
  });

  it('routes matching done progress to Memory and clears the modal state', () => {
    const options = createOptions();
    const navigateSpy = vi.fn();
    const memoryIndexSpy = vi.fn();

    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);
    window.addEventListener('shogun-memory-index-changed', memoryIndexSpy as EventListener);

    try {
      renderHook(() => useAppEventBus(options));

      act(() => {
        window.dispatchEvent(
          new CustomEvent('shogun-historical-sync-progress', {
            detail: {
              provider: 'gmail',
              current: 10,
              total: 10,
              phase: 'done',
            },
          }),
        );
      });

      expect(options.setHistoricalImportBusy).toHaveBeenCalledWith(false);
      expect(options.setHistoricalImport).toHaveBeenCalledWith(null);
      expect(options.setHistoricalImportProgress).toHaveBeenCalledWith(null);
      expect(memoryIndexSpy).toHaveBeenCalledTimes(1);
      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const navigationEvent = navigateSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(navigationEvent.detail).toEqual({ screen: 'memory' });
    } finally {
      window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
      window.removeEventListener(
        'shogun-memory-index-changed',
        memoryIndexSpy as EventListener,
      );
    }
  });

  it('keeps normal progress updates for non-terminal events', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-historical-sync-progress', {
          detail: {
            provider: 'gmail',
            current: 3,
            total: 10,
            phase: 'pages',
          },
        }),
      );
    });

    expect(options.setHistoricalImportBusy).not.toHaveBeenCalled();
    expect(options.setHistoricalImport).not.toHaveBeenCalled();
    expect(options.setHistoricalImportProgress).toHaveBeenCalledWith({
      provider: 'gmail',
      current: 3,
      total: 10,
      phase: 'pages',
    });
  });

  it('shows an actionable sync-complete toast outside the Memory screen when no import modal is active', () => {
    const options = createOptions({
      historicalImport: null,
      historicalImportBusy: false,
    });
    const navigateSpy = vi.fn();

    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    try {
      renderHook(() => useAppEventBus(options));

      act(() => {
        window.dispatchEvent(
          new CustomEvent('shogun-historical-sync-progress', {
            detail: {
              provider: 'gmail',
              current: 10,
              total: 10,
              phase: 'done',
            },
          }),
        );
      });

      const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
      expect(pushToastMock).toHaveBeenCalledWith(
        'Gmail historical sync が完了しました',
        'success',
        expect.objectContaining({
          durationMs: 7000,
          action: expect.objectContaining({
            label: 'Open Memory',
            onClick: expect.any(Function),
          }),
        }),
      );
      expect(options.setHistoricalImportBusy).not.toHaveBeenCalled();
      expect(options.setHistoricalImport).not.toHaveBeenCalled();
      expect(options.setHistoricalImportProgress).toHaveBeenCalledWith({
        provider: 'gmail',
        current: 10,
        total: 10,
        phase: 'done',
      });

      const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
        action?: { onClick?: () => void };
      };
      act(() => {
        toastOptions.action?.onClick?.();
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const navigationEvent = navigateSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(navigationEvent.detail).toEqual({ screen: 'memory' });
    } finally {
      window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
    }
  });

  it('shows an actionable auto-stop toast outside the Meetings screen', () => {
    const options = createOptions();
    const navigateSpy = vi.fn();

    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    try {
      renderHook(() => useAppEventBus(options));

      act(() => {
        window.dispatchEvent(
          new CustomEvent('shogun-meeting-auto-stopped', {
            detail: {
              meeting_id: 'mtg-42',
              reason: 'video_ended',
              meeting: {
                title: 'Weekly Sync',
              },
            },
          }),
        );
      });

      const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
      expect(pushToastMock).toHaveBeenCalledWith(
        'Weekly Sync をビデオ通話の終了により保存しました',
        'info',
        expect.objectContaining({
          durationMs: 7000,
          action: expect.objectContaining({
            label: 'Open Meeting',
            onClick: expect.any(Function),
          }),
        }),
      );

      const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
        action?: { onClick?: () => void };
      };
      act(() => {
        toastOptions.action?.onClick?.();
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const navigationEvent = navigateSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(navigationEvent.detail).toEqual({ screen: 'meetings', meetingId: 'mtg-42' });
    } finally {
      window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
    }
  });

  it('does not show an auto-stop toast while the Meetings screen is already open', () => {
    const options = createOptions({ activeScreen: 'meetings' });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-meeting-auto-stopped', {
          detail: {
            meeting_id: 'mtg-42',
            reason: 'inactivity',
            meeting: {
              title: 'Weekly Sync',
            },
          },
        }),
      );
    });

    expect(options.pushToast as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('shows a meeting prompt without stashing pending state when app-detect alerts are enabled', () => {
    const setMeetingPrompt = vi.fn();
    const acceptMeetingPrompt = vi.fn();
    const shouldShowMeetingPrompt = vi.fn(() => true);
    const options = createOptions({
      appDetectAlerts: true,
      setMeetingPrompt,
      acceptMeetingPrompt,
      shouldShowMeetingPrompt,
    });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-video-meeting-started', {
          detail: {
            provider: 'google_meet',
            meeting_id: 'mtg-42',
            title: 'Weekly Sync',
          },
        }),
      );
    });

    expect(normalizeVideoMeetingPayloadMock).toHaveBeenCalledWith({
      provider: 'google_meet',
      meeting_id: 'mtg-42',
      title: 'Weekly Sync',
    });
    expect(clearPendingMeetingDetectMock).toHaveBeenCalledTimes(1);
    expect(setMeetingPrompt).toHaveBeenCalledWith({
      provider: 'google_meet',
      meeting_id: 'mtg-42',
      title: 'Weekly Sync',
    });
    expect(acceptMeetingPrompt).not.toHaveBeenCalled();
  });

  it('suppresses prompt handling when the detection event already represents an auto-started meeting', () => {
    const setMeetingPrompt = vi.fn();
    const acceptMeetingPrompt = vi.fn();
    const shouldShowMeetingPrompt = vi.fn(() => true);
    normalizeVideoMeetingPayloadMock.mockImplementationOnce((input) => ({
      ...input,
      auto_started: true,
    }));
    const options = createOptions({
      appDetectAlerts: true,
      setMeetingPrompt,
      acceptMeetingPrompt,
      shouldShowMeetingPrompt,
    });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-video-meeting-started', {
          detail: {
            provider: 'google_meet',
            meeting_id: 'mtg-auto-1',
            title: 'Google Meet · Google Chrome',
            auto_started: true,
          },
        }),
      );
    });

    expect(clearPendingMeetingDetectMock).toHaveBeenCalledTimes(1);
    expect(shouldShowMeetingPrompt).not.toHaveBeenCalled();
    expect(setMeetingPrompt).not.toHaveBeenCalled();
    expect(acceptMeetingPrompt).not.toHaveBeenCalled();
  });

  it('shows an actionable auto-start toast outside the Meetings screen', () => {
    const options = createOptions();
    const navigateSpy = vi.fn();

    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    try {
      renderHook(() => useAppEventBus(options));

      act(() => {
        window.dispatchEvent(
          new CustomEvent('shogun-video-meeting-auto-started', {
            detail: {
              meeting_id: 'mtg-auto-1',
              title: 'Google Meet · Google Chrome',
              system_started: false,
              screen_capture_granted: false,
            },
          }),
        );
      });

      const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
      expect(clearPendingMeetingDetectMock).toHaveBeenCalledTimes(1);
      expect(options.setMeetingPrompt).toHaveBeenCalledWith(null);
      expect(options.setMeetingHud).toHaveBeenCalledWith({
        active: true,
        hudPhase: 'begin',
        title: 'Google Meet · Google Chrome',
        startedAt: expect.any(Number),
        storageKey: null,
        backend: true,
        backendMeetingId: 'mtg-auto-1',
        micRunning: true,
        systemRunning: false,
        deepgramConfigured: true,
        systemMode: 'mic_only',
      });
      expect(pushToastMock).toHaveBeenCalledWith(
        'Google Meet · Google Chrome を検知し、会議セッションを開始しました（相手の声には画面収録の許可が必要です）',
        'success',
        expect.objectContaining({
          durationMs: 7000,
          action: expect.objectContaining({
            label: 'Open Meeting',
            onClick: expect.any(Function),
          }),
        }),
      );

      const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
        action?: { onClick?: () => void };
      };
      act(() => {
        toastOptions.action?.onClick?.();
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const navigationEvent = navigateSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(navigationEvent.detail).toEqual({ screen: 'meetings', meetingId: 'mtg-auto-1' });
    } finally {
      window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
    }
  });

  it('does not show an auto-start toast while the Meetings screen is already open', () => {
    const options = createOptions({ activeScreen: 'meetings' });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-video-meeting-auto-started', {
          detail: {
            meeting_id: 'mtg-auto-1',
            title: 'Google Meet · Google Chrome',
            system_started: true,
            screen_capture_granted: true,
          },
        }),
      );
    });

    expect(clearPendingMeetingDetectMock).toHaveBeenCalledTimes(1);
    expect(options.setMeetingPrompt).toHaveBeenCalledWith(null);
    expect(options.setMeetingHud).toHaveBeenCalledWith({
      active: true,
      hudPhase: 'begin',
      title: 'Google Meet · Google Chrome',
      startedAt: expect.any(Number),
      storageKey: null,
      backend: true,
      backendMeetingId: 'mtg-auto-1',
      micRunning: true,
      systemRunning: true,
      deepgramConfigured: true,
      systemMode: 'system_audio',
    });
    expect(options.pushToast as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('clears the meeting HUD when an auto-stopped event arrives', () => {
    const options = createOptions();

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-meeting-auto-stopped', {
          detail: {
            meeting_id: 'mtg-42',
            reason: 'inactivity',
            meeting: {
              title: 'Weekly Sync',
            },
          },
        }),
      );
    });

    expect(options.setMeetingHud).toHaveBeenCalledWith(null);
  });

  it('shows an actionable manual-stop toast outside the Meetings screen', () => {
    const options = createOptions();
    const navigateSpy = vi.fn();

    window.addEventListener('shogun-app-navigate', navigateSpy as EventListener);

    try {
      renderHook(() => useAppEventBus(options));

      act(() => {
        window.dispatchEvent(
          new CustomEvent('shogun-meeting-stopped', {
            detail: {
              meeting_id: 'mtg-stop-1',
              reason: 'manual_stop',
              meeting: {
                title: 'Weekly Sync',
              },
            },
          }),
        );
      });

      const pushToastMock = options.pushToast as unknown as ReturnType<typeof vi.fn>;
      expect(options.setMeetingHud).toHaveBeenCalledWith(null);
      expect(pushToastMock).toHaveBeenCalledWith(
        'Weekly Sync を保存して終了しました',
        'success',
        expect.objectContaining({
          durationMs: 7000,
          action: expect.objectContaining({
            label: 'Open Meeting',
            onClick: expect.any(Function),
          }),
        }),
      );

      const toastOptions = pushToastMock.mock.calls[0]?.[2] as {
        action?: { onClick?: () => void };
      };
      act(() => {
        toastOptions.action?.onClick?.();
      });

      expect(navigateSpy).toHaveBeenCalledTimes(1);
      const navigationEvent = navigateSpy.mock.calls[0]?.[0] as CustomEvent;
      expect(navigationEvent.detail).toEqual({ screen: 'meetings', meetingId: 'mtg-stop-1' });
    } finally {
      window.removeEventListener('shogun-app-navigate', navigateSpy as EventListener);
    }
  });

  it('does not show a manual-stop toast while the Meetings screen is already open', () => {
    const options = createOptions({ activeScreen: 'meetings' });

    renderHook(() => useAppEventBus(options));

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-meeting-stopped', {
          detail: {
            meeting_id: 'mtg-stop-1',
            reason: 'manual_stop',
            meeting: {
              title: 'Weekly Sync',
            },
          },
        }),
      );
    });

    expect(options.setMeetingHud).toHaveBeenCalledWith(null);
    expect(options.pushToast as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});
