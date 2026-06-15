import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ShogunIpcClient } from '@/shared/ipc/ipc-client';

type DetectStatus = {
  claudeConfigPath?: string;
  claudeConfigExists?: boolean;
  claudeInstalled?: boolean;
  binaryPath?: string | null;
  binaryFound?: boolean;
  shogunConfigured?: boolean;
  configuredCommand?: string | null;
};

type GateState =
  | { status: 'loading' }
  | { status: 'bypass' }
  | { status: 'ok' }
  | { status: 'wizard'; detect: DetectStatus };

function isMcpComplete(sections: Record<string, unknown> | null | undefined): boolean {
  const raw = sections && sections.onboarding;
  if (!raw || typeof raw !== 'object') return false;
  return Boolean((raw as Record<string, unknown>).mcpComplete);
}

function McpSetupWizard({
  detect,
  onComplete,
  ipc,
}: {
  detect: DetectStatus;
  onComplete: () => void;
  ipc: ReturnType<typeof ShogunIpcClient.createIpcClient>;
}) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [binaryPath, setBinaryPath] = useState(detect.binaryPath || detect.configuredCommand || '');
  const [message, setMessage] = useState('');
  const [verifyOk, setVerifyOk] = useState<boolean | null>(null);

  const writeConfig = useCallback(async function () {
    setBusy(true);
    setMessage('');
    const res = await ipc.invoke('mcp_setup_write_config', {
      binaryPath: binaryPath.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setMessage(String((res.error && res.error.message) || 'Failed to write config'));
      return;
    }
    setMessage('Configuration saved. Restart Claude Desktop to connect.');
    setStep(4);
  }, [binaryPath, ipc]);

  const runVerify = useCallback(async function () {
    setBusy(true);
    const res = await ipc.invoke('mcp_setup_verify', {});
    setBusy(false);
    if (!res.ok) {
      setVerifyOk(false);
      setMessage(String((res.error && res.error.message) || 'Verification failed'));
      return;
    }
    setVerifyOk(Boolean(res.data && res.data.ok));
    if (res.data && res.data.ok) {
      setMessage('MCP connection looks good.');
    } else {
      setMessage(`Setup incomplete: ${String((res.data && res.data.reason) || 'unknown')}`);
    }
  }, [ipc]);

  const finish = useCallback(async function (skipped = false) {
    setBusy(true);
    const res = await ipc.invoke('mcp_setup_complete', { skipped });
    setBusy(false);
    if (!res.ok) {
      setMessage(String((res.error && res.error.message) || 'Could not save completion'));
      return;
    }
    onComplete();
  }, [ipc, onComplete]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: 'rgba(10,9,8,0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          padding: 28,
          maxWidth: 560,
          width: '92%',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
          Connect Claude Desktop
        </div>
        <div className="t-mono" style={{ color: 'var(--text-mute)', marginBottom: 20 }}>
          Step {step} of 4
        </div>

        {step === 1 && (
          <>
            <p style={{ lineHeight: 1.6, color: 'var(--text-dim)', marginTop: 0 }}>
              <span className="en-only">
                SHOGUN exposes your local memory to Claude via MCP. We will add SHOGUN to Claude Desktop&apos;s config automatically.
              </span>
              <span className="jp">
                SHOGUN のローカルメモリを Claude から使えるよう、MCP 接続を設定します。
              </span>
            </p>
            <ul style={{ lineHeight: 1.7, color: 'var(--text-dim)', paddingLeft: 18 }}>
              <li>Claude Desktop: {detect.claudeInstalled ? 'installed' : 'not found in /Applications'}</li>
              <li>Config: {detect.claudeConfigExists ? detect.claudeConfigPath : 'will be created'}</li>
              <li>SHOGUN MCP: {detect.shogunConfigured ? 'already configured' : 'not configured yet'}</li>
            </ul>
          </>
        )}

        {step === 2 && (
          <>
            <div className="t-sm" style={{ marginBottom: 8 }}>shogun-mcp binary path</div>
            <input
              className="input"
              value={binaryPath}
              onChange={(e) => setBinaryPath(e.target.value)}
              placeholder="/path/to/shogun-mcp"
              style={{ width: '100%', boxSizing: 'border-box', marginBottom: 10 }}
            />
            {!detect.binaryFound && (
              <div className="t-cap" style={{ color: 'var(--warning)', lineHeight: 1.5 }}>
                Build the binary: cargo build --manifest-path src-tauri/Cargo.toml --bin shogun-mcp
              </div>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <p style={{ lineHeight: 1.6, color: 'var(--text-dim)', marginTop: 0 }}>
              We will merge a <code className="mono">shogun</code> entry into Claude&apos;s MCP config
              (existing entries are preserved; a backup is created).
            </p>
            <div className="t-cap" style={{ color: 'var(--text-mute)', marginBottom: 12 }}>
              Command: {binaryPath || detect.binaryPath || '(auto-detect)'}
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <p style={{ lineHeight: 1.6, color: 'var(--text-dim)', marginTop: 0 }}>
              Restart Claude Desktop, start a new chat, and look for the tools icon with SHOGUN tools.
            </p>
            {verifyOk === true && (
              <div className="t-cap" style={{ color: 'var(--success)', marginBottom: 10 }}>Verified</div>
            )}
            {verifyOk === false && (
              <div className="t-cap" style={{ color: 'var(--warning)', marginBottom: 10 }}>Not verified yet</div>
            )}
          </>
        )}

        {message && (
          <div className="t-sm" style={{ color: 'var(--text-mute)', marginTop: 12, lineHeight: 1.5 }}>
            {message}
          </div>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'space-between', marginTop: 22, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={busy}
            onClick={() => void finish(true)}
          >
            Skip for now
          </button>
          <div className="row" style={{ gap: 8 }}>
            {step > 1 && step < 4 && (
              <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setStep((s) => s - 1)}>
                Back
              </button>
            )}
            {step === 1 && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setStep(2)}>
                Continue
              </button>
            )}
            {step === 2 && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !(binaryPath.trim() || detect.binaryPath)}
                onClick={() => setStep(3)}
              >
                Continue
              </button>
            )}
            {step === 3 && (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void writeConfig()}>
                {busy ? 'Writing…' : 'Write config'}
              </button>
            )}
            {step === 4 && (
              <>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  disabled={busy}
                  onClick={() => void ipc.invoke('mcp_setup_open_claude_app', {})}
                >
                  Open Claude
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void runVerify()}>
                  Verify
                </button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void finish(false)}>
                  Done
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function McpSetupGate({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<GateState>({ status: 'loading' });
  const ipc = useMemo(function () {
    if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) return null;
    return ShogunIpcClient.createIpcClient();
  }, []);

  const refresh = useCallback(async function () {
    if (!ipc) {
      setGate({ status: 'bypass' });
      return;
    }

    const settingsRes = await ipc.invoke('app_settings_load', {});
    const sections =
      settingsRes.ok && settingsRes.data && settingsRes.data.settings
        ? settingsRes.data.settings.sections
        : null;

    if (isMcpComplete(sections)) {
      setGate({ status: 'ok' });
      return;
    }

    const detectRes = await ipc.invoke('mcp_setup_detect', {});
    if (!detectRes.ok) {
      setGate({ status: 'bypass' });
      return;
    }

    setGate({ status: 'wizard', detect: (detectRes.data || {}) as DetectStatus });
  }, [ipc]);

  useEffect(function () {
    void refresh();
  }, [refresh]);

  if (gate.status === 'loading') {
    return <div style={{ padding: 32, color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>;
  }
  if (gate.status === 'bypass' || gate.status === 'ok') {
    return <>{children}</>;
  }

  if (gate.status === 'wizard' && ipc) {
    return (
      <McpSetupWizard
        detect={gate.detect}
        ipc={ipc}
        onComplete={function () { setGate({ status: 'ok' }); }}
      />
    );
  }

  return <div style={{ padding: 32, color: 'var(--text-dim)', fontSize: 13 }}>Loading…</div>;
}
