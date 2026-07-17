import { createHmac } from 'crypto';
import { NextRequest } from 'next/server';

/**
 * Client IP behind the platform proxy. Cloudflare's cf-connecting-ip comes
 * first: behind Cloudflare the FIRST x-forwarded-for hop is client-supplied
 * (Cloudflare appends to an existing header rather than replacing it), so
 * trusting XFF there would let callers spoof their way around rate limits.
 * Vercel-only deployments fall through to XFF, which Vercel does control.
 * Never used for auth — only rate limiting and fraud signals.
 */
export function clientIp(req: NextRequest): string {
  const cf = req.headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]!.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Country code from the edge, free: Cloudflare sets cf-ipcountry on every
 * proxied request, Vercel sets x-vercel-ip-country. Server-side, so it works
 * with ad blockers on and no analytics consent needed (it's an aggregate
 * operations signal, not a tracking identifier).
 */
export function requestCountry(req: NextRequest): string | null {
  const raw = (req.headers.get('cf-ipcountry') || req.headers.get('x-vercel-ip-country') || '')
    .trim().toUpperCase();
  return /^[A-Z]{2}$/.test(raw) && raw !== 'XX' ? raw : null;
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
