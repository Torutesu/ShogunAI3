import { randomBytes } from 'crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { waitlist } from '@/db/schema';
import { normalizeEmail } from '@/lib/invites';

// Reward ladder. Rewards REPLACE each other — reaching a higher tier
// supersedes the lower one, they never stack.
export const REFERRAL_TIERS = [
  { threshold: 3, months: 1, en: '1 month free', ja: '1ヶ月無料' },
  { threshold: 10, months: 3, en: '3 months free', ja: '3ヶ月無料' },
  { threshold: 30, months: 6, en: '6 months free', ja: '6ヶ月無料' },
] as const;

export const TOP_REFERRER_COUNT = 10;
export const TOP_REFERRER_REWARD = { months: 12, en: '1 year free', ja: '1年無料' } as const;

export const TIME_SINK_OPTIONS = [
  'email_and_slack',
  'meetings_and_notes',
  'context_switching',
  'searching_for_things_i_saw',
  'scheduling_and_admin',
  'other',
] as const;

export function generateRefCode(): string {
  // Public — printed in share links. Short for URL aesthetics.
  return randomBytes(8).toString('base64url').slice(0, 10);
}

export function generateStatusToken(): string {
  // Private bearer for the status page and profile writes. The ref code is
  // public by design (it rides on shared links), so it must never be the
  // key that reads status or writes answers — this token is.
  return randomBytes(24).toString('base64url');
}

export function isValidRefCode(code: string): boolean {
  return /^[A-Za-z0-9_-]{6,16}$/.test(code);
}

export function isValidStatusToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(token);
}

export function currentTier(qualifiedReferrals: number) {
  let tier: (typeof REFERRAL_TIERS)[number] | null = null;
  for (const t of REFERRAL_TIERS) {
    if (qualifiedReferrals >= t.threshold) tier = t;
  }
  return tier;
}

export function nextTier(qualifiedReferrals: number) {
  for (const t of REFERRAL_TIERS) {
    if (qualifiedReferrals < t.threshold) return t;
  }
  return null;
}

export function answersCompleted(row: {
  answerTimeSink: string | null;
  answerCompanyRole: string | null;
  answerWhy: string | null;
}): number {
  let n = 0;
  if (row.answerTimeSink) n++;
  if (row.answerCompanyRole) n++;
  if (row.answerWhy) n++;
  return n;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2);
  const tld = domain?.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
  return `${visible}***@***${tld}`;
}

export async function findByRefCode(code: string) {
  const db = getDb();
  const [row] = await db.select().from(waitlist).where(eq(waitlist.refCode, code)).limit(1);
  return row ?? null;
}

export async function findByStatusToken(token: string) {
  const db = getDb();
  const [row] = await db.select().from(waitlist).where(eq(waitlist.statusToken, token)).limit(1);
  return row ?? null;
}

/**
 * Assign ref code + status token to a waitlist row that predates the
 * campaign. Retries on the (vanishingly rare) unique collision.
 */
