import { Suspense } from 'react';
import { CheckoutPageClient } from './CheckoutPageClient';

export default function CheckoutPage() {
  return (
    <Suspense fallback={<main style={{ padding: 48 }}>Redirecting…</main>}>
      <CheckoutPageClient />
    </Suspense>
  );
}
