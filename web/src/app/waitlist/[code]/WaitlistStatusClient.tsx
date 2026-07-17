'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import posthog from 'posthog-js';

// Funnel events, no-ops unless AnalyticsProvider initialized PostHog.
function track(event: string, props?: Record<string, unknown>) {
  try {
    if (posthog.__loaded) posthog.capture(event, props);
  } catch {}
}

type Lang = 'en' | 'ja';

type Status = {
  refCode: string;
  answers: {
    timeSink: string | null;
    companyRole: string | null;
    why: string | null;
    completed: number;
    formCompletedAt: string | null;
  };
  qualifiedReferrals: number;
  tier: { threshold: number; en: string; ja: string } | null;
  nextTier: { threshold: number; en: string; ja: string } | null;
  leaderboardRank: number | null;
  position: number | null;
  totalPending: number | null;
};

type LeaderboardRow = { rank: number; maskedEmail: string; qualifiedReferrals: number };

const C = {
  bg: '#080808',
  surface: '#141414',
  border: '#2A2A2A',
  text: '#FFFFFF',
  mute: '#999999',
  dim: '#666666',
  gold: '#C8A96E',
};

const TIME_SINK_OPTIONS: { value: string; en: string; ja: string }[] = [
  { value: 'email_and_slack', en: 'Email and chat', ja: 'メールとチャット' },
  { value: 'meetings_and_notes', en: 'Meetings and notes', ja: '会議とメモ' },
  { value: 'context_switching', en: 'Context switching', ja: 'アプリ間の行き来' },
  { value: 'searching_for_things_i_saw', en: 'Finding things I already saw', ja: '一度見たものを探し直す時間' },
  { value: 'scheduling_and_admin', en: 'Scheduling and admin', ja: '日程調整と雑務' },
  { value: 'other', en: 'Other', ja: 'その他' },
];

const COPY = {
  en: {
    kicker: 'WAITING LIST',
    inLine: 'You are in line.',
    position: (p: number, t: number) => `#${p.toLocaleString()} of ${t.toLocaleString()}`,
    formTitle: 'Three questions. Each answer moves you up.',
    formNote: 'Optional — but the line is ordered by who answers.',
    q1: 'Where does your time actually go?',
    q2: 'Company or role',
    q2Placeholder: 'e.g. founder, Acme Inc.',
    q3: 'Why SHOGUN?',
    q3Placeholder: 'One sentence. What should it take off your plate first?',
    submit: 'Answer',
    skip: 'Skip for now',
    answered: 'Locked in. You moved up.',
    formDone: 'All three answered. Your spot is secured.',
    gdpr: 'Answers set your access priority and shape launch communication.',
    privacy: 'Privacy',
    refTitle: 'Skip the line.',
    refBody: 'Share your link. Each person who joins through it and answers their three questions counts as one invite.',
    ladder: [
      { n: '3 invites', r: '1 month free' },
      { n: '10 invites', r: '3 months free' },
      { n: '30 invites', r: '6 months free' },
      { n: 'Top 10 referrers', r: '1 year free' },
    ],
    ladderNote: 'Rewards replace as you climb — the highest tier you reach is the one you get.',
    yourLink: 'Your link',
    copy: 'Copy',
    copied: 'Copied',
    shareX: 'Post on X',
    tweet: (url: string) =>
      `Your AI has memory. Now it acts.\n\nI'm in line for SHOGUN — the OS for the AI-native individual.\n\n${url}`,
    invites: (n: number) => `${n} qualified ${n === 1 ? 'invite' : 'invites'}`,
    currentReward: 'Current reward',
    nextUp: (need: number, reward: string) => `${need} more to ${reward}`,
    lbTitle: 'Top referrers',
    lbEmpty: 'No qualified invites yet. The board is open.',
    yourRank: (r: number) => `You are #${r} on the board.`,
    notFound: 'This link is not active. Join the waiting list at syogun.com.',
    loading: 'Loading…',
  },
  ja: {
    kicker: 'WAITING LIST',
    inLine: '順番待ちに入りました。',
    position: (p: number, t: number) => `${t.toLocaleString()}人中 ${p.toLocaleString()}番目`,
    formTitle: '3つの質問。答えるごとに順位が上がる。',
    formNote: '回答は任意。ただし列の順番は回答者から先に進む。',
    q1: '一番時間を溶かしているのは？',
    q2: '会社名または職種',
    q2Placeholder: '例：スタートアップ創業者、Acme株式会社',
    q3: 'なぜ SHOGUN を？',
    q3Placeholder: '一文で。最初に何を任せたいか。',
    submit: '回答する',
    skip: 'あとで',
    answered: '記録した。順位が上がった。',
    formDone: '3問すべて回答済み。枠を確保した。',
    gdpr: '回答はアクセス優先度の決定とローンチ連絡のために使用します。',
    privacy: 'プライバシー',
    refTitle: '列を飛ばす。',
    refBody: 'リンクを共有する。あなたのリンクから登録して3問に回答した人が1招待としてカウントされる。',
    ladder: [
      { n: '3人招待', r: '1ヶ月無料' },
      { n: '10人招待', r: '3ヶ月無料' },
      { n: '30人招待', r: '6ヶ月無料' },
      { n: 'リファラル上位10人', r: '1年無料' },
    ],
    ladderNote: '特典は加算ではなく置換。到達した最上位の段階が適用される。',
    yourLink: 'あなたのリンク',
    copy: 'コピー',
    copied: 'コピーした',
    shareX: 'Xでポスト',
    tweet: (url: string) =>
      `記憶するAIから、行動するAIへ。\n\nSHOGUNのwaiting listに並んだ。\n\n${url}`,
    invites: (n: number) => `有効招待 ${n}人`,
    currentReward: '現在の特典',
    nextUp: (need: number, reward: string) => `あと${need}人で${reward}`,
    lbTitle: 'リファラル上位',
    lbEmpty: 'まだ有効招待はない。ボードは空いている。',
    yourRank: (r: number) => `あなたは現在${r}位。`,
    notFound: 'このリンクは有効ではありません。syogun.com から登録してください。',
    loading: '読み込み中…',
  },
} as const;

