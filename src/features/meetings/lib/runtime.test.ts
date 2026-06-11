import { describe, it, expect } from 'vitest';
import { fmtElapsedMs, GRANOLA_CLASSES } from './runtime';

// ─── fmtElapsedMs ─────────────────────────────────────────────────────────────

describe('fmtElapsedMs', () => {
  it('formats 0ms as "0:00"', () => {
    expect(fmtElapsedMs(0)).toBe('0:00');
  });

  it('formats 1000ms as "0:01"', () => {
    expect(fmtElapsedMs(1000)).toBe('0:01');
  });

  it('formats 60000ms as "1:00"', () => {
    expect(fmtElapsedMs(60_000)).toBe('1:00');
  });

  it('formats 83000ms as "1:23"', () => {
    expect(fmtElapsedMs(83_000)).toBe('1:23');
  });

  it('formats 3600000ms as "1:00:00" (hour format)', () => {
    expect(fmtElapsedMs(3_600_000)).toBe('1:00:00');
  });

  it('formats 3723000ms as "1:02:03"', () => {
    expect(fmtElapsedMs(3_723_000)).toBe('1:02:03');
  });

  it('pads seconds with leading zero', () => {
    expect(fmtElapsedMs(65_000)).toBe('1:05');
  });

  it('handles sub-second rounding (floors to seconds)', () => {
    expect(fmtElapsedMs(1999)).toBe('0:01');
  });

  it('formats very large duration with hours', () => {
    // 2h + 30m + 15s = 9015000ms
    expect(fmtElapsedMs(9_015_000)).toBe('2:30:15');
  });
});

// ─── GRANOLA_CLASSES ──────────────────────────────────────────────────────────

describe('GRANOLA_CLASSES', () => {
  it('exposes stable CSS class tokens for Granola UI', () => {
    expect(GRANOLA_CLASSES.pill).toBe('granola-pill');
    expect(GRANOLA_CLASSES.pillBtn).toContain('granola-pill');
    expect(GRANOLA_CLASSES.pillGold).toContain('granola-pill--gold');
    expect(GRANOLA_CLASSES.miniBtn).toBe('granola-mini-btn');
    expect(GRANOLA_CLASSES.miniBtnGold).toContain('granola-mini-btn--gold');
    expect(GRANOLA_CLASSES.textarea).toBe('granola-textarea');
    expect(GRANOLA_CLASSES.iconBtn).toBe('granola-icon-btn');
  });
});
