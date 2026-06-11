import { MeetingNoteLocal } from '@/shared/lib/meeting-note-local';
import { ShogunUserTimezone } from '@/shared/lib/user-timezone';

export function mnl(): any {
  return MeetingNoteLocal || null;
}

export function toastM(message: string, kind?: string): void {
  const rt = (window as any).SHOGUN_RUNTIME;
  if (rt && typeof rt.pushToast === 'function') {
    rt.pushToast(message, kind || 'info');
  }
}

export function briefPayloadWithUserTz(base: any): any {
  const b = base && typeof base === 'object' ? base : {};
  let tz = '';
  const stz = ShogunUserTimezone;
  if (stz && typeof stz.getTimeZone === 'function') {
    tz = stz.getTimeZone();
  }
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch (_e) {}
  }
  return tz ? Object.assign({}, b, { user_tz: tz }) : b;
}

/** Map UI recipe labels → backend `recipe_id` slugs (`meeting_recipes.rs`). */
export const RECIPE_LABEL_TO_ID: Record<string, string> = {
  'Coach me: Matt 1:1': 'rec-coach-me',
  'Write weekly recap': 'rec-feature-digest',
  'List open decisions': 'rec-decision-log',
  'Draft follow-ups': 'rec-follow-up-email',
};

/** Local body templates for recipes (fallback when LLM unavailable). */
export const RECIPE_LOCAL_BODIES: Record<string, string> = {
  'Write weekly recap': '## 週報\n\n### 今週のハイライト\n- \n\n### 来週のフォーカス\n- \n\n### リスク\n- \n',
  'Coach me: Matt 1:1': '## 1:1 コーチング\n\n### 前回からのフォロー\n- \n\n### 今回の議題\n- \n\n### ネクストアクション\n- [ ] \n',
  'List open decisions': '## 未決定事項リスト\n\n| 議題 | 状態 | 期日 |\n|------|------|------|\n| | 検討中 | |\n\n### 決定済み\n- \n',
  'Draft follow-ups': '## フォローアップ\n\n- [ ] \n- [ ] \n\n### 送信済み\n- \n',
};

export const MEETINGS_COMING_UP_STORAGE = 'shogun.hifi.meetingsComingUp.v1';

/** Dock slash menu + "All recipes" browser (labels must match RECIPE_LOCAL_BODIES / Granola recipes). */
export const MEETINGS_DOCK_SLASH_CATALOG: Array<{
  id: string;
  label: string;
  desc: string;
  jpHint: string;
  kind: string;
  accent: string;
  recipeLabel?: string;
  recipeJp?: string;
}> = [
  { id: 'todos', label: 'List recent todos', desc: 'Surface every unchecked line and TODO marker across notes—in one pass.', jpHint: 'ノート横断で未完了を集約', kind: 'action', accent: 'mint' },
  { id: 'coach', label: 'Coach me: Matt 1:1', desc: 'Spin up a structured 1:1—agenda, follow-ups, and next actions.', jpHint: '1:1 用のテンプを開く', kind: 'recipe', recipeLabel: 'Coach me: Matt 1:1', recipeJp: '対话', accent: 'amber' },
  { id: 'weekly', label: 'Write weekly recap', desc: 'Ship a crisp weekly narrative: wins, risks, and what changed.', jpHint: '週次レビューの骨子を作成', kind: 'recipe', recipeLabel: 'Write weekly recap', recipeJp: '週報', accent: 'violet' },
  { id: 'decisions', label: 'List open decisions', desc: 'Draft a decision log—what is open, who owns it, and by when.', jpHint: '未決定とオーナーを一覧', kind: 'recipe', recipeLabel: 'List open decisions', recipeJp: '決定', accent: 'rose' },
  { id: 'followups', label: 'Draft follow-ups', desc: 'Turn threads into a send-ready checklist your team can act on.', jpHint: 'フォロー用チェックリスト', kind: 'recipe', recipeLabel: 'Draft follow-ups', recipeJp: '追跡', accent: 'cyan' },
];

/** Granola overlay CSS class tokens (styles live in app.css). */
export const GRANOLA_CLASSES = {
  pill: 'granola-pill',
  pillBtn: 'granola-pill granola-pill--btn',
  pillGold: 'granola-pill granola-pill--gold',
  miniBtn: 'granola-mini-btn',
  miniBtnGold: 'granola-mini-btn granola-mini-btn--gold',
  textarea: 'granola-textarea',
  iconBtn: 'granola-icon-btn',
} as const;

export function isNativeDesktop(): boolean {
  return !!(typeof window !== 'undefined' && (window as Window & { __TAURI__?: unknown }).__TAURI__);
}

export function formatLiveTranscript(segments: Array<{ speaker?: string; text?: string }>): string {
  return segments
    .map((s) => {
      const sp = s.speaker === 'self' ? 'You' : s.speaker === 'other' ? 'Other' : (s.speaker || 'Speaker');
      return `${sp}: ${s.text || ''}`;
    })
    .filter((line) => line.trim().length > 3)
    .join('\n');
}

export function fmtElapsedMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  return String(m) + ':' + String(sec).padStart(2, '0');
}

/** ノートに録音完了行が入っているか（録音済みMTGとして下部タブを出す） */
export function noteHasCompletedRecording(storageKey: string): boolean {
  const L = mnl();
  if (!L || !storageKey || !L.loadNote) return false;
  const n = L.loadNote(storageKey);
  const t = (n && n.transcript) || '';
  return /\[録音\s[^\]]+\]/.test(t) || t.indexOf('音声ファイル:') !== -1;
}

