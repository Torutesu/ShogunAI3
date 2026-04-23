/* global Icon, Kamon, IntegrationLogo, React, MeetingNoteLocal */

function runRuntimeActionM(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

function mnl() {
  return window.MeetingNoteLocal || null;
}

function toastM(message, kind) {
  if (window.SHOGUN_RUNTIME && typeof window.SHOGUN_RUNTIME.pushToast === 'function') {
    window.SHOGUN_RUNTIME.pushToast(message, kind || 'info');
  }
}

function briefPayloadWithUserTz(base) {
  var b = base && typeof base === 'object' ? base : {};
  var tz = '';
  if (window.ShogunUserTimezone && typeof window.ShogunUserTimezone.getTimeZone === 'function') {
    tz = window.ShogunUserTimezone.getTimeZone();
  }
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (_e) {}
  }
  return tz ? Object.assign({}, b, { user_tz: tz }) : b;
}

const RECIPE_LOCAL_BODIES = {
  'Write weekly recap': '## \u9031\u5831\n\n### \u4eca\u9031\u306e\u30cf\u30a4\u30e9\u30a4\u30c8\n- \n\n### \u6765\u9031\u306e\u30d5\u30a9\u30fc\u30ab\u30b9\n- \n\n### \u30ea\u30b9\u30af\n- \n',
  'Coach me: Matt 1:1': '## 1:1 \u30b3\u30fc\u30c1\u30f3\u30b0\n\n### \u524d\u56de\u304b\u3089\u306e\u30d5\u30a9\u30ed\u30fc\n- \n\n### \u4eca\u56de\u306e\u8b70\u984c\n- \n\n### \u30cd\u30af\u30b9\u30c8\u30a2\u30af\u30b7\u30e7\u30f3\n- [ ] \n',
  'List open decisions': '## \u672a\u6c7a\u5b9a\u4e8b\u9805\u30ea\u30b9\u30c8\n\n| \u8b70\u984c | \u72b6\u614b | \u671f\u65e5 |\n|------|------|------|\n| | \u691c\u8a0e\u4e2d | |\n\n### \u6c7a\u5b9a\u6e08\u307f\n- \n',
  'Draft follow-ups': '## \u30d5\u30a9\u30ed\u30fc\u30a2\u30c3\u30d7\n\n- [ ] \n- [ ] \n\n### \u9001\u4fe1\u6e08\u307f\n- \n',
};

var MEETINGS_COMING_UP_STORAGE = 'shogun.hifi.meetingsComingUp.v1';

/** Dock slash menu + "All recipes" browser (labels must match RECIPE_LOCAL_BODIES / Granola recipes). */
var MEETINGS_DOCK_SLASH_CATALOG = [
  { id: 'todos', label: 'List recent todos', desc: 'Surface every unchecked line and TODO marker across notes—in one pass.', jpHint: '\u30ce\u30fc\u30c8\u6a2a\u65ad\u3067\u672a\u5b8c\u4e86\u3092\u96c6\u7d04', kind: 'action', accent: 'mint' },
  { id: 'coach', label: 'Coach me: Matt 1:1', desc: 'Spin up a structured 1:1—agenda, follow-ups, and next actions.', jpHint: '1:1 \u7528\u306e\u30c6\u30f3\u30d7\u3092\u958b\u304f', kind: 'recipe', recipeLabel: 'Coach me: Matt 1:1', recipeJp: '\u5bfe\u8bdd', accent: 'amber' },
  { id: 'weekly', label: 'Write weekly recap', desc: 'Ship a crisp weekly narrative: wins, risks, and what changed.', jpHint: '\u9031\u6b21\u30ec\u30d3\u30e5\u30fc\u306e\u9aa8\u5b50\u3092\u4f5c\u6210', kind: 'recipe', recipeLabel: 'Write weekly recap', recipeJp: '\u9031\u5831', accent: 'violet' },
  { id: 'decisions', label: 'List open decisions', desc: 'Draft a decision log—what is open, who owns it, and by when.', jpHint: '\u672a\u6c7a\u5b9a\u3068\u30aa\u30fc\u30ca\u30fc\u3092\u4e00\u89a7', kind: 'recipe', recipeLabel: 'List open decisions', recipeJp: '\u6c7a\u5b9a', accent: 'rose' },
  { id: 'followups', label: 'Draft follow-ups', desc: 'Turn threads into a send-ready checklist your team can act on.', jpHint: '\u30d5\u30a9\u30ed\u30fc\u7528\u30c1\u30a7\u30c3\u30af\u30ea\u30b9\u30c8', kind: 'recipe', recipeLabel: 'Draft follow-ups', recipeJp: '\u8ffd\u8de1', accent: 'cyan' },
];

function granolaMiniBtn(surface, border, color) {
  return {
    fontSize:12,
    padding:'6px 12px',
    borderRadius:999,
    border:'1px solid ' + border,
    background:surface,
    color:color,
    cursor:'pointer',
    fontFamily:'inherit',
  };
}

function granolaTextareaStyle() {
  return {
    width:'100%',
    minHeight:'min(48vh, 420px)',
    marginTop:14,
    padding:0,
    border:'none',
    outline:'none',
    resize:'vertical',
    background:'transparent',
    color:'var(--text)',
    fontSize:16,
    lineHeight:1.65,
    fontFamily:'inherit',
  };
}

function fmtElapsedMs(ms) {
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return String(m) + ':' + String(sec).padStart(2, '0');
}

/** ノートに録音完了行が入っているか（録音済みMTGとして下部タブを出す） */
function noteHasCompletedRecording(storageKey) {
  var L = mnl();
  if (!L || !storageKey || !L.loadNote) return false;
  var n = L.loadNote(storageKey);
  var t = (n && n.transcript) || '';
  return /\[録音\s[^\]]+\]/.test(t) || t.indexOf('音声ファイル:') !== -1;
}

/** Memo / transcript / summary / minutes completion (4 dots). listVersion bumps parent to refresh. */
function MtgProgressDots({ storageKey, listVersion }) {
  void listVersion;
  var L = typeof window !== 'undefined' ? window.MeetingNoteLocal : null;
  if (!L || !storageKey) return null;
  var saved = L.loadNote ? L.loadNote(storageKey) : null;
  var p = L.noteProgress ? L.noteProgress(saved) : null;
  if (!p || p.pct === 0) return null;
  function dot(on) {
    return (
      <span style={{
        display:'inline-block', width:6, height:6, borderRadius:999,
        background: on ? 'var(--gold)' : 'var(--border)',
        opacity: on ? 1 : 0.35,
      }}/>
    );
  }
  return (
    <span className="row" style={{gap:3, marginLeft:6}} title={p.pct + '%'}>
      {dot(p.memo)}{dot(p.transcript)}{dot(p.summary)}{dot(p.minutes)}
    </span>
  );
}

