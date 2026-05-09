import type { AgentDemo, AgentLiveEntry } from '../types';

export const AGENTS_DEMO_NOW = Date.parse('2026-04-27T14:30:00+09:00');
export const HOUR = 60 * 60 * 1000;

export const AGENTS_DEMO: AgentDemo[] = [
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

export const AGENTS_LIVE: AgentLiveEntry[] = [
  { t: '14:31:08', agent: 'inbox-triage', msg: 'Read 3 emails · drafted 1 reply', level: 'success' },
  { t: '14:18:42', agent: 'meeting-notes', msg: 'Processed "All PJ" meeting · 6 decisions extracted', level: 'success' },
  { t: '14:02:15', agent: 'memory', msg: 'Indexed conversation · 48 messages · 3 entities linked', level: 'info' },
  { t: '13:46:02', agent: 'inbox-triage', msg: 'Polled inbox · no new priority mail', level: 'info' },
  { t: '13:20:37', agent: 'daily-digest', msg: 'Scheduled: next run at 21:00', level: 'info' },
];
