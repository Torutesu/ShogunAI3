import { NextRequest } from 'next/server';
import { currentTier, findByRefCode, isValidRefCode, maskEmail, qualifiedReferralCount } from '@/lib/referral';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIpHash } from '@/lib/request-meta';
import { lpCorsHeaders } from '@/lib/waitlist-auth';

/**
 * Public context for a visitor arriving via a share link (?ref=CODE):
 * lets the LP render "ja*** saved you a place in line" instead of a
 * generic page. Exposes only what the sharer already broadcast by
 * sharing: a masked identity and their public referral standing. Never
 * the email, tokens, position, or answers.
 *
 * Invalid codes return valid:false with 200 — the LP renders the generic
 * hero and moves on; enumeration is pointless (60-bit codes) and rate
 * limited anyway.
 */
export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: lpCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const cors = {
    ...lpCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
  };

  const ref = req.nextUrl.searchParams.get('ref')?.trim() ?? '';
  if (!isValidRefCode(ref)) {
    return Response.json({ ok: true, valid: false }, { headers: cors });
  }

  const { limit, windowSeconds } = LIMITS.status;
  const rl = await rateLimit(`invite-context:${clientIpHash(req)}`, limit, windowSeconds);
  if (!rl.allowed) return rateLimitedResponse(cors);

  try {
    const row = await findByRefCode(ref);
    if (!row) {
      return Response.json({ ok: true, valid: false }, { headers: cors });
    }
    const qualified = await qualifiedReferralCount(ref);
    return Response.json({
      ok: true,
      valid: true,
      inviter: maskEmail(row.email),
      qualifiedReferrals: qualified,
      tier: currentTier(qualified),
    }, { headers: cors });
  } catch (err) {
    console.error('[waitlist/invite-context]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500, headers: cors });
  }
}