// ===========================================================================
// MEETINGS — synthesis layer for calendar events + conversations
// ===========================================================================
function ScreenMeetings() {
  const { useState, useEffect, useCallback, useRef, useMemo } = React;
  const [granola, setGranola] = useState(null);
  const [granolaPane, setGranolaPane] = useState('memo');
  const [granolaDraft, setGranolaDraft] = useState({ body:'', transcript:'', summary:'', minutes:'' });
  const [granolaMenuOpen, setGranolaMenuOpen] = useState(false);
  const [cmdBarMin, setCmdBarMin] = useState(false);
  const [granolaOutline, setGranolaOutline] = useState(false);
  const [granolaAsk, setGranolaAsk] = useState('');
  const [granolaTodos, setGranolaTodos] = useState(null);
  const [granolaEnhanceMenuOpen, setGranolaEnhanceMenuOpen] = useState(false);
  const granolaRef = useRef(null);
  const granolaDraftRef = useRef(granolaDraft);
  granolaDraftRef.current = granolaDraft;

  const [userMeetingItems, setUserMeetingItems] = useState([]);
  const [listTick, setListTick] = useState(0);
  const [audioRecSession, setAudioRecSession] = useState(null);
  const [recTick, setRecTick] = useState(0);
  const [comingUp, setComingUp] = useState([]);
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

  granolaRef.current = granola;

  const postRecBarActive = !!(granola && granola.storageKey && !audioRecSession && (postRecSessionFlag || noteHasCompletedRecording(granola.storageKey)));

  useEffect(function () {
    function onEnded() {
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
    runRuntimeActionM('settings.load', {}, { silentError: true }).then(function (r) {
      if (cancelled || !r || !r.ok || !r.data || !r.data.settings || !r.data.settings.sections) return;
      var priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    });
    return function () { cancelled = true; };
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

  useEffect(function () {
    setPostRecSessionFlag(false);
    setPostRecWaveMenuOpen(false);
    setMtgTopShareOpen(false);
    setMtgShareSearch('');
    setMtgLinkAccessMenuOpen(false);
    setMtgLinkAccess('anyone');
  }, [granola && granola.storageKey]);

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
      if (!r || !r.ok || !r.data || !Array.isArray(r.data.events) || !r.data.events.length) return;
      var WKD = ['\u65e5', '\u6708', '\u706b', '\u6c34', '\u6728', '\u91d1', '\u571f'];
      var mapped = r.data.events.map(function (ev, idx) {
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

  useEffect(function () {
    function syncRec() {
      var M = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
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
    if (!audioRecSession) return;
    const id = setInterval(function () { setRecTick(function (x) { return x + 1; }); }, 1000);
    return function () { clearInterval(id); };
  }, [audioRecSession]);

  /** Keep MediaRecorder titleRef aligned with the note title (download filename + HUD) while recording. */
  useEffect(function () {
    if (!granola || !granola.storageKey) return;
    var M = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
    if (!M || !M.setActiveTitle || !M.isRecording || !M.isRecording()) return;
    var activeSk = M.getActiveStorageKey && M.getActiveStorageKey();
    if (!activeSk || activeSk !== granola.storageKey) return;
    M.setActiveTitle(granola.title);
  }, [granola && granola.storageKey, granola && granola.title, audioRecSession]);

  useEffect(function () {
    const onAutoMinutes = function (e) {
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

  const openGranolaMinutesForDetectedMeeting = useCallback(function (title, eventId) {
    const L = mnl();
    const key = 'cal-' + String(eventId != null ? eventId : Date.now());
    const storageKey = L ? L.storageHash({ cal: key, t: title }) : key;
    setGranolaPane('minutes');
    setGranolaMenuOpen(false);
    setGranola({
      key,
      storageKey,
      title: title || 'Meeting',
      titleJp: '\u8b70\u4e8b\u9332',
      dateLabel: 'Today',
      dateLabelJp: '\u4eca\u65e5',
      authorLabel: 'Me',
      authorLabelJp: '\u81ea\u5206',
      body: '',
      tag: 'MTG',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    toastM('\u4e88\u5b9a\u304b\u3089\u30df\u30fc\u30c6\u30a3\u30f3\u30b0\u3092\u691c\u77e5\u3057\u307e\u3057\u305f\uff08\u8b70\u4e8b\u9332\uff09', 'success');
  }, []);

  useEffect(function () {
    const onDetected = function (e) {
      if (granolaRef.current) return;
      var d = (e && e.detail) || {};
      if (window.SHOGUN_RUNTIME && typeof window.SHOGUN_RUNTIME.setActiveScreen === 'function') {
        window.SHOGUN_RUNTIME.setActiveScreen('meetings');
      }
      openGranolaMinutesForDetectedMeeting(d.title, d.eventId);
    };
    window.addEventListener('shogun-meeting-detected', onDetected);
    return function () {
      window.removeEventListener('shogun-meeting-detected', onDetected);
    };
  }, [openGranolaMinutesForDetectedMeeting]);

  useEffect(function () {
    if (!comingUp || !comingUp.length) return undefined;
    const check = function () {
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
  }, [comingUp]);

  function rowStorageKey(n, dateCtx, dayJp) {
    const L = mnl();
    if (n && n.storageKey) return n.storageKey;
    return L ? L.storageHash({ t: n.t, time: n.time, ctx: dateCtx, j: dayJp || '' }) : ('mtg-' + n.t + n.time);
  }

  const tagColor = (tag) => ({
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
  }[tag] || 'var(--text-dim)');

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

  const openMeetingNote = useCallback((n, dateCtx, dayJp) => {
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

  const openRecipeGranola = useCallback((recipe) => {
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

  const closeGranola = useCallback(() => {
    const g = granola;
    if (g && g.storageKey && mnl() && mnl().saveNote) {
      const tit = g.title != null ? String(g.title) : '';
      mnl().saveNote(g.storageKey, { ...granolaDraftRef.current, title: tit });
      const L = mnl();
      if (tit.trim() && L.updateMeetingLogTitleByStorageKey) {
        L.updateMeetingLogTitleByStorageKey(g.storageKey, tit);
      }
    }
    var M = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
    if (M && M.isBusyRecordingOrStarting && M.isBusyRecordingOrStarting() && typeof M.abort === 'function') {
      M.abort();
    }
    setGranola(null);
    setGranolaMenuOpen(false);
    setGranolaTodos(null);
    setCmdBarMin(false);
    setListTick(function (x) { return x + 1; });
  }, [granola]);

  const startNoteRecording = useCallback(async function () {
    if (!granola || !granola.storageKey) return;
    var M = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
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
  }, [granola]);

  const stopNoteRecording = useCallback(function () {
    var M = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
    if (M && typeof M.stop === 'function') {
      M.stop();
    } else {
      toastM('録音モジュールが読み込まれていません', 'error');
    }
  }, []);

  useEffect(() => {
    if (!granola || !granola.storageKey) return;
    const L = mnl();
    const saved = L && L.loadNote ? L.loadNote(granola.storageKey) : null;
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
  }, [granola && granola.storageKey, granola && granola.key]);

  useEffect(() => {
    if (!granola || !granola.storageKey) return;
    const L = mnl();
    if (!L || !L.saveNote) return;
    const t = setTimeout(function () {
      L.saveNote(granola.storageKey, granolaDraft);
    }, 450);
    return function () { clearTimeout(t); };
  }, [granola && granola.storageKey, granolaDraft]);

  useEffect(() => {
    if (!granola) return;
    const onKey = (e) => {
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
      granolaDraft.summary && granolaDraft.summary.slice(0, 400),
      granolaDraft.body && granolaDraft.body.slice(0, 300),
    ].filter(Boolean).join('\n---\n').slice(0, 1800);
    void runRuntimeActionM('memory.ingest', {
      title: title + ' · note',
      snippet: snippet || '(empty)',
      source: 'meetings_granola',
      kinds: ['note'],
    }, { successMessage: 'Memory に保存しました' });
  }, [granola, granolaDraft]);

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
      } else {
        toastM('下書きを取得できませんでした', 'warn');
      }
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

  const injectRecipeIntoMemo = useCallback(function (recipeLabel) {
    var block = RECIPE_LOCAL_BODIES[recipeLabel];
    if (!granola || !block) return;
    setGranolaPane('memo');
    setGranolaDraft(function (d) {
      var sep = (d.body || '').trim() ? '\n\n' : '';
      return { ...d, body: (d.body || '') + sep + block };
    });
    toastM('\u30c6\u30f3\u30d7\u3092\u30e1\u30e2\u306b\u633f\u5165\u3057\u307e\u3057\u305f', 'success');
    setPostRecWaveMenuOpen(false);
  }, [granola]);

  const runPostRecSlashItem = useCallback(function (item) {
    setPostRecWaveMenuOpen(false);
    if (item.kind === 'action' && item.id === 'todos') {
      listLocalTodos();
      return;
    }
    if (item.kind === 'recipe' && item.recipeLabel) {
      injectRecipeIntoMemo(item.recipeLabel);
    }
  }, [listLocalTodos, injectRecipeIntoMemo]);

  const addFolderTag = useCallback(() => {
    setGranolaDraft(function (d) {
      const line = '\n\n\u203c\ufe0f \u30d5\u30a9\u30eb\u30c0: \u53d7\u4fe1\u30c8\u30ec\u30a4\uff08\u30ed\u30fc\u30ab\u30eb\u30e1\u30e2\u306e\u307f\uff09';
      return { ...d, body: (d.body || '') + line };
    });
    toastM('\u30e1\u30e2\u306b\u30d5\u30a9\u30eb\u30c0\u30bf\u30b0\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f', 'success');
  }, []);

  const addCalendarEvent = useCallback(function () {
    toastM('\u30ab\u30ec\u30f3\u30c0\u30fc\u30a4\u30d9\u30f3\u30c8\u306e\u30ea\u30f3\u30af\u306f\u8a2d\u5b9a\u304b\u3089\u6709\u52b9\u5316\u3067\u304d\u307e\u3059\uff08\u30e2\u30c3\u30af\uff09', 'info');
  }, []);

  const showGranolaDateInfo = useCallback(function () {
    if (!granola) return;
    try {
      var d = new Date();
      var jp = d.toLocaleDateString('ja-JP', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      var en = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      toastM(en + ' / ' + jp, 'info');
    } catch (_e) {
      toastM(String(granola.dateLabel || 'Today'), 'info');
    }
  }, [granola]);

  const showGranolaAuthorInfo = useCallback(function () {
    if (!granola) return;
    var a = granola.authorLabel || 'Me';
    toastM('\u53c2\u52a0\u8005\u8868\u793a: ' + a + ' \uff08\u30ed\u30fc\u30ab\u30eb\u30ce\u30fc\u30c8\uff09', 'info');
  }, [granola]);

  const submitMeetingsPrompt = useCallback(function (e) {
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

  const runDockSlashItem = useCallback(function (item) {
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
    function onKey(e) {
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
        <div style={{marginTop:8, color:'var(--text-mute)', fontSize:13, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6, flexWrap:'wrap', textAlign:'center'}}>
          <span>Your private meeting notes and recordings</span>
          <span className="jp dim" style={{fontSize:11, marginLeft:4}}>個人</span>
        </div>
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
      <div style={{height:1, background:'var(--border)', marginBottom:28, position:'relative'}}>
        <span style={{position:'absolute', left:'50%', top:-7, transform:'translateX(-50%)', padding:'0 10px', background:'var(--bg)', fontFamily:'var(--font-jp)', fontSize:11, color:'var(--text-dim)'}} className="jp">記録</span>
      </div>

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
            {userMeetingItems.map(function (n, i) {
              var Mrow = typeof window !== 'undefined' ? window.MeetingMediaRecording : null;
              var recSk = audioRecSession && audioRecSession.storageKey;
              var activeSk = recSk || (Mrow && Mrow.getActiveStorageKey && Mrow.getActiveStorageKey());
              var isLiveRow = !!(Mrow && Mrow.isBusyRecordingOrStarting && Mrow.isBusyRecordingOrStarting() && n.storageKey && activeSk && n.storageKey === activeSk);
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
                          animation: isLiveRow ? 'shogun-rec-pulse 1.35s ease-in-out infinite' : undefined,
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
      <div className="screen-meetings-chatdock">
        <div className="screen-meetings-chatdock-inner">
          <div className="mtg-chatdock-panel" tabIndex={-1}>
          {showDockRecipeOverlay && filteredDockSlash.length > 0 && (
            <div className="mtg-recipe-overlay" role="listbox" aria-label="Commands">
              <div className="mtg-recipe-overlay-h">
                <span className="mtg-recipe-overlay-h-main">{meetingsRecipeBrowse ? 'Recipes' : 'Commands'}</span>
                <span className="mtg-recipe-overlay-h-jp jp dim">{meetingsRecipeBrowse ? '\u30ec\u30b7\u30d4' : '\u30b3\u30de\u30f3\u30c9'}</span>
                <span className="mtg-recipe-overlay-h-line" aria-hidden="true"/>
              </div>
              {filteredDockSlash.map(function (row) {
                var acc = row.accent || 'mint';
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    className="mtg-recipe-row"
                    onMouseDown={function (e) { e.preventDefault(); }}
                    onClick={function () { runDockSlashItem(row); }}
                  >
                    <span className={'mtg-recipe-icon mtg-recipe-icon--' + acc}>/</span>
                    <div style={{minWidth:0}}>
                      <div className="mtg-recipe-row-title">{row.label}</div>
                      <div className="mtg-recipe-row-desc">{row.desc}</div>
                      {row.jpHint && <div className="mtg-recipe-row-hint jp">{row.jpHint}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
            <div className="mtg-chatdock-top">
              <div className="mtg-chatdock-chips">
                <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[0]); }}>
                  <Icon name="edit" size={12}/>
                  <span className="en-only">List recent todos</span>
                  <span className="jp" style={{fontSize:10}}>TODO</span>
                </button>
                <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[1]); }}>
                  <Icon name="edit" size={12}/>
                  <span>Coach me Matt</span>
                </button>
                <button type="button" className="mtg-chatdock-chip" onMouseDown={function (e) { e.preventDefault(); }} onClick={function () { runDockSlashItem(MEETINGS_DOCK_SLASH_CATALOG[2]); }}>
                  <Icon name="edit" size={12}/>
                  <span className="en-only">Write weekly recap</span>
                  <span className="jp" style={{fontSize:10}}>週報</span>
                </button>
              </div>
              <button
                type="button"
                className="mtg-chatdock-chip"
                style={{flexShrink:0}}
                onMouseDown={function (e) { e.preventDefault(); }}
                onClick={function () { setMeetingsRecipeBrowse(function (v) { return !v; }); }}
              >
                <Icon name="grid" size={12}/>
                <span className="en-only">All recipes</span>
                <span className="jp" style={{fontSize:10}}>全て</span>
              </button>
            </div>

            <form onSubmit={submitMeetingsPrompt}>
              <div className="mtg-chatdock-inputblock">
                <div className="mtg-chatdock-inputrow">
                  <input
                    type="text"
                    value={meetingsPrompt}
                    onChange={function (e) {
                      var v = e.target.value;
                      setMeetingsPrompt(v);
                      if (v === '/') setMeetingsRecipeBrowse(false);
                    }}
                    onKeyDown={function (e) {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        submitMeetingsPrompt(e);
                      }
                    }}
                    placeholder="Ask anything"
                    aria-label="Ask anything"
                    autoComplete="off"
                    style={{
                      border:'none',
                      outline:'none',
                      background:'transparent',
                      color:'var(--text)',
                      fontSize:14,
                      fontFamily:'inherit',
                    }}
                  />
                  <span
                    className="mtg-chatdock-auto"
                    role="button"
                    tabIndex={0}
                    onMouseDown={function (e) { e.preventDefault(); }}
                    onClick={function () { toastM('Model: Auto', 'info'); }}
                    onKeyDown={function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toastM('Model: Auto', 'info'); } }}
                  >
                    Auto <Icon name="chevronDown" size={10}/>
                  </span>
                  <button type="button" className="btn btn-sm btn-ghost" style={{padding:'0 6px'}} onMouseDown={function (e) { e.preventDefault(); }} onClick={function () {
                    var q = (meetingsPrompt || '').trim();
                    var payload = {
                      source: 'meetings_prompt',
                      action: 'attach',
                      target: 'document',
                      prompt: q || 'Meeting follow-up draft from dock',
                    };
                    if (allowServerMemoryAssembly) {
                      payload.memoryAssembly = {
                        query: q.slice(0, 480),
                        limit: 12,
                        semantic: true,
                      };
                    }
                    runRuntimeActionM('draft.create', payload, { silentError: true }).then(function (r) {
                      if (r && r.ok) toastM('\u4e0b\u66f8\u304d\u3092\u751f\u6210\u3057\u307e\u3057\u305f\uff08\u30e2\u30c3\u30af\uff09', 'success');
                      else toastM((r && r.error && r.error.message) || '\u4e0b\u66f8\u304d\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f', 'warn');
                    });
                  }}><Icon name="paperclip" size={13}/></button>
                  <button
                    type="submit"
                    className="mtg-chatdock-send"
                    disabled={!(meetingsPrompt || '').trim()}
                    title="Send"
                    aria-label="Send"
                  >
                    <Icon name="arrowUp" size={17}/>
                  </button>
                </div>
              </div>
            </form>
            <div className="mtg-chatdock-handle" aria-hidden="true"/>
          </div>
        </div>
      </div>
      )}

      {/* Granola — scoped to main column only (sidebar + topbar stay visible) */}
      {granola && (
        <div
          className="granola-shell"
          style={{ fontFamily:'var(--font-sans, system-ui, sans-serif)' }}
        >
          <button
            type="button"
            className="granola-back-btn"
            onClick={closeGranola}
            aria-label="Close note"
            style={{
              display:'flex',
              alignItems:'center',
              justifyContent:'center',
              width:40,
              height:40,
              borderRadius:999,
              border:'1px solid var(--border-hi)',
              background:'var(--surface)',
              color:'var(--text-mute)',
              cursor:'pointer',
              top: 20,
            }}
          >
            <Icon name="arrowLeft" size={18}/>
          </button>

          <div
            className="granola-float mtg-top-chrome"
            style={{
              top: 18,
              right: 18,
              zIndex: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              maxWidth: 'calc(100% - 88px)',
            }}
          >
            <button
              type="button"
              aria-label="More"
              title="More"
              onClick={function () {
                setGranolaMenuOpen(function (v) { return !v; });
                setMtgTopShareOpen(false);
                setMtgLinkAccessMenuOpen(false);
                setPostRecWaveMenuOpen(false);
              }}
              aria-expanded={granolaMenuOpen}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 999,
                border: '1px solid color-mix(in srgb, var(--border-hi) 85%, transparent)',
                background: 'color-mix(in srgb, var(--surface-2) 90%, var(--bg))',
                color: 'var(--text-mute)',
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <Icon name="more" size={16} />
            </button>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                borderRadius: 999,
                padding: 2,
                gap: 2,
                border: '1px solid color-mix(in srgb, var(--border-hi) 70%, transparent)',
                background: 'color-mix(in srgb, var(--surface-2) 88%, var(--bg))',
              }}
            >
              <button
                type="button"
                aria-label="Section outline"
                title="Outline"
                onClick={function () {
                  setGranolaOutline(function (v) { return !v; });
                  setGranolaMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  border: 'none',
                  background: granolaOutline
                    ? 'color-mix(in srgb, var(--gold) 18%, transparent)'
                    : 'transparent',
                  color: 'var(--text-mute)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="menu" size={15} />
              </button>
              <div style={{ position: 'relative', display: 'inline-flex' }}>
                <button
                  type="button"
                  aria-label="Enhanced notes"
                  title="Enhanced notes"
                  aria-expanded={granolaEnhanceMenuOpen}
                  disabled={mtgEnhanceBusy}
                  onClick={function () {
                    setGranolaEnhanceMenuOpen(function (v) { return !v; });
                    setGranolaMenuOpen(false);
                    setMtgTopShareOpen(false);
                    setMtgLinkAccessMenuOpen(false);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    height: 32,
                    padding: '0 6px 0 8px',
                    borderRadius: 999,
                    border: 'none',
                    background: mtgEnhanceBusy || granolaEnhanceMenuOpen
                      ? 'color-mix(in srgb, var(--gold) 14%, transparent)'
                      : 'transparent',
                    color: 'var(--text-mute)',
                    cursor: mtgEnhanceBusy ? 'wait' : 'pointer',
                  }}
                >
                  {mtgEnhanceBusy ? (
                    <span className="granola-share-spin" />
                  ) : (
                    <Icon name="sparkles" size={15} />
                  )}
                  <Icon name="chevronDown" size={10} />
                </button>
                {granolaEnhanceMenuOpen && (
                  <>
                    <div
                      role="presentation"
                      style={{ position: 'fixed', inset: 0, zIndex: 20 }}
                      onMouseDown={function () { setGranolaEnhanceMenuOpen(false); }}
                    />
                    <div
                      role="menu"
                      aria-label="Enhanced notes"
                      onMouseDown={function (e) { e.stopPropagation(); }}
                      style={{
                        position: 'absolute',
                        top: 'calc(100% + 6px)',
                        right: 0,
                        zIndex: 21,
                        minWidth: 240,
                        padding: 6,
                        borderRadius: 14,
                        border: '1px solid var(--border-hi)',
                        background: 'color-mix(in srgb, var(--surface-2) 96%, var(--bg))',
                        boxShadow: 'var(--shadow-md, 0 10px 30px rgba(0,0,0,0.25))',
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 8px 8px 10px',
                          borderRadius: 10,
                        }}
                      >
                        <Icon name="sparkles" size={15} />
                        <span style={{ flex: 1 }}>
                          <span className="en-only">Enhanced notes</span>
                          <span className="jp">AI強化メモ</span>
                        </span>
                        <button
                          type="button"
                          title="Re-run enhancement"
                          aria-label="Re-run enhancement"
                          disabled={mtgEnhanceBusy}
                          onClick={function () {
                            setGranolaEnhanceMenuOpen(false);
                            void runMtgEnhance();
                          }}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 26,
                            height: 26,
                            borderRadius: 999,
                            border: 'none',
                            background: 'color-mix(in srgb, var(--surface) 60%, transparent)',
                            color: 'var(--text-mute)',
                            cursor: mtgEnhanceBusy ? 'wait' : 'pointer',
                          }}
                        >
                          {mtgEnhanceBusy ? (
                            <span className="granola-share-spin" />
                          ) : (
                            <Icon name="refresh" size={13} />
                          )}
                        </button>
                        <Icon name="check" size={14} />
                      </div>
                      <div style={{ height: 1, margin: '4px 6px', background: 'var(--border)' }} />
                      <div
                        style={{
                          padding: '4px 10px 6px',
                          fontSize: 11,
                          letterSpacing: '0.04em',
                          textTransform: 'uppercase',
                          color: 'var(--text-dim)',
                        }}
                      >
                        <span className="en-only">Templates</span>
                        <span className="jp">テンプレート</span>
                      </div>
                      {[
                        { id: '1to1', en: '1 to 1', jp: '1on1', emoji: '👥' },
                        { id: 'discovery', en: 'Customer: Discovery', jp: '顧客ディスカバリー', emoji: '💵' },
                        { id: 'hiring', en: 'Hiring', jp: '採用', emoji: '💼' },
                        { id: 'standup', en: 'Stand-Up', jp: 'スタンドアップ', emoji: '🧍' },
                        { id: 'weekly', en: 'Weekly Team Meeting', jp: '週次ミーティング', emoji: '📆' },
                      ].map(function (tpl) {
                        return (
                          <button
                            key={tpl.id}
                            type="button"
                            role="menuitem"
                            onClick={function () {
                              setGranolaEnhanceMenuOpen(false);
                              toastM((tpl.en) + ' テンプレートで生成（モック）', 'info');
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              width: '100%',
                              padding: '8px 10px',
                              borderRadius: 10,
                              border: 'none',
                              background: 'transparent',
                              color: 'inherit',
                              cursor: 'pointer',
                              textAlign: 'left',
                              fontFamily: 'inherit',
                              fontSize: 13,
                            }}
                            onMouseEnter={function (e) { e.currentTarget.style.background = 'color-mix(in srgb, var(--surface) 70%, transparent)'; }}
                            onMouseLeave={function (e) { e.currentTarget.style.background = 'transparent'; }}
                          >
                            <span style={{ fontSize: 16, lineHeight: 1 }}>{tpl.emoji}</span>
                            <span className="en-only">{tpl.en}</span>
                            <span className="jp">{tpl.jp}</span>
                          </button>
                        );
                      })}
                      <div style={{ height: 1, margin: '4px 6px', background: 'var(--border)' }} />
                      <button
                        type="button"
                        role="menuitem"
                        onClick={function () {
                          setGranolaEnhanceMenuOpen(false);
                          toastM('テンプレート一覧（モック）', 'info');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 10,
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: 'inherit',
                          fontSize: 13,
                        }}
                      >
                        <Icon name="grid" size={14} />
                        <span className="en-only">All templates…</span>
                        <span className="jp">すべてのテンプレート…</span>
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={function () {
                          setGranolaEnhanceMenuOpen(false);
                          toastM('新規テンプレートの作成（モック）', 'info');
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          width: '100%',
                          padding: '8px 10px',
                          borderRadius: 10,
                          border: 'none',
                          background: 'transparent',
                          color: 'inherit',
                          cursor: 'pointer',
                          textAlign: 'left',
                          fontFamily: 'inherit',
                          fontSize: 13,
                        }}
                      >
                        <Icon name="plus" size={14} />
                        <span className="en-only">New template</span>
                        <span className="jp">新規テンプレート</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
            <div
              style={{
                display: 'inline-flex',
                borderRadius: 999,
                overflow: 'hidden',
                border: '1px solid color-mix(in srgb, #e4e2dc 45%, var(--border))',
              }}
            >
              <button
                type="button"
                onClick={function () {
                  setMtgTopShareOpen(function (v) { return !v; });
                  setGranolaMenuOpen(false);
                  setMtgLinkAccessMenuOpen(false);
                }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 14px',
                  border: 'none',
                  background: '#f3f1ec',
                  color: '#1a1a1a',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Icon name="lock" size={15} />
                <span className="en-only">Share</span>
                <span className="jp" style={{ fontSize: 12 }}>共有</span>
              </button>
              <span
                style={{
                  width: 1,
                  alignSelf: 'stretch',
                  background: 'color-mix(in srgb, #000 12%, transparent)',
                }}
                aria-hidden="true"
              />
              <button
                type="button"
                aria-label="Copy link"
                title="Copy link"
                disabled={mtgLinkBusy}
                onClick={function () { void copyMtgShareLink(); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 44,
                  padding: '8px 0',
                  border: 'none',
                  background: '#f3f1ec',
                  color: '#1a1a1a',
                  cursor: mtgLinkBusy ? 'default' : 'pointer',
                }}
              >
                {mtgLinkBusy ? (
                  <span className="granola-share-spin" />
                ) : (
                  <Icon name="link" size={15} />
                )}
              </button>
            </div>
          </div>

          {mtgTopShareOpen && (
            <div
              className="granola-float mtg-share-panel"
              style={{
                top: 62,
                right: 18,
                width: 'min(360px, calc(100vw - 40px))',
                padding: 14,
                borderRadius: 16,
                background: 'var(--surface)',
                border: '1px solid var(--border-hi)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 11,
              }}
              onMouseDown={function (e) { e.stopPropagation(); }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                <input
                  type="text"
                  value={mtgShareSearch}
                  onChange={function (e) { setMtgShareSearch(e.target.value); }}
                  placeholder="Search people, folders, or emails"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    padding: '10px 12px',
                    borderRadius: 10,
                    border: '1px solid color-mix(in srgb, var(--gold) 35%, var(--border-hi))',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 13,
                    fontFamily: 'inherit',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  disabled={!/\S+@\S+\.\S+/.test(mtgShareSearch)}
                  onClick={function () {
                    toastM('招待の送信はクラウド共有 API 接続後に有効になります（現在はローカル Hi-Fi）', 'info');
                  }}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 10,
                    border: 'none',
                    fontWeight: 500,
                    fontSize: 13,
                    fontFamily: 'inherit',
                    background: /\S+@\S+\.\S+/.test(mtgShareSearch)
                      ? 'color-mix(in srgb, var(--gold) 22%, var(--surface))'
                      : 'var(--surface-2)',
                    color: /\S+@\S+\.\S+/.test(mtgShareSearch) ? 'var(--text)' : 'var(--text-mute)',
                    cursor: /\S+@\S+\.\S+/.test(mtgShareSearch) ? 'pointer' : 'not-allowed',
                    flexShrink: 0,
                  }}
                >
                  <span className="en-only">Share</span>
                  <span className="jp" style={{ fontSize: 12 }}>共有</span>
                </button>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 4px',
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 999,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border-hi)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--text-mute)',
                    flexShrink: 0,
                  }}
                >
                  {(mtgShareOwner.displayName || 'U').trim().charAt(0).toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                    {mtgShareOwner.displayName || granola.authorLabel || 'You'}
                    <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}> (you)</span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-mute)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {mtgShareOwner.email || '—'}
                  </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--text-mute)', flexShrink: 0 }}>Owner</span>
              </div>
              <div style={{ borderTop: '1px solid var(--border-hi)', margin: '10px 0' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ position: 'relative', flex: 1, minWidth: 140 }}>
                  <button
                    type="button"
                    onClick={function () { setMtgLinkAccessMenuOpen(function (v) { return !v; }); }}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 10,
                      border: '1px solid var(--border-hi)',
                      background: 'var(--surface-2)',
                      color: 'var(--text)',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      width: '100%',
                      justifyContent: 'flex-start',
                    }}
                  >
                    <Icon name="globe" size={14} />
                    <span className="en-only" style={{ flex: 1, textAlign: 'left' }}>
                      {mtgLinkAccess === 'anyone' ? 'Anyone with the link' : 'Restricted'}
                    </span>
                    <span className="jp" style={{ fontSize: 11, color: 'var(--text-mute)' }}>
                      {mtgLinkAccess === 'anyone' ? 'リンクを知っている全員' : '制限付き'}
                    </span>
                    <Icon name="chevronDown" size={12} />
                  </button>
                  {mtgLinkAccessMenuOpen && (
                    <div
                      style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        right: 0,
                        marginBottom: 4,
                        padding: 6,
                        borderRadius: 10,
                        background: 'var(--surface)',
                        border: '1px solid var(--border-hi)',
                        boxShadow: 'var(--shadow-lg)',
                        zIndex: 2,
                      }}
                    >
                      <button
                        type="button"
                        onClick={function () {
                          setMtgLinkAccess('anyone');
                          setMtgLinkAccessMenuOpen(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 8px',
                          border: 'none',
                          borderRadius: 8,
                          background: mtgLinkAccess === 'anyone' ? 'var(--surface-2)' : 'transparent',
                          color: 'var(--text)',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Anyone with the link can view
                      </button>
                      <button
                        type="button"
                        onClick={function () {
                          setMtgLinkAccess('restricted');
                          setMtgLinkAccessMenuOpen(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 8px',
                          border: 'none',
                          borderRadius: 8,
                          background: mtgLinkAccess === 'restricted' ? 'var(--surface-2)' : 'transparent',
                          color: 'var(--text)',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        Restricted (signed-in only)
                      </button>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  disabled={mtgLinkBusy}
                  onClick={function () { void copyMtgShareLink(); }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 12px',
                    borderRadius: 10,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: mtgLinkBusy ? 'default' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <Icon name="link" size={14} />
                  <span className="en-only">Copy link</span>
                  <span className="jp" style={{ fontSize: 11 }}>リンクをコピー</span>
                </button>
              </div>
            </div>
          )}

          {granolaOutline && (
            <div className="granola-float" style={{top:100, right:16, display:'flex', flexDirection:'column', gap:6, padding:10, borderRadius:12, background:'var(--surface)', border:'1px solid var(--border-hi)', maxWidth:140}}>
              {['memo','transcript','summary','minutes'].map(function (pid) {
                const labels = { memo:'メモ', transcript:'文字起こし', summary:'要約', minutes:'議事録' };
                return (
                  <button key={pid} type="button" onClick={function () { setGranolaPane(pid); }} style={{fontSize:11, padding:'6px 8px', borderRadius:8, border:'1px solid var(--border-hi)', background:granolaPane===pid?'color-mix(in srgb, var(--gold) 16%, transparent)':'transparent', color:'var(--text)', cursor:'pointer', fontFamily:'inherit'}}>
                    {labels[pid]}
                  </button>
                );
              })}
            </div>
          )}

          {granolaMenuOpen && (
            <div
              className="granola-float mtg-more-menu"
              style={{
                top: 62,
                right: 18,
                left: 'auto',
                bottom: 'auto',
                transform: 'none',
                width: 'min(300px, calc(100vw - 48px))',
                padding: 8,
                borderRadius: 14,
                background: 'var(--surface)',
                border: '1px solid var(--border-hi)',
                boxShadow: 'var(--shadow-lg)',
                zIndex: 12,
              }}
            >
              {[
                {
                  fn: function () {
                    mtgDraftEmail();
                    setGranolaMenuOpen(false);
                  },
                  en: 'Draft email',
                  jp: 'メール下書き',
                  icon: 'mail',
                },
                {
                  fn: function () {
                    mtgCopyAllText();
                    setGranolaMenuOpen(false);
                  },
                  en: 'Copy text',
                  jp: 'テキストをコピー',
                  icon: 'copy',
                },
                {
                  fn: function () {
                    void runRuntimeActionM('integrations.connect', { provider: 'slack' }, { silentError: true });
                    setGranolaMenuOpen(false);
                  },
                  en: 'Connect Slack',
                  jp: 'Slack を接続',
                  logo: 'slack',
                },
              ].map(function (row, idx) {
                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={row.fn}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      textAlign: 'left',
                      padding: '10px 10px',
                      marginBottom: 2,
                      border: 'none',
                      borderRadius: 10,
                      background: 'transparent',
                      color: 'var(--text)',
                      fontSize: 13,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {row.logo ? (
                      <IntegrationLogo slug={row.logo} size={22} title={row.en} />
                    ) : (
                      <Icon name={row.icon} size={16} />
                    )}
                    <span>
                      <span className="en-only">{row.en}</span>
                      <span className="jp" style={{ fontSize: 12, display: 'block', color: 'var(--text-mute)' }}>
                        {row.jp}
                      </span>
                    </span>
                  </button>
                );
              })}
              {[
                { en: 'Send to Zapier', jp: 'Zapier へ', slug: 'zapier_mcp' },
                { en: 'Save to Notion', jp: 'Notion へ', slug: 'notion' },
                { en: 'Save to HubSpot', jp: 'HubSpot へ', slug: null },
              ].map(function (row, idx) {
                return (
                  <div
                    key={'dis-' + idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 10px',
                      marginBottom: 2,
                      borderRadius: 10,
                      opacity: 0.45,
                      pointerEvents: 'none',
                      color: 'var(--text-mute)',
                      fontSize: 13,
                    }}
                  >
                    {row.slug ? (
                      <IntegrationLogo slug={row.slug} size={22} title={row.en} />
                    ) : (
                      <Icon name="plug" size={16} />
                    )}
                    <span>
                      <span className="en-only">{row.en}</span>
                      <span className="jp" style={{ fontSize: 11 }}>{row.jp}</span>
                    </span>
                  </div>
                );
              })}
              <div style={{ borderTop: '1px solid var(--border-hi)', margin: '8px 0 6px' }} />
              <div style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--text-mute)', padding: '0 10px 6px', textTransform: 'uppercase' }}>
                <span className="en-only">Local</span>
                <span className="jp" style={{ marginLeft: 6 }}>ローカル</span>
              </div>
              {[
                { fn: applyStubTranscript, en: 'Insert transcript template', jp: 'テンプレ文字起こし' },
                { fn: refreshSummary, en: 'Refresh summary (rules)', jp: '要約を更新（ルール）' },
                { fn: refreshMinutes, en: 'Build minutes (rules)', jp: '議事録（ルール）' },
                { fn: ingestNoteToMemory, en: 'Save to Memory', jp: 'Memory に保存' },
              ].map(function (row, idx) {
                return (
                  <button
                    key={'loc-' + idx}
                    type="button"
                    onClick={function () { row.fn(); setGranolaMenuOpen(false); }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      marginBottom: 2,
                      border: 'none',
                      borderRadius: 8,
                      background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                      color: 'var(--text-mute)',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    <span className="en-only">{row.en}</span>
                    <span className="jp" style={{ fontSize: 11 }}>{row.jp}</span>
                  </button>
                );
              })}
              <div style={{ borderTop: '1px solid var(--border-hi)', margin: '6px 0' }} />
              <button
                type="button"
                onClick={function () {
                  moveGranolaToTrash();
                  setGranolaMenuOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 10px',
                  border: 'none',
                  borderRadius: 10,
                  background: 'transparent',
                  color: '#c45c3e',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Icon name="trash" size={16} />
                <span className="en-only">Move to trash</span>
                <span className="jp" style={{ fontSize: 12 }}>ゴミ箱へ移動</span>
              </button>
            </div>
          )}

          {granolaTodos !== null && (
            <div className="granola-float" style={{bottom:cmdBarMin?96:(postRecBarActive?128:158), left:'50%', transform:'translateX(-50%)', width:'min(420px, calc(100% - 40px))', maxHeight:200, overflow:'auto', padding:14, borderRadius:14, background:'var(--surface)', border:'1px solid var(--border-hi)'}}>
              <div style={{fontSize:11, color:'var(--text-mute)', marginBottom:8}}>ToDo (\u30ed\u30fc\u30ab\u30eb\u62bd\u51fa)</div>
              {granolaTodos.length === 0 ? (
                <div style={{fontSize:13, color:'var(--text-mute)'}}>\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3067\u3057\u305f\uff08[ ]\u3084 TODO:\u884c\u3092\u8ffd\u52a0\u3057\u3066\u304f\u3060\u3055\u3044\uff09</div>
              ) : (
                <ul style={{margin:0, paddingLeft:18, fontSize:13}}>
                  {granolaTodos.map(function (t, i) { return <li key={i} style={{marginBottom:4}}>{t}</li>; })}
                </ul>
              )}
              <button type="button" onClick={function () { setGranolaTodos(null); }} style={{marginTop:10, fontSize:12, border:'1px solid var(--border-hi)', borderRadius:8, padding:'4px 10px', background:'transparent', color:'var(--text-mute)', cursor:'pointer'}}>Close</button>
            </div>
          )}

          <div style={{flex:1, overflow:'auto', padding:'56px 32px ' + (cmdBarMin ? '100px' : (postRecBarActive ? '160px' : '140px')), maxWidth:720, width:'100%', margin:'0 auto', boxSizing:'border-box'}}>
            <h1 style={{
              margin:0,
              fontSize:32,
              fontWeight:500,
              letterSpacing:'-0.03em',
              lineHeight:1.15,
              fontFamily:'var(--font-serif, Georgia, "Times New Roman", serif)',
              color:'var(--text)',
            }}>
              <span className="en-only">{granola.title}</span>
              {granola.titleJp && <span className="jp">{granola.titleJp}</span>}
            </h1>

            <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:18}}>
              <button type="button" onClick={showGranolaDateInfo} style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)'), cursor:'pointer', font:'inherit', color:'inherit'}} title="Tap for full date">
                <Icon name="calendar" size={13}/>
                <span className="en-only">{granola.dateLabel}</span>
                <span className="jp" style={{fontSize:12}}>{granola.dateLabelJp}</span>
                {granola.time && <span style={{opacity:0.7, marginLeft:4}} className="t-mono">{granola.time}</span>}
              </button>
              <button type="button" onClick={showGranolaAuthorInfo} style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)'), cursor:'pointer', font:'inherit', color:'inherit'}} title="Participant label">
                <Icon name="users" size={13}/>
                <span className="en-only">{granola.authorLabel}</span>
                <span className="jp" style={{fontSize:12}}>{granola.authorLabelJp}</span>
              </button>
              <button type="button" onClick={addFolderTag} style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)'), cursor:'pointer', font:'inherit', color:'inherit'}}>
                <Icon name="folder" size={13}/>
                <span className="en-only">Add to folder</span>
                <span className="jp" style={{fontSize:12}}>フォルダに追加</span>
              </button>
              {granola.tag && (
                <span style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--gold)'), color:'var(--gold)', borderColor:'color-mix(in srgb, var(--gold) 35%, transparent)'}}>
                  {granola.tag}
                </span>
              )}
            </div>

            <div
              role="group"
              aria-label="Calendar event"
              style={{
                marginTop:14,
                display:'flex',
                alignItems:'center',
                gap:14,
                padding:'14px 16px',
                borderRadius:14,
                border:'1px solid var(--border-hi)',
                background:'color-mix(in srgb, var(--surface) 92%, var(--bg))',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  display:'flex',
                  alignItems:'center',
                  justifyContent:'center',
                  width:34,
                  height:34,
                  borderRadius:10,
                  color:'var(--text-mute)',
                  background:'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                  flexShrink:0,
                }}
              >
                <Icon name="calendar" size={16}/>
              </div>
              <div style={{display:'flex', flexDirection:'column', gap:2, minWidth:0, flex:1}}>
                <div style={{fontSize:14, fontWeight:500, color:'var(--text)'}}>
                  <span className="en-only">No calendar event</span>
                  <span className="jp">カレンダーイベントなし</span>
                </div>
                <div className="t-mono" style={{fontSize:12, color:'var(--text-mute)'}}>
                  {granola.dateLabel || 'Today'}
                  {granola.time && <span style={{marginLeft:6}}>· {granola.time}</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={addCalendarEvent}
                title="Link a calendar event"
                aria-label="Link a calendar event"
                style={{
                  display:'inline-flex',
                  alignItems:'center',
                  justifyContent:'center',
                  width:32,
                  height:32,
                  borderRadius:999,
                  border:'1px solid var(--border-hi)',
                  background:'transparent',
                  color:'var(--text-mute)',
                  cursor:'pointer',
                  flexShrink:0,
                }}
              >
                <Icon name="plus" size={15}/>
              </button>
            </div>

            <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:20, alignItems:'center'}}>
              {[
                { id:'memo', en:'Notes', jp:'メモ' },
                { id:'transcript', en:'Transcript', jp:'文字起こし' },
                { id:'summary', en:'Summary', jp:'要約' },
                { id:'minutes', en:'Minutes', jp:'議事録' },
              ].map(function (t) {
                const on = granolaPane === t.id;
                return (
                  <button key={t.id} type="button" onClick={function () { setGranolaPane(t.id); }} style={{padding:'8px 14px', borderRadius:999, border:'1px solid ' + (on ? 'var(--gold)' : 'var(--border-hi)'), background:on ? 'color-mix(in srgb, var(--gold) 14%, transparent)' : 'transparent', color:on ? 'var(--gold)' : 'var(--text-mute)', cursor:'pointer', fontSize:12, fontFamily:'inherit'}}>
                    <span className="en-only">{t.en}</span>
                    <span className="jp" style={{fontSize:11}}>{t.jp}</span>
                  </button>
                );
              })}
            </div>

            {granolaPane === 'transcript' && (
              <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:12, alignItems:'center'}}>
                <button type="button" onClick={applyStubTranscript} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--text-mute)')}>+ \u30c6\u30f3\u30d7</button>
              </div>
            )}
            {granolaPane === 'summary' && (
              <div style={{marginTop:12}}>
                <button type="button" onClick={refreshSummary} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--gold)')}>\u8981\u7d04\u3092\u66f4\u65b0\uff08\u30eb\u30fc\u30eb\uff09</button>
              </div>
            )}
            {granolaPane === 'minutes' && (
              <div style={{marginTop:12}}>
                <button type="button" onClick={refreshMinutes} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--gold)')}>\u8b70\u4e8b\u9332\u3092\u751f\u6210</button>
              </div>
            )}

            {granolaPane === 'memo' && (
              <textarea
                value={granolaDraft.body}
                onChange={function (e) { setGranolaDraft(function (d) { return { ...d, body: e.target.value }; }); }}
                placeholder="Write your notes here… メモをここに入力…"
                className="granola-body granola-pane"
                style={granolaTextareaStyle()}
              />
            )}
            {granolaPane === 'transcript' && (
              <textarea
                value={granolaDraft.transcript}
                onChange={function (e) { setGranolaDraft(function (d) { return { ...d, transcript: e.target.value }; }); }}
                placeholder="Transcript (paste or type locally)… \u8cbc\u308a\u4ed8\u3051\u307e\u305f\u306f\u5165\u529b\u2026"
                className="granola-body granola-pane"
                style={granolaTextareaStyle()}
              />
            )}
            {granolaPane === 'summary' && (
              <textarea
                value={granolaDraft.summary}
                onChange={function (e) { setGranolaDraft(function (d) { return { ...d, summary: e.target.value }; }); }}
                placeholder="Rule-based summary appears here…"
                className="granola-body granola-pane"
                style={granolaTextareaStyle()}
              />
            )}
            {granolaPane === 'minutes' && (
              <textarea
                value={granolaDraft.minutes}
                onChange={function (e) { setGranolaDraft(function (d) { return { ...d, minutes: e.target.value }; }); }}
                placeholder="Markdown minutes…"
                className="granola-body granola-pane"
                style={granolaTextareaStyle()}
              />
            )}
          </div>

          {!cmdBarMin && postRecBarActive && (
            <div
              className="granola-float"
              style={{
                left:'50%',
                bottom:20,
                transform:'translateX(-50%)',
                width:'min(760px, calc(100% - 28px))',
                zIndex:3,
              }}
            >
              <div style={{position:'relative', width:'100%', display:'flex', alignItems:'flex-end', justifyContent:'flex-start', gap:12, flexWrap:'wrap'}}>
              {postRecWaveMenuOpen && (
                <div
                  style={{
                    position:'absolute',
                    bottom:'100%',
                    left:0,
                    marginBottom:10,
                    width:'min(320px, calc(100vw - 48px))',
                    padding:10,
                    borderRadius:14,
                    background:'var(--surface)',
                    border:'1px solid var(--border-hi)',
                    boxShadow:'var(--shadow-lg)',
                    maxHeight:280,
                    overflow:'auto',
                    zIndex:4,
                  }}
                >
                  {MEETINGS_DOCK_SLASH_CATALOG.map(function (row) {
                    var acc = row.accent || 'mint';
                    return (
                      <button
                        key={row.id}
                        type="button"
                        onClick={function () { runPostRecSlashItem(row); }}
                        style={{
                          display:'flex',
                          alignItems:'flex-start',
                          gap:10,
                          width:'100%',
                          textAlign:'left',
                          padding:'8px 6px',
                          marginBottom:4,
                          border:'none',
                          borderRadius:8,
                          background:'transparent',
                          color:'var(--text)',
                          cursor:'pointer',
                          fontFamily:'inherit',
                          fontSize:13,
                        }}
                      >
                        <span className={'mtg-recipe-icon mtg-recipe-icon--' + acc}>/</span>
                        <div style={{minWidth:0}}>
                          <div style={{fontWeight:500}}>{row.label}</div>
                          {row.jpHint && <div className="jp" style={{fontSize:11, color:'var(--text-mute)'}}>{row.jpHint}</div>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div style={{display:'flex', alignItems:'flex-end', gap:10, flex:1, minWidth:'min(100%, 420px)'}}>
                <button
                  type="button"
                  onClick={function () { setPostRecWaveMenuOpen(function (v) { return !v; }); setGranolaMenuOpen(false); }}
                  aria-expanded={postRecWaveMenuOpen}
                  aria-label="Commands"
                  style={{
                    display:'flex',
                    alignItems:'center',
                    justifyContent:'center',
                    gap:3,
                    width:50,
                    height:50,
                    flexShrink:0,
                    borderRadius:999,
                    border:'1px solid color-mix(in srgb, var(--border-hi) 75%, transparent)',
                    background:'color-mix(in srgb, #141416 88%, var(--surface))',
                    color:'#f0f0f0',
                    cursor:'pointer',
                    boxShadow:'0 6px 28px rgba(0,0,0,0.45)',
                  }}
                >
                  <Icon name="audioBars" size={19}/>
                  <Icon name="chevronUp" size={13}/>
                </button>

                <div
                  style={{
                    position:'relative',
                    flex:1,
                    minWidth:0,
                    borderRadius:999,
                    border:'1px solid color-mix(in srgb, var(--border-hi) 55%, transparent)',
                    background:'color-mix(in srgb, #141416 92%, var(--surface))',
                    boxShadow:'0 6px 32px rgba(0,0,0,0.42)',
                    padding:'11px 14px 15px 16px',
                  }}
                >
                  <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:10, minWidth:0}}>
                    <button
                      type="button"
                      onClick={function () { injectRecipeIntoMemo('Coach me: Matt 1:1'); }}
                      title="Coach template"
                      style={{
                        border:'none',
                        background:'transparent',
                        color:'#fafafa',
                        fontSize:14,
                        fontFamily:'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                        cursor:'pointer',
                        textAlign:'left',
                        flex:1,
                        minWidth:0,
                        overflow:'hidden',
                        textOverflow:'ellipsis',
                        whiteSpace:'nowrap',
                        padding:0,
                      }}
                    >
                      /coach-me-Matt
                    </button>
                    <button
                      type="button"
                      onClick={function () { injectRecipeIntoMemo('Draft follow-ups'); }}
                      style={{
                        display:'inline-flex',
                        alignItems:'center',
                        gap:7,
                        padding:'6px 11px 6px 7px',
                        borderRadius:999,
                        border:'1px solid color-mix(in srgb, var(--border-hi) 45%, transparent)',
                        background:'color-mix(in srgb, #1a1a1f 94%, transparent)',
                        color:'#fafafa',
                        fontSize:12,
                        fontWeight:500,
                        cursor:'pointer',
                        flexShrink:0,
                        fontFamily:'inherit',
                        whiteSpace:'nowrap',
                      }}
                    >
                      <span
                        style={{
                          display:'inline-flex',
                          alignItems:'center',
                          justifyContent:'center',
                          width:22,
                          height:22,
                          borderRadius:6,
                          background:'linear-gradient(135deg, #7ec8ff 0%, #a78bfa 100%)',
                          color:'#fff',
                          lineHeight:0,
                        }}
                      >
                        <Icon name="slash" size={12}/>
                      </span>
                      <span className="en-only">Write follow up email</span>
                      <span className="jp" style={{fontSize:11}}>フォローアップ</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label="Minimize bar"
                    onClick={function () { setCmdBarMin(true); setGranolaMenuOpen(false); setPostRecWaveMenuOpen(false); }}
                    style={{
                      position:'absolute',
                      left:'50%',
                      bottom:5,
                      transform:'translateX(-50%)',
                      width:32,
                      height:5,
                      borderRadius:5,
                      border:'none',
                      padding:0,
                      background:'color-mix(in srgb, var(--text-mute) 42%, transparent)',
                      opacity:0.65,
                      cursor:'pointer',
                    }}
                  />
                </div>
              </div>
              </div>
            </div>
          )}

          {!cmdBarMin && !postRecBarActive && (
          <div className="granola-float"
            style={{
              left:'50%',
              bottom:28,
              transform:'translateX(-50%)',
              width:'min(640px, calc(100% - 48px))',
              display:'flex',
              alignItems:'stretch',
              gap:6,
              padding:6,
              borderRadius:999,
              background:'var(--surface)',
              border:'1px solid var(--border-hi)',
              boxShadow:'var(--shadow-lg)',
            }}
          >
            <div style={{display:'flex', alignItems:'center', gap:4, padding:'0 6px 0 10px'}}>
              <button type="button" style={granolaIconBtn} onClick={function () { setGranolaMenuOpen(function (v) { return !v; }); }} aria-expanded={granolaMenuOpen}><Icon name="more" size={16}/></button>
              <button
                type="button"
                onClick={function () { if (audioRecSession) stopNoteRecording(); else startNoteRecording(); }}
                aria-label={audioRecSession ? 'Stop recording' : 'Start recording'}
                title={audioRecSession ? '録音を終了' : '録音を開始'}
                style={{
                  display:'flex',
                  alignItems:'center',
                  justifyContent:'center',
                  width:40,
                  height:34,
                  borderRadius:10,
                  flexShrink:0,
                  border:'1px solid ' + (audioRecSession
                    ? 'color-mix(in srgb, var(--gold) 50%, var(--border-hi))'
                    : 'color-mix(in srgb, var(--gold) 38%, var(--border-hi))'),
                  background: audioRecSession
                    ? 'color-mix(in srgb, var(--gold) 26%, var(--surface))'
                    : 'color-mix(in srgb, var(--gold) 14%, var(--surface))',
                  color:'var(--gold)',
                  cursor:'pointer',
                  boxShadow: audioRecSession ? '0 0 0 1px color-mix(in srgb, var(--gold) 20%, transparent)' : 'none',
                  animation: audioRecSession ? 'shogun-rec-pulse 1.35s ease-in-out infinite' : undefined,
                }}
              >
                <Icon name={audioRecSession ? 'stop' : 'play'} size={audioRecSession ? 15 : 16}/>
              </button>
              <button type="button" style={granolaIconBtn} onClick={function () { setCmdBarMin(true); setGranolaMenuOpen(false); }} aria-label="Minimize bar"><Icon name="chevronUp" size={16}/></button>
              <button type="button" style={granolaIconBtn} onClick={function () { setGranolaOutline(function (v) { return !v; }); }} aria-label="Section outline" title="セクション一覧"><Icon name="grid" size={15}/></button>
            </div>
            <input
              type="text"
              placeholder="Search in this note (local)"
              className="granola-ask"
              value={granolaAsk}
              onChange={function (e) { setGranolaAsk(e.target.value); }}
              style={{
                flex:1,
                minWidth:0,
                border:'none',
                borderRadius:999,
                padding:'10px 16px',
                fontSize:14,
                background:'var(--surface-2)',
                color:'var(--text)',
                outline:'none',
              }}
              onKeyDown={function (e) { if (e.key === 'Enter') { e.preventDefault(); runLocalAsk(); } }}
            />
            <button
              type="button"
              onClick={listLocalTodos}
              style={{
                display:'inline-flex',
                alignItems:'center',
                gap:8,
                padding:'8px 14px',
                borderRadius:999,
                border:'1px solid var(--border-hi)',
                background:'color-mix(in srgb, var(--surface-2) 85%, transparent)',
                color:'var(--text)',
                fontSize:13,
                fontWeight:500,
                cursor:'pointer',
                whiteSpace:'nowrap',
                fontFamily:'inherit',
              }}
            >
              <span style={{color:'var(--gold)', display:'inline-flex', lineHeight:0}}><Icon name="note" size={15}/></span>
              <span className="en-only">List recent todos</span>
              <span className="jp" style={{fontSize:12}}>直近のToDo</span>
            </button>
          </div>
          )}
          {cmdBarMin && postRecBarActive && !audioRecSession && (
            <div className="granola-float" style={{left:'50%', bottom:28, transform:'translateX(-50%)', display:'flex', alignItems:'center', gap:10}}>
              <button
                type="button"
                onClick={function () { setCmdBarMin(false); setPostRecWaveMenuOpen(false); }}
                style={{
                  display:'flex',
                  alignItems:'center',
                  justifyContent:'center',
                  gap:3,
                  width:46,
                  height:46,
                  flexShrink:0,
                  borderRadius:999,
                  border:'1px solid color-mix(in srgb, var(--border-hi) 70%, transparent)',
                  background:'color-mix(in srgb, #141416 88%, var(--surface))',
                  color:'#f0f0f0',
                  cursor:'pointer',
                  boxShadow:'0 4px 20px rgba(0,0,0,0.35)',
                }}
              >
                <Icon name="audioBars" size={18}/>
                <Icon name="chevronDown" size={12}/>
              </button>
              <button
                type="button"
                onClick={function () { setCmdBarMin(false); }}
                style={{
                  display:'flex',
                  alignItems:'center',
                  gap:8,
                  padding:'10px 18px',
                  borderRadius:999,
                  border:'1px solid var(--border-hi)',
                  background:'color-mix(in srgb, #141416 75%, var(--surface))',
                  color:'var(--text-mute)',
                  cursor:'pointer',
                  fontFamily:'inherit',
                  fontSize:13,
                }}
              >
                <Icon name="chevronDown" size={16}/>
                <span className="en-only">Meeting tab</span>
                <span className="jp" style={{fontSize:12}}>ミーティングタブ</span>
              </button>
            </div>
          )}
          {cmdBarMin && (!postRecBarActive || audioRecSession) && (
            <div className="granola-float" style={{left:'50%', bottom:28, transform:'translateX(-50%)', display:'flex', alignItems:'center', gap:8}}>
              {audioRecSession && (
                <button
                  type="button"
                  onClick={function (e) { e.preventDefault(); stopNoteRecording(); }}
                  aria-label="Stop recording"
                  title="録音を終了"
                  style={{
                    display:'flex',
                    alignItems:'center',
                    justifyContent:'center',
                    width:44,
                    height:44,
                    borderRadius:999,
                    border:'1px solid color-mix(in srgb, var(--gold) 45%, var(--border-hi))',
                    background:'color-mix(in srgb, var(--gold) 22%, var(--surface))',
                    color:'var(--gold)',
                    cursor:'pointer',
                    flexShrink:0,
                  }}
                >
                  <Icon name="stop" size={16}/>
                </button>
              )}
              <button type="button" onClick={function () { setCmdBarMin(false); }} style={{display:'flex', alignItems:'center', gap:8, padding:'10px 18px', borderRadius:999, border:'1px solid var(--border-hi)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', fontFamily:'inherit'}}>
                <Icon name="chevronDown" size={16}/> Command bar
              </button>
            </div>
          )}

          <style>{`
            .granola-pane::placeholder { color: var(--text-mute); opacity: 1; }
            .granola-ask::placeholder { color: var(--text-mute); }
            @keyframes granola-share-spin { to { transform: rotate(360deg); } }
            .granola-share-spin {
              width: 14px;
              height: 14px;
              border: 2px solid #c0c0c0;
              border-top-color: var(--gold);
              border-radius: 50%;
              animation: granola-share-spin 0.7s linear infinite;
              flex-shrink: 0;
              display: inline-block;
              vertical-align: middle;
              box-sizing: border-box;
            }
          `}</style>
        </div>
      )}

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
    </div>
  );
}

function granolaPillStyle(bg, border, color) {
  return {
    display:'inline-flex',
    alignItems:'center',
    gap:6,
    padding:'6px 12px',
    borderRadius:999,
    border:`1px solid ${border}`,
    background:bg,
    fontSize:12,
    color,
 };
}

const granolaIconBtn = {
  display:'flex',
  alignItems:'center',
  justifyContent:'center',
  width:34,
  height:34,
  borderRadius:999,
  border:'none',
  background:'transparent',
  color:'var(--text-mute)',
  cursor:'pointer',
};

window.ScreenMeetings = ScreenMeetings;
