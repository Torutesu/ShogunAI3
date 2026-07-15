import { Icon } from '@/shared/icons';
import type { AgentDemo } from '../types';
import { AGENT_STATUS_META, buildAgentSubLine, fmtNextTime } from '../lib/metadata';
import { RecentRunsList } from './RecentRunsList';

interface AgentCardProps {
  agent: AgentDemo;
  expanded: boolean;
  onToggle: () => void;
  nowMs: number;
  onOpenHistory: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete?: (id: string) => void;
  running: boolean;
  onRunNow: () => void;
  onTogglePause: () => void;
}

export function AgentCard({
  agent, expanded, onToggle, nowMs, onOpenHistory, onEdit, onDelete, running, onRunNow, onTogglePause,
}: AgentCardProps) {
  // If the most recent run failed, surface it as `error` regardless of
  // the schema status — operationally this is what matters.
  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] ?? AGENT_STATUS_META['idle']!;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  return (
    <div
      id={`agent-card-${agent.id}`}
      className="card card-hover"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderColor: expanded ? 'var(--border-hi)' : 'var(--border)',
        transition: `border-color var(--dur-base) var(--ease-out)`,
      }}
    >
      <div style={{padding:'var(--space-4) var(--space-6)', display:'flex', alignItems:'flex-start', gap:'var(--space-3)'}}>
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
          onClick={onToggle}
          aria-label={expanded ? 'Collapse agent' : 'Expand agent'}
          aria-expanded={expanded}
          style={{
            all:'unset',
            padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
          }}
        >
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15}/>
        </button>
      </div>
      <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-4) var(--space-6)', color:'var(--text-mute)'}} className="t-sm">
        {agent.description}
      </div>
      {expanded && (
        <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-5) var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-4)'}}>
          {/* TRIGGER */}
          <div>
            <div className="t-mono" style={{color:'var(--text-mute)', marginBottom:'var(--space-1)'}}>TRIGGER</div>
            <div className="t-sm">
              {agent.trigger}
              {agent.triggerSince && <> · since {agent.triggerSince}</>}
              {fmtNextTime(agent.nextRunMs, nowMs) && <> · next {fmtNextTime(agent.nextRunMs, nowMs)}</>}
            </div>
          </div>
          {/* Actions */}
          <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={running}
              onClick={onRunNow}
              style={{opacity: running ? 0.6 : 1, cursor: running ? 'wait' : 'pointer'}}
            >
              <Icon name={running ? 'loader' : 'play'} size={12}/>
              {running ? ' Running…' : ' Run now'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={onTogglePause}
            >
              <Icon name={agent.paused ? 'play' : 'pause'} size={12}/>
              {agent.paused ? ' Resume' : ' Pause'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => onEdit(agent.id)}
            >
              <Icon name="edit" size={12}/> Edit
            </button>
            {agent.isCustom && onDelete ? (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => onDelete(agent.id)}
              >
                <Icon name="trash" size={12}/> Delete
              </button>
            ) : null}
          </div>
          {/* Recent runs */}
          <div>
            <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:'var(--space-2)'}}>
              <span className="t-mono" style={{color:'var(--text-mute)'}}>RECENT RUNS</span>
            </div>
            <RecentRunsList
              runs={agent.recentRuns}
              onSeeAll={() => onOpenHistory(agent.id)}
            />
          </div>
        </div>
      )}
      <div style={{padding:'var(--space-3) var(--space-6)', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
        <span style={{flex:1}}/>
        {agent.tools.map((tool) => (
          <span key={tool.name} className="label" style={{display:'inline-flex', alignItems:'center', gap:5}}>
            <Icon name={tool.icon} size={11}/>{tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}
