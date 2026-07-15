import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { getAppBaseUrl } from '@/lib/web-config';

export const dynamic = 'force-dynamic';
import { getLatestSubscriptionForClerkUser } from '@/lib/billing';
import { getStripe } from '@/lib/stripe';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db';
import { users } from '@/db/schema';

export default async function AccountPage() {
  const { userId } = await auth();
  if (!userId) redirect('/invite');

  const sub = await getLatestSubscriptionForClerkUser(userId);
  let manageUrl: string | null = null;
  const base = getAppBaseUrl();

  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.clerkUserId, userId)).limit(1);

  if (user?.stripeCustomerId) {
    if (!base) {
      return (
        <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
          <h1>Your account</h1>
          <p>Web app URL is not configured yet. Set NEXT_PUBLIC_APP_URL before enabling billing.</p>
        </main>
      );
    }
    const stripe = getStripe();
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${base}/account`,
    });
    manageUrl = portal.url;
  }

  return (
    <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
      <h1>Your account</h1>
      {!sub ? (
        <p>No active subscription. Complete checkout from your invite link.</p>
      ) : (
        <>
          <p>Status: <strong>{sub.status}</strong></p>
          {sub.trialEnd && (
            <p>Trial ends: {sub.trialEnd.toLocaleDateString()}</p>
          )}
          {sub.currentPeriodEnd && (
            <p>Current period ends: {sub.currentPeriodEnd.toLocaleDateString()}</p>
          )}
          {manageUrl && (
            <a href={manageUrl} style={{ color: '#c9a227' }}>Manage billing</a>
          )}
        </>
      )}
    </main>
  );
}
