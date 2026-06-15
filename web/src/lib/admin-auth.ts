import { NextRequest } from 'next/server';

export function assertAdmin(req: NextRequest): Response | null {
  const key = req.headers.get('x-admin-api-key');
  if (!key || key !== process.env.ADMIN_API_KEY) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  return null;
}
