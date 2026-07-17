import { NextRequest } from 'next/server';
import { addToWaitlist, isValidWaitlistEmail } from '@/lib/waitlist';
import { assertWaitlistWebhook, lpCorsHeaders } from '@/lib/waitlist-auth';

export async function OPTIONS(req: NextRequest) {
  return new Response(null, { status: 204, headers: lpCorsHeaders(req) });
}

export async function POST(req: NextRequest) {
  const cors = lpCorsHeaders(req);
  const denied = assertWaitlistWebhook(req);
  if (denied) {
    Object.entries(cors).forEach(([k, v]) => denied.headers.set(k, v));
    return denied;
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400, headers: cors });
  }

  const email = String(body.email || '').trim();
  if (!isValidWaitlistEmail(email)) {
    return Response.json({ ok: false, error: 'invalid_email' }, { status: 400, headers: cors });
  }

  const ref = typeof body.ref === 'string' ? body.ref.trim() : undefined;

  try {
    const { row, duplicate } = await addToWaitlist(email, ref);
    const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
    return Response.json({
      ok: true,
      duplicate,
      email: row.email,
      status: row.status,
      createdAt: row.createdAt,
      refCode: row.refCode,
      statusUrl: row.refCode ? `${base}/waitlist/${row.refCode}` : null,
    }, { headers: cors });
  } catch (err) {
    console.error('[waitlist]', err);
    return Response.json({ ok: false, error: 'server_error' }, { status: 500, headers: cors });
  }
}
