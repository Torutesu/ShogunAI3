import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/shared/icons';
import type { AgentDemo, AgentRun } from '../types';
import { AGENT_STATUS_META, SYNTHETIC_RUN_TEMPLATES, buildAgentSubLine } from '../lib/metadata';
import { RunRow } from './RunRow';

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatRunStamp(d: Date, weekly: boolean): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (weekly) {
    const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${wd} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

// Pure: deterministically pads agent.recentRuns out to 50 entries by
// stepping backwards from the oldest curated run, using a per-trigger
// stride. Synthetic content is intentionally repetitive so it reads as
// background noise next to the curated entries on top.
function generateAgentRunHistory(agent: AgentDemo): AgentRun[] {
  const out: AgentRun[] = [...(agent.recentRuns || [])];
  if (out.length === 0) return out;
  const last = out[out.length - 1];
  if (!last) return out;
  // Stride per agent kind, in ms. Cron-ish agents step by 2h, daily by
  // 24h, weekly by 7d. Default falls back to 2h.
  let strideMs: number;
  if (agent.trigger === 'weekly') strideMs = 7 * 24 * 60 * 60 * 1000;
  else if ((agent.trigger || '').endsWith('daily')) strideMs = 24 * 60 * 60 * 1000;
  else strideMs = 2 * 60 * 60 * 1000;

  const agentTemplates = SYNTHETIC_RUN_TEMPLATES[agent.id];
  const fallbackTemplates = SYNTHETIC_RUN_TEMPLATES['default'];
  const templates = (agentTemplates ?? fallbackTemplates)!;
  let cursor = last.atMs - strideMs;
  let i = 0;
  while (out.length < 50) {
    const tpl = templates[i % templates.length];
    if (!tpl) { i += 1; cursor -= strideMs; continue; }
    // every ~12th synthetic run is an error so the drawer can demo failures.
    const isError = (i + 1) % 12 === 0;
    const atMs = cursor;
    const d = new Date(atMs);
    const t = formatRunStamp(d, agent.trigger === 'weekly');
    const run: AgentRun = {
      id: `${agent.id}-r-syn-${i + 1}`,
      atMs, t,
      msg: isError ? 'Run failed · see details' : tpl.msg,
      level: isError ? 'error' : 'info',
      durationMs: tpl.durationMs,
      tools: tpl.tools,
      input: tpl.input,
      output: isError ? '' : tpl.output,
      memoryTouched: [],
    };
    if (isError) {
      run.error = 'TypeError: Cannot read property \'subject\' of undefined\n    at processInbox (gmail.js:42)\n    at runAgent (runner.js:88)';
    }
    out.push(run);
    cursor -= strideMs;
    i += 1;
  }
  return out;
}

// Bucket runs into 4 chronological groups based on `atMs` and the
// caller's `nowMs`. Returns an ordered array of { label, runs }.
function bucketRunsByDate(runs: AgentRun[], nowMs: number): Array<{ label: string; runs: AgentRun[] }> {
  const now = new Date(nowMs);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  const dow = startOfWeek.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  startOfWeek.setDate(startOfWeek.getDate() + mondayOffset);

  const todayRuns: AgentRun[] = [];
  const yesterdayRuns: AgentRun[] = [];
  const weekRuns: AgentRun[] = [];
  const earlierRuns: AgentRun[] = [];

  for (const r of runs) {
    if (r.atMs >= startOfToday.getTime()) todayRuns.push(r);
    else if (r.atMs >= startOfYesterday.getTime()) yesterdayRuns.push(r);
    else if (r.atMs >= startOfWeek.getTime()) weekRuns.push(r);
    else earlierRuns.push(r);
  }

  return [
    { label: 'TODAY', runs: todayRuns },
    { label: 'YESTERDAY', runs: yesterdayRuns },
    { label: 'THIS WEEK', runs: weekRuns },
    { label: 'EARLIER', runs: earlierRuns },
  ].filter((b) => b.runs.length > 0);
}

// ─── Component ────────────────────────────────────────────────────────────

interface AgentRunHistoryDrawerProps {
  agent: AgentDemo;
  nowMs: number;
  onClose: () => void;
}

export function AgentRunHistoryDrawer({ agent, nowMs, onClose }: AgentRunHistoryDrawerProps) {
  const [expandedRunIds, setExpandedRunIds] = useState<Set<string>>(() => new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpandedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runs = useMemo(() => generateAgentRunHistory(agent), [agent]);
  const buckets = useMemo(() => bucketRunsByDate(runs, nowMs), [runs, nowMs]);

  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] ?? AGENT_STATUS_META['idle']!;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  const onOpenMemory = (id: string) => {
    (window as any).SHOGUN_RUNTIME?.pushToast?.(`Memory item view coming soon (${id})`, 'info');
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position:'fixed', inset:0, zIndex:999,
          background:'rgba(0,0,0,0.4)',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} run history`}
        style={{
          position:'fixed', right:0, top:0, bottom:0,
          width:480, maxWidth:'95vw', zIndex:1000,
          background:'var(--surface)',
          borderLeft:'1px solid var(--border-hi)',
          boxShadow:'var(--shadow-lg)',
          display:'flex', flexDirection:'column',
        }}
      >
        <div style={{
          padding:'var(--space-5) var(--space-6)',
          borderBottom:'1px solid var(--border)',
          display:'flex', alignItems:'flex-start', gap:'var(--space-3)',
        }}>
          <div style={{
            width:40, height:40, borderRadius:'var(--radius-md)',
            background:'var(--surface-2)', border:'1px solid var(--border)',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'var(--gold)', flexShrink:0,
          }}>
            <Icon name={agent.icon} size={18}/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em', marginBottom:4}}>{agent.name}</div>
            <div className="t-mono" style={{display:'inline-flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span style={{width:6, height:6, borderRadius:999, background:status.color, display:'inline-block'}}/>
              {subLine}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close run history"
            style={{
              all:'unset',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
            }}
          >
            <Icon name="x" size={15}/>
          </button>
        </div>
        <div style={{flex:1, overflowY:'auto', padding:'var(--space-5) var(--space-6)'}}>
          {buckets.length === 0 ? (
            <div style={{
              padding:'var(--space-8) var(--space-4)',
              border:`1px dashed var(--border)`,
              borderRadius:'var(--radius-md)',
              textAlign:'center',
              color:'var(--text-mute)',
            }} className="t-sm">
              No runs yet for this agent.
            </div>
          ) : (
            buckets.map(({ label, runs: bucketRuns }, gi) => (
              <div key={label} style={{marginTop: gi === 0 ? 0 : 'var(--space-4)'}}>
                <div className="t-mono" style={{
                  color:'var(--text-mute)', fontSize:10,
                  marginBottom:'var(--space-2)',
                }}>
                  {label}
                </div>
                <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                  {bucketRuns.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      expanded={expandedRunIds.has(r.id)}
                      onToggle={() => toggleExpanded(r.id)}
                      onOpenMemory={onOpenMemory}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
