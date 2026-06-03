import React from 'react';

import { MeetingMediaRecording } from '@/shared/lib/meeting-media-recording';
import { emitMeetingHud, clearMeetingHud } from '@/shared/lib/meeting-hud-events';
import { Icon, Kamon } from '@/shared/icons';
import { MtgProgressDots } from './components/MtgProgressDots';
import { GranolaOverlay } from './components/GranolaOverlay';
import { MtgChatDock } from './components/MtgChatDock';
import { MeetingDetailModal } from './components/MeetingDetailModal';
import { useMeetingScreenCapturePermission } from './hooks/useMeetingScreenCapturePermission';
import { runRuntimeActionM } from '@/shared/ipc/runtime-actions';
import {
  mnl,
  toastM,
  briefPayloadWithUserTz,
  RECIPE_LOCAL_BODIES,
  MEETINGS_COMING_UP_STORAGE,
  MEETINGS_DOCK_SLASH_CATALOG,
  RECIPE_LABEL_TO_ID,
  noteHasCompletedRecording,
} from './lib/runtime';

function formatLiveTranscript(segments: any[]) {
  return segments
    .map(function (s: any) {
      var sp = s.speaker === 'self' ? 'You' : s.speaker === 'other' ? 'Other' : (s.speaker || 'Speaker');
      return sp + ': ' + (s.text || '');
    })
    .filter(function (line: string) { return line.trim().length > 3; })
    .join('\n');
}

function isNativeDesktop() {
  return !!(typeof window !== 'undefined' && (window as any).__TAURI__);
}

