interface EdgeReviewSectionProps {
  proposals: any[];
  proposalsBusy: boolean;
  proposalsErr: string | null;
  showAllProposals: boolean;
  setShowAllProposals: (v: boolean) => void;
  reviewNotes: Record<string, string>;
  setReviewNotes: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  reviewBusy: string | null;
  refreshProposals: () => Promise<void>;
  reviewProposal: (edge_type: string, status: number) => Promise<void>;
}

export function EdgeReviewSection({
  proposals,
  proposalsBusy,
  proposalsErr,
  showAllProposals,
  setShowAllProposals,
  reviewNotes,
  setReviewNotes,
  reviewBusy,
  refreshProposals,
  reviewProposal,
}: EdgeReviewSectionProps) {
  return (
    <div className="s-card" style={{ padding: 20, marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>edge_type review queue</h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ fontSize: 12, color: '#aaa' }}>
            <input
              type="checkbox"
              checked={showAllProposals}
              onChange={(e) => setShowAllProposals(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            Show reviewed
          </label>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => void refreshProposals()}
            disabled={proposalsBusy}
          >
            {proposalsBusy ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p style={{ color: '#aaa', fontSize: 12, marginTop: 0 }}>
        Each edge the extraction worker writes records its <code>edge_type</code> here. Mark
        new types as <strong>Accept</strong> to feed them into Stage 4's CHECK constraint
        candidate set, or <strong>Reject</strong> to flag them for soft-retire. Canonical
        types (<code>mentions</code> / <code>follows_up</code> / ...) are pre-accepted.
      </p>
      {proposalsErr && <div style={{ color: '#e57373', marginBottom: 8, fontSize: 12 }}>{proposalsErr}</div>}
      {proposals.length === 0 ? (
        <div style={{ color: '#888', fontStyle: 'italic', padding: '8px 0' }}>
          {showAllProposals
            ? 'No proposals yet. Once the extraction worker runs, it logs every edge_type here.'
            : 'No unreviewed proposals. Toggle "Show reviewed" to see canonical and previously-judged types.'}
        </div>
      ) : (
        <table className="mdbg-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>edge_type</th>
              <th style={{ textAlign: 'right' }}>seen</th>
              <th style={{ textAlign: 'left' }}>status</th>
              <th style={{ textAlign: 'left' }}>note (optional)</th>
              <th style={{ textAlign: 'right' }}>actions</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((p) => {
              const status =
                p.reviewed === 1 ? 'accepted' :
                p.reviewed === 2 ? 'rejected' :
                'unreviewed';
              const statusColor =
                p.reviewed === 1 ? '#8fdc8f' :
                p.reviewed === 2 ? '#e57373' :
                '#aaa';
              return (
                <tr key={p.edge_type}>
                  <td>
                    <code>{p.edge_type}</code>
                    {p.canonical && (
                      <span style={{
                        marginLeft: 6, fontSize: 10, padding: '2px 6px', borderRadius: 8,
                        background: '#1f3a1f', color: '#8fdc8f', border: '1px solid #2f5a2f',
                      }}>canonical</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>{p.seen_count}</td>
                  <td style={{ color: statusColor }}>{status}</td>
                  <td>
                    {p.reviewer_note ? (
                      <span style={{ color: '#aaa', fontSize: 11 }}>{p.reviewer_note}</span>
                    ) : (
                      <input
                        className="s-input"
                        placeholder="why accept/reject?"
                        value={reviewNotes[p.edge_type] || ''}
                        onChange={(e) => setReviewNotes((prev) => ({
                          ...prev, [p.edge_type]: e.target.value,
                        }))}
                        style={{ fontSize: 11, padding: '2px 6px', width: 200 }}
                      />
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => void reviewProposal(p.edge_type, 1)}
                      disabled={reviewBusy === p.edge_type || p.reviewed === 1}
                      style={{ marginRight: 4 }}
                    >
                      Accept
                    </button>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => void reviewProposal(p.edge_type, 2)}
                      disabled={reviewBusy === p.edge_type || p.reviewed === 2}
                    >
                      Reject
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
