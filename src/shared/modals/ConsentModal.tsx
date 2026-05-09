import { useState, useEffect, useRef } from 'react';

export function ConsentModal(props: any) {
  const initialLang = props.initialLang === 'ja' ? 'ja' : 'en';
  const termsVersion = String(props.termsVersion || '');
  const privacyVersion = String(props.privacyVersion || '');
  const onAccept = props.onAccept || function noop() {};
  const onDecline = props.onDecline || function noop() {};
  const loadDocs = props.loadDocs; // (lang) => Promise<{terms, privacy}>
  const renderMarkdown = props.renderMarkdown; // (text) => htmlString

  const [lang, setLang] = useState(initialLang);
  const [docs, setDocs] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [telemetryOptIn, setTelemetryOptIn] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [decliningUntil, setDecliningUntil] = useState<number | null>(null);
  const agreeRef = useRef<HTMLInputElement | null>(null);
  const focusedOnceRef = useRef(false);

  useEffect(() => {
    // Move keyboard focus into the modal the first time the I-agree
    // checkbox becomes focusable (it's `disabled={docs == null || saving}`).
    // Focusing a disabled element is a no-op, so we wait until docs load.
    // The `focusedOnceRef` guard prevents re-stealing focus later if
    // `saving` flips back to false after a save error.
    // No focus trap — the gate replaces App entirely so there is no
    // background DOM to escape into.
    if (docs != null && !saving && !focusedOnceRef.current && agreeRef.current) {
      focusedOnceRef.current = true;
      agreeRef.current.focus();
    }
  }, [docs, saving]);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    setLoadError(null);
    Promise.resolve(loadDocs(lang))
      .then((d: any) => {
        if (cancelled) return;
        setDocs(d);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setLoadError(String(e && e.message ? e.message : e));
      });
    return function () {
      cancelled = true;
    };
  }, [lang, loadDocs]);

  useEffect(() => {
    if (decliningUntil == null) return;
    const ms = Math.max(0, decliningUntil - Date.now());
    const t = setTimeout(function () {
      onDecline();
    }, ms);
    return function () {
      clearTimeout(t);
    };
  }, [decliningUntil, onDecline]);

  function handleAccept() {
    setSaving(true);
    setSaveError(null);
    Promise.resolve(
      onAccept({
        termsVersion: termsVersion,
        privacyVersion: privacyVersion,
        telemetryOptIn: telemetryOptIn,
      }),
    ).catch(function (e: any) {
      setSaving(false);
      setSaveError(String(e && e.message ? e.message : e));
    });
  }

  function handleDecline() {
    setDecliningUntil(Date.now() + 1500);
  }

  const declining = decliningUntil != null;

  return (
    <>
      <div className="swm-backdrop" role="presentation" />
      <div
        className="swm-modal swm-modal--consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="consent-modal-title"
        onMouseDown={function (e) {
          e.stopPropagation();
        }}
      >
        {declining ? (
          <div className="swm-body" style={{ textAlign: 'center', padding: 32 }}>
            <div id="consent-modal-title" style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
              Goodbye.
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>
              SHOGUN AI requires acceptance of the Terms to continue.
            </div>
          </div>
        ) : (
          <>
            <div className="swm-header">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div id="consent-modal-title" style={{ fontSize: 15, fontWeight: 600 }}>
                  Welcome to SHOGUN AI
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button
                    type="button"
                    className={'btn btn-sm ' + (lang === 'ja' ? 'btn-primary' : 'btn-ghost')}
                    onClick={function () { setLang('ja'); }}
                    aria-pressed={lang === 'ja'}
                  >
                    JP
                  </button>
                  <button
                    type="button"
                    className={'btn btn-sm ' + (lang === 'en' ? 'btn-primary' : 'btn-ghost')}
                    onClick={function () { setLang('en'); }}
                    aria-pressed={lang === 'en'}
                  >
                    EN
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>
                Please review and accept the Terms of Service and Privacy Policy before continuing.
              </div>
            </div>
            <div
              className="swm-body swm-body--consent"
              style={{ maxHeight: 420, overflowY: 'auto' }}
            >
              {loadError ? (
                <div style={{ color: 'var(--danger, #d33)' }}>
                  Failed to load legal documents: {loadError}. Please reinstall the application.
                </div>
              ) : docs == null ? (
                <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
              ) : (
                <>
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(docs.terms) }} />
                  <hr style={{ margin: '16px 0', border: 0, borderTop: '1px solid var(--border, #ccc)' }} />
                  <div dangerouslySetInnerHTML={{ __html: renderMarkdown(docs.privacy) }} />
                </>
              )}
            </div>
            <div className="swm-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
              {saveError ? (
                <div
                  style={{
                    color: 'var(--danger, #d33)',
                    background: 'var(--danger-bg, rgba(220,80,80,0.1))',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                  }}
                >
                  Could not save consent: {saveError}. Please try again.
                </div>
              ) : null}
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  ref={agreeRef}
                  type="checkbox"
                  checked={agreed}
                  disabled={docs == null || saving}
                  onChange={function (e) { setAgreed(e.target.checked); }}
                />
                I agree to the Terms of Service and Privacy Policy
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={telemetryOptIn}
                  disabled={saving}
                  onChange={function (e) { setTelemetryOptIn(e.target.checked); }}
                />
                Send anonymous usage telemetry (optional)
              </label>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={handleDecline}
                  disabled={saving}
                >
                  Decline & Quit
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleAccept}
                  disabled={!agreed || saving || docs == null}
                >
                  Accept & Continue
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      <style>{`
        .swm-backdrop {
          position: fixed; inset: 0; z-index: 1150;
          background: rgba(10, 9, 8, 0.55);
        }
        .swm-modal {
          position: fixed; z-index: 1151;
          top: 50%; left: 50%; transform: translate(-50%, -50%);
          box-sizing: border-box;
          width: min(560px, calc(100vw - 32px));
          max-width: calc(100vw - 32px);
          max-height: calc(100vh - 32px);
          max-height: calc(100dvh - 32px);
          overflow: auto;
          background: var(--surface); border: 1px solid var(--border-hi);
          border-radius: var(--radius-lg);
          box-shadow: 0 24px 48px -12px rgba(0,0,0,0.6);
        }
        .swm-modal--consent { width: min(680px, calc(100vw - 32px)); }
        .swm-header { padding: 16px 18px; border-bottom: 1px solid var(--border); }
        .swm-body { padding: 16px 18px; }
        .swm-body--consent { padding: 16px 18px; line-height: 1.5; }
        .swm-body--consent h2 { font-size: 14px; margin: 16px 0 6px; }
        .swm-body--consent h3 { font-size: 13px; margin: 12px 0 4px; }
        .swm-body--consent p, .swm-body--consent li { font-size: 12px; margin: 4px 0; }
        .swm-body--consent ul { padding-left: 20px; margin: 4px 0; }
        .swm-footer {
          padding: 12px 18px 16px; border-top: 1px solid var(--border);
          display: flex; justify-content: flex-end; gap: 8px;
        }
      `}</style>
    </>
  );
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ConsentModal = ConsentModal;
}
