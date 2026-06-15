import { NextRequest } from 'next/server';
import { validateInviteToken } from '@/lib/invites';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') || '';
  if (!token) {
    return Response.json({ ok: false, error: 'missing_token' }, { status: 400 });
  }

  try {
    const invite = await validateInviteToken(token);
    if (!invite) {
      return Response.json({ ok: false, error: 'invalid_or_expired' }, { status: 404 });
    }
    return Response.json({ ok: true, email: invite.email, expiresAt: invite.expiresAt });
  } catch (err) {
    console.error('[invites/validate]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
