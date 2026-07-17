import { NextRequest, after } from 'next/server';
import { isValidStatusToken, submitProfile } from '@/lib/referral';
import { LIMITS, rateLimit, rateLimitedResponse } from '@/lib/rate-limit';
import { clientIpHash } from '@/lib/request-meta';
import { notifyReferrerProgress } from '@/lib/notifications';
import { readJsonBody } from '@/lib/json-body';

// Called same-origin from the status page. The bearer is the PRIVATE status
// token — never the public ref code, which anyone who saw a share link holds.
export async function POST(req: NextRequest) {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const token = typeof body.code === 'string' ? body.code.trim() : '';
  if (!isValidStatusToken(token)) {
    return Response.json({ ok: false, error: 'invalid_code' }, { status: 400 });
  }

  const { limit, windowSeconds } = LIMITS.profile;
  const rl = await rateLimit(`profile:${clientIpHash(req)}`, limit, windowSeconds);
  if (!rl.allowed) return rateLimitedResponse();

  try {
    const result = await submitProfile(token, {
      timeSink: body.timeSink,
      companyRole: body.companyRole,
      why: body.why,
    });
    if (!result) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    // Their referrer's qualified count just moved — milestone emails go out
    // after the response is flushed, never on the request's critical path.
    if (result.justCompleted && result.row.referredBy) {
      const referredBy = result.row.referredBy;
      after(() => notifyReferrerProgress(referredBy));
    }
    return Response.json({
      ok: true,
      formCompleted: Boolean(result.row.formCompletedAt),
    });
  } catch (err) {
    console.error('[waitlist/profile]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