const PRIVACY_URL = 'https://github.com/Torutesu/ShogunAI3/blob/main/PRIVACY.md';
const LP_URL = 'https://syogun.com';

const styles = {
  page: {
    minHeight: '100vh',
    background: C.bg,
    color: C.text,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    padding: '48px 20px 96px',
  },
  wrap: { maxWidth: 640, margin: '0 auto' },
  kicker: {
    fontSize: 12,
    letterSpacing: '0.22em',
    color: C.gold,
    fontFamily: '"JetBrains Mono","SF Mono",monospace',
  },
  h1: { fontSize: 32, fontWeight: 700, margin: '12px 0 4px' },
  card: {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 10,
    padding: 24,
    marginTop: 24,
  },
  mute: { color: C.mute, fontSize: 14, lineHeight: 1.6 },
  dim: { color: C.dim, fontSize: 12, lineHeight: 1.5 },
  input: {
    width: '100%',
    boxSizing: 'border-box' as const,
    background: C.bg,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    color: C.text,
    padding: '12px 14px',
    fontSize: 14,
  },
  btn: {
    background: C.text,
    color: C.bg,
    border: 'none',
    borderRadius: 8,
    padding: '11px 22px',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
  },
  btnGhost: {
    background: 'transparent',
    color: C.mute,
    border: `1px solid ${C.border}`,
    borderRadius: 8,
    padding: '11px 22px',
    fontSize: 14,
    cursor: 'pointer',
  },
  option: (selected: boolean) => ({
    display: 'block',
    width: '100%',
    textAlign: 'left' as const,
    boxSizing: 'border-box' as const,
    background: selected ? C.text : C.bg,
    color: selected ? C.bg : C.text,
    border: `1px solid ${selected ? C.text : C.border}`,
    borderRadius: 8,
    padding: '12px 14px',
    fontSize: 14,
    cursor: 'pointer',
    marginBottom: 8,
  }),
};

