import { useCallback, useEffect, useState } from 'react';
import { useRuntimeActions } from '../../lib/hooks';

export function ExtractionRecoverySection() {
  const { run } = useRuntimeActions();
  const [smoke, setSmoke] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [requeueResult, setRequeueResult] = useState<any>(null);
  const [resumeResult, setResumeResult] = useState<string | null>(null);
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
    setResumeResult(null);
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

  const resumeExtraction = async () => {
    setBusy(true);
    setRequeueResult(null);
    setResumeResult(null);
    setErr(null);
    try {
      const enable = await run('settings.save', { section: 'kioku_graph', worker_enabled: true }, { silentError: true });
      if (!enable?.ok) {
        setErr((enable && (enable.message || enable.error)) || 'Failed to enable worker');
        return;
      }
      const failedBilling = Number(smoke?.failed_billing_jobs) || 0;
      if (failedBilling > 0) {
        const rq = await run('kioku.extraction_requeue', { only_billing: true }, { silentError: true });
        if (!rq?.ok) {
          setErr((rq && (rq.message || rq.error)) || 'Re-queue failed');
          return;
        }
        setRequeueResult(rq.data);
      }
      setResumeResult('Worker enabled. Queued jobs will run when your LLM API quota is available.');
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const billingBlocked = !!(smoke && smoke.billing_blocked);
  const failedBilling = Number(smoke?.failed_billing_jobs) || 0;
  const failedTotal = Number(smoke?.failed_jobs) || 0;
  const queued = Number(smoke?.queued_jobs) || 0;
  const edgesActive = Number(smoke?.edges_active) || 0;

  return (
    <div className="s-card" style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Extraction pipeline</div>
      <p style={{ fontSize: 12, color: 'var(--text-mute)', margin: '0 0 14px', lineHeight: 1.5 }}>
        Facts and graph edges are created by the BYOK extraction worker. After saving a Gemini API key
        (Settings → Model and API), use <strong>Resume extraction</strong> to turn the worker on and
        re-queue billing-failed jobs.
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
          · Edges: {edgesActive}
          · Worker: {smoke.worker_enabled ? 'on' : 'off'}
          · LLM key: {smoke.llm_key_configured ? 'yes' : 'no'}
        </div>
      )}
      {billingBlocked && (
        <p style={{ fontSize: 12, color: 'var(--warn)', marginBottom: 12 }}>
          Extraction is blocked — check your LLM API key and quota, then click Resume extraction below.
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
          style={{ borderColor: 'var(--gold-dim)', color: 'var(--gold)' }}
          disabled={busy || !smoke?.llm_key_configured}
          onClick={() => void resumeExtraction()}
          data-testid="kioku-resume-extraction"
        >
          Resume extraction
        </button>
        <button
          type="button"
          className="s-btn"
          disabled={busy || failedBilling === 0}
          onClick={() => void requeueBilling()}
          data-testid="kioku-requeue-billing"
        >
          Re-queue billing-failed only
        </button>
      </div>
      {resumeResult && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 10 }}>{resumeResult}</p>
      )}
      {requeueResult && !resumeResult && (
        <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 10 }}>
          Re-queued {requeueResult.requeued} job(s). Worker will retry when credits are available.
        </p>
      )}
    </div>
  );
}
