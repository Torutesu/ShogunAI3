import { useCallback, useEffect, useState } from 'react';
import { useRuntimeActions } from '../../lib/hooks';

export function ExtractionRecoverySection() {
  const { run } = useRuntimeActions();
  const [smoke, setSmoke] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [requeueResult, setRequeueResult] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setErr(null);
    const r = await run('kioku.pipeline_smoke', {}, { silentError: true });
    if (r?.ok && r.data) {
      setSmoke(r.data);
    } else {
      setErr((r && (r.message || r.error)) || 'Pipeline check failed');
    }
  }, [run]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requeueBlocked = async () => {
    setBusy(true);
    setRequeueResult(null);
    setErr(null);
    const r = await run('kioku.extraction_requeue', { only_blocked: true }, { silentError: true });
    setBusy(false);
    if (r?.ok && r.data) {
      setRequeueResult(r.data);
      await refresh();
    } else {
      setErr((r && (r.message || r.error)) || 'Requeue failed');
    }
  };

  const billingBlocked = !!(smoke && smoke.billing_blocked);
  const authBlocked = !!(smoke && smoke.auth_blocked);
  const extractionBlocked = billingBlocked || authBlocked;
  const blockedBilling = Number(smoke?.billing_blocked_jobs ?? smoke?.failed_billing_jobs) || 0;
  const blockedAuth = Number(smoke?.auth_blocked_jobs ?? smoke?.failed_auth_jobs) || 0;
  const blockedTotal = Number(smoke?.blocked_jobs) || blockedBilling + blockedAuth;
  const failedTotal = Number(smoke?.failed_jobs) || 0;
  const queued = Number(smoke?.queued_jobs) || 0;

  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Extraction pipeline</div>
      <p style={{ fontSize: 12, color: 'var(--text-mute)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Facts and graph edges are created by the BYOK extraction worker. If the model key or billing is blocked,
        jobs pause until the configuration is fixed and the blocked jobs are re-queued.
      </p>
      {err && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{err}</p>
      )}
      {smoke && (
        <div
          style={{
            fontSize: 12,
            color: extractionBlocked ? 'var(--warn)' : 'var(--text-mute)',
            marginBottom: 14,
            lineHeight: 1.6,
          }}
        >
          Queued: {queued} · Failed: {failedTotal}
          {blockedTotal > 0 ? ` (${blockedTotal} blocked: ${blockedBilling} billing, ${blockedAuth} auth)` : ''}
          · Worker: {smoke.worker_enabled ? 'on' : 'off'}
          · LLM key: {smoke.llm_key_configured ? 'yes' : 'no'}
        </div>
      )}
      {extractionBlocked && (
        <p style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 12 }}>
          Extraction is blocked — fix the LLM key or Anthropic credits, then re-queue blocked jobs below.
        </p>
      )}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="s-btn"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? 'Working…' : 'Refresh status'}
        </button>
        <button
          type="button"
          className="s-btn"
          disabled={busy || blockedTotal === 0}
          onClick={() => void requeueBlocked()}
          data-testid="kioku-requeue-blocked"
        >
          Re-queue blocked jobs
        </button>
      </div>
      {requeueResult && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 10 }}>
          Re-queued {requeueResult.requeued} job(s). Worker will retry when the blocker is resolved.
        </p>
      )}
    </div>
  );
}
