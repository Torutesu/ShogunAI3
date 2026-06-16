import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

export default async function HomePage() {
  const { userId } = await auth();
  if (userId) redirect('/account');

  return (
    <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
      <h1>SHOGUN AI</h1>
      <p>Early access is invite-only. Use the link in your invitation email to get started.</p>
    </main>
  );
}
