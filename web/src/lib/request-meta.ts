import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

/**
 * Client IP behind the platform proxy (Vercel sets x-forwarded-for with the
 * client as the first hop). Never trusted for auth — only for rate limiting
 * and fraud signals, where a spoofed value costs the spoofer their own limit.
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]!.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Raw IPs are personal data under GDPR — we only ever store a keyed hash.
 * The salt lives server-side, so the stored value cannot be reversed or
 * correlated with other datasets.
 */
export function hashIp(ip: string): string {
  const salt = process.env.IP_HASH_SALT || 'shogun-dev-only-salt';
  return createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32);
}

export function clientIpHash(req: NextRequest): string {
  return hashIp(clientIp(req));
}

export function truncatedUserAgent(req: NextRequest): string | null {
  const ua = req.headers.get('user-agent')?.trim();
  if (!ua) return null;
  return ua.slice(0, 256);
}
