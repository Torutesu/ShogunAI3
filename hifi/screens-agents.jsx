// hifi/screens-agents.jsx
// Agents (execution layer) — extracted from screens-b.jsx for file-size hygiene.
// All globals (React, Icon, window.SHOGUN_RUNTIME) are loaded by earlier <script> tags.

// L4 · AGENTS — execution layer
// ═══════════════════════════════════════════════════════════════════════════
// Demo timestamps: anchored to a fixed reference instant so the relative
// labels ("2h ago", "next 14:00") render consistently across reloads.

// "2h ago" / "12m ago" / "Sun 10:00" — relative to AGENTS_DEMO_NOW.
function fmtRelativeTime(ms, nowMs) {
  if (!ms || !nowMs) return '—';
  const diff = nowMs - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  if (diff < 7 * 24 * 60 * 60_000) return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// "14:00" / "Sun 10:00" — formatted next-fire time, today vs future-day-aware.
function fmtNextTime(ms, nowMs) {
  if (!ms || !nowMs) return null;
  const d = new Date(ms);
  const sameDay = new Date(nowMs).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
  return `${wd} ${hh}:${mm}`;
}

// "running · 2h ago · next 14:00" — derives the small mono sub-line.
function buildAgentSubLine(agent, statusLabel, nowMs) {
  const parts = [statusLabel];
  if (agent.lastRunMs && statusLabel !== 'paused') {
    parts.push(`${fmtRelativeTime(agent.lastRunMs, nowMs)}`);
  } else if (agent.lastRunMs && statusLabel === 'paused') {
    parts.push(`last ${fmtRelativeTime(agent.lastRunMs, nowMs)}`);
  }
  const next = fmtNextTime(agent.nextRunMs, nowMs);
  if (next && (statusLabel === 'running' || statusLabel === 'scheduled')) {
    parts.push(`next ${next}`);
  }
  return parts.join(' · ');
}

// Pure: decode a free-form `agent.trigger` string into a structured form
// the EditAgentModal can edit. Falls back to interval/1/hour when no
// pattern matches and warns to the console (the demo data should never
// hit the fallback in practice).
function parseTrigger(triggerStr) {
  const s = String(triggerStr || '').trim();
  let m;
  m = s.match(/^every (\d+) (minute|hour|day)s?$/);
  if (m) return { type: 'interval', value: Number(m[1]), unit: m[2] };
  m = s.match(/^on (\w+) event$/);
  if (m) return { type: 'event', source: m[1] };
  m = s.match(/^(\d{2}):(\d{2}) daily$/);
  if (m) return { type: 'daily', time: `${m[1]}:${m[2]}` };
  if (s === 'weekly') return { type: 'weekly' };
  console.warn('parseTrigger: unrecognized trigger string:', triggerStr);
  return { type: 'interval', value: 1, unit: 'hour' };
}

// Pure: round-trip a structured form back to the same string format
// AGENTS_DEMO uses today.
function serializeTrigger(form) {
  if (!form || !form.type) return '';
  if (form.type === 'interval') {
    const n = Number(form.value) || 1;
    const u = form.unit || 'hour';
    return `every ${n} ${u}${n === 1 ? '' : 's'}`;
  }
  if (form.type === 'event') {
    return `on ${form.source || 'calendar'} event`;
  }
  if (form.type === 'daily') {
    return `${form.time || '12:00'} daily`;
  }
  if (form.type === 'weekly') {
    return 'weekly';
  }
  return '';
}

const AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');
const HOUR = 60 * 60 * 1000;
const AGENTS_DEMO = [
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    icon: 'mail',
    status: 'running',
    trigger: 'every 2 hours',
    triggerSince: '2026-04-12',
    description: 'Sorts Gmail by memory-derived priority. Drafts replies for you to approve.',
    tools: [{ name: 'mail', icon: 'mail' }, { name: 'memory', icon: 'memory' }],
    lastRunMs: AGENTS_DEMO_NOW - 2 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 0.5 * HOUR,
    recentRuns: [
      {
        id: 'inbox-triage-r-1', atMs: AGENTS_DEMO_NOW - 2 * HOUR,
        t: '14:31', msg: 'Read 3 emails · drafted 1 reply', level: 'success',
        durationMs: 1200, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 12:31',
        output: 'Found 3 unread, 1 priority (Yuito).\nDrafted reply to Yuito\'s "Re: All-Strategy".\nSkipped 2 newsletters.',
        memoryTouched: [
          { id: 'm_1779381', title: 'Yuito · Re: All-Strategy' },
          { id: 'm_1779380', title: 'MarkeZine News', note: 'skipped' },
        ],
      },
      {
        id: 'inbox-triage-r-2', atMs: AGENTS_DEMO_NOW - 4 * HOUR,
        t: '12:31', msg: 'Polled inbox · no new priority', level: 'info',
        durationMs: 800, tools: ['gmail'],
        input: 'Sweep Gmail inbox since 10:31',
        output: 'Inbox empty since last sweep.',
        memoryTouched: [],
      },
      {
        id: 'inbox-triage-r-3', atMs: AGENTS_DEMO_NOW - 6 * HOUR,
        t: '10:31', msg: 'Read 5 emails · drafted 2 replies', level: 'success',
        durationMs: 1500, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 08:31',
        output: 'Found 5 unread, 2 priorities.\nDrafted reply to Akiko ("RE: PR review").\nDrafted reply to Mei ("Schedule check").',
        memoryTouched: [
          { id: 'm_1779370', title: 'Akiko · RE: PR review' },
          { id: 'm_1779369', title: 'Mei · Schedule check' },
        ],
      },
      {
        id: 'inbox-triage-r-4', atMs: AGENTS_DEMO_NOW - 8 * HOUR,
        t: '08:31', msg: 'Auth refresh · token rotated', level: 'info',
        durationMs: 400, tools: ['gmail'],
        input: 'Token expiring in 5min — refresh',
        output: 'OAuth refresh succeeded.\nNew token expires 2026-04-27T20:31Z.',
        memoryTouched: [],
      },
      {
        id: 'inbox-triage-r-5', atMs: AGENTS_DEMO_NOW - 10 * HOUR,
        t: '06:31', msg: 'Read 1 email · no draft needed', level: 'success',
        durationMs: 700, tools: ['gmail', 'memory'],
        input: 'Sweep Gmail inbox since 04:31',
        output: 'Found 1 unread (newsletter).\nMatched memory: similar low-priority pattern.\nNo draft generated.',
        memoryTouched: [
          { id: 'm_1779360', title: 'Daily newsletter', note: 'low-priority' },
        ],
      },
    ],
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    icon: 'calendar',
    status: 'idle',
    trigger: 'on calendar event',
    triggerSince: '2026-03-22',
    description: 'Captures calendar events, extracts decisions into memory, links to entities.',
    tools: [{ name: 'calendar', icon: 'calendar' }, { name: 'memory', icon: 'memory' }],
    lastRunMs: AGENTS_DEMO_NOW - 12 * HOUR,
    nextRunMs: null,
    recentRuns: [
      {
        id: 'meeting-notes-r-1', atMs: AGENTS_DEMO_NOW - 12 * HOUR,
        t: '02:30', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success',
        durationMs: 4200, tools: ['calendar', 'memory'],
        input: 'Calendar event end-trigger: "All PJ" 02:00-02:30',
        output: '6 decisions extracted.\nLinked to entities: Yuito, Mei, Akiko.\nFollow-ups due: 2 (assigned to Yuito by Friday).',
        memoryTouched: [
          { id: 'm_1779350', title: 'All PJ · 6 decisions' },
          { id: 'm_1779351', title: 'Follow-up · Yuito · Friday' },
        ],
      },
      {
        id: 'meeting-notes-r-2', atMs: AGENTS_DEMO_NOW - 13.5 * HOUR,
        t: '01:00', msg: 'Calendar event captured · linked to "Yuito" entity', level: 'info',
        durationMs: 1800, tools: ['calendar', 'memory'],
        input: 'Calendar event start: "1:1 Yuito" 01:00-01:30',
        output: 'Pre-meeting brief generated.\nLinked to "Yuito" entity (3 prior touches).',
        memoryTouched: [
          { id: 'm_1779340', title: '1:1 Yuito · pre-brief' },
        ],
      },
    ],
  },
  {
    id: 'daily-digest',
    name: 'Daily digest',
    icon: 'note',
    status: 'scheduled',
    trigger: '21:00 daily',
    triggerSince: '2026-04-01',
    description: 'Synthesizes the day at 21:00. Writes a morning brief for tomorrow at 07:00.',
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }],
    lastRunMs: AGENTS_DEMO_NOW - 17 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 6.5 * HOUR,
    recentRuns: [
      {
        id: 'daily-digest-r-1', atMs: AGENTS_DEMO_NOW - 17 * HOUR,
        t: '21:00', msg: 'Wrote daily digest · 14 highlights', level: 'success',
        durationMs: 8500, tools: ['memory', 'note'],
        input: 'Synthesize 2026-04-26 (memory window: 00:00-21:00)',
        output: '14 highlights extracted.\nThemes: Inbox triage tuning, KIOKU phase 2 review.\nWritten to note: "Daily 2026-04-26".',
        memoryTouched: [
          { id: 'm_1779300', title: 'Daily 2026-04-26' },
        ],
      },
      {
        id: 'daily-digest-r-2', atMs: AGENTS_DEMO_NOW - 31 * HOUR,
        t: '07:00', msg: 'Morning brief · 4 priorities surfaced', level: 'success',
        durationMs: 6100, tools: ['memory', 'note'],
        input: 'Generate morning brief for 2026-04-26',
        output: '4 priorities for today.\nP1: Yuito sync · 14:00\nP2: Memory rollup polish\nP3: Agents UI review\nP4: Inbox catch-up',
        memoryTouched: [
          { id: 'm_1779290', title: 'Morning brief 2026-04-26' },
        ],
      },
    ],
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    icon: 'clock',
    status: 'scheduled',
    trigger: 'weekly',
    triggerSince: '2026-03-08',
    description: 'Sunday morning. What moved this week? What needs decisions. Drafts a retro.',
    tools: [{ name: 'memory', icon: 'memory' }, { name: 'note', icon: 'note' }, { name: 'calendar', icon: 'calendar' }],
    lastRunMs: AGENTS_DEMO_NOW - 4 * 24 * HOUR,
    nextRunMs: AGENTS_DEMO_NOW + 3 * 24 * HOUR,
    recentRuns: [
      {
        id: 'weekly-review-r-1', atMs: AGENTS_DEMO_NOW - 4 * 24 * HOUR,
        t: 'Sun 10:00', msg: 'Drafted retro · 3 decisions, 2 risks flagged', level: 'success',
        durationMs: 12300, tools: ['memory', 'note', 'calendar'],
        input: 'Synthesize week of 2026-04-13 to 2026-04-19',
        output: '3 decisions:\n- Adopt KIOKU phase 2 schema\n- Defer multi-provider LLM to v0.5\n- Promote Memory digest to default-on\n\n2 risks flagged:\n- LLM cost trending +20% W/W\n- Inbox triage success rate dropped 8%\n\nDrafted retro: "Week 2026-04-13"',
        memoryTouched: [
          { id: 'm_1779100', title: 'Week 2026-04-13 retro' },
        ],
      },
    ],
  },
];

