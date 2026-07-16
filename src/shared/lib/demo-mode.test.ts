import { describe, it, expect } from 'vitest';
import { computeDemoDataEnabled } from './demo-mode';

describe('computeDemoDataEnabled', () => {
  it('is off for a production build (no DEV, no flag)', () => {
    expect(computeDemoDataEnabled({ DEV: false, PROD: true })).toBe(false);
    expect(computeDemoDataEnabled({})).toBe(false);
    expect(computeDemoDataEnabled(null)).toBe(false);
    expect(computeDemoDataEnabled(undefined)).toBe(false);
  });

  it('is on in dev', () => {
    expect(computeDemoDataEnabled({ DEV: true })).toBe(true);
  });

  it('honors an explicit VITE_SHOGUN_DEMO opt-in regardless of DEV', () => {
    expect(computeDemoDataEnabled({ DEV: false, VITE_SHOGUN_DEMO: '1' })).toBe(true);
    expect(computeDemoDataEnabled({ DEV: false, VITE_SHOGUN_DEMO: 'true' })).toBe(true);
    expect(computeDemoDataEnabled({ DEV: false, VITE_SHOGUN_DEMO: true })).toBe(true);
  });

  it('honors an explicit opt-out even in dev', () => {
    expect(computeDemoDataEnabled({ DEV: true, VITE_SHOGUN_DEMO: '0' })).toBe(false);
    expect(computeDemoDataEnabled({ DEV: true, VITE_SHOGUN_DEMO: 'false' })).toBe(false);
  });
});
