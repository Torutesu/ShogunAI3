import { describe, it, expect } from 'vitest';
import {
  homeFirstNameToken,
  computeHomeGreetingState,
  smartSnoozePresets,
  composerPlaceholderForLang,
} from './runtime';

// ─── homeFirstNameToken ───────────────────────────────────────────────────────

describe('homeFirstNameToken', () => {
  it('extracts the first word of a full name', () => {
    expect(homeFirstNameToken('John Doe')).toBe('John');
  });

  it('returns the whole string when there is only one word', () => {
    expect(homeFirstNameToken('Alice')).toBe('Alice');
  });

  it('returns empty string for empty input', () => {
    expect(homeFirstNameToken('')).toBe('');
  });

  it('returns empty string for null', () => {
    expect(homeFirstNameToken(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(homeFirstNameToken(undefined)).toBe('');
  });

  it('handles extra whitespace between words', () => {
    expect(homeFirstNameToken('  Bob   Smith  ')).toBe('Bob');
  });

  it('handles Japanese names (space-delimited)', () => {
    expect(homeFirstNameToken('田中 太郎')).toBe('田中');
  });
});

// ─── computeHomeGreetingState ─────────────────────────────────────────────────

describe('computeHomeGreetingState', () => {
  function makeDate(hour: number): Date {
    const d = new Date();
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  it('returns "Good morning" before noon (h=8)', () => {
    const state = computeHomeGreetingState(makeDate(8));
    expect(state.greetEn).toBe('Good morning');
    expect(state.greetJp).toBe('おはようございます');
  });

  it('returns "Good morning" at h=5 (boundary)', () => {
    const state = computeHomeGreetingState(makeDate(5));
    expect(state.greetEn).toBe('Good morning');
  });

  it('returns "Good afternoon" at h=12 (noon)', () => {
    const state = computeHomeGreetingState(makeDate(12));
    expect(state.greetEn).toBe('Good afternoon');
    expect(state.greetJp).toBe('こんにちは');
  });

  it('returns "Good afternoon" at h=16', () => {
    const state = computeHomeGreetingState(makeDate(16));
    expect(state.greetEn).toBe('Good afternoon');
  });

  it('returns "Good evening" at h=17 (boundary)', () => {
    const state = computeHomeGreetingState(makeDate(17));
    expect(state.greetEn).toBe('Good evening');
    expect(state.greetJp).toBe('こんばんは');
  });

  it('returns "Good evening" for late night (h=23)', () => {
    const state = computeHomeGreetingState(makeDate(23));
    expect(state.greetEn).toBe('Good evening');
    // Late night uses お疲れ様です
    expect(state.greetJp).toBe('お疲れ様です');
  });

  it('returns "Good evening" for h=0 (midnight)', () => {
    const state = computeHomeGreetingState(makeDate(0));
    expect(state.greetEn).toBe('Good evening');
  });

  it('falls back to new Date() when given a non-Date value', () => {
    // Just ensure it doesn't throw and returns the shape
    const state = computeHomeGreetingState('not a date');
    expect(state).toHaveProperty('greetEn');
    expect(state).toHaveProperty('greetJp');
    expect(state).toHaveProperty('dateEn');
    expect(state).toHaveProperty('dateJp');
    expect(state).toHaveProperty('dateBi');
  });

  it('returns non-empty date strings', () => {
    const state = computeHomeGreetingState(makeDate(10));
    expect(state.dateEn.length).toBeGreaterThan(0);
    expect(state.dateJp.length).toBeGreaterThan(0);
    expect(state.dateBi.length).toBeGreaterThan(0);
  });
});

// ─── smartSnoozePresets ───────────────────────────────────────────────────────

describe('smartSnoozePresets', () => {
  it('returns tomorrowMorning at 09:00 the next day', () => {
    const now = new Date('2024-06-12T10:00:00'); // Wednesday
    const { tomorrowMorning } = smartSnoozePresets(now);
    const t = new Date(tomorrowMorning);
    expect(t.getFullYear()).toBe(2024);
    expect(t.getMonth()).toBe(5); // June (0-indexed)
    expect(t.getDate()).toBe(13);
    expect(t.getHours()).toBe(9);
    expect(t.getMinutes()).toBe(0);
  });

  it('returns nextMondayMorning at 09:00 on the following Monday', () => {
    const now = new Date('2024-06-12T10:00:00'); // Wednesday
    const { nextMondayMorning } = smartSnoozePresets(now);
    const t = new Date(nextMondayMorning);
    expect(t.getDay()).toBe(1); // Monday
    expect(t.getHours()).toBe(9);
    expect(t.getMinutes()).toBe(0);
    expect(t.getDate()).toBe(17); // next Monday from June 12
  });

  it('adds exactly 7 days when today is Monday', () => {
    const now = new Date('2024-06-10T10:00:00'); // Monday
    const { nextMondayMorning } = smartSnoozePresets(now);
    const t = new Date(nextMondayMorning);
    expect(t.getDay()).toBe(1);
    expect(t.getDate()).toBe(17); // 7 days ahead
  });

  it('nextMondayMorning is always a Monday (Sunday)', () => {
    const now = new Date('2024-06-16T10:00:00'); // Sunday
    const { nextMondayMorning } = smartSnoozePresets(now);
    const t = new Date(nextMondayMorning);
    expect(t.getDay()).toBe(1);
  });

  it('tomorrowMorning is always after now', () => {
    const now = new Date();
    const { tomorrowMorning } = smartSnoozePresets(now);
    expect(tomorrowMorning).toBeGreaterThan(now.getTime());
  });

  it('nextMondayMorning is always after tomorrowMorning on a Friday', () => {
    const now = new Date('2024-06-14T10:00:00'); // Friday
    const { tomorrowMorning, nextMondayMorning } = smartSnoozePresets(now);
    expect(nextMondayMorning).toBeGreaterThan(tomorrowMorning);
  });
});

// ─── composerPlaceholderForLang ──────────────────────────────────────────────

describe('composerPlaceholderForLang', () => {
  it('returns English for "en"', () => {
    expect(composerPlaceholderForLang('en')).toBe('How can I help you today?');
  });

  it('returns Japanese for "jp"', () => {
    expect(composerPlaceholderForLang('jp')).toBe('本日はどのようなお手伝いをさせていただけますか？');
  });

  it('returns bilingual for "bi"', () => {
    const result = composerPlaceholderForLang('bi');
    expect(result).toContain('How can I help you today?');
    expect(result).toContain('本日はどのようなお手伝いをさせていただけますか？');
  });

  it('defaults to English for unknown lang', () => {
    expect(composerPlaceholderForLang('de')).toBe('How can I help you today?');
  });

  it('defaults to English for null', () => {
    expect(composerPlaceholderForLang(null)).toBe('How can I help you today?');
  });

  it('defaults to English for undefined', () => {
    expect(composerPlaceholderForLang(undefined)).toBe('How can I help you today?');
  });
});
