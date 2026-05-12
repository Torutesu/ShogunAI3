import { describe, it, expect } from 'vitest';
import { fmtElapsedMs, granolaMiniBtn, granolaPillStyle } from './runtime';

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

// ─── granolaMiniBtn ───────────────────────────────────────────────────────────

describe('granolaMiniBtn', () => {
  it('returns an object with expected style keys', () => {
    const style = granolaMiniBtn('#fff', '#ccc', '#000');
    expect(style).toHaveProperty('fontSize');
    expect(style).toHaveProperty('padding');
    expect(style).toHaveProperty('borderRadius');
    expect(style).toHaveProperty('border');
    expect(style).toHaveProperty('background');
    expect(style).toHaveProperty('color');
    expect(style).toHaveProperty('cursor');
    expect(style).toHaveProperty('fontFamily');
  });

  it('uses the provided surface color as background', () => {
    const style = granolaMiniBtn('#f0f0f0', '#ddd', '#333');
    expect(style.background).toBe('#f0f0f0');
  });

  it('uses the provided border color in the border property', () => {
    const style = granolaMiniBtn('#fff', '#aabbcc', '#000');
    expect(style.border).toContain('#aabbcc');
  });

  it('uses the provided text color', () => {
    const style = granolaMiniBtn('#fff', '#ccc', '#ff0000');
    expect(style.color).toBe('#ff0000');
  });
});

// ─── granolaPillStyle ─────────────────────────────────────────────────────────

describe('granolaPillStyle', () => {
  it('returns an object with display: inline-flex', () => {
    const style = granolaPillStyle('#fff', '#ccc', '#000');
    expect(style.display).toBe('inline-flex');
  });

  it('uses borderRadius 999', () => {
    const style = granolaPillStyle('#fff', '#ccc', '#000');
    expect(style.borderRadius).toBe(999);
  });

  it('uses the provided colors', () => {
    const style = granolaPillStyle('#background', '#border', '#textcolor');
    expect(style.background).toBe('#background');
    expect(style.color).toBe('#textcolor');
    expect(style.border).toContain('#border');
  });
});
