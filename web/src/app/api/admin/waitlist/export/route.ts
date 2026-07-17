import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { assertAdmin } from '@/lib/admin-auth';
import { csvEscape } from '@/lib/csv';

// Full export for launch-copy mining (the "why SHOGUN?" answers) and CRM
// import. Admin-only. CSV by default, ?format=json for tooling.

const COLUMNS = [
  'email', 'created_at', 'status', 'locale', 'signup_country',
  'utm_source', 'utm_medium', 'utm_campaign', 'referred_by',
  'answer_time_sink', 'answer_company_role', 'answer_why',
  'form_completed_at', 'email_opt_out_at',
] as const;

export async function GET(req: NextRequest) {
  const denied = assertAdmin(req);
  if (denied) return denied;

  try {
    const db = getDb();
    const rows = (await db.execute(sql`
      SELECT email, created_at, status, locale, signup_country,
             utm_source, utm_medium, utm_campaign, referred_by,
             answer_time_sink, answer_company_role, answer_why,
             form_completed_at, email_opt_out_at
      FROM waitlist
      ORDER BY created_at ASC
    `)) as unknown as Array<Record<string, unknown>>;

    if (req.nextUrl.searchParams.get('format') === 'json') {
      return Response.json({ ok: true, rows });
    }

    const header = COLUMNS.join(',');
    const lines = rows.map((r) => COLUMNS.map((c) => {
      const v = r[c];
      return csvEscape(v instanceof Date ? v.toISOString() : v);
    }).join(','));

    return new Response([header, ...lines].join('\n') + '\n', {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="waitlist-export.csv"',
      },
    });
  } catch (err) {
    console.error('[admin/waitlist/export]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
