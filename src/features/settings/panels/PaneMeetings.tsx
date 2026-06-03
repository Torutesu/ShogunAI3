import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { Toggle } from '../components/Toggle';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';

export function PaneMeetings() {
  const { run } = useRuntimeActions();
  const { sections } = React.useContext(SettingsHydrationContext);
  const [notifScope, setNotifScope] = useState('confirmed_only');
  const [meetingLang, setMeetingLang] = useState('ja');
  const [remindersOn, setRemindersOn] = useState(true);
  const [reminderMins, setReminderMins] = useState('5');
  const [excludeNoGuests, setExcludeNoGuests] = useState(true);
  const [appDetectAlerts, setAppDetectAlerts] = useState(true);
  const [autoStartOnCalendar, setAutoStartOnCalendar] = useState(false);
  const [autoStartOnVideoDetect, setAutoStartOnVideoDetect] = useState(true);
  const [autoStartMicOnVideoDetect, setAutoStartMicOnVideoDetect] = useState(true);
  const [autoIngestToMemory, setAutoIngestToMemory] = useState(true);
  const [liveSttStreaming, setLiveSttStreaming] = useState(true);
  const [inactivityMins, setInactivityMins] = useState('15');
  const persist = React.useCallback(
    (patch: any) =>
      run(
        'settings.save',
        {
          section: 'meetings',
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
          ...patch,
        },
        { silentError: true },
      ),
    [run, notifScope, meetingLang, remindersOn, reminderMins, excludeNoGuests, appDetectAlerts, autoStartOnCalendar, autoStartOnVideoDetect, autoStartMicOnVideoDetect, autoIngestToMemory, liveSttStreaming, inactivityMins],
  );
  React.useEffect(() => {
    const m = sections.meetings;
    if (!m || typeof m !== 'object') return;
    if (m.notifScope != null) setNotifScope(String(m.notifScope));
    if (m.meetingLang != null) setMeetingLang(String(m.meetingLang));
    if (typeof m.remindersOn === 'boolean') setRemindersOn(m.remindersOn);
    if (m.reminderMins != null) setReminderMins(String(m.reminderMins));
    if (typeof m.excludeNoGuests === 'boolean') setExcludeNoGuests(m.excludeNoGuests);
    if (typeof m.appDetectAlerts === 'boolean') setAppDetectAlerts(m.appDetectAlerts);
    if (typeof m.autoStartOnCalendar === 'boolean') setAutoStartOnCalendar(m.autoStartOnCalendar);
    else if (typeof m.autoRecord === 'boolean') setAutoStartOnCalendar(m.autoRecord);
    if (typeof m.autoStartOnVideoDetect === 'boolean') setAutoStartOnVideoDetect(m.autoStartOnVideoDetect);
    if (typeof m.autoStartMicOnVideoDetect === 'boolean') setAutoStartMicOnVideoDetect(m.autoStartMicOnVideoDetect);
    if (typeof m.autoIngestToMemory === 'boolean') setAutoIngestToMemory(m.autoIngestToMemory);
    if (typeof m.liveSttStreaming === 'boolean') setLiveSttStreaming(m.liveSttStreaming);
    if (m.inactivityMins != null) setInactivityMins(String(m.inactivityMins));
  }, [sections]);
  return (
    <Pane title="Meetings" jp="会議">
      <div className="s-card">
        <Row title="Meeting Notifications" desc="Choose when to get notified for upcoming meetings">
          <select
            className="s-select"
            value={notifScope}
            onChange={(e) => {
              const v = e.target.value;
              setNotifScope(v);
              void persist({ notifScope: v });
            }}
          >
            <option value="confirmed_only">Confirmed Only</option>
            <option value="all">All meetings</option>
          </select>
        </Row>
        <Row title="Meeting Language" desc="Choose the language that will be used for transcriptions">
          <select
            className="s-select"
            value={meetingLang}
            onChange={(e) => {
              const v = e.target.value;
              setMeetingLang(v);
              void persist({ meetingLang: v });
            }}
          >
            <option value="ja">Japanese</option>
            <option value="en">English</option>
            <option value="auto">Auto-detect</option>
          </select>
        </Row>
        <Row title="Meeting Reminders" desc="Show notifications before meetings start">
          <Toggle
            on={remindersOn}
            onClick={() => {
              const next = !remindersOn;
              setRemindersOn(next);
              void persist({ remindersOn: next });
            }}
          />
        </Row>
        <Row title="Reminder Time" desc="Set the time before a meeting to get a reminder">
          <select
            className="s-select"
            value={reminderMins}
            onChange={(e) => {
              const v = e.target.value;
              setReminderMins(v);
              void persist({ reminderMins: v });
            }}
          >
            <option value="1">1 Minute</option>
            <option value="5">5 Minutes</option>
            <option value="15">15 Minutes</option>
          </select>
        </Row>
        <Row title="Exclude Events Without Guests" desc="Don't show notifications for events without other guests or meeting links">
          <Toggle
            on={excludeNoGuests}
            onClick={() => {
              const next = !excludeNoGuests;
              setExcludeNoGuests(next);
              void persist({ excludeNoGuests: next });
            }}
          />
        </Row>
        <Row title="Meeting App Detection Alerts" desc="Show notifications when a meeting app is detected">
          <Toggle
            on={appDetectAlerts}
            onClick={() => {
              const next = !appDetectAlerts;
              setAppDetectAlerts(next);
              void persist({ appDetectAlerts: next });
            }}
          />
        </Row>
        <Row
          title="Auto-Open Note from Calendar"
          desc="During a synced calendar event, open a local meeting note automatically (no backend recording unless you start it)"
        >
          <Toggle
            on={autoStartOnCalendar}
            onClick={() => {
              const next = !autoStartOnCalendar;
              setAutoStartOnCalendar(next);
              void persist({ autoStartOnCalendar: next });
            }}
          />
        </Row>
        <Row title="Auto-Start Meeting on Video Detect" desc="When Meet/Zoom is detected from screen capture, create a live backend meeting and open the note">
          <Toggle
            on={autoStartOnVideoDetect}
            onClick={() => {
              const next = !autoStartOnVideoDetect;
              setAutoStartOnVideoDetect(next);
              void persist({ autoStartOnVideoDetect: next });
            }}
          />
        </Row>
        <Row title="Auto-Start Mic + System Audio" desc="When a video meeting is auto-detected, start microphone and remote audio capture (requires Deepgram key)">
          <Toggle
            on={autoStartMicOnVideoDetect}
            onClick={() => {
              const next = !autoStartMicOnVideoDetect;
              setAutoStartMicOnVideoDetect(next);
              void persist({ autoStartMicOnVideoDetect: next });
            }}
          />
        </Row>
        <Row title="Auto-Save Meetings to Memory" desc="When a backend meeting ends, upsert transcript and summary into Memory search">
          <Toggle
            on={autoIngestToMemory}
            onClick={() => {
              const next = !autoIngestToMemory;
              setAutoIngestToMemory(next);
              void persist({ autoIngestToMemory: next });
            }}
          />
        </Row>
        <Row title="Live STT Streaming" desc="Use Deepgram WebSocket for lower-latency transcription (falls back to chunked HTTP when off)">
          <Toggle
            on={liveSttStreaming}
            onClick={() => {
              const next = !liveSttStreaming;
              setLiveSttStreaming(next);
              void persist({ liveSttStreaming: next });
            }}
          />
        </Row>
        <Row title="Auto-Stop Inactivity Timeout" desc="Automatically stop transcription after inactivity" last>
          <select
            className="s-select"
            value={inactivityMins}
            onChange={(e) => {
              const v = e.target.value;
              setInactivityMins(v);
              void persist({ inactivityMins: v });
            }}
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
