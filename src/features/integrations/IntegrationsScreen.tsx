// Phase 2 Step 7.3: IntegrationsScreen split from _legacy/screens-c.tsx.
import React from 'react';
import { Icon, IntegrationLogo } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';

// Window-injected connector registry — populated at runtime by the native layer.
declare const ShogunIntegrationConnectors: any;

export function IntegrationsScreen() {
  const [calCred, setCalCred] = React.useState(false);
  const [calRefresh, setCalRefresh] = React.useState(false);
  const [gmailCred, setGmailCred] = React.useState(false);
  const [gmailRefresh, setGmailRefresh] = React.useState(false);
  const [slackCred, setSlackCred] = React.useState(false);
  const [notionCred, setNotionCred] = React.useState(false);
  const [githubCred, setGithubCred] = React.useState(false);
  const [linearCred, setLinearCred] = React.useState(false);
  const [driveCred, setDriveCred] = React.useState(false);
  const [zoomCred, setZoomCred] = React.useState(false);
  const [calHistDays, setCalHistDays] = React.useState<number | null>(null);
  const [gmailHistDays, setGmailHistDays] = React.useState<number | null>(null);
  const [slackHistDays, setSlackHistDays] = React.useState<number | null>(null);
  const [notionHistDays, setNotionHistDays] = React.useState<number | null>(null);
  const [githubHistDays, setGithubHistDays] = React.useState<number | null>(null);
  const [linearHistDays, setLinearHistDays] = React.useState<number | null>(null);
  const [driveHistDays, setDriveHistDays] = React.useState<number | null>(null);
  const [zoomHistDays, setZoomHistDays] = React.useState<number | null>(null);
  // Per-provider auto-sync toggle. Backend reads
  // `sections.integrations.<provider>AutoSync`.
  const [autoSync, setAutoSync] = React.useState({
    gmail: false,
    slack: false,
    notion: false,
    github: false,
    linear: false,
    google_drive: false,
    zoom: false,
  });
  const [tools, setTools] = React.useState(() => {
    const C = typeof window !== 'undefined' ? (window as any).ShogunIntegrationConnectors : null;
    const base = C && C.hydrateTools ? C.hydrateTools(C.DEFAULT_GRID_TOOLS) : [
      { slug: 'gmail', name: 'Gmail', cat: 'Mail', jp: 'メール', connected: false, ops: ['read', 'draft', 'send'] },
      { slug: 'google_calendar', name: 'Google Calendar', cat: 'Calendar', jp: '予定', connected: false, ops: ['read', 'create'] },
      { slug: 'slack', name: 'Slack', cat: 'Chat', jp: '会話', connected: false, ops: ['read', 'post'] },
      { slug: 'notion', name: 'Notion', cat: 'Docs', jp: '文書', connected: false, ops: ['read', 'write'] },
      { slug: 'linear', name: 'Linear', cat: 'Tasks', jp: '課題', connected: false, ops: ['read', 'create'] },
      { slug: 'github', name: 'GitHub', cat: 'Code', jp: 'コード', connected: false, ops: ['read', 'comment'] },
      { slug: 'arc_browser', name: 'Arc Browser', cat: 'Web', jp: '閲覧', connected: false, ops: ['capture'] },
      { slug: 'claude', name: 'Claude', cat: 'LLM', jp: '対話', connected: false, ops: ['chat'] },
      { slug: 'figma', name: 'Figma', cat: 'Design', jp: '意匠', connected: false, ops: ['read'] },
      { slug: 'raycast', name: 'Raycast', cat: 'Launcher', jp: '起動', connected: false, ops: ['trigger'] },
      { slug: 'obsidian', name: 'Obsidian', cat: 'Notes', jp: '手記', connected: false, ops: ['read', 'write'] },
      { slug: 'zapier_mcp', name: 'Zapier MCP', cat: 'Bridge', jp: '橋梁', connected: false, ops: ['any'] },
    ];
    return base;
  });
  const refreshCalStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'google_calendar' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setCalCred(!!res.data.configured);
        setCalRefresh(!!res.data.tokenRefreshReady);
      }
      return res;
    });
  }, []);
  const refreshGmailStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'gmail' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setGmailCred(!!res.data.configured);
        setGmailRefresh(!!res.data.tokenRefreshReady);
      }
      return res;
    });
  }, []);
  const refreshSlackStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'slack' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setSlackCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshNotionStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'notion' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setNotionCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const toggleAutoSync = React.useCallback((provider: string, next: boolean) => {
    setAutoSync((prev) => ({ ...prev, [provider]: next }));
    const key = `${provider}AutoSync`;
    return runRuntimeAction(
      'settings.save',
      { section: 'integrations', [key]: next } as any,
      { silentError: true } as any,
    );
  }, []);
  const refreshGithubStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'github' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setGithubCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshLinearStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'linear' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setLinearCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshDriveStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'google_drive' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setDriveCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshZoomStatus = React.useCallback(() => {
    return runRuntimeAction('integrations.credentials_status', { provider:'zoom' } as any, { silentError:true } as any).then((res) => {
      if (res.ok && res.data) {
        setZoomCred(!!res.data.configured);
      }
      return res;
    });
  }, []);
  const refreshHistSettings = React.useCallback(() => {
    return runRuntimeAction('settings.load', {}, { silentError:true } as any).then((res) => {
      const sec = res && res.ok && res.data && res.data.settings && res.data.settings.sections;
      if (sec) {
        const g = sec.gmail && typeof sec.gmail === 'object' ? sec.gmail.historicalSyncDays : null;
        const c = sec.google_calendar && typeof sec.google_calendar === 'object' ? sec.google_calendar.historicalSyncDays : null;
        const s = sec.slack && typeof sec.slack === 'object' ? sec.slack.historicalSyncDays : null;
        const n = sec.notion && typeof sec.notion === 'object' ? sec.notion.historicalSyncDays : null;
        const gh = sec.github && typeof sec.github === 'object' ? sec.github.historicalSyncDays : null;
        const li = sec.linear && typeof sec.linear === 'object' ? sec.linear.historicalSyncDays : null;
        const dr = sec.google_drive && typeof sec.google_drive === 'object' ? sec.google_drive.historicalSyncDays : null;
        const zm = sec.zoom && typeof sec.zoom === 'object' ? sec.zoom.historicalSyncDays : null;
        setGmailHistDays(Number.isFinite(Number(g)) ? Number(g) : null);
        setCalHistDays(Number.isFinite(Number(c)) ? Number(c) : null);
        setSlackHistDays(Number.isFinite(Number(s)) ? Number(s) : null);
        setNotionHistDays(Number.isFinite(Number(n)) ? Number(n) : null);
        setGithubHistDays(Number.isFinite(Number(gh)) ? Number(gh) : null);
        setLinearHistDays(Number.isFinite(Number(li)) ? Number(li) : null);
        setDriveHistDays(Number.isFinite(Number(dr)) ? Number(dr) : null);
        setZoomHistDays(Number.isFinite(Number(zm)) ? Number(zm) : null);
        const integ = sec.integrations && typeof sec.integrations === 'object' ? sec.integrations : {};
        setAutoSync({
          gmail: !!integ.gmailAutoSync,
          slack: !!integ.slackAutoSync,
          notion: !!integ.notionAutoSync,
          github: !!integ.githubAutoSync,
          linear: !!integ.linearAutoSync,
          google_drive: !!integ.google_driveAutoSync,
          zoom: !!integ.zoomAutoSync,
        });
      }
      return res;
    });
  }, []);
  React.useEffect(() => {
    refreshCalStatus();
    refreshGmailStatus();
    refreshSlackStatus();
    refreshNotionStatus();
    refreshGithubStatus();
    refreshLinearStatus();
    refreshDriveStatus();
    refreshZoomStatus();
    refreshHistSettings();
  }, [refreshCalStatus, refreshGmailStatus, refreshSlackStatus, refreshNotionStatus, refreshGithubStatus, refreshLinearStatus, refreshDriveStatus, refreshZoomStatus, refreshHistSettings]);
  React.useEffect(() => {
    const onCred = () => {
      void refreshCalStatus();
      void refreshGmailStatus();
      void refreshSlackStatus();
      void refreshNotionStatus();
      void refreshGithubStatus();
      void refreshLinearStatus();
      void refreshDriveStatus();
      void refreshZoomStatus();
      void refreshHistSettings();
      const C = (window as any).ShogunIntegrationConnectors;
      if (C && typeof C.hydrateTools === 'function') {
        setTools(C.hydrateTools(C.DEFAULT_GRID_TOOLS));
      }
    };
    window.addEventListener('shogun-credentials-updated', onCred);
    return () => window.removeEventListener('shogun-credentials-updated', onCred);
  }, [refreshCalStatus, refreshGmailStatus, refreshSlackStatus, refreshNotionStatus, refreshGithubStatus, refreshLinearStatus, refreshDriveStatus, refreshZoomStatus, refreshHistSettings]);
  const nConnected = tools.filter((t: any) => t.connected).length;

  return (
    <div className="content-inner">
      <div className="page-head">
        <div>
          <div className="t-mono" style={{marginBottom:8}}>CONNECTION LAYER</div>
          <h1>Integrations <span className="jp">接続</span></h1>
          <div className="sub">Browser mock: Connect / toggles persist per connector in localStorage. OAuth is not implemented in-app. Google Calendar: have an external agent import tokens into Keychain, then use the card below to sync events into Memory.</div>
        </div>
        <div className="row">
          <div style={{fontSize:13, color:'var(--text-mute)'}}><span className="gold" style={{fontSize:20, fontWeight:600}}>{nConnected}</span> / {tools.length} connected</div>
          <button className="btn btn-primary" onClick={()=>runRuntimeAction('integrations.connect', { provider:'new_tool' } as any, { silentError:true } as any)}><Icon name="plus" size={14}/>Add tool</button>
        </div>
      </div>

      <div className="shogun-grid-3">
        {tools.map((t: any,i: number)=>(
          <div key={i} className="card card-hover" style={{padding:20, opacity: t.connected?1:0.6}}>
            <div className="row" style={{marginBottom:14, gap:12}}>
              <IntegrationLogo slug={t.slug} size={40} title={t.name} className={t.connected ? 's-intg-logo-on' : 's-intg-logo-off'} />
              <div style={{flex:1}}>
                <div style={{fontSize:14, fontWeight:500}}>{t.name}</div>
                <div className="row" style={{gap:6, marginTop:2}}>
                  <span className="t-mono" style={{fontSize:10}}>{t.cat}</span>
                  <span className="jp dim" style={{fontSize:10}}>{t.jp}</span>
                </div>
              </div>
              <div
                className={'switch '+(t.connected?'on':'')}
                style={{transform:'scale(0.85)', cursor:'pointer'}}
                onClick={async (e) => {
                  e.stopPropagation();
                  const next = !t.connected;
                  const res = await runRuntimeAction('integrations.toggle', { provider: t.slug || t.name, connected: next } as any, { silentError: true } as any);
                  if (res.ok && res.data && !res.data.notImplemented) {
                    setTools((prev: any[]) => prev.map((item) => (item.slug === t.slug ? { ...item, connected: next } : item)));
                  }
                }}
              />
            </div>
            <div className="row" style={{gap:4, flexWrap:'wrap'}}>
              {t.ops.map((o: string) => <span key={o} className="label" style={{fontSize:10, height:20}}>{o}</span>)}
            </div>
          </div>
        ))}
      </div>

      <div className="card" style={{padding:20, marginTop:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:8}}>EXTERNAL AGENT · GOOGLE CALENDAR</div>
        <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:14}}>
          Credentials: Tauri invoke <code style={{fontSize:12}}>app_integration_import_credentials</code> with <code style={{fontSize:12}}>provider: &quot;google_calendar&quot;</code>, <code style={{fontSize:12}}>accessToken</code>, optional <code style={{fontSize:12}}>refreshToken</code>, <code style={{fontSize:12}}>expiresAt</code>, <code style={{fontSize:12}}>oauthClientId</code> (and <code style={{fontSize:12}}>oauthClientSecret</code> if required), <code style={{fontSize:12}}>scopes</code>. OAuth flow is out of scope for this app.
        </div>
        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center'}}>
          <span className={'label ' + (calCred ? 'label-success' : '')}>{calCred ? 'Token imported' : 'No token'}</span>
          {calCred ? (
            <span className={'label ' + (calRefresh ? 'label-success' : '')} style={{fontSize:11}}>
              {calRefresh ? 'Auto-refresh ready' : 'Add oauthClientId + refresh for auto-refresh'}
            </span>
          ) : null}
          <button type="button" className="btn btn-sm btn-secondary" onClick={() => { refreshCalStatus(); }}>Refresh status</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => runRuntimeAction('calendar.sync', { calendarId:'primary', maxResults:25 } as any, { successMessage:'Calendar synced to Memory' } as any)}>Sync to Memory</button>
        </div>
      </div>

      <div className="card" style={{padding:20, marginTop:20, borderColor:'var(--border-hi)'}}>
        <div className="t-mono" style={{marginBottom:8}}>HISTORICAL IMPORT</div>
        <div style={{fontSize:13, color:'var(--text-mute)', lineHeight:1.6, marginBottom:14}}>
          Pull past data from connected Gmail / Google Calendar into Memory. Up to 1 year. Re-running an import may create duplicates.
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginBottom:10}}>
          <span style={{fontSize:13, minWidth:120}}>Google Calendar</span>
          {calCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {calHistDays != null && calHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {calHistDays}d</span>
          ) : calHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!calCred}
            style={!calCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('google_calendar', calHistDays && calHistDays > 0 ? calHistDays : 30);
              }
            }}
          >
            {calHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center'}}>
          <span style={{fontSize:13, minWidth:120}}>Gmail</span>
          {gmailCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {gmailCred && gmailRefresh ? (
            <span className="label label-success" style={{fontSize:11}}>Auto-refresh ready</span>
          ) : null}
          {gmailHistDays != null && gmailHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {gmailHistDays}d</span>
          ) : gmailHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {gmailCred && gmailHistDays != null && gmailHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.gmail}
                onChange={(e) => { void toggleAutoSync('gmail', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!gmailCred}
            style={!gmailCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('gmail', gmailHistDays && gmailHistDays > 0 ? gmailHistDays : 30);
              }
            }}
          >
            {gmailHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Slack</span>
          {slackCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {slackHistDays != null && slackHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {slackHistDays}d</span>
          ) : slackHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!slackCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = (window as any).SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('slack');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {slackCred && slackHistDays != null && slackHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.slack}
                onChange={(e) => { void toggleAutoSync('slack', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!slackCred}
            style={!slackCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('slack', slackHistDays && slackHistDays > 0 ? slackHistDays : 30);
              }
            }}
          >
            {slackHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Notion</span>
          {notionCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {notionHistDays != null && notionHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {notionHistDays}d</span>
          ) : notionHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!notionCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = (window as any).SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('notion');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {notionCred && notionHistDays != null && notionHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.notion}
                onChange={(e) => { void toggleAutoSync('notion', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!notionCred}
            style={!notionCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('notion', notionHistDays && notionHistDays > 0 ? notionHistDays : 30);
              }
            }}
          >
            {notionHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>GitHub</span>
          {githubCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {githubHistDays != null && githubHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {githubHistDays}d</span>
          ) : githubHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!githubCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = (window as any).SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('github');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {githubCred && githubHistDays != null && githubHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.github}
                onChange={(e) => { void toggleAutoSync('github', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!githubCred}
            style={!githubCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('github', githubHistDays && githubHistDays > 0 ? githubHistDays : 30);
              }
            }}
          >
            {githubHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Linear</span>
          {linearCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {linearHistDays != null && linearHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {linearHistDays}d</span>
          ) : linearHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!linearCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = (window as any).SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('linear');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {linearCred && linearHistDays != null && linearHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.linear}
                onChange={(e) => { void toggleAutoSync('linear', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!linearCred}
            style={!linearCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('linear', linearHistDays && linearHistDays > 0 ? linearHistDays : 30);
              }
            }}
          >
            {linearHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Google Drive</span>
          {driveCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {driveHistDays != null && driveHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {driveHistDays}d</span>
          ) : driveHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {driveCred && driveHistDays != null && driveHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.google_drive}
                onChange={(e) => { void toggleAutoSync('google_drive', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!driveCred}
            style={!driveCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('google_drive', driveHistDays && driveHistDays > 0 ? driveHistDays : 30);
              }
            }}
          >
            {driveHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
          {!driveCred && (
            <span className="s-field-hint" style={{fontSize:10, marginLeft:8}}>
              OAuth token needed: import via app_integration_import_credentials (provider: google_drive, scope: drive.readonly)
            </span>
          )}
        </div>

        <div className="row" style={{gap:10, flexWrap:'wrap', alignItems:'center', marginTop:10}}>
          <span style={{fontSize:13, minWidth:120}}>Zoom</span>
          {zoomCred ? (
            <span className="label label-success" style={{fontSize:11}}>Connected</span>
          ) : (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Not connected</span>
          )}
          {zoomHistDays != null && zoomHistDays > 0 ? (
            <span className="label" style={{fontSize:11}}>Last imported: past {zoomHistDays}d</span>
          ) : zoomHistDays === 0 ? (
            <span className="label" style={{fontSize:11, opacity:0.7}}>Skipped previously</span>
          ) : null}
          {!zoomCred && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => {
                const rt = (window as any).SHOGUN_RUNTIME;
                if (rt && typeof rt.openPasteToken === 'function') {
                  rt.openPasteToken('zoom');
                }
              }}
            >
              Paste token…
            </button>
          )}
          {zoomCred && zoomHistDays != null && zoomHistDays > 0 && (
            <label className="row" style={{gap:6, alignItems:'center', fontSize:11, color:'var(--text-dim)', cursor:'pointer', userSelect:'none'}}>
              <input
                type="checkbox"
                checked={!!autoSync.zoom}
                onChange={(e) => { void toggleAutoSync('zoom', e.target.checked); }}
              />
              <span>Auto-sync</span>
            </label>
          )}
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!zoomCred}
            style={!zoomCred ? {opacity:0.5, cursor:'not-allowed'} : undefined}
            onClick={() => {
              const rt = (window as any).SHOGUN_RUNTIME;
              if (rt && typeof rt.openHistoricalImport === 'function') {
                rt.openHistoricalImport('zoom', zoomHistDays && zoomHistDays > 0 ? zoomHistDays : 30);
              }
            }}
          >
            {zoomHistDays != null ? 'Re-sync past…' : 'Import past…'}
          </button>
        </div>
      </div>
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenIntegrations = IntegrationsScreen;
}
