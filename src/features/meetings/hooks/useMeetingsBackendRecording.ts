import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { MeetingMediaRecording } from '@/shared/lib/meeting-media-recording';
import { emitMeetingHud, clearMeetingHud } from '@/shared/lib/meeting-hud-events';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { useMeetingScreenCapturePermission } from './useMeetingScreenCapturePermission';
import { formatLiveTranscript, isNativeDesktop, toastM } from '../lib/runtime';

export interface UseMeetingsBackendRecordingDeps {
  granola: Record<string, unknown> | null;
  granolaRef: MutableRefObject<Record<string, unknown> | null>;
  setGranolaDraft: Dispatch<SetStateAction<{ body: string; transcript: string; summary: string; minutes: string }>>;
  setGranolaPane: Dispatch<SetStateAction<string>>;
  setPostRecSessionFlag: Dispatch<SetStateAction<boolean>>;
  setListTick: Dispatch<SetStateAction<number>>;
  linkClientNoteToStorage: (meetingId: unknown, storageKey: unknown) => Promise<unknown>;
}

export function useMeetingsBackendRecording(deps: UseMeetingsBackendRecordingDeps) {
  const {
    granola,
    granolaRef,
    setGranolaDraft,
    setGranolaPane,
    setPostRecSessionFlag,
    setListTick,
    linkClientNoteToStorage,
  } = deps;

  const [audioRecSession, setAudioRecSession] = useState<Record<string, unknown> | null>(null);
  const [backendRecActive, setBackendRecActive] = useState(false);
  const backendRecActiveRef = useRef(false);
  backendRecActiveRef.current = backendRecActive;
  const [contextTimelineItems, setContextTimelineItems] = useState<unknown[]>([]);
  const [contextTimelineLoading, setContextTimelineLoading] = useState(false);
  const backendRecStartedAtRef = useRef(0);
  const [systemAudioRunning, setSystemAudioRunning] = useState(false);
  const [permissionActionBusy, setPermissionActionBusy] = useState(false);
  const [, setRecTick] = useState(0);
  const pendingManualStopRef = useRef<string | null>(null);

  const permissionPollEnabled = !!(granola && granola.backendMeetingId && isNativeDesktop());
  const {
    screenCaptureGranted,
    refresh: refreshScreenCapturePermission,
    grantedChangedToTrue,
    isNativeDesktop: nativeDesktop,
  } = useMeetingScreenCapturePermission(permissionPollEnabled);

  const showPermissionBanner =
    permissionPollEnabled &&
    nativeDesktop &&
    ((screenCaptureGranted === false && (!backendRecActive || !systemAudioRunning)) ||
      (backendRecActive && !systemAudioRunning));

  const startBackendRecordingRef = useRef<(captureSystem: boolean) => Promise<boolean>>(async () => false);
  const startNoteRecordingRef = useRef<() => Promise<void>>(async () => {});

  const granolaBackendMeetingId = granola ? granola.backendMeetingId : null;

  useEffect(() => {
    function onEnded() {
      if (backendRecActiveRef.current && granolaRef.current?.backendMeetingId && isNativeDesktop()) {
        setBackendRecActive(false);
        backendRecStartedAtRef.current = 0;
        const mid = granolaRef.current.backendMeetingId;
        void runRuntimeAction('meetings.get', { meeting_id: mid }, { silentError: true }).then((getRes) => {
          const data = getRes?.data as { transcript?: unknown[] } | undefined;
          const segs = getRes?.ok && Array.isArray(data?.transcript) ? data!.transcript : [];
          if (segs.length) {
            setGranolaDraft((d) => ({ ...d, transcript: formatLiveTranscript(segs as Array<{ speaker?: string; text?: string }>) }));
          }
        });
      }
      if (granolaRef.current?.storageKey) {
        setPostRecSessionFlag(true);
        setListTick((x) => x + 1);
      }
    }
    window.addEventListener('shogun-meeting-recording-ended', onEnded);
    return () => window.removeEventListener('shogun-meeting-recording-ended', onEnded);
  }, [granolaRef, setGranolaDraft, setPostRecSessionFlag, setListTick]);

  useEffect(() => {
    function syncRec() {
      if (backendRecActiveRef.current) {
        setAudioRecSession({
          startedAt: Date.now(),
          storageKey: granolaRef.current?.storageKey,
          backend: true,
        });
        setRecTick((x) => x + 1);
        return;
      }
      const M = MeetingMediaRecording;
      if (M?.isBusyRecordingOrStarting?.()) {
        const sk = M.getActiveStorageKey?.();
        setAudioRecSession({ startedAt: M.getStartedAt(), storageKey: sk || null });
      } else {
        setAudioRecSession(null);
      }
      setRecTick((x) => x + 1);
    }
    window.addEventListener('shogun-meeting-hud', syncRec);
    window.addEventListener('shogun-meeting-recording-ended', syncRec);
    syncRec();
    return () => {
      window.removeEventListener('shogun-meeting-hud', syncRec);
      window.removeEventListener('shogun-meeting-recording-ended', syncRec);
    };
  }, [granolaRef]);

  useEffect(() => {
    if (!granolaBackendMeetingId || !isNativeDesktop()) return;
    let cancelled = false;
    runRuntimeAction('meetings.audio.status', {}, { silentError: true }).then((r) => {
      if (cancelled) return;
      const data = r?.data as { mic_capture_running?: boolean; system_audio_running?: boolean } | undefined;
      if (r?.ok && data?.mic_capture_running) {
        setBackendRecActive(true);
        setSystemAudioRunning(!!data.system_audio_running);
        setGranolaPane('minutes');
      }
    });
    return () => { cancelled = true; };
  }, [granolaBackendMeetingId, setGranolaPane]);

  useEffect(() => {
    if (!backendRecActive || !granolaBackendMeetingId || !isNativeDesktop()) {
      if (!backendRecActive) setSystemAudioRunning(false);
      return undefined;
    }
    let cancelled = false;
    const poll = () => {
      runRuntimeAction('meetings.audio.status', {}, { silentError: true }).then((r) => {
        if (cancelled || !r?.ok || !r.data) return;
        const data = r.data as { system_audio_running?: boolean };
        setSystemAudioRunning(!!data.system_audio_running);
      });
    };
    poll();
    const id = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [backendRecActive, granolaBackendMeetingId]);

  useEffect(() => {
    if (!backendRecActive || !granolaBackendMeetingId || !isNativeDesktop()) {
      if (backendRecStartedAtRef.current) {
        clearMeetingHud();
        backendRecStartedAtRef.current = 0;
      }
      return undefined;
    }
    if (!backendRecStartedAtRef.current) {
      backendRecStartedAtRef.current = Date.now();
    }
    let cancelled = false;
    function pushHud(phase: 'begin' | 'tick') {
      if (cancelled) return;
      runRuntimeAction('meetings.audio.status', {}, { silentError: true }).then((statusRes) => {
        if (cancelled) return;
        const g = granolaRef.current;
        const st = statusRes?.ok && statusRes.data ? statusRes.data as Record<string, unknown> : {};
        const sysOn = !!st.system_audio_running;
        setSystemAudioRunning(sysOn);
        emitMeetingHud({
          active: true,
          hudPhase: phase,
          title: (g?.title as string) || 'Untitled',
          startedAt: backendRecStartedAtRef.current,
          storageKey: (g?.storageKey as string) || null,
          backend: true,
          backendMeetingId: (g?.backendMeetingId as string) || null,
          micRunning: !!st.mic_capture_running,
          systemRunning: sysOn,
          deepgramConfigured: !!st.deepgram_configured,
          systemMode: (st.system_mode as string) || null,
        });
      });
    }
    pushHud('begin');
    const hudId = window.setInterval(() => pushHud('tick'), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(hudId);
    };
  }, [backendRecActive, granolaBackendMeetingId, granolaRef]);

  useEffect(() => {
    if (!granola?.backendMeetingId || !isNativeDesktop()) {
      setContextTimelineItems([]);
      setContextTimelineLoading(false);
      return undefined;
    }
    let cancelled = false;
    function refreshContextTimeline() {
      if (cancelled) return;
      setContextTimelineLoading(true);
      void runRuntimeAction('meetings.context_timeline', {
        meeting_id: granolaBackendMeetingId,
        include_live: backendRecActiveRef.current,
        limit: 120,
      }, { silentError: true }).then((res) => {
        if (cancelled) return;
        const data = res?.data as { items?: unknown[] } | undefined;
        const items = res?.ok && Array.isArray(data?.items) ? data!.items : [];
        setContextTimelineItems(items);
        setContextTimelineLoading(false);
      });
    }
    refreshContextTimeline();
    const id = window.setInterval(refreshContextTimeline, backendRecActiveRef.current ? 4000 : 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [granola, granolaBackendMeetingId, backendRecActive]);

  useEffect(() => {
    if (!grantedChangedToTrue) return;
    toastM('画面収録が許可されました。録音を開始できます', 'success');
    void refreshScreenCapturePermission();
  }, [grantedChangedToTrue, refreshScreenCapturePermission]);

  useEffect(() => {
    if (!granola?.backendMeetingId || !backendRecActive) return undefined;
    let cancelled = false;
    const poll = () => {
      runRuntimeAction('meetings.transcript.live', { meeting_id: granola.backendMeetingId }, { silentError: true })
        .then((r) => {
          if (cancelled) return;
          const data = r?.data as { segments?: unknown[] } | undefined;
          const segs = r?.ok && Array.isArray(data?.segments) ? data!.segments : [];
          if (!segs.length) return;
          const tx = formatLiveTranscript(segs as Array<{ speaker?: string; text?: string }>);
          if (!tx) return;
          setGranolaDraft((d) => ({ ...d, transcript: tx }));
        });
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [granola, granolaBackendMeetingId, backendRecActive, setGranolaDraft]);

  useEffect(() => {
    if (!backendRecActive) {
      if (!MeetingMediaRecording?.isRecording?.()) {
        setAudioRecSession(null);
      }
      return;
    }
    setAudioRecSession({
      startedAt: backendRecStartedAtRef.current || Date.now(),
      storageKey: granolaRef.current?.storageKey,
      backend: true,
    });
  }, [backendRecActive, granolaRef]);

  useEffect(() => {
    if (!audioRecSession) return undefined;
    const id = setInterval(() => setRecTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [audioRecSession]);

  const completeBackendRecording = useCallback(async (
    meetingId: unknown,
    opts?: { reason?: string; silent?: boolean },
  ) => {
    const mid = String(meetingId || '').trim();
    const g = granolaRef.current;
    if (!mid || !g || g.backendMeetingId !== mid || !isNativeDesktop()) return;
    setBackendRecActive(false);
    backendRecStartedAtRef.current = 0;
    clearMeetingHud();
    const getRes = await runRuntimeAction('meetings.get', { meeting_id: mid }, { silentError: true });
    const data = getRes?.data as { transcript?: unknown[] } | undefined;
    const segs = getRes?.ok && Array.isArray(data?.transcript) ? data!.transcript : [];
    if (segs.length) {
      setGranolaDraft((d) => ({
        ...d,
        transcript: formatLiveTranscript(segs as Array<{ speaker?: string; text?: string }>),
      }));
    }
    if (!opts?.silent) {
      const reason = String(opts?.reason || '').trim();
      if (reason === 'video_ended') {
        toastM('会議を自動終了しました（ビデオ通話終了）', 'info');
      } else if (reason === 'inactivity') {
        toastM('会議を自動終了しました（無活動）', 'info');
      } else {
        toastM('会議を保存して終了しました', 'success');
      }
    }
    try {
      window.dispatchEvent(new CustomEvent('shogun-meeting-recording-ended'));
    } catch {
      /* ignore */
    }
  }, [granolaRef, setGranolaDraft]);

  const finalizeBackendMeeting = useCallback(async (opts?: { silent?: boolean }) => {
    const g = granolaRef.current;
    if (!g?.backendMeetingId || !isNativeDesktop()) return null;
    const mid = g.backendMeetingId;
    pendingManualStopRef.current = String(mid);
    const res = await runRuntimeAction('meetings.stop', { meeting_id: mid }, { silentError: true });
    if (!res?.ok) {
      pendingManualStopRef.current = null;
      const err = res && typeof res === 'object' && 'error' in res ? (res as { error?: { message?: unknown } }).error : null;
      toastM(String(err?.message || '会議の終了に失敗しました'), 'error');
      return res;
    }
    await completeBackendRecording(mid, {
      reason: 'manual_stop',
      ...(opts?.silent !== undefined ? { silent: opts.silent } : {}),
    });
    pendingManualStopRef.current = null;
    return res;
  }, [granolaRef, completeBackendRecording]);

  useEffect(() => {
    const onMeetingStopped = (e: Event) => {
      const p = ((e as CustomEvent).detail) || {};
      const mid = String(p.meeting_id || '').trim();
      if (!mid) return;
      if (pendingManualStopRef.current && pendingManualStopRef.current === mid) {
        pendingManualStopRef.current = null;
        return;
      }
      void completeBackendRecording(mid, { reason: String(p.reason || 'manual_stop') });
    };
    window.addEventListener('shogun-meeting-stopped', onMeetingStopped);
    return () => window.removeEventListener('shogun-meeting-stopped', onMeetingStopped);
  }, [completeBackendRecording]);

  useEffect(() => {
    const onAutoStopped = (e: Event) => {
      const p = ((e as CustomEvent).detail) || {};
      const mid = String(p.meeting_id || '').trim();
      if (!mid) return;
      void completeBackendRecording(mid, { reason: String(p.reason || 'inactivity') });
    };
    window.addEventListener('shogun-meeting-auto-stopped', onAutoStopped);
    return () => window.removeEventListener('shogun-meeting-auto-stopped', onAutoStopped);
  }, [completeBackendRecording]);

  const startBackendRecording = useCallback(async (captureSystem: boolean) => {
    const g = granolaRef.current;
    if (!g?.backendMeetingId || !isNativeDesktop()) return false;
    if (backendRecActiveRef.current) return true;
    if (g.storageKey) {
      await linkClientNoteToStorage(g.backendMeetingId, g.storageKey);
    }
    const br = await runRuntimeAction('meetings.mic.start', {
      meeting_id: g.backendMeetingId,
      live_stt: true,
      capture_system: captureSystem,
    });
    if (br?.ok) {
      backendRecStartedAtRef.current = Date.now();
      setBackendRecActive(true);
      setGranolaPane('minutes');
      const statusRes = await runRuntimeAction('meetings.audio.status', {}, { silentError: true });
      const statusData = statusRes?.data as { system_audio_running?: boolean } | undefined;
      const sysOn = !!(statusRes?.ok && statusData?.system_audio_running);
      setSystemAudioRunning(sysOn);
      if (captureSystem && sysOn) {
        toastM('録音を開始しました（マイク + 相手の声）', 'success');
      } else if (captureSystem && !sysOn) {
        toastM('マイク録音を開始しました（相手の声は画面収録の許可が必要です）', 'info');
      } else {
        toastM('マイクのみで録音を開始しました', 'success');
      }
      return true;
    }
    const err = br && typeof br === 'object' && 'error' in br ? (br as { error?: unknown }).error : null;
    toastM(String(err || 'バックエンド録音の開始に失敗しました'), 'error');
    return false;
  }, [granolaRef, linkClientNoteToStorage, setGranolaPane]);

  const startNoteRecording = useCallback(async () => {
    if (!granola?.storageKey) return;
    if (granola.backendMeetingId && isNativeDesktop()) {
      if (backendRecActive) return;
      if (screenCaptureGranted === false) {
        toastM('相手の声を録音するには画面収録の許可が必要です', 'warn');
        return;
      }
      if (screenCaptureGranted !== true) {
        const granted = await refreshScreenCapturePermission();
        if (!granted) {
          toastM('相手の声を録音するには画面収録の許可が必要です', 'warn');
          return;
        }
      }
      await startBackendRecording(true);
      return;
    }
    const M = MeetingMediaRecording;
    if (M?.isBusyRecordingOrStarting?.()) return;
    if (!M?.start) {
      toastM('録音モジュールが読み込まれていません', 'error');
      return;
    }
    const r = await M.start({
      storageKey: granola.storageKey as string,
      title: granola.title as string,
      onToast: toastM,
    });
    if (r?.ok) {
      setGranolaPane('minutes');
    }
  }, [granola, backendRecActive, screenCaptureGranted, startBackendRecording, refreshScreenCapturePermission, setGranolaPane]);

  startBackendRecordingRef.current = startBackendRecording;
  startNoteRecordingRef.current = startNoteRecording;

  const startMicOnlyRecording = useCallback(async () => {
    if (!granola?.backendMeetingId || !isNativeDesktop()) return;
    if (backendRecActive) return;
    await startBackendRecording(false);
  }, [granola, backendRecActive, startBackendRecording]);

  const openMeetingScreenCaptureSettings = useCallback(async () => {
    setPermissionActionBusy(true);
    try {
      await runRuntimeAction(
        'permissions.manage',
        { target: 'screen_capture', source: 'meetings.permission_banner' },
        { silentError: true },
      );
    } finally {
      setPermissionActionBusy(false);
    }
  }, []);

  const requestMeetingScreenCaptureAccess = useCallback(async () => {
    setPermissionActionBusy(true);
    try {
      await runRuntimeAction(
        'permissions.manage',
        { target: 'screen_capture_request', source: 'meetings.permission_banner' },
        { silentError: true },
      );
      await refreshScreenCapturePermission();
    } finally {
      setPermissionActionBusy(false);
    }
  }, [refreshScreenCapturePermission]);

  const stopNoteRecording = useCallback(async () => {
    if (granola?.backendMeetingId && isNativeDesktop() && backendRecActive) {
      await finalizeBackendMeeting();
      return;
    }
    const M = MeetingMediaRecording;
    if (M?.stop) {
      M.stop();
    } else {
      toastM('録音モジュールが読み込まれていません', 'error');
    }
  }, [granola, backendRecActive, finalizeBackendMeeting]);

  return {
    audioRecSession,
    backendRecActive,
    backendRecActiveRef,
    systemAudioRunning,
    contextTimelineItems,
    contextTimelineLoading,
    permissionActionBusy,
    screenCaptureGranted,
    showPermissionBanner,
    refreshScreenCapturePermission,
    finalizeBackendMeeting,
    startBackendRecording,
    startNoteRecording,
    stopNoteRecording,
    startMicOnlyRecording,
    openMeetingScreenCaptureSettings,
    requestMeetingScreenCaptureAccess,
    startBackendRecordingRef,
    startNoteRecordingRef,
    setBackendRecActive,
    setSystemAudioRunning,
  };
}
