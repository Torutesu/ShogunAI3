import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getDb } from '@/db';
import { subscriptions, users } from '@/db/schema';
import { markInviteUsed, normalizeEmail } from '@/lib/invites';
import { markWaitlistConverted } from '@/lib/waitlist';
import { subscriptionCurrentPeriodEnd, subscriptionTrialEnd } from '@/lib/stripe-subscription';

export async function upsertUserFromCheckout(params: {
  clerkUserId: string;
  email: string;
  stripeCustomerId: string | null;
}) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, params.clerkUserId))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(users)
      .set({
        email: normalizeEmail(params.email),
        stripeCustomerId: params.stripeCustomerId ?? existing.stripeCustomerId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db.insert(users).values({
    clerkUserId: params.clerkUserId,
    email: normalizeEmail(params.email),
    stripeCustomerId: params.stripeCustomerId,
  }).returning();
  return created;
}

export async function upsertSubscriptionFromStripe(
  userId: string,
  sub: Stripe.Subscription,
) {
  const db = getDb();
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, sub.id))
    .limit(1);

  const values = {
    userId,
    stripeSubscriptionId: sub.id,
    status: sub.status,
    trialEnd: subscriptionTrialEnd(sub),
    currentPeriodEnd: subscriptionCurrentPeriodEnd(sub),
    updatedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(subscriptions)
      .set(values)
      .where(eq(subscriptions.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db.insert(subscriptions).values(values).returning();
  return created;
}

export async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  const clerkUserId = session.metadata?.clerkUserId;
  const inviteToken = session.metadata?.inviteToken;
  const customerEmail = session.customer_details?.email || session.customer_email;

  if (!clerkUserId || !customerEmail) {
    throw new Error('checkout.session.completed missing clerkUserId or email');
  }

  const user = await upsertUserFromCheckout({
    clerkUserId,
    email: customerEmail,
    stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
  });

  const stripeSubId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id;

  if (stripeSubId) {
    const { getStripe } = await import('@/lib/stripe');
    const sub = await getStripe().subscriptions.retrieve(stripeSubId);
    await upsertSubscriptionFromStripe(user.id, sub);
  }

  if (inviteToken) {
    await markInviteUsed(inviteToken, clerkUserId);
  }

  await markWaitlistConverted(customerEmail);

  return user;
}

export async function handleSubscriptionChanged(sub: Stripe.Subscription) {
  const db = getDb();
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1);

  if (!user) {
    throw new Error(`No user found for Stripe customer ${customerId}`);
  }

  await upsertSubscriptionFromStripe(user.id, sub);
}

export async function getLatestSubscriptionForClerkUser(clerkUserId: string) {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (!user) return null;

  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, user.id));

  if (rows.length === 0) return null;

  return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
}
