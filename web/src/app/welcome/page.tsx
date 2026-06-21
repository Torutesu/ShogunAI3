import { getDmgDownloadUrl } from '@/lib/web-config';

export default function WelcomePage() {
  const dmg = getDmgDownloadUrl();

  return (
    <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
      <h1>Welcome to SHOGUN AI</h1>
      <p>Your 7-day trial has started. Download the app and connect Claude Desktop.</p>
      {dmg ? (
        <a
          href={dmg}
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
      ) : (
        <p style={{ marginTop: 24 }}>
          Download link is not configured yet. Set NEXT_PUBLIC_DMG_DOWNLOAD_URL before publishing the web app.
        </p>
      )}
      <ol style={{ marginTop: 32, lineHeight: 1.8 }}>
        <li>Install and open SHOGUN AI</li>
        <li>Sign in with the same account</li>
        <li>Complete MCP setup in the app</li>
      </ol>
    </main>
  );
}
