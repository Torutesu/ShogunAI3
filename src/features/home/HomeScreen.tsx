/* eslint-disable max-lines -- Phase 2 Step 8: feature split. Will tighten in Phase 3 with finer component extraction. */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Icon, Kamon } from '@/shared/icons';
import { ShogunDriveGlyph } from './components/ShogunDriveGlyph';
import {
  runRuntimeActionA,
  resolveUserTimeZoneId,
  composerPlaceholderForLang,
  homeFirstNameToken,
  computeHomeGreetingState,
  smartSnoozePresets,
} from './lib/runtime';

const HOME_QUICK_CATEGORIES = [
  { id: 'writing', en: 'Writing', jp: '文章作成', icon: 'edit' },
  { id: 'learning', en: 'Learning', jp: '学習', icon: 'graduation' },
  { id: 'code', en: 'Code', jp: 'コード', icon: 'terminal' },
  { id: 'lifestyle', en: 'Lifestyle', jp: 'ライフスタイル', icon: 'coffee' },
  { id: 'drive', en: 'From Drive', jp: 'Drive から', icon: 'drive' },
];

const HOME_PROMPT_ROWS: Record<string, Array<{ en: string; jp: string }>> = {
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
    { en: 'Explain this code\'s architecture', jp: 'このコードのアーキテクチャを説明する' },
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

function pickHomeText(item: any, uiLang: any): string {
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

export function HomeScreen() {
  const [morningBrief, setMorningBrief] = useState<any>(null);
  const [memoryDigest, setMemoryDigest] = useState<any>(null);
  const [expandedHighlightId, setExpandedHighlightId] = useState<any>(null);
  const [entityRollupCache, setEntityRollupCache] = useState<any>({});
  const [memoryTotal, setMemoryTotal] = useState<any>(null);
  const [sliSnapshot, setSliSnapshot] = useState<any>(null);
  const [sliThresholds, setSliThresholds] = useState<any>({
    bad: { successLt: 95, p95Gt: 3000, backlogGt: 40 },
    warn: { successLt: 99, p95Gt: 1500, backlogGt: 15 },
  });
  const [profileFullName, setProfileFullName] = useState('');
  const [_modelHint, setModelHint] = useState('');
  const [homeInput, setHomeInput] = useState('');
  const [plusOpen, setPlusOpen] = useState(false);
  const [promptModal, setPromptModal] = useState<any>(null);
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
  const plusRef = useRef<any>(null);
  const plusFileInputRef = useRef<any>(null);
  const quickPromptRootRef = useRef<any>(null);

  const headLine = useMemo(() => computeHomeGreetingState(new Date()), [clockTick]); // eslint-disable-line react-hooks/exhaustive-deps
  const greetFirstName = useMemo(() => homeFirstNameToken(profileFullName), [profileFullName]);
  const homeDateStr =
    uiLang === 'jp' ? headLine.dateJp : uiLang === 'bi' ? headLine.dateBi : headLine.dateEn;

  const briefGeneratedDisplay = useMemo(() => {
    const iso = morningBrief && morningBrief.generated_at;
    if (!iso) return '';
    const U = typeof window !== 'undefined' ? (window as any).ShogunUserTimezone : null;
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

  const sliTone = useMemo(() => {
    if (!sliSnapshot) return null;
    const success = Number(sliSnapshot.successRate || 0);
    const p95 = Number(sliSnapshot.p95LatencyMs || 0);
    const backlog = Number(sliSnapshot.backlog || 0);
    const bad = sliThresholds.bad || {};
    const warn = sliThresholds.warn || {};
    if (
      success < Number(bad.successLt || 95) ||
      p95 > Number(bad.p95Gt || 3000) ||
      backlog > Number(bad.backlogGt || 40)
    ) {
      return {
        fg: 'var(--danger)',
        border: 'color-mix(in srgb, var(--danger) 55%, var(--border) 45%)',
        bg: 'color-mix(in srgb, var(--danger) 9%, var(--surface) 91%)',
      };
    }
    if (
      success < Number(warn.successLt || 99) ||
      p95 > Number(warn.p95Gt || 1500) ||
      backlog > Number(warn.backlogGt || 15)
    ) {
      return {
        fg: 'var(--warn)',
        border: 'color-mix(in srgb, var(--warn) 55%, var(--border) 45%)',
        bg: 'color-mix(in srgb, var(--warn) 10%, var(--surface) 90%)',
      };
    }
    return {
      fg: 'var(--success)',
      border: 'color-mix(in srgb, var(--success) 55%, var(--border) 45%)',
      bg: 'color-mix(in srgb, var(--success) 10%, var(--surface) 90%)',
    };
  }, [sliSnapshot, sliThresholds]);

  useEffect(() => {
    const bump = () => setClockTick((x) => x + 1);
    const HOUR_MS = 60 * 60 * 1000;
    const msToNextHour = () => {
      const n = new Date();
      const next = new Date(n.getTime());
      next.setHours(n.getHours() + 1, 0, 0, 0);
      return Math.max(1, next.getTime() - n.getTime());
    };
    let intervalId: any = null;
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
    let cancelled = false;
    const fetchSli = () =>
      runRuntimeActionA('stats.get', { stage: 'sli' }, { silentError: true }).then((r: any) => {
        if (cancelled || !r?.ok || !r.data?.sli) return;
        setSliSnapshot(r.data.sli);
      });
    void fetchSli();
    const id = window.setInterval(fetchSli, 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
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
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r: any) => {
      if (cancelled || !r?.ok || !r.data?.settings?.sections) return;
      const g = r.data.settings.sections.general;
      if (g && typeof g === 'object') {
        const raw = g.name != null ? String(g.name).trim() : '';
        setProfileFullName(raw);
      }
      const llm = r.data.settings.sections.llm;
      if (llm && llm.model != null) setModelHint(String(llm.model));
      const obs = r.data.settings.sections.observability;
      const t = obs && obs.sliThresholds;
      if (t && typeof t === 'object') {
        setSliThresholds({
          bad: {
            successLt: Number(t.bad?.successLt ?? 95),
            p95Gt: Number(t.bad?.p95Gt ?? 3000),
            backlogGt: Number(t.bad?.backlogGt ?? 40),
          },
          warn: {
            successLt: Number(t.warn?.successLt ?? 99),
            p95Gt: Number(t.warn?.p95Gt ?? 1500),
            backlogGt: Number(t.warn?.backlogGt ?? 15),
          },
        });
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onProfile = (e: any) => {
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
      if (inner.memory_digest) {
        setMemoryDigest(inner.memory_digest);
        try {
          const highlights = Array.isArray(inner.memory_digest.highlights)
            ? inner.memory_digest.highlights
            : [];
          const nowMs = Date.now();
          const highCount = highlights.filter(
            (h: any) => (h.userPriority || h.priority) === 'high'
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
      if ((window as any).BriefTelemetry) {
        (window as any).BriefTelemetry.log((window as any).BriefTelemetry.EVENTS.BRIEF_RENDERED, {
          itemCount: inner.brief.items?.length || 0,
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!plusOpen) return;
    const close = (e: any) => {
      if (plusRef.current && !plusRef.current.contains(e.target)) setPlusOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [plusOpen]);

  useEffect(() => {
    if (!promptModal && !plusOpen) return;
    const onKey = (e: any) => {
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
    const close = (e: any) => {
      if (quickPromptRootRef.current && !quickPromptRootRef.current.contains(e.target)) {
        setPromptModal(null);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [promptModal]);

  const seedAndOpenChat = (text: any, options?: any) => {
    const t = String(text || '').trim();
    const autoSend = !!(options && options.autoSend) && t.length > 0;
    window.dispatchEvent(
      new CustomEvent('shogun-chat-composer-seed', {
        detail: { text: t, webSearch: webSearchOn, assembleMemory: assembleMemoryOn, autoSend },
      }),
    );
    (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  };

  const goAsk = () => {
    const t = homeInput.trim();
    if (!t) return;
    seedAndOpenChat(t, { autoSend: true });
    setHomeInput('');
  };

  const ingestPlusFiles = useCallback(async (fileList: any) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList) as File[];
    let n = 0;
    for (let i = 0; i < files.length; i++) {
      const file: File | undefined = files[i];
      if (!file) continue;
      let snippet = '';
      if (file.type && file.type.indexOf('image/') === 0) {
        snippet = `[Image] ${file.name} (${file.size} bytes)`;
      } else {
        try {
          const text = await new Promise<string>((resolve, reject) => {
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
      (window as any).SHOGUN_RUNTIME?.pushToast?.(`${n} file(s) added to Memory`, 'success');
    } else {
      (window as any).SHOGUN_RUNTIME?.pushToast?.('Could not ingest files', 'warn');
    }
  }, []);

  const onPlusFilesChange = useCallback(
    (e: any) => {
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
          icon: 'folder',
          label: 'Workに追加',
          chev: true,
          onPick: () => {
            const open = (window as any).SHOGUN_RUNTIME?.openWorkPickerForNewChat;
            if (typeof open === 'function') {
              open();
            } else {
              (window as any).SHOGUN_RUNTIME?.pushToast?.('Work picker not ready', 'warn');
            }
          },
        },
        {
          icon: 'github',
          label: 'GitHubから追加',
          chev: false,
          onPick: () => {
            (window as any).SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
            (window as any).SHOGUN_RUNTIME?.pushToast?.('連携から Git / ツールを選ぶか、リポジトリ URL をチャットに貼ってください', 'info');
          },
        },
      ],
      [
        {
          icon: 'note',
          label: 'スキル',
          chev: true,
          onPick: () => {
            (window as any).SHOGUN_RUNTIME?.openSettingsPane?.('chat');
            (window as any).SHOGUN_RUNTIME?.pushToast?.('Chat のカスタム指示を編集できます', 'info');
          },
        },
        {
          icon: 'grid',
          label: 'コネクタ',
          chev: true,
          onPick: () => {
            (window as any).SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
          },
        },
        {
          icon: 'plug',
          label: 'プラグイン',
          chev: true,
          onPick: () => {
            (window as any).SHOGUN_RUNTIME?.openSettingsPane?.('integrations');
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
            (window as any).SHOGUN_RUNTIME?.pushToast?.('入力欄に Research: を挿入しました（続きを書いて送信）', 'info');
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
      ],
    ],
    [webSearchOn, assembleMemoryOn],
  );

  const runBriefMcp = (item: any, tool: any) => {
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
    if ((window as any).BriefTelemetry) {
      (window as any).BriefTelemetry.log((window as any).BriefTelemetry.EVENTS.NEXT_ACTION_CLICK, {
        itemId: item.id,
        tool: key,
      });
    }
  };

  const dismissBriefItem = (item: any) => {
    setMorningBrief((prev: any) => {
      if (!prev?.items) return prev;
      return {
        ...prev,
        items: prev.items.filter((i: any) => i.id !== item.id),
      };
    });
    if ((window as any).BriefTelemetry) {
      (window as any).BriefTelemetry.log((window as any).BriefTelemetry.EVENTS.ITEM_DISMISS, { itemId: item.id });
    }
  };

  const submitBriefRating = (n: number) => {
    if ((window as any).BriefTelemetry) {
      (window as any).BriefTelemetry.log((window as any).BriefTelemetry.EVENTS.RATING, { score: n });
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
                        {section.map((row: any, ri) => (
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
                                (window as any).SHOGUN_RUNTIME?.pushToast?.('この項目は近日対応です', 'info');
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
              onClick={() => setPromptModal((cur: any) => (cur === cat.id ? null : cat.id))}
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
            {sliSnapshot && (
              <span
                className="pill"
                style={{
                  fontSize: 10,
                  color: sliTone?.fg || 'var(--text-mute)',
                  borderColor: sliTone?.border || 'var(--border)',
                  background: sliTone?.bg || 'var(--surface)',
                }}
                title="Last 24h SLI snapshot"
              >
                SLI {Number(sliSnapshot.successRate || 0).toFixed(1)}% · p95 {sliSnapshot.p95LatencyMs ?? '—'}ms · backlog {sliSnapshot.backlog ?? 0}
              </span>
            )}
            <span className="spacer" />
            <span className="t-mono xsmall muted">{briefGeneratedDisplay || '—'}</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 18, lineHeight: 1.35 }}>{morningBrief.headline}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {(morningBrief.items || []).map((item: any) => (
              <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
                <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span className="t-mono xsmall" style={{ color: 'var(--gold)' }}>P{item.priority}</span>
                  <span className="t-mono xsmall muted">{item.category}</span>
                  {Array.isArray(item.related_context) && item.related_context.length > 0 && (
                    <span className="t-mono xsmall muted">src:{item.related_context.length}</span>
                  )}
                  {Array.isArray(item.related_context) && item.related_context[0]?.last_touched && (
                    <span className="t-mono xsmall muted">fresh:{item.related_context[0].last_touched}</span>
                  )}
                  {item.time_hint && <span className="t-mono xsmall">{item.time_hint}</span>}
                  <span className="spacer" />
                  <button type="button" className="btn btn-sm btn-ghost" style={{ fontSize: 10, height: 24 }} onClick={() => dismissBriefItem(item)}>見送る</button>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{item.what}</div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>{item.why_now}</div>
                {(item.related_context || []).length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 10 }}>
                    {(item.related_context || []).map((r: any) => (
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
          {Array.isArray(morningBrief?.patterns) && morningBrief.patterns.length > 0 && (
            <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginTop:'var(--space-4)'}}>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>
                YOUR USUAL
              </div>
              <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                {morningBrief.patterns.slice(0, 4).map((p: any, i: number) => (
                  <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
                    • <span style={{color:'var(--text)'}}>{p.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

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
                  {memoryDigest.day_rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
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
                  {memoryDigest.week_rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
                    <li key={i} style={{ fontSize: 12, color: 'var(--text-mute)', lineHeight: 1.5 }}>{k}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {(() => {
            const nowMs = Date.now();
            const unreadHighlights = Array.isArray(memoryDigest.highlights)
              ? memoryDigest.highlights.filter((h: any) =>
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
                      const items = unreadHighlights.map((h: any) => ({
                        targetId: h.targetId, targetKind: h.targetKind || 'item',
                      }));
                      if (items.length === 0) return;
                      setMemoryDigest((prev: any) => prev ? {
                        ...prev,
                        highlights: (prev.highlights || []).map((h: any) => ({
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
                {unreadHighlights.slice(0, 5).map((h: any) => {
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
                    if (h.entityId && !entityRollupCache[h.entityId]) {
                      setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup: null, loading: true } }));
                      const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                      runRuntimeActionA('memory.rollup.entity.get', {
                        entityId: h.entityId, entityLabel: h.entityId, lang,
                      }, { silentError: true }).then((res: any) => {
                        const rollup = res?.ok && res.data?.rollup ? res.data.rollup : null;
                        setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup, loading: false } }));
                      }).catch(() => {
                        setEntityRollupCache((prev: any) => ({ ...prev, [h.entityId]: { rollup: null, loading: false } }));
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
                              {allPoints.map((p: any, i: number) => (
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
                                      {ent.rollup.keyPoints.slice(0, 4).map((k: any, i: number) => (
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
                                setMemoryDigest((prev: any) => prev ? {
                                  ...prev,
                                  highlights: (prev.highlights || []).map((x: any) => x.targetId === h.targetId ? { ...x, acknowledgedAt: Date.now() } : x),
                                } : prev);
                              }}
                              style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                            >Mark read</button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                window.dispatchEvent(new Event('shogun-jump-memory-timeline'));
                                (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('memory');
                              }}
                              style={{ padding: '2px 0', border: 'none', background: 'transparent', color: 'var(--text-dim)', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline' }}
                            >Open in Memory</button>
                            {[
                              { label: '1h', label_jp: '1時間', compute: (now: number) => now + 60 * 60 * 1000 },
                              { label: 'Tomorrow 9am', label_jp: '明日9時', compute: (now: number) => smartSnoozePresets(new Date(now)).tomorrowMorning },
                              { label: 'Next Monday', label_jp: '来週月曜', compute: (now: number) => smartSnoozePresets(new Date(now)).nextMondayMorning },
                            ].map((opt) => (
                              <button
                                key={opt.label}
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const untilMs = opt.compute(Date.now());
                                  setMemoryDigest((prev: any) => prev ? {
                                    ...prev,
                                    highlights: (prev.highlights || []).map((x: any) => x.targetId === h.targetId ? { ...x, snoozeUntil: untilMs } : x),
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
                (window as any).SHOGUN_RUNTIME?.setActiveScreen?.('memory');
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
                  const lines: string[] = [];
                  const day = memoryDigest && memoryDigest.day_rollup;
                  const week = memoryDigest && memoryDigest.week_rollup;
                  const highlights = (memoryDigest && memoryDigest.highlights) || [];
                  if (day) {
                    lines.push(`## Today — ${day.title || ''}`.trim());
                    (day.keyPoints || []).forEach((k: any) => lines.push(`- ${k}`));
                    lines.push('');
                  }
                  if (week) {
                    lines.push(`## This week — ${week.title || ''}`.trim());
                    (week.keyPoints || []).forEach((k: any) => lines.push(`- ${k}`));
                    lines.push('');
                  }
                  const unread = highlights.filter((h: any) => !h.acknowledgedAt);
                  if (unread.length > 0) {
                    lines.push('## Needs attention');
                    unread.slice(0, 8).forEach((h: any) => {
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
                    (window as any).SHOGUN_RUNTIME?.pushToast?.('Digest copied as Markdown', 'success');
                  } else {
                    (window as any).SHOGUN_RUNTIME?.pushToast?.('Clipboard unavailable', 'warn');
                  }
                } catch (_) {
                  (window as any).SHOGUN_RUNTIME?.pushToast?.('Copy failed', 'error');
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

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenHome = HomeScreen;
}
