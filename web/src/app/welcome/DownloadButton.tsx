'use client';

import posthog from 'posthog-js';

// The single most important funnel event on the web side: a paying/trialing
// user clicking through to the DMG. Everything after this point lives in
// Stripe/entitlement data, not web analytics.
export function DownloadButton({ href }: { href: string }) {
  return (
    <a
      href={href}
      onClick={() => {
        try {
          posthog.capture('download_clicked', { platform: 'macos-aarch64' });
        } catch {
          // analytics must never block the download
        }
      }}
      style={{
        display: 'inline-block',
        marginTop: 24,
        padding: '12px 24px',
        background: '#c9a227',
        color: '#0a0908',
        textDecoration: 'none',
        borderRadius: 8,
        fontWeight: 600,
      }}
    >
      Download for macOS
    </a>
  );
}
