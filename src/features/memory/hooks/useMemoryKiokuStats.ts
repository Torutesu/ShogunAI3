import { useEffect, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

export interface KiokuExtractionSummary {
  jobsQueued: number;
  jobsRunning: number;
  jobsDone: number;
  jobsFailed: number;
  jobCompletionRate: number | null;
  edgesActive: number;
  memItemsActive: number;
  edgeDensity: number;
  readPath: string;
}

function parseSummary(data: any): KiokuExtractionSummary | null {
  const s = data?.summary;
  if (!s || typeof s !== 'object') return null;
  const flags = data?.flags;
  const readPath = String(flags?.read_path || 'graph').toLowerCase();
  const rate = s.job_completion_rate;
  return {
    jobsQueued: Number(s.jobs_queued) || 0,
    jobsRunning: Number(s.jobs_running) || 0,
    jobsDone: Number(s.jobs_done) || 0,
    jobsFailed: Number(s.jobs_failed) || 0,
    jobCompletionRate: typeof rate === 'number' && Number.isFinite(rate) ? rate : null,
    edgesActive: Number(s.edges_active) || 0,
    memItemsActive: Number(s.mem_items_active) || 0,
    edgeDensity: typeof s.edge_density === 'number' ? s.edge_density : 0,
    readPath: readPath === 'graph' ? 'graph' : 'legacy',
  };
}

export function useMemoryKiokuStats(enabled: boolean, refreshKey: string | number = 0) {
  const [summary, setSummary] = useState<KiokuExtractionSummary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const r = await runRuntimeAction('kioku.debug_stats', {}, { silentError: true });
      if (cancelled) return;
      if (r?.ok) {
        setSummary(parseSummary(r.data));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return summary;
}
