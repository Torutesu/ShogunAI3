import { FILTER_OPTIONS } from '../lib/metadata';

interface FilterBarProps {
  active: string;
  onChange: (id: string) => void;
  counts: Record<string, number>;
  search: string;
  onSearchChange: (value: string) => void;
}

export function FilterBar({ active, onChange, counts, search, onSearchChange }: FilterBarProps) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:'var(--space-2)',
      marginBottom:'var(--space-4)', flexWrap:'wrap',
    }}>
      {FILTER_OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        const count = counts[opt.id] ?? 0;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            style={{
              all:'unset', cursor:'pointer',
              padding:'var(--space-1) var(--space-3)',
              border:`1px solid ${isActive ? 'var(--border-hi)' : 'var(--border)'}`,
              borderRadius: 999,
              color: isActive ? 'var(--text)' : 'var(--text-mute)',
              fontSize: 12,
              transition: `all var(--dur-fast) var(--ease-out)`,
            }}
          >
            {opt.label} ({count})
          </button>
        );
      })}
      <span style={{flex:1}}/>
      <input
        type="text"
        value={search}
        onChange={(e) => onSearchChange(e.target.value)}
        placeholder="search ⌘F"
        aria-label="Search agents"
        style={{
          background:'transparent', border:`1px solid var(--border)`,
          borderRadius:'var(--radius-sm)', padding:'var(--space-1) var(--space-3)',
          color:'var(--text)', fontSize:12, fontFamily:'inherit',
          width:160,
        }}
      />
    </div>
  );
}
