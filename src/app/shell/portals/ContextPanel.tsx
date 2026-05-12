import * as ReactDOM from 'react-dom';
import { Icon } from '@/shared/icons';

export interface ContextPanelProps {
  open: boolean;
  anchor: { left: number; bottom: number; width: number };
  onClose: () => void;
  onOpenSettings: (pane: string) => void;
}

export function ContextPanel(props: ContextPanelProps) {
  if (!props.open) return null;
  return ReactDOM.createPortal(
    <>
      <div
        role="presentation"
        style={{ position: 'fixed', inset: 0, zIndex: 1078 }}
        onMouseDown={props.onClose}
      />
      <div
        className="context-panel"
        style={{ left: props.anchor.left, bottom: props.anchor.bottom, width: props.anchor.width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="context-panel-title">Data and Privacy</div>
        <div className="context-awareness-card">
          <button type="button" className="context-awareness-close" onClick={props.onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
          <div className="context-awareness-heading">Context Awareness</div>
          <div className="context-panel-body-copy">
            SHOGUN AI remembers your work across apps, no integrations needed.
          </div>
          <button type="button" className="context-link-btn" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
            Learn more <Icon name="arrowUpRight" size={14} />
          </button>
        </div>
        <button type="button" className="context-panel-row" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
          <span>Pause Context Awareness</span>
          <Icon name="chevronRight" size={14} />
        </button>
        <button type="button" className="context-panel-row" onClick={() => { props.onOpenSettings('data'); props.onClose(); }}>
          <span>Delete Data</span>
          <Icon name="chevronRight" size={14} />
        </button>
        <div className="context-panel-foot">
          <button type="button" className="context-manage-btn" onClick={() => { props.onOpenSettings('privacy'); props.onClose(); }}>
            Manage
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
