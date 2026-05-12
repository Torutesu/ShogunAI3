// Phase 2.1.4 T5 — Cloud Mirror pane (ported from hifi/settings-modal.jsx).
//
// Renders one of three states based on `mirror.status`:
//   - Disabled  → onboarding CTA + 4-step setup wizard
//   - Locked    → passphrase prompt (Mirror enabled, master key not loaded)
//   - Active    → status row + sync / devices / privacy cards + danger zone
// All IPC goes through the existing `mirror.*` runtime actions registered
// in `src/shared/ipc/action-registry.ts`.

// autoFocus is intentionally used on wizard / confirm modals — these are
// dialog overlays where focusing the primary input on open is expected UX
// (matches the legacy hifi/settings-modal.jsx Cloud Mirror pane behavior).
/* eslint-disable jsx-a11y/no-autofocus */

import React from 'react';
import { Pane } from '../components/Pane';
import { useRuntimeActions } from '../lib/hooks';
import { SettingsHydrationContext } from '../types';

type RunFn = (key: string, payload?: any, options?: any) => Promise<any>;
type ToastFn = (message: string, kind?: string) => void;

interface MirrorStatus {
  enabled?: boolean;
  locked?: boolean;
  queue_depth?: number;
  last_sync_at?: string | number | null;
  last_error?: string | null;
  device_id?: string | null;
}

interface MirrorDevice {
  device_id: string;
  device_name?: string;
  blob_count?: number;
  latest_stored_at?: string | null;
  is_this_device?: boolean;
}

/**
 * Reusable destructive-action confirm modal — user types a literal word
 * (e.g. "DISABLE", "DELETE") to enable the Confirm button. Modeled after
 * the existing `IMPORT_CONFIRM_TOKEN` flow in `PanePrivacy`.
 */
