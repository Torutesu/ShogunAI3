import { NextRequest } from 'next/server';
import { addToWaitlist, isValidWaitlistEmail } from '@/lib/waitlist';
import {
  assertWaitlistWebhook,
  hasWebhookSecretHeader,
  isAllowedLpOrigin,
  lpCorsHeaders,
} from '@/lib/waitlist-auth';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIp, clientIpHash, truncatedUserAgent } from '@/lib/request-meta';
import { verifyTurnstile } from '@/lib/turnstile';

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: lpCorsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const cors = lpCorsHeaders(req);

  // Two entry paths — see waitlist-auth.ts. The webhook secret must never
  // appear in browser code; browser calls are gated by origin + rate limit
  // + optional Turnstile instead.
  const trusted = hasWebhookSecretHeader(req);
  if (trusted) {
    const denied = assertWaitlistWebhook(req);
    if (denied) {
      Object.entries(cors).forEach(([k, v]) => denied.headers.set(k, v));
      return denied;
    }
  } else if (!isAllowedLpOrigin(req)) {
    return Response.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: cors });
  }

  // Honeypot: real users never see the field. Report success, store nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return Response.json({ ok: true, duplicate: false }, { headers: cors });
  }

  const email = String(body.email || '').trim();
  if (!isValidWaitlistEmail(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400, headers: cors });
  }

  const ref = typeof body.ref === 'string' ? body.ref.trim().slice(0, 32) : undefined;
  const ipHash = clientIpHash(req);

  if (!trusted) {
    const human = await verifyTurnstile(body.turnstileToken, clientIp(req));
    if (!human) {
      return Response.json({ ok: false, error: 'bot_check_failed' }, { status: 403, headers: cors });
    }
    const { limit, windowSeconds } = LIMITS.signup;
    const rl = await rateLimit(`signup:${ipHash}`, limit, windowSeconds);
    if (!rl.allowed) return rateLimitedResponse(cors);
  }

  try {
    const { row, duplicate } = await addToWaitlist(email, ref, {
      ipHash,
      userAgent: truncatedUserAgent(req),
    });
    const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
    return Response.json({
      ok: true,
      duplicate,
      status: row.status,
      refCode: row.refCode,
      statusUrl: row.statusToken ? `${base}/waitlist/${row.statusToken}` : null,
    }, { headers: cors });
  } catch (err) {
    console.error('[waitlist]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500, headers: cors });
  }
}
