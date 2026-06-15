import { NextRequest } from 'next/server';
import { assertAdmin } from '@/lib/admin-auth';
import { listWaitlist, waitlistCounts, type WaitlistStatus } from '@/lib/waitlist';

export async function GET(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  const status = req.nextUrl.searchParams.get('status') as WaitlistStatus | null;
  const validStatuses = new Set(['pending', 'invited', 'converted']);
  const filter = status && validStatuses.has(status) ? status : undefined;

  const [entries, counts] = await Promise.all([
    listWaitlist(filter),
    waitlistCounts(),
  ]);

  return Response.json({
    ok: true,
    counts,
    entries: entries.map((e) => ({
      id: e.id,
      email: e.email,
      status: e.status,
      createdAt: e.createdAt,
      invitedAt: e.invitedAt,
    })),
  });
}
