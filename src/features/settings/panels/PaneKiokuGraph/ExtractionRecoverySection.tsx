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

  const requeueBilling = async () => {
    setBusy(true);
    setRequeueResult(null);
    setErr(null);
    const r = await run('kioku.extraction_requeue', { only_billing: true }, { silentError: true });
    setBusy(false);
    if (r?.ok && r.data) {
      setRequeueResult(r.data);
      await refresh();
    } else {
      setErr((r && (r.message || r.error)) || 'Requeue failed');
    }
  };

  const billingBlocked = !!(smoke && smoke.billing_blocked);
  const failedBilling = Number(smoke?.failed_billing_jobs) || 0;
  const failedTotal = Number(smoke?.failed_jobs) || 0;
  const queued = Number(smoke?.queued_jobs) || 0;

  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Extraction pipeline</div>
      <p style={{ fontSize: 12, color: 'var(--text-mute)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Facts and graph edges are created by the BYOK extraction worker. If Anthropic credits are exhausted,
        jobs fail permanently unless re-queued after billing is restored.
      </p>
      {err && (
        <p style={{ fontSize: 12, color: 'var(--danger)', marginBottom: 10 }}>{err}</p>
      )}
      {smoke && (
        <div
          style={{
            fontSize: 12,
            color: billingBlocked ? 'var(--warn)' : 'var(--text-mute)',
            marginBottom: 14,
            lineHeight: 1.6,
          }}
        >
          Queued: {queued} · Failed: {failedTotal}
          {failedBilling > 0 ? ` (${failedBilling} billing/credit)` : ''}
          · Worker: {smoke.worker_enabled ? 'on' : 'off'}
          · LLM key: {smoke.llm_key_configured ? 'yes' : 'no'}
        </div>
      )}
      {billingBlocked && (
        <p style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 12 }}>
          Extraction is blocked — add Anthropic credits, then re-queue billing-failed jobs below.
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
          disabled={busy || failedBilling === 0}
          onClick={() => void requeueBilling()}
          data-testid="kioku-requeue-billing"
        >
          Re-queue billing-failed jobs
        </button>
      </div>
      {requeueResult && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 10 }}>
          Re-queued {requeueResult.requeued} job(s). Worker will retry when credits are available.
        </p>
      )}
    </div>
  );
}
