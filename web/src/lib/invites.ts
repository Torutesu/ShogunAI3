import { randomBytes } from 'crypto';
import { eq, and, isNull, gt } from 'drizzle-orm';
import { getDb } from '@/db';
import { invites } from '@/db/schema';

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function validateInviteToken(token: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(invites)
    .where(and(
      eq(invites.token, token),
      isNull(invites.usedAt),
      gt(invites.expiresAt, new Date()),
    ))
    .limit(1);

  if (!row) return null;
  return { email: row.email, expiresAt: row.expiresAt };
}

export async function createInvite(email: string, expiresInDays = 7) {
  const db = getDb();
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const [row] = await db.insert(invites).values({
    token,
    email: normalizeEmail(email),
    expiresAt,
  }).returning();
  return row;
}

export async function markInviteUsed(token: string, clerkUserId: string) {
  const db = getDb();
  await db.update(invites)
    .set({ usedAt: new Date(), clerkUserId })
    .where(eq(invites.token, token));
}
