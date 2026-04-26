/* global Icon, React */
const { useState, useEffect, useMemo, useCallback, useRef } = React;

function runRuntimeActionA(key, payload, options) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.executeAction) return Promise.resolve({ ok:false });
  return window.SHOGUN_RUNTIME.executeAction(key, payload || {}, options || {});
}

function requestWriteActionA(actionKey, payload, title, description) {
  if (!window.SHOGUN_RUNTIME || !window.SHOGUN_RUNTIME.requestWriteAction) return;
  window.SHOGUN_RUNTIME.requestWriteAction(actionKey, payload, title, description);
}

/** Mirrors desktop `derive_provenance_from_source` when API omits `provenance`. */
function deriveLocalProvenance(source) {
  const s = String(source || '');
  if (s === 'capture_sampler' || s === 'capture_ax') return 'screen';
  if (s === 'google_calendar' || s === 'gmail') return 'connector';
  if (s === 'meeting' || s.startsWith('meetings')) return 'meeting';
  return 'user';
}

/** Collapse a raw `sources` row value into a filter bucket. */
function memoryProviderKey(sourceRaw) {
  const s = String(sourceRaw || '').toLowerCase();
  if (s === 'capture_sampler' || s === 'capture_ax') return 'screen';
  if (s === 'gmail') return 'gmail';
  if (s === 'google_calendar') return 'google_calendar';
  if (s === 'slack') return 'slack';
  if (s === 'notion') return 'notion';
  if (s === 'github') return 'github';
  if (s === 'meeting' || s.startsWith('meetings')) return 'meeting';
  return 'manual';
}

const MEMORY_PROVIDER_META = {
  screen:          { en: 'Screen',   jp: '画面',   color: 'var(--text-mute)' },
  meeting:         { en: 'Meeting',  jp: '会議',   color: 'var(--success)' },
  gmail:           { en: 'Gmail',    jp: 'メール', color: '#D93025' },
  google_calendar: { en: 'Calendar', jp: '予定',   color: '#1A73E8' },
  slack:           { en: 'Slack',    jp: 'Slack',  color: '#4A154B' },
  notion:          { en: 'Notion',   jp: 'Notion', color: 'var(--text)' },
  github:          { en: 'GitHub',   jp: 'GitHub', color: 'var(--text-mute)' },
  manual:          { en: 'Manual',   jp: '手動',   color: 'var(--text-dim)' },
};

function memoryProvenanceLabel(prov) {
  const p = prov || 'user';
  if (p === 'screen') return { en: 'Screen', jp: '画面' };
  if (p === 'connector') return { en: 'Connector', jp: '連携' };
  if (p === 'meeting') return { en: 'Meeting', jp: '会議' };
  return { en: 'User', jp: '手動' };
}

function memoryHitToRiverEvent(hit) {
  const ts = hit.created_at != null ? Number(hit.created_at) : Date.now();
  const d = new Date(ts);
  const hRaw = d.getHours() + d.getMinutes() / 60;
  const h = Math.max(6, Math.min(22, hRaw));
  const t = d.toTimeString().slice(0, 5);
  const rawSrc = String(hit.source || '').toLowerCase();
  let src = 'note';
  if (rawSrc === 'meetings' || (Array.isArray(hit.kinds) && hit.kinds.indexOf('audio') >= 0)) src = 'meet';
  else if (rawSrc === 'chat') src = 'chat';
  else if (rawSrc === 'work') src = 'code';
  else if (rawSrc === 'google_calendar') src = 'meet';
  else if (rawSrc === 'gmail') src = 'mail';
  const provenance = hit.provenance || deriveLocalProvenance(hit.source);
  return {
    ts,
    t,
    h,
    src,
    title: hit.title || 'Memory',
    snippet: hit.snippet || '',
    titleHighlight: typeof hit.title_highlight === 'string' ? hit.title_highlight : null,
    snippetHighlight: typeof hit.snippet_highlight === 'string' ? hit.snippet_highlight : null,
    memoryId: hit.id,
    provenance,
    sourceRaw: hit.source || '',
    entityId: hit.entity_id != null ? String(hit.entity_id) : null,
    big: false,
  };
}

/** Parse a window/app identifier out of the AX snippet dump.
 *  Falls back to the first 40 chars of the snippet when nothing matches. */
/** Compute smart snooze deadlines from "now":
 *   - tomorrowMorning: tomorrow 9:00 local
 *   - nextMondayMorning: next Monday 9:00 local (weekend snoozes skip past it)
 *  If today is already past 9am, tomorrow's 9am is still tomorrow (not today).
 *  Returned values are ms epoch so the IPC can pass them straight through. */
function smartSnoozePresets(now = new Date()) {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  // ISO weekday: Mon=1..Sun=7. JS: Sun=0..Sat=6.
  const jsDow = now.getDay();
  const daysToMonday = jsDow === 1
    ? 7                 // already Monday — next Monday is 7 days out
    : (8 - jsDow) % 7;  // Tue→6, Wed→5, ..., Sun→1
  const nextMonday = new Date(now);
  nextMonday.setDate(nextMonday.getDate() + (daysToMonday || 7));
  nextMonday.setHours(9, 0, 0, 0);
  return { tomorrowMorning: tomorrow.getTime(), nextMondayMorning: nextMonday.getTime() };
}

function extractWindowLabel(snippet) {
  const s = String(snippet || '');
  const winMatch = s.match(/^window=([^\n]{1,80})/m);
  if (winMatch) {
    const w = winMatch[1].trim();
    // "App — Document — claude — 120x30" → keep up to 2 segments for brevity
    const parts = w.split(/\s*[—·]\s*/);
    return parts.slice(0, 2).join(' · ').slice(0, 60);
  }
  const titleMatch = s.match(/^title=([^\n]{1,80})/m);
  if (titleMatch) return titleMatch[1].trim().slice(0, 60);
  const roleDesc = s.match(/^roleDesc=([^\n]{1,40})/m);
  if (roleDesc) return `AX · ${roleDesc[1].trim()}`;
  return 'Screen capture';
}

/** Collapse consecutive capture_ax / capture_sampler events with the same
 *  window label into a single "session" card. Gap > `gapMs` starts a new
 *  session. Non-screen events are passed through unchanged. */
function clusterScreenSessions(events, gapMs = 15 * 60 * 1000) {
  if (!Array.isArray(events) || events.length === 0) return events;
  const out = [];
  let current = null;
  for (const e of events) {
    const raw = String(e.sourceRaw || '').toLowerCase();
    const isScreen = raw === 'capture_ax' || raw === 'capture_sampler';
    if (!isScreen) {
      if (current) { out.push(current); current = null; }
      out.push(e);
      continue;
    }
    const label = extractWindowLabel(e.snippet);
    if (current && current.clusterLabel === label && Math.abs(e.ts - current.ts) <= gapMs) {
      current.clusterCount += 1;
      current.clusterStart = Math.min(current.clusterStart, e.ts);
      current.clusterEnd = Math.max(current.clusterEnd, e.ts);
      // Prefer the longest snippet so the raw view is informative.
      if ((e.snippet || '').length > (current.snippet || '').length) {
        current.snippet = e.snippet;
      }
    } else {
      if (current) out.push(current);
      current = {
        ...e,
        title: `Session · ${label}`,
        clusterLabel: label,
        clusterCount: 1,
        clusterStart: e.ts,
        clusterEnd: e.ts,
      };
    }
  }
  if (current) out.push(current);
  return out;
}

/** Shared FTS5 highlight renderer. Definition lives in `hifi/lib/highlight.js`. */
const renderHighlighted = (text) =>
  (window.ShogunHighlight && window.ShogunHighlight.renderHighlighted)
    ? window.ShogunHighlight.renderHighlighted(text)
    : (text || '');

function mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx) {
  if (!res || !res.ok || !res.data) return;
  const hits = res.data.hits;
  if (!Array.isArray(hits) || hits.length === 0) {
    setEvents([]);
    setScrubIdx(0);
    return;
  }
  const mapped = hits.map(memoryHitToRiverEvent);
  setEvents(mapped);
  setScrubIdx(0);
}

/** Jump to Chat with composer text + one-shot `memoryAssembly` preset (title-biased retrieval). */
function openMemoryEntryInChat(entry, options) {
  const opts = options || {};
  const allowAsm = opts.allowServerMemoryAssembly !== false;
  const title = String(entry.title || '').trim() || 'Memory';
  const snippet = String(entry.snippet || '');
  const lead = opts.userLead != null ? String(opts.userLead) : 'この記憶について手伝ってください。';
  const text = lead + '\n\n**' + title + '**\n\n' + snippet.slice(0, 2000);
  const memQ = String(opts.memoryAssemblyQuery != null ? opts.memoryAssemblyQuery : title).slice(0, 480);
  const limRaw = opts.memoryAssemblyLimit != null ? Number(opts.memoryAssemblyLimit) : 14;
  const limit = Number.isFinite(limRaw) ? Math.min(80, Math.max(1, Math.floor(limRaw))) : 14;
  const semantic = opts.memoryAssemblySemantic !== false;
  if (opts.newChat && typeof window.SHOGUN_RUNTIME?.createNewChat === 'function') {
    window.SHOGUN_RUNTIME.createNewChat();
  }
  const detail = {
    text,
    webSearch: !!opts.webSearch,
    assembleMemory: allowAsm,
    autoSend: !!opts.autoSend,
  };
  if (allowAsm) {
    detail.memoryAssemblyPreset = { query: memQ, limit, semantic };
  } else {
    detail.clearMemoryAssemblyPreset = true;
  }
  const dispatch = () => window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
  window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  if (opts.newChat) {
    // Let React mount the new chat + composer listener before seeding.
    setTimeout(dispatch, 0);
  } else {
    dispatch();
  }
}

/** IANA zone from Shogun helper or `Intl` (browser / OS). */
function resolveUserTimeZoneId() {
  const U = typeof window !== 'undefined' ? window.ShogunUserTimezone : null;
  if (U && typeof U.getTimeZone === 'function') {
    const z = U.getTimeZone();
    if (z && String(z).trim()) return String(z).trim();
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_e) {
    return 'UTC';
  }
}

function composerPlaceholderForLang(lang) {
  const L = lang === 'en' || lang === 'jp' || lang === 'bi' ? lang : 'en';
  if (L === 'jp') return '本日はどのようなお手伝いをさせていただけますか？';
  if (L === 'bi') {
    return 'How can I help you today? ／ 本日はどのようなお手伝いをさせていただけますか？';
  }
  return 'How can I help you today?';
}

/** First word of display name for EN/JP greeting lines (matches previous behavior). */
function homeFirstNameToken(fullName) {
  const raw = fullName != null ? String(fullName).trim() : '';
  if (!raw) return '';
  return raw.split(/\s+/)[0];
}

/** Drive-style mark using SHOGUN palette (not Google colors). */
function ShogunDriveGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden style={{ flexShrink: 0 }}>
      <path fill="var(--success)" d="M12 4 7.5 14.5h9L12 4z" />
      <path fill="var(--gold)" d="M7.5 14.5 4 21h16l-3.5-6.5z" />
      <path fill="color-mix(in srgb, var(--gold) 55%, var(--border) 45%)" d="M12 4l3.5 10.5h7L12 4z" />
    </svg>
  );
}

/** Greeting + date lines from the user's local clock (browser/OS timezone). */
function computeHomeGreetingState(now) {
  const d = now instanceof Date ? now : new Date();
  const h = d.getHours();
  let greetEn;
  let greetJp;
  if (h >= 5 && h < 12) {
    greetEn = 'Good morning';
    greetJp = 'おはようございます';
  } else if (h >= 12 && h < 17) {
    greetEn = 'Good afternoon';
    greetJp = 'こんにちは';
  } else if (h >= 17 && h < 22) {
    greetEn = 'Good evening';
    greetJp = 'こんばんは';
  } else {
    greetEn = 'Good evening';
    greetJp = 'お疲れ様です';
  }
  const tz = resolveUserTimeZoneId();
  const dateEn = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  })
    .format(d);
  const dateJp = new Intl.DateTimeFormat('ja-JP', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(d);
  const dateBi = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: tz,
    timeZoneName: 'short',
  }).format(d);
  return { greetEn, greetJp, dateEn, dateJp, dateBi };
}

const HOME_QUICK_CATEGORIES = [
  { id: 'writing', en: 'Writing', jp: '文章作成', icon: 'edit' },
  { id: 'learning', en: 'Learning', jp: '学習', icon: 'graduation' },
  { id: 'code', en: 'Code', jp: 'コード', icon: 'terminal' },
  { id: 'lifestyle', en: 'Lifestyle', jp: 'ライフスタイル', icon: 'coffee' },
  { id: 'drive', en: 'From Drive', jp: 'Drive から', icon: 'drive' },
];

const HOME_PROMPT_ROWS = {
  writing: [
    { en: 'Research for a piece of writing', jp: '執筆のための調査をする' },
    { en: 'Draft interview questions', jp: '面接質問の作成' },
    { en: 'Plan a blog post series', jp: 'ブログ記事シリーズの作成' },
    { en: 'Write social media posts', jp: 'ソーシャルメディア投稿の作成' },
    { en: 'Create a content brief', jp: 'コンテンツ企画書を作成する' },
  ],
  learning: [
    { en: 'Set learning goals', jp: '学習目標を設定する' },
    { en: 'Design a teaching strategy', jp: '教育戦略の開発' },
    { en: 'Summarize an academic paper', jp: '学術論文を要約する' },
    { en: 'Design a reflection exercise', jp: '振り返り演習を開発する' },
    { en: 'Find patterns across my research', jp: '私の研究からパターンを見つけてください' },
  ],
  code: [
    { en: 'Request a code review', jp: 'コードレビューを依頼する' },
    { en: 'Diagnose a bug', jp: 'バグの原因を調査する' },
    { en: 'Suggest a refactor', jp: 'リファクタリング案を出す' },
    { en: 'Generate test cases', jp: 'テストケースを生成する' },
    { en: 'Explain this code’s architecture', jp: 'このコードのアーキテクチャを説明する' },
  ],
  lifestyle: [
    { en: 'Manage personal stress', jp: '個人のストレス管理' },
    { en: 'Help me decide', jp: '意思決定をサポートする' },
    { en: 'Build a self-care routine', jp: 'セルフケアの習慣作り' },
    { en: 'Plan post-retirement activities', jp: '退職後の活動を計画する' },
    { en: 'Plan a home improvement', jp: '住宅改善を計画する' },
  ],
  drive: [
    { en: 'Surface the best moments in my documents', jp: '私の文書から最も優れた瞬間を特定し、視覚化する' },
    { en: 'What themes recur across my documents?', jp: '私の文書全体を通して一貫して現れるアイデアのテーマは何ですか？' },
    { en: 'Analyze my writing style from my documents', jp: '私の文書に基づいて文章スタイルを分析してください' },
    { en: 'Suggest a writing genre that fits me', jp: '私の文書を確認して、どのようなジャンルの作家になれるか提案する' },
    { en: 'Summarize documents I just gained access to', jp: '新しくアクセス権を得た文書の要約を教えてください' },
  ],
};

function pickHomeText(item, uiLang) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  if (uiLang === 'jp') return item.jp || item.en || '';
  if (uiLang === 'bi') {
    const en = item.en || '';
    const jp = item.jp || '';
    if (en && jp) return `${en} ／ ${jp}`;
    return en || jp;
  }
  return item.en || item.jp || '';
}

