import { describe, it, expect } from 'vitest';
import {
  parseTrigger,
  serializeTrigger,
  fmtRelativeTime,
  fmtNextTime,
  buildAgentSubLine,
} from './metadata';
import type { AgentDemo } from '../types';

// ─── parseTrigger ────────────────────────────────────────────────────────────

describe('parseTrigger', () => {
  it('parses interval trigger (singular unit)', () => {
    expect(parseTrigger('every 1 hour')).toEqual({ type: 'interval', value: 1, unit: 'hour' });
  });

  it('parses interval trigger (plural unit)', () => {
    expect(parseTrigger('every 30 minutes')).toEqual({ type: 'interval', value: 30, unit: 'minute' });
  });

  it('parses daily trigger', () => {
    expect(parseTrigger('09:00 daily')).toEqual({ type: 'daily', time: '09:00' });
  });

  it('parses event trigger', () => {
    expect(parseTrigger('on calendar event')).toEqual({ type: 'event', source: 'calendar' });
  });

  it('parses weekly trigger', () => {
    expect(parseTrigger('weekly')).toEqual({ type: 'weekly' });
  });

  it('falls back to interval/1/hour for unrecognized string', () => {
    expect(parseTrigger('unknown trigger format')).toEqual({ type: 'interval', value: 1, unit: 'hour' });
  });

  it('falls back for empty string', () => {
    expect(parseTrigger('')).toEqual({ type: 'interval', value: 1, unit: 'hour' });
  });

  it('trims surrounding whitespace', () => {
    expect(parseTrigger('  weekly  ')).toEqual({ type: 'weekly' });
  });
});

// ─── serializeTrigger ────────────────────────────────────────────────────────

describe('serializeTrigger', () => {
  it('serializes interval=1 without plural s', () => {
    expect(serializeTrigger({ type: 'interval', value: 1, unit: 'hour' })).toBe('every 1 hour');
  });

  it('serializes interval=5 with plural s', () => {
    expect(serializeTrigger({ type: 'interval', value: 5, unit: 'minute' })).toBe('every 5 minutes');
  });

  it('serializes daily trigger', () => {
    expect(serializeTrigger({ type: 'daily', time: '09:00' })).toBe('09:00 daily');
  });

  it('serializes event trigger', () => {
    expect(serializeTrigger({ type: 'event', source: 'calendar' })).toBe('on calendar event');
  });

  it('serializes weekly trigger', () => {
    expect(serializeTrigger({ type: 'weekly' })).toBe('weekly');
  });

  it('returns empty string for missing/null form', () => {
    expect(serializeTrigger(null as any)).toBe('');
  });

  it('round-trips parseTrigger → serializeTrigger for daily', () => {
    const raw = '14:30 daily';
    expect(serializeTrigger(parseTrigger(raw))).toBe(raw);
  });

  it('round-trips parseTrigger → serializeTrigger for event', () => {
    const raw = 'on gmail event';
    expect(serializeTrigger(parseTrigger(raw))).toBe(raw);
  });

  it('defaults missing unit to "hour" for interval', () => {
    expect(serializeTrigger({ type: 'interval', value: 2 })).toBe('every 2 hours');
  });
});

// ─── fmtRelativeTime ─────────────────────────────────────────────────────────

