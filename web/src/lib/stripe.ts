import Stripe from 'stripe';
import { getRequiredEnv } from '@/lib/web-config';

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const secretKey = getRequiredEnv('STRIPE_SECRET_KEY');
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is required');
  }

  stripeInstance = new Stripe(secretKey);
  return stripeInstance;
}
