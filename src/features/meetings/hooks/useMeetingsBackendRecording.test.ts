import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMeetingsBackendRecording } from './useMeetingsBackendRecording';

const runRuntimeActionMock = vi.fn();
const toastMMock = vi.fn();
const clearMeetingHudMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./useMeetingScreenCapturePermission', () => ({
  useMeetingScreenCapturePermission: () => ({
    screenCaptureGranted: true,
    refresh: vi.fn(async () => true),
    grantedChangedToTrue: false,
    isNativeDesktop: true,
  }),
}));

vi.mock('../lib/runtime', () => ({
  formatLiveTranscript: (segments: Array<{ speaker?: string; text?: string }>) =>
    segments.map((segment) => `${segment.speaker || 'Unknown'}: ${segment.text || ''}`.trim()).join('\n'),
  isNativeDesktop: () => true,
  toastM: (...args: unknown[]) => toastMMock(...args),
}));

vi.mock('@/shared/lib/meeting-hud-events', () => ({
  emitMeetingHud: vi.fn(),
  clearMeetingHud: (...args: unknown[]) => clearMeetingHudMock(...args),
}));

vi.mock('@/shared/lib/meeting-media-recording', () => ({
  MeetingMediaRecording: {
    isBusyRecordingOrStarting: () => false,
    isRecording: () => false,
    getActiveStorageKey: () => null,
    getStartedAt: () => 0,
  },
}));

function createDeps() {
  const granola = {
    backendMeetingId: 'mtg-1',
    storageKey: 'storage-1',
    title: 'Aurora Sync',
  };
  return {
    granola,
    granolaRef: { current: granola },
    setGranolaDraft: vi.fn(),
    setGranolaPane: vi.fn(),
    setPostRecSessionFlag: vi.fn(),
    setListTick: vi.fn(),
    linkClientNoteToStorage: vi.fn(async () => null),
  };
}

describe('useMeetingsBackendRecording native stop handling', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    toastMMock.mockReset();
    clearMeetingHudMock.mockReset();
    runRuntimeActionMock.mockImplementation((actionKey: string) => {
      if (actionKey === 'meetings.audio.status') {
        return Promise.resolve({
          ok: true,
          data: { mic_capture_running: true, system_audio_running: true },
        });
      }
      if (actionKey === 'meetings.stop') {
        window.dispatchEvent(
          new CustomEvent('shogun-meeting-stopped', {
            detail: { meeting_id: 'mtg-1', reason: 'manual_stop' },
          }),
        );
        return Promise.resolve({ ok: true, data: { meeting: { id: 'mtg-1' } } });
      }
      if (actionKey === 'meetings.get') {
        return Promise.resolve({
          ok: true,
          data: {
            transcript: [{ speaker: 'A', text: 'Wrapped up next steps' }],
          },
        });
      }
      if (actionKey === 'meetings.context_timeline') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'meetings.transcript.live') {
        return Promise.resolve({ ok: true, data: { segments: [] } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('finalizeBackendMeeting handles the native manual-stop event without duplicate completion', async () => {
    const deps = createDeps();
    const endedSpy = vi.fn();
    window.addEventListener('shogun-meeting-recording-ended', endedSpy as EventListener);

    const { result, unmount } = renderHook(() => useMeetingsBackendRecording(deps));

    await waitFor(() => {
      expect(result.current.backendRecActive).toBe(true);
    });

    await act(async () => {
      await result.current.finalizeBackendMeeting();
    });

    await waitFor(() => {
      expect(deps.setGranolaDraft).toHaveBeenCalledWith(expect.any(Function));
    });

    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.stop',
      { meeting_id: 'mtg-1' },
      { silentError: true },
    );
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.get',
      { meeting_id: 'mtg-1' },
      { silentError: true },
    );
    expect(toastMMock).toHaveBeenCalledTimes(1);
    expect(toastMMock).toHaveBeenCalledWith('会議を保存して終了しました', 'success');
    expect(endedSpy).toHaveBeenCalledTimes(1);
    expect(clearMeetingHudMock).toHaveBeenCalled();
    expect(result.current.backendRecActive).toBe(false);

    window.removeEventListener('shogun-meeting-recording-ended', endedSpy as EventListener);
    unmount();
  });

  it('reconciles backend state when a manual-stop event arrives from outside the screen action', async () => {
    const deps = createDeps();
    const endedSpy = vi.fn();
    window.addEventListener('shogun-meeting-recording-ended', endedSpy as EventListener);

    const { result, unmount } = renderHook(() => useMeetingsBackendRecording(deps));

    await waitFor(() => {
      expect(result.current.backendRecActive).toBe(true);
    });

    act(() => {
      window.dispatchEvent(
        new CustomEvent('shogun-meeting-stopped', {
          detail: { meeting_id: 'mtg-1', reason: 'manual_stop' },
        }),
      );
    });

    await waitFor(() => {
      expect(deps.setGranolaDraft).toHaveBeenCalledWith(expect.any(Function));
    });

    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.get',
      { meeting_id: 'mtg-1' },
      { silentError: true },
    );
    expect(toastMMock).toHaveBeenCalledWith('会議を保存して終了しました', 'success');
    expect(endedSpy).toHaveBeenCalledTimes(1);
    expect(result.current.backendRecActive).toBe(false);

    window.removeEventListener('shogun-meeting-recording-ended', endedSpy as EventListener);
    unmount();
  });
});
