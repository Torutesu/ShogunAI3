import React from 'react';

export function Field({ label, children, hint }: {
  label: React.ReactNode;
  children?: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="s-field-label">{label}</div>
      {children}
      {hint && <div className="s-field-hint">{hint}</div>}
    </div>
  );
}
