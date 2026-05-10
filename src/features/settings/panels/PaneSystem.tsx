import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';

export function PaneSystem() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [startup, setStartup] = useState(true);
  const [notif, setNotif] = useState(true);
  const [sound, setSound] = useState(false);
  const [timeFormat, setTimeFormat] = useState('24-hour');
  const [showAppIn, setShowAppIn] = useState('Dock and Menu Bar');
  const persist = (patch: any) => run('settings.save', { section: 'system', startup, notif, sound, timeFormat, showAppIn, ...patch }, { silentError: true });
  React.useEffect(() => {
    const s = sections.system;
    if (!s || typeof s !== 'object') return;
    if (typeof s.startup === 'boolean') setStartup(s.startup);
    if (typeof s.notif === 'boolean') setNotif(s.notif);
    if (typeof s.sound === 'boolean') setSound(s.sound);
    if (s.timeFormat != null) setTimeFormat(String(s.timeFormat));
    if (s.showAppIn != null) setShowAppIn(String(s.showAppIn));
  }, [sections]);
  return (
    <Pane title="System" jp="系統">
      <div className="s-card">
        <Row title="Launch SHOGUN on startup" desc="Automatically start SHOGUN when you log in to your computer">
          <Toggle on={startup} onClick={() => { const next = !startup; setStartup(next); persist({ startup: next }); }} />
        </Row>
        <Row title="Notifications" desc="Show SHOGUN notifications">
          <Toggle on={notif} onClick={() => { const next = !notif; setNotif(next); persist({ notif: next }); }} />
        </Row>
        <Row title="Notification Sound" desc="Play a sound for notifications like meeting reminders and more">
          <Toggle on={sound} onClick={() => { const next = !sound; setSound(next); persist({ sound: next }); }} />
        </Row>
        <Row title="Time Format" desc="How times are displayed throughout the app">
          <select className="s-select" value={timeFormat} onChange={(e) => { const v = e.target.value; setTimeFormat(v); run('settings.save', { section: 'system', startup, notif, sound, timeFormat: v, showAppIn }, { silentError: true }); }}>
            <option value="24-hour">24-hour</option>
            <option value="12-hour">12-hour</option>
          </select>
        </Row>
        <Row title="Show App In" desc="Control the visibility of the app when closed" last>
          <select className="s-select" value={showAppIn} onChange={(e) => { const v = e.target.value; setShowAppIn(v); run('settings.save', { section: 'system', startup, notif, sound, timeFormat, showAppIn: v }, { silentError: true }); }}>
            <option value="Dock and Menu Bar">Dock and Menu Bar</option>
            <option value="Menu Bar only">Menu Bar only</option>
            <option value="Dock only">Dock only</option>
          </select>
        </Row>
      </div>
    </Pane>
  );
}
