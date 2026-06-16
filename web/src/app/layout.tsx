import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'SHOGUN AI' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body style={{
          margin: 0,
          background: '#0a0908',
          color: '#f5f0eb',
          fontFamily: 'system-ui, sans-serif',
        }}>
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
