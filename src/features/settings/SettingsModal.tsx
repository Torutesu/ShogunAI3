import React, { useState } from 'react';
import * as ReactDOM from 'react-dom';
import { Icon, Kamon } from '@/shared/icons';
import { SettingsHydrationContext } from './types';
import { SETTINGS_NAV, PANE_ALIAS } from './lib/nav';
import { PANES } from './panels';

export function SettingsModal({ pane, setPane, close }: {
  pane: string;
  setPane: (pane: string) => void;
  close: () => void;
}) {
  const resolved = PANE_ALIAS[pane] || pane;
  const PaneComp = (PANES[resolved] || PANES.general) as React.ComponentType;
  const [hydratedSections, setHydratedSections] = useState<Record<string, any>>({});
  const refreshSections = React.useCallback(async () => {
    if (!(window as any).SHOGUN_RUNTIME || !(window as any).SHOGUN_RUNTIME.executeAction) {
      setHydratedSections({});
      return;
    }
    const res = await (window as any).SHOGUN_RUNTIME.executeAction('settings.load', {}, { silentError: true });
    const inner = res && res.data;
    const sec = inner && inner.settings && inner.settings.sections;
    setHydratedSections(sec && typeof sec === 'object' ? sec : {});
  }, []);
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshSections();
      if (cancelled) return;
    })();
    return () => { cancelled = true; };
  }, [refreshSections]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  /** Re-hydrate all settings panes when the macOS tray toggles capture state.
   *  ipc-client.js dispatches shogun-settings-refresh on shogun-capture-state-changed. */
  React.useEffect(() => {
    const onRefresh = () => { void refreshSections(); };
    window.addEventListener('shogun-settings-refresh', onRefresh);
    return () => window.removeEventListener('shogun-settings-refresh', onRefresh);
  }, [refreshSections]);
  const hydrationCtxValue = React.useMemo(
    () => ({ sections: hydratedSections, refreshSections, setPane }),
    [hydratedSections, refreshSections, setPane],
  );
  const tree = (
    <SettingsHydrationContext.Provider value={hydrationCtxValue}>
      <>
        <div className="s-backdrop" role="presentation" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); close(); }} />
        <div className="s-modal" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
          <div className="s-sidebar">
            <div className="t-mono" style={{ padding: '14px 14px 16px', fontSize: 10, color: 'var(--text-dim)', letterSpacing: '0.2em' }}>
              SETTINGS · 設定
            </div>
            <div className="s-nav-list">
              {SETTINGS_NAV.map(n => (
                <div key={n.id} className={'s-nav ' + (resolved === n.id ? 'active' : '')} onClick={() => setPane(n.id)}>
                  <Icon name={n.icon} size={13} />
                  <span className="en-only">{n.label}</span>
                  <span className="jp">{n.jp}</span>
                </div>
              ))}
            </div>
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Kamon size={11} color="var(--gold)" />
              <span className="t-mono" style={{ fontSize: 9, color: 'var(--text-dim)' }}>SHOGUN v0.4.1</span>
            </div>
          </div>
          <div className="s-content">
            <button type="button" className="s-close" aria-label="Close settings" onClick={(e) => { e.stopPropagation(); close(); }}><Icon name="x" size={14} /></button>
            <PaneComp />
          </div>
        </div>

        <style>{`
        .s-backdrop {
          position:fixed; inset:0; z-index:1100;
          background:rgba(10,9,8,0.55);
          backdrop-filter: blur(6px);
          animation: sBackIn 160ms var(--ease-out);
        }
        @keyframes sBackIn { from {opacity:0;} to {opacity:1;} }
        .s-modal {
          position:fixed; z-index:1101;
          top:50%; left:50%; transform:translate(-50%, -50%);
          box-sizing:border-box;
          --s-edge: max(16px, min(48px, 5vmin));
          --s-safe-x: calc(env(safe-area-inset-left, 0px) + env(safe-area-inset-right, 0px));
          --s-safe-y: calc(env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px));
          --s-max-view-w: calc(100vw - 2 * var(--s-edge) - var(--s-safe-x));
          --s-max-view-h: calc(100dvh - 2 * var(--s-edge) - var(--s-safe-y));
          --s-pref-w: min(1200px, min(92vw, var(--s-max-view-w)));
          --s-pref-h: clamp(400px, 86dvh, min(820px, var(--s-max-view-h)));
          width:min(var(--s-pref-w), var(--s-max-view-w));
          height:min(var(--s-pref-h), var(--s-max-view-h));
          max-width:var(--s-max-view-w);
          max-height:var(--s-max-view-h);
          min-height:min(384px, var(--s-max-view-h));
          background:var(--bg);
          border:1px solid var(--border-hi);
          border-radius:var(--radius-lg);
          box-shadow:0 40px 80px -20px rgba(0,0,0,0.7), 0 2px 0 rgba(0,0,0,0.4);
          display:flex; overflow:hidden;
          animation: sModalIn 220ms var(--ease-out);
        }
        @keyframes sModalIn {
          from { opacity:0; }
          to { opacity:1; }
        }
        .s-nav-list {
          flex:1; min-height:0; overflow-y:auto;
          padding:0 8px;
        }
        .s-sidebar {
          width:200px; flex-shrink:0; min-height:0;
          border-right:1px solid var(--border);
          background:var(--surface);
          display:flex; flex-direction:column;
        }
        .s-appearance-grid {
          display:grid;
          grid-template-columns:repeat(3, minmax(0, 1fr));
          gap:14px;
          margin-bottom:24px;
        }
        .s-nav {
          display:flex; align-items:center; gap:8px;
          padding:7px 10px; border-radius:var(--radius-sm);
          color:var(--text-mute); font-size:12px; cursor:pointer;
          margin-bottom:1px;
        }
        .s-nav:hover { background:var(--surface-2); color:var(--text); }
        .s-nav.active {
          background:var(--surface-2); color:var(--text);
          border:1px solid var(--border);
        }
        .s-nav .jp { font-family:var(--font-jp); font-weight:300; font-size:10.5px; color:var(--text-dim); margin-left:-4px; }

        .s-content {
          flex:1; min-width:0; min-height:0; overflow-y:auto; position:relative;
          padding:22px 28px 36px;
        }
        .s-close {
          position:absolute; top:12px; right:12px;
          width:28px; height:28px; border-radius:6px;
          background:transparent; border:1px solid transparent;
          color:var(--text-mute); cursor:pointer;
          display:flex; align-items:center; justify-content:center;
          z-index:2;
        }
        .s-close:hover { background:var(--surface); border-color:var(--border); color:var(--text); }

        .s-pane-head { margin-bottom:18px; }
        .s-pane-sub { margin-top:6px; font-size:12px; color:var(--text-mute); line-height:1.55; max-width:min(960px, 100%); }
        .s-pane-body { max-width:min(960px, 100%); }

        .s-card {
          background:var(--surface);
          border:1px solid var(--border);
          border-radius:var(--radius-md);
          overflow:hidden;
        }
        .s-row {
          display:flex; align-items:center; gap:14px;
          padding:14px 16px;
          border-bottom:1px solid var(--border);
        }
        .s-row.last { border-bottom:none; }
        .s-row-title { font-size:13px; color:var(--text); font-weight:500; }
        .s-row-desc { font-size:11.5px; color:var(--text-dim); margin-top:2px; line-height:1.4; }

        .s-field-label { font-size:13px; color:var(--text); margin-bottom:8px; font-weight:500; }
        .s-field-hint { font-size:11.5px; color:var(--text-dim); margin-top:6px; line-height:1.5; }
        .s-input, .s-textarea, .s-select {
          width:100%; padding:9px 12px;
          background:var(--surface); border:1px solid var(--border);
          border-radius:var(--radius-sm);
          color:var(--text); font-size:13px; font-family:inherit;
        }
        .s-textarea { resize:vertical; line-height:1.55; }
        .s-input:focus, .s-textarea:focus, .s-select:focus {
          outline:none; border-color:var(--gold-dim);
        }
        .s-select {
          width:auto; padding:6px 28px 6px 10px;
          font-size:12px; background-image:none; cursor:pointer;
          appearance:none; -webkit-appearance:none;
          background-position: right 8px center;
        }

        .s-link { color:var(--gold); cursor:pointer; }
        .s-link:hover { text-decoration:underline; }

        .s-meta {
          padding:14px 16px;
          background:var(--surface);
          border:1px solid var(--border);
          border-radius:var(--radius-md);
          margin-top:10px;
        }

        .s-toggle {
          width:34px; height:18px; border-radius:9px;
          background:var(--surface-2); border:1px solid var(--border);
          position:relative; cursor:pointer; transition:background 120ms;
          flex-shrink:0;
        }
        .s-toggle[data-on="1"] { background:var(--gold); border-color:var(--gold); }
        .s-toggle-knob {
          position:absolute; top:1px; left:1px;
          width:14px; height:14px; border-radius:50%;
          background:var(--text-mute); transition:transform 160ms, background 120ms;
        }
        .s-toggle[data-on="1"] .s-toggle-knob {
          background:#fff; transform:translateX(16px);
        }

        .s-color-card {
          padding:4px; border-radius:var(--radius-md);
          cursor:pointer; border:1px solid transparent;
          transition:border-color 120ms;
        }
        .s-color-card.active { border-color:var(--gold); }
        .s-color-preview {
          aspect-ratio:16/10; border-radius:var(--radius-sm);
          border:1px solid var(--border);
          padding:8px; display:flex; flex-direction:column; gap:8px;
          position:relative; overflow:hidden;
        }
        .s-color-preview[data-mode="light"] { background:#f4f1ea; color:#2a2420; }
        .s-color-preview[data-mode="dark"] { background:#151212; color:#d9d4ca; }
        .s-color-preview[data-mode="auto"] {
          background:linear-gradient(90deg, #f4f1ea 50%, #151212 50%);
          color:#2a2420;
        }
        .s-color-bar { display:flex; gap:3px; }
        .s-color-bar span { width:5px; height:5px; border-radius:50%; background:currentColor; opacity:0.4; }
        .s-color-title { font-size:10px; opacity:0.9; text-align:center; flex:1; display:flex; align-items:center; justify-content:center; }
        .s-color-input {
          height:10px; border-radius:3px;
          background:color-mix(in srgb, currentColor 10%, transparent);
          border:1px solid color-mix(in srgb, currentColor 15%, transparent);
        }

        .s-intg-icon {
          width:30px; height:30px; border-radius:6px;
          background:var(--surface-2); border:1px solid var(--border);
          display:flex; align-items:center; justify-content:center;
          font-size:14px; flex-shrink:0;
        }

        .s-kbd {
          min-width:24px; height:24px;
          padding:0 6px; border-radius:5px;
          background:var(--bg); border:1px solid var(--border);
          display:inline-flex; align-items:center; justify-content:center;
          font-family:var(--font-mono); font-size:11px;
          color:var(--text-mute);
        }

        @media (max-width: 1024px) {
          .s-modal {
            width:min(1440px, calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
            height:calc(100vh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-width:calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            max-height:calc(100vh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-height:calc(100dvh - 32px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
          }
          .s-sidebar { width:200px; }
          .s-content { padding:24px 28px 40px; }
        }

        @media (max-width: 768px) {
          .s-modal {
            flex-direction:column;
            width:calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            height:calc(100vh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-width:calc(100vw - 24px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
            max-height:calc(100vh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
            max-height:calc(100dvh - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
          }
          .s-sidebar {
            width:100%;
            max-height:min(40vh, 280px);
            border-right:none;
            border-bottom:1px solid var(--border);
            flex-shrink:0;
          }
          .s-nav-list {
            flex:1 1 auto;
            overflow-x:auto;
            overflow-y:hidden;
            -webkit-overflow-scrolling:touch;
            display:flex;
            flex-direction:row;
            flex-wrap:nowrap;
            gap:6px;
            padding:4px 10px 10px;
            scrollbar-width:thin;
          }
          .s-nav {
            flex-shrink:0;
            margin-bottom:0;
            padding:10px 14px;
          }
          .s-content {
            flex:1;
            min-height:0;
            padding:20px 18px 32px;
            padding-top:max(20px, env(safe-area-inset-top, 0px));
          }
          .s-close {
            top:max(12px, env(safe-area-inset-top, 0px));
            right:max(12px, env(safe-area-inset-right, 0px));
            width:40px;
            height:40px;
            min-width:44px;
            min-height:44px;
          }
          .s-appearance-grid {
            grid-template-columns:1fr;
            gap:12px;
          }
        }

        @media (max-width: 520px) {
          .s-modal {
            width:100%;
            max-width:100%;
            height:100%;
            max-height:100%;
            top:0;
            left:0;
            transform:none;
            border-radius:0;
            border-left:none;
            border-right:none;
            height:100dvh;
            max-height:100dvh;
            padding-top:env(safe-area-inset-top, 0px);
            padding-bottom:env(safe-area-inset-bottom, 0px);
            padding-left:env(safe-area-inset-left, 0px);
            padding-right:env(safe-area-inset-right, 0px);
          }
          .s-content { padding:16px 14px 28px; }
          .s-pane-head h2 { font-size:18px !important; }
          .s-row {
            flex-wrap:wrap;
            align-items:flex-start;
            gap:12px;
          }
          .s-row > div:last-child {
            width:100%;
            display:flex;
            justify-content:flex-end;
          }
          .s-select { max-width:100%; }
        }

        @media (max-width: 768px) and (min-width: 521px) {
          .s-appearance-grid {
            grid-template-columns:repeat(2, minmax(0, 1fr));
          }
        }
      `}</style>
      </>
    </SettingsHydrationContext.Provider>
  );
  return ReactDOM.createPortal(tree, document.body);
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).SettingsModal = SettingsModal;
}
