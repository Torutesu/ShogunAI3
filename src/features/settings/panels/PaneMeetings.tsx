import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useSettingsSection } from '../lib/hooks';

export interface MeetingsSettingsState extends Record<string, unknown> {
  notifScope: string;
  meetingLang: string;
  remindersOn: boolean;
  reminderMins: string;
  excludeNoGuests: boolean;
  appDetectAlerts: boolean;
  autoStartOnCalendar: boolean;
  autoStartOnVideoDetect: boolean;
  autoStartMicOnVideoDetect: boolean;
  autoIngestToMemory: boolean;
  liveSttStreaming: boolean;
  inactivityMins: string;
}

const MEETINGS_DEFAULTS: MeetingsSettingsState = {
  notifScope: 'confirmed_only',
  meetingLang: 'ja',
  remindersOn: true,
  reminderMins: '5',
  excludeNoGuests: true,
  appDetectAlerts: true,
  autoStartOnCalendar: false,
  autoStartOnVideoDetect: true,
  autoStartMicOnVideoDetect: true,
  autoIngestToMemory: true,
  liveSttStreaming: true,
  inactivityMins: '15',
};

function meetingsFromSections(sections: Record<string, unknown>): MeetingsSettingsState | null {
  const m = sections.meetings;
  if (!m || typeof m !== 'object') return null;
  const row = m as Record<string, unknown>;
  return {
    notifScope: row.notifScope != null ? String(row.notifScope) : MEETINGS_DEFAULTS.notifScope,
    meetingLang: row.meetingLang != null ? String(row.meetingLang) : MEETINGS_DEFAULTS.meetingLang,
    remindersOn: typeof row.remindersOn === 'boolean' ? row.remindersOn : MEETINGS_DEFAULTS.remindersOn,
    reminderMins: row.reminderMins != null ? String(row.reminderMins) : MEETINGS_DEFAULTS.reminderMins,
    excludeNoGuests: typeof row.excludeNoGuests === 'boolean' ? row.excludeNoGuests : MEETINGS_DEFAULTS.excludeNoGuests,
    appDetectAlerts: typeof row.appDetectAlerts === 'boolean' ? row.appDetectAlerts : MEETINGS_DEFAULTS.appDetectAlerts,
    autoStartOnCalendar: typeof row.autoStartOnCalendar === 'boolean'
      ? row.autoStartOnCalendar
      : (typeof row.autoRecord === 'boolean' ? row.autoRecord : MEETINGS_DEFAULTS.autoStartOnCalendar),
    autoStartOnVideoDetect: typeof row.autoStartOnVideoDetect === 'boolean'
      ? row.autoStartOnVideoDetect
      : MEETINGS_DEFAULTS.autoStartOnVideoDetect,
    autoStartMicOnVideoDetect: typeof row.autoStartMicOnVideoDetect === 'boolean'
      ? row.autoStartMicOnVideoDetect
      : MEETINGS_DEFAULTS.autoStartMicOnVideoDetect,
    autoIngestToMemory: typeof row.autoIngestToMemory === 'boolean'
      ? row.autoIngestToMemory
      : MEETINGS_DEFAULTS.autoIngestToMemory,
    liveSttStreaming: typeof row.liveSttStreaming === 'boolean'
      ? row.liveSttStreaming
      : MEETINGS_DEFAULTS.liveSttStreaming,
    inactivityMins: row.inactivityMins != null ? String(row.inactivityMins) : MEETINGS_DEFAULTS.inactivityMins,
  };
}

