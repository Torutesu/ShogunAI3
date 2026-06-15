import { NextRequest } from 'next/server';
import { assertAdmin } from '@/lib/admin-auth';
import { inviteNextPending, inviteWaitlistEmail, isValidWaitlistEmail } from '@/lib/waitlist';

export async function POST(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  const body = await req.json();
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';

  if (body.email) {
    const email = String(body.email).trim();
    if (!isValidWaitlistEmail(email)) {
      return Response.json({ ok: false, error: 'invalid_email' }, { status: 400 });
    }
    const invite = await inviteWaitlistEmail(email);
    return Response.json({
      ok: true,
      invites: [{
        email: invite.email,
        inviteUrl: `${base}/invite?token=${invite.token}`,
        expiresAt: invite.expiresAt,
      }],
    });
  }

  const limit = Number(body.limit ?? 1);
  const invites = await inviteNextPending(Number.isFinite(limit) ? limit : 1);

  return Response.json({ ok: true, invites });
}
