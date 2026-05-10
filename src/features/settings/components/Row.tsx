import React from 'react';

export function Row({ title, desc, children, last }: {
  title: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={'s-row' + (last ? ' last' : '')}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="s-row-title">{title}</div>
        {desc && <div className="s-row-desc">{desc}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