export function PaneMeetings() {
  const [state, , save] = useSettingsSection(
    {
      section: 'meetings',
      fromSections: meetingsFromSections,
      toPayload: (s) => s,
    },
    MEETINGS_DEFAULTS,
  );

  const {
    notifScope,
    meetingLang,
    remindersOn,
    reminderMins,
    excludeNoGuests,
    appDetectAlerts,
    autoStartOnCalendar,
    autoStartOnVideoDetect,
    autoStartMicOnVideoDetect,
    autoIngestToMemory,
    liveSttStreaming,
    inactivityMins,
  } = state;

  return (
    <Pane title="Meetings" jp="会議">
      <div className="s-card">
        <Row title="Meeting Notifications" desc="Choose when to get notified for upcoming meetings">
          <select
            className="s-select"
            value={notifScope}
            onChange={(e) => void save({ notifScope: e.target.value })}
          >
            <option value="confirmed_only">Confirmed Only</option>
            <option value="all">All meetings</option>
          </select>
        </Row>
        <Row title="Meeting Language" desc="Choose the language that will be used for transcriptions">
          <select
            className="s-select"
            value={meetingLang}
            onChange={(e) => void save({ meetingLang: e.target.value })}
          >
            <option value="ja">Japanese</option>
            <option value="en">English</option>
            <option value="auto">Auto-detect</option>
          </select>
        </Row>
        <Row title="Meeting Reminders" desc="Show notifications before meetings start">
          <Toggle
            on={remindersOn}
            onClick={() => void save({ remindersOn: !remindersOn })}
          />
        </Row>
        <Row title="Reminder Time" desc="Set the time before a meeting to get a reminder">
          <select
            className="s-select"
            value={reminderMins}
            onChange={(e) => void save({ reminderMins: e.target.value })}
          >
            <option value="1">1 Minute</option>
            <option value="5">5 Minutes</option>
            <option value="15">15 Minutes</option>
          </select>
        </Row>
        <Row title="Exclude Events Without Guests" desc="Don't show notifications for events without other guests or meeting links">
          <Toggle
            on={excludeNoGuests}
            onClick={() => void save({ excludeNoGuests: !excludeNoGuests })}
          />
        </Row>
        <Row title="Meeting App Detection Alerts" desc="Show notifications when a meeting app is detected">
          <Toggle
            on={appDetectAlerts}
            onClick={() => void save({ appDetectAlerts: !appDetectAlerts })}
          />
        </Row>
        <Row
          title="Auto-Open Note from Calendar"
          desc="During a synced calendar event, open a local meeting note automatically (no backend recording unless you start it)"
        >
          <Toggle
            on={autoStartOnCalendar}
            onClick={() => void save({ autoStartOnCalendar: !autoStartOnCalendar })}
          />
        </Row>
        <Row title="Auto-Start Meeting on Video Detect" desc="When Meet/Zoom is detected from screen capture, create a live backend meeting and open the note">
          <Toggle
            on={autoStartOnVideoDetect}
            onClick={() => void save({ autoStartOnVideoDetect: !autoStartOnVideoDetect })}
          />
        </Row>
        <Row title="Auto-Start Mic + System Audio" desc="When a video meeting is auto-detected, start microphone and remote audio capture (requires Deepgram key)">
          <Toggle
            on={autoStartMicOnVideoDetect}
            onClick={() => void save({ autoStartMicOnVideoDetect: !autoStartMicOnVideoDetect })}
          />
        </Row>
        <Row title="Auto-Save Meetings to Memory" desc="When a backend meeting ends, upsert transcript and summary into Memory search">
          <Toggle
            on={autoIngestToMemory}
            onClick={() => void save({ autoIngestToMemory: !autoIngestToMemory })}
          />
        </Row>
        <Row title="Live STT Streaming" desc="Use Deepgram WebSocket for lower-latency transcription (falls back to chunked HTTP when off)">
          <Toggle
            on={liveSttStreaming}
            onClick={() => void save({ liveSttStreaming: !liveSttStreaming })}
          />
        </Row>
        <Row title="Auto-Stop Inactivity Timeout" desc="Automatically stop transcription after inactivity" last>
          <select
            className="s-select"
            value={inactivityMins}
            onChange={(e) => void save({ inactivityMins: e.target.value })}
          >
            <option value="5">5 Minutes</option>
            <option value="15">15 Minutes</option>
            <option value="30">30 Minutes</option>
          </select>
        </Row>
      </div>
    </Pane>
  );
}
