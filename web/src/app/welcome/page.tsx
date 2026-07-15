import { DownloadButton } from './DownloadButton';

export default function WelcomePage() {
  const dmg = process.env.NEXT_PUBLIC_DMG_DOWNLOAD_URL || '#';

  return (
    <main style={{ padding: 48, maxWidth: 560, margin: '0 auto' }}>
      <h1>Welcome to SHOGUN AI</h1>
      <p>Your 7-day trial has started. Download the app and connect Claude Desktop.</p>
      <DownloadButton href={dmg} />
      <ol style={{ marginTop: 32, lineHeight: 1.8 }}>
        <li>Install and open SHOGUN AI</li>
        <li>Sign in with the same account</li>
        <li>Complete MCP setup in the app</li>
      </ol>
    </main>
  );
}
