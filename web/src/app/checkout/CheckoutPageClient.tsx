'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export function CheckoutPageClient() {
  const params = useSearchParams();
  const inviteToken = params.get('inviteToken') || '';
  const [error, setError] = useState('');

  useEffect(() => {
    if (!inviteToken) {
      setError('missing_invite_token');
      return;
    }

    fetch('/api/checkout/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteToken }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.url) window.location.href = data.url;
        else setError(data.error || 'checkout_failed');
      })
      .catch(() => setError('network_error'));
  }, [inviteToken]);

  if (error) return <main style={{ padding: 48 }}>Checkout error: {error}</main>;
  return <main style={{ padding: 48 }}>Redirecting to secure checkout…</main>;
}
