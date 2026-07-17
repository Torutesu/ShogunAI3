import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { lpCorsHeaders } from '@/lib/waitlist-auth';

/**
 * Public social proof for the LP: "4,820 people from 37 countries are in
 * line." Aggregate-only, CDN-cached. Exact numbers — rounding is a
 * display decision, the frontend owns it.
 */
export const dynamic = 'force-dynamic';

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: lpCorsHeaders(req) });
}

export async function GET(req: NextRequest) {
  const cors = {
    ...lpCorsHeaders(req),
    'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=600',
  };

  try {
    const db = getDb();
    const rows = await db.execute(sql`
      SELECT count(*)::int AS total,
             count(DISTINCT signup_country)::int AS countries
      FROM waitlist
    `);
    const r = (rows as unknown as Array<{ total: number; countries: number }>)[0];
    return Response.json({
      ok: true,
      total: Number(r?.total) || 0,
      countries: Number(r?.countries) || 0,
    }, { headers: cors });
  } catch (err) {
    console.error('[waitlist/social-proof]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500, headers: cors });
  }
}
