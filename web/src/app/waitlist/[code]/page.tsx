import type { Metadata } from 'next';
import WaitlistStatusClient from './WaitlistStatusClient';

export const metadata: Metadata = {
  title: 'SHOGUN — Waiting list',
  description: 'Your AI has memory. Now it acts.',
  robots: { index: false, follow: false },
};

export default async function WaitlistStatusPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <WaitlistStatusClient code={code} />;
}
