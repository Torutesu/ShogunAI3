import type Stripe from 'stripe';

function toDate(unix: number | null | undefined): Date | null {
  if (unix == null) return null;
  return new Date(unix * 1000);
}

/** Stripe SDK v22 moved period fields to SubscriptionItem; keep legacy fallback. */
export function subscriptionTrialEnd(sub: Stripe.Subscription): Date | null {
  const legacy = (sub as Stripe.Subscription & { trial_end?: number | null }).trial_end;
  if (legacy != null) return toDate(legacy);
  return null;
}

export function subscriptionCurrentPeriodEnd(sub: Stripe.Subscription): Date | null {
  const itemEnds = (sub.items?.data ?? [])
    .map((item) => item.current_period_end)
    .filter((v): v is number => typeof v === 'number');
  if (itemEnds.length > 0) return toDate(Math.max(...itemEnds));

  const legacy = (sub as Stripe.Subscription & { current_period_end?: number | null }).current_period_end;
  return legacy != null ? toDate(legacy) : null;
}
