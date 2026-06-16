import { NextRequest } from 'next/server';
import { assertAdmin } from '@/lib/admin-auth';
import { createInvite } from '@/lib/invites';

export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  const body = await req.json();
  const email = String(body.email || '').trim();
  if (!email.includes('@')) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
  }

  const invite = await createInvite(email);
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
  return Response.json({
    ok: true,
    inviteUrl: `${base}/invite?token=${invite.token}`,
    email: invite.email,
    expiresAt: invite.expiresAt,
  });
}
