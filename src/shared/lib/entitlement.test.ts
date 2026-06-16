import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_GRACE_MS,
  billingCacheFromSections,
  isEntitlementActive,
  isGraceValid,
  resolveEntitlement,
} from './entitlement';

describe('isEntitlementActive', () => {
  it('allows trialing and active', () => {
    expect(isEntitlementActive('trialing')).toBe(true);
    expect(isEntitlementActive('active')).toBe(true);
    expect(isEntitlementActive('none')).toBe(false);
  });
});

describe('isGraceValid', () => {
  it('accepts cache within 24h', () => {
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const checkedAt = new Date(now - ENTITLEMENT_GRACE_MS + 1000).toISOString();
    expect(isGraceValid(checkedAt, now)).toBe(true);
  });

  it('rejects stale cache', () => {
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const checkedAt = new Date(now - ENTITLEMENT_GRACE_MS - 1000).toISOString();
    expect(isGraceValid(checkedAt, now)).toBe(false);
  });
});

describe('resolveEntitlement', () => {
  it('prefers network over cache', () => {
    const result = resolveEntitlement({
      network: { status: 'trialing' },
      cache: { status: 'active', checkedAt: new Date().toISOString() },
    });
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('network');
  });

  it('uses cache when network unavailable', () => {
    const now = Date.parse('2026-06-15T12:00:00.000Z');
    const result = resolveEntitlement({
      network: null,
      cache: {
        status: 'active',
        checkedAt: new Date(now - 60_000).toISOString(),
      },
      nowMs: now,
    });
    expect(result.allowed).toBe(true);
    expect(result.source).toBe('cache');
  });

  it('blocks when network says none', () => {
    const result = resolveEntitlement({
      network: { status: 'none' },
      cache: {
        status: 'active',
        checkedAt: new Date().toISOString(),
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.source).toBe('network');
  });
});

describe('billingCacheFromSections', () => {
  it('reads billing section from settings', () => {
    const cache = billingCacheFromSections({
      billing: {
        status: 'trialing',
        checkedAt: '2026-06-15T00:00:00.000Z',
        trialEnd: '2026-06-22T00:00:00.000Z',
      },
    });
    expect(cache?.status).toBe('trialing');
    expect(cache?.trialEnd).toContain('2026-06-22');
  });
});
