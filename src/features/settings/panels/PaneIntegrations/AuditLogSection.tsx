interface AuditLogSectionProps {
  filteredAuditRows: any[];
  auditFilter: string;
  setAuditFilter: (v: string) => void;
  auditProviderFilter: string;
  setAuditProviderFilter: (v: string) => void;
  auditProviderOptions: string[];
  exportAuditJson: () => void;
  fmtAuditTime: (t: any) => string;
  auditEventLabel: (event: any) => string;
  auditReasonLabel: (reason: any) => string;
  auditViaLabel: (via: any) => string;
}

export function AuditLogSection({
  filteredAuditRows,
  auditFilter,
  setAuditFilter,
  auditProviderFilter,
  setAuditProviderFilter,
  auditProviderOptions,
  exportAuditJson,
  fmtAuditTime,
  auditEventLabel,
  auditReasonLabel,
  auditViaLabel,
}: AuditLogSectionProps) {
  return (
    <div className="s-card" style={{ marginBottom: 10 }}>
      <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Integration Security Audit</div>
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-xs btn-ghost"
          style={{ marginRight: 8, padding: '2px 8px' }}
          onClick={exportAuditJson}
        >
          Export audit (JSON)
        </button>
        <select
          className="s-select"
          style={{ minWidth: 120, marginRight: 8 }}
          value={auditFilter}
          onChange={(e) => setAuditFilter(String(e.target.value || 'all'))}
        >
          <option value="all">全件</option>
          <option value="success">成功のみ</option>
          <option value="rejected">拒否のみ</option>
        </select>
        <select
          className="s-select"
          style={{ minWidth: 140, marginRight: 8 }}
          value={auditProviderFilter}
          onChange={(e) => setAuditProviderFilter(String(e.target.value || 'all'))}
        >
          {auditProviderOptions.map((p) => (
            <option key={p} value={p}>
              {p === 'all' ? 'プロバイダ: 全て' : `プロバイダ: ${p}`}
            </option>
          ))}
        </select>
        <span className="s-field-hint" style={{ margin: 0 }}>Last 20 events</span>
      </div>
      {filteredAuditRows.length === 0 ? (
        <div className="s-field-hint" style={{ padding: '12px 16px' }}>
          No audit events yet.
        </div>
      ) : (
        <div style={{ maxHeight: 220, overflow: 'auto' }}>
          {filteredAuditRows.map((r, i) => (
            <div
              key={`${r.ts || 'na'}-${r.event || 'evt'}-${i}`}
              className={'s-row' + (i === filteredAuditRows.length - 1 ? ' last' : '')}
              style={{ fontSize: 12 }}
            >
              <div style={{ width: 130, color: 'var(--text-dim)' }}>{fmtAuditTime(r.ts)}</div>
              <div style={{ width: 160 }} title={String(r.event || '')}>{auditEventLabel(r.event)}</div>
              <div style={{ width: 120, color: 'var(--text-dim)' }}>{r.provider || 'unknown'}</div>
              <div style={{ width: 90, color: 'var(--text-dim)' }} title={String(r.via || '')}>
                {auditViaLabel(r.via)}
              </div>
              <div style={{ flex: 1, color: 'var(--text-dim)' }} title={String(r.reason || '')}>
                {auditReasonLabel(r.reason)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