export async function ensureTokens(email: string): Promise<{ refCode: string; statusToken: string }> {
  const db = getDb();
  const normalized = normalizeEmail(email);
  const [row] = await db.select().from(waitlist).where(eq(waitlist.email, normalized)).limit(1);
  if (!row) throw new Error('waitlist row not found');
  if (row.refCode && row.statusToken) {
    return { refCode: row.refCode, statusToken: row.statusToken };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const refCode = row.refCode ?? generateRefCode();
    const statusToken = row.statusToken ?? generateStatusToken();
    try {
      await db.update(waitlist).set({ refCode, statusToken }).where(eq(waitlist.id, row.id));
      return { refCode, statusToken };
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  throw new Error('unreachable');
}

/**
 * A referral only counts once the invited person completes the post-signup
 * form. No email verification by design — the form is the anti-junk filter.
 */
export async function qualifiedReferralCount(refCode: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(waitlist)
    .where(and(eq(waitlist.referredBy, refCode), isNotNull(waitlist.formCompletedAt)));
  return Number(row?.count) || 0;
}

/**
 * Queue position: ranked by qualified referrals, then answered questions,
 * then signup time. Answering a question genuinely moves you up.
 */
export async function queuePosition(refCode: string): Promise<{ position: number; total: number } | null> {
  const db = getDb();
  const rows = await db.execute(sql`
    WITH scored AS (
      SELECT
        w.ref_code,
        w.created_at,
        COALESCE(r.qualified, 0) AS qualified,
        (CASE WHEN w.answer_time_sink IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN w.answer_company_role IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN w.answer_why IS NOT NULL THEN 1 ELSE 0 END) AS answers
      FROM waitlist w
      LEFT JOIN (
        SELECT referred_by, count(*)::int AS qualified
        FROM waitlist
        WHERE referred_by IS NOT NULL AND form_completed_at IS NOT NULL
        GROUP BY referred_by
      ) r ON r.referred_by = w.ref_code
      WHERE w.status = 'pending'
    ),
    ranked AS (
      SELECT ref_code,
        row_number() OVER (ORDER BY qualified DESC, answers DESC, created_at ASC) AS pos,
        count(*) OVER () AS total
      FROM scored
    )
    SELECT pos::int, total::int FROM ranked WHERE ref_code = ${refCode}
  `);
  const list = rows as unknown as Array<{ pos: number; total: number }>;
  if (!list.length) return null;
  return { position: Number(list[0].pos), total: Number(list[0].total) };
}

export async function getLeaderboard(limit = TOP_REFERRER_COUNT) {
  const db = getDb();
  const rows = await db.execute(sql`
    SELECT w.email, w.ref_code, r.qualified
    FROM waitlist w
    JOIN (
      SELECT referred_by, count(*)::int AS qualified
      FROM waitlist
      WHERE referred_by IS NOT NULL AND form_completed_at IS NOT NULL
      GROUP BY referred_by
    ) r ON r.referred_by = w.ref_code
    ORDER BY r.qualified DESC, w.created_at ASC
    LIMIT ${Math.max(1, Math.min(limit, 50))}
  `);
  const list = rows as unknown as Array<{ email: string; ref_code: string; qualified: number }>;
  return list.map((r, i) => ({
    rank: i + 1,
    maskedEmail: maskEmail(r.email),
    qualifiedReferrals: Number(r.qualified),
  }));
}

export async function leaderboardRank(refCode: string): Promise<number | null> {
  const db = getDb();
  const rows = await db.execute(sql`
    WITH counts AS (
      SELECT referred_by, count(*)::int AS qualified
      FROM waitlist
      WHERE referred_by IS NOT NULL AND form_completed_at IS NOT NULL
      GROUP BY referred_by
    ),
    ranked AS (
      SELECT w.ref_code,
        row_number() OVER (ORDER BY c.qualified DESC, w.created_at ASC) AS rank
      FROM waitlist w
      JOIN counts c ON c.referred_by = w.ref_code
    )
    SELECT rank::int FROM ranked WHERE ref_code = ${refCode}
  `);
  const list = rows as unknown as Array<{ rank: number }>;
  return list.length ? Number(list[0].rank) : null;
}

const MAX_ANSWER_LENGTH = 1000;

export function sanitizeAnswer(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_ANSWER_LENGTH);
}

export async function submitProfile(statusToken: string, answers: {
  timeSink?: unknown;
  companyRole?: unknown;
  why?: unknown;
}) {
  const db = getDb();
  const row = await findByStatusToken(statusToken);
  if (!row) return null;

  const timeSinkRaw = sanitizeAnswer(answers.timeSink);
  const timeSink = timeSinkRaw && (TIME_SINK_OPTIONS as readonly string[]).includes(timeSinkRaw)
    ? timeSinkRaw
    : null;
  const companyRole = sanitizeAnswer(answers.companyRole);
  const why = sanitizeAnswer(answers.why);

  const update: Record<string, unknown> = {};
  if (timeSink) update.answerTimeSink = timeSink;
  if (companyRole) update.answerCompanyRole = companyRole;
  if (why) update.answerWhy = why;

  const merged = {
    answerTimeSink: timeSink ?? row.answerTimeSink,
    answerCompanyRole: companyRole ?? row.answerCompanyRole,
    answerWhy: why ?? row.answerWhy,
  };
  // All 3 answered → the signup is "qualified" and counts for its referrer.
  const justCompleted = answersCompleted(merged) === 3 && !row.formCompletedAt;
  if (justCompleted) {
    update.formCompletedAt = new Date();
  }

  if (Object.keys(update).length === 0) return { row, justCompleted: false };

  const [updated] = await db
    .update(waitlist)
    .set(update)
    .where(eq(waitlist.id, row.id))
    .returning();
  return { row: updated, justCompleted };
}

export async function getReferralStatus(statusToken: string) {
  const row = await findByStatusToken(statusToken);
  if (!row?.refCode) return null;
  const refCode = row.refCode;

  const [qualified, position, rank] = await Promise.all([
    qualifiedReferralCount(refCode),
    queuePosition(refCode),
    leaderboardRank(refCode),
  ]);

  // Deliberately no email in the payload: the bearer already knows their
  // address, and keeping it out makes an accidentally forwarded status URL
  // leak nothing personal.
  return {
    refCode,
    createdAt: row.createdAt,
    answers: {
      timeSink: row.answerTimeSink,
      companyRole: row.answerCompanyRole,
      why: row.answerWhy,
      completed: answersCompleted(row),
      formCompletedAt: row.formCompletedAt,
    },
    qualifiedReferrals: qualified,
    tier: currentTier(qualified),
    nextTier: nextTier(qualified),
    leaderboardRank: rank,
    position: position?.position ?? null,
    totalPending: position?.total ?? null,
  };
}
