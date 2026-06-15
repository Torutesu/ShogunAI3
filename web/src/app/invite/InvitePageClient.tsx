'use client';

import { SignUp } from '@clerk/nextjs';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export function InvitePageClient() {
  const params = useSearchParams();
  const token = params.get('token') || '';
  const [state, setState] = useState<'loading' | 'valid' | 'invalid'>('loading');
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!token) { setState('invalid'); return; }
    fetch(`/api/invites/validate?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) { setEmail(data.email); setState('valid'); }
        else setState('invalid');
      })
      .catch(() => setState('invalid'));
  }, [token]);

  if (state === 'loading') return <main style={{ padding: 48 }}>Loading…</main>;
  if (state === 'invalid') {
    return (
      <main style={{ padding: 48, maxWidth: 480, margin: '0 auto' }}>
        <h1>Invalid or expired invite</h1>
        <p>Request access at shogunai.lovable.app or contact support.</p>
      </main>
    );
  }

  return (
    <main style={{ padding: 48, maxWidth: 480, margin: '0 auto' }}>
      <h1>SHOGUN AI — Early Access</h1>
      <p>Create your account as <strong>{email}</strong></p>
      <SignUp
        routing="hash"
        forceRedirectUrl={`/checkout?inviteToken=${encodeURIComponent(token)}`}
        initialValues={{ emailAddress: email }}
      />
    </main>
  );
}
