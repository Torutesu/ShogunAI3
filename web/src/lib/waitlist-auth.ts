import { NextRequest } from 'next/server';
import { secureCompare } from '@/lib/secure-compare';

/**
 * Two ways into POST /api/waitlist:
 *
 * 1. Server-to-server webhook — x-waitlist-webhook-secret header, compared
 *    in constant time. The secret must NEVER ship in browser code; this
 *    path skips rate limiting because the caller is ours.
 * 2. Browser, directly from the LP — no secret. Gated by Origin allowlist
 *    + per-IP rate limit + optional Turnstile instead. Origin is not
 *    spoofable from a browser, which is the actor that matters here;
 *    curl bypassing it still hits the rate limit and Turnstile.
 */

export function allowedLpOrigins(): string[] {
  return [
    'https://syogun.com',
    'https://www.syogun.com',
    'https://shogunai.lovable.app',
    process.env.NEXT_PUBLIC_LP_ORIGIN,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NODE_ENV !== 'production' ? 'http://localhost:3001' : undefined,
  ].filter(Boolean) as string[];
}

export function isAllowedLpOrigin(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  return !!origin && allowedLpOrigins().includes(origin);
}

export function hasWebhookSecretHeader(req: NextRequest): boolean {
  return req.headers.get('x-waitlist-webhook-secret') !== null;
}

export function assertWaitlistWebhook(req: NextRequest): Response | null {
  const secret = process.env.WAITLIST_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const header = req.headers.get('x-waitlist-webhook-secret');
  if (!header || !secureCompare(header, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export function lpCorsHeaders(req: NextRequest): HeadersInit {
  const origin = req.headers.get('origin');
  if (origin && allowedLpOrigins().includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
  }
  return {};
}
