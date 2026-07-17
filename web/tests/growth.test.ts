import { describe, it, expect } from 'vitest';
import type { NextRequest } from 'next/server';
import { milestoneFor } from '../src/lib/notifications';
import { clientIp, requestCountry } from '../src/lib/request-meta';
import { csvEscape } from '../src/lib/csv';

function fakeReq(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

describe('milestoneFor', () => {
  it('fires exactly at the gamification points', () => {
    expect(milestoneFor(1)).toBe('invite_1');
    expect(milestoneFor(2)).toBe('near_tier_3');
    expect(milestoneFor(3)).toBe('tier_3');
    expect(milestoneFor(9)).toBe('near_tier_10');
    expect(milestoneFor(10)).toBe('tier_10');
    expect(milestoneFor(29)).toBe('near_tier_30');
    expect(milestoneFor(30)).toBe('tier_30');
  });

  it('stays quiet everywhere else', () => {
    for (const n of [0, 4, 5, 8, 11, 15, 28, 31, 100]) {
      expect(milestoneFor(n)).toBeNull();
    }
  });
});

describe('clientIp behind Cloudflare', () => {
  it('prefers cf-connecting-ip over a client-spoofable XFF first hop', () => {
    const req = fakeReq({
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '6.6.6.6, 203.0.113.7',
    });
    expect(clientIp(req)).toBe('203.0.113.7');
  });
});

describe('csvEscape', () => {
  it('quotes separators, quotes, and newlines; passes plain values', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
  });
});

describe('requestCountry', () => {
  it('reads cf-ipcountry, falls back to vercel header', () => {
    expect(requestCountry(fakeReq({ 'cf-ipcountry': 'JP' }))).toBe('JP');
    expect(requestCountry(fakeReq({ 'x-vercel-ip-country': 'us' }))).toBe('US');
  });

  it('rejects unknown/invalid values', () => {
    expect(requestCountry(fakeReq({}))).toBeNull();
    expect(requestCountry(fakeReq({ 'cf-ipcountry': 'XX' }))).toBeNull();
    expect(requestCountry(fakeReq({ 'cf-ipcountry': 'T1' }))).toBeNull();
    expect(requestCountry(fakeReq({ 'cf-ipcountry': 'evil<script>' }))).toBeNull();
  });
});
