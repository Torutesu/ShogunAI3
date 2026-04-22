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
    t,
    h,
    src,
    title: hit.title || 'Memory',
    snippet: hit.snippet || '',
    memoryId: hit.id,
    provenance,
    sourceRaw: hit.source || '',
    entityId: hit.entity_id != null ? String(hit.entity_id) : null,
    big: false,
  };
}

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
  const detail = {
    text,
    webSearch: !!opts.webSearch,
    assembleMemory: allowAsm,
  };
  if (allowAsm) {
    detail.memoryAssemblyPreset = { query: memQ, limit, semantic };
  } else {
    detail.clearMemoryAssemblyPreset = true;
  }
  window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
  window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
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
    .format(d)
    .toUpperCase();
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
  { id: 'writing', label: '文章作成', icon: 'edit' },
  { id: 'learning', label: '学習', icon: 'graduation' },
  { id: 'code', label: 'コード', icon: 'terminal' },
  { id: 'lifestyle', label: 'ライフスタイル', icon: 'coffee' },
  { id: 'drive', label: 'Drive から', icon: 'drive' },
];

const HOME_PROMPT_ROWS = {
  writing: [
    '執筆のための調査をする',
    '面接質問の作成',
    'ブログ記事シリーズの作成',
    'ソーシャルメディア投稿の作成',
    'コンテンツ企画書を作成する',
  ],
  learning: [
    '学習目標を設定する',
    '教育戦略の開発',
    '学術論文を要約する',
    '振り返り演習を開発する',
    '私の研究からパターンを見つけてください',
  ],
  code: [
    'コードレビューを依頼する',
    'バグの原因を調査する',
    'リファクタリング案を出す',
    'テストケースを生成する',
    'このコードのアーキテクチャを説明する',
  ],
  lifestyle: [
    '個人のストレス管理',
    '意思決定をサポートする',
    'セルフケアの習慣作り',
    '退職後の活動を計画する',
    '住宅改善を計画する',
  ],
  drive: [
    '私の文書から最も優れた瞬間を特定し、視覚化する',
    '私の文書全体を通して一貫して現れるアイデアのテーマは何ですか？',
    '私の文書に基づいて文章スタイルを分析してください',
    '私の文書を確認して、どのようなジャンルの作家になれるか提案する',
    '新しくアクセス権を得た文書の要約を教えてください',
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// L1 · HOME — the launch pad
// ═══════════════════════════════════════════════════════════════════════════
function ScreenHome() {
  const [morningBrief, setMorningBrief] = useState(null);
  const [briefErr, setBriefErr] = useState(null);
  const [memoryTotal, setMemoryTotal] = useState(null);
  const [profileFullName, setProfileFullName] = useState('');
  const [modelHint, setModelHint] = useState('');
  const [homeInput, setHomeInput] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [promptModal, setPromptModal] = useState(null);
  const [webSearchOn, setWebSearchOn] = useState(true);
  const [assembleMemoryOn, setAssembleMemoryOn] = useState(false);
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
      const res = await runRuntimeActionA(
        "brief.get",
        { span: "today", source: "home", user_tz: resolveUserTimeZoneId() },
        { silentError: true }
      );
      if (cancelled) return;
      if (!res.ok || !res.data) {
        setBriefErr("brief unavailable");
        return;
      }
      const inner = res.data;
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

  const seedAndOpenChat = (text) => {
    const t = String(text || '').trim();
    window.dispatchEvent(
      new CustomEvent('shogun-chat-composer-seed', {
        detail: { text: t, webSearch: webSearchOn, assembleMemory: assembleMemoryOn },
      }),
    );
    window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  };

  const goAsk = () => {
    const t = homeInput.trim();
    if (t) seedAndOpenChat(t);
    else {
      window.dispatchEvent(
        new CustomEvent('shogun-chat-composer-seed', {
          detail: { text: '', webSearch: webSearchOn, assembleMemory: assembleMemoryOn },
        }),
      );
      window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
    }
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
        maxWidth: 720,
        margin: '0 auto',
        padding: 'clamp(28px, 6vw, 56px) clamp(18px, 3vw, 32px) clamp(36px, 5vw, 64px)',
      }}
    >
      <div
        style={{
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
          <div className="t-mono" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
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
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 20,
              boxShadow: 'var(--shadow-md)',
              padding: '16px 16px 12px',
            }}
          >
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
                      bottom: '100%',
                      marginBottom: 8,
                      width: 'min(340px, calc(100vw - 48px))',
                      background: 'var(--surface)',
                      border: '1px solid var(--border-hi)',
                      borderRadius: 'var(--radius-lg)',
                      boxShadow: 'var(--shadow-lg)',
                      padding: '6px 0',
                      zIndex: 50,
                    }}
                  >
                    {plusMenuSections.map((section, si) => (
                      <div key={si}>
                        {si > 0 && <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />}
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
                              gap: 12,
                              width: '100%',
                              textAlign: 'left',
                              padding: '12px 14px',
                              fontSize: 13,
                              border: 'none',
                              background: 'transparent',
                              color: row.active ? 'var(--gold)' : row.disabled ? 'var(--text-dim)' : 'var(--text)',
                              cursor: row.disabled ? 'not-allowed' : 'pointer',
                              opacity: row.disabled ? 0.45 : 1,
                              fontFamily: 'var(--font-jp), var(--font-en)',
                            }}
                          >
                            <span style={{ flexShrink: 0, opacity: 0.9, display: 'inline-flex' }}>
                              <Icon name={row.icon} size={16} />
                            </span>
                            <span style={{ flex: 1 }}>{row.label}</span>
                            {row.chev && (
                              <span style={{ color: 'var(--text-dim)', display: 'inline-flex' }}>
                                <Icon name="chevronRight" size={14} />
                              </span>
                            )}
                            {row.active && (
                              <span style={{ color: 'var(--gold)', display: 'inline-flex' }}>
                                <Icon name="check" size={16} />
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
                  onClick={() => window.SHOGUN_RUNTIME?.openSettingsPane?.('llm')}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    borderRadius: 999,
                    border: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-mute)',
                    fontSize: 12,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {modelHint || 'Model'}
                  <Icon name="chevronDown" size={14} />
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
                background: 'color-mix(in srgb, var(--surface) 88%, var(--bg))',
                border: '1px solid var(--border-hi)',
                borderRadius: 16,
                boxShadow: '0 8px 28px -12px rgba(0,0,0,0.45)',
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
                  className="jp"
                  style={{ flex: 1, fontSize: 15, fontWeight: 600, color: 'var(--text)' }}
                >
                  {modalMeta.label}
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
                        seedAndOpenChat(line);
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
                      {line}
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
              {cat.label}
            </button>
          ))}
        </div>
        </div>
      </div>

      {morningBrief && (
        <div className="card" style={{ padding: 28, borderColor: 'var(--gold-dim)', marginTop: 32, background: 'var(--surface)' }}>
          <div className="row" style={{ marginBottom: 14, alignItems: 'baseline', gap: 12 }}>
            <div className="t-mono gold">MORNING BRIEF · AMC</div>
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
      {briefErr && (
        <div className="xsmall muted" style={{ marginTop: 16 }}>{briefErr}</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// L2 · MEMORY TIMELINE — HERO
// ═══════════════════════════════════════════════════════════════════════════
function ScreenMemory() {
  const [view, setView] = useState('river');
  const [events, setEvents] = useState(() => []);
  const [scrubIdx, setScrubIdx] = useState(0);
  const [sourceEntities, setSourceEntities] = useState([]);
  const [semanticMemorySearch, setSemanticMemorySearch] = useState(true);
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [memorySettingsLoaded, setMemorySettingsLoaded] = useState(false);
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
  useEffect(() => {
    if (!memorySettingsLoaded) return;
    let cancelled = false;
    (async () => {
      const res = await runRuntimeActionA('memory.search', withSemantic({ query: '', limit: 40 }), { silentError: true });
      if (cancelled) return;
      mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx);
    })();
    return () => { cancelled = true; };
  }, [memorySettingsLoaded, withSemantic]);
  useEffect(() => {
    const onIndexChanged = async () => {
      const r = await runRuntimeActionA('memory.search', withSemantic({ query: '', limit: 40 }), { silentError: true });
      mergeIndexHitsIntoRiver(r, setEvents, setScrubIdx);
      refreshSourceEntities();
    };
    window.addEventListener('shogun-memory-index-changed', onIndexChanged);
    return () => window.removeEventListener('shogun-memory-index-changed', onIndexChanged);
  }, [withSemantic]);
  useEffect(() => {
    setScrubIdx((i) => {
      if (events.length === 0) return 0;
      return Math.min(i, events.length - 1);
    });
  }, [events.length]);
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
  const memoryHeadDate = useMemo(() => {
    const d = new Date();
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }, []);

  const hourIndexFromEvents = useMemo(() => {
    const counts = new Array(24).fill(0);
    const firstIdx = new Array(24).fill(-1);
    events.forEach((e, i) => {
      const hh = Math.floor(Number(e.h));
      const h = Math.max(0, Math.min(23, Number.isFinite(hh) ? hh : 12));
      if (firstIdx[h] < 0) firstIdx[h] = i;
      counts[h] += 1;
    });
    const maxC = Math.max(1, ...counts);
    return { counts, firstIdx, maxC };
  }, [events]);

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
    <div className="content-inner wide" style={{padding:0, height:'100%', display:'flex', flexDirection:'column', overflowY:'auto'}}>
      {/* Header */}
      <div style={{padding:'24px 40px 0', display:'flex', alignItems:'flex-start', gap:20, flexWrap:'wrap'}}>
        <div style={{flex:1, minWidth:240}}>
          <div className="t-mono" style={{fontSize:10, letterSpacing:'0.14em', color:'var(--text-dim)'}}>MEMORY / TIMELINE</div>
          <h1 style={{margin:'10px 0 0', fontSize:32, fontWeight:600, letterSpacing:'-0.02em'}}>
            <span className="en-only">April 17 · Friday</span>
            <span className="jp" style={{display:'block', fontSize:14, color:'var(--text-mute)', fontWeight:400, marginTop:4}}>4月17日（金）</span>
          </h1>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
          <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:999, padding:2, background:'var(--surface)'}}>
            {[['river','River'],['kakejiku','Kakejiku']].map(([k,l])=>(
              <button key={k} type="button" onClick={()=>setView(k)} style={{
                padding:'6px 14px', borderRadius:999, border:'none',
                background: view===k ? 'var(--surface-2)' : 'transparent',
                color: view===k ? 'var(--text)' : 'var(--text-mute)',
                fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            ))}
          </div>
          <button type="button" style={{
            display:'inline-flex', alignItems:'center', gap:6,
            padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)',
            background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
          }} onClick={async ()=>{
            const res = await runRuntimeActionA('memory.search', withSemantic({ query:'filters timeline', kinds:['screen','audio','input'], limit:50 }), { successMessage:'Filters applied' });
            mergeIndexHitsIntoRiver(res, setEvents, setScrubIdx);
          }}>
            <Icon name="filter" size={12}/>
            Filters · 3
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{padding:'20px 40px 0', display:'flex', alignItems:'center', gap:16, flexWrap:'wrap'}}>
        <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden', background:'var(--surface)'}}>
          {['Day','Week','Month','Year'].map((l)=>{
            const on = l==='Week';
            return (
              <button key={l} type="button" style={{
                padding:'7px 16px', border:'none',
                background: on?'var(--surface-2)':'transparent',
                color: on?'var(--text)':'var(--text-mute)',
                fontSize:12, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            );
          })}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:6}}>
          <button type="button" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={13}/></button>
          <span className="t-mono" style={{fontSize:13, color:'var(--text)', padding:'0 8px'}}>APR 11 – APR 17</span>
          <button type="button" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={13}/></button>
        </div>
        <button type="button" style={{
          padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
        }}>
          <span className="en-only">Today</span>
          <span className="jp" style={{marginLeft:4, fontSize:11}}>· 今日</span>
        </button>
        <span style={{flex:1}}/>
        <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>372 MEMORIES · 94H</span>
      </div>

      {/* 7-day week cards (no heatmap — just date + activity count) */}
      <div style={{padding:'18px 40px 0', display:'grid', gridTemplateColumns:'repeat(7, minmax(0, 1fr))', gap:10}}>
        {[
          {label:'APR 11', count:38},
          {label:'APR 12', count:52},
          {label:'APR 13', count:61},
          {label:'APR 14', count:44},
          {label:'APR 15', count:58},
          {label:'APR 16', count:46},
          {label:'APR 17', count:73},
        ].map((d, i)=>{
          const active = i===6;
          return (
            <div key={d.label} style={{
              padding:'14px 16px',
              borderRadius:14,
              border: active ? '1px solid color-mix(in srgb, var(--gold) 55%, var(--border))' : '1px solid var(--border)',
              background: active ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
              minHeight:82,
              display:'flex', flexDirection:'column', gap:8, cursor:'pointer',
            }}>
              <div className="t-mono" style={{fontSize:10, color: active ? 'var(--gold)' : 'var(--text-dim)', letterSpacing:'0.14em'}}>{d.label}</div>
              <div style={{fontSize:22, fontWeight:600, color: active ? 'var(--text)' : 'var(--text-mute)', letterSpacing:'-0.02em'}}>{d.count}</div>
              <div className="t-mono" style={{fontSize:9, color:'var(--text-dim)'}}>MEMORIES</div>
            </div>
          );
        })}
      </div>

      {/* Main content split */}
      <div style={{padding:'24px 40px 24px', display:'grid', gridTemplateColumns:'minmax(0, 1fr) minmax(0, 1fr)', gap:20, minHeight:420}}>
        {/* Left: Conversation card */}
        <div style={{
          padding:'24px 26px',
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--surface) 94%, var(--bg))',
        }}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <div style={{width:32, height:32, borderRadius:8, background:'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gold)'}}>
              <Icon name="chat" size={15}/>
            </div>
            <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>CONVERSATION · 14:02</div>
          </div>
          <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em'}}>Revenue-cat · pricing tiers</h2>
          <div style={{display:'flex', gap:8, flexWrap:'wrap', marginBottom:16}}>
            {['#pricing','Matt','Toru'].map(t=>(
              <span key={t} style={{padding:'4px 10px', borderRadius:999, border:'1px solid var(--border)', background:'var(--surface-2)', fontSize:11, color:'var(--text-mute)', fontFamily:'var(--font-mono, ui-monospace, monospace)'}}>{t}</span>
            ))}
          </div>
          <p style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)'}}>
            Jumped into Revenue-cat. Locked on a three-tier structure: Plus at $17, Pro at $62, and a founder plan. Matt pushed back on the middle tier — we softened it.
          </p>
          <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em', marginBottom:12}}>3 MEMORIES WRITTEN · 2 ENTITIES LINKED</div>
          <div style={{display:'flex', flexDirection:'column', gap:8}}>
            {[
              {label:'DECISION', body:'\"Pro tier = $62/mo, annual $49\"'},
              {label:'QUOTE', body:'\"pricing shouldn\u2019t apologize for itself\"'},
              {label:'TODO', body:'Send tiering doc to Matt by Friday'},
            ].map(row=>(
              <div key={row.label} style={{
                display:'flex', alignItems:'center', gap:14,
                padding:'10px 14px', borderRadius:10,
                background:'color-mix(in srgb, var(--surface-2) 50%, transparent)',
                border:'1px solid var(--border)',
              }}>
                <span className="t-mono" style={{fontSize:10, color:'var(--gold)', letterSpacing:'0.14em', minWidth:78}}>{row.label}</span>
                <span style={{flex:1, fontSize:13, color:'var(--text)'}}>{row.body}</span>
                <Icon name="arrowUpRight" size={13}/>
              </div>
            ))}
          </div>
          <div style={{display:'flex', gap:10, marginTop:18, paddingTop:14, borderTop:'1px solid var(--border)'}}>
            <button type="button" style={{display:'inline-flex', alignItems:'center', gap:6, padding:'7px 12px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>
              <Icon name="chat" size={13}/>Open in Chat
            </button>
            <button type="button" style={{display:'inline-flex', alignItems:'center', gap:6, padding:'7px 12px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>
              <Icon name="link" size={13}/>Open source
            </button>
            <span style={{flex:1}}/>
            <button type="button" style={{display:'inline-flex', alignItems:'center', justifyContent:'center', width:32, height:30, padding:0, borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer'}}>
              <Icon name="more" size={14}/>
            </button>
          </div>
        </div>

        {/* Right: Snapshot card */}
        <div style={{
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--bg) 60%, var(--surface))',
          overflow:'hidden',
          display:'flex', flexDirection:'column',
        }}>
          <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
            <div style={{display:'flex', gap:5}}>
              {['#ff5f57','#ffbd2e','#28c940'].map(c=>(
                <span key={c} style={{width:9, height:9, borderRadius:999, background:c, opacity:0.85}}/>
              ))}
            </div>
            <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', marginLeft:6}}>SHOGUN Chat · Revenue-cat · pricing tiers</span>
            <span style={{flex:1}}/>
            <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)'}}>33 / 57</span>
          </div>
          <div style={{flex:1, padding:'24px 22px', display:'flex', flexDirection:'column', gap:18, minHeight:280}}>
            <div style={{alignSelf:'flex-end', maxWidth:'75%', padding:'10px 14px', borderRadius:14, background:'var(--surface-2)', color:'var(--text)', fontSize:13}}>
              Draft a three-tier pricing page for SHOGUN.
            </div>
            <div style={{display:'flex', gap:10, alignItems:'flex-start'}}>
              <div style={{marginTop:2}}><Kamon size={18}/></div>
              <div style={{flex:1, fontSize:13, color:'var(--text)', lineHeight:1.55}}>
                Pulling from Matt 1-on-1 and Rev-cat chat — here\u2019s the draft…
                <div style={{marginTop:12, fontFamily:'var(--font-mono, ui-monospace, monospace)', fontSize:12, color:'var(--text-mute)'}}>
                  ## Plus — $17/mo · ## Pro — $62/mo
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Timeline scrubber */}
      <div style={{marginTop:'auto', padding:'18px 40px 28px', borderTop:'1px solid var(--border)'}}>
        <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:12}}>
          <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>TIMELINE</span>
          <span style={{flex:1}}/>
          <button type="button" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={12}/></button>
          <button type="button" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={12}/></button>
          <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)'}}>57 EVENTS · 15H 02M</span>
        </div>
        <div style={{position:'relative', height:64}}>
          <div style={{position:'absolute', inset:'0 0 22px 0', display:'flex', alignItems:'flex-end', gap:2}}>
            {[...Array(54)].map((_,i)=>{
              const h = 8 + ((i * 37 + (i%7)*11) % 22);
              const now = i===30;
              return <span key={i} style={{flex:1, height: h, background: now? 'var(--gold)':'var(--border-hi)', opacity: now?0.95:0.48, borderRadius:2}}/>;
            })}
          </div>
          <div className="t-mono" style={{position:'absolute', left:0, bottom:0, right:0, display:'flex', justifyContent:'space-between', fontSize:10, color:'var(--text-dim)'}}>
            {['06','08','10','12','14','16','18','20','22'].map(h=><span key={h}>{h}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

window.ScreenHome = ScreenHome;
window.ScreenMemory = ScreenMemory;
