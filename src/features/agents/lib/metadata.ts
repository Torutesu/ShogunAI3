import type { AgentDemo, TriggerForm } from '../types';

// ─── Status display metadata ───────────────────────────────────────────────

export const AGENT_STATUS_META: Record<string, { color: string; label: string }> = {
  running: { color: 'var(--success)', label: 'running' },
  scheduled: { color: 'var(--gold)', label: 'scheduled' },
  idle: { color: 'var(--text-mute)', label: 'idle' },
  paused: { color: 'var(--text-dim)', label: 'paused' },
  error: { color: 'var(--danger)', label: 'error' },
};

// ─── Per-agent IPC runtime config ─────────────────────────────────────────
// Per-agent runtime mapping: which IPC action backs each agent's
// Run now button, and which settings path drives its Pause/Resume.
// Daily-digest and weekly-review intentionally share
// `enableMemoryDigestAutoSync` — pausing one pauses both, matching
// the current rollup_sync.rs behavior.

export const AGENT_RUNTIME: Record<string, {
  runNowAction: string;
  runNowPayload: () => Record<string, unknown>;
  runNowSuccessMsg: (data: any) => string;
  pausedSettingPath: [string, string];
}> = {
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

// ─── Attention reasons ─────────────────────────────────────────────────────

export const ATTENTION_REASONS: Record<string, (a: AgentDemo & { lastRunRel?: string }) => string> = {
  error: (a) => `${a.name} failed last run ${'lastRunRel' in a ? a.lastRunRel : 'recently'}.`,
  stale: (a) => `${a.name} hasn't run in over 24 hours.`,
  auth_expired: (a) => `${a.name} needs re-authorization.`,
};

export function agentNeedsAttention(agent: AgentDemo, nowMs: number): boolean {
  if (agent.paused) return false;
  const last = agent.recentRuns && agent.recentRuns[0];
  const tooStale =
    (agent.status === 'scheduled' || agent.trigger?.startsWith('every ')) &&
    agent.lastRunMs != null &&
    (nowMs - agent.lastRunMs) > 24 * 60 * 60 * 1000;
  return (
    agent.attention === 'error' ||
    agent.attention === 'auth_expired' ||
    agent.attention === 'stale' ||
    Boolean(last && last.level === 'error') ||
    tooStale
  );
}

// ─── Filter options ────────────────────────────────────────────────────────

export const FILTER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'attention', label: 'attention' },
  { id: 'running', label: 'running' },
  { id: 'scheduled', label: 'scheduled' },
  { id: 'paused', label: 'paused' },
  { id: 'error', label: 'error' },
];

export const CUSTOM_AGENT_TOOL_OPTIONS: Array<{ name: string; icon: string }> = [
  { name: 'memory', icon: 'memory' },
  { name: 'mail', icon: 'mail' },
  { name: 'calendar', icon: 'calendar' },
  { name: 'note', icon: 'note' },
  { name: 'github', icon: 'github' },
];

// ─── Synthetic run templates ───────────────────────────────────────────────

export interface SyntheticRunTemplate {
  msg: string;
  durationMs: number;
  tools: string[];
  input: string;
  output: string;
}

export const SYNTHETIC_RUN_TEMPLATES: Record<string, SyntheticRunTemplate[]> = {
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

// ─── Trigger parsing helpers ───────────────────────────────────────────────

// Pure: decode a free-form `agent.trigger` string into a structured form
// the EditAgentModal can edit. Falls back to interval/1/hour when no
// pattern matches and warns to the console (the demo data should never
// hit the fallback in practice).
export function parseTrigger(triggerStr: string): TriggerForm {
  const s = String(triggerStr || '').trim();
  let m: RegExpMatchArray | null;
  m = s.match(/^every (\d+) (minute|hour|day)s?$/);
  if (m) {
    const result: TriggerForm = { type: 'interval', value: Number(m[1] ?? '1'), unit: m[2] ?? 'hour' };
    return result;
  }
  m = s.match(/^on (\w+) event$/);
  if (m) {
    const result: TriggerForm = { type: 'event', source: m[1] ?? 'calendar' };
    return result;
  }
  m = s.match(/^(\d{2}):(\d{2}) daily$/);
  if (m) {
    const result: TriggerForm = { type: 'daily', time: `${m[1] ?? '12'}:${m[2] ?? '00'}` };
    return result;
  }
  if (s === 'weekly') return { type: 'weekly' };
  console.warn('parseTrigger: unrecognized trigger string:', triggerStr);
  return { type: 'interval', value: 1, unit: 'hour' };
}

// Pure: round-trip a structured form back to the same string format
// AGENTS_DEMO uses today.
export function serializeTrigger(form: TriggerForm): string {
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

// ─── Time formatting helpers ───────────────────────────────────────────────

// "2h ago" / "12m ago" / "Sun 10:00" — relative to AGENTS_DEMO_NOW.
export function fmtRelativeTime(ms: number, nowMs: number): string {
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
export function fmtNextTime(ms: number | null, nowMs: number): string | null {
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
export function buildAgentSubLine(agent: AgentDemo, statusLabel: string, nowMs: number): string {
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