const AGENTS_LIVE = [
  { t: '14:31:08', agent: 'inbox-triage', msg: 'Read 3 emails · drafted 1 reply', level: 'success' },
  { t: '14:18:42', agent: 'meeting-notes', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success' },
  { t: '14:02:15', agent: 'memory', msg: 'Indexed conversation · 48 messages · 3 entities linked', level: 'info' },
  { t: '13:46:02', agent: 'inbox-triage', msg: 'Polled inbox · no new priority mail', level: 'info' },
  { t: '13:20:37', agent: 'daily-digest', msg: 'Scheduled: next run at 21:00', level: 'info' },
];

const AGENT_STATUS_META = {
  running: { color: 'var(--success)', label: 'running' },
  scheduled: { color: 'var(--gold)', label: 'scheduled' },
  idle: { color: 'var(--text-mute)', label: 'idle' },
  paused: { color: 'var(--text-dim)', label: 'paused' },
  error: { color: 'var(--danger)', label: 'error' },
};

// Per-agent runtime mapping: which IPC action backs each agent's
// Run now button, and which settings path drives its Pause/Resume.
// Daily-digest and weekly-review intentionally share
// `enableMemoryDigestAutoSync` — pausing one pauses both, matching
// the current rollup_sync.rs behavior.
const AGENT_RUNTIME = {
  'inbox-triage': {
    runNowAction: 'gmail.sync',
    runNowPayload: () => ({ maxResults: 20 }),
    runNowSuccessMsg: (data) => `Synced ${data?.imported ?? 0} emails`,
    pausedSettingPath: ['integrations', 'gmailAutoSync'],
  },
  'meeting-notes': {
    runNowAction: 'calendar.sync',
    runNowPayload: () => ({ maxResults: 25 }),
    runNowSuccessMsg: (data) => `Synced ${data?.imported ?? 0} events`,
    pausedSettingPath: ['integrations', 'googleCalendarAutoSync'],
  },
  'daily-digest': {
    runNowAction: 'memory.rollup.day.get',
    runNowPayload: () => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      return { dayStartMs: day.getTime(), regenerate: true };
    },
    runNowSuccessMsg: () => 'Daily digest regenerated',
    pausedSettingPath: ['memory', 'enableMemoryDigestAutoSync'],
  },
  'weekly-review': {
    runNowAction: 'memory.rollup.get',
    runNowPayload: () => {
      const cursor = new Date();
      const day = cursor.getDay();
      const mondayOffset = (day === 0 ? -6 : 1 - day);
      const monday = new Date(cursor);
      monday.setDate(cursor.getDate() + mondayOffset);
      monday.setHours(0, 0, 0, 0);
      return { weekStartMs: monday.getTime(), regenerate: true };
    },
    runNowSuccessMsg: () => 'Weekly review regenerated',
    pausedSettingPath: ['memory', 'enableMemoryDigestAutoSync'],
  },
};


