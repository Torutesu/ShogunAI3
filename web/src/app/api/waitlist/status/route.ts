import { NextRequest } from 'next/server';
import { getReferralStatus, isValidRefCode } from '@/lib/referral';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')?.trim() ?? '';
  if (!isValidRefCode(code)) {
    return Response.json({ ok: false, error: 'invalid_code' }, { status: 400 });
  }

  try {
    const status = await getReferralStatus(code);
    if (!status) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return Response.json({ ok: true, ...status });
  } catch (err) {
    console.error('[waitlist/status]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
