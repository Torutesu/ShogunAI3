import { NextRequest } from 'next/server';
import { isValidStatusToken, submitProfile } from '@/lib/referral';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIpHash } from '@/lib/request-meta';

// Called same-origin from the status page. The bearer is the PRIVATE status
// token — never the public ref code, which anyone who saw a share link holds.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const token = typeof body.code === 'string' ? body.code.trim() : '';
  if (!isValidStatusToken(token)) {
    return Response.json({ ok: false, error: 'invalid_code' }, { status: 400 });
  }

  const { limit, windowSeconds } = LIMITS.profile;
  const rl = await rateLimit(`profile:${clientIpHash(req)}`, limit, windowSeconds);
  if (!rl.allowed) return rateLimitedResponse();

  try {
    const row = await submitProfile(token, {
      timeSink: body.timeSink,
      companyRole: body.companyRole,
      why: body.why,
    });
    if (!row) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({
      ok: true,
      formCompleted: Boolean(row.formCompletedAt),
    });
  } catch (err) {
    console.error('[waitlist/profile]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
