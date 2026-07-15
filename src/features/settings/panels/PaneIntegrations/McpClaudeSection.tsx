import React from 'react';
import { Icon, IntegrationLogo } from '@/shared/icons';
import { ShogunIpcClient } from '@/shared/ipc/ipc-client';
import { McpToolConsolePanel } from '@/shared/context/McpToolConsolePanel';

type DetectStatus = {
  claudeConfigPath?: string;
  claudeConfigExists?: boolean;
  claudeInstalled?: boolean;
  binaryPath?: string | null;
  binaryFound?: boolean;
  shogunConfigured?: boolean;
  configuredCommand?: string | null;
  configValid?: boolean;
};

function runtimeToast(message: string, kind: 'success' | 'warn' | 'info' = 'info') {
  (window as any).SHOGUN_RUNTIME?.pushToast?.(message, kind);
}

export function McpClaudeSection(): JSX.Element | null {
  const ipc = React.useMemo(() => {
    if (!ShogunIpcClient || !ShogunIpcClient.createIpcClient) return null;
    return ShogunIpcClient.createIpcClient();
  }, []);
  const [detect, setDetect] = React.useState<DetectStatus | null>(null);
  const [binaryPath, setBinaryPath] = React.useState('');
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState('');
  const [verifyState, setVerifyState] = React.useState<boolean | null>(null);

  const refreshDetect = React.useCallback(async () => {
    if (!ipc) return;
    setBusyAction('refresh');
    setMessage('');
    const res = await ipc.invoke('mcp_setup_detect', {});
    setBusyAction(null);
    if (!res.ok) {
      setMessage(String(res.error?.message || 'Failed to load Claude Desktop MCP status'));
      return;
    }
    const next = (res.data || {}) as DetectStatus;
    setDetect(next);
    setBinaryPath(String(next.configuredCommand || next.binaryPath || ''));
  }, [ipc]);

  React.useEffect(() => {
    void refreshDetect();
  }, [refreshDetect]);

  if (!ipc) return null;

  const saveConfig = async () => {
    setBusyAction('write');
    setMessage('');
    const trimmed = binaryPath.trim();
    const res = await ipc.invoke(
      'mcp_setup_write_config',
      trimmed ? { binaryPath: trimmed } : {},
    );
    setBusyAction(null);
    if (!res.ok) {
      const nextMessage = String(res.error?.message || 'Failed to save Claude Desktop config');
      setMessage(nextMessage);
      runtimeToast(nextMessage, 'warn');
      return;
    }
    const backupPath = String(res.data?.backupPath || '').trim();
    setMessage(
      backupPath
        ? `Saved Claude Desktop config and backed up the previous file to ${backupPath}.`
        : 'Saved Claude Desktop config for SHOGUN MCP.',
    );
    runtimeToast('Saved SHOGUN MCP config for Claude Desktop', 'success');
    await refreshDetect();
  };

  const verifySetup = async () => {
    setBusyAction('verify');
    setMessage('');
    const res = await ipc.invoke('mcp_setup_verify', {});
    setBusyAction(null);
    if (!res.ok) {
      const nextMessage = String(res.error?.message || 'Failed to verify Claude Desktop MCP setup');
      setVerifyState(false);
      setMessage(nextMessage);
      runtimeToast(nextMessage, 'warn');
      return;
    }
    const ok = res.data?.ok === true;
    setVerifyState(ok);
    if (ok) {
      setMessage(`Claude Desktop will use ${String(res.data?.command || '').trim() || 'the configured SHOGUN MCP binary'}.`);
      runtimeToast('Claude Desktop MCP connection looks good', 'success');
      void ipc.invoke('mcp_setup_complete', { skipped: false });
    } else {
      const reason = String(res.data?.reason || 'unknown');
      setMessage(`Setup incomplete: ${reason}`);
      runtimeToast(`MCP setup incomplete: ${reason}`, 'warn');
    }
    await refreshDetect();
  };

  const openClaude = async () => {
    setBusyAction('open-claude');
    const res = await ipc.invoke('mcp_setup_open_claude_app', {});
    setBusyAction(null);
    if (!res.ok) {
      runtimeToast(String(res.error?.message || 'Failed to open Claude Desktop'), 'warn');
      return;
    }
    runtimeToast('Opened Claude Desktop', 'info');
  };

  const openConfigFolder = async () => {
    setBusyAction('open-config');
    const res = await ipc.invoke('mcp_setup_open_claude_config', {});
    setBusyAction(null);
    if (!res.ok) {
      runtimeToast(String(res.error?.message || 'Failed to open Claude config folder'), 'warn');
      return;
    }
    runtimeToast('Opened Claude Desktop config folder', 'info');
  };

  const resolvedBinary = binaryPath.trim() || String(detect?.binaryPath || '').trim();

  return (
    <div className="s-card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ padding: '14px 16px' }}>
        <IntegrationLogo slug="claude" size={30} title="Claude" />
        <div style={{ marginLeft: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Claude Desktop / SHOGUN MCP</div>
          <div className="s-field-hint">Manage the read-only SHOGUN MCP bridge that exposes shared context to Claude Desktop from this Mac app.</div>
        </div>
        <span className="spacer" />
        <Icon name="terminal" size={12} className="dim" />
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <span className={'label ' + (detect?.claudeInstalled ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
          {detect?.claudeInstalled ? 'Claude installed' : 'Claude not found'}
        </span>
        <span className={'label ' + (detect?.shogunConfigured ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
          {detect?.shogunConfigured ? 'SHOGUN configured' : 'SHOGUN not configured'}
        </span>
        <span className={'label ' + (detect?.binaryFound ? 'label-success' : '')} style={{ borderColor: 'var(--border)' }}>
          {detect?.binaryFound ? 'shogun-mcp found' : 'shogun-mcp missing'}
        </span>
        {detect?.configValid === false ? (
          <span className="label" style={{ borderColor: 'var(--border)' }}>Config needs repair</span>
        ) : null}
        {verifyState === true ? (
          <span className="label label-success" style={{ borderColor: 'var(--border)' }}>Verified</span>
        ) : verifyState === false ? (
          <span className="label" style={{ borderColor: 'var(--border)' }}>Not verified</span>
        ) : null}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
        <div className="s-field-hint" style={{ marginBottom: 8 }}>
          Claude config: {detect?.claudeConfigPath || 'Detecting…'}
        </div>
        <label style={{ display: 'block', fontSize: 12, color: 'var(--text-mute)', marginBottom: 6 }}>
          SHOGUN MCP binary path
        </label>
        <input
          className="s-input"
          value={binaryPath}
          onChange={(e) => setBinaryPath(e.target.value)}
          placeholder={String(detect?.binaryPath || '/path/to/shogun-mcp')}
          style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
        />
        <div className="s-field-hint" style={{ lineHeight: 1.55 }}>
          Current command: {resolvedBinary || 'Auto-detect on save'}
        </div>
        {message ? (
          <div className="s-field-hint" style={{ marginTop: 8, lineHeight: 1.55 }}>
            {message}
          </div>
        ) : null}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <button className="btn btn-sm btn-secondary" type="button" disabled={busyAction === 'refresh'} onClick={() => { void refreshDetect(); }}>
          {busyAction === 'refresh' ? 'Refreshing…' : 'Refresh status'}
        </button>
        <button className="btn btn-sm btn-primary" type="button" disabled={!!busyAction || !resolvedBinary} onClick={() => { void saveConfig(); }}>
          {busyAction === 'write' ? 'Saving…' : detect?.shogunConfigured ? 'Repair config' : 'Save to Claude'}
        </button>
        <button className="btn btn-sm btn-secondary" type="button" disabled={!!busyAction} onClick={() => { void verifySetup(); }}>
          {busyAction === 'verify' ? 'Verifying…' : 'Verify'}
        </button>
        <button className="btn btn-sm btn-ghost" type="button" disabled={!!busyAction} onClick={() => { void openClaude(); }}>
          Open Claude
        </button>
        <button className="btn btn-sm btn-ghost" type="button" disabled={!!busyAction} onClick={() => { void openConfigFolder(); }}>
          Open config folder
        </button>
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
        <McpToolConsolePanel />
      </div>
    </div>
  );
}