describe('fmtRelativeTime', () => {
  const nowMs = 1_700_000_000_000;

  it('returns "—" for falsy ms', () => {
    expect(fmtRelativeTime(0, nowMs)).toBe('—');
  });

  it('returns "—" for falsy nowMs', () => {
    expect(fmtRelativeTime(nowMs, 0)).toBe('—');
  });

  it('returns "just now" for diff < 60s', () => {
    expect(fmtRelativeTime(nowMs - 30_000, nowMs)).toBe('just now');
  });

  it('returns minutes ago for diff < 1h', () => {
    expect(fmtRelativeTime(nowMs - 15 * 60_000, nowMs)).toBe('15m ago');
  });

  it('returns hours ago for diff < 24h', () => {
    expect(fmtRelativeTime(nowMs - 3 * 60 * 60_000, nowMs)).toBe('3h ago');
  });

  it('returns days ago for diff < 7d', () => {
    expect(fmtRelativeTime(nowMs - 3 * 24 * 60 * 60_000, nowMs)).toBe('3d ago');
  });

  it('returns month/day format for diff >= 7d', () => {
    const result = fmtRelativeTime(nowMs - 10 * 24 * 60 * 60_000, nowMs);
    // Should be like "Oct 25" or similar — check it's not one of the relative suffixes
    expect(result).not.toMatch(/ago|now/);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─── fmtNextTime ─────────────────────────────────────────────────────────────

describe('fmtNextTime', () => {
  it('returns null for falsy ms', () => {
    expect(fmtNextTime(null, Date.now())).toBeNull();
  });

  it('returns null for falsy nowMs', () => {
    expect(fmtNextTime(Date.now(), 0)).toBeNull();
  });

  it('returns HH:MM for same-day time', () => {
    // Build a target time 2h in the future but same day
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const future = new Date(now);
    future.setHours(12, 30, 0, 0);
    const result = fmtNextTime(future.getTime(), now.getTime());
    expect(result).toBe('12:30');
  });

  it('returns "Weekday HH:MM" for a different-day time', () => {
    // Use a fixed past timestamp for stability
    const refNow = new Date('2024-01-01T10:00:00').getTime();
    const nextDay = new Date('2024-01-02T09:00:00').getTime();
    const result = fmtNextTime(nextDay, refNow);
    expect(result).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
  });
});

// ─── buildAgentSubLine ───────────────────────────────────────────────────────

describe('buildAgentSubLine', () => {
  const nowMs = 1_700_000_000_000;

  function makeAgent(overrides: Partial<AgentDemo> = {}): AgentDemo {
    return {
      id: 'test-agent',
      name: 'Test Agent',
      icon: '🤖',
      status: 'idle',
      trigger: 'every 1 hour',
      triggerSince: '09:00',
      description: 'A test agent',
      tools: [],
      lastRunMs: null,
      nextRunMs: null,
      recentRuns: [],
      ...overrides,
    };
  }

  it('includes just the status label when no lastRunMs or nextRunMs', () => {
    const result = buildAgentSubLine(makeAgent(), 'idle', nowMs);
    expect(result).toBe('idle');
  });

  it('includes relative time when lastRunMs set and status is not paused', () => {
    const agent = makeAgent({ lastRunMs: nowMs - 2 * 60 * 60_000 });
    const result = buildAgentSubLine(agent, 'running', nowMs);
    expect(result).toContain('2h ago');
  });

  it('prefixes "last" for paused status', () => {
    const agent = makeAgent({ lastRunMs: nowMs - 60_000 * 30 });
    const result = buildAgentSubLine(agent, 'paused', nowMs);
    expect(result).toContain('last');
  });

  it('includes next time for scheduled status', () => {
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    const future = new Date(now);
    future.setHours(14, 0, 0, 0);
    const agent = makeAgent({ nextRunMs: future.getTime() });
    const result = buildAgentSubLine(agent, 'scheduled', now.getTime());
    expect(result).toContain('next');
    expect(result).toContain('14:00');
  });

  it('does not include next time for idle status', () => {
    const agent = makeAgent({ nextRunMs: nowMs + 60 * 60_000 });
    const result = buildAgentSubLine(agent, 'idle', nowMs);
    expect(result).not.toContain('next');
  });

  it('joins parts with " · "', () => {
    const agent = makeAgent({ lastRunMs: nowMs - 60_000 * 60 });
    const result = buildAgentSubLine(agent, 'running', nowMs);
    expect(result).toContain(' · ');
  });
});
