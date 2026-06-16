import { NextRequest } from 'next/server';

export function assertWaitlistWebhook(req: NextRequest): Response | null {
  const secret = process.env.WAITLIST_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const header = req.headers.get('x-waitlist-webhook-secret');
  if (!header || header !== secret) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

export function lpCorsHeaders(req: NextRequest): HeadersInit {
  const allowed = [
    'https://shogunai.lovable.app',
    process.env.NEXT_PUBLIC_LP_ORIGIN,
  ].filter(Boolean) as string[];

  const origin = req.headers.get('origin');
  if (origin && allowed.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-waitlist-webhook-secret',
    };
  }
  return {};
}
