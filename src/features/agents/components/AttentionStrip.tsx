import { Icon } from '@/shared/icons';
import type { AgentDemo } from '../types';
import { ATTENTION_REASONS, agentNeedsAttention, fmtRelativeTime } from '../lib/metadata';

interface AttentionStripProps {
  agents: AgentDemo[];
  nowMs: number;
  onView: (id: string) => void;
  onRunNow: (id: string) => void;
  onShowAllAttention?: () => void;
}

export function AttentionStrip({ agents, nowMs, onView, onRunNow, onShowAllAttention }: AttentionStripProps) {
  // Derive issues: explicit `attention` flag, OR last run was error,
  // OR scheduled/cron and lastRunMs is older than 24h.
  const issues: Array<{ agent: AgentDemo; reason: string; lastRunRel: string }> = [];
  for (const a of agents) {
    if (!agentNeedsAttention(a, nowMs)) continue;
    const last = a.recentRuns && a.recentRuns[0];
    let reason: string | null = null;
    if (a.attention === 'error' || (last && last.level === 'error')) reason = 'error';
    else if (a.attention === 'auth_expired') reason = 'auth_expired';
    else reason = 'stale';
    if (reason) {
      issues.push({
        agent: a,
        reason,
        lastRunRel: a.lastRunMs ? fmtRelativeTime(a.lastRunMs, nowMs) : 'recently',
      });
    }
  }
  if (issues.length === 0) return null;
  const visible = issues.slice(0, 3);
  const overflow = issues.length - visible.length;

  return (
    <div style={{marginBottom:'var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {visible.map(({ agent, reason, lastRunRel }) => (
        <div
          key={agent.id}
          style={{
            display:'flex', alignItems:'center', gap:'var(--space-3)',
            padding:'var(--space-3) var(--space-4)',
            background:'var(--surface-2)',
            borderLeft:'3px solid var(--danger)',
            borderRadius:'var(--radius-md)',
          }}
        >
          <span style={{color:'var(--danger)', flexShrink:0, display:'inline-flex'}}><Icon name="alert" size={14}/></span>
          <span className="t-sm" style={{flex:1, color:'var(--text)'}}>
            {ATTENTION_REASONS[reason]?.({ ...agent, lastRunRel })}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => onRunNow(agent.id)}
          >
            Run now
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onView(agent.id)}
          >
            View
          </button>
        </div>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          className="t-sm"
          onClick={() => {
            if (onShowAllAttention) {
              onShowAllAttention();
              return;
            }
            (window as any).SHOGUN_RUNTIME?.pushToast?.(`Attention filter opened`, 'info');
          }}
          style={{
            all:'unset', cursor:'pointer', color:'var(--text-dim)', alignSelf:'flex-start',
            padding:'var(--space-1) var(--space-2)',
          }}
        >
          +{overflow} more
        </button>
      )}
    </div>
  );
}
