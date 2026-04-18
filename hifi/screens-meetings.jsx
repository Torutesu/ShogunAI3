/* global Icon, Kamon, React, MeetingNoteLocal */

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

const RECIPE_LOCAL_BODIES = {
  'Write weekly recap': '## \u9031\u5831\n\n### \u4eca\u9031\u306e\u30cf\u30a4\u30e9\u30a4\u30c8\n- \n\n### \u6765\u9031\u306e\u30d5\u30a9\u30fc\u30ab\u30b9\n- \n\n### \u30ea\u30b9\u30af\n- \n',
  'Coach me: Matt 1:1': '## 1:1 \u30b3\u30fc\u30c1\u30f3\u30b0\n\n### \u524d\u56de\u304b\u3089\u306e\u30d5\u30a9\u30ed\u30fc\n- \n\n### \u4eca\u56de\u306e\u8b70\u984c\n- \n\n### \u30cd\u30af\u30b9\u30c8\u30a2\u30af\u30b7\u30e7\u30f3\n- [ ] \n',
  'List open decisions': '## \u672a\u6c7a\u5b9a\u4e8b\u9805\u30ea\u30b9\u30c8\n\n| \u8b70\u984c | \u72b6\u614b | \u671f\u65e5 |\n|------|------|------|\n| | \u691c\u8a0e\u4e2d | |\n\n### \u6c7a\u5b9a\u6e08\u307f\n- \n',
  'Draft follow-ups': '## \u30d5\u30a9\u30ed\u30fc\u30a2\u30c3\u30d7\n\n- [ ] \n- [ ] \n\n### \u9001\u4fe1\u6e08\u307f\n- \n',
};

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
  const { useState, useEffect, useCallback, useRef } = React;
  const [granola, setGranola] = useState(null);
  const [granolaPane, setGranolaPane] = useState('memo');
  const [granolaDraft, setGranolaDraft] = useState({ body:'', transcript:'', summary:'', minutes:'' });
  const [granolaMenuOpen, setGranolaMenuOpen] = useState(false);
  const [cmdBarMin, setCmdBarMin] = useState(false);
  const [granolaOutline, setGranolaOutline] = useState(false);
  const [granolaAsk, setGranolaAsk] = useState('');
  const [granolaTodos, setGranolaTodos] = useState(null);
   const speechRef = useRef(null);
  const granolaDraftRef = useRef(granolaDraft);
  granolaDraftRef.current = granolaDraft;

  const LIVE_SS_KEY = 'shogun.mtg.live.v1';
  const [userMeetingItems, setUserMeetingItems] = useState([]);
  const [liveSession, setLiveSession] = useState(null);
  const [listTick, setListTick] = useState(0);
  const [nowTick, setNowTick] = useState(function () { return Date.now(); });

  useEffect(function () {
    const L = mnl();
    if (L && L.loadUserMeetingLog) {
      const log = L.loadUserMeetingLog();
      setUserMeetingItems(Array.isArray(log.items) ? log.items : []);
    }
    try {
      const raw = sessionStorage.getItem(LIVE_SS_KEY);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && o.storageKey && o.startedAt) setLiveSession(o);
      }
    } catch (_e) {}
  }, []);

  useEffect(function () {
    if (liveSession) sessionStorage.setItem(LIVE_SS_KEY, JSON.stringify(liveSession));
    else sessionStorage.removeItem(LIVE_SS_KEY);
  }, [liveSession]);

  useEffect(function () {
    if (!liveSession) return;
    const id = setInterval(function () { setNowTick(Date.now()); }, 1000);
    return function () { clearInterval(id); };
  }, [liveSession]);

  function rowStorageKey(n, dateCtx, dayJp) {
    const L = mnl();
    if (n && n.storageKey) return n.storageKey;
    return L ? L.storageHash({ t: n.t, time: n.time, ctx: dateCtx, j: dayJp || '' }) : ('mtg-' + n.t + n.time);
  }

  const recipes = [
    {label:'Write weekly recap', jp:'週報'},
    {label:'Coach me: Matt 1:1',  jp:'対話'},
    {label:'List open decisions', jp:'決定'},
    {label:'Draft follow-ups',    jp:'追跡'},
  ];

  const yesterday = [
    {t:'Kitazawa · Aurora DPIA review', a:'Mio Sato, legal counsel', time:'15:18', tag:'DECISION', att:3, locked:true},
    {t:'Nodebank (sample) · user research synthesis', a:'Alex Chen, UX', time:'14:00', tag:'RESEARCH', att:1},
    {t:'Northline Partners · board deck dry-run', a:'Jordan B., Kenta Y.', time:'11:37', tag:'REVIEW', att:5, locked:true},
    {t:'Launch checklist — open questions', a:'solo', time:'10:49', tag:'THINKING'},
    {t:'Vendor MSA · redlines round2', a:'Finance', time:'10:21', tag:'REVIEW', locked:true},
    {t:'Design partner intro — fictive Co.', a:'with Riley Park', time:'09:58', tag:'NETWORK'},
  ];

  const older = [
    {day:'Apr 16', jp:'木', items:[
      {t:'Engineering · Aurora ingestion hardening', a:'Platform team', time:'13:58', tag:'PLAN', att:4},
    ]},
    {day:'Apr 15', jp:'水', items:[
      {t:'Agentic workflows — internal brainstorm', a:'solo · voice memo', time:'09:18', tag:'THINKING', duration:'22min'},
    ]},
    {day:'Apr 14', jp:'火', items:[
      {t:'Staff memo · Kitazawa Q2 priorities', a:'Elena, Mio, Alex', time:'17:00', tag:'DECISION', att:3, locked:true},
    ]},
  ];

  const tagColor = (tag) => ({
    DECISION: 'var(--gold)',
    RESEARCH: 'var(--text)',
    REVIEW:   'var(--text-mute)',
    THINKING: 'var(--text-dim)',
    NETWORK:  'var(--text-mute)',
    PLAN:     'var(--text)',
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
      title: 'New note',
      titleJp: '新しいノート',
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

  const startLiveMeeting = useCallback(function () {
    if (liveSession) {
      toastM('\u3059\u3067\u306b\u4f1a\u8b70\u4e2d\u3067\u3059\u3002\u7d42\u4e86\u3059\u308b\u304b\u3001\u30ce\u30fc\u30c8\u3092\u9589\u3058\u3066\u304f\u3060\u3055\u3044\u3002', 'warn');
      return;
    }
    var startedAt = Date.now();
    var title = 'Live · ' + new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    var L = mnl();
    var key = 'live-' + startedAt;
    var storageKey = L ? L.storageHash({ live: key }) : key;
    var session = { storageKey: storageKey, title: title, startedAt: startedAt };
    setLiveSession(session);
    setGranolaPane('memo');
    setGranolaMenuOpen(false);
    setGranola({
      key: key,
      storageKey: storageKey,
      title: title,
      titleJp: '\u9032\u884c\u4e2d\u306e\u4f1a\u8b70',
      dateLabel: 'Today',
      dateLabelJp: '\u4eca\u65e5',
      authorLabel: 'Me',
      authorLabelJp: '\u81ea\u5206',
      body: '# \u4f1a\u8b70\u30e1\u30e2\n\n- \u958b\u59cb: ' + new Date(startedAt).toLocaleString() + '\n\n',
      tag: 'LIVE',
      time: new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    toastM('\u4f1a\u8b70\u3092\u958b\u59cb\u3057\u307e\u3057\u305f\uff08\u30ed\u30fc\u30ab\u30eb\u30fb\u7d4c\u904e\u6642\u9593\u8868\u793a\uff09', 'success');
  }, [liveSession]);

  const reopenLiveGranola = useCallback(function () {
    if (!liveSession) return;
    setGranolaPane('memo');
    setGranolaMenuOpen(false);
    setGranola({
      key: 'live-' + liveSession.startedAt,
      storageKey: liveSession.storageKey,
      title: liveSession.title,
      titleJp: '\u9032\u884c\u4e2d\u306e\u4f1a\u8b70',
      dateLabel: 'Today',
      dateLabelJp: '\u4eca\u65e5',
      authorLabel: 'Me',
      authorLabelJp: '\u81ea\u5206',
      body: '',
      tag: 'LIVE',
      time: new Date(liveSession.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
  }, [liveSession]);

  const endLiveMeeting = useCallback(function () {
    if (!liveSession) return;
    var ended = Date.now();
    var durationMin = Math.max(1, Math.round((ended - liveSession.startedAt) / 60000));
    var entry = {
      t: liveSession.title,
      a: 'solo · local',
      time: new Date(ended).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      tag: 'LIVE',
      duration: durationMin + 'm',
      storageKey: liveSession.storageKey,
      dateCtx: 'today-user',
    };
    if (mnl() && mnl().prependMeetingLogEntry) mnl().prependMeetingLogEntry(entry);
    setUserMeetingItems(function (prev) { return [entry].concat(prev); });
    setLiveSession(null);
    setListTick(function (x) { return x + 1; });
    toastM('\u7d42\u4e86\u3057\u3001\u4eca\u65e5\u306e\u4e00\u89a7\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f', 'success');
  }, [liveSession]);

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
    void runRuntimeActionM('brief.get', { span:'today', recipe: recipe.label, source:'meetings_local_recipe' }, { silentError:true });
    toastM('\u30ed\u30fc\u30ab\u30eb\u30c6\u30f3\u30d7\u3092\u958b\u304d\u307e\u3057\u305f\uff08\u30dc\u30c3\u30c8\u672a\u4f7f\u7528\uff09', 'success');
  }, []);

  const closeGranola = useCallback(() => {
    const g = granola;
    if (g && g.storageKey && mnl() && mnl().saveNote) {
      mnl().saveNote(g.storageKey, granolaDraftRef.current);
    }
    setGranola(null);
    setGranolaMenuOpen(false);
    setGranolaTodos(null);
    setCmdBarMin(false);
    setListTick(function (x) { return x + 1; });
    if (speechRef.current) {
      try { speechRef.current.stop(); } catch (_e) {}
      speechRef.current = null;
    }
  }, [granola]);

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
        if (granolaMenuOpen) { setGranolaMenuOpen(false); return; }
        if (granolaTodos !== null) { setGranolaTodos(null); return; }
        closeGranola();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [granola, granolaMenuOpen, granolaTodos, closeGranola]);

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

  const toggleSpeech = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      toastM('\u3053\u306e\u74b0\u5883\u3067\u306f\u97f3\u58f0\u5165\u529b\u304c\u4f7f\u3048\u307e\u305b\u3093\uff08Web Speech API\uff09', 'warn');
      return;
    }
    if (speechRef.current) {
      try { speechRef.current.stop(); } catch (_e) {}
      speechRef.current = null;
      toastM('\u97f3\u58f0\u5165\u529b\u3092\u505c\u6b62\u3057\u307e\u3057\u305f', 'info');
      return;
    }
    const rec = new SR();
    rec.lang = document.documentElement.lang === 'ja' ? 'ja-JP' : 'en-US';
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = function (ev) {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (!ev.results[i].isFinal) continue;
        const chunk = ev.results[i][0].transcript.trim();
        if (!chunk) continue;
        setGranolaDraft(function (d) {
          const sep = d.transcript && !d.transcript.endsWith('\n') ? '\n' : '';
          return { ...d, transcript: (d.transcript || '') + sep + chunk };
        });
      }
    };
    rec.onerror = function () { toastM('\u97f3\u58f0\u8a8d\u8b58\u30a8\u30e9\u30fc', 'warn'); };
    rec.start();
    speechRef.current = rec;
    toastM('\u97f3\u58f0\u5165\u529b\u958b\u59cb\uff08\u6587\u5b57\u8d77\u3053\u3057\u30bf\u30d6\u3078\u8ffd\u8a18\uff09', 'success');
  }, []);

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

  const addFolderTag = useCallback(() => {
    setGranolaDraft(function (d) {
      const line = '\n\n\u203c\ufe0f \u30d5\u30a9\u30eb\u30c0: \u53d7\u4fe1\u30c8\u30ec\u30a4\uff08\u30ed\u30fc\u30ab\u30eb\u30e1\u30e2\u306e\u307f\uff09';
      return { ...d, body: (d.body || '') + line };
    });
    toastM('\u30e1\u30e2\u306b\u30d5\u30a9\u30eb\u30c0\u30bf\u30b0\u3092\u8ffd\u52a0\u3057\u307e\u3057\u305f', 'success');
  }, []);

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
          position:'relative',
        }}>
          <Icon name="calendar" size={20} className="gold"/>
          <span style={{position:'absolute', bottom:-2, right:-2, width:16, height:16, borderRadius:'50%', background:'var(--bg)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center'}}>
            <Icon name="shield" size={9}/>
          </span>
        </div>
        <h1 style={{margin:0, width:'100%', textAlign:'center', fontSize:34, fontWeight:600, letterSpacing:'-0.02em', fontFamily:'var(--font-serif, var(--font-en))'}}>
          Meetings <span className="jp" style={{fontSize:22, fontWeight:300, marginLeft:10, color:'var(--text-mute)'}}>会議</span>
        </h1>
        <div style={{marginTop:8, color:'var(--text-mute)', fontSize:13, display:'inline-flex', alignItems:'center', justifyContent:'center', gap:6, flexWrap:'wrap', textAlign:'center'}}>
          <Icon name="shield" size={11}/>
          <span>Your private meeting notes and recordings</span>
          <span className="jp dim" style={{fontSize:11, marginLeft:4}}>個人</span>
        </div>
      </div>

      {/* Live session — local progress you can see without backend */}
      <div style={{
        marginBottom:18,
        padding:'14px 16px',
        borderRadius:'var(--radius-lg)',
        border:'1px solid ' + (liveSession ? 'var(--gold-dim)' : 'var(--border-hi)'),
        background: liveSession ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
      }}>
        {liveSession ? (
          <div className="row" style={{gap:14, flexWrap:'wrap', alignItems:'center'}}>
            <span className="t-mono" style={{color:'var(--gold)', fontWeight:600}}>LIVE</span>
            <span style={{fontSize:20, fontWeight:600, fontVariantNumeric:'tabular-nums'}}>{fmtElapsedMs(nowTick - liveSession.startedAt)}</span>
            <span className="jp dim" style={{fontSize:12}}>Granola で記録中 · ブラウザのみ</span>
            <span className="spacer"/>
            {!granola && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={reopenLiveGranola}>
                <Icon name="note" size={14}/>
                <span className="jp" style={{fontSize:11}}>ノートを開く</span>
              </button>
            )}
            <button type="button" className="btn btn-sm btn-secondary" onClick={endLiveMeeting}>
              <span className="en-only">End · save to Today</span>
              <span className="jp" style={{fontSize:11}}>終了して今日に保存</span>
            </button>
          </div>
        ) : (
          <div className="row" style={{gap:12, flexWrap:'wrap', alignItems:'center'}}>
            <button type="button" className="btn btn-sm btn-primary" onClick={startLiveMeeting}>
              <Icon name="play" size={14}/>
              <span className="en-only">Start meeting</span>
              <span className="jp" style={{fontSize:11}}>会議を開始</span>
            </button>
            <span style={{fontSize:12, color:'var(--text-dim)'}} className="jp">経過時間を表示し、終了時に「今日」の一覧へ追記します（ダミーから進められます）</span>
          </div>
        )}
      </div>

      {/* Prompt area */}
      <div style={{background:'var(--surface)', border:'1px solid var(--border-hi)', borderRadius:'var(--radius-lg)', padding:'14px 18px', marginBottom:18}}>
        <div className="row" style={{marginBottom:10}}>
          <button className="btn btn-sm btn-ghost" style={{padding:'0 8px', height:26, fontSize:11, background:'var(--surface-2)'}} onClick={()=>runRuntimeActionM('memory.search', { query:'meetings', kinds:['audio'], limit:30 }, { successMessage:'Meeting filter updated' })}>
            <Icon name="shield" size={11}/>All meetings <Icon name="chevronDown" size={10}/>
          </button>
          <span className="spacer"/>
        </div>
        <div className="row" style={{gap:10}}>
          <div style={{flex:1, fontSize:14, color:'var(--text-dim)', padding:'6px 0'}}>Ask anything across 142 meetings…</div>
          <span className="t-mono" style={{fontSize:10, color:'var(--text-mute)'}}>AUTO</span>
          <button className="btn btn-sm btn-ghost" style={{padding:'0 6px'}} onClick={function () {
            runRuntimeActionM('draft.create', { source:'meetings_prompt', action:'attach' }, { silentError:true }).then(function (r) {
              if (r && r.ok) toastM('\u4e0b\u66f8\u304d\u3092\u751f\u6210\u3057\u307e\u3057\u305f\uff08\u30e2\u30c3\u30af\uff09', 'success');
              else toastM((r && r.error && r.error.message) || '\u4e0b\u66f8\u304d\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f', 'warn');
            });
          }}><Icon name="paperclip" size={13}/></button>
          <button className="btn btn-sm" style={{padding:'0 10px', background:'var(--gold)', color:'var(--bg)', borderColor:'var(--gold)'}} onClick={function () {
            runRuntimeActionM('schedule.create', { source:'meetings_prompt', action:'record_voice_query' }, { silentError:true }).then(function (r) {
              if (r && r.ok) toastM('\u97f3\u58f0\u30e1\u30e2\u3092\u30ad\u30e5\u30fc\u306b\u8ffd\u52a0\u3057\u307e\u3057\u305f\uff08\u30e2\u30c3\u30af / Tauri\u3067\u306f\u672c\u756a\uff09', 'success');
              else toastM((r && r.error && r.error.message) || '\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u306b\u5931\u6557\u3057\u307e\u3057\u305f', 'warn');
            });
          }}>
            <Icon name="mic" size={13}/>
          </button>
        </div>
      </div>

      {/* Quick recipes */}
      <div className="row" style={{gap:8, marginBottom:40, flexWrap:'wrap'}}>
        {recipes.map((r,i) => (
          <button key={i} className="btn btn-sm btn-ghost" style={{fontSize:11, height:26, padding:'0 10px', borderRadius:999, border:'1px dashed var(--border)', color:'var(--text-mute)'}} onClick={()=>openRecipeGranola(r)}>
            <Icon name="check" size={10}/>
            <span className="en-only">{r.label}</span>
            <span className="jp" style={{fontSize:10, marginLeft:4}}>{r.jp}</span>
          </button>
        ))}
        <span className="spacer"/>
        <button className="btn btn-sm btn-ghost" style={{fontSize:11, height:26, padding:'0 10px', color:'var(--text-mute)'}} onClick={function () {
          runRuntimeActionM('brief.get', { span:'week', source:'meetings_recipes' }, { silentError:true }).then(function (r) {
            if (r && r.ok) toastM('\u30ec\u30b7\u30d4\u30e9\u30a4\u30d6\u30e9\u30ea\u3092\u958b\u304d\u307e\u3057\u305f', 'success');
            else toastM('\u30d6\u30e9\u30a6\u30b6\u30e2\u30c3\u30af: \u4e0a\u306e\u30c1\u30c3\u30d7\u304b\u3089\u30ed\u30fc\u30ab\u30eb\u30c6\u30f3\u30d7\u3092\u958b\u3044\u3066\u304f\u3060\u3055\u3044', 'info');
          });
        }}>
          <Icon name="grid" size={11}/>All recipes
        </button>
      </div>

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
              return (
                <div key={i} role="button" tabIndex={0} className="mtg-row" onClick={function () { openMeetingNote(n, n.dateCtx || 'today-user'); }} onKeyDown={function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMeetingNote(n, n.dateCtx || 'today-user'); } }}>
                  <div className="mtg-icon">
                    <Icon name="mic" size={14}/>
                  </div>
                  <div className="mtg-body">
                    <div className="row" style={{gap:8}}>
                      <span className="mtg-title">{n.t}</span>
                      <span className="mtg-tag" style={{color:'var(--gold)', borderColor:'color-mix(in srgb, var(--gold) 30%, var(--border))'}}>
                        {n.tag || 'LOCAL'}
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

      {/* Yesterday group */}
      <div style={{marginBottom:36}}>
        <div className="row" style={{marginBottom:16, gap:14}}>
          <span className="t-mono" style={{color:'var(--text-mute)'}}>YESTERDAY</span>
          <span className="jp dim" style={{fontSize:11}}>昨日</span>
          <span style={{height:1, flex:1, background:'var(--border)'}}/>
          <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>6 ITEMS · 2H 14M</span>
        </div>
        <div style={{display:'flex', flexDirection:'column', gap:2}}>
          {yesterday.map((n,i) => (
            <div key={i} role="button" tabIndex={0} className="mtg-row" onClick={()=>openMeetingNote(n, 'yesterday')} onKeyDown={(e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); openMeetingNote(n, 'yesterday'); } }}>
              <div className="mtg-icon">
                <Icon name="note" size={14}/>
              </div>
              <div className="mtg-body">
                <div className="row" style={{gap:8}}>
                  <span className="mtg-title">{n.t}</span>
                  <span className="mtg-tag" style={{color: tagColor(n.tag), borderColor: 'color-mix(in srgb, '+tagColor(n.tag)+' 30%, var(--border))'}}>
                    {n.tag}
                  </span>
                  <MtgProgressDots storageKey={rowStorageKey(n, 'yesterday')} listVersion={listTick}/>
                </div>
                <div className="row" style={{gap:10, marginTop:3}}>
                  <span className="mtg-meta">{n.a}</span>
                  {n.att && <span className="mtg-meta"><Icon name="users" size={10}/>{n.att}</span>}
                  {n.duration && <span className="mtg-meta"><Icon name="clock" size={10}/>{n.duration}</span>}
                </div>
              </div>
              <div className="mtg-right">
                {n.locked && <Icon name="shield" size={11} className="dim"/>}
                <span className="t-mono mtg-time">{n.time}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Older groups */}
      {older.map((g,gi) => (
        <div key={gi} style={{marginBottom:28}}>
          <div className="row" style={{marginBottom:14, gap:14}}>
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{g.day.toUpperCase()}</span>
            <span className="jp dim" style={{fontSize:11}}>{g.jp}</span>
            <span style={{height:1, flex:1, background:'var(--border)'}}/>
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:2}}>
            {g.items.map((n,i) => (
              <div key={i} role="button" tabIndex={0} className="mtg-row" onClick={()=>openMeetingNote(n, g.day, g.jp)} onKeyDown={(e)=>{ if(e.key==='Enter'||e.key===' ') { e.preventDefault(); openMeetingNote(n, g.day, g.jp); } }}>
                <div className="mtg-icon">
                  <Icon name="note" size={14}/>
                </div>
                <div className="mtg-body">
                  <div className="row" style={{gap:8}}>
                    <span className="mtg-title">{n.t}</span>
                    <span className="mtg-tag" style={{color: tagColor(n.tag), borderColor: 'color-mix(in srgb, '+tagColor(n.tag)+' 30%, var(--border))'}}>
                      {n.tag}
                    </span>
                    <MtgProgressDots storageKey={rowStorageKey(n, g.day, g.jp)} listVersion={listTick}/>
                  </div>
                  <div className="row" style={{gap:10, marginTop:3}}>
                    <span className="mtg-meta">{n.a}</span>
                    {n.att && <span className="mtg-meta"><Icon name="users" size={10}/>{n.att}</span>}
                    {n.duration && <span className="mtg-meta"><Icon name="clock" size={10}/>{n.duration}</span>}
                  </div>
                </div>
                <div className="mtg-right">
                  {n.locked && <Icon name="shield" size={11} className="dim"/>}
                  <span className="t-mono mtg-time">{n.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* Footer */}
      <div style={{marginTop:48, padding:'18px 0', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:12, color:'var(--text-dim)'}}>
        <Kamon size={14} color="var(--gold)"/>
        <span className="t-mono" style={{fontSize:10}}>142 MEETINGS IN MEMORY · LOCAL</span>
        <span className="spacer"/>
        <span className="jp" style={{fontSize:11}}>一期一会</span>
        <span style={{fontSize:11, fontStyle:'italic'}}>One meeting, one encounter</span>
      </div>

        </div>
      </div>

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
            }}
          >
            <Icon name="arrowLeft" size={18}/>
          </button>

          {granolaOutline && (
            <div className="granola-float" style={{top:100, right:16, display:'flex', flexDirection:'column', gap:6, padding:10, borderRadius:12, background:'var(--surface)', border:'1px solid var(--border-hi)', maxWidth:140}}>
              {['memo','transcript','summary','minutes'].map(function (pid) {
                const labels = { memo:'メモ', transcript:'文字起こし', summary:'要約', minutes:'議事録' };
                return (
                  <button key={pid} type="button" onClick={function () { setGranolaPane(pid); }} style={{fontSize:11, padding:'6px 8px', borderRadius:8, border:'1px solid var(--border-hi)', background:granolaPane===pid?'color-mix(in srgb, var(--success) 16%, transparent)':'transparent', color:'var(--text)', cursor:'pointer', fontFamily:'inherit'}}>
                    {labels[pid]}
                  </button>
                );
              })}
            </div>
          )}

          {granolaMenuOpen && (
            <div className="granola-float" style={{bottom:cmdBarMin?88:150, left:'50%', transform:'translateX(-50%)', width:'min(320px, calc(100% - 32px))', padding:12, borderRadius:16, background:'var(--surface)', border:'1px solid var(--border-hi)', boxShadow:'var(--shadow-lg)'}}>
              {[
                { fn: applyStubTranscript, en: 'Insert transcript template', jp: 'テンプレ文字起こし' },
                { fn: toggleSpeech, en: 'Browser speech input', jp: 'ブラウザ音声入力' },
                { fn: refreshSummary, en: 'Refresh summary (rules)', jp: '要約を更新（ルール）' },
                { fn: refreshMinutes, en: 'Build minutes', jp: '議事録を生成' },
                { fn: ingestNoteToMemory, en: 'Save to Memory', jp: 'Memory に保存' },
              ].map(function (row, idx) {
                return (
                  <button key={idx} type="button" onClick={function () { row.fn(); setGranolaMenuOpen(false); }} style={{display:'block', width:'100%', textAlign:'left', padding:'10px 8px', marginBottom:4, border:'none', borderRadius:8, background:'var(--surface-2)', color:'var(--text)', fontSize:13, cursor:'pointer', fontFamily:'inherit'}}>
                    <span className="en-only">{row.en}</span>
                    <span className="jp" style={{fontSize:12}}>{row.jp}</span>
                  </button>
                );
              })}
            </div>
          )}

          {granolaTodos !== null && (
            <div className="granola-float" style={{bottom:cmdBarMin?96:158, left:'50%', transform:'translateX(-50%)', width:'min(420px, calc(100% - 40px))', maxHeight:200, overflow:'auto', padding:14, borderRadius:14, background:'var(--surface)', border:'1px solid var(--border-hi)'}}>
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

          <div style={{flex:1, overflow:'auto', padding:'56px 32px ' + (cmdBarMin ? '100px' : '140px'), maxWidth:720, width:'100%', margin:'0 auto', boxSizing:'border-box'}}>
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
              <span style={granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)')}>
                <Icon name="calendar" size={13}/>
                <span className="en-only">{granola.dateLabel}</span>
                <span className="jp" style={{fontSize:12}}>{granola.dateLabelJp}</span>
                {granola.time && <span style={{opacity:0.7, marginLeft:4}} className="t-mono">{granola.time}</span>}
              </span>
              <span style={granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)')}>
                <Icon name="users" size={13}/>
                <span className="en-only">{granola.authorLabel}</span>
                <span className="jp" style={{fontSize:12}}>{granola.authorLabelJp}</span>
              </span>
              <button type="button" onClick={addFolderTag} style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--text-mute)'), cursor:'pointer', font:'inherit', color:'inherit'}}>
                <Icon name="folder" size={13}/>
                <span className="en-only">Add to folder</span>
                <span className="jp" style={{fontSize:12}}>フォルダに追加</span>
              </button>
              {granola.tag && (
                <span style={{...granolaPillStyle('var(--surface)', 'var(--border-hi)', 'var(--success)'), color:'var(--success)', borderColor:'color-mix(in srgb, var(--success) 35%, transparent)'}}>
                  {granola.tag}
                </span>
              )}
            </div>

            <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:20}}>
              {[
                { id:'memo', en:'Notes', jp:'メモ' },
                { id:'transcript', en:'Transcript', jp:'文字起こし' },
                { id:'summary', en:'Summary', jp:'要約' },
                { id:'minutes', en:'Minutes', jp:'議事録' },
              ].map(function (t) {
                const on = granolaPane === t.id;
                return (
                  <button key={t.id} type="button" onClick={function () { setGranolaPane(t.id); }} style={{padding:'8px 14px', borderRadius:999, border:'1px solid ' + (on ? 'var(--success)' : 'var(--border-hi)'), background:on ? 'color-mix(in srgb, var(--success) 14%, transparent)' : 'transparent', color:on ? 'var(--success)' : 'var(--text-mute)', cursor:'pointer', fontSize:12, fontFamily:'inherit'}}>
                    <span className="en-only">{t.en}</span>
                    <span className="jp" style={{fontSize:11}}>{t.jp}</span>
                  </button>
                );
              })}
            </div>

            {granolaPane === 'transcript' && (
              <div style={{display:'flex', flexWrap:'wrap', gap:8, marginTop:12}}>
                <button type="button" onClick={applyStubTranscript} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--text-mute)')}>+ \u30c6\u30f3\u30d7</button>
                <button type="button" onClick={toggleSpeech} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--success)')}>\u97f3\u58f0\u5165\u529b</button>
              </div>
            )}
            {granolaPane === 'summary' && (
              <div style={{marginTop:12}}>
                <button type="button" onClick={refreshSummary} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--success)')}>\u8981\u7d04\u3092\u66f4\u65b0\uff08\u30eb\u30fc\u30eb\uff09</button>
              </div>
            )}
            {granolaPane === 'minutes' && (
              <div style={{marginTop:12}}>
                <button type="button" onClick={refreshMinutes} style={granolaMiniBtn('var(--surface)', 'var(--border-hi)', 'var(--success)')}>\u8b70\u4e8b\u9332\u3092\u751f\u6210</button>
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
                placeholder="Transcript (local / paste / speech)…"
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

          {!cmdBarMin && (
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
            <div style={{display:'flex', alignItems:'center', gap:2, padding:'0 6px 0 10px'}}>
              <button type="button" style={granolaIconBtn} onClick={function () { setGranolaMenuOpen(function (v) { return !v; }); }} aria-expanded={granolaMenuOpen}><Icon name="more" size={16}/></button>
              <button type="button" style={granolaIconBtn} onClick={function () { setCmdBarMin(true); setGranolaMenuOpen(false); }} aria-label="Minimize bar"><Icon name="chevronUp" size={16}/></button>
              <button type="button" style={granolaIconBtn} onClick={function () { setGranolaOutline(function (v) { return !v; }); }} aria-label="Section outline"><span style={{display:'block', width:14, height:14, border:'1.5px solid var(--text-mute)', borderRadius:3}}/></button>
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
          {cmdBarMin && (
            <div className="granola-float" style={{left:'50%', bottom:28, transform:'translateX(-50%)'}}>
              <button type="button" onClick={function () { setCmdBarMin(false); }} style={{display:'flex', alignItems:'center', gap:8, padding:'10px 18px', borderRadius:999, border:'1px solid var(--border-hi)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', fontFamily:'inherit'}}>
                <Icon name="chevronDown" size={16}/> Command bar
              </button>
            </div>
          )}

          <style>{`
            .granola-pane::placeholder { color: var(--text-mute); opacity: 1; }
            .granola-ask::placeholder { color: var(--text-mute); }
          `}</style>
        </div>
      )}

      {/* Scoped styles */}
      <style>{`
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