const ATTENTION_REASONS = {
  error: (a) => `${a.name} failed last run ${'lastRunRel' in a ? a.lastRunRel : 'recently'}.`,
  stale: (a) => `${a.name} hasn't run in over 24 hours.`,
  auth_expired: (a) => `${a.name} needs re-authorization.`,
};

function AttentionStrip({ agents, nowMs, onView, onRunNow }) {
  // Derive issues: explicit `attention` flag, OR last run was error,
  // OR scheduled/cron and lastRunMs is older than 24h.
  const issues = [];
  for (const a of agents) {
    if (a.paused) continue;
    const last = a.recentRuns && a.recentRuns[0];
    const tooStale =
      (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
      a.lastRunMs && (nowMs - a.lastRunMs) > 24 * 60 * 60 * 1000;
    let reason = null;
    if (a.attention === 'error' || (last && last.level === 'error')) reason = 'error';
    else if (a.attention === 'auth_expired') reason = 'auth_expired';
    else if (a.attention === 'stale' || tooStale) reason = 'stale';
    if (reason) {
      issues.push({
        agent: a,
        reason,
        lastRunRel: a.lastRunMs ? fmtRelativeTime(a.lastRunMs, nowMs) : 'recently',
      });
    }
  }
  if (issues.length === 0) return null;
  const visible = issues.slice(0, 3);
  const overflow = issues.length - visible.length;

  return (
    <div style={{marginBottom:'var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {visible.map(({ agent, reason, lastRunRel }) => (
        <div
          key={agent.id}
          style={{
            display:'flex', alignItems:'center', gap:'var(--space-3)',
            padding:'var(--space-3) var(--space-4)',
            background:'var(--surface-2)',
            borderLeft:'3px solid var(--danger)',
            borderRadius:'var(--radius-md)',
          }}
        >
          <Icon name="alert" size={14} style={{color:'var(--danger)', flexShrink:0}}/>
          <span className="t-sm" style={{flex:1, color:'var(--text)'}}>
            {ATTENTION_REASONS[reason]({ ...agent, lastRunRel })}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => onRunNow(agent.id)}
          >
            Run now
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => onView(agent.id)}
          >
            View
          </button>
        </div>
      ))}
      {overflow > 0 && (
        <button
          type="button"
          className="t-sm"
          onClick={() => window.SHOGUN_RUNTIME?.pushToast?.(`Attention list page coming soon`, 'info')}
          style={{
            all:'unset', cursor:'pointer', color:'var(--text-dim)', alignSelf:'flex-start',
            padding:'var(--space-1) var(--space-2)',
          }}
        >
          +{overflow} more
        </button>
      )}
    </div>
  );
}

const FILTER_OPTIONS = [
  { id: 'all', label: 'all' },
  { id: 'running', label: 'running' },
  { id: 'scheduled', label: 'scheduled' },
  { id: 'paused', label: 'paused' },
  { id: 'error', label: 'error' },
];

function AgentsEmptyState({ filterStatus, totalCount, onCreate }) {
  // Two flavors: zero agents at all (welcome), vs zero matching the filter.
  if (totalCount === 0) {
    return (
      <div style={{
        padding:'var(--space-12) var(--space-6)',
        border:`1px dashed var(--border)`,
        borderRadius:'var(--radius-lg)',
        textAlign:'center',
        color:'var(--text-mute)',
      }}>
        <div style={{
          width:48, height:48, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:`1px solid var(--border)`,
          display:'inline-flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', marginBottom:'var(--space-4)',
        }}>
          <Icon name="plus" size={20}/>
        </div>
        <div style={{fontSize:16, fontWeight:600, color:'var(--text)', marginBottom:'var(--space-2)'}}>
          No agents yet
        </div>
        <div className="t-sm" style={{marginBottom:'var(--space-4)'}}>
          Agents read your memory and act on your behalf.
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreate}>
          <Icon name="plus" size={14}/> Create your first agent
        </button>
      </div>
    );
  }
  return (
    <div style={{
      padding:'var(--space-8) var(--space-6)',
      border:`1px dashed var(--border)`,
      borderRadius:'var(--radius-lg)',
      textAlign:'center',
      color:'var(--text-mute)',
    }} className="t-sm">
      No agents in "{filterStatus}".
    </div>
  );
}

