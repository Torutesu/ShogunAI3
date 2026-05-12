import { describe, it, expect } from 'vitest';
import {
  unwrapExecutePayload,
  readSectionValue,
  normalizeEmbedBackfillBatch,
  normalizeEmbedBackfillDelayMs,
  isProfilePhotoDataUrlSetting,
  formatBytes,
} from './utils';

// ─── unwrapExecutePayload ─────────────────────────────────────────────────────

describe('unwrapExecutePayload', () => {
  it('returns null for null input', () => {
    expect(unwrapExecutePayload(null)).toBeNull();
  });

  it('returns null for missing data field', () => {
    expect(unwrapExecutePayload({ ok: true })).toBeNull();
  });

  it('returns nested data.data when it is an object', () => {
    const result = unwrapExecutePayload({ data: { data: { count: 5 } } });
    expect(result).toEqual({ count: 5 });
  });

  it('returns data directly when data.data is absent', () => {
    const result = unwrapExecutePayload({ data: { count: 5 } });
    expect(result).toEqual({ count: 5 });
  });

  it('returns data.data only when it is a non-null object (not primitive)', () => {
    // data.data = null → falls through to return d
    const result = unwrapExecutePayload({ data: { data: null, count: 5 } });
    expect(result).toEqual({ data: null, count: 5 });
  });
});

// ─── readSectionValue ─────────────────────────────────────────────────────────

describe('readSectionValue', () => {
  it('returns undefined for null sections', () => {
    expect(readSectionValue(null, 'chat.instructions')).toBeUndefined();
  });

  it('reads a direct string value', () => {
    expect(readSectionValue({ 'chat.instructions': 'Hello' }, 'chat.instructions')).toBe('Hello');
  });

  it('reads a value-wrapped object', () => {
    expect(readSectionValue({ 'chat.instructions': { value: 'Hi' } }, 'chat.instructions')).toBe('Hi');
  });

  it('returns empty string for value: null wrapper', () => {
    expect(readSectionValue({ 'chat.instructions': { value: null } }, 'chat.instructions')).toBe('');
  });

  it('reads nested object via dotted key', () => {
    const sections = { chat: { instructions: 'nested' } };
    expect(readSectionValue(sections, 'chat.instructions')).toBe('nested');
  });

  it('reads nested value-wrapped object', () => {
    const sections = { chat: { instructions: { value: 'nested-wrapped' } } };
    expect(readSectionValue(sections, 'chat.instructions')).toBe('nested-wrapped');
  });

  it('returns undefined when nested path does not exist', () => {
    expect(readSectionValue({}, 'chat.instructions')).toBeUndefined();
  });
});

// ─── normalizeEmbedBackfillBatch ─────────────────────────────────────────────

describe('normalizeEmbedBackfillBatch', () => {
  const OPTS = [20, 40, 80, 120, 200];

  it('returns 40 for NaN input', () => {
    expect(normalizeEmbedBackfillBatch('abc', OPTS)).toBe(40);
  });

  it('returns the exact value when it is in OPTS', () => {
    expect(normalizeEmbedBackfillBatch(80, OPTS)).toBe(80);
  });

  it('returns 40 for a valid number not in OPTS', () => {
    expect(normalizeEmbedBackfillBatch(50, OPTS)).toBe(40);
  });

  it('clamps below 20 to 20 and returns 20 if in OPTS', () => {
    expect(normalizeEmbedBackfillBatch(5, OPTS)).toBe(20);
  });

  it('clamps above 200 to 200 and returns 200 if in OPTS', () => {
    expect(normalizeEmbedBackfillBatch(999, OPTS)).toBe(200);
  });
});

// ─── normalizeEmbedBackfillDelayMs ───────────────────────────────────────────

describe('normalizeEmbedBackfillDelayMs', () => {
  const OPTS = [0, 500, 1000, 2000];

  it('returns 0 for NaN input', () => {
    expect(normalizeEmbedBackfillDelayMs('abc', OPTS)).toBe(0);
  });

  it('returns the exact value when it is in OPTS', () => {
    expect(normalizeEmbedBackfillDelayMs(1000, OPTS)).toBe(1000);
  });

  it('returns 0 for a valid number not in OPTS', () => {
    expect(normalizeEmbedBackfillDelayMs(750, OPTS)).toBe(0);
  });
});

// ─── isProfilePhotoDataUrlSetting ────────────────────────────────────────────

describe('isProfilePhotoDataUrlSetting', () => {
  it('returns true for a valid data:image/ URL', () => {
    expect(isProfilePhotoDataUrlSetting('data:image/png;base64,abc123')).toBe(true);
  });

  it('returns true for data:image/jpeg', () => {
    expect(isProfilePhotoDataUrlSetting('data:image/jpeg;base64,/9j/')).toBe(true);
  });

  it('returns false for empty string', () => {
    expect(isProfilePhotoDataUrlSetting('')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isProfilePhotoDataUrlSetting(null)).toBe(false);
  });

  it('returns false for a non-data URL string', () => {
    expect(isProfilePhotoDataUrlSetting('https://example.com/photo.png')).toBe(false);
  });

  it('is case-insensitive on the prefix', () => {
    expect(isProfilePhotoDataUrlSetting('DATA:IMAGE/PNG;base64,abc')).toBe(true);
  });
});

// ─── formatBytes ─────────────────────────────────────────────────────────────

describe('formatBytes', () => {
  it('returns "0 B" for 0', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('returns bytes for small values', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('returns "1.0 KB" for 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
  });

  it('returns "1.5 KB" for 1536', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('returns "1.0 MB" for 1024^2', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
  });

  it('returns "1.0 GB" for 1024^3', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});
