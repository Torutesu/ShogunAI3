import React from 'react';

export function Pane({ title, jp, children, subtitle }: {
  title: string;
  jp?: string;
  children?: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  return (
    <div className="s-pane">
      <div className="s-pane-head">
        <h2 style={{ margin: 0, fontSize: 19, fontWeight: 500, letterSpacing: '-0.01em' }}>
          {title}
          <span className="jp" style={{ fontSize: 12.5, marginLeft: 8, color: 'var(--text-dim)', fontWeight: 300 }}>{jp}</span>
        </h2>
        {subtitle && <div className="s-pane-sub">{subtitle}</div>}
      </div>
      <div className="s-pane-body">{children}</div>
    </div>
  );
}