// ═══════════════════════════════════════════════════════════════════════════
// L1 · HOME — the launch pad
// ═══════════════════════════════════════════════════════════════════════════
function ScreenHome() {
  const [morningBrief, setMorningBrief] = useState(null);
  const [memoryDigest, setMemoryDigest] = useState(null); // { highlights: [], week_rollup: {...} | null }
  // Item-detail expansion: when the user clicks a highlight, show full
  // keyPoints + reason + (if entityId present) an entity rollup of related
  // items underneath.
  const [expandedHighlightId, setExpandedHighlightId] = useState(null);
  const [entityRollupCache, setEntityRollupCache] = useState({}); // { [entityId]: { rollup, loading } }
  const [memoryTotal, setMemoryTotal] = useState(null);
  const [profileFullName, setProfileFullName] = useState('');
  const [modelHint, setModelHint] = useState('');
  const [homeInput, setHomeInput] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [promptModal, setPromptModal] = useState(null);
  const [webSearchOn, setWebSearchOn] = useState(true);
  const [assembleMemoryOn, setAssembleMemoryOn] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragDepthRef = useRef(0);
  const [composerPh, setComposerPh] = useState(() =>
    composerPlaceholderForLang(
      typeof document !== 'undefined' ? document.body.getAttribute('data-lang') : null,
    ),
  );
  const [uiLang, setUiLang] = useState(() =>
    typeof document !== 'undefined' ? document.body.getAttribute('data-lang') || 'en' : 'en',
  );
  const [clockTick, setClockTick] = useState(0);
  const plusRef = useRef(null);
  const plusFileInputRef = useRef(null);
  const quickPromptRootRef = useRef(null);

  const headLine = useMemo(() => computeHomeGreetingState(new Date()), [clockTick]);
  const greetFirstName = useMemo(() => homeFirstNameToken(profileFullName), [profileFullName]);
  const homeDateStr =
    uiLang === 'jp' ? headLine.dateJp : uiLang === 'bi' ? headLine.dateBi : headLine.dateEn;

  const briefGeneratedDisplay = useMemo(() => {
    const iso = morningBrief && morningBrief.generated_at;
    if (!iso) return '';
    const U = typeof window !== 'undefined' ? window.ShogunUserTimezone : null;
    if (U && typeof U.formatIsoInTimeZone === 'function') {
      const x = U.formatIsoInTimeZone(iso);
      const t = (x.time || '').trim();
      const z = (x.tzShort || '').trim();
      return t + (z ? ' ' + z : '');
    }
    try {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d.toTimeString().slice(0, 5);
    } catch (_e) {}
    return typeof iso === 'string' && iso.length >= 16 ? iso.slice(11, 16) : '';
  }, [morningBrief]);

  /* Local clock only — no API/LLM cost. Hourly + tab refocus keeps greeting/date in sync without waking every minute. */
  useEffect(() => {
    const bump = () => setClockTick((x) => x + 1);
    const HOUR_MS = 60 * 60 * 1000;
    const msToNextHour = () => {
      const n = new Date();
      const next = new Date(n.getTime());
      next.setHours(n.getHours() + 1, 0, 0, 0);
      return Math.max(1, next - n);
    };
    let intervalId = null;
    const timeoutId = window.setTimeout(() => {
      bump();
      intervalId = window.setInterval(bump, HOUR_MS);
    }, msToNextHour());
    const onVis = () => {
      if (document.visibilityState === 'visible') bump();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.clearTimeout(timeoutId);
      if (intervalId != null) window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    runRuntimeActionA('stats.get', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data) return;
      const n = Number(r.data.memoryTotal);
      if (!Number.isNaN(n)) setMemoryTotal(n);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const syncPh = () => {
      const L = typeof document !== 'undefined' ? document.body.getAttribute('data-lang') : null;
      const next = L === 'en' || L === 'jp' || L === 'bi' ? L : 'en';
      setUiLang(next);
      setComposerPh(composerPlaceholderForLang(next));
    };
    syncPh();
    const obs =
      typeof document !== 'undefined'
        ? new MutationObserver(syncPh)
        : null;
    if (obs) obs.observe(document.body, { attributes: true, attributeFilter: ['data-lang'] });
    return () => {
      if (obs) obs.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data?.settings?.sections) return;
      const g = r.data.settings.sections.general;
      if (g && typeof g === 'object') {
        const raw = g.name != null ? String(g.name).trim() : '';
        setProfileFullName(raw);
      }
      const llm = r.data.settings.sections.llm;
      if (llm && llm.model != null) setModelHint(String(llm.model));
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onProfile = (e) => {
      const d = e && e.detail;
      if (!d || typeof d !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(d, 'name')) {
        setProfileFullName(d.name == null ? '' : String(d.name).trim());
      }
    };
    window.addEventListener('shogun-profile-changed', onProfile);
    return () => window.removeEventListener('shogun-profile-changed', onProfile);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
      const res = await runRuntimeActionA(
        "brief.get",
        { span: "today", source: "home", user_tz: resolveUserTimeZoneId(), lang },
        { silentError: true }
      );
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setMorningBrief(null);
        setMemoryDigest(null);
        return;
      }
      const inner = res.data;
      // Memory digest rides alongside the brief. Always surface it when the
      // backend provides it, even if the main brief is skipped / unavailable.
      if (inner.memory_digest) {
        setMemoryDigest(inner.memory_digest);
        // Tell the App-level sidebar how many HIGH items to badge.
        try {
          const highlights = Array.isArray(inner.memory_digest.highlights)
            ? inner.memory_digest.highlights
            : [];
          const nowMs = Date.now();
          const highCount = highlights.filter(
            (h) => (h.userPriority || h.priority) === 'high'
              && !h.acknowledgedAt
              && !(h.snoozeUntil && h.snoozeUntil > nowMs),
          ).length;
          window.dispatchEvent(new CustomEvent('shogun-memory-high-count', { detail: { count: highCount } }));
        } catch (_) { /* ignore */ }
      }
      if (inner.skipped || !inner.brief) {
        setMorningBrief(null);
        return;
      }
      setMorningBrief(inner.brief);
      if (window.BriefTelemetry) {
        window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.BRIEF_RENDERED, {
          itemCount: inner.brief.items?.length || 0,
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!plusOpen) return;
    const close = (e) => {
      if (plusRef.current && !plusRef.current.contains(e.target)) setPlusOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [plusOpen]);

  useEffect(() => {
    if (!promptModal && !plusOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setPromptModal(null);
        setPlusOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [promptModal, plusOpen]);

  useEffect(() => {
    if (!promptModal) return;
    const close = (e) => {
      if (quickPromptRootRef.current && !quickPromptRootRef.current.contains(e.target)) {
        setPromptModal(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [promptModal]);

  const seedAndOpenChat = (text, options) => {
    const t = String(text || '').trim();
    const autoSend = !!(options && options.autoSend) && t.length > 0;
    window.dispatchEvent(
      new CustomEvent('shogun-chat-composer-seed', {
        detail: { text: t, webSearch: webSearchOn, assembleMemory: assembleMemoryOn, autoSend },
      }),
    );
    window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  };

  const goAsk = () => {
    const t = homeInput.trim();
    if (!t) return;
    seedAndOpenChat(t, { autoSend: true });
    setHomeInput('');
  };

  const ingestPlusFiles = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    let n = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let snippet = '';
      if (file.type && file.type.indexOf('image/') === 0) {
        snippet = `[Image] ${file.name} (${file.size} bytes)`;
      } else {
        try {
          const text = await new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
            fr.onerror = () => reject(new Error('read'));
            fr.readAsText(file);
          });
          snippet = String(text).slice(0, 16000);
        } catch (_) {
          snippet = `[File] ${file.name} — could not read as text (binary or too large).`;
        }
      }
      const r = await runRuntimeActionA(
        'memory.ingest',
        {
          title: `Home · ${file.name}`,
          snippet,
          source: 'home_attachment',
          kinds: ['input', 'note'],
        },
        { silentError: true },
      );
      if (r && r.ok) n += 1;
    }
    if (n > 0) {
      window.SHOGUN_RUNTIME?.pushToast?.(`${n} file(s) added to Memory`, 'success');
    } else {
      window.SHOGUN_RUNTIME?.pushToast?.('Could not ingest files', 'warn');
    }
  }, []);

  const onPlusFilesChange = useCallback(
    (e) => {
      const fl = e.target.files;
      if (fl && fl.length) void ingestPlusFiles(fl);
      e.target.value = '';
    },
    [ingestPlusFiles],
  );

  const plusMenuSections = useMemo(
    () => [
      [
        {
          icon: 'paperclip',
          label: 'ファイルまたは写真を追加',
          chev: false,
          onPick: () => plusFileInputRef.current && plusFileInputRef.current.click(),
        },
        {
          icon: 'layers',
          label: 'プロジェクトに追加',
          chev: true,
          onPick: () => {
            window.SHOGUN_RUNTIME?.setActiveScreen?.('memory');
            window.SHOGUN_RUNTIME?.pushToast?.('Memory を開きました — タイムラインでプロジェクトを整理できます', 'info');
          },
        },
        {
          icon: 'github',
          label: 'GitHubから追加',
          chev: false,
          onPick: () => {
            window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
            window.SHOGUN_RUNTIME?.pushToast?.('連携から Git / ツールを選ぶか、リポジトリ URL をチャットに貼ってください', 'info');
          },
        },
      ],
      [
        {
          icon: 'note',
          label: 'スキル',
          chev: true,
          onPick: () => {
            window.SHOGUN_RUNTIME?.openSettingsPane?.('chat');
            window.SHOGUN_RUNTIME?.pushToast?.('Chat のカスタム指示を編集できます', 'info');
          },
        },
        {
          icon: 'grid',
          label: 'コネクタ',
          chev: true,
          onPick: () => {
            window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
          },
        },
        {
          icon: 'plug',
          label: 'プラグイン',
          chev: true,
          onPick: () => {
            window.SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
          },
        },
      ],
      [
        {
          icon: 'search',
          label: 'リサーチ',
          chev: false,
          onPick: () => {
            setHomeInput((v) => {
              const t = (v || '').trim();
              return t ? `${t}\nResearch: ` : 'Research: ';
            });
            window.SHOGUN_RUNTIME?.pushToast?.('入力欄に Research: を挿入しました（続きを書いて送信）', 'info');
          },
        },
        {
          icon: 'globe',
          label: 'ウェブ検索',
          chev: false,
          active: webSearchOn,
          onPick: () => setWebSearchOn((v) => !v),
        },
        {
          icon: 'memory',
          label: 'Memory 自動取得',
          chev: false,
          active: assembleMemoryOn,
          onPick: () => setAssembleMemoryOn((v) => !v),
        },
        {
          icon: 'edit',
          label: 'スタイルを使用',
          chev: true,
          onPick: () => {
            window.SHOGUN_RUNTIME?.openSettingsPane?.('appearance');
          },
        },
      ],
    ],
    [webSearchOn, assembleMemoryOn],
  );

  const runBriefMcp = (item, tool) => {
    if (!tool?.tool_name) return;
    const key = tool.tool_name;
    const payload = {
      ...(tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {}),
      brief_item: {
        id: item.id,
        what: item.what,
        why_now: item.why_now,
        related_context: item.related_context,
        category: item.category,
        priority: item.priority,
        time_hint: item.time_hint,
      },
    };
    runRuntimeActionA(key, payload, { successMessage: item.next_action?.label || "Done" });
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.NEXT_ACTION_CLICK, {
        itemId: item.id,
        tool: key,
      });
    }
  };

  const dismissBriefItem = (item) => {
    setMorningBrief((prev) => {
      if (!prev?.items) return prev;
      return {
        ...prev,
        items: prev.items.filter((i) => i.id !== item.id),
      };
    });
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.ITEM_DISMISS, { itemId: item.id });
    }
  };

  const submitBriefRating = (n) => {
    if (window.BriefTelemetry) {
      window.BriefTelemetry.log(window.BriefTelemetry.EVENTS.RATING, { score: n });
    }
    runRuntimeActionA("settings.save", { section: "brief", rating: n }, { successMessage: "Thanks — saved locally" });
  };

  const modalMeta = promptModal && HOME_QUICK_CATEGORIES.find((c) => c.id === promptModal);
  const modalRows = promptModal ? HOME_PROMPT_ROWS[promptModal] : null;

  return (
    <div
      className="content-inner home-launch-root"
      style={{
        width: '100%',
        maxWidth: 'none',
        margin: 0,
        padding: 'clamp(32px, 5vw, 64px) clamp(24px, 5vw, 72px) clamp(40px, 6vw, 80px)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          marginInline: 'auto',
          minHeight: 'min(72vh, 620px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          justifyContent: 'center',
          gap: 28,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ marginBottom: 10, display: 'flex', justifyContent: 'center' }}>
            <Kamon size={28} />
          </div>
          <h1
            className="en-only"
            style={{
              fontSize: 'clamp(22px, 4vw, 28px)',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1.35,
            }}
          >
            {headLine.greetEn}, {greetFirstName || 'there'}.
          </h1>
          <h1
            className="jp"
            style={{
              fontSize: 'clamp(22px, 4vw, 28px)',
              fontWeight: 600,
              letterSpacing: '-0.02em',
              margin: 0,
              lineHeight: 1.35,
            }}
          >
            {headLine.greetJp}。{greetFirstName || 'ゲスト'}さん、お帰りなさい
          </h1>
          <div className="t-mono" style={{ marginTop: 10, fontSize: 12, color: 'var(--text-dim)', textTransform:'none', letterSpacing:'0.02em' }}>
            {homeDateStr}
            {memoryTotal != null && (
              <span className="jp" style={{ marginLeft: 12, fontFamily: 'var(--font-jp)' }}>
                記憶 {memoryTotal} 件
              </span>
            )}
          </div>
        </div>

        <div
          ref={quickPromptRootRef}
          style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <div
            className={'home-composer-dropzone' + (dragOver ? ' is-drag-over' : '')}
            style={{
              position: 'relative',
              background: 'var(--surface)',
              border: '1px solid ' + (dragOver ? 'var(--gold)' : 'var(--border)'),
              borderRadius: 20,
              boxShadow: 'var(--shadow-md)',
              padding: '16px 16px 12px',
              transition: 'border-color 140ms, background 140ms, box-shadow 140ms',
            }}
            onDragEnter={(e) => {
              if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
              e.preventDefault();
              dragDepthRef.current += 1;
              setDragOver(true);
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={() => {
              dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
              if (dragDepthRef.current === 0) setDragOver(false);
            }}
            onDrop={(e) => {
              if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
              e.preventDefault();
              dragDepthRef.current = 0;
              setDragOver(false);
              void ingestPlusFiles(e.dataTransfer.files);
            }}
          >
            {dragOver && (
              <div className="home-composer-drop-hint" aria-hidden="true">
                <Icon name="paperclip" size={18} />
                <span className="en-only">Drop files to add to Memory</span>
                <span className="jp">ファイルをドロップして Memory に追加</span>
              </div>
            )}
            <textarea
              value={homeInput}
              onChange={(e) => setHomeInput(e.target.value)}
              placeholder={composerPh}
              rows={3}
              style={{
                width: '100%',
                resize: 'none',
                border: 'none',
                background: 'transparent',
                color: 'var(--text)',
                fontSize: 15,
                lineHeight: 1.55,
                outline: 'none',
                fontFamily: 'var(--font-jp), var(--font-en)',
                minHeight: 72,
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  goAsk();
                }
              }}
            />
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginTop: 8,
                paddingTop: 8,
                borderTop: '1px solid var(--border)',
              }}
            >
              <div style={{ position: 'relative' }} ref={plusRef}>
                <input
                  ref={plusFileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.json,.csv,.html,text/plain,text/markdown"
                  style={{ display: 'none' }}
                  aria-hidden
                  onChange={onPlusFilesChange}
                />
                <button
                  type="button"
                  aria-expanded={plusOpen}
                  aria-haspopup="true"
                  onClick={() => setPlusOpen((v) => !v)}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 10,
                    border: '1px solid var(--border-hi)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-mute)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon name="plus" size={18} />
                </button>
                {plusOpen && (
                  <div
                    role="menu"
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: '100%',
                      marginTop: 6,
                      width: 'min(260px, calc(100vw - 48px))',
                      background: 'var(--surface)',
                      border: '1px solid var(--border-hi)',
                      borderRadius: 'var(--radius-md)',
                      boxShadow: 'var(--shadow-lg)',
                      padding: '4px 0',
                      zIndex: 50,
                    }}
                  >
                    {plusMenuSections.map((section, si) => (
                      <div key={si}>
                        {si > 0 && <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />}
                        {section.map((row, ri) => (
                          <button
                            key={ri}
                            type="button"
                            disabled={row.disabled}
                            onClick={() => {
                              if (row.onPick) {
                                row.onPick();
                                setPlusOpen(false);
                                return;
                              }
                              if (!row.disabled) {
                                window.SHOGUN_RUNTIME?.pushToast?.('この項目は近日対応です', 'info');
                                setPlusOpen(false);
                              }
                            }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              width: '100%',
                              textAlign: 'left',
                              padding: '7px 12px',
                              fontSize: 12.5,
                              border: 'none',
                              background: 'transparent',
                              color: row.active ? 'var(--gold)' : row.disabled ? 'var(--text-dim)' : 'var(--text)',
                              cursor: row.disabled ? 'not-allowed' : 'pointer',
                              opacity: row.disabled ? 0.45 : 1,
                              fontFamily: 'var(--font-jp), var(--font-en)',
                            }}
                          >
                            <span style={{ flexShrink: 0, opacity: 0.85, display: 'inline-flex' }}>
                              <Icon name={row.icon} size={14} />
                            </span>
                            <span style={{ flex: 1 }}>{row.label}</span>
                            {row.chev && (
                              <span style={{ color: 'var(--text-dim)', display: 'inline-flex' }}>
                                <Icon name="chevronRight" size={12} />
                              </span>
                            )}
                            {row.active && (
                              <span style={{ color: 'var(--gold)', display: 'inline-flex' }}>
                                <Icon name="check" size={14} />
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  aria-label="Send"
                  onClick={goAsk}
                  className="home-send-btn"
                >
                  <Icon name="arrowUp" size={16} />
                </button>
              </div>
            </div>
          </div>

          {modalMeta && modalRows && (
            <div
              role="dialog"
              aria-modal="false"
              aria-labelledby="home-quick-prompt-title"
              style={{
                // Float below the composer without consuming column height
                // — otherwise the centered home content shifts upward every
                // time a quick-prompt category is clicked.
                position: 'absolute',
                top: 'calc(100% + 10px)',
                left: 0,
                right: 0,
                zIndex: 10,
                background: 'color-mix(in srgb, var(--surface) 88%, var(--bg))',
                border: '1px solid var(--border-hi)',
                borderRadius: 16,
                boxShadow: '0 20px 48px -16px rgba(0,0,0,0.55)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                {promptModal === 'drive' ? (
                  <ShogunDriveGlyph size={20} />
                ) : (
                  <span style={{ color: 'var(--text-mute)', display: 'inline-flex' }} aria-hidden>
                    <Icon
                      name={modalMeta.icon === 'drive' ? 'folder' : modalMeta.icon}
                      size={20}
                    />
                  </span>
                )}
                <span
                  id="home-quick-prompt-title"
                  style={{ flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text)' }}
                >
                  {pickHomeText(modalMeta, uiLang)}
                </span>
                <button
                  type="button"
                  onClick={() => setPromptModal(null)}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--text-mute)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                  aria-label="閉じる"
                >
                  <Icon name="x" size={18} />
                </button>
              </div>
              <div style={{ padding: '4px 0 6px' }}>
                {modalRows.map((line, idx) => (
                  <div key={idx}>
                    {idx > 0 && (
                      <div
                        style={{
                          height: 1,
                          margin: '0 14px',
                          background: 'var(--border)',
                        }}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        seedAndOpenChat(pickHomeText(line, uiLang));
                        setPromptModal(null);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        padding: '13px 18px',
                        fontSize: 14,
                        lineHeight: 1.55,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-jp), var(--font-en)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'color-mix(in srgb, var(--surface-2) 70%, transparent)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      {pickHomeText(line, uiLang)}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {HOME_QUICK_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setPromptModal((cur) => (cur === cat.id ? null : cat.id))}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                borderRadius: 999,
                border: '1px solid var(--border-hi)',
                background: promptModal === cat.id ? 'var(--surface-2)' : 'transparent',
                color: promptModal === cat.id ? 'var(--text)' : 'var(--text-mute)',
                fontSize: 13,
                transition: 'border-color 0.15s, color 0.15s, background 0.15s',
                fontFamily: 'var(--font-jp), var(--font-en)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--gold-dim)';
                if (promptModal !== cat.id) e.currentTarget.style.color = 'var(--text)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-hi)';
                if (promptModal !== cat.id) e.currentTarget.style.color = 'var(--text-mute)';
              }}
            >
              {cat.icon === 'drive' ? (
                <ShogunDriveGlyph size={16} />
              ) : (
                <Icon name={cat.icon} size={16} />
              )}
              {pickHomeText(cat, uiLang)}
            </button>
          ))}
        </div>
        </div>
      </div>

      {morningBrief && (
        <div className="card" style={{ width: '100%', maxWidth: 760, marginInline: 'auto', padding: 28, borderColor: 'var(--gold-dim)', marginTop: 32, background: 'var(--surface)' }}>
          <div className="row" style={{ marginBottom: 14, alignItems: 'baseline', gap: 12 }}>
            <div className="t-mono gold" style={{textTransform:'none', letterSpacing:'0.02em'}}>Morning brief · AMC</div>
            <span className="pill" style={{ fontSize: 10 }}>{morningBrief.posture}</span>
            <span className="spacer" />
            <span className="t-mono xsmall muted">{briefGeneratedDisplay || '—'}</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 18, lineHeight: 1.35 }}>{morningBrief.headline}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(morningBrief.items || []).map((item) => (
              <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
                <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span className="t-mono xsmall" style={{ color: 'var(--gold)' }}>P{item.priority}</span>
                  <span className="t-mono xsmall muted">{item.category}</span>
                  {item.time_hint && <span className="t-mono xsmall">{item.time_hint}</span>}
                  <span className="spacer" />
                  <button type="button" className="btn btn-sm btn-ghost" style={{ fontSize: 10, height: 24 }} onClick={() => dismissBriefItem(item)}>見送る</button>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{item.what}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>{item.why_now}</div>
                {(item.related_context || []).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 10 }}>
                    {(item.related_context || []).map((r) => (
                      <span key={r.uri} style={{ marginRight: 10 }}>{r.title} · {r.last_touched}</span>
                    ))}
                  </div>
                )}
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {item.next_action?.mcp_tool ? (
                    <button type="button" className="btn btn-sm btn-secondary" onClick={() => runBriefMcp(item, item.next_action.mcp_tool)}>
                      {item.next_action.label} <Icon name="arrowRight" size={14} />
                    </button>
                  ) : (
                    <span className="xsmall muted">No MCP action</span>
                  )}
                </div>
              </div>
            ))}
          </div>
          {morningBrief.deferred_count > 0 && (
            <div className="xsmall muted" style={{ marginTop: 14 }}>+ {morningBrief.deferred_count} deferred</div>
          )}
          <div className="row" style={{ marginTop: 16, gap: 6, alignItems: 'center' }}>
            <span className="xsmall muted">今日の品質 (1–5)</span>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} type="button" className="btn btn-sm btn-ghost" style={{ minWidth: 32, height: 28, fontSize: 11 }} onClick={() => submitBriefRating(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      {/* Memory digest — HIGH/MED item highlights from the last week +
          current week rollup. Surfaces here regardless of whether the
          main brief rendered, so users get value from Memory right on Home. */}
      {memoryDigest && (
        (memoryDigest.highlights && memoryDigest.highlights.length > 0) ||
        memoryDigest.week_rollup ||
        memoryDigest.day_rollup
      ) && (
        <div className="card" style={{ width: '100%', maxWidth: 760, marginInline: 'auto', padding: 24, marginTop: 18, background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
            <div className="t-mono gold" style={{ textTransform: 'none', letterSpacing: '0.02em' }}>
              <span className="en-only">Memory digest</span>
              <span className="jp">メモリのハイライト</span>
            </div>
            <span className="spacer" />
          </div>

          {memoryDigest.day_rollup && (
            <div style={{ borderLeft: '2px solid var(--gold)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                <span className="en-only">TODAY</span>
                <span className="jp">今日</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{memoryDigest.day_rollup.title}</div>
              {Array.isArray(memoryDigest.day_rollup.keyPoints) && (
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {memoryDigest.day_rollup.keyPoints.slice(0, 4).map((k, i) => (
                    <li key={i} style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {memoryDigest.week_rollup && (
            <div style={{ borderLeft: '2px solid var(--border-hi)', paddingLeft: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                <span className="en-only">THIS WEEK</span>
                <span className="jp">今週</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3 }}>{memoryDigest.week_rollup.title}</div>
              {Array.isArray(memoryDigest.week_rollup.keyPoints) && (
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {memoryDigest.week_rollup.keyPoints.slice(0, 4).map((k, i) => (
                    <li key={i} style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(() => {
            // Hide items the user already marked as read — they've been dealt with.
            // Also hide currently-snoozed items (re-surface when snooze passes).
            const nowMs = Date.now();
            const unreadHighlights = Array.isArray(memoryDigest.highlights)
              ? memoryDigest.highlights.filter((h) =>
                  !h.acknowledgedAt && !(h.snoozeUntil && h.snoozeUntil > nowMs),
                )
              : [];
            if (unreadHighlights.length === 0) return null;
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <div className="t-mono" style={{ fontSize: 10, color: 'var(--text-mute)', letterSpacing: '0.12em' }}>
                    <span className="en-only">NEEDS ATTENTION</span>
                    <span className="jp">要確認</span>
                  </div>
                  <span className="spacer" />
                  <button
                    type="button"
                    style={{
                      padding: '2px 0', border: 'none', background: 'transparent',
                      color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer',
                      fontFamily: 'inherit', textDecoration: 'underline',
                    }}
                    title="Mark all shown items as read"
                    onClick={async () => {
                      const items = unreadHighlights.map((h) => ({
                        targetId: h.targetId, targetKind: h.targetKind || 'item',
                      }));
                      if (items.length === 0) return;
                      // Optimistic UI: clear local badge + highlights immediately.
                      setMemoryDigest((prev) => prev ? {
                        ...prev,
                        highlights: (prev.highlights || []).map((h) => ({
                          ...h, acknowledgedAt: h.acknowledgedAt || Date.now(),
                        })),
                      } : prev);
                      window.dispatchEvent(new CustomEvent('shogun-memory-high-count', { detail: { count: 0 } }));
                      await runRuntimeActionA('memory.summary.acknowledge', {
                        items, acknowledged: true,
                      }, { silentError: true });
                    }}
                  >Mark all read</button>
                </div>
                {unreadHighlights.slice(0, 5).map((h) => {
                  const expanded = expandedHighlightId === h.targetId;
                  const allPoints = Array.isArray(h.keyPoints) ? h.keyPoints : [];
                  const ent = h.entityId
                    ? (entityRollupCache[h.entityId] || null)
                    : null;
                  const toggleExpand = () => {
                    if (expanded) {
                      setExpandedHighlightId(null);
                      return;
                    }
                    setExpandedHighlightId(h.targetId);
                    // Lazy-load the entity rollup the first time the user
                    // expands a highlight that has an entity_id.
                    if (h.entityId && !entityRollupCache[h.entityId]) {
                      setEntityRollupCache((prev) => ({ ...prev, [h.entityId]: { rollup: null, loading: true } }));
                      const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                      runRuntimeActionA('memory.rollup.entity.get', {
                        entityId: h.entityId, entityLabel: h.entityId, lang,
                      }, { silentError: true }).then((res) => {
                        const rollup = res?.ok && res.data?.rollup ? res.data.rollup : null;
                        setEntityRollupCache((prev) => ({ ...prev, [h.entityId]: { rollup, loading: false } }));
                      }).catch(() => {
                        setEntityRollupCache((prev) => ({ ...prev, [h.entityId]: { rollup: null, loading: false } }));
                      });
                    }
                  };
                  return (
                    <div
                      key={h.targetId}
                      role="button"
                      tabIndex={0}
                      onClick={toggleExpand}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpand(); } }}
                      style={{
                        borderLeft: (h.userPriority || h.priority) === 'high' ? '2px solid var(--gold)' : '2px solid var(--border)',
                        paddingLeft: 12,
                        display: 'flex', flexDirection: 'column', gap: expanded ? 8 : 3,
                        cursor: 'pointer',
                        transition: 'gap 120ms',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.35, wordBreak: 'break-word', flex: 1, minWidth: 0 }}>{h.title}</div>
                        <span className="t-mono" style={{ fontSize: 9, color: 'var(--text-dim)' }}>{expanded ? '−' : '+'}</span>
                      </div>
                      {!expanded && allPoints[0] && (
                        <div style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>{allPoints[0]}</div>
                      )}
                      {expanded && (
                        <>
                          {allPoints.length > 0 && (
                            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {allPoints.map((p, i) => (
                                <li key={i} style={{ fontSize: 12, color: i === 0 ? 'var(--text)' : 'var(--text-mute)', lineHeight: 1.5 }}>{p}</li>
                              ))}
                            </ul>
                          )}
                          {h.reason && (
                            <div style={{ fontSize: 10, color: 'var(--text-dim)', fontStyle: 'italic' }}>{h.reason}</div>
                          )}
                          <div className="t-mono" style={{ fontSize: 9, color: 'var(--text-dim)', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <span>{(h.sourceType || '').toUpperCase()}</span>
                            {h.entityId && <span title={h.entityId}>· entity {String(h.entityId).slice(0, 16)}…</span>}
                          </div>
                          {h.entityId && ent && (
                            <div style={{ marginTop: 4, padding: '8px 10px', background: 'color-mix(in srgb, var(--surface-2) 80%, var(--bg))', borderRadius: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div className="t-mono" style={{ fontSize: 9, color: 'var(--text-mute)', letterSpacing: '0.1em' }}>RELATED · 関連</div>
                              {ent.loading && (
                                <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                                  <span className="en-only">Loading related items…</span>
                                  <span className="jp">関連アイテムを読み込み中…</span>
                                </div>
                              )}
                              {ent.rollup && (
                                <>
                                  <div style={{ fontSize: 12, fontWeight: 500 }}>{ent.rollup.title}</div>
                                  {Array.isArray(ent.rollup.keyPoints) && ent.rollup.keyPoints.length > 0 && (
                                    <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {ent.rollup.keyPoints.slice(0, 4).map((k, i) => (
                                        <li key={i} style={{ fontSize: 11, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
                                      ))}
                                    </ul>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                await runRuntimeActionA('memory.summary.acknowledge', {
                                  items: [{ targetId: h.targetId, targetKind: h.targetKind || 'item' }],
                                  acknowledged: true,
                                }, { silentError: true });
                                // Optimistic local update.
                                setMemoryDigest((prev) => prev ? {
                                  ...prev,
                                  highlights: (prev.highlights || []).map((x) => x.targetId === h.targetId ? { ...x, acknowledgedAt: Date.now() } : x),
                                } : prev);
                              }}
                              style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                            >Mark read</button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.dispatchEvent(new Event('shogun-jump-memory-timeline'));
                                window.SHOGUN_RUNTIME?.setActiveScreen?.('memory');
                              }}
                              style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                            >Open in Memory</button>
                            {/* Snooze: defer the item until later. Hides it
                                from highlights + sidebar badge until the
                                snooze deadline passes. */}
                            {[
                              { label: '1h', label_jp: '1時間', compute: (now) => now + 60 * 60 * 1000 },
                              { label: 'Tomorrow 9am', label_jp: '明日9時', compute: (now) => smartSnoozePresets(new Date(now)).tomorrowMorning },
                              { label: 'Next Monday', label_jp: '来週月曜', compute: (now) => smartSnoozePresets(new Date(now)).nextMondayMorning },
                            ].map((opt) => (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const untilMs = opt.compute(Date.now());
                                  // Optimistic: hide locally + drop badge
                                  setMemoryDigest((prev) => prev ? {
                                    ...prev,
                                    highlights: (prev.highlights || []).map((x) => x.targetId === h.targetId ? { ...x, snoozeUntil: untilMs } : x),
                                  } : prev);
                                  await runRuntimeActionA('memory.summary.snooze', {
                                    targetId: h.targetId, targetKind: h.targetKind || 'item', untilMs,
                                  }, { silentError: true });
                                }}
                                style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                                title={`Snooze for ${opt.label}`}
                              >
                                <span className="en-only">Snooze · {opt.label}</span>
                                <span className="jp">後で · {opt.label_jp}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <div style={{ display: 'flex', gap: 8, alignSelf: 'stretch', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11 }}
              onClick={() => {
                window.dispatchEvent(new Event('shogun-jump-memory-timeline'));
                window.SHOGUN_RUNTIME?.setActiveScreen?.('memory');
              }}
            >
              <span className="en-only">Open Memory</span>
              <span className="jp">メモリを開く</span>
              <Icon name="arrowRight" size={12} />
            </button>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              style={{ fontSize: 11 }}
              title="Copy this digest as Markdown (for weekly status notes, journals, etc.)"
              onClick={async () => {
                const md = (() => {
                  // Build a Markdown representation of the current digest.
                  const lines = [];
                  const day = memoryDigest && memoryDigest.day_rollup;
                  const week = memoryDigest && memoryDigest.week_rollup;
                  const highlights = (memoryDigest && memoryDigest.highlights) || [];
                  if (day) {
                    lines.push(`## Today — ${day.title || ''}`.trim());
                    (day.keyPoints || []).forEach((k) => lines.push(`- ${k}`));
                    lines.push('');
                  }
                  if (week) {
                    lines.push(`## This week — ${week.title || ''}`.trim());
                    (week.keyPoints || []).forEach((k) => lines.push(`- ${k}`));
                    lines.push('');
                  }
                  const unread = highlights.filter((h) => !h.acknowledgedAt);
                  if (unread.length > 0) {
                    lines.push('## Needs attention');
                    unread.slice(0, 8).forEach((h) => {
                      const tag = (h.userPriority || h.priority || '').toUpperCase();
                      lines.push(`- **[${tag}] ${h.title}**${h.keyPoints && h.keyPoints[0] ? ` — ${h.keyPoints[0]}` : ''}`);
                    });
                    lines.push('');
                  }
                  if (lines.length === 0) lines.push('_(empty digest)_');
                  return lines.join('\n').trimEnd() + '\n';
                })();
                try {
                  if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(md);
                    window.SHOGUN_RUNTIME?.pushToast?.('Digest copied as Markdown', 'success');
                  } else {
                    window.SHOGUN_RUNTIME?.pushToast?.('Clipboard unavailable', 'warn');
                  }
                } catch (_) {
                  window.SHOGUN_RUNTIME?.pushToast?.('Copy failed', 'error');
                }
              }}
            >
              <Icon name="file" size={12} />
              <span className="en-only">Copy as Markdown</span>
              <span className="jp">Markdown でコピー</span>
            </button>
          </div>
        </div>
      )}

      <style>{`
        .home-composer-dropzone.is-drag-over {
          background:color-mix(in srgb, var(--gold) 6%, var(--surface) 94%);
          box-shadow:
            var(--shadow-md),
            0 0 0 3px color-mix(in srgb, var(--gold) 28%, transparent);
        }
        .home-composer-drop-hint {
          position:absolute; inset:0;
          display:flex; align-items:center; justify-content:center;
          gap:10px;
          border-radius:20px;
          background:color-mix(in srgb, var(--gold) 10%, var(--surface) 90%);
          color:var(--gold);
          font-size:14px; font-weight:500;
          letter-spacing:0.01em;
          pointer-events:none;
          z-index:2;
        }
        .home-send-btn {
          display:inline-flex; align-items:center; justify-content:center;
          width:36px; height:36px;
          border-radius:10px;
          border:0;
          background:var(--gold);
          color:#fff;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.18),
            0 1px 0 rgba(0,0,0,0.35),
            0 2px 8px -2px color-mix(in srgb, var(--gold) 55%, transparent);
          cursor:pointer;
          transition:background 160ms, transform 80ms, box-shadow 160ms, filter 160ms;
        }
        .home-send-btn:hover {
          background:var(--gold-hover);
          filter:saturate(1.35) brightness(1.06);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.28),
            0 1px 0 rgba(0,0,0,0.35),
            0 6px 18px -2px color-mix(in srgb, var(--gold) 80%, transparent);
        }
        .home-send-btn:active { transform:scale(0.96); }
        .home-send-btn:focus-visible {
          outline:2px solid var(--gold);
          outline-offset:2px;
        }
      `}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L2 · MEMORY TIMELINE — HERO
// ═══════════════════════════════════════════════════════════════════════════
function ScreenMemory() {
  const [view, setView] = useState('river');
  // Rollup cache keyed by lang. `week` is Monday-start; `day` is local midnight.
  const [digestState, setDigestState] = useState({
    week: null, day: null, loading: false, error: null, generatingWeek: false, generatingDay: false,
  });
  // { [memoryId]: workProjectId } assignment map, persisted in
  // settings.sections.workspace_memberships.memberships.
  const [workspaceAssignments, setWorkspaceAssignments] = useState({});
  const [workProjects, setWorkProjectsLocal] = useState(() => {
    const get = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.getWorkProjects;
    return typeof get === 'function' ? get() : [];
  });
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [newWorkspaceDraft, setNewWorkspaceDraft] = useState('');

  useEffect(() => {
    // Hydrate workProjects from the shell on mount and keep in sync when the
    // user creates / renames / archives one elsewhere.
    const syncProjects = () => {
      const get = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.getWorkProjects;
      if (typeof get === 'function') setWorkProjectsLocal(get());
    };
    syncProjects();
    window.addEventListener('shogun-work-projects-changed', syncProjects);
    return () => window.removeEventListener('shogun-work-projects-changed', syncProjects);
  }, []);

  useEffect(() => {
    // Load persisted { memoryId → workspaceId } map on first mount.
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
      const map = r && r.ok
        && r.data && r.data.settings && r.data.settings.sections
        && r.data.settings.sections.workspace_memberships
        && r.data.settings.sections.workspace_memberships.memberships;
      if (map && typeof map === 'object') {
        setWorkspaceAssignments(map);
      }
    });
  }, []);

  const assignMemoryToWorkspace = useCallback(async (memoryId, workspaceId) => {
    if (!memoryId) return;
    const next = { ...workspaceAssignments };
    if (workspaceId) next[memoryId] = workspaceId;
    else delete next[memoryId];
    setWorkspaceAssignments(next);
    await runRuntimeActionA(
      'settings.save',
      { section: 'workspace_memberships', memberships: next },
      { silentError: true },
    );
    // Let other screens (e.g. Work) refresh counts without polling.
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', {
        detail: { memberships: next },
      }));
    } catch (_) { /* ignore */ }
  }, [workspaceAssignments]);
  const [rawEvents, setRawEvents] = useState(() => []);
  const [summaryByMemId, setSummaryByMemId] = useState(() => ({}));
  const [batchSummarizing, setBatchSummarizing] = useState(0); // count of items being processed; 0 = idle
  const [weekRollup, setWeekRollup] = useState(null); // { title, keyPoints, reason, generatedAt } or null
  const [weekRollupLoading, setWeekRollupLoading] = useState(false);
  const [dayRollup, setDayRollup] = useState(null); // { title, keyPoints, reason, generatedAt } or null
  const [dayRollupLoading, setDayRollupLoading] = useState(false);
  const [monthRollup, setMonthRollup] = useState(null);
  const [monthRollupLoading, setMonthRollupLoading] = useState(false);
  const [yearRollup, setYearRollup] = useState(null);
  const [yearRollupLoading, setYearRollupLoading] = useState(false);
  const [scrubIdx, setScrubIdx] = useState(0);
  const [timelineSpan, setTimelineSpan] = useState('week');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date());
  const [selectedDayOffset, setSelectedDayOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState(() => ({
    sources: { screen: false, audio: true, input: true, calendar: true, mail: true },
    priority: { high: true, medium: true, low: false },
    // Filter by the raw provider source (screen captures, connector imports, ...).
    // All on by default so new users see everything they've indexed.
    providers: {
      screen: true,
      meeting: true,
      gmail: true,
      google_calendar: true,
      slack: true,
      notion: true,
      github: true,
      manual: true,
    },
  }));
  const timelineScrollRef = useRef(null);
  const scrollTimeline = useCallback((dir) => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const step = Math.max(160, Math.floor(el.clientWidth * 0.6));
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  }, []);
  const timelineMsPerSpan = useMemo(() => {
    if (timelineSpan === 'day') return 24 * 60 * 60 * 1000;
    if (timelineSpan === 'week') return 7 * 24 * 60 * 60 * 1000;
    if (timelineSpan === 'month') return 30 * 24 * 60 * 60 * 1000;
    return 365 * 24 * 60 * 60 * 1000;
  }, [timelineSpan]);
  const shiftCursor = useCallback((dir) => {
    setTimelineCursor((d) => new Date(d.getTime() + dir * timelineMsPerSpan));
  }, [timelineMsPerSpan]);
  const jumpToToday = useCallback(() => {
    setTimelineCursor(new Date());
    setSelectedDayOffset(0);
  }, []);
  const spanDayCount = useMemo(() => {
    if (timelineSpan === 'day') return 1;
    if (timelineSpan === 'week') return 7;
    if (timelineSpan === 'month') return 12; // last 12 months (one slot per month)
    return 12; // year: show 12 months as 12 slots (one per month)
  }, [timelineSpan]);
  const weekDays = useMemo(() => {
    const out = [];
    const base = new Date(timelineCursor);
    base.setHours(0, 0, 0, 0);
    if (timelineSpan === 'year') {
      // One slot per year: show last 12 years ending at cursor year.
      for (let i = 12 - 1; i >= 0; i -= 1) {
        const d = new Date(base);
        d.setMonth(0, 1);
        d.setFullYear(d.getFullYear() - i);
        out.push(d);
      }
    } else if (timelineSpan === 'month') {
      // One slot per month: show last 12 months ending at cursor month.
      for (let i = 12 - 1; i >= 0; i -= 1) {
        const d = new Date(base);
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        out.push(d);
      }
    } else {
      for (let i = spanDayCount - 1; i >= 0; i -= 1) {
        out.push(new Date(base.getTime() - i * 24 * 60 * 60 * 1000));
      }
    }
    return out;
  }, [timelineCursor, timelineSpan, spanDayCount]);
  const fmtMonthDay = (d) => d.toLocaleString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  const selectedDate = useMemo(() => {
    const last = weekDays.length - 1;
    const idx = Math.min(last, Math.max(0, last - selectedDayOffset));
    return weekDays[idx] || timelineCursor;
  }, [weekDays, selectedDayOffset, timelineCursor]);
  const fmtFullDate = (d) => {
    try { return d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }); }
    catch (_e) { return d.toDateString(); }
  };
  const fmtFullDateJp = (d) => {
    try { return d.toLocaleString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }); }
    catch (_e) { return ''; }
  };
  const rangeLabel = useMemo(() => {
    if (timelineSpan === 'day') return fmtMonthDay(weekDays[0]);
    if (timelineSpan === 'year') {
      const first = weekDays[0];
      const last = weekDays[weekDays.length - 1];
      return `${first.getFullYear()} – ${last.getFullYear()}`;
    }
    if (timelineSpan === 'month') {
      const first = weekDays[0];
      const last = weekDays[weekDays.length - 1];
      return `${first.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()} – ${last.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()}`;
    }
    return `${fmtMonthDay(weekDays[0])} – ${fmtMonthDay(weekDays[weekDays.length - 1])}`;
  }, [weekDays, timelineSpan]);
  /** Per-slot histograms:
   *  - day/week span → slot = 1 day, 12 bars (2-hour buckets)
   *  - month span    → slot = 1 month, 4 bars (weeks-within-month)
   *  - year span     → slot = 1 year, 12 bars (months-within-year)
   */
  const weekHistograms = useMemo(() => {
    let globalMax = 1;
    const src = Array.isArray(rawEvents) ? rawEvents : [];
    const perDay = weekDays.map((d) => {
      let bars;
      let count = 0;
      if (timelineSpan === 'year') {
        // Slot = one calendar year; bars[0..11] = months of that year.
        bars = new Array(12).fill(0);
        const slotYear = d.getFullYear();
        src.forEach((e) => {
          if (!Number.isFinite(e.ts)) return;
          const ed = new Date(e.ts);
          if (ed.getFullYear() !== slotYear) return;
          bars[Math.min(11, ed.getMonth())] += 1;
          count += 1;
        });
      } else if (timelineSpan === 'month') {
        // Slot = one calendar month; bars[0..3] for weeks-within-month.
        bars = new Array(4).fill(0);
        const slotYear = d.getFullYear();
        const slotMonth = d.getMonth();
        src.forEach((e) => {
          if (!Number.isFinite(e.ts)) return;
          const ed = new Date(e.ts);
          if (ed.getFullYear() !== slotYear || ed.getMonth() !== slotMonth) return;
          bars[Math.min(3, Math.floor((ed.getDate() - 1) / 7))] += 1;
          count += 1;
        });
      } else {
        bars = new Array(12).fill(0);
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const startMs = start.getTime();
        const endMs = startMs + 24 * 60 * 60 * 1000;
        src.forEach((e) => {
          if (!Number.isFinite(e.ts) || e.ts < startMs || e.ts >= endMs) return;
          const h = Math.max(0, Math.min(23, Math.floor(Number(e.h))));
          bars[Math.min(11, Math.floor(h / 2))] += 1;
          count += 1;
        });
      }
      const dayMax = bars.reduce((a, b) => Math.max(a, b), 0);
      if (dayMax > globalMax) globalMax = dayMax;
      return { bars, count, dayMax };
    });
    return { perDay, globalMax };
  }, [weekDays, rawEvents, timelineSpan]);
  const memoryTotals = useMemo(() => {
    const counts = weekHistograms.perDay.map((d) => d.count);
    const total = counts.reduce((a, b) => a + b, 0);
    return { counts, total };
  }, [weekHistograms]);
  const activeFilterCount =
    Object.values(activeFilters.sources).filter(Boolean).length +
    Object.values(activeFilters.priority).filter(Boolean).length +
    // Providers: count the ones that are explicitly OFF so the Filters button
    // advertises that results are narrowed.
    Object.values(activeFilters.providers || {}).filter((v) => v === false).length;
  const toggleFilter = useCallback((group, key) => {
    setActiveFilters((prev) => ({
      ...prev,
      [group]: { ...prev[group], [key]: !prev[group][key] },
    }));
  }, []);
  const [sourceEntities, setSourceEntities] = useState([]);
  const [semanticMemorySearch, setSemanticMemorySearch] = useState(true);
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [memorySettingsLoaded, setMemorySettingsLoaded] = useState(false);
  // Memory Digest Phase 1: River summary card state.
  const [scrubSummary, setScrubSummary] = useState(null);         // { title, keyPoints, priority, ... } or null
  const [scrubSummaryLoading, setScrubSummaryLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [summaryEnabled, setSummaryEnabled] = useState(true);     // feature flag from sections.memory.enableMemorySummary

  // Inline edit state for the scrub summary.
  // editingField: 'title' | 'reason' | `kp:${index}` | null
  const [editingField, setEditingField] = useState(null);
  const [editingDraft, setEditingDraft] = useState('');

  // Common save path. Mutates scrubSummary + summaryByMemId optimistically,
  // dispatches memory.summary.edit, rolls back on failure.
  const persistSummaryEdit = async (field, value, baseValue) => {
    const targetId = scrubbed?.memoryId;
    if (!targetId) return;
    const prevSummary = scrubSummary;
    const nextSummary = { ...prevSummary, [field]: value };
    setScrubSummary(nextSummary);
    setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
    const res = await runRuntimeActionA('memory.summary.edit', {
      targetId,
      targetKind: 'item',
      field,
      value,
      baseValue,
      sourceRaw: scrubbed?.sourceRaw || null,
      entityId: scrubbed?.entityId || null,
    }, { silentError: true });
    if (!res?.ok) {
      // Roll back.
      setScrubSummary(prevSummary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: prevSummary }));
      window.SHOGUN_RUNTIME?.pushToast?.('Failed to save edit', 'warn');
    } else if (res.data?.summary) {
      // Server-confirmed merged summary — adopt it.
      setScrubSummary(res.data.summary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
    }
  };

  // Common revert path.
  const revertSummaryField = async (field) => {
    const targetId = scrubbed?.memoryId;
    if (!targetId) return;
    const res = await runRuntimeActionA('memory.summary.revert', {
      targetId,
      targetKind: 'item',
      field,
    }, { silentError: true });
    if (res?.ok && res.data?.summary) {
      setScrubSummary(res.data.summary);
      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
    } else {
      // Restore the edit indicator: the underlying edit is still in place.
      markFieldEdited(targetId, field);
      window.SHOGUN_RUNTIME?.pushToast?.('Failed to revert', 'warn');
    }
  };

  // Predicate: did this field have at least one user edit applied?
  // We can't tell from the current Summary shape alone — it's merged on
  // the backend. Detect by comparing scrubSummary to the row's "base" via
  // a side-channel: read raw_json from the runtime if exposed, else use a
  // simple sentinel: if the edit was just done in this session, mark it.
  // For Phase 4 we use a session-local Set so the "edited" dot appears
  // immediately after a save.
  // memoryId → Set<field> of fields edited in this session. useState (not
  // useRef) so the "edited · revert" affordance re-renders when marks change,
  // including when revert IPC fails and we re-mark.
  const [editedFieldsBySummary, setEditedFieldsBySummary] = useState(new Map());
  const markFieldEdited = (memoryId, field) => {
    setEditedFieldsBySummary((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(memoryId) || []);
      set.add(field);
      next.set(memoryId, set);
      return next;
    });
  };
  const unmarkFieldEdited = (memoryId, field) => {
    setEditedFieldsBySummary((prev) => {
      const set = prev.get(memoryId);
      if (!set || !set.has(field)) return prev;
      const next = new Map(prev);
      const ns = new Set(set);
      ns.delete(field);
      next.set(memoryId, ns);
      return next;
    });
  };
  const isFieldEdited = (memoryId, field) =>
    editedFieldsBySummary.get(memoryId)?.has(field) || false;

  const timelineLoading = !memorySettingsLoaded;
  const withSemantic = useCallback(
    (payload) => {
      if (!semanticMemorySearch) return payload;
      const q = String((payload && payload.query) || '').trim();
      if (!q) return payload;
      return { ...payload, semantic: true };
    },
    [semanticMemorySearch],
  );
  const refreshSourceEntities = () => {
    runRuntimeActionA('entity.query', { query: '' }, { silentError: true }).then((res) => {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.entities)) return;
      setSourceEntities(res.data.entities);
    });
  };
  useEffect(() => {
    refreshSourceEntities();
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await runRuntimeActionA('settings.load', {}, { silentError: true });
      if (cancelled) return;
      const mem = r?.ok && r.data?.settings?.sections?.memory;
      if (mem && typeof mem === 'object' && typeof mem.semanticRerank === 'boolean') {
        setSemanticMemorySearch(mem.semanticRerank);
      }
      if (mem && typeof mem === 'object') {
        // Default to true when the flag is unset; only disable when explicitly false.
        setSummaryEnabled(mem.enableMemorySummary !== false);
      }
      const priv = r?.ok && r.data?.settings?.sections?.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
      setMemorySettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);
  const activeKinds = useMemo(
    () => Object.entries(activeFilters.sources).filter(([, on]) => on).map(([k]) => k),
    [activeFilters.sources],
  );
  // River = rawEvents filtered by priority, then screen-captures clustered
  // into sessions. Low-priority (自動通知など) items stay in Memory but are
  // hidden from the surface unless the user toggles the Low filter on.
  const events = useMemo(() => {
    const showLow = !!activeFilters.priority.low;
    const provs = activeFilters.providers || {};
    const matchesProvider = (e) => provs[memoryProviderKey(e.sourceRaw)] !== false;
    // effective = user's manual override takes precedence over LLM priority.
    const effectivePriority = (s) => (s && (s.userPriority || s.priority)) || null;
    const filtered = rawEvents.filter((e) => {
      if (!matchesProvider(e)) return false;
      if (showLow) return true;
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      if (!s) return true;
      return effectivePriority(s) !== 'low';
    });
    // Collapse consecutive capture_ax/capture_sampler items into session cards
    // so that enabling the Screen filter doesn't flood the River.
    const clustered = clusterScreenSessions(filtered);
    // Surface HIGH first, then MED, then unclassified, then LOW. Within the
    // same tier, newer events come first. This makes the top of the River
    // read as a "what needs attention" feed.
    const rank = (e) => {
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      const p = effectivePriority(s);
      if (!p) return 2; // unclassified sits between MED and LOW
      if (p === 'high') return 0;
      if (p === 'medium') return 1;
      if (p === 'low') return 3;
      return 2;
    };
    return clustered
      .slice()
      .sort((a, b) => {
        const rA = rank(a);
        const rB = rank(b);
        if (rA !== rB) return rA - rB;
        return (b.ts || 0) - (a.ts || 0);
      });
  }, [rawEvents, summaryByMemId, activeFilters.priority.low, activeFilters.providers]);
  // Batch-summarize connector items on River load so priority data is ready
  // for filtering. Cached summaries short-circuit on the backend.
  useEffect(() => {
    if (!summaryEnabled || rawEvents.length === 0) return;
    let cancelled = false;
    const connectorItems = rawEvents
      .filter((e) => {
        const r = String(e.sourceRaw || '').toLowerCase();
        const isSummarizable =
          r === 'gmail' ||
          r === 'google_calendar' ||
          r === 'meetings' ||
          r === 'meeting_note' ||
          r === 'audio_meeting' ||
          e.provenance === 'connector' ||
          e.provenance === 'meeting';
        return isSummarizable && e.memoryId && !summaryByMemId[e.memoryId];
      })
      .slice(0, 30)
      .map((e) => ({
        id: e.memoryId,
        title: e.title || '',
        snippet: e.snippet || '',
        source: e.sourceRaw || '',
      }));
    if (connectorItems.length === 0) return;
    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
    setBatchSummarizing(connectorItems.length);
    (async () => {
      try {
        const res = await runRuntimeActionA('memory.summary.batch', { items: connectorItems, lang }, { silentError: true });
        if (cancelled || !res?.ok || !res.data?.ok) return;
        const next = {};
        for (const s of res.data.ok) {
          if (s && s.targetId) next[s.targetId] = s;
        }
        if (Object.keys(next).length === 0) return;
        setSummaryByMemId((prev) => ({ ...prev, ...next }));
      } finally {
        if (!cancelled) setBatchSummarizing(0);
      }
    })();
    return () => { cancelled = true; };
    // summaryByMemId intentionally omitted: we read it inside the effect to
    // dedupe, but don't want to re-run when it changes (would thrash).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEvents, summaryEnabled]);
  // Phase 2: fetch a week rollup when the user is in Week span. The rollup
  // is cached server-side per (week_start_ms, lang), so repeated visits are
  // free. Re-runs when item summaries finish (batchSummarizing transition to 0)
  // so the rollup sees freshly classified items.
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'week') {
      setWeekRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const day = cursor.getDay();
    const mondayOffset = (day === 0 ? -6 : 1 - day);
    const monday = new Date(cursor);
    monday.setDate(cursor.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const weekStartMs = monday.getTime();
    let cancelled = false;
    setWeekRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.get', { weekStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setWeekRollup(res.data.rollup);
        } else {
          setWeekRollup(null);
        }
      } finally {
        if (!cancelled) setWeekRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  // Phase 2.5: same pattern for day rollup. Triggers when the user selects
  // the Day span so day_rollup gets generated on demand, then surfaces on
  // Home via brief.get's cache-only read.
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'day') {
      setDayRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const day = new Date(cursor);
    day.setHours(0, 0, 0, 0);
    const dayStartMs = day.getTime();
    let cancelled = false;
    setDayRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.day.get', { dayStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setDayRollup(res.data.rollup);
        } else {
          setDayRollup(null);
        }
      } finally {
        if (!cancelled) setDayRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  // Month rollup — same shape as day/week, calendar-month window.
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'month') {
      setMonthRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();
    let cancelled = false;
    setMonthRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.month.get', { monthStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setMonthRollup(res.data.rollup);
        } else {
          setMonthRollup(null);
        }
      } finally {
        if (!cancelled) setMonthRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  // Year rollup — composed from monthly rollups (cascading on miss).
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'year') {
      setYearRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const yearStart = new Date(cursor.getFullYear(), 0, 1, 0, 0, 0, 0);
    const yearStartMs = yearStart.getTime();
    let cancelled = false;
    setYearRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.year.get', { yearStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setYearRollup(res.data.rollup);
        } else {
          setYearRollup(null);
        }
      } finally {
        if (!cancelled) setYearRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
    let cancelled = false;
    (async () => {
      const res = await runRuntimeActionA('memory.search', withSemantic({ query: '', kinds: activeKinds, limit: 40 }), { silentError: true });
      if (cancelled) return;
      mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
    })();
    return () => { cancelled = true; };
  }, [memorySettingsLoaded, withSemantic, activeKinds]);
  useEffect(() => {
    const onIndexChanged = async () => {
      const r = await runRuntimeActionA('memory.search', withSemantic({ query: '', kinds: activeKinds, limit: 40 }), { silentError: true });
      mergeIndexHitsIntoRiver(r, setRawEvents, setScrubIdx);
      refreshSourceEntities();
    };
    window.addEventListener('shogun-memory-index-changed', onIndexChanged);
    return () => window.removeEventListener('shogun-memory-index-changed', onIndexChanged);
  }, [withSemantic, activeKinds]);
  useEffect(() => {
    setScrubIdx((i) => {
      if (events.length === 0) return 0;
      return Math.min(i, events.length - 1);
    });
  }, [events.length]);
  // Reset day selection when the timeline span changes so the active card
  // always points to the last slot (most-recent day/month) in the new range.
  useEffect(() => {
    setSelectedDayOffset(0);
  }, [timelineSpan]);
  useEffect(() => {
    const onJump = () => {
      setView('river');
      requestAnimationFrame(() => {
        const el = document.querySelector('.memory-scrub-stage');
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    };
    window.addEventListener('shogun-jump-memory-timeline', onJump);
    return () => window.removeEventListener('shogun-jump-memory-timeline', onJump);
  }, []);
  const { bins, maxBin } = useMemo(() => {
    const binCount = 64;
    const b = new Array(binCount).fill(0);
    events.forEach((e) => {
      const p = Math.max(0, Math.min(1, (e.h - 6) / (22 - 6)));
      b[Math.floor(p * (binCount - 1))] += e.big ? 2 : 1;
    });
    return { bins: b, maxBin: Math.max(...b, 1) };
  }, [events]);
  const scrubbed = timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null }
    : events.length
      ? events[Math.min(scrubIdx, events.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null };
  const srcIcon = s => s==='chat'?'chat':s==='meet'?'calendar':s==='note'?'note':s==='mail'?'mail':s==='agent'?'bot':s==='code'?'terminal':'file';
  const srcLabel = s => ({chat:'Conversation',meet:'Meeting',note:'Note',mail:'Email',agent:'Agent run',code:'Code'})[s]||'Event';

  // Memory Digest Phase 1: Fetch a summary for the currently scrubbed item when
  // it comes from a connector source (gmail / google_calendar). Screen/meeting
  // items stay on the raw snippet for now.
  useEffect(() => {
    // Guard: feature flag OFF → always show raw, skip fetch.
    if (!summaryEnabled) {
      setScrubSummary(null);
      setShowRaw(true);
      return;
    }
    if (!scrubbed || !scrubbed.memoryId) {
      setScrubSummary(null);
      setShowRaw(false);
      return;
    }
    // Summarize connector (gmail/google_calendar) and meeting items. Screen
    // capture and other raw-only items stay on the raw snippet.
    const rawSrc = String(scrubbed.sourceRaw || '').toLowerCase();
    const isSummarizable =
      rawSrc === 'gmail' ||
      rawSrc === 'google_calendar' ||
      rawSrc === 'meetings' ||
      rawSrc === 'meeting_note' ||
      rawSrc === 'audio_meeting' ||
      scrubbed.provenance === 'connector' ||
      scrubbed.provenance === 'meeting';
    if (!isSummarizable) {
      setScrubSummary(null);
      setShowRaw(true);
      return;
    }

    setShowRaw(false);
    // Cache-first: the River batch effect likely already populated this.
    const cached = summaryByMemId[scrubbed.memoryId];
    if (cached) {
      setScrubSummary(cached);
      setScrubSummaryLoading(false);
      return;
    }
    setScrubSummary(null);
    setScrubSummaryLoading(true);

    let cancelled = false;
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.summary.get', {
          targetId: scrubbed.memoryId,
          targetKind: 'item',
          lang,
          item: {
            id: scrubbed.memoryId,
            title: scrubbed.title || '',
            snippet: scrubbed.snippet || '',
            source: scrubbed.sourceRaw || '',
          },
        }, { silentError: true });
        if (cancelled) return;
        if (res && res.ok && res.data && res.data.summary) {
          setScrubSummary(res.data.summary);
          const s = res.data.summary;
          if (s.targetId) {
            setSummaryByMemId((prev) => (prev[s.targetId] ? prev : { ...prev, [s.targetId]: s }));
          }
        } else {
          setScrubSummary(null);
        }
      } catch {
        if (!cancelled) setScrubSummary(null);
      } finally {
        if (!cancelled) setScrubSummaryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scrubbed?.memoryId, scrubbed?.sourceRaw, scrubbed?.provenance, summaryEnabled, summaryByMemId]);
  const memoryHeadDate = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }, []);

  const hourIndexFromEvents = useMemo(() => {
    const counts = new Array(24).fill(0);
    const firstIdx = new Array(24).fill(-1);
    const topPriority = new Array(24).fill(null); // best-tier priority found in the hour (or null)
    const priorityRank = (p) => (p === 'high' ? 2 : p === 'medium' ? 1 : 0);
    events.forEach((e, i) => {
      const hh = Math.floor(Number(e.h));
      const h = Math.max(0, Math.min(23, Number.isFinite(hh) ? hh : 12));
      if (firstIdx[h] < 0) firstIdx[h] = i;
      counts[h] += 1;
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      const p = s && (s.userPriority || s.priority);
      if (p === 'high' || p === 'medium') {
        if (priorityRank(p) > priorityRank(topPriority[h])) {
          topPriority[h] = p;
        }
      }
    });
    const maxC = Math.max(1, ...counts);
    return { counts, firstIdx, maxC, topPriority };
  }, [events, summaryByMemId]);

  const timeSpanLabel = useMemo(() => {
    if (!events.length) return '—';
    const hs = events.map((e) => Number(e.h)).filter((n) => Number.isFinite(n));
    if (!hs.length) return '—';
    const mn = Math.min(...hs);
    const mx = Math.max(...hs);
    const fmt = (x) => {
      const h = Math.floor(x);
      const m = Math.round((x - h) * 60) % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    return `${fmt(mn)}–${fmt(mx)}`;
  }, [events]);

  return (
    <div className="content-inner wide memory-screen" style={{padding:0, height:'100%', display:'flex', flexDirection:'column', overflowY:'auto'}}>
      {/* Header */}
      <div style={{padding:'24px 40px 0', display:'flex', alignItems:'flex-start', gap:20, flexWrap:'wrap'}}>
        <div style={{flex:1, minWidth:240}}>
          <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)'}}>Memory / Timeline</div>
          <h1 style={{margin:'10px 0 0', fontSize:32, fontWeight:600, letterSpacing:'-0.02em'}}>
            <span className="en-only">{fmtFullDate(selectedDate)}</span>
            <span className="jp" style={{display:'block', fontSize:14, color:'var(--text-mute)', fontWeight:400, marginTop:4}}>{fmtFullDateJp(selectedDate)}</span>
          </h1>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
          <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:999, padding:2, background:'var(--surface)'}}>
            {[['river','River'],['kakejiku','Kakejiku'],['heatmap','Heatmap'],['digest','Digest'],['search','Search']].map(([k,l])=>(
              <button key={k} type="button" onClick={()=>setView(k)} style={{
                padding:'6px 14px', borderRadius:999, border:'none',
                background: view===k ? 'var(--surface-2)' : 'transparent',
                color: view===k ? 'var(--text)' : 'var(--text-mute)',
                fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            ))}
          </div>
          <div style={{position:'relative'}}>
            <button type="button" aria-expanded={filtersOpen} style={{
              display:'inline-flex', alignItems:'center', gap:6,
              padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)',
              background: filtersOpen ? 'var(--surface-2)' : 'var(--surface)',
              color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
            }} onClick={()=>setFiltersOpen(v=>!v)}>
              <Icon name="filter" size={12}/>
              Filters{activeFilterCount>0 ? ` · ${activeFilterCount}` : ''}
            </button>
            {filtersOpen && (
              <>
                <div role="presentation" onMouseDown={()=>setFiltersOpen(false)} style={{position:'fixed', inset:0, zIndex:40}}/>
                <div role="menu" onMouseDown={(e)=>e.stopPropagation()} style={{
                  position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:41,
                  minWidth:420, padding:10, borderRadius:12,
                  border:'1px solid var(--border-hi)', background:'var(--surface-2)',
                  boxShadow:'var(--shadow-md, 0 10px 30px rgba(0,0,0,0.25))',
                }}>
                  <div style={{ display: 'flex', gap: 20 }}>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Sources</div>
                      {[['screen','Screen capture'],['audio','Audio / Meetings'],['input','Manual input'],['calendar','Calendar'],['mail','Mail']].map(([k,l])=>(
                        <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={!!activeFilters.sources[k]} onChange={()=>toggleFilter('sources', k)}/>
                          <span>{l}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Priority</div>
                      {[['high','High'],['medium','Medium'],['low','Low']].map(([k,l])=>(
                        <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={!!activeFilters.priority[k]} onChange={()=>toggleFilter('priority', k)}/>
                          <span>{l}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Providers</div>
                      {Object.entries(MEMORY_PROVIDER_META).map(([k,meta])=>(
                        <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={activeFilters.providers?.[k] !== false} onChange={()=>toggleFilter('providers', k)}/>
                          <span style={{display:'inline-flex', alignItems:'center', gap:6}}>
                            <span style={{width:8, height:8, borderRadius:2, background: meta.color, flexShrink:0}} aria-hidden="true"/>
                            {meta.en}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{display:'flex', gap:8, marginTop:8}}>
                    <button type="button" onClick={async ()=>{
                      const kinds = Object.entries(activeFilters.sources).filter(([,on])=>on).map(([x])=>x);
                      const res = await runRuntimeActionA('memory.search', withSemantic({ query:'', kinds, limit:80 }), { successMessage:'Filters applied' });
                      mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
                      setFiltersOpen(false);
                    }} style={{flex:1, padding:'6px 10px', borderRadius:8, border:'1px solid var(--border-hi)', background:'var(--gold)', color:'var(--bg)', fontSize:12, cursor:'pointer', fontFamily:'inherit', fontWeight:500}}>Apply</button>
                    <button type="button" onClick={()=>{ setActiveFilters({
                      sources: { screen: false, audio: true, input: true, calendar: true, mail: true },
                      priority: { high: true, medium: true, low: false },
                      providers: {
                        screen: true, meeting: true, gmail: true, google_calendar: true,
                        slack: true, notion: true, github: true, manual: true,
                      },
                    }); }} style={{padding:'6px 10px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>Reset</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{padding:'20px 40px 0', display:'flex', alignItems:'center', gap:16, flexWrap:'wrap'}}>
        <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden', background:'var(--surface)'}}>
          {[['day','Day'],['week','Week'],['month','Month'],['year','Year']].map(([k,l])=>{
            const on = timelineSpan===k;
            return (
              <button key={k} type="button" onClick={()=>setTimelineSpan(k)} style={{
                padding:'7px 16px', border:'none',
                background: on?'var(--surface-2)':'transparent',
                color: on?'var(--text)':'var(--text-mute)',
                fontSize:12, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            );
          })}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:6}}>
          <button type="button" onClick={()=>shiftCursor(-1)} aria-label="Previous range" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={13}/></button>
          <span className="t-mono" style={{fontSize:13, color:'var(--text)', padding:'0 8px'}}>{rangeLabel}</span>
          <button type="button" onClick={()=>shiftCursor(1)} aria-label="Next range" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={13}/></button>
        </div>
        <button type="button" onClick={jumpToToday} style={{
          padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
        }}>
          <span className="en-only">Today</span>
          <span className="jp" style={{marginLeft:4, fontSize:11}}>· 今日</span>
        </button>
        <span style={{flex:1}}/>
        <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>{memoryTotals.total} MEMORIES · {Math.round(memoryTotals.total * 0.25)}H</span>
      </div>

      {/* Span cards — one per day/month depending on timelineSpan */}
      <div style={{padding:'18px 40px 0', display:'grid', gridTemplateColumns:`repeat(${weekDays.length}, minmax(0, 1fr))`, gap:10}}>
        {weekDays.map((d, i)=>{
          const offset = (weekDays.length - 1) - i;
          const active = offset === selectedDayOffset;
          const { bars } = weekHistograms.perDay[i] || { bars: new Array(12).fill(0) };
          const maxBar = Math.max(1, weekHistograms.globalMax);
          return (
            <button key={d.toISOString()} type="button" onClick={()=>setSelectedDayOffset(offset)} style={{
              padding:'14px 16px 12px',
              borderRadius:14,
              border: active ? '1px solid color-mix(in srgb, var(--gold) 65%, var(--border))' : '1px solid var(--border)',
              background: active ? 'color-mix(in srgb, var(--gold) 8%, var(--surface))' : 'var(--surface)',
              minHeight:96,
              display:'flex', flexDirection:'column', gap:10,
              cursor:'pointer', fontFamily:'inherit', textAlign:'left',
              boxShadow: active ? '0 0 0 1px color-mix(in srgb, var(--gold) 25%, transparent)' : 'none',
              transition: 'border-color 120ms, background 120ms',
            }}>
              <div className="t-mono" style={{fontSize:11, color: active ? 'var(--gold)' : 'var(--text-dim)', letterSpacing:'0.14em'}}>
                {timelineSpan === 'year'
                  ? String(d.getFullYear())
                  : timelineSpan === 'month'
                    ? d.toLocaleString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()
                    : fmtMonthDay(d)}
              </div>
              <div style={{position:'relative', height:28}} aria-hidden="true">
                {/* Faint grid guides so empty cells still read as a timeline */}
                <div style={{position:'absolute', inset:0, display:'flex', justifyContent:'space-between', pointerEvents:'none'}}>
                  {[0,1,2,3,4].map((k)=>(
                    <span key={k} style={{
                      width:1,
                      background: active
                        ? 'color-mix(in srgb, var(--gold) 22%, transparent)'
                        : 'color-mix(in srgb, var(--border) 90%, transparent)',
                      opacity: (k === 0 || k === 4) ? 0 : 0.55,
                    }}/>
                  ))}
                </div>
                <div style={{display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:2, height:'100%'}}>
                  {bars.map((v, j)=>{
                    const h = v > 0 ? Math.round((v / maxBar) * 22) + 4 : 3;
                    return (
                      <span key={j} style={{
                        flex:'1 1 0',
                        height: h,
                        borderRadius:2,
                        background: active
                          ? (v > 0 ? 'var(--gold)' : 'color-mix(in srgb, var(--gold) 18%, transparent)')
                          : (v > 0 ? 'var(--border-hi)' : 'var(--border)'),
                        opacity: active ? (v > 0 ? 0.95 : 0.4) : (v > 0 ? 0.7 : 0.45),
                      }}/>
                    );
                  })}
                </div>
              </div>
              <div className="t-mono" style={{
                display:'flex',
                justifyContent:'space-between',
                fontSize:9,
                color: active ? 'color-mix(in srgb, var(--gold) 70%, var(--text-dim))' : 'var(--text-dim)',
                letterSpacing:0,
                opacity:0.75,
                marginTop:3,
                pointerEvents:'none',
              }} aria-hidden="true">
                {timelineSpan === 'year' ? (
                  <>
                    <span>Jan</span>
                    <span>Dec</span>
                  </>
                ) : timelineSpan === 'month' ? (
                  <>
                    <span>W1</span>
                    <span>W4</span>
                  </>
                ) : (
                  <>
                    <span>0</span>
                    <span>12</span>
                    <span>24</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Day rollup banner — reflection digest for the selected day. */}
      {timelineSpan === 'day' && summaryEnabled && (dayRollup || dayRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">DAY ROLLUP</span>
                <span className="jp">本日のまとめ</span>
              </span>
              {dayRollupLoading && !dayRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {dayRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const day = new Date(timelineCursor);
                    day.setHours(0, 0, 0, 0);
                    setDayRollupLoading(true);
                    setDayRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.day.get', {
                      dayStartMs: day.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setDayRollup(res.data.rollup);
                    setDayRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate today's rollup"
                >Regenerate</button>
              )}
            </div>
            {dayRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {dayRollup.title}
                </div>
                {Array.isArray(dayRollup.keyPoints) && dayRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {dayRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Week rollup banner — synthesized digest for the selected week. */}
      {timelineSpan === 'week' && summaryEnabled && (weekRollup || weekRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">WEEK ROLLUP</span>
                <span className="jp">週次サマリ</span>
              </span>
              {weekRollupLoading && !weekRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {weekRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const day = cursor.getDay();
                    const mondayOffset = (day === 0 ? -6 : 1 - day);
                    const monday = new Date(cursor);
                    monday.setDate(cursor.getDate() + mondayOffset);
                    monday.setHours(0, 0, 0, 0);
                    setWeekRollupLoading(true);
                    setWeekRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.get', {
                      weekStartMs: monday.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setWeekRollup(res.data.rollup);
                    setWeekRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this week's rollup"
                >Regenerate</button>
              )}
            </div>
            {weekRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {weekRollup.title}
                </div>
                {Array.isArray(weekRollup.keyPoints) && weekRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {weekRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Month rollup banner — synthesized digest for the selected calendar month. */}
      {timelineSpan === 'month' && summaryEnabled && (monthRollup || monthRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">MONTH ROLLUP</span>
                <span className="jp">今月のまとめ</span>
              </span>
              {monthRollupLoading && !monthRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {monthRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
                    setMonthRollupLoading(true);
                    setMonthRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.month.get', {
                      monthStartMs: monthStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setMonthRollup(res.data.rollup);
                    setMonthRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this month's rollup"
                >Regenerate</button>
              )}
            </div>
            {monthRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {monthRollup.title}
                </div>
                {Array.isArray(monthRollup.keyPoints) && monthRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {monthRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Year rollup banner — composed from the year's 12 monthly rollups. */}
      {timelineSpan === 'year' && summaryEnabled && (yearRollup || yearRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">YEAR ROLLUP</span>
                <span className="jp">今年のまとめ</span>
              </span>
              {yearRollupLoading && !yearRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {yearRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const yearStart = new Date(cursor.getFullYear(), 0, 1, 0, 0, 0, 0);
                    setYearRollupLoading(true);
                    setYearRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.year.get', {
                      yearStartMs: yearStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setYearRollup(res.data.rollup);
                    setYearRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this year's rollup (cached monthly rollups are reused)"
                >Regenerate</button>
              )}
            </div>
            {yearRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {yearRollup.title}
                </div>
                {Array.isArray(yearRollup.keyPoints) && yearRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {yearRollup.keyPoints.slice(0, 6).map((k, i) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* River view: two-card split + hourly timeline scrubber */}
      {view === 'river' && (
      <>
      <div className="memory-scrub-stage" style={{padding:'24px 40px 24px', display:'grid', gridTemplateColumns:'minmax(0, 1fr) minmax(0, 1fr)', gap:20, minHeight:420}}>
        {/* Left: the scrubbed memory */}
        <div style={{
          padding:'24px 26px',
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--surface) 94%, var(--bg))',
          display:'flex', flexDirection:'column',
        }}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <div style={{width:32, height:32, borderRadius:8, background:'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gold)'}}>
              <Icon name={srcIcon(scrubbed.src)} size={15}/>
            </div>
            <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>
              {srcLabel(scrubbed.src).toUpperCase()} · {scrubbed.t}
            </div>
            {(() => {
              const pk = memoryProviderKey(scrubbed.sourceRaw);
              const meta = MEMORY_PROVIDER_META[pk];
              if (!meta) return null;
              return (
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:5,
                  padding:'2px 7px', borderRadius:4,
                  border:`1px solid color-mix(in srgb, ${meta.color} 50%, var(--border))`,
                  background:`color-mix(in srgb, ${meta.color} 10%, transparent)`,
                  color: meta.color,
                  fontSize:10, letterSpacing:'0.06em',
                  fontFamily:'var(--font-mono)',
                }}>
                  <span style={{width:6, height:6, borderRadius:'50%', background: meta.color}} aria-hidden="true"/>
                  {meta.en}
                </span>
              );
            })()}
            {events.length > 0 && !timelineLoading && (
              <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:4}}>
                <button
                  type="button"
                  aria-label="Previous memory"
                  onClick={() => setScrubIdx((i) => Math.max(0, i - 1))}
                  disabled={scrubIdx === 0}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx === 0 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx === 0 ? 0.35 : 1}}
                ><Icon name="chevronLeft" size={11}/></button>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'0 2px'}}>
                  {Math.min(scrubIdx + 1, events.length)} / {events.length}
                  {rawEvents.length > events.length && (
                    <span style={{marginLeft:6, color:'var(--text-mute)'}} title="Low-priority items hidden. Toggle in Filters to show.">
                      (+{rawEvents.length - events.length})
                    </span>
                  )}
                  {batchSummarizing > 0 && (
                    <span style={{marginLeft:8, color:'var(--gold)'}} title={`Summarizing ${batchSummarizing} item(s)…`}>
                      · summarizing {batchSummarizing}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label="Next memory"
                  onClick={() => setScrubIdx((i) => Math.min(events.length - 1, i + 1))}
                  disabled={scrubIdx >= events.length - 1}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx >= events.length - 1 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx >= events.length - 1 ? 0.35 : 1}}
                ><Icon name="chevronRight" size={11}/></button>
              </div>
            )}
          </div>
          {timelineLoading && (
            <>
              <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
                <span className="muted" style={{fontWeight:400, fontSize:16}}>
                  <span className="en-only">Loading timeline…</span>
                  <span className="jp">読み込み中…</span>
                </span>
              </h2>
              <p style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap'}}>
                <span className="muted">
                  <span className="en-only">Applying Memory search preferences before the first fetch.</span>
                  <span className="jp" style={{display:'block', marginTop:4}}>初回取得の前に設定を適用しています。</span>
                </span>
              </p>
            </>
          )}
          {!timelineLoading && (
            <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:12}}>
              {scrubbed.memoryId && (
                <span className="label">index</span>
              )}
              {scrubbed.provenance && (
                <span className="label" style={{borderColor:'var(--gold-dim)', color:'var(--gold)'}} title={scrubbed.sourceRaw || ''}>
                  <span className="en-only">{memoryProvenanceLabel(scrubbed.provenance).en}</span>
                  <span className="jp" style={{fontSize:10}}>{memoryProvenanceLabel(scrubbed.provenance).jp}</span>
                </span>
              )}
              {scrubbed.entityId && (
                <span className="label t-mono" style={{fontSize:9, maxWidth:140, overflow:'hidden', textOverflow:'ellipsis'}} title={scrubbed.entityId}>
                  id · {scrubbed.entityId.slice(0, 24)}{scrubbed.entityId.length > 24 ? '…' : ''}
                </span>
              )}
            </div>
          )}
          {!timelineLoading && scrubSummary && !showRaw && (() => {
            const effPriority = scrubSummary.userPriority || scrubSummary.priority;
            const pinned = !!scrubSummary.userPriority;
            const setPinPriority = async (tier) => {
              if (!scrubbed?.memoryId) return;
              const targetId = scrubbed.memoryId;
              // Clicking the currently-active tier clears the override.
              const nextValue = tier === scrubSummary.userPriority ? null : tier;
              // Optimistic update.
              const nextSummary = { ...scrubSummary, userPriority: nextValue };
              setScrubSummary(nextSummary);
              setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
              await runRuntimeActionA('memory.summary.set_priority', {
                targetId, targetKind: 'item', priority: nextValue,
              }, { silentError: true });
            };
            return (
            <div className="memory-summary-card" style={{
              display:'flex', flexDirection:'column', gap:10,
              marginBottom:14,
              borderLeft: effPriority === 'high'
                ? '2px solid var(--gold)'
                : '2px solid var(--border)',
              paddingLeft:14,
            }}>
              <div style={{display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap'}}>
                {editingField === 'title' ? (
                  <textarea
                    autoFocus
                    aria-label="Edit title"
                    value={editingDraft}
                    onChange={(e) => setEditingDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        e.currentTarget.blur(); // triggers onBlur save
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        setEditingField(null);
                        setEditingDraft('');
                      }
                    }}
                    onBlur={async () => {
                      const next = editingDraft.trim();
                      const base = (scrubSummary?.title || '').trim();
                      setEditingField(null);
                      setEditingDraft('');
                      if (next && next !== base) {
                        // Guard scrubbed.memoryId — if the user navigated away
                        // mid-edit, scrubbed could be null. persistSummaryEdit
                        // also no-ops when targetId is missing, but we shouldn't
                        // crash on the markFieldEdited call.
                        if (scrubbed?.memoryId) {
                          markFieldEdited(scrubbed.memoryId, 'title');
                        }
                        await persistSummaryEdit('title', next, base);
                      }
                    }}
                    style={{
                      flex: 1, minWidth: 0,
                      fontSize: 18, fontWeight: 600, lineHeight: 1.3,
                      fontFamily: 'inherit', color: 'var(--text)',
                      background: 'var(--surface-mute)',
                      border: '1px solid var(--border-hi)', borderRadius: 4,
                      padding: '4px 6px', resize: 'vertical', minHeight: 32,
                    }}
                  />
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label="Edit title"
                    onClick={() => {
                      setEditingDraft(scrubSummary?.title || '');
                      setEditingField('title');
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditingDraft(scrubSummary?.title || '');
                        setEditingField('title');
                      }
                    }}
                    style={{
                      fontSize: 18, fontWeight: 600, lineHeight: 1.3,
                      wordBreak: 'break-word', flex: 1, minWidth: 0,
                      cursor: 'text',
                    }}
                  >
                    {scrubSummary.title}
                    {isFieldEdited(scrubbed?.memoryId, 'title') && (
                      <span
                        title="Edited by you"
                        style={{
                          marginLeft: 6, fontSize: 10, color: 'var(--text-dim)',
                          letterSpacing: '0.06em', cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          unmarkFieldEdited(scrubbed.memoryId, 'title');
                          revertSummaryField('title');
                        }}
                      >
                        edited · revert
                      </span>
                    )}
                  </div>
                )}
                {pinned && (
                  <span className="t-mono" style={{fontSize:9, color:'var(--gold)', letterSpacing:'0.12em', padding:'2px 6px', border:'1px solid var(--gold-dim)', borderRadius:4}}>
                    <span className="en-only">PINNED</span>
                    <span className="jp">手動</span>
                  </span>
                )}
              </div>
              {Array.isArray(scrubSummary.keyPoints) && (
                <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                  {scrubSummary.keyPoints.map((k, i) => {
                    const editKey = `kp:${i}`;
                    if (editingField === editKey) {
                      return (
                        <li key={`edit-${i}`} style={{listStyle:'none', marginLeft:-16}}>
                          <input
                            autoFocus
                            type="text"
                            aria-label={`Edit key point ${i + 1}`}
                            value={editingDraft}
                            onChange={(e) => setEditingDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setEditingField(null);
                                setEditingDraft('');
                              }
                            }}
                            onBlur={async () => {
                              const next = editingDraft;
                              const baseArr = Array.isArray(scrubSummary?.keyPoints) ? scrubSummary.keyPoints : [];
                              const baseValue = baseArr[i] || '';
                              setEditingField(null);
                              setEditingDraft('');
                              const trimmed = next.trim();
                              if (!trimmed) {
                                // Empty save = remove this entry.
                                if (baseValue) {
                                  const newArr = baseArr.filter((_, idx) => idx !== i);
                                  if (scrubbed?.memoryId) {
                                    markFieldEdited(scrubbed.memoryId, 'keyPoints');
                                  }
                                  await persistSummaryEdit('keyPoints', newArr, baseArr);
                                }
                                return;
                              }
                              if (trimmed !== baseValue) {
                                const newArr = baseArr.map((v, idx) => (idx === i ? trimmed : v));
                                if (scrubbed?.memoryId) {
                                  markFieldEdited(scrubbed.memoryId, 'keyPoints');
                                }
                                await persistSummaryEdit('keyPoints', newArr, baseArr);
                              }
                            }}
                            style={{
                              width: '100%', boxSizing: 'border-box',
                              fontSize: 13, color: 'var(--text)',
                              fontFamily: 'inherit',
                              background: 'var(--surface-mute)',
                              border: '1px solid var(--border-hi)', borderRadius: 4,
                              padding: '2px 6px',
                            }}
                          />
                        </li>
                      );
                    }
                    return (
                      <li
                        key={i}
                        role="button"
                        tabIndex={0}
                        aria-label={`Edit key point ${i + 1}`}
                        onClick={() => {
                          setEditingDraft(k);
                          setEditingField(editKey);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setEditingDraft(k);
                            setEditingField(editKey);
                          }
                        }}
                        style={{
                          fontSize:13,
                          color: i === 0 ? 'var(--text)' : 'var(--text-mute)',
                          lineHeight:1.5, cursor:'text',
                        }}
                      >
                        {k}
                      </li>
                    );
                  })}
                  <li style={{listStyle:'none', marginLeft:-16}}>
                    <button
                      type="button"
                      onClick={() => {
                        const baseArr = Array.isArray(scrubSummary?.keyPoints) ? scrubSummary.keyPoints : [];
                        const newArr = [...baseArr, ''];
                        // Optimistically extend, then enter edit mode for the new index.
                        const targetId = scrubbed?.memoryId;
                        const nextSummary = { ...scrubSummary, keyPoints: newArr };
                        setScrubSummary(nextSummary);
                        setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
                        setEditingDraft('');
                        setEditingField(`kp:${newArr.length - 1}`);
                      }}
                      style={{
                        padding: '2px 0', border: 'none', background: 'transparent',
                        color: 'var(--text-dim)', fontSize: 11, cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      + Add point
                    </button>
                  </li>
                  {isFieldEdited(scrubbed?.memoryId, 'keyPoints') && (
                    <li style={{listStyle:'none', marginLeft:-16}}>
                      <span
                        title="Edited by you"
                        style={{
                          fontSize: 10, color: 'var(--text-dim)',
                          letterSpacing: '0.06em', cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                        onClick={() => {
                          unmarkFieldEdited(scrubbed.memoryId, 'keyPoints');
                          revertSummaryField('keyPoints');
                        }}
                      >
                        edited · revert
                      </span>
                    </li>
                  )}
                </ul>
              )}
              <div style={{display:'flex', gap:14, marginTop:2, alignItems:'center', flexWrap:'wrap'}}>
                {/* Priority override: click a tier to pin; click the active tier again to clear. */}
                <div style={{display:'flex', gap:4, alignItems:'center'}} title="Set the priority for this item. Click the active tier to clear the override.">
                  <span className="t-mono" style={{fontSize:9, color:'var(--text-dim)', letterSpacing:'0.1em', marginRight:2}}>PIN</span>
                  {[{k:'high', label:'H'}, {k:'medium', label:'M'}, {k:'low', label:'L'}].map(({k, label}) => {
                    const active = effPriority === k;
                    const isOverride = scrubSummary.userPriority === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPinPriority(k)}
                        style={{
                          width:18, height:18, padding:0,
                          border:'1px solid ' + (active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'var(--border)'),
                          background: active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'transparent',
                          color: active ? 'var(--bg)' : 'var(--text-dim)',
                          fontFamily: 'inherit', fontSize: 10, fontWeight: isOverride ? 700 : 500,
                          borderRadius: 3, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >{label}</button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => setShowRaw(true)} style={{
                  padding:'4px 0', borderRadius:0, border:'none',
                  background:'transparent', color:'var(--text-dim)', fontSize:11, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline',
                }}>Show raw</button>
                <button
                  type="button"
                  disabled={scrubSummaryLoading}
                  onClick={async () => {
                    if (!scrubbed?.memoryId) return;
                    const targetId = scrubbed.memoryId;
                    setScrubSummaryLoading(true);
                    setScrubSummary(null);
                    setSummaryByMemId((prev) => {
                      const next = { ...prev };
                      delete next[targetId];
                      return next;
                    });
                    await runRuntimeActionA('memory.summary.invalidate', {
                      targetId, targetKind: 'item',
                    }, { silentError: true });
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.summary.get', {
                      targetId, targetKind: 'item', lang,
                      item: {
                        id: targetId,
                        title: scrubbed.title || '',
                        snippet: scrubbed.snippet || '',
                        source: scrubbed.sourceRaw || '',
                      },
                    }, { silentError: true });
                    if (res?.ok && res.data?.summary) {
                      setScrubSummary(res.data.summary);
                      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
                    }
                    setScrubSummaryLoading(false);
                  }}
                  style={{
                    padding:'4px 0', borderRadius:0, border:'none',
                    background:'transparent',
                    color: scrubSummaryLoading ? 'var(--text-mute)' : 'var(--text-dim)',
                    fontSize:11,
                    cursor: scrubSummaryLoading ? 'default' : 'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                    opacity: scrubSummaryLoading ? 0.5 : 1,
                  }}
                  title="Regenerate this summary (clears cache)"
                >
                  {scrubSummaryLoading ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>
            </div>
            );
          })()}
          {!timelineLoading && scrubSummaryLoading && !scrubSummary && (
            <div style={{padding:'20px 18px', marginBottom:16, color:'var(--text-dim)', fontSize:13, textAlign:'center', border:'1px solid var(--border)', borderRadius:12, background:'var(--surface)'}}>
              <span className="en-only">Generating summary…</span>
              <span className="jp">要約を生成中…</span>
            </div>
          )}
          {!timelineLoading && (showRaw || (!scrubSummary && !scrubSummaryLoading)) && (
            <>
              <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
                {renderHighlighted(scrubbed.titleHighlight || scrubbed.title)}
              </h2>
              {scrubbed.clusterCount > 1 && (
                <div className="t-mono" style={{margin:'-8px 0 14px', fontSize:11, color:'var(--text-dim)', letterSpacing:'0.06em'}}>
                  {scrubbed.clusterCount} captures · {new Date(scrubbed.clusterStart).toTimeString().slice(0,5)}
                  {' – '}
                  {new Date(scrubbed.clusterEnd).toTimeString().slice(0,5)}
                </div>
              )}
              <div style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap', maxHeight:320, overflowY:'auto', wordBreak:'break-word'}}>
                {scrubbed.snippetHighlight
                  ? renderHighlighted(scrubbed.snippetHighlight)
                  : scrubbed.snippet || (events.length ? 'No snippet text for this entry.' : 'No memories in the index yet.')}
              </div>
              {scrubSummary && (
                <div style={{marginBottom:16}}>
                  <button type="button" onClick={() => setShowRaw(false)} style={{
                    padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)',
                    background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
                  }}>Show summary</button>
                </div>
              )}
            </>
          )}
          <span style={{flex:1}}/>
          <div style={{display:'flex', gap:8, marginTop:18, paddingTop:14, borderTop:'1px solid var(--border)', flexWrap:'wrap', alignItems:'center', position:'relative'}}>
            {scrubbed.memoryId && !timelineLoading && (
              <button
                type="button"
                onClick={() => {
                  openMemoryEntryInChat(
                    { title: scrubbed.title, snippet: scrubbed.snippet },
                    {
                      memoryAssemblyQuery: scrubbed.title,
                      memoryAssemblyLimit: 14,
                      allowServerMemoryAssembly,
                      newChat: true,
                    },
                  );
                }}
                style={{display:'inline-flex', alignItems:'center', gap:6, padding:'7px 12px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}
              >
                <Icon name="chat" size={13}/>
                <span className="en-only">Open in Chat</span>
                <span className="jp" style={{fontSize:11}}>チャットへ</span>
              </button>
            )}
            {scrubbed.memoryId && !timelineLoading && (() => {
              const assignedId = workspaceAssignments[scrubbed.memoryId];
              const assignedProject = assignedId
                ? workProjects.find((p) => p.id === assignedId)
                : null;
              const label = assignedProject ? assignedProject.name : 'Assign to workspace';
              return (
                <>
                  <button
                    type="button"
                    onClick={() => setAssignMenuOpen((v) => !v)}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6,
                      padding:'7px 12px', borderRadius:10,
                      border:'1px solid ' + (assignedProject ? 'var(--gold-dim)' : 'var(--border)'),
                      background: assignedProject ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
                      color: assignedProject ? 'var(--gold)' : 'var(--text-mute)',
                      fontSize:12, cursor:'pointer', fontFamily:'inherit', maxWidth:240,
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                    }}
                  >
                    <Icon name="work" size={13}/>
                    <span style={{overflow:'hidden', textOverflow:'ellipsis'}}>{label}</span>
                  </button>
                  {assignMenuOpen && (
                    <>
                      <div role="presentation" onMouseDown={()=>setAssignMenuOpen(false)} style={{position:'fixed', inset:0, zIndex:40}}/>
                      <div
                        role="menu"
                        onMouseDown={(e)=>e.stopPropagation()}
                        style={{
                          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:41,
                          minWidth:240, padding:6, borderRadius:10,
                          border:'1px solid var(--border-hi)', background:'var(--surface-2)',
                          boxShadow:'0 10px 30px rgba(0,0,0,0.35)',
                          display:'flex', flexDirection:'column', gap:2,
                          maxHeight:280, overflowY:'auto',
                        }}
                      >
                        {workProjects.length === 0 && (
                          <div style={{padding:'8px 10px', fontSize:12, color:'var(--text-dim)'}}>
                            No workspaces yet.
                          </div>
                        )}
                        {workProjects
                          .filter((p) => !p.archived)
                          .map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={async () => {
                                await assignMemoryToWorkspace(scrubbed.memoryId, p.id);
                                setAssignMenuOpen(false);
                              }}
                              style={{
                                textAlign:'left', padding:'8px 10px', borderRadius:6,
                                border:0, background: p.id === assignedId ? 'color-mix(in srgb, var(--gold) 12%, transparent)' : 'transparent',
                                color: 'var(--text)', fontSize:13, cursor:'pointer',
                                display:'flex', alignItems:'center', gap:8, fontFamily:'inherit',
                              }}
                            >
                              <Icon name="work" size={12} className={p.id === assignedId ? 'gold' : 'dim'}/>
                              <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{p.name}</span>
                              {p.id === assignedId && <Icon name="check" size={11} className="gold"/>}
                            </button>
                          ))}
                        {assignedId && (
                          <button
                            type="button"
                            onClick={async () => {
                              await assignMemoryToWorkspace(scrubbed.memoryId, null);
                              setAssignMenuOpen(false);
                            }}
                            style={{
                              textAlign:'left', padding:'8px 10px', borderRadius:6,
                              border:0, background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer',
                              borderTop:'1px solid var(--border)', marginTop:2, fontFamily:'inherit',
                            }}
                          >
                            Unassign
                          </button>
                        )}
                        <div style={{borderTop:'1px solid var(--border)', marginTop:4, paddingTop:6, display:'flex', gap:6}}>
                          <input
                            type="text"
                            value={newWorkspaceDraft}
                            onChange={(e) => setNewWorkspaceDraft(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key !== 'Enter') return;
                              const name = newWorkspaceDraft.trim();
                              if (!name) return;
                              const create = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.createWorkProject;
                              const newId = typeof create === 'function' ? create(name) : null;
                              if (newId) {
                                setNewWorkspaceDraft('');
                                await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                                setAssignMenuOpen(false);
                              }
                            }}
                            placeholder="New workspace…"
                            style={{
                              flex:1, padding:'6px 8px', borderRadius:6,
                              border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)',
                              fontSize:12, fontFamily:'inherit',
                            }}
                          />
                          <button
                            type="button"
                            onClick={async () => {
                              const name = newWorkspaceDraft.trim();
                              if (!name) return;
                              const create = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.createWorkProject;
                              const newId = typeof create === 'function' ? create(name) : null;
                              if (newId) {
                                setNewWorkspaceDraft('');
                                await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                                setAssignMenuOpen(false);
                              }
                            }}
                            disabled={!newWorkspaceDraft.trim()}
                            style={{
                              padding:'6px 10px', borderRadius:6,
                              border:'1px solid var(--border-hi)',
                              background:'var(--surface)', color:'var(--text)',
                              fontSize:12, cursor: newWorkspaceDraft.trim() ? 'pointer' : 'default',
                              opacity: newWorkspaceDraft.trim() ? 1 : 0.5,
                              fontFamily:'inherit',
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              );
            })()}
            <span style={{flex:1}}/>
          </div>
        </div>

        {/* Right: details panel */}
        <div style={{
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--bg) 60%, var(--surface))',
          overflow:'hidden',
          display:'flex', flexDirection:'column',
        }}>
          <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
            <Icon name="memory" size={14} className="gold"/>
            <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>
              <span className="en-only">Memory details</span>
              <span className="jp" style={{marginLeft:6, fontSize:10}}>メモリ詳細</span>
            </span>
          </div>
          <div style={{flex:1, padding:'18px 22px', display:'flex', flexDirection:'column', gap:14, minHeight:280, overflowY:'auto'}}>
            {scrubbed.memoryId ? (
              <>
                <div style={{display:'grid', gridTemplateColumns:'110px 1fr', rowGap:10, columnGap:12, fontSize:12}}>
                  <span className="t-mono" style={{color:'var(--text-dim)'}}>Source</span>
                  <span style={{color:'var(--text)', wordBreak:'break-word'}}>{scrubbed.sourceRaw || srcLabel(scrubbed.src)}</span>
                  <span className="t-mono" style={{color:'var(--text-dim)'}}>Captured</span>
                  <span style={{color:'var(--text)'}}>{scrubbed.t}</span>
                  {scrubSummary && scrubSummary.priority && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Priority</span>
                      <span style={{color:'var(--text)'}}>{String(scrubSummary.priority).toUpperCase()}</span>
                    </>
                  )}
                  {scrubSummary && scrubSummary.reason && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Reason</span>
                      <span style={{color:'var(--text-mute)', wordBreak:'break-word', fontSize:12}}>{scrubSummary.reason}</span>
                    </>
                  )}
                  {scrubbed.entityId && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Entity</span>
                      <span className="t-mono" style={{color:'var(--text-mute)', wordBreak:'break-all', fontSize:11}}>{scrubbed.entityId}</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'var(--text-dim)', fontSize:13, textAlign:'center', padding:'0 20px'}}>
                <Icon name="memory" size={22}/>
                <span className="en-only">Select a memory to see its details.</span>
                <span className="jp" style={{fontSize:12}}>メモリを選ぶと詳細が表示されます。</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Timeline scrubber — real events by hour */}
      <div style={{marginTop:'auto', padding:'18px 40px 28px', borderTop:'1px solid var(--border)'}}>
        <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:12}}>
          <span style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.08em', fontFamily:'inherit'}}>Timeline</span>
          <span style={{flex:1}}/>
          <button type="button" onClick={()=>scrollTimeline(-1)} aria-label="Scroll timeline left" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={12}/></button>
          <button type="button" onClick={()=>scrollTimeline(1)} aria-label="Scroll timeline right" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={12}/></button>
          <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)'}}>{events.length} events · {timeSpanLabel}</span>
        </div>
        <div
          ref={timelineScrollRef}
          role="group"
          aria-label="Event timeline"
          style={{
            overflowX:'auto',
            overflowY:'hidden',
            paddingBottom:2,
            scrollbarWidth:'thin',
            WebkitOverflowScrolling:'touch',
            width:'100%',
            maxWidth:'100%',
            minWidth:0,
          }}
        >
          <div style={{position:'relative', width: 24 * 96, height:72, flexShrink:0}}>
            <div style={{position:'absolute', inset:'0 0 26px 0', display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', alignItems:'end', gap:3}}>
              {[...Array(24)].map((_,h)=>{
                const count = hourIndexFromEvents.counts[h] || 0;
                const firstIdx = hourIndexFromEvents.firstIdx[h];
                const height = count > 0 ? Math.round((count / hourIndexFromEvents.maxC) * 42) + 6 : 4;
                const active = firstIdx >= 0 && scrubIdx >= firstIdx && scrubIdx < firstIdx + count;
                const clickable = firstIdx >= 0;
                const topTier = hourIndexFromEvents.topPriority[h];
                // Color the bar by the BEST-tier event in the hour so the eye
                // tracks "when did important stuff happen today".
                const inactiveBg = topTier === 'high'
                  ? 'var(--gold)'
                  : topTier === 'medium'
                    ? 'var(--border-hi)'
                    : 'var(--border)';
                const inactiveOpacity = topTier === 'high'
                  ? 0.9
                  : topTier === 'medium'
                    ? 0.6
                    : (clickable ? 0.4 : 0.3);
                return (
                  <button
                    key={h}
                    type="button"
                    disabled={!clickable}
                    onClick={() => { if (clickable) setScrubIdx(firstIdx); }}
                    aria-label={`${count} memories at ${String(h).padStart(2,'0')}:00${topTier ? ` (top priority: ${topTier})` : ''}`}
                    style={{
                      height,
                      padding:0,
                      border:'none',
                      background: active ? 'var(--gold)' : inactiveBg,
                      opacity: clickable ? (active ? 0.95 : inactiveOpacity) : 0.3,
                      borderRadius:2,
                      cursor: clickable ? 'pointer' : 'default',
                      transition: 'opacity 120ms, background 120ms',
                    }}
                  />
                );
              })}
            </div>
            <div className="t-mono" style={{position:'absolute', left:0, bottom:0, right:0, display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', fontSize:10, color:'var(--text-dim)'}}>
              {[...Array(24)].map((_,h)=>(
                <span key={h} style={{textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* Kakejiku view: vertical scroll feed of memories for the selected day */}
      {view === 'kakejiku' && (
        <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
          <div style={{maxWidth:820, margin:'0 auto'}}>
            {(() => {
              const dayStart = new Date(selectedDate);
              dayStart.setHours(0, 0, 0, 0);
              const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
              const dayEvents = events.filter((e) => Number.isFinite(e.ts) && e.ts >= dayStart.getTime() && e.ts < dayEnd);
              if (timelineLoading) {
                return (
                  <div className="muted" style={{padding:'40px 0', textAlign:'center', fontSize:13}}>
                    <span className="en-only">Loading timeline…</span>
                    <span className="jp" style={{display:'block', marginTop:6}}>読み込み中…</span>
                  </div>
                );
              }
              if (dayEvents.length === 0) {
                return (
                  <div style={{padding:'60px 0', textAlign:'center', color:'var(--text-dim)', fontSize:13, display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
                    <Icon name="memory" size={28}/>
                    <span className="en-only">No memories for {fmtFullDate(selectedDate)}.</span>
                    <span className="jp" style={{fontSize:12}}>{fmtFullDateJp(selectedDate)} のメモリはまだありません。</span>
                  </div>
                );
              }
              return dayEvents.map((e, i) => {
                const solid = e.src === 'agent' || e.src === 'meet';
                return (
                  <button
                    key={e.memoryId || `${e.ts}-${i}`}
                    type="button"
                    disabled={!e.memoryId}
                    onClick={() => {
                      if (!e.memoryId) return;
                      openMemoryEntryInChat(
                        { title: e.title, snippet: e.snippet },
                        { memoryAssemblyQuery: e.title, memoryAssemblyLimit: 14, allowServerMemoryAssembly },
                      );
                    }}
                    className="memory-scrub-stage"
                    style={{
                      all: 'unset',
                      display:'grid',
                      gridTemplateColumns:'76px 1px 1fr',
                      columnGap:24,
                      padding:'22px 0',
                      borderBottom:'1px solid var(--border)',
                      width:'100%',
                      boxSizing:'border-box',
                      cursor: e.memoryId ? 'pointer' : 'default',
                      fontFamily:'inherit',
                    }}
                  >
                    <div style={{textAlign:'right', paddingTop:4}}>
                      <span className="t-mono" style={{fontSize:12, color:'var(--text)', letterSpacing:'0.06em'}}>{e.t}</span>
                    </div>
                    <div style={{background:'var(--border)', alignSelf:'stretch', position:'relative'}}>
                      <span style={{
                        position:'absolute', left:-4, top:8, width:9, height:9, borderRadius:'50%',
                        background: solid ? 'var(--gold)' : 'transparent',
                        border: solid ? 'none' : '1.5px solid var(--text-mute)',
                        boxShadow:'0 0 0 3px var(--bg)',
                      }}/>
                    </div>
                    <div style={{minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
                      <div style={{display:'flex', alignItems:'center', gap:8}}>
                        <Icon name={srcIcon(e.src)} size={13} className="dim"/>
                        <span className="t-mono" style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.14em'}}>{srcLabel(e.src)}</span>
                      </div>
                      <div style={{fontSize:15, fontWeight:500, color:'var(--text)', lineHeight:1.45, wordBreak:'break-word'}}>
                        {renderHighlighted(e.titleHighlight || e.title)}
                      </div>
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Heatmap view: 7 days × 24 hours activity grid */}
      {view === 'heatmap' && (
        <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
          <div style={{maxWidth:900, margin:'0 auto'}}>
            {(() => {
              const grid = weekDays.map((d) => {
                const start = new Date(d);
                start.setHours(0, 0, 0, 0);
                const startMs = start.getTime();
                const endMs = startMs + 24 * 60 * 60 * 1000;
                const hours = new Array(24).fill(0);
                events.forEach((e) => {
                  if (!Number.isFinite(e.ts) || e.ts < startMs || e.ts >= endMs) return;
                  const hh = Math.max(0, Math.min(23, Math.floor(Number(e.h))));
                  hours[hh] += 1;
                });
                return hours;
              });
              const max = Math.max(1, ...grid.flat());
              const fmtWk = (d) => d.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();
              return (
                <div style={{display:'flex', flexDirection:'column', gap:6}}>
                  {/* hour axis */}
                  <div style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'end', paddingBottom:4}}>
                    <span/>
                    {[...Array(24)].map((_, h) => (
                      <span key={h} className="t-mono" style={{fontSize:9, color:'var(--text-dim)', textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
                    ))}
                  </div>
                  {grid.map((row, i) => {
                    const offset = 6 - i;
                    const isActiveDay = offset === selectedDayOffset;
                    return (
                      <div key={i} style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'stretch'}}>
                        <button
                          type="button"
                          onClick={() => setSelectedDayOffset(offset)}
                          className="t-mono"
                          style={{
                            all:'unset',
                            fontSize:10,
                            color: isActiveDay ? 'var(--gold)' : 'var(--text-dim)',
                            letterSpacing:'0.14em',
                            cursor:'pointer',
                            paddingRight:8,
                            textAlign:'right',
                            alignSelf:'center',
                          }}
                          title={weekDays[i].toDateString()}
                        >
                          {fmtWk(weekDays[i])}
                        </button>
                        {row.map((v, h) => {
                          const intensity = v / max;
                          const bg = v === 0
                            ? 'var(--border)'
                            : `color-mix(in srgb, var(--gold) ${Math.round(15 + intensity * 75)}%, var(--surface))`;
                          return (
                            <span
                              key={h}
                              title={`${fmtWk(weekDays[i])} ${String(h).padStart(2,'0')}:00 · ${v} ${v === 1 ? 'memory' : 'memories'}`}
                              style={{
                                height:24,
                                borderRadius:4,
                                background: bg,
                                outline: isActiveDay ? '1px solid color-mix(in srgb, var(--gold) 35%, transparent)' : 'none',
                                opacity: v === 0 ? 0.35 : 1,
                              }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                  {/* legend */}
                  <div style={{marginTop:18, display:'flex', alignItems:'center', gap:10, justifyContent:'flex-end'}}>
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>LESS</span>
                    {[0, 0.25, 0.5, 0.75, 1].map((p, idx) => (
                      <span key={idx} style={{
                        width:18, height:10, borderRadius:3,
                        background: p === 0 ? 'var(--border)' : `color-mix(in srgb, var(--gold) ${Math.round(15 + p * 75)}%, var(--surface))`,
                      }}/>
                    ))}
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>MORE</span>
                  </div>
                  {events.length === 0 && !timelineLoading && (
                    <div style={{marginTop:20, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
                      <span className="en-only">No memories indexed yet — ingest or sync to populate the grid.</span>
                      <span className="jp" style={{display:'block', fontSize:12, marginTop:4}}>まだインデックス化されたメモリがありません。</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {view === 'digest' && (
        <MemoryDigestView state={digestState} setState={setDigestState} />
      )}

      {view === 'search' && (
        <MemorySearchView
          workProjects={workProjects}
          assignments={workspaceAssignments}
          setAssignments={setWorkspaceAssignments}
        />
      )}

      {/* FTS5 highlight styles */}
      <style>{`
        .memory-scrub-stage mark {
          background: color-mix(in srgb, var(--gold) 28%, transparent);
          color: inherit;
          padding: 0 2px;
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
}

/** Helpers for `MemoryDigestView` below. */
function startOfDayMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
/** ISO Monday (day index 1). Returns ms of local midnight on that Monday. */
function startOfWeekMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // JS: getDay() 0=Sun..6=Sat. Shift so Mon=0.
  const offset = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - offset);
  return x.getTime();
}

function MemoryDigestView({ state, setState }) {
  const now = new Date();
  const weekStartMs = useMemo(() => startOfWeekMs(now), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayStartMs = useMemo(() => startOfDayMs(now), [now.getDate()]); // eslint-disable-line react-hooks/exhaustive-deps
  const lang = 'en';

  const loadRollups = useCallback(async (regenerate) => {
    setState((prev) => ({
      ...prev,
      loading: !regenerate,
      generatingWeek: !!regenerate,
      generatingDay: !!regenerate,
      error: null,
    }));
    const [weekRes, dayRes] = await Promise.all([
      runRuntimeActionA(
        'memory.rollup.get',
        { weekStartMs, lang, regenerate: !!regenerate },
        { silentError: true },
      ),
      runRuntimeActionA(
        'memory.rollup.day.get',
        { dayStartMs, lang, regenerate: !!regenerate },
        { silentError: true },
      ),
    ]);
    const weekRollup = weekRes && weekRes.ok && weekRes.data ? weekRes.data.rollup : null;
    const dayRollup = dayRes && dayRes.ok && dayRes.data ? dayRes.data.rollup : null;
    const errMsg = (!weekRes || !weekRes.ok) && (!dayRes || !dayRes.ok)
      ? ((weekRes && weekRes.error && weekRes.error.message)
         || (dayRes && dayRes.error && dayRes.error.message)
         || 'Rollup failed')
      : null;
    setState({
      week: weekRollup,
      day: dayRollup,
      loading: false,
      generatingWeek: false,
      generatingDay: false,
      error: errMsg,
    });
  }, [setState, weekStartMs, dayStartMs]);

  useEffect(() => {
    // Only load on first entry to this view (state.week / .day null).
    if (state.week == null && state.day == null && !state.loading) {
      void loadRollups(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtRange = (startMs, endMs) => {
    try {
      const s = new Date(startMs);
      const e = new Date(endMs);
      const opts = { month: 'short', day: 'numeric' };
      if (s.getFullYear() !== e.getFullYear()) {
        opts.year = 'numeric';
      }
      return `${s.toLocaleDateString('en-US', opts)} – ${e.toLocaleDateString('en-US', opts)}`;
    } catch (_e) {
      return '';
    }
  };

  const renderCard = (rollup, label, onRegen, generating) => {
    const priority = rollup && typeof rollup === 'object'
      ? String(rollup.userPriority || rollup.priority || '').toLowerCase()
      : '';
    const priColor = priority === 'high'
      ? 'var(--danger)'
      : priority === 'medium'
        ? 'var(--gold)'
        : 'var(--text-dim)';
    return (
      <div className="card" style={{padding:22, display:'flex', flexDirection:'column', gap:14}}>
        <div className="row" style={{gap:10, alignItems:'center'}}>
          <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>{label.toUpperCase()}</span>
          {rollup && priority && (
            <span className="label" style={{fontSize:10, borderColor:priColor, color:priColor, textTransform:'uppercase'}}>
              {priority}
            </span>
          )}
          <span style={{flex:1}}/>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={generating}
            onClick={() => void onRegen()}
            style={generating ? {opacity:0.55, cursor:'default'} : undefined}
          >
            {generating ? 'Regenerating…' : 'Regenerate'}
          </button>
        </div>
        {!rollup ? (
          <div style={{color:'var(--text-dim)', fontSize:13, lineHeight:1.5}}>
            No summary yet. Run Regenerate to build one from your indexed memory.
          </div>
        ) : (
          <>
            <div style={{fontSize:18, fontWeight:500, lineHeight:1.35}}>
              {rollup.title || 'Untitled digest'}
            </div>
            {Array.isArray(rollup.keyPoints) && rollup.keyPoints.length > 0 && (
              <ul style={{margin:0, paddingLeft:20, fontSize:13, lineHeight:1.6, color:'var(--text)'}}>
                {rollup.keyPoints.map((p, i) => (
                  <li key={i} style={{marginBottom:4}}>{p}</li>
                ))}
              </ul>
            )}
            {rollup.reason && (
              <div style={{fontSize:11, color:'var(--text-dim)', lineHeight:1.5}}>
                <span className="t-mono" style={{fontSize:9, letterSpacing:'0.1em'}}>WHY</span>{' '}{rollup.reason}
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
      <div style={{maxWidth:820, margin:'0 auto', display:'flex', flexDirection:'column', gap:18}}>
        {state.loading ? (
          <div style={{padding:32, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>Loading digest…</div>
        ) : state.error ? (
          <div className="card" style={{padding:18, color:'var(--danger)', fontSize:13}}>
            {state.error}
          </div>
        ) : null}

        <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>
          WEEK · {fmtRange(weekStartMs, weekStartMs + 6 * 86_400_000)}
        </div>
        {renderCard(
          state.week,
          'Weekly digest',
          async () => {
            setState((prev) => ({ ...prev, generatingWeek: true }));
            const res = await runRuntimeActionA(
              'memory.rollup.get',
              { weekStartMs, lang, regenerate: true },
              { silentError: true },
            );
            setState((prev) => ({
              ...prev,
              week: res && res.ok && res.data ? res.data.rollup : prev.week,
              generatingWeek: false,
              error: res && res.ok ? null : ((res && res.error && res.error.message) || 'Regenerate failed'),
            }));
          },
          state.generatingWeek,
        )}

        <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em', marginTop:8}}>
          DAY · {(() => { try { return new Date(dayStartMs).toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' }); } catch (_) { return ''; } })()}
        </div>
        {renderCard(
          state.day,
          'Daily digest',
          async () => {
            setState((prev) => ({ ...prev, generatingDay: true }));
            const res = await runRuntimeActionA(
              'memory.rollup.day.get',
              { dayStartMs, lang, regenerate: true },
              { silentError: true },
            );
            setState((prev) => ({
              ...prev,
              day: res && res.ok && res.data ? res.data.rollup : prev.day,
              generatingDay: false,
              error: res && res.ok ? null : ((res && res.error && res.error.message) || 'Regenerate failed'),
            }));
          },
          state.generatingDay,
        )}
      </div>
    </div>
  );
}

function MemorySearchView({ workProjects, assignments, setAssignments }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [targetWorkspace, setTargetWorkspace] = useState('');
  const [busy, setBusy] = useState(false);
  const [newDraft, setNewDraft] = useState('');

  // Initial load: most recent hits, no query.
  useEffect(() => {
    let cancelled = false;
    setSearching(true);
    runRuntimeActionA('memory.search', { query: '', limit: 60 }, { silentError: true })
      .then((r) => {
        if (cancelled) return;
        setSearching(false);
        const arr = r && r.ok && Array.isArray(r.data?.hits) ? r.data.hits : [];
        setHits(arr);
      });
    return () => { cancelled = true; };
  }, []);

  // Debounced search as the user types.
  useEffect(() => {
    if (query === '') return undefined;
    const t = setTimeout(() => {
      setSearching(true);
      runRuntimeActionA('memory.search', { query, limit: 60 }, { silentError: true })
        .then((r) => {
          setSearching(false);
          const arr = r && r.ok && Array.isArray(r.data?.hits) ? r.data.hits : [];
          setHits(arr);
        });
    }, 220);
    return () => clearTimeout(t);
  }, [query]);

  const toggleOne = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelected(new Set(hits.map((h) => h.id).filter(Boolean)));
  }, [hits]);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  const applyAssign = useCallback(async () => {
    if (selected.size === 0 || !targetWorkspace) return;
    setBusy(true);
    const next = { ...assignments };
    let resolvedTarget = targetWorkspace;
    if (targetWorkspace === '__new__') {
      const name = newDraft.trim();
      if (!name) { setBusy(false); return; }
      const create = window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.createWorkProject;
      const id = typeof create === 'function' ? create(name) : null;
      if (!id) { setBusy(false); return; }
      resolvedTarget = id;
      setNewDraft('');
    } else if (targetWorkspace === '__unassign__') {
      resolvedTarget = '';
    }
    selected.forEach((id) => {
      if (resolvedTarget) next[id] = resolvedTarget;
      else delete next[id];
    });
    setAssignments(next);
    await runRuntimeActionA(
      'settings.save',
      { section: 'workspace_memberships', memberships: next },
      { silentError: true },
    );
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', { detail: { memberships: next } }));
    } catch (_) { /* ignore */ }
    window.SHOGUN_RUNTIME?.pushToast?.(
      resolvedTarget
        ? `Assigned ${selected.size} memor${selected.size === 1 ? 'y' : 'ies'}`
        : `Unassigned ${selected.size} memor${selected.size === 1 ? 'y' : 'ies'}`,
      'success',
    );
    setSelected(new Set());
    if (targetWorkspace !== '__new__') setTargetWorkspace('');
    setBusy(false);
  }, [assignments, selected, targetWorkspace, newDraft, setAssignments]);

  const visibleProjects = workProjects.filter((p) => !p.archived);
  const renderHL = window.ShogunHighlight && window.ShogunHighlight.renderHighlighted
    ? window.ShogunHighlight.renderHighlighted
    : ((t) => t);

  return (
    <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, display:'flex', flexDirection:'column', gap:14}}>
      <div className="row" style={{gap:10, alignItems:'center'}}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search indexed memory…"
          autoFocus
          style={{
            flex:1, padding:'10px 14px', borderRadius:10,
            border:'1px solid var(--border-hi)', background:'var(--bg)',
            color:'var(--text)', fontSize:14, fontFamily:'inherit',
          }}
        />
        <span className="t-mono" style={{fontSize:11, color:'var(--text-dim)'}}>
          {searching ? 'Searching…' : `${hits.length} hits`}
        </span>
        {hits.length > 0 && (
          selected.size === hits.length ? (
            <button
              type="button" className="btn btn-sm btn-ghost"
              onClick={clearSelection}
            >Clear</button>
          ) : (
            <button
              type="button" className="btn btn-sm btn-secondary"
              onClick={selectAllVisible}
            >Select all</button>
          )
        )}
      </div>

      <div style={{flex:1, minHeight:0, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, paddingRight:4}}>
        {hits.length === 0 ? (
          <div style={{padding:32, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
            {searching ? 'Loading…' : 'No matches.'}
          </div>
        ) : (
          hits.map((h) => {
            const id = h.id;
            const isOn = !!id && selected.has(id);
            const titleSrc = h.title_highlight || h.title || 'Untitled';
            const snippetSrc = h.snippet_highlight || h.snippet || '';
            const provider = memoryProviderKey(h.source);
            const meta = MEMORY_PROVIDER_META[provider];
            const assignedId = id ? assignments[id] : null;
            const assignedProj = assignedId ? workProjects.find((p) => p.id === assignedId) : null;
            return (
              <label
                key={id || h.title}
                style={{
                  display:'grid', gridTemplateColumns:'24px 1fr', columnGap:12,
                  padding:'12px 14px', borderRadius:12,
                  border:'1px solid ' + (isOn ? 'color-mix(in srgb, var(--gold) 65%, var(--border))' : 'var(--border)'),
                  background: isOn ? 'color-mix(in srgb, var(--gold) 6%, var(--surface))' : 'var(--surface)',
                  cursor: id ? 'pointer' : 'default',
                  alignItems:'flex-start',
                }}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={!id}
                  onChange={() => id && toggleOne(id)}
                  style={{marginTop:3}}
                />
                <div style={{minWidth:0}}>
                  <div className="row" style={{gap:8, alignItems:'center', flexWrap:'wrap', marginBottom:4}}>
                    {meta && (
                      <span style={{
                        display:'inline-flex', alignItems:'center', gap:5,
                        padding:'2px 7px', borderRadius:4,
                        border:`1px solid color-mix(in srgb, ${meta.color} 50%, var(--border))`,
                        background:`color-mix(in srgb, ${meta.color} 10%, transparent)`,
                        color: meta.color,
                        fontSize:9, letterSpacing:'0.06em', fontFamily:'var(--font-mono)',
                      }}>
                        <span style={{width:5, height:5, borderRadius:'50%', background: meta.color}} aria-hidden="true"/>
                        {meta.en}
                      </span>
                    )}
                    {assignedProj && (
                      <span className="label" style={{fontSize:10, borderColor:'var(--gold-dim)', color:'var(--gold)'}}>
                        ▣ {assignedProj.name}
                      </span>
                    )}
                  </div>
                  <div style={{fontSize:14, fontWeight:500, lineHeight:1.35, marginBottom:4}}>
                    {renderHL(titleSrc)}
                  </div>
                  {snippetSrc && (
                    <div style={{fontSize:12, color:'var(--text-dim)', lineHeight:1.55, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical'}}>
                      {renderHL(snippetSrc)}
                    </div>
                  )}
                </div>
              </label>
            );
          })
        )}
      </div>

      {selected.size > 0 && (
        <div className="card" style={{padding:14, display:'flex', gap:10, alignItems:'center', flexWrap:'wrap', borderColor:'var(--gold-dim)'}}>
          <span style={{fontSize:13, fontWeight:500}}>
            {selected.size} selected
          </span>
          <span style={{flex:1}}/>
          <select
            value={targetWorkspace}
            onChange={(e) => setTargetWorkspace(e.target.value)}
            disabled={busy}
            style={{
              padding:'6px 10px', borderRadius:8,
              border:'1px solid var(--border-hi)', background:'var(--surface)', color:'var(--text)',
              fontSize:12, fontFamily:'inherit',
            }}
          >
            <option value="">Choose workspace…</option>
            {visibleProjects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value="__new__">+ New workspace…</option>
            <option value="__unassign__">Unassign</option>
          </select>
          {targetWorkspace === '__new__' && (
            <input
              type="text"
              value={newDraft}
              onChange={(e) => setNewDraft(e.target.value)}
              placeholder="New workspace name"
              disabled={busy}
              style={{
                padding:'6px 10px', borderRadius:8,
                border:'1px solid var(--border-hi)', background:'var(--bg)', color:'var(--text)',
                fontSize:12, fontFamily:'inherit', width:180,
              }}
            />
          )}
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={busy || !targetWorkspace || (targetWorkspace === '__new__' && !newDraft.trim())}
            onClick={applyAssign}
            style={(busy || !targetWorkspace || (targetWorkspace === '__new__' && !newDraft.trim())) ? {opacity:0.55, cursor:'not-allowed'} : undefined}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={clearSelection}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}

window.ScreenHome = ScreenHome;
window.ScreenMemory = ScreenMemory;
