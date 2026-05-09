import type { AgentRun } from '../types';

interface RecentRunsListProps {
  runs: AgentRun[] | undefined;
  onSeeAll: () => void;
}

export function RecentRunsList({ runs, onSeeAll }: RecentRunsListProps) {
  if (!runs || runs.length === 0) {
    return (
      <div className="t-sm" style={{color:'var(--text-mute)', padding:'var(--space-2) 0'}}>
        No runs yet.
      </div>
    );
  }
  return (
    <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {runs.slice(0, 5).map((r, i) => {
        const levelColor = r.level === 'success' ? 'var(--success)'
                         : r.level === 'error'   ? 'var(--danger)'
                         : 'var(--text-mute)';
        return (
          <div key={i} style={{display:'grid', gridTemplateColumns:'48px 1fr auto', gap:'var(--space-3)', alignItems:'center'}} className="t-sm">
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{r.t}</span>
            <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.msg}</span>
            <span
              className="label"
              style={{
                borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
                color: levelColor,
              }}
            >
              {r.level.toUpperCase()}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onSeeAll}
        style={{
          all: 'unset',
          alignSelf: 'flex-end',
          marginTop: 'var(--space-1)',
          color: 'var(--text-dim)',
          fontSize: 11,
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        See all →
      </button>
    </div>
  );
}
