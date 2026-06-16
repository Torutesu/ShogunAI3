import { describe, it, expect } from 'vitest';

function toDate(unix: number | null | undefined): Date | null {
  if (unix == null) return null;
  return new Date(unix * 1000);
}

describe('webhook helpers', () => {
  it('converts unix timestamps to Date', () => {
    expect(toDate(1_700_000_000)?.toISOString()).toBe(new Date(1_700_000_000_000).toISOString());
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
  });
});
