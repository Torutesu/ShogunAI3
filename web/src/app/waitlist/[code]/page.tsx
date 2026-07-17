import type { Metadata } from 'next';
import WaitlistStatusClient from './WaitlistStatusClient';

export const metadata: Metadata = {
  title: 'SHOGUN — Waiting list',
  description: 'Your AI has memory. Now it acts.',
};

export default async function WaitlistStatusPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <WaitlistStatusClient code={code} />;
}
