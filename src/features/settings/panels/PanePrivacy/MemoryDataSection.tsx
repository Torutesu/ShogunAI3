import { IMPORT_CONFIRM_TOKEN } from '../../lib/defaults';

interface MemoryDataSectionProps {
  busyExport: boolean;
  busyImport: boolean;
  importConfirmOpen: boolean;
  importConfirmText: string;
  setImportConfirmOpen: (v: boolean) => void;
  setImportConfirmText: (v: string) => void;
  handleExport: () => Promise<void>;
  handleImportConfirm: () => Promise<void>;
}

export function MemoryDataSection({
  busyExport,
  busyImport,
  importConfirmOpen,
  importConfirmText,
  setImportConfirmOpen,
  setImportConfirmText,
  handleExport,
  handleImportConfirm,
}: MemoryDataSectionProps) {
  return (
    <>
      <div className="s-card" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Memory data</div>
        </div>
        <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 12 }}>
          Export your memories to a file you control, or import a previously-exported file.
          <span className="jp" style={{ display: 'block', fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
            Memory データをファイルにエクスポート、または以前のエクスポートをインポートできます。
          </span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleExport}
            disabled={busyExport}
          >
            {busyExport ? 'Exporting…' : 'Export memory…'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => { setImportConfirmOpen(true); setImportConfirmText(''); }}
            disabled={busyImport}
          >
            {busyImport ? 'Importing…' : 'Import memory…'}
          </button>
        </div>
      </div>

      {importConfirmOpen ? (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 1200,
            background: 'rgba(10,9,8,0.65)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setImportConfirmOpen(false); setImportConfirmText(''); } }}
        >
          <div
            style={{
              background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)', padding: 24, maxWidth: 400, width: '90%',
              boxShadow: '0 8px 40px rgba(0,0,0,0.5)',
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Import memory — confirm</div>
            <div className="s-field-hint" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.55 }}>
              This will <strong>delete all existing memories</strong> and replace them with the contents of the selected file.
              This action cannot be undone.
            </div>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Type <code>{IMPORT_CONFIRM_TOKEN}</code> to confirm:
            </div>
            <input
              className="s-input"
              style={{ width: '100%', marginBottom: 14, boxSizing: 'border-box' }}
              placeholder={IMPORT_CONFIRM_TOKEN}
              value={importConfirmText}
              onChange={(e) => setImportConfirmText(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={`Type ${IMPORT_CONFIRM_TOKEN} to confirm`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && importConfirmText === IMPORT_CONFIRM_TOKEN) {
                  void handleImportConfirm();
                }
                if (e.key === 'Escape') {
                  setImportConfirmOpen(false);
                  setImportConfirmText('');
                }
              }}
            />
            <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setImportConfirmOpen(false); setImportConfirmText(''); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger-ghost"
                disabled={importConfirmText !== IMPORT_CONFIRM_TOKEN}
                onClick={() => void handleImportConfirm()}
              >
                Replace memories
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
