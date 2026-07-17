import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { assertAdmin } from '@/lib/admin-auth';

/**
 * Fraud review for reward fulfillment. The campaign accepts throwaway
 * emails at signup (by design), so enforcement happens here, before
 * rewards are granted: a referrer whose qualified invites collapse onto
 * one or two IP hashes is one person farming the ladder.
 */
export async function GET(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const db = getDb();
    const rows = await db.execute(sql`
      SELECT
        w.email                                   AS referrer_email,
        w.ref_code                                AS ref_code,
        count(r.id)::int                          AS qualified,
        count(DISTINCT r.signup_ip_hash)::int     AS distinct_ips,
        max(cnt.per_ip)::int                      AS max_from_one_ip
      FROM waitlist w
      JOIN waitlist r
        ON r.referred_by = w.ref_code
       AND r.form_completed_at IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS per_ip
        FROM waitlist x
        WHERE x.referred_by = w.ref_code
          AND x.form_completed_at IS NOT NULL
          AND x.signup_ip_hash IS NOT NULL
        GROUP BY x.signup_ip_hash
        ORDER BY count(*) DESC
        LIMIT 1
      ) cnt ON true
      GROUP BY w.id
      HAVING count(r.id) >= 3
      ORDER BY count(r.id) DESC
    `);

    const list = (rows as unknown as Array<{
      referrer_email: string;
      ref_code: string;
      qualified: number;
      distinct_ips: number;
      max_from_one_ip: number | null;
    }>).map((r) => ({
      referrerEmail: r.referrer_email,
      refCode: r.ref_code,
      qualified: Number(r.qualified),
      distinctIps: Number(r.distinct_ips),
      maxFromOneIp: Number(r.max_from_one_ip) || 0,
      suspicious: Number(r.distinct_ips) > 0 && Number(r.distinct_ips) * 3 < Number(r.qualified),
    }));

    return Response.json({ ok: true, referrers: list });
  } catch (err) {
    console.error('[admin/waitlist/fraud]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
