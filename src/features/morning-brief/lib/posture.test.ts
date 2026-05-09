import { describe, it, expect } from 'vitest';
import { contextIconName, formatFocusBlocks, POSTURE_LABEL, CONTEXT_ICON } from './posture';

describe('contextIconName', () => {
  it('returns mapped icon for known types', () => {
    expect(contextIconName('document')).toBe('note');
    expect(contextIconName('person')).toBe('users');
    expect(contextIconName('decision')).toBe('check');
    expect(contextIconName('slack_thread')).toBe('chat');
    expect(contextIconName('email')).toBe('mail');
    expect(contextIconName('commit')).toBe('terminal');
    expect(contextIconName('calendar')).toBe('calendar');
  });

  it('falls back to "file" for unknown or empty types', () => {
    expect(contextIconName('unknown')).toBe('file');
    expect(contextIconName('')).toBe('file');
    expect(contextIconName(undefined)).toBe('file');
  });
});

describe('formatFocusBlocks', () => {
  it('returns null for empty or missing input', () => {
    expect(formatFocusBlocks(undefined)).toBeNull();
    expect(formatFocusBlocks([])).toBeNull();
  });

  it('formats single block with hour duration', () => {
    expect(
      formatFocusBlocks([{ start: '09:00', end: '11:00', duration_minutes: 120 }]),
    ).toBe('09:00-11:00 (2h)');
  });

  it('formats single block in minutes only when rounded hour is 0', () => {
    // Original quirk preserved: Math.round(45/60) = 1 → "1h", so only durations
    // strictly below 30 minutes render as "Xm" (since Math.round rounds half up).
    expect(
      formatFocusBlocks([{ start: '09:00', end: '09:14', duration_minutes: 14 }]),
    ).toBe('09:00-09:14 (14m)');
  });

  it('rounds 45 minutes up to 1h (preserves legacy behavior)', () => {
    expect(
      formatFocusBlocks([{ start: '09:00', end: '09:45', duration_minutes: 45 }]),
    ).toBe('09:00-09:45 (1h)');
  });

  it('joins multiple blocks with " · "', () => {
    expect(
      formatFocusBlocks([
        { start: '09:00', end: '10:00', duration_minutes: 60 },
        { start: '14:00', end: '16:00', duration_minutes: 120 },
      ]),
    ).toBe('09:00-10:00 (1h) · 14:00-16:00 (2h)');
  });
});

describe('POSTURE_LABEL / CONTEXT_ICON', () => {
  it('has all 4 postures', () => {
    expect(Object.keys(POSTURE_LABEL).sort()).toEqual([
      'focus',
      'launch',
      'meeting-heavy',
      'recovery',
    ]);
  });

  it('has all 7 context types', () => {
    expect(Object.keys(CONTEXT_ICON).length).toBe(7);
  });
});
