import { sql } from 'drizzle-orm';
import { getDb } from '@/db';

/**
 * Fixed-window rate limiter backed by Postgres, so limits hold across
 * serverless instances. One upsert per check; stale windows are swept
 * opportunistically.
 *
 * Fails OPEN on database errors: losing a signup to a limiter outage is
 * worse than letting a burst through.
 */

export function windowStartFor(nowMs: number, windowSeconds: number): Date {
  const w = windowSeconds * 1000;
  return new Date(Math.floor(nowMs / w) * w);
}

export type RateLimitResult = { allowed: boolean; count: number };

export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const db = getDb();
    const windowStart = windowStartFor(Date.now(), windowSeconds).toISOString();
    const rows = await db.execute(sql`
      INSERT INTO rate_limits (key, window_start, count)
      VALUES (${key}, ${windowStart}::timestamptz, 1)
      ON CONFLICT (key, window_start)
      DO UPDATE SET count = rate_limits.count + 1
      RETURNING count
    `);
    const count = Number((rows as unknown as Array<{ count: number }>)[0]?.count) || 1;

    if (Math.random() < 0.01) {
      db.execute(sql`
        DELETE FROM rate_limits
        WHERE window_start < now() - make_interval(secs => ${windowSeconds * 2})
      `).catch(() => {});
    }

    return { allowed: count <= limit, count };
  } catch (err) {
    console.error('[rate-limit]', err);
    return { allowed: true, count: 0 };
  }
}

export function rateLimitedResponse(headers?: HeadersInit): Response {
  return Response.json(
    { ok: false, error: 'rate_limited' },
    { status: 429, headers: { 'Retry-After': '3600', ...headers } },
  );
}

// Per-IP, per-hour. Generous on purpose: NAT'd offices and event crowds
// share an IP, and killing legitimate viral bursts costs more than the
// junk a burst of fakes adds (fakes are filtered by form completion anyway).
export const LIMITS = {
  signup: { limit: envInt('RATE_LIMIT_SIGNUP', 30), windowSeconds: 3600 },
  profile: { limit: envInt('RATE_LIMIT_PROFILE', 120), windowSeconds: 3600 },
  status: { limit: envInt('RATE_LIMIT_STATUS', 300), windowSeconds: 3600 },
} as const;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
