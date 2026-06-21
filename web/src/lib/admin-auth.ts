import { NextRequest } from 'next/server';
import { getRequiredEnv } from '@/lib/web-config';

export function assertAdmin(req: NextRequest): Response | null {
  const adminKey = getRequiredEnv('ADMIN_API_KEY');
  if (!adminKey) {
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const key = req.headers.get('x-admin-api-key');
  if (!key || key !== adminKey) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
