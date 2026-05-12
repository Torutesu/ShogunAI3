import { describe, it, expect } from 'vitest';
import {
  filterPrivacyRows,
  normalizePrivacyFromSettings,
  timeBlockMinutesToHHMM,
  hhmmToMinutes,
  newQuietBlock,
} from './privacy';

// ─── timeBlockMinutesToHHMM ──────────────────────────────────────────────────

describe('timeBlockMinutesToHHMM', () => {
  it('converts 0 to "00:00"', () => {
    expect(timeBlockMinutesToHHMM(0)).toBe('00:00');
  });

  it('converts 540 to "09:00"', () => {
    expect(timeBlockMinutesToHHMM(540)).toBe('09:00');
  });

  it('converts 1439 to "23:59"', () => {
    expect(timeBlockMinutesToHHMM(1439)).toBe('23:59');
  });

  it('clamps below 0 to "00:00"', () => {
    expect(timeBlockMinutesToHHMM(-10)).toBe('00:00');
  });

  it('clamps above 1439 to "23:59"', () => {
    expect(timeBlockMinutesToHHMM(2000)).toBe('23:59');
  });

  it('converts 60 to "01:00"', () => {
    expect(timeBlockMinutesToHHMM(60)).toBe('01:00');
  });

  it('pads single-digit hours', () => {
    expect(timeBlockMinutesToHHMM(61)).toBe('01:01');
  });
});

// ─── hhmmToMinutes ───────────────────────────────────────────────────────────

describe('hhmmToMinutes', () => {
  it('converts "09:00" to 540', () => {
    expect(hhmmToMinutes('09:00')).toBe(540);
  });

  it('converts "00:00" to 0', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
  });

  it('converts "23:59" to 1439', () => {
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });

  it('returns 0 for empty string', () => {
    expect(hhmmToMinutes('')).toBe(0);
  });

  it('returns 0 for invalid format', () => {
    expect(hhmmToMinutes('not-a-time')).toBe(0);
  });

  it('clamps hours above 23', () => {
    expect(hhmmToMinutes('25:00')).toBe(23 * 60);
  });

  it('clamps minutes above 59', () => {
    expect(hhmmToMinutes('01:99')).toBe(1 * 60 + 59);
  });

  it('round-trips with timeBlockMinutesToHHMM', () => {
    expect(hhmmToMinutes(timeBlockMinutesToHHMM(540))).toBe(540);
    expect(hhmmToMinutes(timeBlockMinutesToHHMM(75))).toBe(75);
  });
});

// ─── filterPrivacyRows ───────────────────────────────────────────────────────

describe('filterPrivacyRows', () => {
  const rows = [
    { name: 'Slack', enabled: true },
    { name: 'Notion', enabled: false },
    { name: 'GitHub', enabled: true },
  ];
  const textOf = (r: any) => r.name;

  it('returns all rows when query is empty and filter is "all"', () => {
    expect(filterPrivacyRows(rows, '', 'all', textOf)).toHaveLength(3);
  });

  it('filters by "on" to show only enabled rows', () => {
    const result = filterPrivacyRows(rows, '', 'on', textOf);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.enabled)).toBe(true);
  });

  it('filters by "off" to show only disabled rows', () => {
    const result = filterPrivacyRows(rows, '', 'off', textOf);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Notion');
  });

  it('filters by search query (case-insensitive)', () => {
    const result = filterPrivacyRows(rows, 'SLACK', 'all', textOf);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Slack');
  });

  it('combines search + filter', () => {
    // "git" matches "GitHub" which is enabled
    const result = filterPrivacyRows(rows, 'git', 'on', textOf);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('GitHub');
  });

  it('returns empty array when nothing matches', () => {
    expect(filterPrivacyRows(rows, 'zzznoexist', 'all', textOf)).toHaveLength(0);
  });
});

// ─── normalizePrivacyFromSettings ────────────────────────────────────────────