function ConfirmTypedText({
  word, title, description, confirmLabel, onConfirm, onCancel,
}: {
  word: string;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const matches = typed === word;
  const submit = React.useCallback(async () => {
    if (!matches) return;
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  }, [matches, onConfirm]);
  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(10,9,8,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 24, maxWidth: 480, width: '90%',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>{title}</div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 14, lineHeight: 1.55 }}>
          {description}
        </div>
        <div className="t-sm" style={{ marginBottom: 8 }}>
          Type <code className="mono" style={{ color: 'var(--danger)', fontWeight: 600 }}>{word}</code> to confirm:
        </div>
        <input
          className="input"
          style={{ width: '100%', marginBottom: 14, boxSizing: 'border-box' }}
          placeholder={word}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Type ${word} to confirm`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches && !busy) void submit();
            if (e.key === 'Escape' && !busy) onCancel();
          }}
        />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger-ghost"
            disabled={!matches || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : (confirmLabel || 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Heuristic strength meter for the onboarding wizard's passphrase step. */
function PassphraseStrengthMeter({ score }: { score: number }) {
  const labels = ['Too weak', 'Weak', 'OK', 'Acceptable', 'Strong'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--warning)', 'var(--success)', 'var(--success)'];
  const idx = Math.max(0, Math.min(4, score | 0));
  return (
    <div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--space-1)' }}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            style={{
              flex: 1,
              height: 4,
              background: i < idx ? colors[idx] : 'var(--border)',
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <div className="t-cap" style={{ color: colors[idx] }}>{labels[idx]}</div>
    </div>
  );
}

/** 4-step onboarding wizard: server URL → registration code → device name → passphrase. */
function MirrorOnboardingModal({
  onClose, onComplete, run, toast,
}: {
  onClose: () => void;
  onComplete: () => void;
  run: RunFn;
  toast: ToastFn;
}) {
  const [step, setStep] = React.useState(1); // 1: URL, 2: Code, 3: Name, 4: Pass
  const [serverUrl, setServerUrl] = React.useState('');
  const [regCode, setRegCode] = React.useState('');
  const [deviceName, setDeviceName] = React.useState('');
  const [pass1, setPass1] = React.useState('');
  const [pass2, setPass2] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [urlNextAttempted, setUrlNextAttempted] = React.useState(false);

  const deviceNameTooLong = React.useMemo(
    () => Array.from(deviceName).length > 64,
    [deviceName],
  );

  const urlError = React.useMemo(() => {
    if (!serverUrl) return 'URL required';
    if (!/^https?:\/\//.test(serverUrl)) return 'Must start with http:// or https://';
    let parsed: URL;
    try { parsed = new URL(serverUrl); } catch (_e) { return 'Invalid URL'; }
    if (parsed.protocol === 'http:'
        && parsed.hostname !== 'localhost'
        && parsed.hostname !== '127.0.0.1'
        && parsed.hostname !== '[::1]'
        && parsed.hostname !== '::1') {
      return 'http:// is only allowed for localhost (use https:// otherwise)';
    }
    return null;
  }, [serverUrl]);

  const passStrength = React.useMemo(() => {
    if (!pass1) return 0;
    let score = 0;
    if (pass1.length >= 8) score++;
    if (pass1.length >= 12) score++;
    if (pass1.length >= 16) score++;
    if (/[a-z]/.test(pass1) && /[A-Z]/.test(pass1)) score++;
    if (/\d/.test(pass1)) score++;
    if (/[^a-zA-Z0-9]/.test(pass1)) score++;
    return Math.min(score, 4);
  }, [pass1]);

  const passMatch = pass1 === pass2 && pass1.length > 0;

  const finish = React.useCallback(async () => {
    setBusy(true);
    const reg = await run('mirror.register', {
      server_url: serverUrl.replace(/\/$/, ''),
      registration_code: regCode.trim(),
      device_name: deviceName.trim() || 'My Mac',
    }, { silentError: true });
    if (!reg || !reg.ok) {
      setBusy(false);
      toast((reg && reg.error && reg.error.message) || 'Registration failed', 'error');
      return;
    }
    const unl = await run('mirror.unlock', { passphrase: pass1 }, { silentError: true });
    setBusy(false);
    if (!unl || !unl.ok) {
      toast((unl && unl.error && unl.error.message) || 'Unlock failed (registered but locked)', 'warn');
      return;
    }
    onComplete();
  }, [serverUrl, regCode, deviceName, pass1, run, toast, onComplete]);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1200,
        background: 'rgba(10,9,8,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        style={{
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', padding: 24, maxWidth: 520, width: '92%',
          boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Enable Cloud Mirror</div>
        <div className="t-mono" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-4)' }}>
          Step {step} of 4
        </div>

        {step === 1 && (
          <div>
            <div className="t-sm" style={{ marginBottom: 'var(--space-2)' }}>Mirror server URL</div>
            <input
              className="input"
              placeholder="https://mirror.example.com"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              style={{ marginBottom: 'var(--space-2)' }}
            />
            {urlError && (serverUrl.length > 0 || urlNextAttempted) && (
              <div className="t-cap" style={{ color: 'var(--warning)' }}>{urlError}</div>
            )}
            <div className="t-cap" style={{ color: 'var(--text-mute)', marginTop: 'var(--space-2)' }}>
              The address of your self-hosted shogun-mirror-server.
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <div className="t-sm" style={{ marginBottom: 'var(--space-2)' }}>Registration code</div>
            <input
              className="input"
              placeholder="from your server admin"
              value={regCode}
              onChange={(e) => setRegCode(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              style={{ marginBottom: 'var(--space-2)' }}
            />
            <div className="t-cap" style={{ color: 'var(--text-mute)' }}>
              Acquire this out-of-band from whoever runs your Mirror server.
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div className="t-sm" style={{ marginBottom: 'var(--space-2)' }}>Device name (optional)</div>
            <input
              className="input"
              placeholder="My Mac"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              autoFocus
              spellCheck={false}
              style={{ marginBottom: 'var(--space-2)' }}
            />
            {deviceNameTooLong && (
              <div className="t-cap" style={{ color: 'var(--warning)' }}>
                Name too long (max 64 chars)
              </div>
            )}
            <div className="t-cap" style={{ color: 'var(--text-mute)' }}>
              Shown to other devices when displaying synced memories.
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <div className="t-sm" style={{ marginBottom: 'var(--space-2)' }}>Passphrase</div>
            <input
              className="input"
              type="password"
              value={pass1}
              onChange={(e) => setPass1(e.target.value)}
              autoFocus
              autoComplete="new-password"
              style={{ marginBottom: 'var(--space-2)' }}
            />
            <input
              className="input"
              type="password"
              placeholder="Confirm passphrase"
              value={pass2}
              onChange={(e) => setPass2(e.target.value)}
              autoComplete="new-password"
              style={{ marginBottom: 'var(--space-3)' }}
            />
            <PassphraseStrengthMeter score={passStrength} />
            {pass1 && pass2 && !passMatch && (
              <div className="t-cap" style={{ color: 'var(--warning)', marginTop: 'var(--space-2)' }}>
                Passphrases don&rsquo;t match
              </div>
            )}
            <div
              className="t-cap"
              style={{
                color: 'var(--danger)',
                marginTop: 'var(--space-3)',
                padding: 'var(--space-3)',
                background: 'color-mix(in srgb, var(--danger) 8%, transparent)',
                borderRadius: 'var(--radius-md)',
                lineHeight: 1.55,
              }}
            >
              ⚠ This passphrase is the only key. If you forget it, every synced memory is unrecoverable.
            </div>
          </div>
        )}

        <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-6)' }}>
          <button className="btn btn-sm btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            {step > 1 && (
              <button
                className="btn btn-sm btn-secondary"
                onClick={() => setStep(step - 1)}
                disabled={busy}
              >
                Back
              </button>
            )}
            {step < 4 && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  if (step === 1 && urlError) {
                    setUrlNextAttempted(true);
                    return;
                  }
                  setStep(step + 1);
                }}
                disabled={
                  !!((step === 1 && urlError && (serverUrl.length > 0 || urlNextAttempted))
                  || (step === 2 && !regCode.trim())
                  || (step === 3 && deviceNameTooLong))
                }
              >
                Next
              </button>
            )}
            {step === 4 && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void finish()}
                disabled={busy || !passMatch || passStrength < 3}
              >
                {busy ? 'Setting up…' : 'Set up Mirror'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One row in the Devices card: rename inline + delete with typed-text confirm. */
function MirrorDeviceRow({
  device, run, toast, refreshDevices,
}: {
  device: MirrorDevice;
  run: RunFn;
  toast: ToastFn;
  refreshDevices: () => Promise<void>;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [newName, setNewName] = React.useState(device.device_name || '');
  const [showDelete, setShowDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const submitRename = React.useCallback(async () => {
    const trimmed = newName.trim();
    if (!trimmed) { toast('Name required', 'warn'); return; }
    if (Array.from(trimmed).length > 64) { toast('Name too long (max 64 chars)', 'warn'); return; }
    setBusy(true);
    const r = await run(
      'mirror.rename_device',
      { device_id: device.device_id, new_name: trimmed },
      { silentError: true },
    );
    setBusy(false);
    if (r && r.ok) {
      setRenaming(false);
      toast('Device renamed', 'success');
      await refreshDevices();
    } else {
      toast((r && r.error && r.error.message) || 'Rename failed', 'error');
    }
  }, [newName, device.device_id, run, toast, refreshDevices]);

  const displayName = device.device_name || `${String(device.device_id).slice(0, 8)}…`;
  const blobCount = device.blob_count != null ? device.blob_count : 0;
  const lastSeen = device.latest_stored_at
    ? new Date(device.latest_stored_at).toLocaleDateString()
    : '—';

  return (
    <div
      className="row"
      style={{
        padding: 'var(--space-3) var(--space-2)',
        borderBottom: '1px solid var(--border)',
        gap: 'var(--space-3)',
      }}
    >
      {renaming ? (
        <>
          <input
            className="input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ flex: 1 }}
            autoFocus
            disabled={busy}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submitRename();
              if (e.key === 'Escape' && !busy) setRenaming(false);
            }}
          />
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void submitRename()}
            disabled={busy}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setRenaming(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t-sm" style={{ color: 'var(--text)' }}>
              {displayName}
              {device.is_this_device && (
                <span className="t-cap" style={{ marginLeft: 'var(--space-2)', color: 'var(--gold)' }}>
                  (this device)
                </span>
              )}
            </div>
            <div className="t-cap" style={{ color: 'var(--text-mute)' }}>
              {blobCount} {blobCount === 1 ? 'memory' : 'memories'} · last seen {lastSeen}
            </div>
          </div>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => { setNewName(device.device_name || ''); setRenaming(true); }}
          >
            Rename
          </button>
          {!device.is_this_device && (
            <button
              className="btn btn-sm btn-danger-ghost"
              onClick={() => setShowDelete(true)}
            >
              Delete
            </button>
          )}
        </>
      )}

      {showDelete && (
        <ConfirmTypedText
          word="DELETE"
          title={`Delete device: ${displayName}`}
          description="Type DELETE to confirm. This tombstones every memory uploaded by this device. Other devices' memories are NOT affected. The owner of this device cannot recover the data afterward."
          confirmLabel="Delete device"
          onConfirm={async () => {
            const r = await run(
              'mirror.delete_device',
              { device_id: device.device_id, confirm: 'DELETE' },
              { silentError: true },
            );
            if (r && r.ok) {
              setShowDelete(false);
              const n = (r.data && r.data.tombstoned_blobs) || 0;
              toast(`Tombstoned ${n} ${n === 1 ? 'memory' : 'memories'}`, 'success');
              await refreshDevices();
            } else {
              toast((r && r.error && r.error.message) || 'Delete failed', 'warn');
            }
          }}
          onCancel={() => setShowDelete(false)}
        />
      )}
    </div>
  );
}

function MirrorDisabledView({
  refreshStatus, run, toast,
}: {
  refreshStatus: () => Promise<void>;
  run: RunFn;
  toast: ToastFn;
}) {
  const [showOnboarding, setShowOnboarding] = React.useState(false);
  return (
    <Pane title="Cloud Mirror" jp="雲">
      <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-6)' }}>
        Sync your encrypted memories across devices via your own self-hosted Mirror server.
        Memories are encrypted on this device with a passphrase only you know — the server
        never sees plaintext. Disabled by default.
      </div>
      <div className="card" style={{ padding: 'var(--space-6)' }}>
        <div className="t-h3" style={{ marginBottom: 'var(--space-3)' }}>Get started</div>
        <ul
          className="t-sm"
          style={{
            color: 'var(--text-mute)',
            lineHeight: 1.7,
            paddingLeft: 'var(--space-4)',
            marginBottom: 'var(--space-4)',
          }}
        >
          <li>You&rsquo;ll need a Mirror server URL (run shogun-mirror-server yourself or use a trusted host).</li>
          <li>The server admin gives you a one-time registration code.</li>
          <li>You set a passphrase — this is the ONLY key. If you forget it, every synced memory is unrecoverable.</li>
          <li>Other devices can be linked later by entering the same passphrase.</li>
        </ul>
        <button
          className="btn btn-primary"
          onClick={() => setShowOnboarding(true)}
        >
          Enable Cloud Mirror
        </button>
      </div>
      {showOnboarding && (
        <MirrorOnboardingModal
          onClose={() => setShowOnboarding(false)}
          onComplete={async () => {
            setShowOnboarding(false);
            await refreshStatus();
            toast('Cloud Mirror enabled', 'success');
          }}
          run={run}
          toast={toast}
        />
      )}
    </Pane>
  );
}

function MirrorLockedView({
  refreshStatus, run, toast,
}: {
  refreshStatus: () => Promise<void>;
  run: RunFn;
  toast: ToastFn;
}) {
  const [pass, setPass] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const submit = React.useCallback(async () => {
    if (!pass) { toast('Passphrase required', 'warn'); return; }
    setBusy(true);
    const r = await run('mirror.unlock', { passphrase: pass }, { silentError: true });
    setBusy(false);
    if (r && r.ok) {
      setPass('');
      await refreshStatus();
      toast('Mirror unlocked', 'success');
    } else {
      toast((r && r.error && r.error.message) || 'Unlock failed', 'warn');
    }
  }, [pass, run, toast, refreshStatus]);

  return (
    <Pane title="Cloud Mirror" jp="雲">
      <div
        className="card"
        style={{ padding: 'var(--space-6)', borderColor: 'var(--warning)' }}
      >
        <div className="t-h3" style={{ marginBottom: 'var(--space-2)' }}>Locked</div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-4)' }}>
          Mirror is enabled but the master key isn&rsquo;t loaded. Enter your passphrase to resume sync.
        </div>
        <input
          type="password"
          className="input"
          placeholder="Passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void submit(); }}
          autoComplete="current-password"
          autoFocus
          style={{ marginBottom: 'var(--space-3)' }}
        />
        <button
          className="btn btn-primary"
          disabled={busy || !pass}
          onClick={() => void submit()}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </button>
      </div>
    </Pane>
  );
}

function MirrorActiveView({
  status, refreshStatus, run, toast,
}: {
  status: MirrorStatus;
  refreshStatus: () => Promise<void>;
  run: RunFn;
  toast: ToastFn;
}) {
  const { setPane } = React.useContext(SettingsHydrationContext);
  const [devices, setDevices] = React.useState<MirrorDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = React.useState(false);
  const [devicesTruncated, setDevicesTruncated] = React.useState(false);
  const [showDisable, setShowDisable] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);

  const refreshDevices = React.useCallback(async () => {
    setDevicesLoading(true);
    const r = await run('mirror.list_devices', {}, { silentError: true });
    setDevicesLoading(false);
    if (r && r.ok && r.data) {
      setDevices(Array.isArray(r.data.devices) ? r.data.devices : []);
      setDevicesTruncated(!!r.data.truncated);
    }
  }, [run]);

  React.useEffect(() => { void refreshDevices(); }, [refreshDevices]);

  const syncNow = React.useCallback(async () => {
    setSyncing(true);
    const r = await run('mirror.sync_now', {}, { silentError: true });
    setSyncing(false);
    if (r && r.ok) {
      const n = (r.data && r.data.synced_count) || 0;
      toast(`Synced ${n} ${n === 1 ? 'item' : 'items'}`, 'success');
      await refreshStatus();
    } else {
      toast((r && r.error && r.error.message) || 'Sync failed', 'error');
    }
  }, [run, toast, refreshStatus]);

  const resetStuck = React.useCallback(async () => {
    setResetting(true);
    const r = await run('mirror.reset_stuck', {}, { silentError: true });
    setResetting(false);
    if (r && r.ok) {
      const n = (r.data && r.data.reset) || 0;
      toast(`Reset ${n} stuck ${n === 1 ? 'item' : 'items'}`, 'success');
      await refreshStatus();
    } else {
      toast((r && r.error && r.error.message) || 'Reset failed', 'error');
    }
  }, [run, toast, refreshStatus]);

  const lastSyncLabel = status.last_sync_at
    ? new Date(status.last_sync_at).toLocaleString()
    : '—';
  const queueDepth = status.queue_depth != null ? status.queue_depth : 0;

  return (
    <Pane title="Cloud Mirror" jp="雲">
      {/* Status row */}
      <div
        className="card"
        style={{
          padding: 'var(--space-4) var(--space-6)',
          marginBottom: 'var(--space-4)',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div className="t-mono" style={{ color: 'var(--text-mute)' }}>Last sync</div>
          <div className="t-sm">{lastSyncLabel}</div>
        </div>
        <div>
          <div className="t-mono" style={{ color: 'var(--text-mute)' }}>Queue depth</div>
          <div className="t-sm">{queueDepth}</div>
        </div>
        {status.last_error && (
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="t-mono" style={{ color: 'var(--danger)' }}>Last error</div>
            <div className="t-sm" style={{ color: 'var(--danger)', wordBreak: 'break-word' }}>
              {String(status.last_error)}
            </div>
            <button
              className="btn btn-sm btn-secondary"
              style={{ marginTop: 'var(--space-2)' }}
              onClick={() => void resetStuck()}
              disabled={resetting}
            >
              {resetting ? 'Resetting…' : 'Reset stuck'}
            </button>
          </div>
        )}
        <div>
          <span className={`label ${status.last_error ? 'label-danger' : 'label-success'}`}>
            {status.last_error ? 'Error' : 'Active'}
          </span>
        </div>
      </div>

      {/* Sync controls card */}
      <div className="card" style={{ padding: 'var(--space-6)', marginBottom: 'var(--space-4)' }}>
        <div className="t-h3" style={{ marginBottom: 'var(--space-3)' }}>Sync</div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-3)' }}>
          New memories sync automatically every 5 minutes when this device is online and unlocked.
          (Sync cadence is fixed for the MVP; configurable in 2.1.5+.)
        </div>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => void syncNow()}
          disabled={syncing}
        >
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      {/* Devices card */}
      <div className="card" style={{ padding: 'var(--space-6)', marginBottom: 'var(--space-4)' }}>
        <div className="t-h3" style={{ marginBottom: 'var(--space-3)' }}>Devices</div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-3)' }}>
          Mirror is shared across these devices. Counts reflect non-tombstoned blobs.
          {devicesTruncated && ' (List truncated; you have many devices.)'}
        </div>
        {devicesLoading ? (
          <div className="t-sm muted">Loading…</div>
        ) : devices.length === 0 ? (
          <div className="t-sm muted">
            No devices yet. Sync from another device with the same passphrase.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {devices.map((d) => (
              <MirrorDeviceRow
                key={d.device_id}
                device={d}
                run={run}
                toast={toast}
                refreshDevices={refreshDevices}
              />
            ))}
          </div>
        )}
      </div>

      {/* Privacy filter link card */}
      <div className="card" style={{ padding: 'var(--space-6)', marginBottom: 'var(--space-4)' }}>
        <div className="t-h3" style={{ marginBottom: 'var(--space-2)' }}>Privacy filters</div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-3)' }}>
          Apps and URLs excluded from capture are also excluded from Mirror sync.
          Edit them in the Privacy Controls pane.
        </div>
        {typeof setPane === 'function' ? (
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => setPane('privacy')}
          >
            Open Privacy Controls
          </button>
        ) : (
          <div className="t-sm muted">→ Settings → Privacy Controls</div>
        )}
      </div>

      {/* Disable danger zone */}
      <div
        className="card"
        style={{
          padding: 'var(--space-6)',
          borderColor: 'var(--danger)',
          marginTop: 'var(--space-6)',
        }}
      >
        <div className="t-h3" style={{ marginBottom: 'var(--space-2)', color: 'var(--danger)' }}>
          Disable Cloud Mirror
        </div>
        <div className="t-sm" style={{ color: 'var(--text-mute)', marginBottom: 'var(--space-3)' }}>
          Stops sync and wipes the master key from this device&rsquo;s Keychain.
          Local memories are preserved. Other devices using the same passphrase keep working.
          You can re-enable later by entering the passphrase again.
        </div>
        <button
          className="btn btn-sm btn-danger-ghost"
          onClick={() => setShowDisable(true)}
        >
          Disable Mirror…
        </button>
      </div>

      {showDisable && (
        <ConfirmTypedText
          word="DISABLE"
          title="Disable Cloud Mirror"
          description="Type DISABLE to confirm. This wipes the master key from this device. Synced data on the server is preserved; you can re-link with the same passphrase."
          confirmLabel="Disable Mirror"
          onConfirm={async () => {
            const r = await run('mirror.disable', { wipe_keys: true }, { silentError: true });
            if (r && r.ok) {
              setShowDisable(false);
              toast('Cloud Mirror disabled', 'success');
              await refreshStatus();
            } else {
              toast((r && r.error && r.error.message) || 'Disable failed', 'warn');
            }
          }}
          onCancel={() => setShowDisable(false)}
        />
      )}
    </Pane>
  );
}

export function PaneCloudMirror() {
  const { run, toast } = useRuntimeActions();
  const [status, setStatus] = React.useState<MirrorStatus | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(false);

  const refreshStatus = React.useCallback(async () => {
    setStatusLoading(true);
    const res = await run('mirror.status', {}, { silentError: true });
    setStatusLoading(false);
    if (res && res.ok && res.data) setStatus(res.data);
  }, [run]);

  React.useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  if (statusLoading && !status) {
    return (
      <Pane title="Cloud Mirror" jp="雲">
        <div className="t-sm muted">Loading…</div>
      </Pane>
    );
  }
  if (!status) {
    return (
      <Pane title="Cloud Mirror" jp="雲">
        <div className="t-sm muted">
          Cloud Mirror is unavailable in this build.
        </div>
      </Pane>
    );
  }

  const enabled = !!status.enabled;
  const locked = !!status.locked;

  if (!enabled) {
    return <MirrorDisabledView refreshStatus={refreshStatus} run={run} toast={toast} />;
  }
  if (locked) {
    return <MirrorLockedView refreshStatus={refreshStatus} run={run} toast={toast} />;
  }
  return (
    <MirrorActiveView
      status={status}
      refreshStatus={refreshStatus}
      run={run}
      toast={toast}
    />
  );
}
