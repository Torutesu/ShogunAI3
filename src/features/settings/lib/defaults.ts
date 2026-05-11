import { ShogunMemoryExport } from '@/shared/ipc/shogun-api';

/**
 * Commercial build: customer-facing legal URLs (optional). Leave empty to rely on bundled markdown
 * (docs/TERMS_OF_SERVICE.md, docs/TERMS_OF_SERVICE_EN.md, PRIVACY.md). Replace supportMailto with your support address.
 */
export const PRODUCT = {
  supportMailto: 'mailto:support@yourcompany.com?subject=SHOGUN%20support',
  termsJaUrl: '',
  termsEnUrl: '',
  privacyUrl: '',
};

export const PRIVACY_DEFAULT_APPS = [
  { id: 'preset-finder', name: 'Finder', icon: '📁', enabled: true },
  { id: 'preset-1password', name: '1Password', icon: '🔐', enabled: true },
  { id: 'preset-banking', name: 'Banking', icon: '🏦', enabled: true },
];

export const PRIVACY_DEFAULT_SITES = [
  { id: 'site-ex1', host: 'internal.corp.example', label: 'Corporate SSO (example)', enabled: true },
  { id: 'site-ex2', host: 'pay.vendor.example', label: 'Vendor payments (example)', enabled: false },
];

export const DEFAULT_PAYMENT_DOMAINS = [
  { id: 'pd-stripe',     host: 'stripe.com',            label: 'Stripe',           enabled: true },
  { id: 'pd-paypal',     host: 'paypal.com',            label: 'PayPal',           enabled: true },
  { id: 'pd-amazonpay',  host: 'pay.amazon.com',        label: 'Amazon Pay',       enabled: true },
  { id: 'pd-googlepay',  host: 'pay.google.com',        label: 'Google Pay',       enabled: true },
  { id: 'pd-shopify',    host: 'checkout.shopify.com',  label: 'Shopify Checkout', enabled: true },
  { id: 'pd-itunes',     host: 'buy.itunes.apple.com',  label: 'iTunes Store',     enabled: true },
  { id: 'pd-applepay',   host: 'applepay.apple.com',    label: 'Apple Pay',        enabled: true },
  { id: 'pd-billing',    host: 'billing.stripe.com',    label: 'Stripe Billing',   enabled: true },
];

export const EMBED_BACKFILL_BATCH_OPTS = [20, 40, 80, 120, 200];
export const EMBED_BACKFILL_DELAY_OPTS = [0, 250, 500, 1000];

export const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const FULL_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Stable fallback so `sections.security` missing does not allocate a new `{}` every render. */
export const EMPTY_SETTINGS_SECURITY = {};

// Mirrors `src-tauri/src/memory_export.rs::CONFIRM_TOKEN`.
export const IMPORT_CONFIRM_TOKEN =
  (ShogunMemoryExport && ShogunMemoryExport.CONFIRM_TOKEN)
    || 'REPLACE';

export const MAX_PROFILE_PHOTO_BYTES = 512 * 1024;
