import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShogunClerkAuth } from '@/shared/lib/clerk-auth';
import { ShogunIpcClient } from '@/shared/ipc/ipc-client';
import {
  billingCacheFromSections,
  billingCacheToPayload,
  fetchEntitlementFromWeb,
  isEntitlementActive,
  resolveEntitlement,
  type EntitlementStatus,
} from '@/shared/lib/entitlement';

type GateState =
  | { status: 'loading' }
  | { status: 'bypass' }
  | { status: 'error'; message: string }
  | { status: 'unauthenticated'; webAppUrl: string }
  | { status: 'paywall'; webAppUrl: string; entitlementStatus: EntitlementStatus; manageUrl?: string | null }
  | { status: 'ok' };

export function EntitlementGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GateState>({ status: 'loading' });
  const ipc = useMemo(function () {
    if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) return null;
    return ShogunIpcClient.createIpcClient();
  }, []);

  const refresh = useCallback(async function refreshEntitlement() {
    if (!ipc) {
      setGate({ status: 'bypass' });
      return;
    }

    setGate({ status: 'loading' });

    try {
      const billingRes = await ipc.invoke('billing_config', {});
      if (!billingRes.ok) {
        throw new Error(String((billingRes.error && billingRes.error.message) || 'billing config failed'));
      }
      const billingCfg = billingRes.data || {};
      if (!billingCfg.enabled || !billingCfg.webAppUrl) {
        setGate({ status: 'bypass' });
        return;
      }
      const webAppUrl = String(billingCfg.webAppUrl);

      await ShogunClerkAuth.init();

      if (!ShogunClerkAuth.isSignedIn()) {
        setGate({ status: 'unauthenticated', webAppUrl });
        return;
      }

      const settingsRes = await ipc.invoke('app_settings_load', {});
      const sections =
        settingsRes.ok && settingsRes.data && settingsRes.data.settings
          ? settingsRes.data.settings.sections
          : null;
      const cache = billingCacheFromSections(sections);

      let network = null;
      try {
        const token = await ShogunClerkAuth.getSessionToken();
        if (!token) {
          setGate({ status: 'unauthenticated', webAppUrl });
          return;
        }
        network = await fetchEntitlementFromWeb(webAppUrl, token);
      } catch (err) {
        console.warn('[EntitlementGate] network check failed, trying cache', err);
      }

      const resolved = resolveEntitlement({ network, cache });
      if (resolved.cache) {
        await ipc.invoke('app_settings_save', billingCacheToPayload(resolved.cache));
      }

      if (resolved.allowed) {
        setGate({ status: 'ok' });
        return;
      }

      setGate({
        status: 'paywall',
        webAppUrl,
        entitlementStatus: resolved.status,
        manageUrl: resolved.cache?.manageUrl || network?.manageUrl || null,
      });
    } catch (err: any) {
      setGate({
        status: 'error',
        message: String((err && err.message) || err || 'entitlement check failed'),
      });
    }
  }, [ipc]);

  useEffect(function () {
    void refresh();
  }, [refresh]);

  useEffect(function () {
    function onAuthChanged() {
      void refresh();
    }
    window.addEventListener('shogun-clerk-auth-changed', onAuthChanged);
    return function () {
      window.removeEventListener('shogun-clerk-auth-changed', onAuthChanged);
    };
  }, [refresh]);

  const openUrl = useCallback(async function (url: string) {
    if (!ipc) {
      window.open(url, '_blank');
      return;
    }
    await ipc.invoke('billing_open_url', { url });
  }, [ipc]);

  if (gate.status === 'loading') {
    return <div style={{ padding: 32, color: 'var(--text-dim)', fontSize: 13 }}>Checking subscription…</div>;
  }
  if (gate.status === 'bypass' || gate.status === 'ok') {
    return <>{children}</>;
  }
  if (gate.status === 'error') {
    return (
      <div style={{ padding: 32, fontSize: 13, maxWidth: 480 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Subscription check failed</div>
        <div style={{ color: 'var(--text-dim)', marginBottom: 16 }}>{gate.message}</div>
        <button type="button" className="btn btn-sm" onClick={function () { void refresh(); }}>
          Retry
        </button>
      </div>
    );
  }

  if (gate.status === 'unauthenticated') {
    return (
      <div style={{ padding: 48, maxWidth: 520, margin: '0 auto' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Sign in to continue</h1>
        <p style={{ color: 'var(--text-dim)', marginBottom: 24, lineHeight: 1.6 }}>
          <span className="en-only">Use the same account you registered with on the web.</span>
          <span className="jp">Web で登録したアカウントでサインインしてください。</span>
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-sm" onClick={function () { void ShogunClerkAuth.openSignIn(); }}>
            Sign in
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={function () { void ShogunClerkAuth.openSignUp(); }}>
            Create account
          </button>
        </div>
      </div>
    );
  }

  const manageUrl = gate.manageUrl || `${gate.webAppUrl}/account`;
  const statusLabel = isEntitlementActive(gate.entitlementStatus)
    ? gate.entitlementStatus
    : gate.entitlementStatus || 'none';

  return (
    <div style={{ padding: 48, maxWidth: 520, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, marginBottom: 12 }}>Subscription required</h1>
      <p style={{ color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.6 }}>
        <span className="en-only">
          An active trial or subscription is required to use SHOGUN AI.
        </span>
        <span className="jp">SHOGUN AI の利用には有効なトライアルまたはサブスクリプションが必要です。</span>
      </p>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 24 }}>
        Status: {statusLabel}
      </p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn btn-sm"
          onClick={function () { void openUrl(manageUrl); }}
        >
          Manage billing
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={function () { void refresh(); }}>
          Refresh
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={function () { void ShogunClerkAuth.signOut().then(function () { void refresh(); }); }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
