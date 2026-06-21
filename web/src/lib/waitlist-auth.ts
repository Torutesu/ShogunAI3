import { NextRequest } from 'next/server';
import { getAllowedLpOrigins, getRequiredEnv } from '@/lib/web-config';

export function assertWaitlistWebhook(req: NextRequest): Response | null {
  const secret = getRequiredEnv('WAITLIST_WEBHOOK_SECRET');
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
  const allowed = getAllowedLpOrigins();

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
