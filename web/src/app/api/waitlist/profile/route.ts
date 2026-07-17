import { NextRequest } from 'next/server';
import { isValidRefCode, submitProfile } from '@/lib/referral';

// Called same-origin from the status page. The ref code is the bearer:
// unguessable, scoped to one waitlist row, grants nothing beyond it.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!isValidRefCode(code)) {
    return Response.json({ ok: false, error: 'invalid_code' }, { status: 400 });
  }

  try {
    const row = await submitProfile(code, {
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
