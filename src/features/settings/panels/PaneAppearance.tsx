import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { scheduleAppearanceLive } from '../lib/appearance';
import { SettingsHydrationContext } from '../types';

export function PaneAppearance() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [mode, setMode] = useState('dark');
  const [wide, setWide] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [fontSize, setFontSize] = useState('Normal');
  React.useEffect(() => {
    const a = sections.appearance;
    if (!a || typeof a !== 'object') return;
    if (a.colorMode != null) setMode(String(a.colorMode));
    if (typeof a.extraWideChat === 'boolean') setWide(a.extraWideChat);
    if (typeof a.codeBlockWrap === 'boolean') setWrap(a.codeBlockWrap);
    if (a.fontSize != null) setFontSize(String(a.fontSize));
  }, [sections]);
  return (
    <Pane title="Appearance" jp="外観">
      <div className="s-field-label" style={{ marginBottom: 10 }}>Color Mode</div>
      <div className="s-appearance-grid">
        {[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match System']].map(([k, l]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setMode(k as string); scheduleAppearanceLive(run, { colorMode: k as string, extraWideChat: wide, codeBlockWrap: wrap, fontSize }); }}
            className={'s-color-card ' + (mode === k ? 'active' : '')}
            aria-pressed={mode === k}
          >
            <div className="s-color-preview" data-mode={k}>
              <div className="s-color-bar"><span /><span /><span /></div>
              <div className="s-color-title">What's on your mind?</div>
              <div className="s-color-input" />
            </div>
            <div style={{ marginTop: 8, fontSize: 12, textAlign: 'center', color: mode === k ? 'var(--gold)' : 'var(--text-mute)' }}>{l}</div>
          </button>
        ))}
      </div>
      <div className="s-card">
        <Row title="Extra Wide Chat" desc="Choose whether to make the chat extra wide">
          <Toggle on={wide} onClick={() => { const next = !wide; setWide(next); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: next, codeBlockWrap: wrap, fontSize }); }} />
        </Row>
        <Row title="Font Size" desc="Adjust the size of text across the app">
          <select className="s-select" value={fontSize} onChange={(e) => { const v = e.target.value; setFontSize(v); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: wide, codeBlockWrap: wrap, fontSize: v }); }}>
            <option value="Normal">Normal</option>
            <option value="Compact">Compact</option>
            <option value="Comfortable">Comfortable</option>
          </select>
        </Row>
        <Row title="Code Block Wrapping" desc="Enable or disable code block wrapping" last>
          <Toggle on={wrap} onClick={() => { const next = !wrap; setWrap(next); scheduleAppearanceLive(run, { colorMode: mode, extraWideChat: wide, codeBlockWrap: next, fontSize }); }} />
        </Row>
      </div>
    </Pane>
  );
}