export default function WaitlistStatusClient({ code }: { code: string }) {
  const [lang, setLang] = useState<Lang>('en');
  const [status, setStatus] = useState<Status | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'notFound'>('loading');
  const [timeSink, setTimeSink] = useState('');
  const [companyRole, setCompanyRole] = useState('');
  const [why, setWhy] = useState('');
  const [flash, setFlash] = useState('');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const t = COPY[lang];
  // Share link carries the PUBLIC ref code; the URL of this page is the
  // private status token and must never be what gets shared.
  const shareUrl = useMemo(
    () => (status?.refCode ? `${LP_URL}/?ref=${encodeURIComponent(status.refCode)}` : ''),
    [status?.refCode],
  );

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.language?.startsWith('ja')) {
      setLang('ja');
    }
  }, []);

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/waitlist/status?code=${encodeURIComponent(code)}`);
    if (!res.ok) {
      setState('notFound');
      return;
    }
    const data = await res.json();
    setStatus(data);
    setState('ready');
  }, [code]);

  useEffect(() => {
    refresh().catch(() => setState('notFound'));
    fetch('/api/waitlist/leaderboard')
      .then((r) => r.json())
      .then((d) => setLeaderboard(d.leaderboard ?? []))
      .catch(() => {});
  }, [refresh]);

  const submitAnswer = async (payload: Record<string, string>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/waitlist/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, ...payload }),
      });
      if (res.ok) {
        track('waitlist_form_answered', { question: Object.keys(payload)[0] });
        setFlash(t.answered);
        await refresh();
        setTimeout(() => setFlash(''), 2500);
      }
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      track('waitlist_link_copied');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  if (state === 'loading') {
    return (
      <main style={styles.page}>
        <div style={styles.wrap}><p style={styles.mute}>{t.loading}</p></div>
      </main>
    );
  }

  if (state === 'notFound' || !status) {
    return (
      <main style={styles.page}>
        <div style={styles.wrap}>
          <span style={styles.kicker}>{t.kicker}</span>
          <p style={{ ...styles.mute, marginTop: 16 }}>
            {t.notFound}{' '}
            <a href={LP_URL} style={{ color: C.text }}>syogun.com →</a>
          </p>
        </div>
      </main>
    );
  }

  const a = status.answers;
  const nextQuestion = !a.timeSink ? 1 : !a.companyRole ? 2 : !a.why ? 3 : null;
  const xShareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(t.tweet(shareUrl))}`;

  return (
    <main style={styles.page}>
      <div style={styles.wrap}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={styles.kicker}>{t.kicker}</span>
          <button
            onClick={() => setLang(lang === 'en' ? 'ja' : 'en')}
            style={{ ...styles.btnGhost, padding: '4px 12px', fontSize: 12 }}
          >
            {lang === 'en' ? '日本語' : 'EN'}
          </button>
        </div>

        <h1 style={styles.h1}>{t.inLine}</h1>
        {status.position != null && status.totalPending != null && (
          <p style={{ fontSize: 20, color: C.mute, margin: 0 }}>
            <span style={{ color: C.text, fontWeight: 600 }}>
              {t.position(status.position, status.totalPending)}
            </span>
          </p>
        )}

        {flash && (
          <p style={{ color: C.gold, fontSize: 14, marginTop: 12 }}>{flash}</p>
        )}

        {nextQuestion !== null ? (
          <section style={styles.card}>
            <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>{t.formTitle}</h2>
            <p style={{ ...styles.mute, marginTop: 0 }}>{t.formNote}</p>
            <p style={{ ...styles.dim, marginBottom: 20 }}>
              {a.completed}/3
            </p>

            {nextQuestion === 1 && (
              <div>
                <p style={{ fontSize: 15, fontWeight: 600 }}>{t.q1}</p>
                {TIME_SINK_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    style={styles.option(timeSink === o.value)}
                    onClick={() => setTimeSink(o.value)}
                  >
                    {o[lang]}
                  </button>
                ))}
                <button
                  style={{ ...styles.btn, marginTop: 8, opacity: timeSink && !saving ? 1 : 0.4 }}
                  disabled={!timeSink || saving}
                  onClick={() => submitAnswer({ timeSink })}
                >
                  {t.submit}
                </button>
              </div>
            )}

            {nextQuestion === 2 && (
              <div>
                <p style={{ fontSize: 15, fontWeight: 600 }}>{t.q2}</p>
                <input
                  style={styles.input}
                  value={companyRole}
                  placeholder={t.q2Placeholder}
                  onChange={(e) => setCompanyRole(e.target.value)}
                />
                <button
                  style={{ ...styles.btn, marginTop: 12, opacity: companyRole.trim() && !saving ? 1 : 0.4 }}
                  disabled={!companyRole.trim() || saving}
                  onClick={() => submitAnswer({ companyRole })}
                >
                  {t.submit}
                </button>
              </div>
            )}

            {nextQuestion === 3 && (
              <div>
                <p style={{ fontSize: 15, fontWeight: 600 }}>{t.q3}</p>
                <textarea
                  style={{ ...styles.input, minHeight: 80, resize: 'vertical' }}
                  value={why}
                  placeholder={t.q3Placeholder}
                  onChange={(e) => setWhy(e.target.value)}
                />
                <button
                  style={{ ...styles.btn, marginTop: 12, opacity: why.trim() && !saving ? 1 : 0.4 }}
                  disabled={!why.trim() || saving}
                  onClick={() => submitAnswer({ why })}
                >
                  {t.submit}
                </button>
              </div>
            )}

            <p style={{ ...styles.dim, marginTop: 20, marginBottom: 0 }}>
              {t.gdpr}{' '}
              <a href={PRIVACY_URL} style={{ color: C.mute }}>{t.privacy} →</a>
            </p>
          </section>
        ) : (
          <p style={{ ...styles.mute, marginTop: 12 }}>{t.formDone}</p>
        )}

        <section style={styles.card}>
          <h2 style={{ fontSize: 18, margin: '0 0 4px' }}>{t.refTitle}</h2>
          <p style={{ ...styles.mute, marginTop: 0 }}>{t.refBody}</p>

          <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <input style={{ ...styles.input, flex: 1, minWidth: 220 }} readOnly value={shareUrl} />
            <button style={styles.btn} onClick={copyLink}>
              {copied ? t.copied : t.copy}
            </button>
            <a
              href={xShareUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track('waitlist_share_x')}
              style={{ ...styles.btnGhost, textDecoration: 'none', display: 'inline-block' }}
            >
              {t.shareX}
            </a>
          </div>

          <p style={{ fontSize: 15, marginTop: 20, marginBottom: 4 }}>
            <span style={{ color: C.gold, fontWeight: 600 }}>
              {t.invites(status.qualifiedReferrals)}
            </span>
            {status.tier && (
              <span style={styles.mute}>
                {' '}· {t.currentReward}: {status.tier[lang]}
              </span>
            )}
          </p>
          {status.nextTier && (
            <p style={{ ...styles.mute, margin: 0 }}>
              {t.nextUp(status.nextTier.threshold - status.qualifiedReferrals, status.nextTier[lang])}
            </p>
          )}

          <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse', fontSize: 14 }}>
            <tbody>
              {t.ladder.map((row, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: '10px 0', color: C.mute }}>{row.n}</td>
                  <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 600 }}>{row.r}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ ...styles.dim, marginBottom: 0 }}>{t.ladderNote}</p>
        </section>

        <section style={styles.card}>
          <h2 style={{ fontSize: 18, margin: '0 0 12px' }}>{t.lbTitle}</h2>
          {status.leaderboardRank != null && (
            <p style={{ ...styles.mute, marginTop: 0 }}>{t.yourRank(status.leaderboardRank)}</p>
          )}
          {leaderboard.length === 0 ? (
            <p style={{ ...styles.mute, margin: 0 }}>{t.lbEmpty}</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <tbody>
                {leaderboard.map((row) => (
                  <tr key={row.rank} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: '8px 0', color: row.rank <= 10 ? C.gold : C.mute, width: 40 }}>
                      {row.rank}
                    </td>
                    <td style={{ padding: '8px 0', fontFamily: '"JetBrains Mono","SF Mono",monospace', fontSize: 13 }}>
                      {row.maskedEmail}
                    </td>
                    <td style={{ padding: '8px 0', textAlign: 'right', color: C.mute }}>
                      {row.qualifiedReferrals}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </main>
  );
}
