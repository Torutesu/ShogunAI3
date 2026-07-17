import { NextRequest } from 'next/server';
import { secureCompare } from '@/lib/secure-compare';

export function assertAdmin(req: NextRequest): Response | null {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }
  const key = req.headers.get('x-admin-api-key');
  if (!key || !secureCompare(key, expected)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
