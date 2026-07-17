import React from 'react';

import { MeetingMediaRecording } from '@/shared/lib/meeting-media-recording';
import { takePendingMeetingDetect } from '@/shared/lib/meeting-detect-events';
import { Icon, Kamon } from '@/shared/icons';
import { MtgProgressDots } from './components/MtgProgressDots';
import { GranolaOverlay } from './components/GranolaOverlay';
import { MtgChatDock } from './components/MtgChatDock';
import { MeetingDetailModal } from './components/MeetingDetailModal';
import { useMeetingsCalendar } from './hooks/useMeetingsCalendar';
import { useGranolaPillUi } from './hooks/useGranolaPillUi';
import { useMeetingsBackendRecording } from './hooks/useMeetingsBackendRecording';
import { useMeetingsScreenPrefs } from './hooks/useMeetingsScreenPrefs';
import { useMeetingsShareControls } from './hooks/useMeetingsShareControls';
import { useGranolaNoteActions } from './hooks/useGranolaNoteActions';
import { GranolaOverlayProvider } from './context/GranolaOverlayContext';
import type { GranolaOverlayContextValue } from './context/GranolaOverlayContext';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { t } from '@/shared/lib/i18n';
import {
  mnl,
  toastM,
  briefPayloadWithUserTz,
  RECIPE_LOCAL_BODIES,
  MEETINGS_DOCK_SLASH_CATALOG,
  noteHasCompletedRecording,
  isNativeDesktop,
} from './lib/runtime';

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
  const comingUp = useMeetingsCalendar();
  const granolaPillUi = useGranolaPillUi();
  const { allowServerMemoryAssembly, autoStartOnCalendar, autoStartOnCalendarRef } = useMeetingsScreenPrefs();
  const [meetingsPrompt, setMeetingsPrompt] = useState('');
  const [meetingsRecipeBrowse, setMeetingsRecipeBrowse] = useState(false);
  const [postRecSessionFlag, setPostRecSessionFlag] = useState(false);
  const [postRecWaveMenuOpen, setPostRecWaveMenuOpen] = useState(false);
  const [mtgEnhanceBusy, setMtgEnhanceBusy] = useState(false);
  const pendingAutoRecordRef = useRef(false);
  const linkClientNoteToStorageRef = useRef<(meetingId: any, storageKey: any) => Promise<any>>(async (id) => id);

  granolaRef.current = granola;

  const linkClientNoteToStorage = useCallback(async function (meetingId: any, storageKey: any) {
    if (!meetingId || !storageKey || !isNativeDesktop()) return meetingId;
    const L = mnl();
    if (L && L.linkBackendMeetingId) {
      L.linkBackendMeetingId(storageKey, meetingId);
    }
    const r = await runRuntimeAction(
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

  linkClientNoteToStorageRef.current = linkClientNoteToStorage;

  const {
    mtgTopShareOpen,
    setMtgTopShareOpen,
    mtgLinkAccess,
    setMtgLinkAccess,
    mtgShareSearch,
    setMtgShareSearch,
    mtgShareOwner,
    mtgLinkBusy,
    mtgLinkAccessMenuOpen,
    setMtgLinkAccessMenuOpen,
    copyMtgShareLink,
  } = useMeetingsShareControls({ granola, granolaDraft, granolaRef });

  const {
    audioRecSession,
    backendRecActive,
    systemAudioRunning,
    contextTimelineItems,
    contextTimelineLoading,
    permissionActionBusy,
    screenCaptureGranted,
    showPermissionBanner,
    finalizeBackendMeeting,
    startNoteRecording,
    stopNoteRecording,
    startMicOnlyRecording,
    openMeetingScreenCaptureSettings,
    requestMeetingScreenCaptureAccess,
    startBackendRecordingRef,
    startNoteRecordingRef,
    setBackendRecActive,
    setSystemAudioRunning,
  } = useMeetingsBackendRecording({
    granola,
    granolaRef,
    setGranolaDraft,
    setGranolaPane,
    setPostRecSessionFlag,
    setListTick,
    linkClientNoteToStorage: (mid, sk) => linkClientNoteToStorageRef.current(mid, sk),
  });

  const postRecBarActive = !!(granola && granola.storageKey && !audioRecSession && (postRecSessionFlag || noteHasCompletedRecording(granola.storageKey)));

  const granolaStorageKey = granola && granola.storageKey;
  useEffect(function () {
    setPostRecSessionFlag(false);
    setPostRecWaveMenuOpen(false);
  }, [granolaStorageKey]);

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
      runRuntimeAction('meetings.list', { limit: 50 }, { silentError: true }).then(function (r) {
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
      toastM(t('Video meeting detected — opened a meeting note', 'ビデオ会議を検知—会議ノートを開きました'), 'success');
    } else {
      toastM(t('Meeting detected from your calendar (minutes)', '予定からミーティングを検知しました（議事録）'), 'success');
    }
  }, [linkClientNoteToStorage]);

  useEffect(function () {
    const onDetected = function (e: any) {
      if (granolaRef.current) return;
      var d = (e && e.detail) || {};
      if ((window as any).SHOGUN_RUNTIME && typeof (window as any).SHOGUN_RUNTIME.setActiveScreen === 'function') {
        (window as any).SHOGUN_RUNTIME.setActiveScreen('meetings');
      }
      if (d.openNotes || d.autoRecord) pendingAutoRecordRef.current = true;
      openGranolaMinutesForDetectedMeeting(d.title, d.eventId, d.meeting_id || null);
    };
    window.addEventListener('shogun-meeting-detected', onDetected);
    return function () {
      window.removeEventListener('shogun-meeting-detected', onDetected);
    };
  }, [openGranolaMinutesForDetectedMeeting]);

  useEffect(function () {
    const pending = takePendingMeetingDetect();
    if (!pending || granolaRef.current) return;
    if ((window as any).SHOGUN_RUNTIME && typeof (window as any).SHOGUN_RUNTIME.setActiveScreen === 'function') {
      (window as any).SHOGUN_RUNTIME.setActiveScreen('meetings');
    }
    pendingAutoRecordRef.current = true;
    openGranolaMinutesForDetectedMeeting(pending.title, pending.eventId, pending.meeting_id || null);
  }, [openGranolaMinutesForDetectedMeeting]);

  useEffect(function () {
    if (!granola || !pendingAutoRecordRef.current) return;
    pendingAutoRecordRef.current = false;
    var cancelled = false;
    (async function () {
      if (cancelled) return;
      if (granola.backendMeetingId && isNativeDesktop()) {
        var statusRes = await runRuntimeAction('meetings.audio.status', {}, { silentError: true });
        if (cancelled) return;
        if (statusRes && statusRes.ok && statusRes.data && statusRes.data.mic_capture_running) {
          setBackendRecActive(true);
          setSystemAudioRunning(!!statusRes.data.system_audio_running);
          setGranolaPane('minutes');
          return;
        }
        await startBackendRecordingRef.current(true);
        return;
      }
      await startNoteRecordingRef.current();
    })();
    return function () {
      cancelled = true;
    };
    // Re-running on granola identity changes is safe: pendingAutoRecordRef is
    // cleared on first run, so later runs bail immediately.
  }, [granola, setBackendRecActive, setSystemAudioRunning, startBackendRecordingRef, startNoteRecordingRef]);

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
  }, [comingUp, autoStartOnCalendar, autoStartOnCalendarRef]);

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
    void runRuntimeAction('brief.get', briefPayloadWithUserTz({ span:'today', recipe: recipe.label, source:'meetings_local_recipe' }), { silentError:true });
    toastM(t('Opened a local template (no bot used)', 'ローカルテンプを開きました（ボット未使用）'), 'success');
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
  }, [granola, finalizeBackendMeeting, setBackendRecActive]);

  const granolaKey = granola && granola.key;
  useEffect(function () {
    if (!granola || !granola.storageKey || !isNativeDesktop()) return undefined;
    var cancelled = false;
    (async function () {
      const L = mnl();
      const saved = L && L.loadNote ? L.loadNote(granola.storageKey) : null;
      var mid = granola.backendMeetingId || (saved && saved.backendMeetingId) || null;
      if (!mid) {
        const r = await runRuntimeAction(
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
        await runRuntimeAction(
          'meetings.link_client_note',
          { meeting_id: mid, storage_key: sk },
          { silentError: true },
        );
      }
    })();
    return function () { cancelled = true; };
  }, [granola]);

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
  }, [granola, granolaStorageKey, granolaDraft]);

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
  }, [
    granola,
    granolaMenuOpen,
    granolaTodos,
    closeGranola,
    mtgTopShareOpen,
    mtgLinkAccessMenuOpen,
    setMtgTopShareOpen,
    setMtgLinkAccessMenuOpen,
  ]);

  const {
    applyStubTranscript,
    refreshSummary,
    refreshMinutes,
    runMtgEnhance,
    ingestNoteToMemory,
    injectRecipeIntoMemo,
    runPostRecSlashItem,
    moveGranolaToTrash,
    mtgDraftEmail,
    mtgCopyAllText,
    runLocalAsk,
    listLocalTodos,
  } = useGranolaNoteActions({
    granola,
    granolaDraft,
    setGranolaDraft,
    setGranolaPane,
    setGranolaTodos,
    setPostRecWaveMenuOpen,
    granolaAsk,
    setMtgTopShareOpen,
    setGranolaMenuOpen,
    setGranola,
    setListTick,
    setMtgEnhanceBusy,
  });


  const submitMeetingsPrompt = useCallback(function (e: any) {
    if (e) e.preventDefault();
    var raw = (meetingsPrompt || '').trim();
    if (!raw) return;
    if (raw.startsWith('/')) {
      var rest = raw.slice(1).trim();
      if (!rest) {
        toastM(t('Pick a command, or type a search term after / and send', 'コマンドを選択するか、/の後に検索語を入力して送信してください'), 'info');
        return;
      }
      raw = rest;
    }
    runRuntimeAction('memory.search', { query: raw, kinds: ['audio', 'note'], limit: 30 }, { successMessage: '\u691c\u7d22\u3057\u307e\u3057\u305f' });
  }, [meetingsPrompt]);

  const listRecentTodosFromDock = useCallback(function () {
    runRuntimeAction('memory.search', { query: 'TODO [ ]', kinds: ['note'], limit: 25 }, { successMessage: 'TODO\u3092\u691c\u7d22\u3057\u307e\u3057\u305f' });
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

  const granolaOverlayValue = useMemo((): GranolaOverlayContextValue => ({
    granola,
    closeGranola,
    granolaPane,
    setGranolaPane,
    granolaDraft,
    setGranolaDraft,
    granolaMenuOpen,
    setGranolaMenuOpen,
    granolaOutline,
    setGranolaOutline,
    granolaAsk,
    setGranolaAsk,
    granolaTodos,
    setGranolaTodos,
    granolaEnhanceMenuOpen,
    setGranolaEnhanceMenuOpen,
    ...granolaPillUi,
    cmdBarMin,
    setCmdBarMin,
    postRecBarActive,
    postRecWaveMenuOpen,
    setPostRecWaveMenuOpen,
    mtgTopShareOpen,
    setMtgTopShareOpen,
    mtgEnhanceBusy,
    mtgLinkAccess,
    setMtgLinkAccess,
    mtgShareSearch,
    setMtgShareSearch,
    mtgShareOwner,
    mtgLinkBusy,
    mtgLinkAccessMenuOpen,
    setMtgLinkAccessMenuOpen,
    audioRecSession,
    applyStubTranscript,
    refreshSummary,
    refreshMinutes,
    runMtgEnhance,
    ingestNoteToMemory,
    copyMtgShareLink,
    mtgDraftEmail,
    mtgCopyAllText,
    moveGranolaToTrash,
    runLocalAsk,
    listLocalTodos,
    startNoteRecording,
    stopNoteRecording,
    showPermissionBanner,
    recordingWithoutRemote: !!(backendRecActive && !systemAudioRunning && screenCaptureGranted === false),
    contextTimelineItems,
    contextTimelineLoading,
    permissionActionBusy,
    onOpenScreenCaptureSettings: openMeetingScreenCaptureSettings,
    onRequestScreenCaptureAccess: requestMeetingScreenCaptureAccess,
    onMicOnlyRecording: startMicOnlyRecording,
    injectRecipeIntoMemo,
    runPostRecSlashItem,
    runRuntimeAction,
  }), [
    granola, closeGranola, granolaPane, granolaDraft, granolaMenuOpen, granolaOutline, granolaAsk,
    granolaTodos, granolaEnhanceMenuOpen, granolaPillUi, cmdBarMin, postRecBarActive, postRecWaveMenuOpen,
    mtgTopShareOpen, mtgEnhanceBusy, mtgLinkAccess, mtgShareSearch, mtgShareOwner, mtgLinkBusy,
    mtgLinkAccessMenuOpen, audioRecSession, applyStubTranscript, refreshSummary, refreshMinutes,
    runMtgEnhance, ingestNoteToMemory, copyMtgShareLink, mtgDraftEmail, mtgCopyAllText, moveGranolaToTrash,
    runLocalAsk, listLocalTodos, startNoteRecording, stopNoteRecording, showPermissionBanner,
    backendRecActive, systemAudioRunning, screenCaptureGranted, contextTimelineItems, contextTimelineLoading,
    permissionActionBusy, openMeetingScreenCaptureSettings, requestMeetingScreenCaptureAccess,
    startMicOnlyRecording, injectRecipeIntoMemo, runPostRecSlashItem,
    setMtgTopShareOpen, setMtgLinkAccess, setMtgLinkAccessMenuOpen, setMtgShareSearch,
  ]);

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
            const pick = await runRuntimeAction('meetings.import.pick', {}, { silentError: true });
            const paths = pick && pick.ok && Array.isArray(pick.data?.paths) ? pick.data.paths : [];
            if (!paths.length) return;
            (window as any).SHOGUN_RUNTIME?.pushToast?.(
              `Importing ${paths.length} recording${paths.length > 1 ? 's' : ''}…`,
              'info',
            );
            let succeeded = 0;
            let failed = 0;
            for (const p of paths) {
              const r = await runRuntimeAction('meetings.import.file', { path: p }, { silentError: true });
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
              const openImportedRecording = function () {
                setMeetingDetail({ meeting: m, segments: null, loading: true, filter: '' });
                runRuntimeAction(
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
              };
              return (
                <div
                  key={m.id}
                  className="card card-interactive"
                  style={{padding:14, display:'flex', gap:14, alignItems:'center', cursor:'pointer'}}
                  onClick={openImportedRecording}
                  role="button"
                  tabIndex={0}
                  onKeyDown={function (e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openImportedRecording();
                    }
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
                      runRuntimeAction('meetings.purge', { meeting_id: m.id }, { silentError: true }).then(function (r) {
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
        runRuntimeAction={runRuntimeAction}
      />
      )}
      <GranolaOverlayProvider value={granolaOverlayValue}>
        <GranolaOverlay />
      </GranolaOverlayProvider>


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
