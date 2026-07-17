import { getLeaderboard } from '@/lib/referral';

// Public, emails masked. CDN-cached briefly to keep the query cheap under
// load (ISR revalidate would query the DB at build time — headers don't).
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const leaderboard = await getLeaderboard();
    return Response.json(
      { ok: true, leaderboard },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (err) {
    console.error('[waitlist/leaderboard]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
