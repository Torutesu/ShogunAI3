import { NextRequest, after } from 'next/server';
import { addToWaitlist, isValidWaitlistEmail } from '@/lib/waitlist';
import {
  assertWaitlistWebhook,
  hasWebhookSecretHeader,
  isAllowedLpOrigin,
  lpCorsHeaders,
} from '@/lib/waitlist-auth';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIp, clientIpHash, requestCountry, truncatedUserAgent } from '@/lib/request-meta';
import { verifyTurnstile } from '@/lib/turnstile';
import { notifySignup } from '@/lib/notifications';
import { readJsonBody } from '@/lib/json-body';

function utmParam(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().slice(0, 64);
  return cleaned || null;
}

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

  const parsed = await readJsonBody(req);
  if (!parsed.ok) {
    Object.entries(cors).forEach(([k, v]) => parsed.response.headers.set(k, String(v)));
    return parsed.response;
  }
  const body = parsed.body;

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

  const locale = body.lang === 'ja' ? 'ja'
    : body.lang === 'en' ? 'en'
    : req.headers.get('accept-language')?.startsWith('ja') ? 'ja' : 'en';

  try {
    const { row, duplicate } = await addToWaitlist(email, ref, {
      ipHash,
      userAgent: truncatedUserAgent(req),
      locale,
      country: requestCountry(req),
      utmSource: utmParam(body.utm_source),
      utmMedium: utmParam(body.utm_medium),
      utmCampaign: utmParam(body.utm_campaign),
    });
    if (!duplicate) {
      after(() => notifySignup(row));
    }
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
