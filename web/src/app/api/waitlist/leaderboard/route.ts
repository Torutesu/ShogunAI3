import { getLeaderboard } from '@/lib/referral';

// Public, emails masked. Cached briefly to keep the query cheap under load.
export const revalidate = 60;

export async function GET() {
  try {
    const leaderboard = await getLeaderboard();
    return Response.json({ ok: true, leaderboard });
  } catch (err) {
    console.error('[waitlist/leaderboard]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
