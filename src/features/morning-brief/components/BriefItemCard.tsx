import { Icon } from '@/shared/icons';
import { contextIconName } from '../lib/posture';
import type { BriefItem, ContextItem } from '../types';

interface BriefItemCardProps {
  item: BriefItem;
  index: number;
  onAction: (item: BriefItem) => void;
  onContext: (ctx: ContextItem) => void;
}

export function BriefItemCard({ item, index, onAction, onContext }: BriefItemCardProps) {
  const num = String(index + 1).padStart(2, '0');
  const ctx = Array.isArray(item.related_context) ? item.related_context.slice(0, 3) : [];

  return (
    <div className="mb-card morning-brief-card">
      <div className="mb-item-head">
        <span className="mb-item-num">{num}</span>
        <div className="mb-item-head-text">
          {item.time_hint ? <div className="t-mono mb-time-hint">{item.time_hint}</div> : null}
          <div className="mb-what">{item.what}</div>
        </div>
      </div>
      <div className="mb-why">{item.why_now}</div>
      {ctx.length > 0 ? (
        <div className="mb-chips">
          {ctx.map((c, i) => (
            <button
              key={i}
              type="button"
              className="mb-chip"
              onClick={() => onContext(c)}
              title={c.uri || ''}
            >
              <Icon name={contextIconName(c.type)} size={12} />
              <span>{c.title}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="mb-cta-row">
        <button
          type="button"
          className="btn btn-sm btn-secondary mb-cta"
          onClick={() => onAction(item)}
        >
          {item.next_action && item.next_action.label ? item.next_action.label : 'Next'}
        </button>
      </div>
    </div>
  );
}