describe('normalizePrivacyFromSettings', () => {
  it('returns defaults when called with null', () => {
    const result = normalizePrivacyFromSettings(null);
    expect(Array.isArray(result.excludedApps)).toBe(true);
    expect(Array.isArray(result.excludedSites)).toBe(true);
    expect(result.paymentScreens).toBeDefined();
    expect(result.incognito).toBeDefined();
    expect(Array.isArray(result.timeBlocks)).toBe(true);
  });

  it('returns defaults when called with empty object', () => {
    const result = normalizePrivacyFromSettings({});
    expect(Array.isArray(result.excludedApps)).toBe(true);
    expect(result.paymentScreens.enabled).toBe(true);
    expect(result.incognito.enabled).toBe(true);
  });

  it('preserves existing excludedApps array', () => {
    const sec = {
      excludedApps: [{ id: 'my-app', name: 'MyApp', icon: '🔖', enabled: true }],
    };
    const result = normalizePrivacyFromSettings(sec);
    expect(result.excludedApps).toHaveLength(1);
    expect(result.excludedApps[0]?.name).toBe('MyApp');
  });

  it('promotes legacy single-app to array', () => {
    const sec = { app: 'LegacyApp', enabled: true };
    const result = normalizePrivacyFromSettings(sec);
    expect(result.excludedApps).toHaveLength(1);
    expect(result.excludedApps[0]?.name).toBe('LegacyApp');
    expect(result.excludedApps[0]?.id).toBe('legacy-app');
  });

  it('normalizes site host to lowercase and strips protocol', () => {
    const sec = {
      excludedSites: [{ id: 's1', host: 'https://Example.COM/path', enabled: true }],
    };
    const result = normalizePrivacyFromSettings(sec);
    expect(result.excludedSites[0]?.host).toBe('example.com');
  });

  it('normalizes timeBlocks clamping out-of-range minutes', () => {
    const sec = {
      timeBlocks: [{ id: 'tb-1', startMinute: -100, endMinute: 9999, days: 0x7F, enabled: true }],
    };
    const result = normalizePrivacyFromSettings(sec);
    expect(result.timeBlocks[0]?.startMinute).toBe(0);
    expect(result.timeBlocks[0]?.endMinute).toBe(1439);
  });

  it('defaults paymentScreens.enabled to true when missing', () => {
    const result = normalizePrivacyFromSettings({});
    expect(result.paymentScreens.enabled).toBe(true);
    expect(result.paymentScreens.detectCardPattern).toBe(true);
  });

  it('reads explicit paymentScreens.enabled = false', () => {
    const sec = { paymentScreens: { enabled: false, detectCardPattern: false, domains: [] } };
    const result = normalizePrivacyFromSettings(sec);
    expect(result.paymentScreens.enabled).toBe(false);
    expect(result.paymentScreens.detectCardPattern).toBe(false);
  });

  it('defaults incognito browser flags to true', () => {
    const result = normalizePrivacyFromSettings({});
    expect(result.incognito.browsers.safari).toBe(true);
    expect(result.incognito.browsers.chrome).toBe(true);
    expect(result.incognito.browsers.firefox).toBe(true);
  });
});

// ─── newQuietBlock ───────────────────────────────────────────────────────────

describe('newQuietBlock', () => {
  it('returns a block with all required fields', () => {
    const block = newQuietBlock();
    expect(typeof block.id).toBe('string');
    expect(block.id.startsWith('tb-')).toBe(true);
    expect(typeof block.label).toBe('string');
    expect(typeof block.startMinute).toBe('number');
    expect(typeof block.endMinute).toBe('number');
    expect(block.enabled).toBe(true);
    expect(block.days).toBe(0x7F);
  });

  it('generates a unique id each call', () => {
    const a = newQuietBlock();
    const b = newQuietBlock();
    expect(a.id).not.toBe(b.id);
  });

  it('defaults startMinute to 22:00 (1320) and endMinute to 07:00 (420)', () => {
    const block = newQuietBlock();
    expect(block.startMinute).toBe(22 * 60);
    expect(block.endMinute).toBe(7 * 60);
  });
});
