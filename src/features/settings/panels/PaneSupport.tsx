import React from 'react';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { useRuntimeActions } from '../lib/hooks';
import { PRODUCT } from '../lib/defaults';

export function PaneSupport() {
  const { run, toast } = useRuntimeActions();
  const onCheckUpdates = React.useCallback(async () => {
    const r = await run('updates.check', {}, { silentError: true });
    if (!r || !r.ok) {
      toast((r && r.error && r.error.message) || 'Update check failed', 'error');
      return;
    }
    const d = r.data;
    if (!d || !d.available) {
      toast('You are on the latest version. / 最新です', 'info');
      return;
    }
    const ver = d.version != null ? String(d.version) : '';
    const msg =
      (d.body && String(d.body).trim()) ||
      `Version ${ver} is available. Install now? The app will restart.`;
    if (typeof window.confirm === 'function' && window.confirm(msg)) {
      const inst = await run('updates.download_install', {}, { silentError: true });
      if (!inst || !inst.ok) {
        toast((inst && inst.error && inst.error.message) || 'Update install failed', 'error');
      }
    }
  }, [run, toast]);
  return (
    <Pane title="Support" jp="支援">
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: 12, lineHeight: 1.55 }}>
        <span className="en-only">Primary channel:</span>
        <span className="jp">主な連絡先:</span>{' '}
        <a className="s-link" href={PRODUCT.supportMailto}>
          Email support（サポート）
        </a>
        （<code style={{ fontSize: 10 }}>PRODUCT.supportMailto</code> を販売用アドレスに差し替えてください）。Discord 等は準備中の場合があります。
        <div className="en-only" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          Desktop: uncaught UI errors are also written to the app process log (stderr / system log). Mention the time of the issue when contacting support. Optional Sentry: set{' '}
          <code style={{ fontSize: 10 }}>&lt;meta name=&quot;shogun-sentry-dsn&quot; content=&quot;…&quot; /&gt;</code> in the HTML shell.
        </div>
        <div className="jp" style={{ marginTop: 10, fontSize: 11, color: 'var(--text-dim)' }}>
          デスクトップ版では、捕捉されなかった UI エラーがアプリのプロセスログ（stderr / システムログ）にも残ります。問い合わせ時は発生時刻を併記してください。任意で Sentry を使う場合は HTML に{' '}
          <code style={{ fontSize: 10 }}>&lt;meta name=&quot;shogun-sentry-dsn&quot; content=&quot;…&quot; /&gt;</code> を追加します。
        </div>
      </div>
      <div className="s-card">
        <Row title="Email support" desc="Bug reports, licensing, and setup — use the address configured for your product build.">
          <a className="btn btn-sm btn-secondary" href={PRODUCT.supportMailto}>
            Open mail
          </a>
        </Row>
        <Row title="Community" desc="Discord is not guaranteed in v1 — email us to request an invite or discuss licensing.">
          <a
            className="btn btn-sm btn-secondary"
            href={`${PRODUCT.supportMailto}?subject=${encodeURIComponent('SHOGUN — community / Discord')}`}
          >
            Email community
          </a>
        </Row>
        <Row
          title="Check for updates / 更新を確認"
          desc="Desktop: Tauri updater (see tauri.conf.json — endpoints + pubkey). Replace YOUR_ORG/YOUR_REPO before shipping. Browser mock: no update."
        >
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => void onCheckUpdates()}>
            Check / 確認
          </button>
        </Row>
        <Row title="Report Performance Issues" desc="Experiencing slowdowns or high resource usage? Create a 5-second diagnostic snapshot to help us troubleshoot the issue." last>
          <button className="btn btn-sm btn-secondary" onClick={() => run('diagnostics.report', { source: 'settings.support' }, { successMessage: 'Diagnostics report started' })}>Report</button>
        </Row>
      </div>
    </Pane>
  );
}
