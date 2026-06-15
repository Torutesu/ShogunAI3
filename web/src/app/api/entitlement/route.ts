import { auth } from '@clerk/nextjs/server';
import { eq } from 'drizzle-orm';
import { getLatestSubscriptionForClerkUser } from '@/lib/billing';
import { getStripe } from '@/lib/stripe';
import { getDb } from '@/db';
import { users } from '@/db/schema';

const ACTIVE_STATUSES = new Set(['trialing', 'active']);

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const sub = await getLatestSubscriptionForClerkUser(userId);
  if (!sub || !ACTIVE_STATUSES.has(sub.status)) {
    return Response.json({ ok: true, status: 'none' });
  }

  let manageUrl: string | null = null;
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);

  if (user?.stripeCustomerId) {
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.NEXT_PUBLIC_APP_URL}/account`,
    });
    manageUrl = portal.url;
  }

  return Response.json({
    ok: true,
    status: sub.status,
    trialEnd: sub.trialEnd?.toISOString() ?? null,
    currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
    manageUrl,
  });
}
