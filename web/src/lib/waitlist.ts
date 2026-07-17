import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { waitlist } from '@/db/schema';
import { createInvite, normalizeEmail } from '@/lib/invites';
import {
  ensureTokens,
  findByRefCode,
  generateRefCode,
  generateStatusToken,
  isValidRefCode,
} from '@/lib/referral';

export type WaitlistStatus = 'pending' | 'invited' | 'converted';

export function isValidWaitlistEmail(email: string): boolean {
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  // Stricter than RFC on purpose: reject quoting/markup characters
  // (<>"'`\ etc.) so a stored address can never carry an XSS or header
  // payload into exports, emails, or a frontend that forgets to escape.
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(trimmed);
}

export type SignupMeta = {
  ipHash?: string | null;
  userAgent?: string | null;
  locale?: string | null;
  country?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
};

export async function addToWaitlist(email: string, ref?: string, meta?: SignupMeta) {
  const db = getDb();
  const normalized = normalizeEmail(email);

  const [existing] = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.email, normalized))
    .limit(1);

  if (existing) {
    // Pre-campaign rows have no tokens yet; assign them so the status
    // page works for everyone.
    if (!existing.refCode || !existing.statusToken) {
      const tokens = await ensureTokens(normalized);
      existing.refCode = tokens.refCode;
      existing.statusToken = tokens.statusToken;
    }
    return { row: existing, duplicate: true };
  }

  // Referrals: silently drop invalid or self-referring codes — the signup
  // itself must never fail because of a bad ref param.
  let referredBy: string | null = null;
  if (ref && isValidRefCode(ref)) {
    const referrer = await findByRefCode(ref);
    if (referrer && referrer.email !== normalized) {
      referredBy = ref;
    }
  }

  const [row] = await db.insert(waitlist).values({
    email: normalized,
    status: 'pending',
    refCode: generateRefCode(),
    statusToken: generateStatusToken(),
    referredBy,
    signupIpHash: meta?.ipHash ?? null,
    signupUserAgent: meta?.userAgent ?? null,
    locale: meta?.locale ?? null,
    signupCountry: meta?.country ?? null,
    utmSource: meta?.utmSource ?? null,
    utmMedium: meta?.utmMedium ?? null,
    utmCampaign: meta?.utmCampaign ?? null,
  }).returning();

  return { row, duplicate: false };
}

export async function listWaitlist(status?: WaitlistStatus) {
  const db = getDb();
  if (status) {
    return db.select().from(waitlist).where(eq(waitlist.status, status));
  }
  return db.select().from(waitlist);
}

export async function waitlistCounts() {
  const db = getDb();
  const rows = await db
    .select({
      status: waitlist.status,
      count: sql<number>`count(*)::int`,
    })
    .from(waitlist)
    .groupBy(waitlist.status);

  const counts = { pending: 0, invited: 0, converted: 0, total: 0 };
  for (const row of rows) {
    const n = Number(row.count) || 0;
    counts.total += n;
    if (row.status === 'pending') counts.pending = n;
    if (row.status === 'invited') counts.invited = n;
    if (row.status === 'converted') counts.converted = n;
  }
  return counts;
}

export async function markWaitlistInvited(email: string) {
  const db = getDb();
  const [row] = await db
    .update(waitlist)
    .set({ status: 'invited', invitedAt: new Date() })
    .where(eq(waitlist.email, normalizeEmail(email)))
    .returning();
  return row ?? null;
}

export async function markWaitlistConverted(email: string) {
  const db = getDb();
  const [row] = await db
    .update(waitlist)
    .set({ status: 'converted' })
    .where(eq(waitlist.email, normalizeEmail(email)))
    .returning();
  return row ?? null;
}

export async function inviteWaitlistEmail(email: string, expiresInDays = 7) {
  const normalized = normalizeEmail(email);
  const invite = await createInvite(normalized, expiresInDays);
  await markWaitlistInvited(normalized);
  return invite;
}

export async function inviteNextPending(limit: number, expiresInDays = 7) {
  const db = getDb();
  const pending = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.status, 'pending'))
    .limit(Math.max(1, Math.min(limit, 50)));

  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001';
  const invites = [];

  for (const row of pending) {
    const invite = await inviteWaitlistEmail(row.email, expiresInDays);
    invites.push({
      email: row.email,
      inviteUrl: `${base}/invite?token=${invite.token}`,
      expiresAt: invite.expiresAt,
    });
  }

  return invites;
}
