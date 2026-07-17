import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { secureCompare } from '../src/lib/secure-compare';
import { clientIp, hashIp, truncatedUserAgent } from '../src/lib/request-meta';
import { windowStartFor } from '../src/lib/rate-limit';
import { verifyTurnstile } from '../src/lib/turnstile';
import { allowedLpOrigins, isAllowedLpOrigin } from '../src/lib/waitlist-auth';
import { generateStatusToken, isValidStatusToken, isValidRefCode } from '../src/lib/referral';

function fakeReq(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe('secureCompare', () => {
  it('matches equal strings, rejects different or truncated ones', () => {
    expect(secureCompare('secret-value', 'secret-value')).toBe(true);
    expect(secureCompare('secret-value', 'secret-valuf')).toBe(false);
    expect(secureCompare('secret-value', 'secret')).toBe(false);
    expect(secureCompare('', '')).toBe(true);
  });
});

describe('clientIp', () => {
  it('takes the first x-forwarded-for hop', () => {
    expect(clientIp(fakeReq({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });
  it('falls back to x-real-ip, then unknown', () => {
    expect(clientIp(fakeReq({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2');
    expect(clientIp(fakeReq({}))).toBe('unknown');
  });
});

describe('hashIp', () => {
  it('is deterministic, salted, and never stores the raw IP', () => {
    const h = hashIp('203.0.113.7');
    expect(h).toHaveLength(32);
    expect(h).toBe(hashIp('203.0.113.7'));
    expect(h).not.toContain('203');
    expect(hashIp('203.0.113.8')).not.toBe(h);
  });
});

describe('truncatedUserAgent', () => {
  it('caps length and nulls empties', () => {
    expect(truncatedUserAgent(fakeReq({ 'user-agent': 'x'.repeat(1000) }))).toHaveLength(256);
    expect(truncatedUserAgent(fakeReq({}))).toBeNull();
  });
});

describe('windowStartFor', () => {
  it('buckets timestamps into fixed windows', () => {
    const hour = 3600;
    const t = Date.UTC(2026, 6, 17, 10, 42, 13);
    expect(windowStartFor(t, hour).toISOString()).toBe('2026-07-17T10:00:00.000Z');
    expect(windowStartFor(t, hour)).toEqual(windowStartFor(t + 17 * 60 * 1000, hour));
    expect(windowStartFor(t, hour)).not.toEqual(windowStartFor(t + 18 * 60 * 1000, hour));
  });
});

describe('verifyTurnstile', () => {
  const prev = process.env.TURNSTILE_SECRET_KEY;
  afterEach(() => {
    if (prev === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = prev;
  });

  it('passes when not configured', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await verifyTurnstile(undefined)).toBe(true);
    expect(await verifyTurnstile('anything')).toBe(true);
  });

  it('fails closed on missing token when configured', async () => {
    process.env.TURNSTILE_SECRET_KEY = 'test-secret';
    expect(await verifyTurnstile(undefined)).toBe(false);
    expect(await verifyTurnstile('')).toBe(false);
    expect(await verifyTurnstile(42)).toBe(false);
  });
});

describe('origin allowlist', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_LP_ORIGIN;
    delete process.env.NEXT_PUBLIC_APP_URL;
  });

  it('includes the production LP domains', () => {
    const origins = allowedLpOrigins();
    expect(origins).toContain('https://syogun.com');
    expect(origins).toContain('https://shogunai.lovable.app');
  });

  it('rejects missing or foreign origins', () => {
    expect(isAllowedLpOrigin(fakeReq({}))).toBe(false);
    expect(isAllowedLpOrigin(fakeReq({ origin: 'https://evil.example' }))).toBe(false);
    expect(isAllowedLpOrigin(fakeReq({ origin: 'https://syogun.com' }))).toBe(true);
  });
});

describe('token separation', () => {
  it('status tokens are long, valid, and distinct from ref codes', () => {
    const token = generateStatusToken();
    expect(token).toHaveLength(32);
    expect(isValidStatusToken(token)).toBe(true);
    // A public ref code must never pass as a status token.
    expect(isValidStatusToken('abc123def4')).toBe(false);
    expect(isValidRefCode(token)).toBe(false);
  });
});
