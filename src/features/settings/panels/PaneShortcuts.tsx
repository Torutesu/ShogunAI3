import React from 'react';
import { Pane } from '../components/Pane';
import { SettingsHydrationContext } from '../types';

export function PaneShortcuts() {
  const { sections } = React.useContext(SettingsHydrationContext);
  const Kbd = typeof window !== 'undefined' ? (window as any).ShogunKeyboardShortcuts : null;
  const merged = React.useMemo(() => {
    if (!Kbd) return null;
    return Kbd.mergeShortcutBindings(sections.shortcuts && sections.shortcuts.bindings);
  }, [sections.shortcuts, Kbd]);

  const groups = React.useMemo(() => {
    if (!Kbd || !merged) return [];
    return Kbd.SHORTCUT_UI_GROUPS.map((g: any) => ({
      name: g.name,
      rows: g.items.map(({ label, actionId }: any) => ({
        label,
        keys: Kbd.bindingToDisplayParts(merged[actionId]),
      })),
    }));
  }, [Kbd, merged]);

  if (!Kbd || !merged) {
    return (
      <Pane title="Keyboard Shortcuts" jp="捷径">
        <div className="s-field-hint">Shortcut module not loaded. Ensure keyboard-shortcuts.js is included before app.jsx.</div>
      </Pane>
    );
  }

  return (
    <Pane title="Keyboard Shortcuts" jp="捷径">
      {groups.map((g: any) => (
        <div key={g.name} style={{ marginBottom: 18 }}>
          <div className="s-field-label" style={{ marginBottom: 8 }}>{g.name}</div>
          <div className="s-card">
            {g.rows.map((row: any, i: number, arr: any[]) => (
              <div key={row.label} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
                <div style={{ flex: 1, fontSize: 13 }}>{row.label}</div>
                <div className="row" style={{ gap: 4 }}>
                  {row.keys.map((k: string, j: number) => (
                    <span key={j} className="s-kbd">{k}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Pane>
  );
}
