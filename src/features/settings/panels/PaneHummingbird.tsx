import React, { useState } from 'react';
import { Icon, Kamon } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';

export function PaneHummingbird() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [open, setOpen] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [alwaysNew, setAlwaysNew] = useState(false);
  const [mode, setMode] = useState('any_app');
  const [globalShortcut, setGlobalShortcut] = useState('option_double_tap');
  React.useEffect(() => {
    const h = sections.hummingbird;
    if (!h || typeof h !== 'object') return;
    if (h.mode != null) setMode(String(h.mode));
    if (typeof h.enabled === 'boolean') setEnabled(h.enabled);
    if (typeof h.alwaysNew === 'boolean') setAlwaysNew(h.alwaysNew);
    if (h.globalShortcut != null) setGlobalShortcut(String(h.globalShortcut));
  }, [sections]);
  return (
    <Pane title="Hummingbird" jp="鳥" subtitle="Chat with anything on your screen — apps, meetings, or selected text.">
      <div className="s-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div onClick={() => setOpen(!open)} className="row" style={{ padding: '12px 16px', cursor: 'pointer' }}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="dim" />
          <span style={{ fontSize: 13, fontWeight: 500, marginLeft: 6 }}>See in action</span>
        </div>
        {open && (
          <div style={{ borderTop: '1px solid var(--border)' }}>
            <div className="row" style={{ padding: '10px 16px', gap: 6 }}>
              <button type="button" className="btn btn-sm" style={{ background: mode === 'any_app' ? 'var(--surface-2)' : 'transparent' }} onClick={() => { setMode('any_app'); run('settings.save', { section: 'hummingbird', mode: 'any_app', enabled, alwaysNew, globalShortcut }, { silentError: true }); }}>Any app</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setMode('meeting'); run('settings.save', { section: 'hummingbird', mode: 'meeting', enabled, alwaysNew, globalShortcut }, { silentError: true }); }}>Ongoing meeting</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setMode('selection'); run('settings.save', { section: 'hummingbird', mode: 'selection', enabled, alwaysNew, globalShortcut }, { silentError: true }); }}>Selected text</button>
            </div>
            <div style={{ margin: '0 16px 16px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', padding: '40px 30px', fontFamily: 'var(--font-en)', color: 'var(--text)', position: 'relative', minHeight: 180 }}>
              <div style={{ fontSize: 22, fontWeight: 500, marginBottom: 8 }}>Creativity Is a Process, Not an Event</div>
              <div style={{ fontSize: 10, letterSpacing: '0.15em', color: 'var(--text-dim)', marginBottom: 20 }}>WRITTEN BY JAMES CLEAR · CREATIVITY</div>
              <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-mute)' }}>In 1666, one of the most influential scientists in history was strolling through a garden when he was struck with a flash of creative brilliance that would change the world.</div>
              <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', width: '70%', maxWidth: 380, background: 'var(--surface-2)', border: '1px solid var(--gold-dim)', borderRadius: 'var(--radius-md)', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
                <Kamon size={12} color="var(--gold)" />
                <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Summarize this article about creativity</span>
                <span className="spacer" />
                <button type="button" className="btn btn-sm btn-primary" style={{ width: 22, height: 22, padding: 0 }} onClick={() => run('settings.save', { section: 'hummingbird', mode, enabled, alwaysNew, globalShortcut }, { successMessage: 'Hummingbird mode saved' })}><Icon name="arrowUpRight" size={10} /></button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="s-card" style={{ marginTop: 14 }}>
        <Row title="Enable Hummingbird" desc="Open SHOGUN from anywhere and ask about what's on your screen.">
          <Toggle on={enabled} onClick={() => { const next = !enabled; setEnabled(next); run('settings.save', { section: 'hummingbird', mode, enabled: next, alwaysNew, globalShortcut }, { silentError: true }); }} />
        </Row>
        <Row title="Global Shortcut" desc="Choose the global shortcut used to open Hummingbird">
          <select
            className="s-select"
            value={globalShortcut}
            onChange={(e) => {
              const v = e.target.value;
              setGlobalShortcut(v);
              run('settings.save', { section: 'hummingbird', mode, enabled, alwaysNew, globalShortcut: v }, { silentError: true });
            }}
          >
            <option value="option_double_tap">Tap Option twice</option>
            <option value="cmd_space">⌘ + Space</option>
          </select>
        </Row>
        <Row title="Always Start New Chat" desc="Start with a fresh chat each time you open Hummingbird" last>
          <Toggle on={alwaysNew} onClick={() => { const next = !alwaysNew; setAlwaysNew(next); run('settings.save', { section: 'hummingbird', mode, enabled, alwaysNew: next, globalShortcut }, { silentError: true }); }} />
        </Row>
      </div>
    </Pane>
  );
}
