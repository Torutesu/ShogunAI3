import React, { useState } from 'react';
import { Icon, IntegrationLogo } from '@/shared/icons';
import { Pane } from '../components/Pane';
import { Row } from '../components/Row';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';
import { AuditLogSection } from './PaneIntegrations/AuditLogSection';
import { McpClaudeSection } from './PaneIntegrations/McpClaudeSection';
import { OAuthNotConfiguredModal } from './PaneIntegrations/OAuthNotConfiguredModal';

const PLANNED_OAUTH_PROVIDERS = [
  { slug: 'google_drive', title: 'Google Drive' },
  { slug: 'outlook', title: 'Outlook' },
  { slug: 'notion', title: 'Notion' },
  { slug: 'linear', title: 'Linear' },
  { slug: 'slack', title: 'Slack' },
  { slug: 'github', title: 'GitHub' },
  { slug: 'figma', title: 'Figma' },
  { slug: 'zapier_mcp', title: 'Zapier MCP' },
] as const;

export function PaneIntegrations() {
  const { run } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [googleCalCred, setGoogleCalCred] = useState(false);
  const [googleCalRefresh, setGoogleCalRefresh] = useState(false);
  const [gmailCred, setGmailCred] = useState(false);
  const [gmailRefresh, setGmailRefresh] = useState(false);
  const [driveCred, setDriveCred] = useState(false);
  const [driveRefresh, setDriveRefresh] = useState(false);
  const [calAutoSync, setCalAutoSync] = useState(false);
  const [calSyncMins, setCalSyncMins] = useState(15);
  const [auditRows, setAuditRows] = useState<any[]>([]);
  const [auditFilter, setAuditFilter] = useState('all');
  const [auditProviderFilter, setAuditProviderFilter] = useState('all');
  const [oauthBusy, setOauthBusy] = React.useState<string | null>(null);
  const [oauthNotConfigured, setOauthNotConfigured] = React.useState(false);

  const applyIntegrationSettings = React.useCallback((sourceSections?: Record<string, any> | null) => {
    const integ = sourceSections && sourceSections.integrations;
    if (!integ || typeof integ !== 'object') return;
    setCalAutoSync(!!integ.googleCalendarAutoSync);
    const m = Number(integ.googleCalendarSyncIntervalMins);
    if (Number.isFinite(m)) setCalSyncMins(Math.min(1440, Math.max(5, m)));
  }, []);

  const reloadIntegrationSettings = React.useCallback(async () => {
    const r = await run('settings.load', {}, { silentError: true });
    const nextSections = r.ok && r.data?.settings?.sections;
    applyIntegrationSettings(nextSections && typeof nextSections === 'object' ? nextSections : null);
    return r;
  }, [applyIntegrationSettings, run]);

  const refreshGoogleCalStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'google_calendar' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setGoogleCalCred(r.data.configured);
      setGoogleCalRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  const refreshGmailStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'gmail' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setGmailCred(r.data.configured);
      setGmailRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  const refreshDriveStatus = React.useCallback(async () => {
    const r = await run('integrations.credentials_status', { provider: 'google_drive' }, { silentError: true });
    if (r.ok && r.data && typeof r.data.configured === 'boolean') {
      setDriveCred(r.data.configured);
      setDriveRefresh(!!r.data.tokenRefreshReady);
    }
  }, [run]);

  React.useEffect(() => {
    void refreshGoogleCalStatus();
    void refreshGmailStatus();
    void refreshDriveStatus();
  }, [refreshGoogleCalStatus, refreshGmailStatus, refreshDriveStatus]);

  React.useEffect(() => {
    applyIntegrationSettings(sections);
  }, [applyIntegrationSettings, sections]);

  React.useEffect(() => {
    void reloadIntegrationSettings();
  }, [reloadIntegrationSettings]);

  React.useEffect(() => {
    const onCred = () => {
      void refreshGoogleCalStatus();
      void refreshGmailStatus();
      void refreshDriveStatus();
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshGoogleCalStatus, refreshGmailStatus, refreshDriveStatus]);

  React.useEffect(() => {
    const onRefresh = () => {
      if (refreshSections) void refreshSections();
      void reloadIntegrationSettings();
    };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, [refreshSections, reloadIntegrationSettings]);

  React.useEffect(() => {
    const key = 'shogun.integration.audit.v1';
    try {
      const raw = localStorage.getItem(key);
      const arr = raw ? JSON.parse(raw) : [];
      setAuditRows(Array.isArray(arr) ? arr.slice(0, 20) : []);
    } catch (_) {
      setAuditRows([]);
    }
    const onAudit = (ev: any) => {
      const d = ev && ev.detail ? ev.detail : null;
      if (!d || typeof d !== 'object') return;
      setAuditRows((prev) => [d].concat(Array.isArray(prev) ? prev : []).slice(0, 20));
    };
    window.addEventListener('shogun-integration-security-audit', onAudit);
    return () => window.removeEventListener('shogun-integration-security-audit', onAudit);
  }, []);

  const fmtAuditTime = (t: any) => {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '—';
    try {
      return new Date(n).toLocaleString();
    } catch (_) {
      return '—';
    }
  };
  const auditEventLabel = (event: any) => {
    switch (String(event || '')) {
      case 'integration_import_attempt': return '取り込み試行';
      case 'integration_import_success': return '取り込み成功';
      case 'integration_import_rejected': return '取り込み拒否';
      default: return String(event || 'unknown');
    }
  };
  const auditReasonLabel = (reason: any) => {
    switch (String(reason || '')) {
      case 'raw_token_query': return 'URLに生トークンが含まれていたため拒否';
      case 'invalid_or_expired_code': return 'ワンタイムコードが無効または期限切れ';
      case 'provider_code_mismatch': return 'provider と code が不一致';
      case 'code_state_error': return 'コード状態の読み取りエラー';
      case 'persist_failed': return '資格情報保存に失敗';
      default: return String(reason || '');
    }
  };
  const auditViaLabel = (via: any) => {
    switch (String(via || '')) {
      case 'invoke': return '直接API';
      case 'deep-link': return 'ディープリンク';
      default: return String(via || 'unknown');
    }
  };
  const filteredAuditRows = React.useMemo(() => {
    let rows = auditRows;
    if (auditFilter === 'success') {
      rows = rows.filter((r) => String(r && r.event) === 'integration_import_success');
    } else if (auditFilter === 'rejected') {
      rows = rows.filter((r) => String(r && r.event) === 'integration_import_rejected');
    }
    if (auditProviderFilter !== 'all') {
      rows = rows.filter((r) => String((r && r.provider) || '') === auditProviderFilter);
    }
    return rows;
  }, [auditRows, auditFilter, auditProviderFilter]);
  const auditProviderOptions = React.useMemo(() => {
    const set = new Set<string>();
    auditRows.forEach((r) => {
      const p = String((r && r.provider) || '').trim();
      if (p) set.add(p);
    });
    return ['all'].concat(Array.from(set).sort());
  }, [auditRows]);
  const exportAuditJson = React.useCallback(() => {
    try {
      const now = new Date();
      const stamp = now
        .toISOString()
        .replace(/[:]/g, '-')
        .replace(/\..+$/, 'Z');
      const payload = {
        exportedAt: now.toISOString(),
        count: auditRows.length,
        rows: auditRows,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shogun-integration-audit-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (_) {
      /* ignore */
    }
  }, [auditRows]);

  const mapOauthError = (raw: string) => {
    if (raw.startsWith('oauth_token_exchange_failed:')) {
      const parts = raw.split(':');
      const status = parts[1] || '?';
      const code = parts[2] || '?';
      return `Token exchange failed [${status} ${code}]. Check CLIENT_SECRET.`;
    }
    if (raw === 'oauth_user_cancelled') return 'OAuth was cancelled';
    if (raw === 'oauth_state_mismatch') return 'Security check failed; please try again';
    if (raw === 'oauth_timeout') return 'OAuth timed out. Try again.';
    if (raw === 'oauth_port_busy') return 'Already connecting — please wait or restart';
    if (raw === 'oauth_already_in_progress') return 'Already connecting';
    if (raw === 'oauth_network_error') return 'Network error during token exchange';
    if (raw === 'oauth_invalid_provider') return 'Invalid provider';
    if (raw.startsWith('oauth_internal:')) {
      const detail = raw.replace(/^oauth_internal:\s*/, '').replace(/^provider error:\s*/, '');
      return `OAuth flow error: ${detail}`;
    }
    return `OAuth failed: ${raw}`;
  };

  const handleOauthConnect = async (provider: string) => {
    setOauthBusy(provider);
    try {
      const res = await runRuntimeAction('oauth.google.start', { provider }, { silentError: true });
      if (!res?.ok) {
        const msg = String(res?.error || '');
        if (msg.startsWith('oauth_credentials_not_configured')) {
          setOauthNotConfigured(true);
        } else {
          const friendly = mapOauthError(msg);
          (window as any).SHOGUN_RUNTIME?.pushToast?.(friendly, 'warn');
        }
        return;
      }
      const label =
        provider === 'gmail'
          ? 'Gmail'
          : provider === 'google_drive'
            ? 'Google Drive'
            : 'Google Calendar';
      (window as any).SHOGUN_RUNTIME?.pushToast?.(`Connected to ${label}`, 'success');
      await Promise.all([
        refreshGmailStatus(),
        refreshGoogleCalStatus(),
        refreshDriveStatus(),
      ]);
    } finally {
      setOauthBusy(null);
    }
  };

  return (
    <Pane title="All Integrations" jp="連携" subtitle="In-app OAuth: Click Connect on Gmail / Google Calendar / Google Drive to start the consent flow. CLIENT_ID/SECRET are read from scripts/.env.google-oauth (dev). For other providers, agent-based import is still supported (see legacy notes below).">
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        Workspace Integrations screen has the same agent contract. Preferred path: Tauri invoke <code style={{ fontSize: 11 }}>app_integration_import_credentials</code> with <code style={{ fontSize: 11 }}>provider: &quot;google_calendar&quot;</code> or <code style={{ fontSize: 11 }}>&quot;gmail&quot;</code>, <code style={{ fontSize: 11 }}>accessToken</code>, optional <code style={{ fontSize: 11 }}>refreshToken</code>, <code style={{ fontSize: 11 }}>expiresAt</code>, <code style={{ fontSize: 11 }}>oauthClientId</code> (for automatic token refresh). Deep-link alternative: <code style={{ fontSize: 11 }}>shogun-ai://credentials/import?provider=...</code> — prefer invoke for secrets (URLs leak to logs / history). Gmail needs scope <code style={{ fontSize: 11 }}>gmail.readonly</code> or broader.
      </div>
      <div className="s-field-hint" style={{ marginBottom: 14, padding: 12, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
        <span className="en-only">Preview note:</span>
        <span className="jp">プレビュー注意:</span> Slack, Notion, Linear, Outlook, GitHub, Claude, Figma, and Zapier MCP still show a warn toast for <code style={{ fontSize: 11 }}>Connect</code> in v1.
        <div style={{ marginTop: 6 }}>
          <span className="en-only">Supported today:</span>
          <span className="jp">現在対応:</span> Gmail, Google Calendar, Google Drive, Apple Calendar, Apple Reminders, Arc, Raycast, and Obsidian.
        </div>
      </div>
      <McpClaudeSection />
      <div className="s-card" style={{ marginBottom: 10 }}>
        <Row title={<div className="row" style={{ gap: 10 }}><IntegrationLogo slug="apple_calendar" size={30} title="Apple Calendar" /><div><div style={{ fontSize: 13, fontWeight: 500 }}>Apple Calendar <span className="label label-gold" style={{ marginLeft: 4 }}>Beta</span></div><div className="s-field-hint">See your events in Apple Calendar</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => run('integrations.connect', { provider: 'apple_calendar' }, { silentError: true })}>Connect</button>
        </Row>
      </div>
      <AuditLogSection
        filteredAuditRows={filteredAuditRows}
        auditFilter={auditFilter}
        setAuditFilter={setAuditFilter}
        auditProviderFilter={auditProviderFilter}
        setAuditProviderFilter={setAuditProviderFilter}
        auditProviderOptions={auditProviderOptions}
        exportAuditJson={exportAuditJson}
        fmtAuditTime={fmtAuditTime}
        auditEventLabel={auditEventLabel}
        auditReasonLabel={auditReasonLabel}
        auditViaLabel={auditViaLabel}
      />
      <div className="s-card" style={{ marginBottom: 10 }}>
        <Row title={<div className="row" style={{ gap: 10 }}><IntegrationLogo slug="apple_reminders" size={30} title="Apple Reminders" /><div><div style={{ fontSize: 13, fontWeight: 500 }}>Apple Reminders <span className="label label-gold" style={{ marginLeft: 4 }}>Beta</span></div><div className="s-field-hint">See your reminders and tasks in Apple Reminders</div></div></div>} last>
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => run('integrations.connect', { provider: 'apple_reminders' }, { silentError: true })}>Connect</button>
        </Row>
      </div>
      <div className="s-card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ padding: '14px 16px' }}>
          <IntegrationLogo slug="gmail" size={30} title="Gmail" />
          <div style={{ marginLeft: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Gmail</div>
            <div className="s-field-hint">Inbox list → Memory ingest (<code style={{ fontSize: 10 }}>provenance: connector</code>, source <code style={{ fontSize: 10 }}>gmail</code>).</div>
          </div>
          <span className="spacer" />
          <Icon name="chevronDown" size={12} className="dim" />
        </div>
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Agent-imported token</span>
          <span className={'label ' + (gmailCred ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
            {gmailCred ? 'Keychain · configured' : 'No token · import via agent'}
          </span>
          {gmailCred ? (
            <span className={'label ' + (gmailRefresh ? 'label-success' : '')} style={{ borderColor: 'var(--border)', fontSize: 11 }}>
              {gmailRefresh ? 'Refresh: client+refresh token' : 'Refresh: add oauthClientId + refreshToken'}
            </span>
          ) : null}
          <span className="spacer" />
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => { void refreshGmailStatus(); }}>Refresh status</button>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!!oauthBusy}
            onClick={() => handleOauthConnect('gmail')}
          >
            {oauthBusy === 'gmail' ? (
              <><span className="en-only">Connecting…</span><span className="jp">接続中…</span></>
            ) : (
              <><span className="en-only">Connect</span><span className="jp">接続</span></>
            )}
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => run('gmail.sync', { maxResults: 20 }, { successMessage: 'Gmail synced to Memory' })}>Sync to Memory</button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'gmail', action: 'edit' }, { silentError: true })}><Icon name="edit" size={12} /></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'gmail', action: 'settings' }, { silentError: true })}><Icon name="settings" size={12} /></button>
        </div>
        {!gmailCred ? (
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>How to import Gmail token</div>
            <div className="s-field-hint" style={{ marginBottom: 8 }}>
              <span className="en-only">In-app: click Connect above. This drawer is for the agent-based fallback (production / multi-user, when scripts/.env.google-oauth is unavailable).</span>
              <span className="jp">アプリ内: 上の Connect を押す。このドロワは agent 経由の代替手順 (本番 / 複数ユーザ、scripts/.env.google-oauth が使えない場合)。</span>
            </div>
            <div>1) Get OAuth access token (+ optional refresh token / client id) with Gmail scope <code style={{ fontSize: 10 }}>gmail.readonly</code>.</div>
            <div>2) Call <code style={{ fontSize: 10 }}>app_integration_import_credentials</code> with <code style={{ fontSize: 10 }}>provider: "gmail"</code>.</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <a
                className="s-link"
                href="https://developers.google.com/workspace/gmail/api/auth/scopes"
                target="_blank"
                rel="noopener noreferrer"
              >
                Gmail scopes guide <Icon name="arrowUpRight" size={10} />
              </a>
              <button
                type="button"
                className="s-link"
                style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', cursor: 'pointer' }}
                onClick={() => run('integrations.connect', { provider: 'gmail' }, { silentError: true })}
              >
                Re-check token status
              </button>
            </div>
          </div>
        ) : null}
      </div>
      <div className="s-card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ padding: '14px 16px' }}>
          <IntegrationLogo slug="google_calendar" size={30} title="Google Calendar" />
          <div style={{ marginLeft: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Google Calendar</div>
            <div className="s-field-hint">Manage and see your calendar events and appointments through Google Calendar.</div>
          </div>
          <span className="spacer" />
          <Icon name="chevronDown" size={12} className="dim" />
        </div>
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Agent-imported token</span>
          <span className={'label ' + (googleCalCred ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
            {googleCalCred ? 'Keychain · configured' : 'No token · import via agent'}
          </span>
          {googleCalCred ? (
            <span className={'label ' + (googleCalRefresh ? 'label-success' : '')} style={{ borderColor: 'var(--border)', fontSize: 11 }}>
              {googleCalRefresh ? 'Refresh: client+refresh token' : 'Refresh: add oauthClientId + refreshToken'}
            </span>
          ) : null}
          <span className="spacer" />
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => { void refreshGoogleCalStatus(); }}>Refresh status</button>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!!oauthBusy}
            onClick={() => handleOauthConnect('google_calendar')}
          >
            {oauthBusy === 'google_calendar' ? (
              <><span className="en-only">Connecting…</span><span className="jp">接続中…</span></>
            ) : (
              <><span className="en-only">Connect</span><span className="jp">接続</span></>
            )}
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => run('calendar.sync', { calendarId: 'primary', maxResults: 25 }, { successMessage: 'Calendar synced to Memory' })}>Sync to Memory</button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'google_calendar', action: 'edit' }, { silentError: true })}><Icon name="edit" size={12} /></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'google_calendar', action: 'settings' }, { silentError: true })}><Icon name="settings" size={12} /></button>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8, opacity: googleCalCred ? 1 : 0.45 }}>
            <input type="checkbox" checked={calAutoSync} disabled={!googleCalCred} onChange={(e) => setCalAutoSync(e.target.checked)} />
            Background sync to Memory
          </label>
          <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, opacity: googleCalCred ? 1 : 0.45 }}>
            Every
            <input className="s-input" type="number" min={5} max={1440} style={{ width: 64 }} value={calSyncMins} disabled={!googleCalCred} onChange={(e) => setCalSyncMins(Number(e.target.value))} />
            min (5–1440)
          </label>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!googleCalCred}
            onClick={async () => {
              const m = Math.min(1440, Math.max(5, Math.round(calSyncMins) || 15));
              const r = await run(
                'settings.save',
                { section: 'integrations', googleCalendarAutoSync: calAutoSync, googleCalendarSyncIntervalMins: m },
                { silentError: true, successMessage: 'Calendar auto-sync saved' },
              );
              if (r.ok) {
                setCalSyncMins(m);
                if (refreshSections) await refreshSections();
              }
            }}
          >Save auto-sync</button>
        </div>
      </div>
      <div className="s-card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ padding: '14px 16px' }}>
          <IntegrationLogo slug="google_drive" size={30} title="Google Drive" />
          <div style={{ marginLeft: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Google Drive</div>
            <div className="s-field-hint">Drive files → Memory ingest (read-only connector).</div>
          </div>
          <span className="spacer" />
          <Icon name="chevronDown" size={12} className="dim" />
        </div>
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Google OAuth</span>
          <span className={'label ' + (driveCred ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
            {driveCred ? 'Keychain · configured' : 'No token · Connect or import'}
          </span>
          {driveCred ? (
            <span className={'label ' + (driveRefresh ? 'label-success' : '')} style={{ borderColor: 'var(--border)', fontSize: 11 }}>
              {driveRefresh ? 'Refresh: client+refresh token' : 'Refresh: add oauthClientId + refreshToken'}
            </span>
          ) : null}
          <span className="spacer" />
          <button className="btn btn-sm btn-secondary" type="button" onClick={() => { void run('integrations.credentials_status', { provider: 'google_drive' }, { silentError: true }); void refreshDriveStatus(); }}>Refresh status</button>
          <button
            className="btn btn-sm btn-secondary"
            type="button"
            disabled={!!oauthBusy}
            onClick={() => handleOauthConnect('google_drive')}
          >
            {oauthBusy === 'google_drive' ? (
              <><span className="en-only">Connecting…</span><span className="jp">接続中…</span></>
            ) : (
              <><span className="en-only">Connect</span><span className="jp">接続</span></>
            )}
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={() => run('drive.sync', { maxFiles: 20 }, { successMessage: 'Google Drive synced to Memory' })}>Sync to Memory</button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'google_drive', action: 'edit' }, { silentError: true })}><Icon name="edit" size={12} /></button>
          <button className="btn btn-sm btn-ghost" type="button" style={{ padding: '0 6px' }} onClick={() => run('integrations.toggle', { provider: 'google_drive', action: 'settings' }, { silentError: true })}><Icon name="settings" size={12} /></button>
        </div>
        {!driveCred ? (
          <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.55 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>How to import Google Drive token</div>
            <div className="s-field-hint" style={{ marginBottom: 8 }}>
              <span className="en-only">In-app: click Connect above. This drawer is for the agent-based fallback when scripts/.env.google-oauth is unavailable.</span>
              <span className="jp">アプリ内: 上の Connect を押す。このドロワは scripts/.env.google-oauth が使えない場合の agent 経由代替手順です。</span>
            </div>
            <div>1) Get OAuth access token (+ optional refresh token / client id) with Drive scope <code style={{ fontSize: 10 }}>https://www.googleapis.com/auth/drive.readonly</code>.</div>
            <div>2) Call <code style={{ fontSize: 10 }}>app_integration_import_credentials</code> with <code style={{ fontSize: 10 }}>provider: "google_drive"</code>.</div>
          </div>
        ) : null}
      </div>
      {PLANNED_OAUTH_PROVIDERS.map((s) => (
        <div key={s.slug} className="s-card" style={{ marginBottom: 8 }}>
          <Row
            last
            title={(
              <div className="row" style={{ gap: 10 }}>
                <IntegrationLogo slug={s.slug} size={30} title={s.title} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.title}</div>
                  <div className="s-field-hint">OAuth connector is coming soon; use agent import where available.</div>
                </div>
              </div>
            )}
          >
            <span className="label" style={{ borderColor: 'var(--border)', marginRight: 8 }}>Coming soon</span>
            <button className="btn btn-sm btn-secondary" type="button" disabled>Coming soon</button>
          </Row>
        </div>
      ))}
      {oauthNotConfigured && (
        <OAuthNotConfiguredModal onClose={() => setOauthNotConfigured(false)} />
      )}
    </Pane>
  );
}
