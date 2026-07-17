import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { assertAdmin } from '@/lib/admin-auth';

/**
 * Free server-side campaign dashboard. Everything here comes from signup
 * rows — no analytics vendor, no ad-blocker blind spots, no consent
 * dependency. Country arrives via the Cloudflare/Vercel edge header.
 *
 * Remember the KPI rule: `formCompleted` is the real number, `raw` is the
 * vanity number.
 */
export async function GET(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const db = getDb();

    const [totalsRows, byDayRows, byCountryRows, byUtmRows, tierRows] = await Promise.all([
      db.execute(sql`
        SELECT
          count(*)::int                                                AS raw,
          count(*) FILTER (WHERE form_completed_at IS NOT NULL)::int   AS form_completed,
          count(*) FILTER (WHERE referred_by IS NOT NULL)::int         AS referred,
          count(*) FILTER (WHERE email_opt_out_at IS NOT NULL)::int    AS opted_out
        FROM waitlist
      `),
      db.execute(sql`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               count(*)::int AS signups,
               count(*) FILTER (WHERE form_completed_at IS NOT NULL)::int AS completed,
               count(*) FILTER (WHERE referred_by IS NOT NULL)::int AS referred
        FROM waitlist
        WHERE created_at > now() - interval '30 days'
        GROUP BY 1 ORDER BY 1
      `),
      db.execute(sql`
        SELECT COALESCE(signup_country, 'unknown') AS country, count(*)::int AS signups
        FROM waitlist GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      `),
      db.execute(sql`
        SELECT COALESCE(utm_source, 'direct') AS source, count(*)::int AS signups,
               count(*) FILTER (WHERE form_completed_at IS NOT NULL)::int AS completed
        FROM waitlist GROUP BY 1 ORDER BY 2 DESC LIMIT 20
      `),
      db.execute(sql`
        SELECT
          count(*) FILTER (WHERE qualified >= 3)::int  AS reached_3,
          count(*) FILTER (WHERE qualified >= 10)::int AS reached_10,
          count(*) FILTER (WHERE qualified >= 30)::int AS reached_30
        FROM (
          SELECT referred_by, count(*)::int AS qualified
          FROM waitlist
          WHERE referred_by IS NOT NULL AND form_completed_at IS NOT NULL
          GROUP BY referred_by
        ) t
      `),
    ]);

    const totals = (totalsRows as unknown as Array<Record<string, number>>)[0] ?? {};
    const raw = Number(totals.raw) || 0;
    const referred = Number(totals.referred) || 0;

    return Response.json({
      ok: true,
      totals: {
        raw,
        formCompleted: Number(totals.form_completed) || 0,
        referred,
        optedOut: Number(totals.opted_out) || 0,
      },
      // Share of signups that arrived via a referral link. >0.5 means the
      // loop feeds itself.
      viralShare: raw > 0 ? Math.round((referred / raw) * 1000) / 1000 : 0,
      byDay: byDayRows,
      byCountry: byCountryRows,
      byUtmSource: byUtmRows,
      tiersReached: (tierRows as unknown as Array<Record<string, number>>)[0] ?? {},
    });
  } catch (err) {
    console.error('[admin/waitlist/stats]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
