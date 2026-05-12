import { Icon, IntegrationLogo } from '@/shared/icons';
import { toastM } from '../../lib/runtime';

export interface GranolaTopPanelsProps {
  granola: any;
  // Share panel
  mtgTopShareOpen: boolean;
  mtgShareSearch: string;
  setMtgShareSearch: (v: string) => void;
  mtgShareOwner: { displayName: string; email: string };
  mtgLinkAccess: string;
  setMtgLinkAccess: (v: string) => void;
  mtgLinkBusy: boolean;
  mtgLinkAccessMenuOpen: boolean;
  setMtgLinkAccessMenuOpen: (fn: (v: boolean) => boolean) => void;
  copyMtgShareLink: () => Promise<void>;
  // More menu
  granolaMenuOpen: boolean;
  setGranolaMenuOpen: (fn: (v: boolean) => boolean) => void;
  mtgDraftEmail: () => void;
  mtgCopyAllText: () => void;
  runRuntimeActionM: (action: string, payload: any, opts: any) => any;
  applyStubTranscript: () => void;
  refreshSummary: () => void;
  refreshMinutes: () => void;
  ingestNoteToMemory: () => void;
  moveGranolaToTrash: () => void;
}

export function GranolaTopPanels(p: GranolaTopPanelsProps) {
  const {
    granola,
    mtgTopShareOpen,
    mtgShareSearch, setMtgShareSearch,
    mtgShareOwner,
    mtgLinkAccess, setMtgLinkAccess,
    mtgLinkBusy,
    mtgLinkAccessMenuOpen, setMtgLinkAccessMenuOpen,
    copyMtgShareLink,
    granolaMenuOpen, setGranolaMenuOpen,
    mtgDraftEmail, mtgCopyAllText,
    runRuntimeActionM,
    applyStubTranscript, refreshSummary, refreshMinutes,
    ingestNoteToMemory,
    moveGranolaToTrash,
  } = p;

  return (
    <>
      {mtgTopShareOpen && (
        <div
          className="granola-float mtg-share-panel"
          style={{
            top: 62,
            right: 18,
            width: 'min(360px, calc(100vw - 40px))',
            padding: 14,
            borderRadius: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border-hi)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 11,
          }}
          onMouseDown={function (e) { e.stopPropagation(); }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <input
              type="text"
              value={mtgShareSearch}
              onChange={function (e) { setMtgShareSearch(e.target.value); }}
              placeholder="Search people, folders, or emails"
              style={{
                flex: 1,
                minWidth: 0,
                padding: '10px 12px',
                borderRadius: 10,
                border: '1px solid color-mix(in srgb, var(--gold) 35%, var(--border-hi))',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
            <button
              type="button"
              disabled={!/\S+@\S+\.\S+/.test(mtgShareSearch)}
              onClick={function () {
                toastM('招待の送信はクラウド共有 API 接続後に有効になります（現在はローカル Hi-Fi）', 'info');
              }}
              style={{
                padding: '10px 14px',
                borderRadius: 10,
                border: 'none',
                fontWeight: 500,
                fontSize: 13,
                fontFamily: 'inherit',
                background: /\S+@\S+\.\S+/.test(mtgShareSearch)
                  ? 'color-mix(in srgb, var(--gold) 22%, var(--surface))'
                  : 'var(--surface-2)',
                color: /\S+@\S+\.\S+/.test(mtgShareSearch) ? 'var(--text)' : 'var(--text-mute)',
                cursor: /\S+@\S+\.\S+/.test(mtgShareSearch) ? 'pointer' : 'not-allowed',
                flexShrink: 0,
              }}
            >
              <span className="en-only">Share</span>
              <span className="jp" style={{ fontSize: 12 }}>共有</span>
            </button>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 4px',
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 999,
                background: 'var(--surface-2)',
                border: '1px solid var(--border-hi)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--text-mute)',
                flexShrink: 0,
              }}
            >
              {(mtgShareOwner.displayName || 'U').trim().charAt(0).toUpperCase()}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                {mtgShareOwner.displayName || granola.authorLabel || 'You'}
                <span style={{ color: 'var(--text-mute)', fontWeight: 400 }}> (you)</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-mute)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {mtgShareOwner.email || '—'}
              </div>
            </div>
            <span style={{ fontSize: 12, color: 'var(--text-mute)', flexShrink: 0 }}>Owner</span>
          </div>
          <div style={{ borderTop: '1px solid var(--border-hi)', margin: '10px 0' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 140 }}>
              <button
                type="button"
                onClick={function () { setMtgLinkAccessMenuOpen(function (v) { return !v; }); }}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 10px',
                  borderRadius: 10,
                  border: '1px solid var(--border-hi)',
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  width: '100%',
                  justifyContent: 'flex-start',
                }}
              >
                <Icon name="globe" size={14} />
                <span className="en-only" style={{ flex: 1, textAlign: 'left' }}>
                  {mtgLinkAccess === 'anyone' ? 'Anyone with the link' : 'Restricted'}
                </span>
                <span className="jp" style={{ fontSize: 11, color: 'var(--text-mute)' }}>
                  {mtgLinkAccess === 'anyone' ? 'リンクを知っている全員' : '制限付き'}
                </span>
                <Icon name="chevronDown" size={12} />
              </button>
              {mtgLinkAccessMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: 0,
                    right: 0,
                    marginBottom: 4,
                    padding: 6,
                    borderRadius: 10,
                    background: 'var(--surface)',
                    border: '1px solid var(--border-hi)',
                    boxShadow: 'var(--shadow-lg)',
                    zIndex: 2,
                  }}
                >
                  <button
                    type="button"
                    onClick={function () {
                      setMtgLinkAccess('anyone');
                      setMtgLinkAccessMenuOpen(function () { return false; });
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 8px',
                      border: 'none',
                      borderRadius: 8,
                      background: mtgLinkAccess === 'anyone' ? 'var(--surface-2)' : 'transparent',
                      color: 'var(--text)',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Anyone with the link can view
                  </button>
                  <button
                    type="button"
                    onClick={function () {
                      setMtgLinkAccess('restricted');
                      setMtgLinkAccessMenuOpen(function () { return false; });
                    }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 8px',
                      border: 'none',
                      borderRadius: 8,
                      background: mtgLinkAccess === 'restricted' ? 'var(--surface-2)' : 'transparent',
                      color: 'var(--text)',
                      fontSize: 12,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Restricted (signed-in only)
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              disabled={mtgLinkBusy}
              onClick={function () { void copyMtgShareLink(); }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 12px',
                borderRadius: 10,
                border: '1px solid var(--border-hi)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: 12,
                fontWeight: 500,
                cursor: mtgLinkBusy ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Icon name="link" size={14} />
              <span className="en-only">Copy link</span>
              <span className="jp" style={{ fontSize: 11 }}>リンクをコピー</span>
            </button>
          </div>
        </div>
      )}

      {granolaMenuOpen && (
        <div
          className="granola-float mtg-more-menu"
          style={{
            top: 62,
            right: 18,
            left: 'auto',
            bottom: 'auto',
            transform: 'none',
            width: 'min(300px, calc(100vw - 48px))',
            padding: 8,
            borderRadius: 14,
            background: 'var(--surface)',
            border: '1px solid var(--border-hi)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 12,
          }}
        >
          {[
            {
              fn: function () {
                mtgDraftEmail();
                setGranolaMenuOpen(function () { return false; });
              },
              en: 'Draft email',
              jp: 'メール下書き',
              icon: 'mail',
            },
            {
              fn: function () {
                mtgCopyAllText();
                setGranolaMenuOpen(function () { return false; });
              },
              en: 'Copy text',
              jp: 'テキストをコピー',
              icon: 'copy',
            },
            {
              fn: function () {
                void runRuntimeActionM('integrations.connect', { provider: 'slack' }, { silentError: true });
                setGranolaMenuOpen(function () { return false; });
              },
              en: 'Connect Slack',
              jp: 'Slack を接続',
              logo: 'slack',
            },
          ].map(function (row, idx) {
            return (
              <button
                key={idx}
                type="button"
                onClick={row.fn}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 10px',
                  marginBottom: 2,
                  border: 'none',
                  borderRadius: 10,
                  background: 'transparent',
                  color: 'var(--text)',
                  fontSize: 13,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {row.logo ? (
                  <IntegrationLogo slug={row.logo} size={22} title={row.en} />
                ) : (
                  <Icon name={(row.icon || '') as any} size={16} />
                )}
                <span>
                  <span className="en-only">{row.en}</span>
                  <span className="jp" style={{ fontSize: 12, display: 'block', color: 'var(--text-mute)' }}>
                    {row.jp}
                  </span>
                </span>
              </button>
            );
          })}
          {[
            { en: 'Send to Zapier', jp: 'Zapier へ', slug: 'zapier_mcp' },
            { en: 'Save to Notion', jp: 'Notion へ', slug: 'notion' },
            { en: 'Save to HubSpot', jp: 'HubSpot へ', slug: null },
          ].map(function (row, idx) {
            return (
              <div
                key={'dis-' + idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 10px',
                  marginBottom: 2,
                  borderRadius: 10,
                  opacity: 0.45,
                  pointerEvents: 'none',
                  color: 'var(--text-mute)',
                  fontSize: 13,
                }}
              >
                {row.slug ? (
                  <IntegrationLogo slug={row.slug} size={22} title={row.en} />
                ) : (
                  <Icon name="plug" size={16} />
                )}
                <span>
                  <span className="en-only">{row.en}</span>
                  <span className="jp" style={{ fontSize: 11 }}>{row.jp}</span>
                </span>
              </div>
            );
          })}
          <div style={{ borderTop: '1px solid var(--border-hi)', margin: '8px 0 6px' }} />
          <div style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--text-mute)', padding: '0 10px 6px', textTransform: 'uppercase' }}>
            <span className="en-only">Local</span>
            <span className="jp" style={{ marginLeft: 6 }}>ローカル</span>
          </div>
          {[
            { fn: applyStubTranscript, en: 'Insert transcript template', jp: 'テンプレ文字起こし' },
            { fn: refreshSummary, en: 'Refresh summary (rules)', jp: '要約を更新（ルール）' },
            { fn: refreshMinutes, en: 'Build minutes (rules)', jp: '議事録（ルール）' },
            { fn: ingestNoteToMemory, en: 'Save to Memory', jp: 'Memory に保存' },
          ].map(function (row, idx) {
            return (
              <button
                key={'loc-' + idx}
                type="button"
                onClick={function () { row.fn(); setGranolaMenuOpen(function () { return false; }); }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  marginBottom: 2,
                  border: 'none',
                  borderRadius: 8,
                  background: 'color-mix(in srgb, var(--surface-2) 70%, transparent)',
                  color: 'var(--text-mute)',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span className="en-only">{row.en}</span>
                <span className="jp" style={{ fontSize: 11 }}>{row.jp}</span>
              </button>
            );
          })}
          <div style={{ borderTop: '1px solid var(--border-hi)', margin: '6px 0' }} />
          <button
            type="button"
            onClick={function () {
              moveGranolaToTrash();
              setGranolaMenuOpen(function () { return false; });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              textAlign: 'left',
              padding: '10px 10px',
              border: 'none',
              borderRadius: 10,
              background: 'transparent',
              color: '#c45c3e',
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Icon name="trash" size={16} />
            <span className="en-only">Move to trash</span>
            <span className="jp" style={{ fontSize: 12 }}>ゴミ箱へ移動</span>
          </button>
        </div>
      )}
    </>
  );
}
