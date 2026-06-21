import { auth, currentUser } from '@clerk/nextjs/server';
import { getStripe } from '@/lib/stripe';
import { normalizeEmail, validateInviteToken } from '@/lib/invites';
import { emailsMatch } from '@/lib/email-match';
import { getAppBaseUrl } from '@/lib/web-config';

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ ok: false, error: 'unauthenticated' }, { status: 401 });
  }

  const user = await currentUser();
  const primaryEmail = user?.emailAddresses.find(
    (e) => e.id === user.primaryEmailAddressId,
  )?.emailAddress;

  if (!primaryEmail) {
    return Response.json({ ok: false, error: 'no_email' }, { status: 400 });
  }

  const { inviteToken } = await req.json();
  const invite = inviteToken ? await validateInviteToken(String(inviteToken)) : null;
  if (!invite) {
    return Response.json({ ok: false, error: 'invalid_invite' }, { status: 403 });
  }

  if (!emailsMatch(primaryEmail, invite.email)) {
    return Response.json({ ok: false, error: 'email_mismatch' }, { status: 403 });
  }

  const priceId = process.env.STRIPE_PRICE_ID;
  const base = getAppBaseUrl();
  if (!priceId || !base) {
    return Response.json({ ok: false, error: 'misconfigured' }, { status: 500 });
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer_email: normalizeEmail(primaryEmail),
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { trial_period_days: 7 },
    payment_method_collection: 'always',
    success_url: `${base}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/checkout?inviteToken=${encodeURIComponent(String(inviteToken))}`,
    metadata: {
      clerkUserId: userId,
      inviteToken: String(inviteToken),
    },
  });

  return Response.json({ ok: true, url: session.url });
}
