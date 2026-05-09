import { describe, it, expect } from 'vitest';
import { normalizeSeedMemoryAssembly } from './normalize-seed';

describe('normalizeSeedMemoryAssembly', () => {
  // ── null / undefined / empty ──────────────────────────────────────────────
  it('returns null for null', () => {
    expect(normalizeSeedMemoryAssembly(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(normalizeSeedMemoryAssembly(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeSeedMemoryAssembly('')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(normalizeSeedMemoryAssembly(42)).toBeNull();
  });

  // ── objects without a memoryAssemblyPreset or memoryAssemblyQuery ─────────
  it('returns null for an empty object', () => {
    expect(normalizeSeedMemoryAssembly({})).toBeNull();
  });

  it('returns null when no relevant keys are present', () => {
    expect(normalizeSeedMemoryAssembly({ text: 'hello', webSearch: true })).toBeNull();
  });

  it('returns null when memoryAssemblyQuery is present but empty/whitespace', () => {
    expect(normalizeSeedMemoryAssembly({ memoryAssemblyQuery: '   ' })).toBeNull();
  });

  // ── memoryAssemblyPreset path ─────────────────────────────────────────────
  it('returns normalized preset when memoryAssemblyPreset is present', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: '  samurai history  ', limit: 5, semantic: true },
    });
    expect(result).toEqual({ query: 'samurai history', limit: 5, semantic: true });
  });

  it('defaults limit to 12 when memoryAssemblyPreset.limit is absent', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'swords' },
    });
    expect(result?.limit).toBe(12);
  });

  it('defaults semantic to true when memoryAssemblyPreset.semantic is absent', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'swords' },
    });
    expect(result?.semantic).toBe(true);
  });

  it('respects semantic: false in memoryAssemblyPreset', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'swords', semantic: false },
    });
    expect(result?.semantic).toBe(false);
  });

  it('clamps limit to max 80 for memoryAssemblyPreset path', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'test', limit: 999 },
    });
    expect(result?.limit).toBe(80);
  });

  it('clamps limit to min 1 for memoryAssemblyPreset path', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'test', limit: 0 },
    });
    expect(result?.limit).toBe(1);
  });

  it('floors fractional limit for memoryAssemblyPreset path', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'test', limit: 7.9 },
    });
    expect(result?.limit).toBe(7);
  });

  it('trims and slices query to 480 chars for memoryAssemblyPreset path', () => {
    const longQuery = 'a'.repeat(600);
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: longQuery },
    });
    expect(result?.query.length).toBe(480);
  });

  it('falls back limit to 12 when memoryAssemblyPreset.limit is non-finite', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'x', limit: NaN },
    });
    expect(result?.limit).toBe(12);
  });

  // ── memoryAssemblyQuery (flat) path ───────────────────────────────────────
  it('returns normalized preset for flat memoryAssemblyQuery', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyQuery: '  ninja tactics  ',
      memoryAssemblyLimit: 8,
      memoryAssemblySemantic: false,
    });
    expect(result).toEqual({ query: 'ninja tactics', limit: 8, semantic: false });
  });

  it('defaults limit to 12 for flat memoryAssemblyQuery path', () => {
    const result = normalizeSeedMemoryAssembly({ memoryAssemblyQuery: 'something' });
    expect(result?.limit).toBe(12);
  });

  it('defaults semantic to true for flat memoryAssemblyQuery path', () => {
    const result = normalizeSeedMemoryAssembly({ memoryAssemblyQuery: 'something' });
    expect(result?.semantic).toBe(true);
  });

  it('clamps limit to max 80 for flat path', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyQuery: 'q',
      memoryAssemblyLimit: 200,
    });
    expect(result?.limit).toBe(80);
  });

  it('trims and slices query to 480 chars for flat path', () => {
    const longQuery = 'b'.repeat(600);
    const result = normalizeSeedMemoryAssembly({ memoryAssemblyQuery: longQuery });
    expect(result?.query.length).toBe(480);
  });

  // ── memoryAssemblyPreset takes priority over flat keys ────────────────────
  it('prefers memoryAssemblyPreset over memoryAssemblyQuery when both present', () => {
    const result = normalizeSeedMemoryAssembly({
      memoryAssemblyPreset: { query: 'from-preset', limit: 3, semantic: true },
      memoryAssemblyQuery: 'from-flat',
    });
    expect(result?.query).toBe('from-preset');
  });
});
