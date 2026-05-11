// AppCore (consent gate) extracted from App.tsx (Phase 2 Step 11)
import React, { useState, useEffect, useCallback } from 'react';
import { ConsentModal } from '@/shared/modals';
import { MainApp } from './MainApp';

export function AppCore(): React.ReactElement {
  // ───────── Consent gate (TOS / Privacy) ─────────
  // All IPC goes through ShogunIpcClient so the payload is wrapped as
  // `{ payload: ... }` (Rust commands take `payload: Value`) and the
  // Tauri v2 `__TAURI_INTERNALS__.invoke` path is preferred over the v1
  // `__TAURI__.core.invoke` fallback. The client's invoke returns
  // `{ ok, data, error }` instead of throwing.
  const [legalGate, setLegalGate] = useState<any>({ status: "loading" });

  const consentClient = React.useMemo(function () {
    const w = window as any;
    if (!w.ShogunIpcClient || !w.ShogunIpcClient.createIpcClient) return null;
    return w.ShogunIpcClient.createIpcClient();
  }, []);

  useEffect(function loadConsentState() {
    let cancelled = false;
    const versions = (window as any).SHOGUN_LEGAL_VERSIONS || {};
    const expectedTerms = versions.TERMS_VERSION || "";
    const expectedPrivacy = versions.PRIVACY_VERSION || "";
    const lang = (navigator.language || "en").toLowerCase().startsWith("ja") ? "ja" : "en";

    if (!consentClient) {
      // Browser preview without ShogunIpcClient — bypass the gate so the wireframe page still loads.
      setLegalGate({ status: "ok" });
      return function () {};
    }

    consentClient
      .invoke("app_settings_load", {})
      .then(function (res: any) {
        if (cancelled) return;
        if (!res.ok) {
          setLegalGate({
            status: "error",
            message: String((res.error && res.error.message) || "settings load failed"),
          });
          return;
        }
        const sec =
          (res.data && res.data.settings && res.data.settings.sections && res.data.settings.sections.legal) ||
          null;
        const ok =
          sec &&
          sec.termsAcceptedVersion === expectedTerms &&
          sec.privacyAcceptedVersion === expectedPrivacy;
        setLegalGate(ok ? { status: "ok" } : { status: "consent_needed", lang: lang });
      })
      .catch(function (err: any) {
        // ShogunIpcClient.invoke is supposed to return {ok:false} rather
        // than throw, but defend against unexpected sync throws (e.g. from
        // withTimeout) so the gate doesn't get stuck on "loading".
        if (cancelled) return;
        setLegalGate({
          status: "error",
          message: String((err && err.message) || err || "settings load failed"),
        });
      });
    return function () {
      cancelled = true;
    };
  }, [consentClient]);

  const handleConsentAccept = useCallback(function (payload: any) {
    if (!consentClient) return Promise.resolve();
    return consentClient
      .invoke("app_settings_save", {
        section: "legal",
        termsAcceptedVersion: payload.termsVersion,
        privacyAcceptedVersion: payload.privacyVersion,
        telemetryOptIn: payload.telemetryOptIn,
        acceptedAt: new Date().toISOString(),
      })
      .then(function (res: any) {
        if (!res.ok) {
          throw new Error(String((res.error && res.error.message) || "save failed"));
        }
        setLegalGate({ status: "ok" });
      });
  }, [consentClient]);

  const handleConsentDecline = useCallback(function () {
    if (!consentClient) return;
    consentClient.invoke("app_quit", {}).catch(function () {
      try { window.close(); } catch (_) {}
    });
  }, [consentClient]);

  const loadConsentDocs = useCallback(function (lang: string) {
    if (!consentClient) {
      return Promise.resolve({ terms: "# Preview mode\nNo documents loaded.", privacy: "" });
    }
    return consentClient.invoke("legal_docs_load", { lang: lang }).then(function (res: any) {
      if (!res.ok) {
        throw new Error(String((res.error && res.error.message) || "legal docs load failed"));
      }
      return res.data;
    });
  }, [consentClient]);

  if (legalGate.status === "loading") {
    return (
      <div style={{ padding: 32, color: "var(--text-dim)", fontSize: 13 }}>Loading…</div>
    );
  }
  if (legalGate.status === "error") {
    return (
      <div style={{ padding: 32, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Failed to load settings</div>
        <div style={{ color: "var(--text-dim)" }}>
          {legalGate.message}. Please restart the app.
        </div>
        <div style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={function () {
              if (consentClient) consentClient.invoke("app_quit", {}).catch(function () {});
            }}
          >
            Quit
          </button>
        </div>
      </div>
    );
  }
  if (legalGate.status === "consent_needed") {
    const versions = (window as any).SHOGUN_LEGAL_VERSIONS || {};
    return (
      <ConsentModal
        initialLang={legalGate.lang}
        termsVersion={versions.TERMS_VERSION || ""}
        privacyVersion={versions.PRIVACY_VERSION || ""}
        onAccept={handleConsentAccept}
        onDecline={handleConsentDecline}
        loadDocs={loadConsentDocs}
        renderMarkdown={(window as any).shogunMarkdownMini}
      />
    );
  }
  // ───────── End consent gate; main app continues below. ─────────
  return <MainApp />;
}
