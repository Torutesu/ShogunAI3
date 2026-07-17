import { NextRequest } from 'next/server';
import { getReferralStatus, isValidStatusToken } from '@/lib/referral';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIpHash } from '@/lib/request-meta';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('code')?.trim() ?? '';
  if (!isValidStatusToken(token)) {
    return Response.json({ ok: false, error: 'invalid_code' }, { status: 400 });
  }

  const { limit, windowSeconds } = LIMITS.status;
  const rl = await rateLimit(`status:${clientIpHash(req)}`, limit, windowSeconds);
  if (!rl.allowed) return rateLimitedResponse();

  try {
    const status = await getReferralStatus(token);
    if (!status) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({ ok: true, ...status });
  } catch (err) {
    console.error('[waitlist/status]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