// ===========================================================================
// MEETINGS — synthesis layer for calendar events + conversations
// ===========================================================================
export function MeetingsScreen() {
  const { useState, useEffect, useCallback, useRef, useMemo } = React;
  const [granola, setGranola] = useState<any>(null);
  const [granolaPane, setGranolaPane] = useState('memo');
  const [granolaDraft, setGranolaDraft] = useState({ body:'', transcript:'', summary:'', minutes:'' });
  const [granolaMenuOpen, setGranolaMenuOpen] = useState(false);
  const [cmdBarMin, setCmdBarMin] = useState(false);
  const [granolaOutline, setGranolaOutline] = useState(false);
  const [granolaAsk, setGranolaAsk] = useState('');
  const [granolaTodos, setGranolaTodos] = useState<any>(null);
  const [granolaEnhanceMenuOpen, setGranolaEnhanceMenuOpen] = useState(false);
  const granolaRef = useRef<any>(null);
  const granolaDraftRef = useRef(granolaDraft);
  granolaDraftRef.current = granolaDraft;

  const [userMeetingItems, setUserMeetingItems] = useState<any[]>([]);
  const [importedMeetings, setImportedMeetings] = useState<any[]>([]);
  // { meeting, segments, loading, filter } when the detail modal is open.
  const [meetingDetail, setMeetingDetail] = useState<any>(null);
  const [listTick, setListTick] = useState(0);
  const [audioRecSession, setAudioRecSession] = useState<any>(null);
  const [backendRecActive, setBackendRecActive] = useState(false);
  const backendRecActiveRef = useRef(false);
  backendRecActiveRef.current = backendRecActive;
  const backendRecStartedAtRef = useRef(0);
  const [systemAudioRunning, setSystemAudioRunning] = useState(false);
  const [permissionActionBusy, setPermissionActionBusy] = useState(false);
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
  const [_recTick, setRecTick] = useState(0);
  const [comingUp, setComingUp] = useState<any[]>([]);
  const [meetingsPrompt, setMeetingsPrompt] = useState('');
  const [meetingsRecipeBrowse, setMeetingsRecipeBrowse] = useState(false);
  const [postRecSessionFlag, setPostRecSessionFlag] = useState(false);
  const [postRecWaveMenuOpen, setPostRecWaveMenuOpen] = useState(false);
  const [mtgTopShareOpen, setMtgTopShareOpen] = useState(false);
  const [mtgEnhanceBusy, setMtgEnhanceBusy] = useState(false);
  const [mtgLinkAccess, setMtgLinkAccess] = useState('anyone');
  const [mtgShareSearch, setMtgShareSearch] = useState('');
  const [mtgShareOwner, setMtgShareOwner] = useState({ displayName: '', email: '' });
  const [mtgLinkBusy, setMtgLinkBusy] = useState(false);
  const [mtgLinkAccessMenuOpen, setMtgLinkAccessMenuOpen] = useState(false);
  /** Mirrors `sections.privacy.allowChatServerMemoryAssembly` (default true). */
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  /** Mirrors `sections.meetings.autoStartOnCalendar` (default false). */
  const [autoStartOnCalendar, setAutoStartOnCalendar] = useState(false);
  const autoStartOnCalendarRef = useRef(false);
  autoStartOnCalendarRef.current = autoStartOnCalendar;

  granolaRef.current = granola;

  const postRecBarActive = !!(granola && granola.storageKey && !audioRecSession && (postRecSessionFlag || noteHasCompletedRecording(granola.storageKey)));

  useEffect(function () {
    function onEnded() {
      if (backendRecActiveRef.current && granolaRef.current && granolaRef.current.backendMeetingId && isNativeDesktop()) {
        setBackendRecActive(false);
        backendRecStartedAtRef.current = 0;
        var mid = granolaRef.current.backendMeetingId;
        void runRuntimeActionM('meetings.get', { meeting_id: mid }, { silentError: true }).then(function (getRes: any) {
          var segs = getRes && getRes.ok && Array.isArray(getRes.data?.transcript) ? getRes.data.transcript : [];
          if (segs.length) {
            setGranolaDraft(function (d: any) {
              return { ...d, transcript: formatLiveTranscript(segs) };
            });
          }
        });
      }
      if (granolaRef.current && granolaRef.current.storageKey) {
        setPostRecSessionFlag(true);
        setListTick(function (x) { return x + 1; });
      }
    }
    window.addEventListener('shogun-meeting-recording-ended', onEnded);
    return function () { window.removeEventListener('shogun-meeting-recording-ended', onEnded); };
  }, []);

  useEffect(function () {
    var cancelled = false;
    function applyMeetingSettings(r: any) {
      if (cancelled || !r || !r.ok || !r.data || !r.data.settings || !r.data.settings.sections) return;
      var priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
      var mtg = r.data.settings.sections.meetings;
      if (mtg && typeof mtg === 'object') {
        if (typeof mtg.autoStartOnCalendar === 'boolean') {
          setAutoStartOnCalendar(mtg.autoStartOnCalendar);
        } else if (typeof mtg.autoRecord === 'boolean') {
          setAutoStartOnCalendar(mtg.autoRecord);
        } else {
          setAutoStartOnCalendar(false);
        }
      }
    }
    runRuntimeActionM('settings.load', {}, { silentError: true }).then(applyMeetingSettings);
    function onSettingsRefresh() {
      runRuntimeActionM('settings.load', {}, { silentError: true }).then(applyMeetingSettings);
    }
    window.addEventListener('shogun-settings-refresh', onSettingsRefresh);
    return function () {
      cancelled = true;
      window.removeEventListener('shogun-settings-refresh', onSettingsRefresh);
    };
  }, []);

  useEffect(function () {
    function onPrivacy() {
      runRuntimeActionM('settings.load', {}, { silentError: true }).then(function (r) {
        var priv = r && r.ok && r.data && r.data.settings && r.data.settings.sections && r.data.settings.sections.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    }
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return function () { window.removeEventListener('shogun-privacy-settings-changed', onPrivacy); };
  }, []);

  const granolaStorageKey = granola && granola.storageKey;
  useEffect(function () {
    setPostRecSessionFlag(false);
    setPostRecWaveMenuOpen(false);
    setMtgTopShareOpen(false);
    setMtgShareSearch('');
    setMtgLinkAccessMenuOpen(false);
    setMtgLinkAccess('anyone');
  }, [granolaStorageKey]);

  useEffect(function () {
    if (!mtgTopShareOpen) return;
    runRuntimeActionM('auth.status', {}, { silentError: true }).then(function (r) {
      var snap = r && r.ok && r.data && r.data.snapshot;
      var g = granolaRef.current;
      if (snap && (snap.displayName || snap.primaryEmail)) {
        setMtgShareOwner({
          displayName: snap.displayName || 'You',
          email: snap.primaryEmail || '',
        });
      } else {
        setMtgShareOwner({
          displayName: (g && g.authorLabel) ? g.authorLabel : 'You',
          email: '',
        });
      }
    });
  }, [mtgTopShareOpen]);

  useEffect(function () {
    try {
      var raw = localStorage.getItem(MEETINGS_COMING_UP_STORAGE);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) setComingUp(parsed);
      }
    } catch (_e) {}
    runRuntimeActionM('calendar.sync', { calendarId: 'primary', maxResults: 25 }, { silentError: true }).then(function (r) {
      if (!r || !r.ok) {
        // "not configured" is an expected first-run state — stay silent.
        // Any other failure (auth expired, network, API error) gets surfaced
        // so the user doesn't wonder why the coming-up list is stale.
        var errMsg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
        if (errMsg && errMsg.indexOf('not configured') < 0) {
          toastM('カレンダー同期に失敗しました — ' + errMsg, 'warn');
        }
        return;
      }
      if (!r.data || !Array.isArray(r.data.events) || !r.data.events.length) return;
      var WKD = ['\u65e5', '\u6708', '\u706b', '\u6c34', '\u6728', '\u91d1', '\u571f'];
      var mapped = r.data.events.map(function (ev: any, idx: any) {
        var start = ev.startDateTimeMs != null ? new Date(ev.startDateTimeMs) : (ev.start ? new Date(ev.start) : new Date());
        var end = ev.endDateTimeMs != null ? new Date(ev.endDateTimeMs) : (ev.end ? new Date(ev.end) : start);
        return {
          id: String(ev.id || 'ev-' + idx),
          day: start.getDate(),
          monthLabel: start.getMonth() + 1 + '\u6708',
          weekday: WKD[start.getDay()],
          title: ev.summary || ev.title || '\u4e88\u5b9a',
          timeRange: start.getHours() + ':' + String(start.getMinutes()).padStart(2, '0') + '\u301c' + end.getHours() + ':' + String(end.getMinutes()).padStart(2, '0'),
          startMs: start.getTime(),
          endMs: end.getTime(),
        };
      });
      setComingUp(mapped);
      try {
        localStorage.setItem(MEETINGS_COMING_UP_STORAGE, JSON.stringify(mapped));
      } catch (_e2) {}
    });
  }, []);

  useEffect(function () {
    const L = mnl();
    if (L && L.loadUserMeetingLog) {
      const log = L.loadUserMeetingLog();
      setUserMeetingItems(Array.isArray(log.items) ? log.items : []);
    }
  }, []);

  useEffect(function () {
    const onLog = function () {
      const L = mnl();
      if (L && L.loadUserMeetingLog) {
        const log = L.loadUserMeetingLog();
        setUserMeetingItems(Array.isArray(log.items) ? log.items : []);
      }
      setListTick(function (x) { return x + 1; });
    };
    window.addEventListener('shogun-user-meeting-log-changed', onLog);
    return function () { window.removeEventListener('shogun-user-meeting-log-changed', onLog); };
  }, []);

  // Imported recordings (com.shogun.import): query the backend meetings list
  // and filter on app_bundle_id. Refreshes when a new import completes via
  // the `shogun-meetings-changed` event.
  useEffect(function () {
    let cancelled = false;
    const load = function () {
      runRuntimeActionM('meetings.list', { limit: 50 }, { silentError: true }).then(function (r) {
        if (cancelled) return;
        const items = r && r.ok && Array.isArray(r.data && r.data.items) ? r.data.items : [];
        const filtered = items.filter(function (m: any) {
          return m && m.app_bundle_id === 'com.shogun.import';
        });
        setImportedMeetings(filtered);
      });
    };
    load();
    const onChanged = function () { load(); };
    window.addEventListener('shogun-meetings-changed', onChanged);
    return function () {
      cancelled = true;
      window.removeEventListener('shogun-meetings-changed', onChanged);
    };
  }, []);

  useEffect(function () {
    function syncRec() {
      if (backendRecActiveRef.current) {
        setAudioRecSession({ startedAt: Date.now(), storageKey: granolaRef.current && granolaRef.current.storageKey, backend: true });
        setRecTick(function (x) { return x + 1; });
        return;
      }
      var M = MeetingMediaRecording;
      if (M && M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting()) {
        var sk = M.getActiveStorageKey && M.getActiveStorageKey();
        setAudioRecSession({ startedAt: M.getStartedAt(), storageKey: sk || null });
      } else {
        setAudioRecSession(null);
      }
      setRecTick(function (x) { return x + 1; });
    }
    window.addEventListener('shogun-meeting-hud', syncRec);
    window.addEventListener('shogun-meeting-recording-ended', syncRec);
    syncRec();
    return function () {
      window.removeEventListener('shogun-meeting-hud', syncRec);
      window.removeEventListener('shogun-meeting-recording-ended', syncRec);
    };
  }, []);

  useEffect(function () {
    if (!granola || !granola.backendMeetingId || !isNativeDesktop()) return;
    var cancelled = false;
    runRuntimeActionM('meetings.audio.status', {}, { silentError: true }).then(function (r: any) {
      if (cancelled) return;
      if (r && r.ok && r.data && r.data.mic_capture_running) {
        setBackendRecActive(true);
        setSystemAudioRunning(!!r.data.system_audio_running);
        setGranolaPane('minutes');
      }
    });
    return function () { cancelled = true; };
  }, [granola && granola.backendMeetingId]);

  useEffect(function () {
    if (!backendRecActive || !granola || !granola.backendMeetingId || !isNativeDesktop()) {
      if (!backendRecActive) setSystemAudioRunning(false);
      return undefined;
    }
    var cancelled = false;
    const poll = function () {
      runRuntimeActionM('meetings.audio.status', {}, { silentError: true }).then(function (r: any) {
        if (cancelled || !r || !r.ok || !r.data) return;
        setSystemAudioRunning(!!r.data.system_audio_running);
      });
    };
    poll();
    var id = window.setInterval(poll, 5000);
    return function () {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [backendRecActive, granola && granola.backendMeetingId]);

  useEffect(function () {
    if (!backendRecActive || !granola || !granola.backendMeetingId || !isNativeDesktop()) {
      if (backendRecStartedAtRef.current) {
        clearMeetingHud();
        backendRecStartedAtRef.current = 0;
      }
      return undefined;
    }
    if (!backendRecStartedAtRef.current) {
      backendRecStartedAtRef.current = Date.now();
    }
    var cancelled = false;
    function pushHud(phase: 'begin' | 'tick') {
      if (cancelled) return;
      runRuntimeActionM('meetings.audio.status', {}, { silentError: true }).then(function (statusRes: any) {
        if (cancelled) return;
        const g = granolaRef.current;
        const st = statusRes && statusRes.ok && statusRes.data ? statusRes.data : {};
        const sysOn = !!st.system_audio_running;
        setSystemAudioRunning(sysOn);
        emitMeetingHud({
          active: true,
          hudPhase: phase,
          title: (g && g.title) || 'Untitled',
          startedAt: backendRecStartedAtRef.current,
          storageKey: (g && g.storageKey) || null,
          backend: true,
          backendMeetingId: (g && g.backendMeetingId) || null,
          micRunning: !!st.mic_capture_running,
          systemRunning: sysOn,
          deepgramConfigured: !!st.deepgram_configured,
          systemMode: st.system_mode || null,
        });
      });
    }
    pushHud('begin');
    var hudId = window.setInterval(function () { pushHud('tick'); }, 5000);
    return function () {
      cancelled = true;
      window.clearInterval(hudId);
    };
  }, [backendRecActive, granola && granola.backendMeetingId]);

  useEffect(function () {
    if (!grantedChangedToTrue) return;
    toastM('画面収録が許可されました。録音を開始できます', 'success');
    void refreshScreenCapturePermission();
  }, [grantedChangedToTrue, refreshScreenCapturePermission]);

  useEffect(function () {
    if (!granola || !granola.backendMeetingId || !backendRecActive) return undefined;
    var cancelled = false;
    const poll = function () {
      runRuntimeActionM('meetings.transcript.live', { meeting_id: granola.backendMeetingId }, { silentError: true })
        .then(function (r: any) {
          if (cancelled) return;
          var segs = r && r.ok && Array.isArray(r.data && r.data.segments) ? r.data.segments : [];
          if (!segs.length) return;
          var tx = formatLiveTranscript(segs);
          if (!tx) return;
          setGranolaDraft(function (d: any) { return { ...d, transcript: tx }; });
        });
    };
    poll();
    var id = setInterval(poll, 2000);
    return function () { cancelled = true; clearInterval(id); };
  }, [granola, granola && granola.backendMeetingId, backendRecActive]);

  useEffect(function () {
    if (!backendRecActive) {
      if (!MeetingMediaRecording || !MeetingMediaRecording.isRecording || !MeetingMediaRecording.isRecording()) {
        setAudioRecSession(null);
      }
      return;
    }
    setAudioRecSession({
      startedAt: backendRecStartedAtRef.current || Date.now(),
      storageKey: granolaRef.current && granolaRef.current.storageKey,
      backend: true,
    });
  }, [backendRecActive]);

  useEffect(function () {
    if (!audioRecSession) return undefined;
    const id = setInterval(function () { setRecTick(function (x) { return x + 1; }); }, 1000);
    return function () { clearInterval(id); };
  }, [audioRecSession]);

  const finalizeBackendMeeting = useCallback(async function (opts?: { silent?: boolean }) {
    const g = granolaRef.current;
    if (!g || !g.backendMeetingId || !isNativeDesktop()) return null;
    const mid = g.backendMeetingId;
    const res = await runRuntimeActionM('meetings.stop', { meeting_id: mid }, { silentError: true });
    setBackendRecActive(false);
    backendRecStartedAtRef.current = 0;
    clearMeetingHud();
    if (res && res.ok && res.data) {
      const getRes = await runRuntimeActionM('meetings.get', { meeting_id: mid }, { silentError: true });
      const segs = getRes && getRes.ok && Array.isArray(getRes.data?.transcript) ? getRes.data.transcript : [];
      if (segs.length) {
        setGranolaDraft(function (d: any) {
          return { ...d, transcript: formatLiveTranscript(segs) };
        });
      }
    }
    if (!opts?.silent) {
      toastM('会議を保存して終了しました', 'success');
    }
    try {
      window.dispatchEvent(new CustomEvent('shogun-meeting-recording-ended'));
      window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));
    } catch (_e) {}
    return res;
  }, []);

  useEffect(function () {
    const listenFn = typeof window !== 'undefined' && (window as any).__TAURI__?.event?.listen;
    if (typeof listenFn !== 'function') return undefined;
    let unlisten: (() => void) | undefined;
    (async function () {
      try {
        unlisten = await listenFn('meeting-auto-stopped', function (e: any) {
          var p = (e && e.payload) || {};
          var mid = p.meeting_id;
          var g = granolaRef.current;
          if (!mid || !g || g.backendMeetingId !== mid) return;
          setBackendRecActive(false);
          backendRecStartedAtRef.current = 0;
          clearMeetingHud();
          void runRuntimeActionM('meetings.get', { meeting_id: mid }, { silentError: true }).then(function (getRes: any) {
            var segs = getRes && getRes.ok && Array.isArray(getRes.data?.transcript) ? getRes.data.transcript : [];
            if (segs.length) {
              setGranolaDraft(function (d: any) {
                return { ...d, transcript: formatLiveTranscript(segs) };
              });
            }
          });
          var reasonLabel = p.reason === 'video_ended' ? 'ビデオ通話終了' : '無活動';
          toastM('会議を自動終了しました（' + reasonLabel + '）', 'info');
          try {
            window.dispatchEvent(new CustomEvent('shogun-meeting-recording-ended'));
          } catch (_e2) {}
        });
      } catch (_e) {}
    })();
    return function () {
      if (typeof unlisten === 'function') unlisten();
    };
  }, []);
  const granolaTitle = granola && granola.title;
  /** Keep MediaRecorder titleRef aligned with the note title (download filename + HUD) while recording. */
  useEffect(function () {
    if (!granola || !granola.storageKey) return;
    var M = MeetingMediaRecording;
    if (!M || !M.setActiveTitle || !M.isRecording || !M.isRecording()) return;
    var activeSk = M.getActiveStorageKey && M.getActiveStorageKey();
    if (!activeSk || activeSk !== granola.storageKey) return;
    M.setActiveTitle(granola.title);
  }, [granola, granolaStorageKey, granolaTitle, audioRecSession]);

  useEffect(function () {
    const onAutoMinutes = function (e: any) {
      var d = (e && e.detail) || {};
      var sk = d.storageKey;
      var g = granolaRef.current;
      if (sk && g && g.storageKey === sk) {
        setGranolaPane('minutes');
      }
    };
    window.addEventListener('shogun-auto-open-meeting-minutes', onAutoMinutes);
    return function () {
      window.removeEventListener('shogun-auto-open-meeting-minutes', onAutoMinutes);
    };
  }, []);

  const linkClientNoteToStorage = useCallback(async function (meetingId: any, storageKey: any) {
    if (!meetingId || !storageKey || !isNativeDesktop()) return meetingId;
    const L = mnl();
    if (L && L.linkBackendMeetingId) {
      L.linkBackendMeetingId(storageKey, meetingId);
    }
    const r = await runRuntimeActionM(
      'meetings.link_client_note',
      { meeting_id: meetingId, storage_key: storageKey },
      { silentError: true },
    );
    if (r && r.ok && r.data) {
      const linkedId = r.data.meeting_id || meetingId;
      if (linkedId !== meetingId) {
        setGranola(function (g: any) {
          if (!g || g.storageKey !== storageKey) return g;
          return { ...g, backendMeetingId: linkedId };
        });
        if (L && L.linkBackendMeetingId) {
          L.linkBackendMeetingId(storageKey, linkedId);
        }
      }
      return linkedId;
    }
    return meetingId;
  }, []);

  const openGranolaMinutesForDetectedMeeting = useCallback(function (title: any, eventId: any, meetingId?: any) {
    const L = mnl();
    const key = meetingId ? 'mtg-' + String(meetingId) : 'cal-' + String(eventId != null ? eventId : Date.now());
    const storageKey = L && L.calendarStorageKey
      ? L.calendarStorageKey(key)
      : (L ? L.storageHash({ cal: key, v: 1 }) : key);
    setGranolaPane('minutes');
    setGranolaMenuOpen(false);
    setGranola({
      key,
      storageKey,
      backendMeetingId: meetingId || null,
      title: title || 'Meeting',
      titleJp: '\u8b70\u4e8b\u9332',
      dateLabel: 'Today',
      dateLabelJp: '\u4eca\u65e5',
      authorLabel: 'Me',
      authorLabelJp: '\u81ea\u5206',
      body: '',
      tag: meetingId ? 'LIVE' : 'MTG',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    if (meetingId) {
      if (L && L.linkBackendMeetingId) {
        L.linkBackendMeetingId(storageKey, meetingId);
      }
      if (isNativeDesktop()) {
        void linkClientNoteToStorage(meetingId, storageKey);
      }
      toastM('ビデオ会議を検知—会議ノートを開きました', 'success');
    } else {
      toastM('\u4e88\u5b9a\u304b\u3089\u30df\u30fc\u30c6\u30a3\u30f3\u30b0\u3092\u691c\u77e5\u3057\u307e\u3057\u305f\uff08\u8b70\u4e8b\u9332\uff09', 'success');
    }
  }, [linkClientNoteToStorage]);

  useEffect(function () {
    const onDetected = function (e: any) {
      if (granolaRef.current) return;
      var d = (e && e.detail) || {};
      if ((window as any).SHOGUN_RUNTIME && typeof (window as any).SHOGUN_RUNTIME.setActiveScreen === 'function') {
        (window as any).SHOGUN_RUNTIME.setActiveScreen('meetings');
      }
      openGranolaMinutesForDetectedMeeting(d.title, d.eventId, d.meeting_id || null);
    };
    window.addEventListener('shogun-meeting-detected', onDetected);
    return function () {
      window.removeEventListener('shogun-meeting-detected', onDetected);
    };
  }, [openGranolaMinutesForDetectedMeeting]);

  useEffect(function () {
    if (!autoStartOnCalendar || !comingUp || !comingUp.length) return undefined;
    const check = function () {
      if (!autoStartOnCalendarRef.current) return;
      if (granolaRef.current) return;
      const now = Date.now();
      for (let i = 0; i < comingUp.length; i++) {
        const ev = comingUp[i];
        if (ev.startMs == null || ev.endMs == null) continue;
        if (now < ev.startMs || now > ev.endMs) continue;
        const mark = 'shogun_mtg_auto_' + ev.id;
        if (sessionStorage.getItem(mark)) continue;
        sessionStorage.setItem(mark, '1');
        try {
          window.dispatchEvent(
            new CustomEvent('shogun-meeting-detected', {
              detail: { title: ev.title, eventId: ev.id, startMs: ev.startMs, endMs: ev.endMs },
            }),
          );
        } catch (_e) {}
        break;
      }
    };
    check();
    const id = window.setInterval(check, 20000);
    return function () {
      window.clearInterval(id);
    };
  }, [comingUp, autoStartOnCalendar]);

  function rowStorageKey(n: any, dateCtx: any, dayJp?: any) {
    const L = mnl();
    if (n && n.storageKey) return n.storageKey;
    return L ? L.storageHash({ t: n.t, time: n.time, ctx: dateCtx, j: dayJp || '' }) : ('mtg-' + n.t + n.time);
  }

  const tagColor = (tag: any): string => (({
    DECISION: 'var(--gold)',
    RESEARCH: 'var(--text)',
    REVIEW:   'var(--text-mute)',
    THINKING: 'var(--text-dim)',
    NETWORK:  'var(--text-mute)',
    PLAN:     'var(--text)',
    AUDIO:    'var(--text-mute)',
    REC:      'var(--text-mute)',
    LIVE:     'var(--gold)',
    LOCAL:    'var(--text-dim)',
  } as Record<string, string>)[tag] || 'var(--text-dim)');

  const openQuickNote = useCallback(() => {
    const key = 'quick-' + Date.now();
    const L = mnl();
    const storageKey = L ? L.storageHash({ q: key }) : key;
    setGranolaPane('memo');
    setGranolaMenuOpen(false);
    setGranola({
      key,
      storageKey,
      title: 'Untitled',
      titleJp: '無題',
      dateLabel: 'Today',
      dateLabelJp: '今日',
      authorLabel: 'Me',
      authorLabelJp: '自分',
      body: '',
      tag: null,
      time: null,
    });
  }, []);

  const openMeetingNote = useCallback((n: any, dateCtx?: any, dayJp?: any) => {
    const isY = dateCtx === 'yesterday';
    const L = mnl();
    const storageKey = (n && n.storageKey) ? n.storageKey : (L ? L.storageHash({ t: n.t, time: n.time, ctx: dateCtx, j: dayJp || '' }) : ('mtg-' + n.t + n.time));
    setGranolaPane('memo');
    setGranolaMenuOpen(false);
    setGranola({
      key: 'mtg-' + n.t + (dateCtx || '') + n.time,
      storageKey,
      title: n.t,
      titleJp: null,
      dateLabel: isY ? 'Today' : (dateCtx || 'Today'),
      dateLabelJp: isY ? '今日' : (dayJp ? dateCtx + ' · ' + dayJp : (dateCtx || '今日')),
      authorLabel: n.a && !/^solo/i.test(n.a.trim()) ? n.a.split(',')[0].trim() : 'Me',
      authorLabelJp: n.a && !/^solo/i.test(n.a.trim()) ? n.a.split(',')[0].trim() : '自分',
      body: '',
      tag: n.tag,
      time: n.time,
    });
  }, []);

  const openRecipeGranola = useCallback((recipe: any) => {
    const key = 'recipe-' + recipe.label + '-' + Date.now();
    const L = mnl();
    const storageKey = L ? L.storageHash({ r: recipe.label, ts: Date.now() }) : key;
    const body = RECIPE_LOCAL_BODIES[recipe.label] || '';
    setGranolaPane('memo');
    setGranolaMenuOpen(false);
    setGranola({
      key,
      storageKey,
      title: recipe.label,
      titleJp: recipe.jp,
      dateLabel: 'Today',
      dateLabelJp: '今日',
      authorLabel: 'Me',
      authorLabelJp: '自分',
      body,
      tag: null,
      time: null,
    });
    void runRuntimeActionM('brief.get', briefPayloadWithUserTz({ span:'today', recipe: recipe.label, source:'meetings_local_recipe' }), { silentError:true });
    toastM('\u30ed\u30fc\u30ab\u30eb\u30c6\u30f3\u30d7\u3092\u958b\u304d\u307e\u3057\u305f\uff08\u30dc\u30c3\u30c8\u672a\u4f7f\u7528\uff09', 'success');
  }, []);

  const closeGranola = useCallback(async function () {
    const g = granola;
    if (g && g.backendMeetingId && isNativeDesktop()) {
      await finalizeBackendMeeting({ silent: true });
    }
    if (g && g.storageKey && mnl() && mnl().saveNote) {
      const tit = g.title != null ? String(g.title) : '';
      mnl().saveNote(g.storageKey, {
        ...granolaDraftRef.current,
        title: tit,
        backendMeetingId: g.backendMeetingId || null,
      });
      const L = mnl();
      if (tit.trim() && L.updateMeetingLogTitleByStorageKey) {
        L.updateMeetingLogTitleByStorageKey(g.storageKey, tit);
      }
    }
    var M = MeetingMediaRecording;
    if (M && M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting() && typeof M.abort === 'function') {
      M.abort();
    }
    setBackendRecActive(false);
    setGranola(null);
    setGranolaMenuOpen(false);
    setGranolaTodos(null);
    setCmdBarMin(false);
    setListTick(function (x) { return x + 1; });
  }, [granola, finalizeBackendMeeting]);

  const startBackendRecording = useCallback(async function (captureSystem: boolean) {
    const g = granolaRef.current;
    if (!g || !g.backendMeetingId || !isNativeDesktop()) return false;
    if (backendRecActiveRef.current) return true;
    if (g.storageKey) {
      await linkClientNoteToStorage(g.backendMeetingId, g.storageKey);
    }
    var br = await runRuntimeActionM('meetings.mic.start', {
      meeting_id: g.backendMeetingId,
      live_stt: true,
      capture_system: captureSystem,
    });
    if (br && br.ok) {
      backendRecStartedAtRef.current = Date.now();
      setBackendRecActive(true);
      setGranolaPane('minutes');
      var statusRes = await runRuntimeActionM('meetings.audio.status', {}, { silentError: true });
      var sysOn = !!(statusRes && statusRes.ok && statusRes.data && statusRes.data.system_audio_running);
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
    toastM((br && br.error) || 'バックエンド録音の開始に失敗しました', 'error');
    return false;
  }, [linkClientNoteToStorage]);

  const startNoteRecording = useCallback(async function () {
    if (!granola || !granola.storageKey) return;
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
    var M = MeetingMediaRecording;
    if (M && M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting()) return;
    if (!M || typeof M.start !== 'function') {
      toastM('録音モジュールが読み込まれていません', 'error');
      return;
    }
    var r = await M.start({
      storageKey: granola.storageKey,
      title: granola.title,
      onToast: toastM,
    });
    if (r && r.ok) {
      setGranolaPane('minutes');
    }
  }, [granola, backendRecActive, screenCaptureGranted, startBackendRecording, refreshScreenCapturePermission]);

  const startMicOnlyRecording = useCallback(async function () {
    if (!granola || !granola.backendMeetingId || !isNativeDesktop()) return;
    if (backendRecActive) return;
    await startBackendRecording(false);
  }, [granola, backendRecActive, startBackendRecording]);

  const openMeetingScreenCaptureSettings = useCallback(async function () {
    setPermissionActionBusy(true);
    try {
      await runRuntimeActionM(
        'permissions.manage',
        { target: 'screen_capture', source: 'meetings.permission_banner' },
        { silentError: true },
      );
    } finally {
      setPermissionActionBusy(false);
    }
  }, []);

  const requestMeetingScreenCaptureAccess = useCallback(async function () {
    setPermissionActionBusy(true);
    try {
      await runRuntimeActionM(
        'permissions.manage',
        { target: 'screen_capture_request', source: 'meetings.permission_banner' },
        { silentError: true },
      );
      await refreshScreenCapturePermission();
    } finally {
      setPermissionActionBusy(false);
    }
  }, [refreshScreenCapturePermission]);

  const stopNoteRecording = useCallback(async function () {
    if (granola && granola.backendMeetingId && isNativeDesktop() && backendRecActive) {
      await finalizeBackendMeeting();
      return;
    }
    var M = MeetingMediaRecording;
    if (M && typeof M.stop === 'function') {
      M.stop();
    } else {
      toastM('録音モジュールが読み込まれていません', 'error');
    }
  }, [granola, backendRecActive, finalizeBackendMeeting]);

  const granolaKey = granola && granola.key;
  useEffect(function () {
    if (!granola || !granola.storageKey || !isNativeDesktop()) return undefined;
    var cancelled = false;
    (async function () {
      const L = mnl();
      const saved = L && L.loadNote ? L.loadNote(granola.storageKey) : null;
      var mid = granola.backendMeetingId || (saved && saved.backendMeetingId) || null;
      if (!mid) {
        const r = await runRuntimeActionM(
          'meetings.resolve_by_storage_key',
          { storage_key: granola.storageKey },
          { silentError: true },
        );
        if (r && r.ok && r.data && r.data.found && r.data.meeting_id) {
          mid = String(r.data.meeting_id);
        }
      }
      if (cancelled || !mid) return;
      const sk = granola.storageKey;
      if (granolaRef.current && granolaRef.current.storageKey === sk) {
        if (granolaRef.current.backendMeetingId !== mid) {
          setGranola(function (g: any) {
            if (!g || g.storageKey !== sk) return g;
            return { ...g, backendMeetingId: mid, tag: g.tag === 'MTG' ? 'LIVE' : g.tag };
          });
        }
        if (L && L.linkBackendMeetingId) {
          L.linkBackendMeetingId(sk, mid);
        }
        await runRuntimeActionM(
          'meetings.link_client_note',
          { meeting_id: mid, storage_key: sk },
          { silentError: true },
        );
      }
    })();
    return function () { cancelled = true; };
  }, [granola && granola.storageKey]);

  useEffect(() => {
    if (!granola || !granola.storageKey) return;
    const L = mnl();
    const saved = L && L.loadNote ? L.loadNote(granola.storageKey) : null;
    if (saved && saved.backendMeetingId && !granola.backendMeetingId) {
      setGranola(function (g: any) {
        if (!g || g.storageKey !== granola.storageKey) return g;
        return { ...g, backendMeetingId: saved.backendMeetingId };
      });
    }
    if (saved && (saved.body || saved.transcript || saved.summary || saved.minutes)) {
      setGranolaDraft({
        body: saved.body || '',
        transcript: saved.transcript || '',
        summary: saved.summary || '',
        minutes: saved.minutes || '',
      });
    } else {
      setGranolaDraft({ body: granola.body || '', transcript:'', summary:'', minutes:'' });
    }
    setGranolaPane('memo');
  }, [granola, granolaStorageKey, granolaKey]);

  useEffect(() => {
    if (!granola || !granola.storageKey) return;
    const L = mnl();
    if (!L || !L.saveNote) return;
    const t = setTimeout(function () {
      L.saveNote(granola.storageKey, {
        ...granolaDraft,
        backendMeetingId: granola.backendMeetingId || null,
      });
    }, 450);
    return function () { clearTimeout(t); };
  }, [granola, granolaStorageKey, granolaDraft, granola && granola.backendMeetingId]);

  useEffect(() => {
    if (!granola) return;
    const onKey = (e: any) => {
      if (e.key === 'Escape') {
        if (mtgLinkAccessMenuOpen) { setMtgLinkAccessMenuOpen(false); return; }
        if (mtgTopShareOpen) { setMtgTopShareOpen(false); return; }
        if (granolaMenuOpen) { setGranolaMenuOpen(false); return; }
        if (granolaTodos !== null) { setGranolaTodos(null); return; }
        closeGranola();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [granola, granolaMenuOpen, granolaTodos, closeGranola, mtgTopShareOpen, mtgLinkAccessMenuOpen]);

  const granolaMeta = useCallback(() => ({
    title: granola && granola.title,
    authorLabel: granola && granola.authorLabel,
    dateLabel: granola && granola.dateLabel,
    time: granola && granola.time,
    tag: granola && granola.tag,
  }), [granola]);

  const applyStubTranscript = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const tx = L.buildStubTranscript(granolaMeta());
    setGranolaDraft(function (d) { return { ...d, transcript: d.transcript ? d.transcript + '\n\n' + tx : tx }; });
    toastM('\u30c6\u30f3\u30d7\u306e\u6587\u5b57\u8d77\u3053\u3057\u3092\u633f\u5165\u3057\u307e\u3057\u305f', 'success');
  }, [granola, granolaMeta]);

  const refreshSummary = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const src = (granolaDraft.transcript || '') + '\n' + (granolaDraft.body || '');
    const sum = L.summarizeLocal(src, granolaMeta());
    setGranolaDraft(function (d) { return { ...d, summary: sum }; });
    setGranolaPane('summary');
    toastM('\u8981\u7d04\u3092\u66f4\u65b0\u3057\u307e\u3057\u305f\uff08\u30eb\u30fc\u30eb\u30d9\u30fc\u30b9\uff09', 'success');
  }, [granola, granolaMeta, granolaDraft.transcript, granolaDraft.body]);

  const refreshMinutes = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const md = L.buildMinutesMarkdown(granolaMeta(), granolaDraft.transcript, granolaDraft.body, granolaDraft.summary);
    setGranolaDraft(function (d) { return { ...d, minutes: md }; });
    setGranolaPane('minutes');
    toastM('\u8b70\u4e8b\u9332\u3092\u751f\u6210\u3057\u307e\u3057\u305f\uff08\u30c6\u30f3\u30d7\u30ec\u30fc\u30c8\uff09', 'success');
  }, [granola, granolaMeta, granolaDraft]);

  /** 録音（文字起こし）＋メモを渡して AI 議事録。デスクトップは `meetings.enhance`、Hi-Fi はフォールバックでルールベース。 */
  const runMtgEnhance = useCallback(async function () {
    if (!granola || !granola.storageKey) return;
    setMtgEnhanceBusy(true);
    try {
      var res = await runRuntimeActionM('meetings.enhance', {
        storageKey: granola.storageKey,
        title: granola.title || '',
        notes: granolaDraft.body || '',
        transcript: granolaDraft.transcript || '',
        summary: granolaDraft.summary || '',
      }, { silentError: true });
      var md =
        res &&
        res.ok &&
        res.data &&
        (res.data.minutesMarkdown || res.data.minutes || res.data.markdown);
      if (md && String(md).trim()) {
        setGranolaDraft(function (d) { return { ...d, minutes: String(md) }; });
        setGranolaPane('minutes');
        toastM('AI 議事録を反映しました', 'success');
        return;
      }
      refreshMinutes();
      toastM('ルールベースの議事録を生成しました（本番 AI はデスクトップ版）', 'info');
    } finally {
      setMtgEnhanceBusy(false);
    }
  }, [granola, granolaDraft, refreshMinutes]);

  const ingestNoteToMemory = useCallback(() => {
    const title = (granola && granola.title) || 'Meeting note';
    const snippet = [
      granolaDraft.summary && granolaDraft.summary.slice(0, 500),
      granolaDraft.transcript && granolaDraft.transcript.slice(0, 1200),
      granolaDraft.body && granolaDraft.body.slice(0, 400),
    ].filter(Boolean).join('\n---\n').slice(0, 4000);
    void runRuntimeActionM('memory.ingest', {
      title: title + ' · meeting',
      snippet: snippet || '(empty)',
      source: 'meeting',
      provenance: 'meeting',
      entity_id: (granola && granola.backendMeetingId) || (granola && granola.storageKey) || undefined,
      kinds: ['note', 'meeting'],
    }, { successMessage: 'Memory に保存しました' });
  }, [granola, granolaDraft]);

  const runMeetingRecipe = useCallback(async function (recipeLabel: any, target?: 'memo' | 'summary') {
    const where = target || 'memo';
    const recipeId = RECIPE_LABEL_TO_ID[recipeLabel];
    if (!recipeId || !isNativeDesktop()) {
      injectRecipeIntoMemoLocal(recipeLabel);
      return;
    }
    const payload: any = { recipe_id: recipeId };
    if (granola && granola.backendMeetingId) {
      payload.meeting_id = granola.backendMeetingId;
    } else {
      payload.transcript = granolaDraft.transcript || '';
      payload.notes = granolaDraft.body || '';
    }
    const res = await runRuntimeActionM('meetings.recipe.run', payload, { silentError: true });
    if (res && res.ok && res.data && res.data.text && String(res.data.text).trim()) {
      const text = String(res.data.text);
      setGranolaDraft(function (d: any) {
        if (where === 'summary') return { ...d, summary: text };
        const sep = (d.body || '').trim() ? '\n\n' : '';
        return { ...d, body: (d.body || '') + sep + text };
      });
      if (where === 'summary') setGranolaPane('summary');
      else setGranolaPane('memo');
      toastM('レシピを実行しました', 'success');
      return;
    }
    injectRecipeIntoMemoLocal(recipeLabel);
  }, [granola, granolaDraft]);

  function injectRecipeIntoMemoLocal(recipeLabel: any) {
    var block = RECIPE_LOCAL_BODIES[recipeLabel];
    if (!granola || !block) return;
    setGranolaPane('memo');
    setGranolaDraft(function (d: any) {
      var sep = (d.body || '').trim() ? '\n\n' : '';
      return { ...d, body: (d.body || '') + sep + block };
    });
    toastM('テンプレートをメモに挿入しました', 'success');
    setPostRecWaveMenuOpen(false);
  }

  const buildMtgShareMarkdown = useCallback(function () {
    if (!granola) return '';
    var title = granola.title || 'Meeting';
    return [
      '# ' + title,
      '',
      '## Notes',
      granolaDraft.body || '',
      '',
      '## Transcript',
      granolaDraft.transcript || '',
      '',
      '## Summary',
      granolaDraft.summary || '',
      '',
      '## Minutes',
      granolaDraft.minutes || '',
    ].join('\n');
  }, [granola, granolaDraft]);

  const copyMtgShareLink = useCallback(async function () {
    if (!granola || !granola.storageKey) return;
    setMtgLinkBusy(true);
    try {
      var mode = mtgLinkAccess === 'anyone' ? 'public' : 'private';
      var res = await runRuntimeActionM('app.create_share_link', {
        resourceType: 'meeting_note',
        storageKey: granola.storageKey,
        title: granola.title,
        mode: mode,
        markdown: buildMtgShareMarkdown().slice(0, 120000),
      }, { silentError: true });
      var url = res && res.ok && res.data && res.data.url;
      if (!url && typeof window !== 'undefined' && window.location) {
        url = window.location.origin + '/meetings?note=' + encodeURIComponent(granola.storageKey);
      }
      if (url && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      }
      var sub = mtgLinkAccess === 'anyone'
        ? 'Anyone with the link can view'
        : 'Restricted link — recipients need access';
      toastM('Link copied\n' + sub, 'success');
    } catch (_e) {
      toastM('コピーに失敗しました', 'warn');
    } finally {
      setMtgLinkBusy(false);
    }
  }, [granola, mtgLinkAccess, buildMtgShareMarkdown]);

  const moveGranolaToTrash = useCallback(function () {
    if (!granola || !granola.storageKey) return;
    if (!window.confirm('この会議ノートをゴミ箱に移しますか？ローカルに保存した内容が削除されます。')) return;
    var L = mnl();
    if (L && L.deleteNote) L.deleteNote(granola.storageKey);
    if (L && L.removeMeetingLogEntryByStorageKey) L.removeMeetingLogEntryByStorageKey(granola.storageKey);
    setMtgTopShareOpen(false);
    setGranolaMenuOpen(false);
    setGranola(null);
    setListTick(function (x) { return x + 1; });
    toastM('ゴミ箱に移しました（ローカル）', 'success');
  }, [granola]);

  const mtgDraftEmail = useCallback(function () {
    if (!granola) return;
    var blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes].filter(Boolean).join('\n\n');
    void runRuntimeActionM('shogun.draft_reply', {
      format: 'email',
      sourceText: blob,
      meetingTitle: granola.title,
    }, { silentError: true }).then(function (r) {
      var c = r && r.ok && r.data && r.data.content;
      if (c && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(c).then(function () {
          toastM('メール下書きをクリップボードにコピーしました', 'success');
        }, function () {
          toastM('下書きは取得できましたがコピーに失敗しました', 'warn');
        });
        return;
      }
      if (c) {
        // Draft succeeded but the browser denied clipboard access (e.g. no
        // secure context). Tell the user explicitly so they know the text
        // isn't on their clipboard.
        toastM('クリップボードが利用できません', 'warn');
        return;
      }
      var errMsg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
      toastM(
        errMsg ? 'メール下書きに失敗しました — ' + errMsg : 'メール下書きを取得できませんでした',
        'warn'
      );
    });
  }, [granola, granolaDraft]);

  const mtgCopyAllText = useCallback(function () {
    var blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes].filter(Boolean).join('\n\n');
    if (!blob.trim()) {
      toastM('コピーするテキストがありません', 'info');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(blob).then(function () {
        toastM('テキストをコピーしました', 'success');
      }, function () {
        toastM('コピーに失敗しました', 'warn');
      });
    }
  }, [granolaDraft]);

  const runLocalAsk = useCallback(() => {
    const q = (granolaAsk || '').trim();
    if (!q) return;
    const L = mnl();
    const text = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes].join('\n');
    let n = 0;
    if (L && L.countOccurrences) n = L.countOccurrences(text, q);
    else if (q) n = Math.max(0, text.toLowerCase().split(q.toLowerCase()).length - 1);
    toastM('\u300c' + q + '\u300d\u2192 \u3053\u306e\u30ce\u30fc\u30c8\u5185 ' + n + ' \u4ef6\u4e00\u81f4\uff08\u30ed\u30fc\u30ab\u30eb\u691c\u7d22\uff09', n ? 'success' : 'info');
  }, [granolaAsk, granolaDraft]);

  const listLocalTodos = useCallback(() => {
    const L = mnl();
    const blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes].join('\n');
    const todos = L ? L.extractTodos(blob) : [];
    setGranolaTodos(todos);
    toastM('ToDo ' + todos.length + '\u4ef6\uff08\u30ed\u30fc\u30ab\u30eb\u62bd\u51fa\u30fb\u30dc\u30c3\u30c8\u672a\u4f7f\u7528\uff09', todos.length ? 'success' : 'info');
  }, [granolaDraft]);

  const injectRecipeIntoMemo = useCallback(function (recipeLabel: any) {
    void runMeetingRecipe(recipeLabel, 'memo');
  }, [runMeetingRecipe]);

  const runPostRecSlashItem = useCallback(function (item: any) {
    setPostRecWaveMenuOpen(false);
    if (item.kind === 'action' && item.id === 'todos') {
      listLocalTodos();
      return;
    }
    if (item.kind === 'recipe' && item.recipeLabel) {
      void runMeetingRecipe(item.recipeLabel, 'memo');
    }
  }, [listLocalTodos, runMeetingRecipe]);

  const [granolaPillMenu, setGranolaPillMenu] = useState<any>(null); // { kind: 'date'|'attendees'|'folder', anchor: {left, top, width} }
  const [granolaAttendees, setGranolaAttendees] = useState<string[]>(['Toru Tano']);
  const [granolaAttendeesQuery, setGranolaAttendeesQuery] = useState('');
  const [granolaFolder, setGranolaFolder] = useState('My notes');
  const [granolaFolderQuery, setGranolaFolderQuery] = useState('');
  const [granolaFolderList, setGranolaFolderList] = useState<string[]>(['My notes', 'Toru team']);

  const openGranolaPillMenu = useCallback(function (kind: any, evt: any) {
    try {
      var el = evt && evt.currentTarget;
      if (!el) { setGranolaPillMenu({ kind: kind, anchor: { left: 80, top: 80, width: 260 } }); return; }
      var r = el.getBoundingClientRect();
      setGranolaPillMenu({
        kind: kind,
        anchor: { left: r.left, top: r.bottom + 6, width: Math.max(260, Math.round(r.width)) },
      });
    } catch (_e) {
      setGranolaPillMenu({ kind: kind, anchor: { left: 80, top: 80, width: 260 } });
    }
  }, []);
  const closeGranolaPillMenu = useCallback(function () { setGranolaPillMenu(null); }, []);

  const addFolderTag = useCallback(function (ev: any) {
    openGranolaPillMenu('folder', ev);
  }, [openGranolaPillMenu]);

  const addCalendarEvent = useCallback(function () {
    toastM('\u30ab\u30ec\u30f3\u30c0\u30fc\u30a4\u30d9\u30f3\u30c8\u306e\u30ea\u30f3\u30af\u306f\u8a2d\u5b9a\u304b\u3089\u6709\u52b9\u5316\u3067\u304d\u307e\u3059\uff08\u30e2\u30c3\u30af\uff09', 'info');
  }, []);

  const showGranolaDateInfo = useCallback(function (ev: any) {
    openGranolaPillMenu('date', ev);
  }, [openGranolaPillMenu]);

  const showGranolaAuthorInfo = useCallback(function (ev: any) {
    openGranolaPillMenu('attendees', ev);
  }, [openGranolaPillMenu]);

  const granolaDateFull = useMemo(function () {
    try {
      var d = new Date();
      var en = d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
      var jp = d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
      var t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      return { en: en, jp: jp, t: t };
    } catch (_e) {
      return { en: 'Today', jp: '\u672c\u65e5', t: '--:--' };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: re-eval when menu opens so "today" stays fresh
  }, [granolaPillMenu]);
  const toggleAttendee = useCallback(function (name: any) {
    setGranolaAttendees(function (list) {
      return list.indexOf(name) >= 0 ? list.filter(function (n) { return n !== name; }) : list.concat([name]);
    });
  }, []);
  const pickFolder = useCallback(function (name: any) {
    setGranolaFolder(name);
    toastM('Folder: ' + name, 'success');
    setGranolaPillMenu(null);
  }, []);
  const addNewFolder = useCallback(function () {
    var base = (granolaFolderQuery || '').trim();
    if (!base) { toastM('\u65b0\u3057\u3044\u30d5\u30a9\u30eb\u30c0\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044', 'info'); return; }
    setGranolaFolderList(function (list) { return list.indexOf(base) >= 0 ? list : list.concat([base]); });
    setGranolaFolder(base);
    toastM('\u30d5\u30a9\u30eb\u30c0\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f: ' + base, 'success');
    setGranolaFolderQuery('');
    setGranolaPillMenu(null);
  }, [granolaFolderQuery]);

  const submitMeetingsPrompt = useCallback(function (e: any) {
    if (e) e.preventDefault();
    var raw = (meetingsPrompt || '').trim();
    if (!raw) return;
    if (raw.startsWith('/')) {
      var rest = raw.slice(1).trim();
      if (!rest) {
        toastM('\u30b3\u30de\u30f3\u30c9\u3092\u9078\u629e\u3059\u308b\u304b\u3001/\u306e\u5f8c\u306b\u691c\u7d22\u8a9e\u3092\u5165\u529b\u3057\u3066\u9001\u4fe1\u3057\u3066\u304f\u3060\u3055\u3044', 'info');
        return;
      }
      raw = rest;
    }
    runRuntimeActionM('memory.search', { query: raw, kinds: ['audio', 'note'], limit: 30 }, { successMessage: '\u691c\u7d22\u3057\u307e\u3057\u305f' });
  }, [meetingsPrompt]);

  const listRecentTodosFromDock = useCallback(function () {
    runRuntimeActionM('memory.search', { query: 'TODO [ ]', kinds: ['note'], limit: 25 }, { successMessage: 'TODO\u3092\u691c\u7d22\u3057\u307e\u3057\u305f' });
  }, []);

  const runDockSlashItem = useCallback(function (item: any) {
    setMeetingsRecipeBrowse(false);
    setMeetingsPrompt('');
    if (item.kind === 'action' && item.id === 'todos') {
      listRecentTodosFromDock();
      return;
    }
    if (item.kind === 'recipe' && item.recipeLabel) {
      openRecipeGranola({ label: item.recipeLabel, jp: item.recipeJp || '\u30ed\u30fc\u30ab\u30eb' });
    }
  }, [listRecentTodosFromDock, openRecipeGranola]);

  const filteredDockSlash = useMemo(function () {
    if (meetingsRecipeBrowse) return MEETINGS_DOCK_SLASH_CATALOG;
    if (!meetingsPrompt.startsWith('/')) return [];
    var needle = meetingsPrompt.slice(1).toLowerCase().trim();
    if (!needle) return MEETINGS_DOCK_SLASH_CATALOG;
    return MEETINGS_DOCK_SLASH_CATALOG.filter(function (row) {
      var inJp = row.jpHint && String(row.jpHint).toLowerCase().indexOf(needle) !== -1;
      return row.label.toLowerCase().indexOf(needle) !== -1 || row.desc.toLowerCase().indexOf(needle) !== -1 || inJp;
    });
  }, [meetingsPrompt, meetingsRecipeBrowse]);

  const showDockRecipeOverlay = meetingsRecipeBrowse || (meetingsPrompt.startsWith('/') && meetingsPrompt.length >= 1);

  useEffect(function () {
    if (!showDockRecipeOverlay) return;
    function onKey(e: any) {
      if (e.key === 'Escape') {
        setMeetingsRecipeBrowse(false);
        setMeetingsPrompt(function (p) { return (p && p.startsWith('/')) ? '' : (p || ''); });
      }
    }
    window.addEventListener('keydown', onKey);
    return function () { window.removeEventListener('keydown', onKey); };
  }, [showDockRecipeOverlay]);

  return (
    <div className="screen-meetings-root">
      <div className="screen-meetings-scroll">
        <div className="screen-meetings-inner">

      {/* Quick note — top right (Granola-style pill) */}
      <button
        type="button"
        onClick={openQuickNote}
        className="mtg-quick-note"
        style={{
          position:'absolute',
          top:44,
          right:40,
          zIndex:2,
          display:'inline-flex',
          alignItems:'center',
          gap:8,
          padding:'8px 14px',
          borderRadius:999,
          border:'1px solid var(--border-hi)',
          background:'var(--surface)',
          color:'var(--text)',
          fontSize:13,
          fontWeight:500,
          letterSpacing:'-0.01em',
          cursor:'pointer',
          fontFamily:'var(--font-sans, system-ui, sans-serif)',
          boxShadow:'var(--shadow-sm)',
        }}
      >
        <Icon name="plus" size={15}/>
        <span className="en-only">Quick note</span>
        <span className="jp" style={{fontSize:12}}>クイックノート</span>
      </button>

      {/* Header — centered to column (Quick note is position:absolute; no asymmetric padding) */}
      <div style={{
        display:'flex',
        flexDirection:'column',
        alignItems:'center',
        width:'100%',
        marginBottom:40,
        boxSizing:'border-box',
      }}>
        <div style={{
          width:52,
          height:52,
          flexShrink:0,
          display:'flex',
          alignItems:'center',
          justifyContent:'center',
          borderRadius:'50%',
          background:'var(--surface)',
          border:'1px solid var(--border)',
          marginBottom:18,
        }}>
          <Icon name="calendar" size={20} className="gold"/>
        </div>
        <h1 style={{margin:0, width:'100%', textAlign:'center', fontSize:34, fontWeight:600, letterSpacing:'-0.02em', fontFamily:'var(--font-serif, var(--font-en))'}}>
          Meetings <span className="jp" style={{fontSize:22, fontWeight:300, marginLeft:10, color:'var(--text-mute)'}}>会議</span>
        </h1>
      </div>

      {/* Coming up — filled when calendar.sync returns events (localStorage cache on success) */}
      <section className="mtg-coming-up" aria-label="Coming up">
        <h2 className="mtg-coming-up-title">
          Coming up
          <span className="jp dim" style={{fontSize:14, fontWeight:400, marginLeft:10}}>これからの予定</span>
        </h2>
        <div className="mtg-coming-up-card">
          {comingUp.length === 0 ? (
            <div style={{ padding: '18px 16px', color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.5, textAlign: 'center' }}>
              <span className="en-only">Connect a calendar to see upcoming meetings here.</span>
              <span className="jp" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>カレンダー連携で、これからの予定が表示されます。</span>
            </div>
          ) : (
            comingUp.map(function (row) {
              return (
                <div key={row.id} className="mtg-coming-row">
                  <div className="mtg-coming-date">
                    <span className="mtg-coming-daynum">{row.day}</span>
                    <div className="mtg-coming-ymd">
                      <span>{row.monthLabel}</span>
                      <span style={{fontSize:11, color:'var(--text-dim)'}}>{row.weekday}</span>
                    </div>
                  </div>
                  <div className="mtg-coming-event">
                    <div className="mtg-coming-event-title">{row.title}</div>
                    <div className="mtg-coming-event-time">{row.timeRange}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Divider */}
      <div style={{height:1, background:'var(--border)', marginBottom:18, position:'relative'}}>
        <span style={{position:'absolute', left:'50%', top:-7, transform:'translateX(-50%)', padding:'0 10px', background:'var(--bg)', fontFamily:'var(--font-jp)', fontSize:11, color:'var(--text-dim)'}} className="jp">記録</span>
      </div>

      {/* Import past recordings */}
      <div className="row" style={{justifyContent:'center', marginBottom:24, gap:10, flexWrap:'wrap', alignItems:'center'}}>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={async () => {
            const pick = await runRuntimeActionM('meetings.import.pick', {}, { silentError: true });
            const paths = pick && pick.ok && Array.isArray(pick.data?.paths) ? pick.data.paths : [];
            if (!paths.length) return;
            (window as any).SHOGUN_RUNTIME?.pushToast?.(
              `Importing ${paths.length} recording${paths.length > 1 ? 's' : ''}…`,
              'info',
            );
            let succeeded = 0;
            let failed = 0;
            for (const p of paths) {
              const r = await runRuntimeActionM('meetings.import.file', { path: p }, { silentError: true });
              if (r && r.ok) succeeded += 1;
              else {
                failed += 1;
                const msg = (r && r.error && r.error.message) || `Failed: ${p}`;
                (window as any).SHOGUN_RUNTIME?.pushToast?.(msg, 'error');
              }
            }
            if (succeeded > 0) {
              (window as any).SHOGUN_RUNTIME?.pushToast?.(
                failed === 0
                  ? `Imported ${succeeded} recording${succeeded > 1 ? 's' : ''}`
                  : `Imported ${succeeded}, failed ${failed}`,
                failed === 0 ? 'success' : 'warn',
              );
              window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));
            }
          }}
        >
          <Icon name="file" size={13} />
          <span className="en-only">Import past recording</span>
          <span className="jp" style={{fontSize:12}}>過去の録音を取り込む</span>
        </button>
        <span className="s-field-hint" style={{fontSize:11}}>
          <span className="en-only">Audio / video files (mp3, m4a, mp4, wav…) are transcribed via Deepgram.</span>
          <span className="jp">音声・動画 (mp3, m4a, mp4, wav など) を Deepgram で文字起こしします。</span>
        </span>
      </div>

      {/* Imported recordings */}
      {importedMeetings.length > 0 && (
        <div style={{marginBottom:36}}>
          <div className="row" style={{marginBottom:16, gap:14}}>
            <span className="t-mono" style={{color:'var(--gold)'}}>IMPORTED</span>
            <span className="jp dim" style={{fontSize:11}}>取り込み済み</span>
            <span style={{height:1, flex:1, background:'var(--border)'}}/>
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>{importedMeetings.length} ITEMS</span>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {importedMeetings.map(function (m) {
              const started = Number(m.started_at) || 0;
              const ended = Number(m.ended_at) || 0;
              const durMs = Math.max(0, ended - started);
              const durMin = Math.floor(durMs / 60000);
              const durSec = Math.floor((durMs % 60000) / 1000);
              const durationLabel = durMs > 0
                ? (durMin > 0 ? durMin + 'm ' + String(durSec).padStart(2, '0') + 's' : durSec + 's')
                : '—';
              const date = started > 0 ? new Date(started) : null;
              const dateLabel = date
                ? date.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';
              return (
                <div
                  key={m.id}
                  className="card card-interactive"
                  style={{padding:14, display:'flex', gap:14, alignItems:'center', cursor:'pointer'}}
                  onClick={function () {
                    setMeetingDetail({ meeting: m, segments: null, loading: true, filter: '' });
                    runRuntimeActionM(
                      'meetings.transcript.get',
                      { meeting_id: m.id },
                      { silentError: true },
                    ).then(function (r) {
                      const segs = r && r.ok && Array.isArray(r.data && r.data.segments)
                        ? r.data.segments
                        : [];
                      setMeetingDetail((prev: any) => (
                        prev && prev.meeting && prev.meeting.id === m.id
                          ? { ...prev, segments: segs, loading: false }
                          : prev
                      ));
                    });
                  }}
                >
                  <span style={{flexShrink:0, display:'inline-flex'}}><Icon name="calendar" size={14} className="gold"/></span>
                  <div style={{flex:1, minWidth:0}}>
                    <div style={{fontSize:14, fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {m.title || 'Imported recording'}
                    </div>
                    <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginTop:2}}>
                      {dateLabel} · {durationLabel}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    title="Remove imported recording"
                    onClick={function (e) {
                      e.stopPropagation();
                      const ok = typeof window.confirm === 'function'
                        ? window.confirm('Remove "' + (m.title || 'this recording') + '" and its transcript?')
                        : true;
                      if (!ok) return;
                      runRuntimeActionM('meetings.purge', { meeting_id: m.id }, { silentError: true }).then(function (r) {
                        if (r && r.ok) {
                          (window as any).SHOGUN_RUNTIME?.pushToast?.('Recording removed', 'success');
                          window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));
                        } else {
                          const msg = (r && r.error && r.error.message) || 'Remove failed';
                          (window as any).SHOGUN_RUNTIME?.pushToast?.(msg, 'error');
                        }
                      });
                    }}
                  >
                    <Icon name="x" size={12}/>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Your sessions today (from Start meeting) */}
      {userMeetingItems.length > 0 && (
        <div style={{marginBottom:36}}>
          <div className="row" style={{marginBottom:16, gap:14}}>
            <span className="t-mono" style={{color:'var(--gold)'}}>TODAY</span>
            <span className="jp dim" style={{fontSize:11}}>あなたの記録</span>
            <span style={{height:1, flex:1, background:'var(--border)'}}/>
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>{userMeetingItems.length} ITEMS</span>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:2}}>
            {(function () {
              var Mrow = MeetingMediaRecording;
              var recSk = audioRecSession && audioRecSession.storageKey;
              var activeSk = recSk || (Mrow && Mrow.getActiveStorageKey && Mrow.getActiveStorageKey());
              var isBusy = !!(Mrow && Mrow.isBusyRecordingOrStarting && Mrow.isBusyRecordingOrStarting());
              var annotated = userMeetingItems.map(function (n, i) {
                var isLiveRow = !!(isBusy && n.storageKey && activeSk && n.storageKey === activeSk);
                return { n: n, i: i, isLiveRow: isLiveRow };
              });
              annotated.sort(function (a, b) {
                if (a.isLiveRow !== b.isLiveRow) return a.isLiveRow ? -1 : 1;
                var ta = Number(a.n.loggedAt) || 0;
                var tb = Number(b.n.loggedAt) || 0;
                if (ta !== tb) return tb - ta;
                return a.i - b.i;
              });
              return annotated;
            })().map(function (entry: any) {
              var n = entry.n;
              var i = entry.i;
              var isLiveRow = entry.isLiveRow;
              var rowTag = isLiveRow ? 'LIVE' : (n.tag || 'LOCAL');
              return (
                <div key={n.storageKey || n.loggedAt || i} role="button" tabIndex={0} className="mtg-row" onClick={function () { openMeetingNote(n, n.dateCtx || 'today-user'); }} onKeyDown={function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeetingNote(n, n.dateCtx || 'today-user'); } }}>
                  <div className="mtg-icon">
                    <Icon name="mic" size={14}/>
                  </div>
                  <div className="mtg-body">
                    <div className="row" style={{gap:8}}>
                      <span className="mtg-title">{n.t}</span>
                      <span
                        className="mtg-tag"
                        style={{
                          color: tagColor(rowTag),
                          borderColor: 'color-mix(in srgb, ' + tagColor(rowTag) + ' 30%, var(--border))',
                          animation: isLiveRow ? ('shogun-rec-pulse 1.35s ease-in-out infinite' as any) : undefined,
                        }}
                      >
                        {rowTag}
                      </span>
                      <MtgProgressDots storageKey={rowStorageKey(n, n.dateCtx || 'today-user')} listVersion={listTick}/>
                    </div>
                    <div className="row" style={{gap:10, marginTop:3}}>
                      <span className="mtg-meta">{n.a}</span>
                      {n.duration && <span className="mtg-meta"><Icon name="clock" size={10}/>{n.duration}</span>}
                    </div>
                  </div>
                  <div className="mtg-right">
                    <span className="t-mono mtg-time">{n.time}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Footer */}
      <div style={{marginTop:48, padding:'18px 0', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, color:'var(--text-dim)'}}>
        <Kamon size={14} color="var(--gold)"/>
        <span className="t-mono" style={{fontSize:10}}>
          {userMeetingItems.length} IN YOUR LOG · LOCAL
        </span>
        <span className="spacer"/>
        <span className="jp" style={{fontSize:11}}>一期一会</span>
        <span style={{fontSize:11, fontStyle:'italic'}}>One meeting, one encounter</span>
      </div>

        </div>
      </div>

      {!granola && (
      <MtgChatDock
        meetingsPrompt={meetingsPrompt}
        setMeetingsPrompt={setMeetingsPrompt}
        meetingsRecipeBrowse={meetingsRecipeBrowse}
        setMeetingsRecipeBrowse={setMeetingsRecipeBrowse}
        showDockRecipeOverlay={showDockRecipeOverlay}
        filteredDockSlash={filteredDockSlash}
        allowServerMemoryAssembly={allowServerMemoryAssembly}
        submitMeetingsPrompt={submitMeetingsPrompt}
        runDockSlashItem={runDockSlashItem}
        runRuntimeActionM={runRuntimeActionM}
      />
      )}
      {/* Granola — scoped to main column only (sidebar + topbar stay visible) */}
      <GranolaOverlay
        granola={granola}
        closeGranola={closeGranola}
        granolaPane={granolaPane}
        setGranolaPane={setGranolaPane}
        granolaDraft={granolaDraft}
        setGranolaDraft={setGranolaDraft}
        granolaMenuOpen={granolaMenuOpen}
        setGranolaMenuOpen={setGranolaMenuOpen}
        granolaOutline={granolaOutline}
        setGranolaOutline={setGranolaOutline}
        granolaAsk={granolaAsk}
        setGranolaAsk={setGranolaAsk}
        granolaTodos={granolaTodos}
        setGranolaTodos={setGranolaTodos}
        granolaEnhanceMenuOpen={granolaEnhanceMenuOpen}
        setGranolaEnhanceMenuOpen={setGranolaEnhanceMenuOpen}
        granolaAttendees={granolaAttendees}
        granolaAttendeesQuery={granolaAttendeesQuery}
        setGranolaAttendeesQuery={setGranolaAttendeesQuery}
        granolaFolder={granolaFolder}
        granolaFolderQuery={granolaFolderQuery}
        setGranolaFolderQuery={setGranolaFolderQuery}
        granolaFolderList={granolaFolderList}
        granolaPillMenu={granolaPillMenu}
        cmdBarMin={cmdBarMin}
        setCmdBarMin={setCmdBarMin}
        postRecBarActive={postRecBarActive}
        postRecWaveMenuOpen={postRecWaveMenuOpen}
        setPostRecWaveMenuOpen={setPostRecWaveMenuOpen}
        mtgTopShareOpen={mtgTopShareOpen}
        setMtgTopShareOpen={setMtgTopShareOpen}
        mtgEnhanceBusy={mtgEnhanceBusy}
        mtgLinkAccess={mtgLinkAccess}
        setMtgLinkAccess={setMtgLinkAccess}
        mtgShareSearch={mtgShareSearch}
        setMtgShareSearch={setMtgShareSearch}
        mtgShareOwner={mtgShareOwner}
        mtgLinkBusy={mtgLinkBusy}
        mtgLinkAccessMenuOpen={mtgLinkAccessMenuOpen}
        setMtgLinkAccessMenuOpen={setMtgLinkAccessMenuOpen}
        audioRecSession={audioRecSession}
        closeGranolaPillMenu={closeGranolaPillMenu}
        addFolderTag={addFolderTag}
        addCalendarEvent={addCalendarEvent}
        showGranolaDateInfo={showGranolaDateInfo}
        showGranolaAuthorInfo={showGranolaAuthorInfo}
        granolaDateFull={granolaDateFull}
        toggleAttendee={toggleAttendee}
        pickFolder={pickFolder}
        addNewFolder={addNewFolder}
        applyStubTranscript={applyStubTranscript}
        refreshSummary={refreshSummary}
        refreshMinutes={refreshMinutes}
        runMtgEnhance={runMtgEnhance}
        ingestNoteToMemory={ingestNoteToMemory}
        copyMtgShareLink={copyMtgShareLink}
        mtgDraftEmail={mtgDraftEmail}
        mtgCopyAllText={mtgCopyAllText}
        moveGranolaToTrash={moveGranolaToTrash}
        runLocalAsk={runLocalAsk}
        listLocalTodos={listLocalTodos}
        startNoteRecording={startNoteRecording}
        stopNoteRecording={stopNoteRecording}
        showPermissionBanner={showPermissionBanner}
        recordingWithoutRemote={!!(backendRecActive && !systemAudioRunning && screenCaptureGranted === false)}
        permissionActionBusy={permissionActionBusy}
        onOpenScreenCaptureSettings={openMeetingScreenCaptureSettings}
        onRequestScreenCaptureAccess={requestMeetingScreenCaptureAccess}
        onMicOnlyRecording={startMicOnlyRecording}
        injectRecipeIntoMemo={injectRecipeIntoMemo}
        runPostRecSlashItem={runPostRecSlashItem}
        runRuntimeActionM={runRuntimeActionM}
      />


      {/* Scoped styles */}
      <style>{`
        @keyframes shogun-rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        .mtg-row {
          display:flex; align-items:center; gap:14px;
          padding:14px 14px; border-radius:var(--radius-md);
          cursor:pointer; transition:background var(--dur-base) var(--ease-out);
          border:1px solid transparent;
        }
        .mtg-row:hover {
          background:var(--surface);
          border-color:var(--border);
        }
        .mtg-row:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
        .mtg-icon {
          width:32px; height:32px; flex-shrink:0;
          display:flex; align-items:center; justify-content:center;
          background:var(--surface-2); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          color:var(--text-mute);
        }
        .mtg-row:hover .mtg-icon { color:var(--gold); border-color:var(--gold-dim); }
        .mtg-body { flex:1; min-width:0; }
        .mtg-title {
          font-size:14px; color:var(--text); font-weight:500;
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .mtg-tag {
          font-family:var(--font-mono); font-size:9px; letter-spacing:0.1em;
          padding:2px 6px; border:1px solid var(--border); border-radius:3px;
          flex-shrink:0;
        }
        .mtg-meta {
          font-size:11px; color:var(--text-dim);
          display:inline-flex; align-items:center; gap:4px;
        }
        .mtg-right {
          display:flex; align-items:center; gap:10px;
          flex-shrink:0;
        }
        .mtg-time {
          font-size:11px; color:var(--text-mute);
          min-width:40px; text-align:right;
        }
        @media (max-width: 720px) {
          .mtg-quick-note { right: 16px !important; top: 16px !important; }
        }
      `}</style>

      <MeetingDetailModal meetingDetail={meetingDetail} setMeetingDetail={setMeetingDetail} />
    </div>
  );
}
