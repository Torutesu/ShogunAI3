import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useSettingsSection } from '../lib/hooks';

export interface SystemSettingsState extends Record<string, unknown> {
  startup: boolean;
  notif: boolean;
  sound: boolean;
  timeFormat: string;
  showAppIn: string;
}

const SYSTEM_DEFAULTS: SystemSettingsState = {
  startup: true,
  notif: true,
  sound: false,
  timeFormat: '24-hour',
  showAppIn: 'Dock and Menu Bar',
};

function systemFromSections(sections: Record<string, unknown>): SystemSettingsState | null {
  const s = sections.system;
  if (!s || typeof s !== 'object') return null;
  const row = s as Record<string, unknown>;
  return {
    startup: typeof row.startup === 'boolean' ? row.startup : SYSTEM_DEFAULTS.startup,
    notif: typeof row.notif === 'boolean' ? row.notif : SYSTEM_DEFAULTS.notif,
    sound: typeof row.sound === 'boolean' ? row.sound : SYSTEM_DEFAULTS.sound,
    timeFormat: row.timeFormat != null ? String(row.timeFormat) : SYSTEM_DEFAULTS.timeFormat,
    showAppIn: row.showAppIn != null ? String(row.showAppIn) : SYSTEM_DEFAULTS.showAppIn,
  };
}

export function PaneSystem() {
  const [state, , save] = useSettingsSection(
    {
      section: 'system',
      fromSections: systemFromSections,
      toPayload: (s) => s,
    },
    SYSTEM_DEFAULTS,
  );

  const { startup, notif, sound, timeFormat, showAppIn } = state;

  return (
    <Pane title="System" jp="系統">
      <div className="s-card">
        <Row title="Launch SHOGUN on startup" desc="Automatically start SHOGUN when you log in to your computer">
          <Toggle on={startup} onClick={() => { void save({ startup: !startup }); }} />
        </Row>
        <Row title="Notifications" desc="Show SHOGUN notifications">
          <Toggle on={notif} onClick={() => { void save({ notif: !notif }); }} />
        </Row>
        <Row title="Notification Sound" desc="Play a sound for notifications like meeting reminders and more">
          <Toggle on={sound} onClick={() => { void save({ sound: !sound }); }} />
        </Row>
        <Row title="Time Format" desc="How times are displayed throughout the app">
          <select className="s-select" value={timeFormat} onChange={(e) => { void save({ timeFormat: e.target.value }); }}>
            <option value="24-hour">24-hour</option>
            <option value="12-hour">12-hour</option>
          </select>
        </Row>
        <Row title="Show App In" desc="Control the visibility of the app when closed" last>
          <select className="s-select" value={showAppIn} onChange={(e) => { void save({ showAppIn: e.target.value }); }}>
            <option value="Dock and Menu Bar">Dock and Menu Bar</option>
            <option value="Menu Bar only">Menu Bar only</option>
            <option value="Dock only">Dock only</option>
          </select>
        </Row>
      </div>
    </Pane>
  );
}
