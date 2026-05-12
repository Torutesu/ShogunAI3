import { Toggle } from '../../components/Toggle';

interface SiteRow {
  id: string;
  host: string;
  label?: string;
  enabled: boolean;
}

interface WebsitesTabProps {
  filteredSites: SiteRow[];
  siteDraft: string;
  setSiteDraft: (v: string) => void;
  addSiteRow: () => Promise<void>;
  removeSiteRow: (id: string) => Promise<void>;
  toggleSite: (id: string, enabled: boolean) => Promise<void>;
}

export function WebsitesTab({
  filteredSites,
  siteDraft,
  setSiteDraft,
  addSiteRow,
  removeSiteRow,
  toggleSite,
}: WebsitesTabProps) {
  return (
    <>
      <div className="s-card">
        {filteredSites.length === 0 ? (
          <div className="s-field-hint" style={{ padding: 16 }}>No sites match this search.</div>
        ) : (
          filteredSites.map((s, i, arr) => (
            <div key={s.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')}>
              <div style={{ flex: 1, fontSize: 13 }}>
                <div style={{ fontWeight: 500 }}>{s.host}</div>
                {s.label && s.label !== s.host ? (
                  <div className="s-field-hint" style={{ fontSize: 11 }}>{s.label}</div>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ marginRight: 8 }}
                title="Remove from list"
                onClick={() => void removeSiteRow(s.id)}
              >
                ×
              </button>
              <Toggle on={s.enabled} onClick={() => void toggleSite(s.id, !s.enabled)} />
            </div>
          ))
        )}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <input
          className="s-input"
          style={{ flex: 1 }}
          placeholder="e.g. bank.example.com"
          value={siteDraft}
          onChange={(e) => setSiteDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void addSiteRow();
            }
          }}
        />
        <button type="button" className="btn btn-sm btn-secondary" onClick={() => void addSiteRow()}>
          Add site
        </button>
      </div>
    </>
  );
}
