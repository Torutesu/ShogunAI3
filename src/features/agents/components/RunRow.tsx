import type { AgentRun } from '../types';
import { formatAgentRunSource } from '../lib/run-source';

interface RunRowProps {
  run: AgentRun;
  expanded: boolean;
  onToggle: () => void;
  onOpenMemory: (id: string) => void;
  onOpenOutput?: () => void;
}

export function RunRow({ run, expanded, onToggle, onOpenMemory, onOpenOutput }: RunRowProps) {
  const levelColor = run.level === 'success' ? 'var(--success)'
                   : run.level === 'error'   ? 'var(--danger)'
                   : 'var(--text-mute)';
  const dur = run.durationMs < 1000
    ? `${run.durationMs}ms`
    : `${(run.durationMs / 1000).toFixed(1)}s`;
  const sourceLabel = formatAgentRunSource(run.source);

  return (
    <div style={{display:'flex', flexDirection:'column'}}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          display: 'grid',
          gridTemplateColumns: sourceLabel ? '56px 48px 84px 1fr auto' : '56px 48px 1fr auto',
          gap: 'var(--space-3)',
          alignItems: 'baseline',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <span className="t-mono" style={{color:'var(--text-mute)', fontSize:11}}>{run.t}</span>
        <span className="t-mono" style={{color:'var(--text-dim)', fontSize:11}}>{dur}</span>
        {sourceLabel && (
          <span className="t-mono" style={{color:'var(--text-dim)', fontSize:10}}>
            {sourceLabel}
          </span>
        )}
        <span style={{color:'var(--text)', fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {run.msg}
        </span>
        <span
          className="label"
          style={{
            borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
            color: levelColor,
          }}
        >
          {run.level.toUpperCase()}
        </span>
      </button>
      {expanded && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          marginBottom: 'var(--space-2)',
        }}>
          {sourceLabel && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>SOURCE</div>
              <div className="t-sm" style={{color:'var(--text)'}}>{sourceLabel}</div>
            </div>
          )}
          {run.tools && run.tools.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>TOOLS</div>
              <div className="t-sm" style={{color:'var(--text)'}}>{run.tools.join(' · ')}</div>
            </div>
          )}
          {run.input && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>INPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.input}</div>
            </div>
          )}
          {run.level === 'error' && run.error ? (
            <div>
              <div className="t-mono" style={{color:'var(--danger)', fontSize:10, marginBottom:'var(--space-1)'}}>ERROR</div>
              <div
                className="t-sm t-mono"
                style={{
                  color:'var(--text)',
                  whiteSpace:'pre-wrap',
                  borderLeft:'2px solid var(--danger)',
                  paddingLeft:'var(--space-2)',
                  fontSize:11,
                }}
              >
                {run.error}
              </div>
            </div>
          ) : run.output ? (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>OUTPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.output}</div>
              {onOpenOutput ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenOutput();
                  }}
                  className="btn btn-sm btn-ghost"
                  style={{ marginTop: 'var(--space-2)' }}
                >
                  Open in Chat
                </button>
              ) : null}
            </div>
          ) : null}
          {run.memoryTouched && run.memoryTouched.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>MEMORY TOUCHED</div>
              <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                {run.memoryTouched.map((m, i) => (
                  <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
                    • <span style={{color:'var(--text)'}}>{m.title}</span>
                    {m.note && <span> ({m.note})</span>}
                    {!m.note && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenMemory(m.id); }}
                        style={{
                          all:'unset', cursor:'pointer',
                          color:'var(--text-dim)', fontSize:11,
                          textDecoration:'underline', marginLeft:'var(--space-2)',
                        }}
                      >
                        [open]
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
