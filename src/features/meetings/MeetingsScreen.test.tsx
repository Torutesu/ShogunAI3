import type React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingsScreen } from './MeetingsScreen';
import {
  clearPendingMeetingDetailId,
  stashPendingMeetingDetailId,
} from '@/shared/context/native-detail-events';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/lib/meeting-media-recording', () => ({
  MeetingMediaRecording: {
    isRecording: () => false,
    setActiveTitle: vi.fn(),
    getActiveStorageKey: vi.fn(),
  },
}));

vi.mock('@/shared/lib/meeting-detect-events', () => ({
  takePendingMeetingDetect: () => null,
}));

vi.mock('./components/MtgProgressDots', () => ({
  MtgProgressDots: () => null,
}));

vi.mock('./components/GranolaOverlay', () => ({
  GranolaOverlay: () => null,
}));

vi.mock('./components/MtgChatDock', () => ({
  MtgChatDock: () => null,
}));

vi.mock('./components/MeetingDetailModal', () => ({
  MeetingDetailModal: ({
    meetingDetail,
  }: {
    meetingDetail: { meeting?: { title?: string; id?: string } } | null;
  }) =>
    meetingDetail ? (
      <div role="dialog">
        Meeting Detail: {meetingDetail.meeting?.title || meetingDetail.meeting?.id || 'unknown'}
      </div>
    ) : null,
}));

vi.mock('./hooks/useMeetingsCalendar', () => ({
  useMeetingsCalendar: () => [],
}));

vi.mock('./hooks/useGranolaPillUi', () => ({
  useGranolaPillUi: () => ({
    granolaPillOpen: false,
    setGranolaPillOpen: vi.fn(),
  }),
}));

vi.mock('./hooks/useMeetingsScreenPrefs', () => ({
  useMeetingsScreenPrefs: () => ({
    allowServerMemoryAssembly: true,
    autoStartOnCalendar: false,
    autoStartOnCalendarRef: { current: false },
  }),
}));

vi.mock('./hooks/useMeetingsShareControls', () => ({
  useMeetingsShareControls: () => ({
    mtgTopShareOpen: false,
    setMtgTopShareOpen: vi.fn(),
    mtgLinkAccess: 'workspace',
    setMtgLinkAccess: vi.fn(),
    mtgShareSearch: '',
    setMtgShareSearch: vi.fn(),
    mtgShareOwner: null,
    mtgLinkBusy: false,
    mtgLinkAccessMenuOpen: false,
    setMtgLinkAccessMenuOpen: vi.fn(),
    copyMtgShareLink: vi.fn(),
  }),
}));

vi.mock('./hooks/useMeetingsBackendRecording', () => ({
  useMeetingsBackendRecording: () => ({
    audioRecSession: null,
    backendRecActive: false,
    systemAudioRunning: false,
    contextTimelineItems: [],
    contextTimelineLoading: false,
    permissionActionBusy: false,
    screenCaptureGranted: true,
    showPermissionBanner: false,
    finalizeBackendMeeting: vi.fn(),
    startNoteRecording: vi.fn(),
    stopNoteRecording: vi.fn(),
    startMicOnlyRecording: vi.fn(),
    openMeetingScreenCaptureSettings: vi.fn(),
    requestMeetingScreenCaptureAccess: vi.fn(),
    startBackendRecordingRef: { current: vi.fn() },
    startNoteRecordingRef: { current: vi.fn() },
    setBackendRecActive: vi.fn(),
    setSystemAudioRunning: vi.fn(),
  }),
}));

vi.mock('./hooks/useGranolaNoteActions', () => ({
  useGranolaNoteActions: () => ({
    applyStubTranscript: vi.fn(),
    refreshSummary: vi.fn(),
    refreshMinutes: vi.fn(),
    runMtgEnhance: vi.fn(),
    ingestNoteToMemory: vi.fn(),
    injectRecipeIntoMemo: vi.fn(),
    runPostRecSlashItem: vi.fn(),
    moveGranolaToTrash: vi.fn(),
    mtgDraftEmail: vi.fn(),
    mtgCopyAllText: vi.fn(),
    runLocalAsk: vi.fn(),
    runAskChat: vi.fn(),
    listLocalTodos: vi.fn(),
  }),
}));

vi.mock('./context/GranolaOverlayContext', () => ({
  GranolaOverlayProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./lib/runtime', () => ({
  mnl: () => ({
    loadUserMeetingLog: () => ({ items: [] }),
    loadNote: () => null,
    saveNote: vi.fn(),
  }),
  toastM: vi.fn(),
  briefPayloadWithUserTz: vi.fn(),
  RECIPE_LOCAL_BODIES: {},
  MEETINGS_DOCK_SLASH_CATALOG: [],
  noteHasCompletedRecording: () => false,
  isNativeDesktop: () => true,
}));

describe('MeetingsScreen', () => {
  beforeEach(() => {
    clearPendingMeetingDetailId();
    runRuntimeActionMock.mockReset();
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: { meeting_id?: string }) => {
      if (actionKey === 'stats.get') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'meetings.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'meetings.get') {
        return Promise.resolve({
          ok: true,
          data: {
            meeting: {
              id: payload?.meeting_id || 'mtg-1',
              title: 'Aurora Sync',
              started_at: 0,
              ended_at: 0,
            },
            transcript: [
              { id: 'seg-1', speaker: 'A', text: 'Kickoff transcript line' },
            ],
          },
        });
      }
      if (actionKey === 'memory.search') {
        return Promise.resolve({ ok: true, data: { hits: [], total: 0 } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });
  });

  it('opens the meeting detail modal from the native detail event', async () => {
    render(<MeetingsScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-meeting-detail', {
        detail: { meetingId: 'mtg-42' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Aurora Sync');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.get',
      { meeting_id: 'mtg-42' },
      { silentError: true },
    );
  });

  it('opens the meeting detail modal from pending native navigation after mount', async () => {
    stashPendingMeetingDetailId('mtg-pending-7');

    render(<MeetingsScreen />);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Aurora Sync');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.get',
      { meeting_id: 'mtg-pending-7' },
      { silentError: true },
    );
  });

  it('reloads an open meeting detail when meetings change', async () => {
    let meetingVersion = 1;
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: { meeting_id?: string }) => {
      if (actionKey === 'stats.get') {
        return Promise.resolve({ ok: true, data: {} });
      }
      if (actionKey === 'meetings.list') {
        return Promise.resolve({ ok: true, data: { items: [] } });
      }
      if (actionKey === 'meetings.get') {
        return Promise.resolve({
          ok: true,
          data: {
            meeting: {
              id: payload?.meeting_id || 'mtg-1',
              title: meetingVersion === 1 ? 'Aurora Sync' : 'Aurora Sync Updated',
              started_at: 0,
              ended_at: 0,
            },
            transcript: [
              { id: 'seg-1', speaker: 'A', text: meetingVersion === 1 ? 'Kickoff transcript line' : 'Updated transcript line' },
            ],
          },
        });
      }
      if (actionKey === 'memory.search') {
        return Promise.resolve({ ok: true, data: { hits: [], total: 0 } });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<MeetingsScreen />);

    window.dispatchEvent(
      new CustomEvent('shogun-open-meeting-detail', {
        detail: { meetingId: 'mtg-42' },
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Aurora Sync');
    });

    meetingVersion = 2;
    window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveTextContent('Aurora Sync Updated');
    });
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'meetings.get',
      { meeting_id: 'mtg-42' },
      { silentError: true },
    );
  });
});
