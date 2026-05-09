import { Icon } from '@/shared/icons';

interface AgentsEmptyStateProps {
  filterStatus: string;
  totalCount: number;
  onCreate: () => void;
}

export function AgentsEmptyState({ filterStatus, totalCount, onCreate }: AgentsEmptyStateProps) {
  // Two flavors: zero agents at all (welcome), vs zero matching the filter.
  if (totalCount === 0) {
    return (
      <div style={{
        padding:'var(--space-12) var(--space-6)',
        border:`1px dashed var(--border)`,
        borderRadius:'var(--radius-lg)',
        textAlign:'center',
        color:'var(--text-mute)',
      }}>
        <div style={{
          width:48, height:48, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:`1px solid var(--border)`,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', marginBottom:'var(--space-4)',
        }}>
          <Icon name="plus" size={20}/>
        </div>
        <div style={{fontSize:16, fontWeight:600, color:'var(--text)', marginBottom:'var(--space-2)'}}>
          No agents yet
        </div>
        <div className="t-sm" style={{marginBottom:'var(--space-4)'}}>
          Agents read your memory and act on your behalf.
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Icon name="plus" size={14}/> Create your first agent
        </button>
      </div>
    );
  }
  return (
    <div style={{
      padding:'var(--space-8) var(--space-6)',
      border:`1px dashed var(--border)`,
      borderRadius:'var(--radius-lg)',
      textAlign:'center',
      color:'var(--text-mute)',
    }} className="t-sm">
      No agents in "{filterStatus}".
    </div>
  );
}
