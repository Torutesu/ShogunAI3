import { Icon } from '@/shared/icons';

export interface MorningBriefCardProps {
  morningBrief: any;
  sliSnapshot: any;
  sliTone: { fg: string; border: string; bg: string } | null;
  briefGeneratedDisplay: string;
  dismissBriefItem: (item: any) => void;
  submitBriefRating: (n: number) => void;
  runBriefMcp: (item: any, tool: any) => void;
}

export function MorningBriefCard({
  morningBrief,
  sliSnapshot,
  sliTone,
  briefGeneratedDisplay,
  dismissBriefItem,
  submitBriefRating,
  runBriefMcp,
}: MorningBriefCardProps) {
  if (!morningBrief) return null;

  return (
    <div className="card" style={{ width: '100%', maxWidth: 760, marginInline: 'auto', padding: 28, borderColor: 'var(--gold-dim)', marginTop: 32, background: 'var(--surface)' }}>
      <div className="row" style={{ marginBottom: 14, alignItems: 'baseline', gap: 12 }}>
        <div className="t-mono gold" style={{textTransform:'none', letterSpacing:'0.02em'}}>Morning brief · AMC</div>
        <span className="pill" style={{ fontSize: 10 }}>{morningBrief.posture}</span>
        {sliSnapshot && (
          <span
            className="pill"
            style={{
              fontSize: 10,
              color: sliTone?.fg || 'var(--text-mute)',
              borderColor: sliTone?.border || 'var(--border)',
              background: sliTone?.bg || 'var(--surface)',
            }}
            title="Last 24h SLI snapshot"
          >
            SLI {Number(sliSnapshot.successRate || 0).toFixed(1)}% · p95 {sliSnapshot.p95LatencyMs ?? '—'}ms · backlog {sliSnapshot.backlog ?? 0}
          </span>
        )}
        <span className="spacer" />
        <span className="t-mono xsmall muted">{briefGeneratedDisplay || '—'}</span>
      </div>
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 18, lineHeight: 1.35 }}>{morningBrief.headline}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(morningBrief.items || []).map((item: any) => (
          <div key={item.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 14 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span className="t-mono xsmall" style={{ color: 'var(--gold)' }}>P{item.priority}</span>
              <span className="t-mono xsmall muted">{item.category}</span>
              {Array.isArray(item.related_context) && item.related_context.length > 0 && (
                <span className="t-mono xsmall muted">src:{item.related_context.length}</span>
              )}
              {Array.isArray(item.related_context) && item.related_context[0]?.last_touched && (
                <span className="t-mono xsmall muted">fresh:{item.related_context[0].last_touched}</span>
              )}
              {item.time_hint && <span className="t-mono xsmall">{item.time_hint}</span>}
              <span className="spacer" />
              <button type="button" className="btn btn-sm btn-ghost" style={{ fontSize: 10, height: 24 }} onClick={() => dismissBriefItem(item)}>見送る</button>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{item.what}</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 10, lineHeight: 1.5 }}>{item.why_now}</div>
            {(item.related_context || []).length > 0 && (
              <div style={{ fontSize: 11, color: 'var(--text-mute)', marginBottom: 10 }}>
                {(item.related_context || []).map((r: any) => (
                  <span key={r.uri} style={{ marginRight: 10 }}>{r.title} · {r.last_touched}</span>
                ))}
              </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {item.next_action?.mcp_tool ? (
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => runBriefMcp(item, item.next_action.mcp_tool)}>
                  {item.next_action.label} <Icon name="arrowRight" size={14} />
                </button>
              ) : (
                <span className="xsmall muted">No MCP action</span>
              )}
            </div>
          </div>
        ))}
      </div>
      {morningBrief.deferred_count > 0 && (
        <div className="xsmall muted" style={{ marginTop: 14 }}>+ {morningBrief.deferred_count} deferred</div>
      )}
      <div className="row" style={{ marginTop: 16, gap: 6, alignItems: 'center' }}>
        <span className="xsmall muted">今日の品質 (1–5)</span>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className="btn btn-sm btn-ghost" style={{ minWidth: 32, height: 28, fontSize: 11 }} onClick={() => submitBriefRating(n)}>{n}</button>
        ))}
      </div>
      {Array.isArray(morningBrief?.patterns) && morningBrief.patterns.length > 0 && (
        <div className="card" style={{padding:'var(--space-4) var(--space-5)', marginTop:'var(--space-4)'}}>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>
            YOUR USUAL
          </div>
          <div style={{display:'flex', flexDirection:'column', gap:'var(--space-1)'}}>
            {morningBrief.patterns.slice(0, 4).map((p: any, i: number) => (
              <div key={i} className="t-sm" style={{color:'var(--text-mute)'}}>
                • <span style={{color:'var(--text)'}}>{p.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
