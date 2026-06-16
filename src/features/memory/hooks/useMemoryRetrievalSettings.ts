import { useCallback, useEffect, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

export type GraphReadPath = 'legacy' | 'graph';

export function useMemoryRetrievalSettings() {
  const [semanticMemorySearch, setSemanticMemorySearch] = useState(true);
  const [graphReadPath, setGraphReadPath] = useState<GraphReadPath>('graph');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [summaryEnabled, setSummaryEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await runRuntimeAction('settings.load', {}, { silentError: true });
      if (cancelled) return;
      const mem = r?.ok && r.data?.settings?.sections?.memory;
      if (mem && typeof mem === 'object' && typeof mem.semanticRerank === 'boolean') {
        setSemanticMemorySearch(mem.semanticRerank);
      }
      if (mem && typeof mem === 'object') {
        setSummaryEnabled(mem.enableMemorySummary !== false);
      }
      const graph = r?.ok && r.data?.settings?.sections?.kioku_graph;
      if (graph && typeof graph === 'object' && typeof graph.read_path === 'string') {
        const path = String(graph.read_path).toLowerCase();
        setGraphReadPath(path === 'graph' ? 'graph' : 'legacy');
      }
      const priv = r?.ok && r.data?.settings?.sections?.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeAction('settings.load', {}, { silentError: true }).then((r: any) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  const withSemantic = useCallback(
    (payload: Record<string, unknown>) => {
      if (!semanticMemorySearch) return payload;
      const q = String((payload && payload.query) || '').trim();
      if (!q) return payload;
      return { ...payload, semantic: true };
    },
    [semanticMemorySearch],
  );

  const saveSemanticRerank = useCallback(async (next: boolean) => {
    const prev = semanticMemorySearch;
    setSemanticMemorySearch(next);
    const r = await runRuntimeAction(
      'settings.save',
      { section: 'memory', semanticRerank: next },
      { silentError: true },
    );
    if (!r?.ok) {
      setSemanticMemorySearch(prev);
      (window as any).SHOGUN_RUNTIME?.pushToast?.('Failed to save Semantic re-rank setting', 'warn');
    }
  }, [semanticMemorySearch]);

  const saveGraphReadPath = useCallback(async (next: GraphReadPath) => {
    const prev = graphReadPath;
    setGraphReadPath(next);
    const r = await runRuntimeAction(
      'settings.save',
      { section: 'kioku_graph', read_path: next },
      { silentError: true },
    );
    if (!r?.ok) {
      setGraphReadPath(prev);
      (window as any).SHOGUN_RUNTIME?.pushToast?.('Failed to save KIOKU graph retrieval setting', 'warn');
      return;
    }
  }, [graphReadPath]);

  return {
    semanticMemorySearch,
    graphReadPath,
    summaryEnabled,
    allowServerMemoryAssembly,
    loaded,
    withSemantic,
    saveSemanticRerank,
    saveGraphReadPath,
  };
}