function EditAgentModal({ agent, onSave, onClose }) {
  const [name, setName] = React.useState(agent.name);
  const [description, setDescription] = React.useState(agent.description);
  const [triggerForm, setTriggerForm] = React.useState(() => parseTrigger(agent.trigger));

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameValid = name.trim().length >= 1;
  const descValid = description.trim().length >= 1;
  const triggerValid = (() => {
    if (!triggerForm) return false;
    if (triggerForm.type === 'interval') return Number.isInteger(Number(triggerForm.value)) && Number(triggerForm.value) >= 1;
    if (triggerForm.type === 'event') return Boolean(triggerForm.source);
    if (triggerForm.type === 'daily') {
      if (!/^\d{2}:\d{2}$/.test(triggerForm.time || '')) return false;
      const [h, m] = triggerForm.time.split(':').map(Number);
      return h < 24 && m < 60;
    }
    if (triggerForm.type === 'weekly') return true;
    return false;
  })();
  const saveEnabled = nameValid && descValid && triggerValid;
  const fieldErrorStyle = { color: 'var(--danger)', fontSize: 11, marginTop: 'var(--space-1)' };

  const setType = (type) => {
    if (type === 'interval') setTriggerForm({ type, value: 1, unit: 'hour' });
    else if (type === 'event') setTriggerForm({ type, source: 'calendar' });
    else if (type === 'daily') setTriggerForm({ type, time: '12:00' });
    else if (type === 'weekly') setTriggerForm({ type });
  };

  const onSubmit = () => {
    if (!saveEnabled) return;
    onSave({
      name: name.trim(),
      description: description.trim(),
      trigger: serializeTrigger(triggerForm),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit agent"
      onClick={onClose}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(0,0,0,0.5)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:'var(--surface)',
          border:`1px solid var(--border-hi)`,
          borderRadius:'var(--radius-lg)',
          padding:'var(--space-8)',
          maxWidth:480, width:'90%',
          boxShadow:'var(--shadow-lg)',
          display:'flex', flexDirection:'column', gap:'var(--space-5)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div className="t-mono" style={{color:'var(--gold)'}}>EDIT AGENT</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              all:'unset', cursor:'pointer',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)',
            }}
          >
            <Icon name="x" size={14}/>
          </button>
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>NAME</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!nameValid}
            maxLength={60}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:14,
            }}
          />
          {!nameValid && (
            <div style={fieldErrorStyle}>Name is required.</div>
          )}
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>DESCRIPTION</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={!descValid}
            rows={3}
            maxLength={240}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:13,
              resize:'vertical',
            }}
          />
          {!descValid && (
            <div style={fieldErrorStyle}>Description is required.</div>
          )}
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>TRIGGER</div>
          <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)', marginBottom:'var(--space-3)'}}>
            <span className="t-sm" style={{color:'var(--text-mute)'}}>Type:</span>
            <select
              value={triggerForm.type}
              onChange={(e) => setType(e.target.value)}
              style={{
                padding:'var(--space-1) var(--space-3)',
                background:'var(--surface-2)', border:`1px solid var(--border)`,
                borderRadius:'var(--radius-sm)',
                color:'var(--text)', fontFamily:'inherit', fontSize:13,
              }}
            >
              <option value="interval">Interval</option>
              <option value="event">Event</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          {triggerForm.type === 'interval' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>Every</span>
              <input
                type="number"
                min={1}
                value={triggerForm.value}
                onChange={(e) => setTriggerForm({ ...triggerForm, value: Number(e.target.value) })}
                style={{
                  width:64, padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <select
                value={triggerForm.unit}
                onChange={(e) => setTriggerForm({ ...triggerForm, unit: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="minute">minutes</option>
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
            </div>
          )}

          {triggerForm.type === 'event' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>On</span>
              <select
                value={triggerForm.source}
                onChange={(e) => setTriggerForm({ ...triggerForm, source: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="calendar">calendar</option>
              </select>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>event</span>
            </div>
          )}

          {triggerForm.type === 'daily' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <input
                type="time"
                value={triggerForm.time}
                onChange={(e) => setTriggerForm({ ...triggerForm, time: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <span className="t-sm" style={{color:'var(--text-mute)'}}>daily</span>
            </div>
          )}

          {triggerForm.type === 'weekly' && (
            <div className="t-sm" style={{color:'var(--text-mute)'}}>
              Runs once a week. Specific day/time set by system.
            </div>
          )}
          {!triggerValid && (
            <div style={fieldErrorStyle}>Trigger format is invalid.</div>
          )}
        </div>

        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end', marginTop:'var(--space-2)'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saveEnabled}
            onClick={onSubmit}
            style={{opacity: saveEnabled ? 1 : 0.5, cursor: saveEnabled ? 'pointer' : 'not-allowed'}}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

function NewAgentModal({ open, onClose, onOpenPlayground }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New agent"
      onClick={onClose}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(0,0,0,0.5)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:'var(--surface)',
          border:`1px solid var(--border-hi)`,
          borderRadius:'var(--radius-lg)',
          padding:'var(--space-8)',
          maxWidth:480, width:'90%',
          boxShadow:'var(--shadow-lg)',
        }}
      >
        <div className="t-mono" style={{color:'var(--gold)', marginBottom:'var(--space-3)'}}>+ NEW AGENT</div>
        <div style={{fontSize:18, fontWeight:600, marginBottom:'var(--space-3)', letterSpacing:'-0.01em'}}>
          Custom agents — coming in v0.5
        </div>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-2)'}}>
          The four agents above are the curated default set. Custom agent
          creation (your own triggers, prompts, and tool selections) is
          coming in v0.5.
        </p>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-6)'}}>
          Want to experiment with agent-style prompts in the meantime?
        </p>
        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={onOpenPlayground}>Open Playground</button>
        </div>
      </div>
    </div>
  );
}

function FilterBar({ active, onChange, counts }) {
  return (
    <div style={{
      display:'flex', alignItems:'center', gap:'var(--space-2)',
      marginBottom:'var(--space-4)', flexWrap:'wrap',
    }}>
      {FILTER_OPTIONS.map((opt) => {
        const isActive = active === opt.id;
        const count = counts[opt.id] ?? 0;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            style={{
              all:'unset', cursor:'pointer',
              padding:'var(--space-1) var(--space-3)',
              border:`1px solid ${isActive ? 'var(--border-hi)' : 'var(--border)'}`,
              borderRadius: 999,
              color: isActive ? 'var(--text)' : 'var(--text-mute)',
              fontSize: 12,
              transition: `all var(--dur-fast) var(--ease-out)`,
            }}
          >
            {opt.label} ({count})
          </button>
        );
      })}
      <span style={{flex:1}}/>
      <input
        type="text"
        placeholder="search ⌘F"
        disabled
        style={{
          background:'transparent', border:`1px solid var(--border)`,
          borderRadius:'var(--radius-sm)', padding:'var(--space-1) var(--space-3)',
          color:'var(--text-dim)', fontSize:12, fontFamily:'inherit',
          width:160, opacity:0.6, cursor:'not-allowed',
        }}
      />
    </div>
  );
}

function RecentRunsList({ runs, onSeeAll }) {
  if (!runs || runs.length === 0) {
    return (
      <div className="t-sm" style={{color:'var(--text-mute)', padding:'var(--space-2) 0'}}>
        No runs yet.
      </div>
    );
  }
  return (
    <div style={{display:'flex', flexDirection:'column', gap:'var(--space-2)'}}>
      {runs.slice(0, 5).map((r, i) => {
        const levelColor = r.level === 'success' ? 'var(--success)'
                         : r.level === 'error'   ? 'var(--danger)'
                         : 'var(--text-mute)';
        return (
          <div key={i} style={{display:'grid', gridTemplateColumns:'48px 1fr auto', gap:'var(--space-3)', alignItems:'center'}} className="t-sm">
            <span className="t-mono" style={{color:'var(--text-mute)'}}>{r.t}</span>
            <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{r.msg}</span>
            <span
              className="label"
              style={{
                borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
                color: levelColor,
              }}
            >
              {r.level.toUpperCase()}
            </span>
          </div>
        );
      })}
      <button
        type="button"
        onClick={onSeeAll}
        style={{
          all: 'unset',
          alignSelf: 'flex-end',
          marginTop: 'var(--space-1)',
          color: 'var(--text-dim)',
          fontSize: 11,
          textDecoration: 'underline',
          cursor: 'pointer',
        }}
      >
        See all →
      </button>
    </div>
  );
}

// Pure: deterministically pads agent.recentRuns out to 50 entries by
// stepping backwards from the oldest curated run, using a per-trigger
// stride. Synthetic content is intentionally repetitive so it reads as
// background noise next to the curated entries on top.
function generateAgentRunHistory(agent) {
  const out = [...(agent.recentRuns || [])];
  if (out.length === 0) return out;
  const last = out[out.length - 1];
  // Stride per agent kind, in ms. Cron-ish agents step by 2h, daily by
  // 24h, weekly by 7d. Default falls back to 2h.
  let strideMs;
  if (agent.trigger === 'weekly') strideMs = 7 * 24 * 60 * 60 * 1000;
  else if ((agent.trigger || '').endsWith('daily')) strideMs = 24 * 60 * 60 * 1000;
  else strideMs = 2 * 60 * 60 * 1000;

  const templates = SYNTHETIC_RUN_TEMPLATES[agent.id] || SYNTHETIC_RUN_TEMPLATES.default;
  let cursor = last.atMs - strideMs;
  let i = 0;
  while (out.length < 50) {
    const tpl = templates[i % templates.length];
    // every ~12th synthetic run is an error so the drawer can demo failures.
    const isError = (i + 1) % 12 === 0;
    const atMs = cursor;
    const d = new Date(atMs);
    const t = formatRunStamp(d, agent.trigger === 'weekly');
    out.push({
      id: `${agent.id}-r-syn-${i + 1}`,
      atMs, t,
      msg: isError ? 'Run failed · see details' : tpl.msg,
      level: isError ? 'error' : 'info',
      durationMs: tpl.durationMs,
      tools: tpl.tools,
      input: tpl.input,
      output: isError ? '' : tpl.output,
      error: isError ? 'TypeError: Cannot read property \'subject\' of undefined\n    at processInbox (gmail.js:42)\n    at runAgent (runner.js:88)' : undefined,
      memoryTouched: [],
    });
    cursor -= strideMs;
    i += 1;
  }
  return out;
}

function formatRunStamp(d, weekly) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (weekly) {
    const wd = d.toLocaleDateString('en-US', { weekday: 'short' });
    return `${wd} ${hh}:${mm}`;
  }
  return `${hh}:${mm}`;
}

// Per-agent synthetic run templates. Each agent has a small list that
// cycles to keep the synthetic history readable.
const SYNTHETIC_RUN_TEMPLATES = {
  'inbox-triage': [
    { msg: 'Polled inbox · 0 new', durationMs: 600, tools: ['gmail'], input: 'Sweep inbox', output: 'No new mail since last sweep.' },
    { msg: 'Read 2 emails · 0 priority', durationMs: 900, tools: ['gmail', 'memory'], input: 'Sweep inbox', output: '2 newsletters, both auto-archived.' },
    { msg: 'Auth refresh · token rotated', durationMs: 400, tools: ['gmail'], input: 'Token expiring · refresh', output: 'OAuth refresh succeeded.' },
  ],
  'meeting-notes': [
    { msg: 'No calendar events in window', durationMs: 200, tools: ['calendar'], input: 'Window check', output: 'Calendar empty.' },
    { msg: 'Processed 1 meeting · 2 decisions', durationMs: 3100, tools: ['calendar', 'memory'], input: 'Meeting end trigger', output: '2 decisions extracted, linked to 1 entity.' },
    { msg: 'Linked event to entity', durationMs: 1200, tools: ['calendar', 'memory'], input: 'Event start', output: 'Linked to existing entity in memory.' },
  ],
  'daily-digest': [
    { msg: 'Wrote daily digest · 9 highlights', durationMs: 7200, tools: ['memory', 'note'], input: 'Synthesize the day', output: '9 highlights, 1 theme. Note written.' },
    { msg: 'Morning brief · 3 priorities', durationMs: 5800, tools: ['memory', 'note'], input: 'Generate morning brief', output: '3 priorities surfaced.' },
    { msg: 'Wrote daily digest · 12 highlights', durationMs: 8100, tools: ['memory', 'note'], input: 'Synthesize the day', output: '12 highlights across 3 themes.' },
  ],
  'weekly-review': [
    { msg: 'Drafted retro · 2 decisions, 1 risk', durationMs: 11200, tools: ['memory', 'note', 'calendar'], input: 'Synthesize the week', output: '2 decisions, 1 risk flagged.' },
    { msg: 'Drafted retro · 4 decisions', durationMs: 13400, tools: ['memory', 'note', 'calendar'], input: 'Synthesize the week', output: '4 decisions, no risks flagged.' },
  ],
  default: [
    { msg: 'Background tick', durationMs: 300, tools: [], input: 'Tick', output: 'No-op.' },
  ],
};

function RunRow({ run, expanded, onToggle, onOpenMemory }) {
  const levelColor = run.level === 'success' ? 'var(--success)'
                   : run.level === 'error'   ? 'var(--danger)'
                   : 'var(--text-mute)';
  const dur = run.durationMs < 1000
    ? `${run.durationMs}ms`
    : `${(run.durationMs / 1000).toFixed(1)}s`;

  return (
    <div style={{display:'flex', flexDirection:'column'}}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          all: 'unset',
          display: 'grid',
          gridTemplateColumns: '56px 48px 1fr auto',
          gap: 'var(--space-3)',
          alignItems: 'baseline',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <span className="t-mono" style={{color:'var(--text-mute)', fontSize:11}}>{run.t}</span>
        <span className="t-mono" style={{color:'var(--text-dim)', fontSize:11}}>{dur}</span>
        <span style={{color:'var(--text)', fontSize:12, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
          {run.msg}
        </span>
        <span
          className="label"
          style={{
            borderColor: `color-mix(in srgb, ${levelColor} 60%, var(--border))`,
            color: levelColor,
          }}
        >
          {run.level.toUpperCase()}
        </span>
      </button>
      {expanded && (
        <div style={{
          padding: 'var(--space-3) var(--space-4)',
          borderTop: '1px solid var(--border)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          marginBottom: 'var(--space-2)',
        }}>
          {run.tools && run.tools.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>TOOLS</div>
              <div className="t-sm" style={{color:'var(--text)'}}>{run.tools.join(' · ')}</div>
            </div>
          )}
          {run.input && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>INPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.input}</div>
            </div>
          )}
          {run.level === 'error' && run.error ? (
            <div>
              <div className="t-mono" style={{color:'var(--danger)', fontSize:10, marginBottom:'var(--space-1)'}}>ERROR</div>
              <div
                className="t-sm t-mono"
                style={{
                  color:'var(--text)',
                  whiteSpace:'pre-wrap',
                  borderLeft:'2px solid var(--danger)',
                  paddingLeft:'var(--space-2)',
                  fontSize:11,
                }}
              >
                {run.error}
              </div>
            </div>
          ) : run.output ? (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>OUTPUT</div>
              <div className="t-sm" style={{color:'var(--text)', whiteSpace:'pre-wrap'}}>{run.output}</div>
            </div>
          ) : null}
          {run.memoryTouched && run.memoryTouched.length > 0 && (
            <div>
              <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-1)'}}>MEMORY TOUCHED</div>
              <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                {run.memoryTouched.map((m, i) => (
                  <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
                    • <span style={{color:'var(--text)'}}>{m.title}</span>
                    {m.note && <span> ({m.note})</span>}
                    {!m.note && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onOpenMemory(m.id); }}
                        style={{
                          all:'unset', cursor:'pointer',
                          color:'var(--text-dim)', fontSize:11,
                          textDecoration:'underline', marginLeft:'var(--space-2)',
                        }}
                      >
                        [open]
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Bucket runs into 4 chronological groups based on `atMs` and the
// caller's `nowMs`. Returns an ordered array of { label, runs }.
function bucketRunsByDate(runs, nowMs) {
  const now = new Date(nowMs);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday);
  const dow = startOfWeek.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  startOfWeek.setDate(startOfWeek.getDate() + mondayOffset);

  const buckets = {
    TODAY: [],
    YESTERDAY: [],
    'THIS WEEK': [],
    EARLIER: [],
  };
  for (const r of runs) {
    if (r.atMs >= startOfToday.getTime()) buckets.TODAY.push(r);
    else if (r.atMs >= startOfYesterday.getTime()) buckets.YESTERDAY.push(r);
    else if (r.atMs >= startOfWeek.getTime()) buckets['THIS WEEK'].push(r);
    else buckets.EARLIER.push(r);
  }
  return ['TODAY', 'YESTERDAY', 'THIS WEEK', 'EARLIER']
    .map((label) => ({ label, runs: buckets[label] }))
    .filter((b) => b.runs.length > 0);
}

function AgentRunHistoryDrawer({ agent, nowMs, onClose }) {
  const [expandedRunIds, setExpandedRunIds] = React.useState(() => new Set());
  const toggleExpanded = React.useCallback((id) => {
    setExpandedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const runs = React.useMemo(() => generateAgentRunHistory(agent), [agent]);
  const buckets = React.useMemo(() => bucketRunsByDate(runs, nowMs), [runs, nowMs]);

  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] || AGENT_STATUS_META.idle;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  const onOpenMemory = (id) => {
    window.SHOGUN_RUNTIME?.pushToast?.(`Memory item view coming soon (${id})`, 'info');
  };

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position:'fixed', inset:0, zIndex:999,
          background:'rgba(0,0,0,0.4)',
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${agent.name} run history`}
        style={{
          position:'fixed', right:0, top:0, bottom:0,
          width:480, maxWidth:'95vw', zIndex:1000,
          background:'var(--surface)',
          borderLeft:'1px solid var(--border-hi)',
          boxShadow:'var(--shadow-lg)',
          display:'flex', flexDirection:'column',
        }}
      >
        <div style={{
          padding:'var(--space-5) var(--space-6)',
          borderBottom:'1px solid var(--border)',
          display:'flex', alignItems:'flex-start', gap:'var(--space-3)',
        }}>
          <div style={{
            width:40, height:40, borderRadius:'var(--radius-md)',
            background:'var(--surface-2)', border:'1px solid var(--border)',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'var(--gold)', flexShrink:0,
          }}>
            <Icon name={agent.icon} size={18}/>
          </div>
          <div style={{flex:1, minWidth:0}}>
            <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em', marginBottom:4}}>{agent.name}</div>
            <div className="t-mono" style={{display:'inline-flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span style={{width:6, height:6, borderRadius:999, background:status.color, display:'inline-block'}}/>
              {subLine}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close run history"
            style={{
              all:'unset',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
            }}
          >
            <Icon name="x" size={15}/>
          </button>
        </div>
        <div style={{flex:1, overflowY:'auto', padding:'var(--space-5) var(--space-6)'}}>
          {buckets.length === 0 ? (
            <div style={{
              padding:'var(--space-8) var(--space-4)',
              border:`1px dashed var(--border)`,
              borderRadius:'var(--radius-md)',
              textAlign:'center',
              color:'var(--text-mute)',
            }} className="t-sm">
              No runs yet for this agent.
            </div>
          ) : (
            buckets.map(({ label, runs: bucketRuns }, gi) => (
              <div key={label} style={{marginTop: gi === 0 ? 0 : 'var(--space-4)'}}>
                <div className="t-mono" style={{
                  color:'var(--text-mute)', fontSize:10,
                  marginBottom:'var(--space-2)',
                }}>
                  {label}
                </div>
                <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
                  {bucketRuns.map((r) => (
                    <RunRow
                      key={r.id}
                      run={r}
                      expanded={expandedRunIds.has(r.id)}
                      onToggle={() => toggleExpanded(r.id)}
                      onOpenMemory={onOpenMemory}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function AgentCard({ agent, expanded, onToggle, nowMs, onOpenHistory, onEdit, running, onRunNow, onTogglePause }) {
  // If the most recent run failed, surface it as `error` regardless of
  // the schema status — operationally this is what matters.
  const lastRun = agent.recentRuns && agent.recentRuns[0];
  const effectiveStatus = lastRun && lastRun.level === 'error' ? 'error' : agent.status;
  const status = AGENT_STATUS_META[effectiveStatus] || AGENT_STATUS_META.idle;
  const subLine = buildAgentSubLine(agent, status.label, nowMs);

  return (
    <div
      id={`agent-card-${agent.id}`}
      className="card card-hover"
      style={{
        padding: 0,
        overflow: 'hidden',
        borderColor: expanded ? 'var(--border-hi)' : 'var(--border)',
        transition: `border-color var(--dur-base) var(--ease-out)`,
      }}
    >
      <div style={{padding:'var(--space-4) var(--space-6)', display:'flex', alignItems:'flex-start', gap:'var(--space-3)'}}>
        <div style={{
          width:40, height:40, borderRadius:'var(--radius-md)',
          background:'var(--surface-2)', border:'1px solid var(--border)',
          display:'flex', alignItems:'center', justifyContent:'center',
          color:'var(--gold)', flexShrink:0,
        }}>
          <Icon name={agent.icon} size={18}/>
        </div>
        <div style={{flex:1, minWidth:0}}>
          <div style={{fontSize:16, fontWeight:600, letterSpacing:'-0.01em', marginBottom:4}}>{agent.name}</div>
          <div className="t-mono" style={{display:'inline-flex', alignItems:'center', gap:'var(--space-2)'}}>
            <span style={{width:6, height:6, borderRadius:999, background:status.color, display:'inline-block'}}/>
            {subLine}
          </div>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-label={expanded ? 'Collapse agent' : 'Expand agent'}
          aria-expanded={expanded}
          style={{
            all:'unset',
            padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)', cursor:'pointer',
          }}
        >
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={15}/>
        </button>
      </div>
      <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-4) var(--space-6)', color:'var(--text-mute)'}} className="t-sm">
        {agent.description}
      </div>
      {expanded && (
        <div style={{borderTop:'1px solid var(--border)', padding:'var(--space-5) var(--space-6)', display:'flex', flexDirection:'column', gap:'var(--space-4)'}}>
          {/* TRIGGER */}
          <div>
            <div className="t-mono" style={{color:'var(--text-mute)', marginBottom:'var(--space-1)'}}>TRIGGER</div>
            <div className="t-sm">
              {agent.trigger}
              {agent.triggerSince && <> · since {agent.triggerSince}</>}
              {fmtNextTime(agent.nextRunMs, nowMs) && <> · next {fmtNextTime(agent.nextRunMs, nowMs)}</>}
            </div>
          </div>
          {/* Actions */}
          <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={running}
              onClick={onRunNow}
              style={{opacity: running ? 0.6 : 1, cursor: running ? 'wait' : 'pointer'}}
            >
              <Icon name={running ? 'loader' : 'play'} size={12}/>
              {running ? ' Running…' : ' Run now'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={onTogglePause}
            >
              <Icon name={agent.paused ? 'play' : 'pause'} size={12}/>
              {agent.paused ? ' Resume' : ' Pause'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => onEdit(agent.id)}
            >
              <Icon name="edit" size={12}/> Edit
            </button>
          </div>
          {/* Recent runs */}
          <div>
            <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', marginBottom:'var(--space-2)'}}>
              <span className="t-mono" style={{color:'var(--text-mute)'}}>RECENT RUNS</span>
            </div>
            <RecentRunsList
              runs={agent.recentRuns}
              onSeeAll={() => onOpenHistory(agent.id)}
            />
          </div>
        </div>
      )}
      <div style={{padding:'var(--space-3) var(--space-6)', borderTop:'1px solid var(--border)', display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
        <span style={{flex:1}}/>
        {agent.tools.map((tool) => (
          <span key={tool.name} className="label" style={{display:'inline-flex', alignItems:'center', gap:5}}>
            <Icon name={tool.icon} size={11}/>{tool.name}
          </span>
        ))}
      </div>
    </div>
  );
}

function ScreenAgents() {
  const [runPrompt, setRunPrompt] = React.useState('');
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = React.useState(true);
  const [playgroundOpen, setPlaygroundOpen] = React.useState(false);
  const [newAgentModalOpen, setNewAgentModalOpen] = React.useState(false);
  const [historyDrawerAgentId, setHistoryDrawerAgentId] = React.useState(null);
  const [editModalAgentId, setEditModalAgentId] = React.useState(null);
  const [sourceAgents] = React.useState(() => AGENTS_DEMO);
  const [agentOverrides, setAgentOverrides] = React.useState({});
  // Settings cache for the paused-overlay. Re-fetched whenever
  // settingsTick increments (e.g., after Pause/Resume save).
  const [settings, setSettings] = React.useState(null);
  const [settingsTick, setSettingsTick] = React.useState(0);
  const [runningIds, setRunningIds] = React.useState(() => new Set());
  React.useEffect(() => {
    let cancelled = false;
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled) return;
      if (r?.ok && r.data?.settings?.sections) setSettings(r.data.settings.sections);
    });
    return () => { cancelled = true; };
  }, [settingsTick]);

  const effectiveAgents = React.useMemo(() => {
    return sourceAgents.map((a) => {
      const o = agentOverrides[a.id];
      let merged = o ? { ...a, ...o } : a;
      const def = AGENT_RUNTIME[a.id];
      if (def && settings) {
        const [section, key] = def.pausedSettingPath;
        const enabled = settings[section]?.[key];
        if (enabled === false) {
          merged = { ...merged, status: 'paused', paused: true };
        }
      }
      return merged;
    });
  }, [agentOverrides, sourceAgents, settings]);

  const [expandedIds, setExpandedIds] = React.useState(() => new Set());
  const toggleExpanded = React.useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const [filterStatus, setFilterStatus] = React.useState('all');

  const filterCounts = React.useMemo(() => {
    const c = { all: effectiveAgents.length, running: 0, scheduled: 0, paused: 0, error: 0 };
    for (const a of effectiveAgents) {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      if (c[eff] !== undefined) c[eff] += 1;
    }
    return c;
  }, [effectiveAgents]);

  const visibleAgents = React.useMemo(() => {
    if (filterStatus === 'all') return effectiveAgents;
    return effectiveAgents.filter((a) => {
      const last = a.recentRuns && a.recentRuns[0];
      const eff = last && last.level === 'error' ? 'error' : a.status;
      return eff === filterStatus;
    });
  }, [filterStatus, effectiveAgents]);
  const editingAgent = React.useMemo(
    () => effectiveAgents.find((a) => a.id === editModalAgentId) || null,
    [effectiveAgents, editModalAgentId],
  );

  const runAgentNow = React.useCallback(async (agentId) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent || !def) return;
    setRunningIds((prev) => new Set([...prev, agentId]));
    try {
      const res = await runRuntimeActionA(def.runNowAction, def.runNowPayload(), { silentError: true });
      if (res?.ok) {
        window.SHOGUN_RUNTIME?.pushToast?.(def.runNowSuccessMsg(res.data), 'success');
      } else {
        const errMsg = res?.error?.message || 'Run failed';
        window.SHOGUN_RUNTIME?.pushToast?.(`${agent.name}: ${errMsg}`, 'warn');
      }
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
    }
  }, [effectiveAgents]);

  const togglePauseAgent = React.useCallback(async (agentId) => {
    const agent = effectiveAgents.find((a) => a.id === agentId);
    const def = AGENT_RUNTIME[agentId];
    if (!agent || !def) return;
    const [section, key] = def.pausedSettingPath;
    const currentEnabled = settings?.[section]?.[key];
    const nextEnabled = currentEnabled === false ? true : false;

    const patch = { section, [key]: nextEnabled };
    const res = await runRuntimeActionA('settings.save', patch, { silentError: true });
    if (res?.ok) {
      setSettingsTick((n) => n + 1);
      window.SHOGUN_RUNTIME?.pushToast?.(
        nextEnabled
          ? `${agent.name} resumed`
          : `${agent.name} paused — background work halted`,
        'info',
      );
    } else {
      window.SHOGUN_RUNTIME?.pushToast?.(`Failed to update ${agent.name}`, 'warn');
    }
  }, [effectiveAgents, settings]);

  React.useEffect(() => {
    let cancelled = false;
    void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
      if (cancelled || !r?.ok || !r.data?.settings?.sections?.privacy) return;
      const priv = r.data.settings.sections.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeActionB('settings.load', {}, { silentError: true }).then((r) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);

  const draftWithMemory = React.useCallback(() => {
    const raw = runPrompt.trim();
    const prompt =
      raw ||
      'Summarize actionable items from my recent local memory index. Output Markdown: bullets, owners if known, and open questions.';
    const payload = { target: 'agent_run', source: 'agents_playground', prompt };
    if (allowServerMemoryAssembly) {
      payload.memoryAssembly = { query: raw.slice(0, 480) || '', limit: 14, semantic: true };
    }
    return runRuntimeActionB('draft.create', payload, { successMessage: 'Draft ready', silentError: true }).then((r) => {
      if (!r.ok && window.SHOGUN_RUNTIME && window.SHOGUN_RUNTIME.pushToast) {
        window.SHOGUN_RUNTIME.pushToast(r.error && r.error.message ? r.error.message : 'Draft failed', 'warn');
      }
    });
  }, [runPrompt, allowServerMemoryAssembly]);

  const openChatWithMemory = React.useCallback(() => {
    const raw = runPrompt.trim();
    const text =
      raw ||
      'You are my execution agent. Use local memory context to propose the next 3 concrete steps (bullets).';
    const q = raw.slice(0, 480) || '';
    const detail = { text, webSearch: false, assembleMemory: allowServerMemoryAssembly };
    if (allowServerMemoryAssembly) {
      detail.memoryAssemblyPreset = { query: q, limit: 14, semantic: true };
    } else {
      detail.clearMemoryAssemblyPreset = true;
    }
    window.dispatchEvent(new CustomEvent('shogun-chat-composer-seed', { detail }));
    window.SHOGUN_RUNTIME?.setActiveScreen?.('chat');
  }, [runPrompt, allowServerMemoryAssembly]);

  const attentionCount = effectiveAgents.filter((a) => {
    const last = a.recentRuns && a.recentRuns[0];
    const stale = (a.status === 'scheduled' || a.trigger?.startsWith('every ')) &&
                  a.lastRunMs && (AGENTS_DEMO_NOW - a.lastRunMs) > 24 * 60 * 60 * 1000;
    return a.attention === 'error' || a.attention === 'auth_expired' ||
           (last && last.level === 'error') || a.attention === 'stale' || stale;
  }).length;

  return (
    <div className="content-inner" style={{padding:'var(--space-8) var(--space-12) var(--space-12)', maxWidth:1280, margin:'0 auto'}}>
      {/* Header */}
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:'var(--space-2)'}}>EXECUTION LAYER</div>
          <h1>Agents</h1>
          <div className="sub">
            <span style={{color:'var(--text-mute)'}}>{effectiveAgents.length} agents · 11 MCP tools</span>
            {attentionCount > 0 && (
              <>
                <span style={{color:'var(--text-mute)'}}> · </span>
                <span style={{color:'var(--danger)'}}>{attentionCount} needs attention</span>
              </>
            )}
          </div>
        </div>
        <div className="row" style={{gap:'var(--space-2)', flexWrap:'wrap'}}>
          <button type="button" className="btn btn-secondary" onClick={() => setPlaygroundOpen((v) => !v)}>
            <Icon name="terminal" size={14}/> MCP console
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setNewAgentModalOpen(true)}>
            <Icon name="plus" size={14}/> New agent
          </button>
        </div>
      </div>

      <AttentionStrip
        agents={effectiveAgents}
        nowMs={AGENTS_DEMO_NOW}
        onRunNow={runAgentNow}
        onView={(id) => {
          setExpandedIds((prev) => new Set([...prev, id]));
          requestAnimationFrame(() => {
            const el = document.getElementById(`agent-card-${id}`);
            if (el && typeof el.scrollIntoView === 'function') {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
          });
        }}
      />


      {/* Agents section */}
      <div style={{marginBottom:'var(--space-3)', color:'var(--text-mute)'}} className="t-sm">Your agents</div>
      <FilterBar
        active={filterStatus}
        onChange={setFilterStatus}
        counts={filterCounts}
      />
      {visibleAgents.length === 0 ? (
        <div style={{marginBottom:'var(--space-8)'}}>
          <AgentsEmptyState
            filterStatus={filterStatus}
            totalCount={effectiveAgents.length}
            onCreate={() => setNewAgentModalOpen(true)}
          />
        </div>
      ) : (
        <div style={{display:'grid', gridTemplateColumns:'repeat(2, minmax(0, 1fr))', gap:'var(--space-4)', marginBottom:'var(--space-8)'}}>
          {visibleAgents.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              expanded={expandedIds.has(a.id)}
              onToggle={() => toggleExpanded(a.id)}
              nowMs={AGENTS_DEMO_NOW}
              onOpenHistory={setHistoryDrawerAgentId}
              onEdit={setEditModalAgentId}
              running={runningIds.has(a.id)}
              onRunNow={() => runAgentNow(a.id)}
              onTogglePause={() => togglePauseAgent(a.id)}
            />
          ))}
        </div>
      )}

      {/* Live activity (compressed footer per spec § 1) */}
      <div className="t-mono" style={{color:'var(--text-dim)', marginTop:'var(--space-8)', marginBottom:'var(--space-2)'}}>
        LIVE ACTIVITY
      </div>
      <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)', borderTop:'1px solid var(--border)', paddingTop:'var(--space-3)'}}>
        {AGENTS_LIVE.slice(0, 5).map((row, i) => {
          const levelColor = row.level === 'success' ? 'var(--success)'
                           : row.level === 'error'   ? 'var(--danger)'
                           : 'var(--text-mute)';
          return (
            <div key={i} style={{
              display:'grid', gridTemplateColumns:'80px 120px 1fr auto', columnGap:'var(--space-3)',
              alignItems:'baseline', fontSize:11,
            }} className="t-mono">
              <span style={{color:'var(--text-dim)'}}>{row.t}</span>
              <span style={{color:'var(--text-mute)'}}>{row.agent}</span>
              <span style={{color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontFamily:'inherit'}}>{row.msg}</span>
              <span style={{color:levelColor, textTransform:'uppercase', fontSize:10}}>{row.level}</span>
            </div>
          );
        })}
      </div>

      <NewAgentModal
        open={newAgentModalOpen}
        onClose={() => setNewAgentModalOpen(false)}
        onOpenPlayground={() => {
          setNewAgentModalOpen(false);
          setPlaygroundOpen(true);
        }}
      />

      {historyDrawerAgentId && (
        <AgentRunHistoryDrawer
          agent={effectiveAgents.find((a) => a.id === historyDrawerAgentId)}
          nowMs={AGENTS_DEMO_NOW}
          onClose={() => setHistoryDrawerAgentId(null)}
        />
      )}

      {editingAgent && (
        <EditAgentModal
          agent={editingAgent}
          onClose={() => setEditModalAgentId(null)}
          onSave={(patch) => {
            setAgentOverrides((prev) => ({
              ...prev,
              [editModalAgentId]: {
                ...(prev[editModalAgentId] || {}),
                ...patch,
              },
            }));
            setEditModalAgentId(null);
            window.SHOGUN_RUNTIME?.pushToast?.('Agent updated', 'success');
          }}
        />
      )}

      {/* Playground drawer — kept for the memory-aware draft + chat flows */}
      {playgroundOpen && (
        <div className="card" style={{marginTop:'var(--space-8)', borderColor:'var(--gold-dim)'}}>
          <div className="row" style={{alignItems:'center', gap:'var(--space-3)', marginBottom:'var(--space-4)'}}>
            <div className="t-mono" style={{color:'var(--gold)'}}>NEW AGENT · PLAYGROUND</div>
            <span className="spacer"/>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setPlaygroundOpen(false)}
              aria-label="Close"
              style={{padding:'0 8px'}}
            >
              <Icon name="x" size={14}/>
            </button>
          </div>
          <textarea
            className="input"
            style={{
              width:'100%',
              minHeight:88,
              height:'auto',
              resize:'vertical',
              padding:'var(--space-3)',
              boxSizing:'border-box',
              fontFamily:'inherit',
            }}
            placeholder="例: 今週のリスクを Memory から洗い出して / 投資家向けに1段落…"
            value={runPrompt}
            onChange={(e) => setRunPrompt(e.target.value)}
          />
          <div className="row" style={{gap:'var(--space-2)', marginTop:'var(--space-3)', flexWrap:'wrap'}}>
            <button className="btn btn-primary" type="button" onClick={draftWithMemory}>
              <Icon name="edit" size={14}/> Draft + Memory
            </button>
            <button className="btn btn-secondary" type="button" onClick={openChatWithMemory}>
              <Icon name="chat" size={14}/> Open in Chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

window.ScreenAgents = ScreenAgents;
