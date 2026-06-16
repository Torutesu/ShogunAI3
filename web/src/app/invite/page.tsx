import { Suspense } from 'react';
import { InvitePageClient } from './InvitePageClient';

export default function InvitePage() {
  return (
    <Suspense fallback={<main style={{ padding: 48 }}>Loading…</main>}>
      <InvitePageClient />
    </Suspense>
  );
}
