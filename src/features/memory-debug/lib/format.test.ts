import { describe, it, expect } from 'vitest';
import { msToLocal, msToRelative, humanBytes } from './format';

describe('msToLocal', () => {
  it('returns "—" for null', () => {
    expect(msToLocal(null)).toBe("—");
  });

  it('returns "—" for 0', () => {
    expect(msToLocal(0)).toBe("—");
  });

  it('returns "—" for undefined', () => {
    expect(msToLocal(undefined)).toBe("—");
  });

  it('returns a string for a valid ms timestamp', () => {
    const result = msToLocal(1700000000000);
    expect(typeof result).toBe('string');
    expect(result).not.toBe("—");
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns "—" for NaN-producing input', () => {
    // Number(NaN) produces NaN → new Date(NaN) is invalid
    expect(msToLocal(NaN)).toBe("—");
  });
});

describe('msToRelative', () => {
  it('returns "—" for null', () => {
    expect(msToRelative(null, 1700000000000)).toBe("—");
  });

  it('returns "just now" for sub-minute age', () => {
    expect(msToRelative(1699999995000, 1700000000000)).toBe("just now");
  });

  it('returns minutes for sub-hour age', () => {
    expect(msToRelative(1699999880000, 1700000000000)).toBe("2m ago");
  });

  it('returns hours for sub-day age', () => {
    expect(msToRelative(1699992800000, 1700000000000)).toBe("2h ago");
  });

  it('returns days for older age', () => {
    expect(msToRelative(1699740800000, 1700000000000)).toBe("3d ago");
  });
});

describe('humanBytes', () => {
  it('returns "0 B" for 0', () => {
    expect(humanBytes(0)).toBe("0 B");
  });

  it('returns "100 B" for 100', () => {
    expect(humanBytes(100)).toBe("100 B");
  });

  it('returns "1.0 KB" for 1024', () => {
    expect(humanBytes(1024)).toBe("1.0 KB");
  });

  it('returns "1.0 MB" for 1024 * 1024', () => {
    expect(humanBytes(1024 * 1024)).toBe("1.0 MB");
  });

  it('returns "1.0 GB" for 1024^3', () => {
    expect(humanBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it('returns "0 B" for null', () => {
    expect(humanBytes(null)).toBe("0 B");
  });

  it('returns "0 B" for undefined', () => {
    expect(humanBytes(undefined)).toBe("0 B");
  });
});
