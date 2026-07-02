import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { buildMeetingChatSeed, openChatWithSeed } from '@/shared/context/chat-composer-seed';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import {
  mnl,
  toastM,
  RECIPE_LOCAL_BODIES,
  RECIPE_LABEL_TO_ID,
  isNativeDesktop,
} from '../lib/runtime';

type GranolaDraft = {
  body: string;
  transcript: string;
  summary: string;
  minutes: string;
};

export function useGranolaNoteActions(params: {
  granola: {
    storageKey?: string;
    title?: string;
    backendMeetingId?: string | null;
  } | null;
  granolaDraft: GranolaDraft;
  setGranolaDraft: Dispatch<SetStateAction<GranolaDraft>>;
  setGranolaPane: (pane: string) => void;
  setGranolaTodos: (todos: unknown[] | null) => void;
  setPostRecWaveMenuOpen: (open: boolean) => void;
  granolaAsk: string;
  setMtgTopShareOpen: (open: boolean) => void;
  setGranolaMenuOpen: (open: boolean) => void;
  setGranola: (g: unknown) => void;
  setListTick: (fn: (x: number) => number) => void;
  setMtgEnhanceBusy: (busy: boolean) => void;
}) {
  const {
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
  } = params;

  const granolaMeta = useCallback(
    () => ({
      title: granola && granola.title,
      authorLabel: (granola as { authorLabel?: string })?.authorLabel,
      dateLabel: (granola as { dateLabel?: string })?.dateLabel,
      time: (granola as { time?: string })?.time,
      tag: (granola as { tag?: string })?.tag,
    }),
    [granola],
  );

  const applyStubTranscript = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const tx = L.buildStubTranscript(granolaMeta());
    setGranolaDraft((d) => ({
      ...d,
      transcript: d.transcript ? d.transcript + '\n\n' + tx : tx,
    }));
    toastM('テンプレの文字起こしを挿入しました', 'success');
  }, [granola, granolaMeta, setGranolaDraft]);

  const refreshSummary = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const src = (granolaDraft.transcript || '') + '\n' + (granolaDraft.body || '');
    const sum = L.summarizeLocal(src, granolaMeta());
    setGranolaDraft((d) => ({ ...d, summary: sum }));
    setGranolaPane('summary');
    toastM('要約を更新しました（ルールベース）', 'success');
  }, [granola, granolaMeta, granolaDraft.transcript, granolaDraft.body, setGranolaDraft, setGranolaPane]);

  const refreshMinutes = useCallback(() => {
    const L = mnl();
    if (!L || !granola) return;
    const md = L.buildMinutesMarkdown(
      granolaMeta(),
      granolaDraft.transcript,
      granolaDraft.body,
      granolaDraft.summary,
    );
    setGranolaDraft((d) => ({ ...d, minutes: md }));
    setGranolaPane('minutes');
    toastM('議事録を生成しました（テンプレート）', 'success');
  }, [granola, granolaMeta, granolaDraft, setGranolaDraft, setGranolaPane]);

  const runMtgEnhance = useCallback(async () => {
    if (!granola || !granola.storageKey) return;
    setMtgEnhanceBusy(true);
    try {
      const res = await runRuntimeAction(
        'meetings.enhance',
        {
          storageKey: granola.storageKey,
          title: granola.title || '',
          notes: granolaDraft.body || '',
          transcript: granolaDraft.transcript || '',
          summary: granolaDraft.summary || '',
        },
        { silentError: true },
      );
      const md =
        res &&
        res.ok &&
        res.data &&
        (res.data.minutesMarkdown || res.data.minutes || res.data.markdown);
      if (md && String(md).trim()) {
        setGranolaDraft((d) => ({ ...d, minutes: String(md) }));
        setGranolaPane('minutes');
        toastM('AI 議事録を反映しました', 'success');
        return;
      }
      refreshMinutes();
      toastM('ルールベースの議事録を生成しました（本番 AI はデスクトップ版）', 'info');
    } finally {
      setMtgEnhanceBusy(false);
    }
  }, [granola, granolaDraft, refreshMinutes, setGranolaDraft, setGranolaPane, setMtgEnhanceBusy]);

  const ingestNoteToMemory = useCallback(() => {
    const title = (granola && granola.title) || 'Meeting note';
    const snippet = [
      granolaDraft.summary && granolaDraft.summary.slice(0, 500),
      granolaDraft.transcript && granolaDraft.transcript.slice(0, 1200),
      granolaDraft.body && granolaDraft.body.slice(0, 400),
    ]
      .filter(Boolean)
      .join('\n---\n')
      .slice(0, 4000);
    void runRuntimeAction(
      'memory.ingest',
      {
        title: title + ' · meeting',
        snippet: snippet || '(empty)',
        source: 'meeting',
        provenance: 'meeting',
        entity_id: granola?.backendMeetingId || granola?.storageKey || undefined,
        kinds: ['note', 'meeting'],
      },
      { successMessage: 'Memory に保存しました' },
    );
  }, [granola, granolaDraft]);

  const injectRecipeIntoMemoLocal = useCallback(
    (recipeLabel: string) => {
      const block = RECIPE_LOCAL_BODIES[recipeLabel];
      if (!granola || !block) return;
      setGranolaPane('memo');
      setGranolaDraft((d) => {
        const sep = (d.body || '').trim() ? '\n\n' : '';
        return { ...d, body: (d.body || '') + sep + block };
      });
      toastM('テンプレートをメモに挿入しました', 'success');
      setPostRecWaveMenuOpen(false);
    },
    [granola, setGranolaDraft, setGranolaPane, setPostRecWaveMenuOpen],
  );

  const runMeetingRecipe = useCallback(
    async (recipeLabel: string, target: 'memo' | 'summary' = 'memo') => {
      const recipeId = RECIPE_LABEL_TO_ID[recipeLabel];
      if (!recipeId || !isNativeDesktop()) {
        injectRecipeIntoMemoLocal(recipeLabel);
        return;
      }
      const payload: Record<string, unknown> = { recipe_id: recipeId };
      if (granola && granola.backendMeetingId) {
        payload.meeting_id = granola.backendMeetingId;
      } else {
        payload.transcript = granolaDraft.transcript || '';
        payload.notes = granolaDraft.body || '';
      }
      const res = await runRuntimeAction('meetings.recipe.run', payload, { silentError: true });
      if (res && res.ok && res.data && res.data.text && String(res.data.text).trim()) {
        const text = String(res.data.text);
        setGranolaDraft((d) => {
          if (target === 'summary') return { ...d, summary: text };
          const sep = (d.body || '').trim() ? '\n\n' : '';
          return { ...d, body: (d.body || '') + sep + text };
        });
        setGranolaPane(target === 'summary' ? 'summary' : 'memo');
        toastM('レシピを実行しました', 'success');
        return;
      }
      injectRecipeIntoMemoLocal(recipeLabel);
    },
    [granola, granolaDraft, injectRecipeIntoMemoLocal, setGranolaDraft, setGranolaPane],
  );

  const moveGranolaToTrash = useCallback(() => {
    if (!granola || !granola.storageKey) return;
    if (!window.confirm('この会議ノートをゴミ箱に移しますか？ローカルに保存した内容が削除されます。')) return;
    const L = mnl();
    if (L && L.deleteNote) L.deleteNote(granola.storageKey);
    if (L && L.removeMeetingLogEntryByStorageKey) {
      L.removeMeetingLogEntryByStorageKey(granola.storageKey);
    }
    setMtgTopShareOpen(false);
    setGranolaMenuOpen(false);
    setGranola(null);
    setListTick((x) => x + 1);
    toastM('ゴミ箱に移しました（ローカル）', 'success');
  }, [granola, setGranola, setGranolaMenuOpen, setListTick, setMtgTopShareOpen]);

  const mtgDraftEmail = useCallback(() => {
    if (!granola) return;
    const blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes]
      .filter(Boolean)
      .join('\n\n');
    void runRuntimeAction(
      'shogun.draft_reply',
      {
        format: 'email',
        sourceText: blob,
        meetingTitle: granola.title,
      },
      { silentError: true },
    ).then((r) => {
      const c = r && r.ok && r.data && r.data.content;
      if (c && navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(c).then(
          () => toastM('メール下書きをクリップボードにコピーしました', 'success'),
          () => toastM('下書きは取得できましたがコピーに失敗しました', 'warn'),
        );
        return;
      }
      if (c) {
        toastM('クリップボードが利用できません', 'warn');
        return;
      }
      const errMsg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
      toastM(
        errMsg ? 'メール下書きに失敗しました — ' + errMsg : 'メール下書きを取得できませんでした',
        'warn',
      );
    });
  }, [granola, granolaDraft]);

  const mtgCopyAllText = useCallback(() => {
    const blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes]
      .filter(Boolean)
      .join('\n\n');
    if (!blob.trim()) {
      toastM('コピーするテキストがありません', 'info');
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(blob).then(
        () => toastM('テキストをコピーしました', 'success'),
        () => toastM('コピーに失敗しました', 'warn'),
      );
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
    toastM(`「${q}」→ このノート内 ${n} 件一致（ローカル検索）`, n ? 'success' : 'info');
  }, [granolaAsk, granolaDraft]);

  const runAskChat = useCallback(() => {
    if (!granola) return;
    const meetingId = String(granola.backendMeetingId || granola.storageKey || '').trim();
    if (!meetingId) return;
    const question = String(granolaAsk || '').trim();
    const transcriptSnippet = String(granolaDraft.transcript || '').trim().slice(0, 1200);
    const noteSnippet = [
      String(granolaDraft.body || '').trim().slice(0, 700),
      String(granolaDraft.summary || '').trim().slice(0, 500),
      String(granolaDraft.minutes || '').trim().slice(0, 700),
    ]
      .filter(Boolean)
      .join('\n---\n')
      .slice(0, 1600);
    openChatWithSeed(buildMeetingChatSeed({
      meetingId,
      title: granola.title ?? null,
      transcriptSnippet,
      noteSnippet,
      question: question || 'この会議ノートの論点と次の一手を整理してください。',
    }));
  }, [granola, granolaAsk, granolaDraft]);

  const listLocalTodos = useCallback(() => {
    const L = mnl();
    const blob = [granolaDraft.body, granolaDraft.transcript, granolaDraft.summary, granolaDraft.minutes].join('\n');
    const todos = L ? L.extractTodos(blob) : [];
    setGranolaTodos(todos);
    toastM(`ToDo ${todos.length} 件（ローカル抽出・ボット未使用）`, todos.length ? 'success' : 'info');
  }, [granolaDraft, setGranolaTodos]);

  const injectRecipeIntoMemo = useCallback(
    (recipeLabel: string) => {
      void runMeetingRecipe(recipeLabel, 'memo');
    },
    [runMeetingRecipe],
  );

  const runPostRecSlashItem = useCallback(
    (item: { kind?: string; id?: string; recipeLabel?: string }) => {
      setPostRecWaveMenuOpen(false);
      if (item.kind === 'action' && item.id === 'todos') {
        listLocalTodos();
        return;
      }
      if (item.kind === 'recipe' && item.recipeLabel) {
        void runMeetingRecipe(item.recipeLabel, 'memo');
      }
    },
    [listLocalTodos, runMeetingRecipe, setPostRecWaveMenuOpen],
  );

  return {
    applyStubTranscript,
    refreshSummary,
    refreshMinutes,
    runMtgEnhance,
    ingestNoteToMemory,
    injectRecipeIntoMemo,
    runMeetingRecipe,
    moveGranolaToTrash,
    mtgDraftEmail,
    mtgCopyAllText,
    runLocalAsk,
    runAskChat,
    listLocalTodos,
    runPostRecSlashItem,
  };
}
