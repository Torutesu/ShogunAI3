import * as ReactDOM from 'react-dom';

export interface HistoricalImportModalProps {
  historicalImport: { provider: string; days: number } | null;
  historicalImportBusy: boolean;
  historicalImportProgress: { provider: string; current: number; total?: number } | null;
  onClose: () => void;
  onDaysChange: (days: number) => void;
  onSkip: () => void;
  onImport: () => void;
}

export function HistoricalImportModal(props: HistoricalImportModalProps) {
  if (!props.historicalImport) return null;
  const { historicalImport, historicalImportBusy, historicalImportProgress } = props;
  return ReactDOM.createPortal(
    <div
      style={{
        position:'fixed', inset:0, zIndex:1090,
        background:'color-mix(in srgb, var(--bg) 78%, transparent)',
        backdropFilter:'blur(4px)',
        display:'flex', alignItems:'center', justifyContent:'center',
        padding:20,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !historicalImportBusy) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width:'min(460px, 100%)',
          background:'var(--surface)',
          border:'1px solid var(--border-hi)',
          borderRadius:16,
          boxShadow:'0 30px 60px -16px rgba(0,0,0,0.6)',
          padding:22,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div style={{fontSize:16, fontWeight:500, marginBottom:6}}>
          {historicalImport.provider === 'gmail'
            ? 'Import past Gmail'
            : historicalImport.provider === 'slack'
              ? 'Import past Slack messages'
              : historicalImport.provider === 'notion'
                ? 'Import past Notion pages'
                : historicalImport.provider === 'github'
                  ? 'Import past GitHub activity'
                  : historicalImport.provider === 'linear'
                    ? 'Import past Linear issues'
                    : historicalImport.provider === 'google_drive'
                      ? 'Import past Drive files'
                      : historicalImport.provider === 'zoom'
                        ? 'Import past Zoom recordings'
                        : 'Import past Calendar events'}
        </div>
        <div style={{fontSize:12, color:'var(--text-mute)', lineHeight:1.5, marginBottom:16}}>
          How far back should SHOGUN pull history into Memory? You can change this later in Settings. Up to 1 year.
        </div>

        <div style={{display:'flex', flexDirection:'column', gap:8}}>
          {[
            { d: 7,   label: 'Past 7 days' },
            { d: 30,  label: 'Past 30 days' },
            { d: 90,  label: 'Past 3 months' },
            { d: 180, label: 'Past 6 months' },
            { d: 365, label: 'Past 1 year (max)' },
          ].map((opt) => {
            const selected = historicalImport.days === opt.d;
            return (
              <button
                key={opt.d}
                type="button"
                disabled={historicalImportBusy}
                onClick={() => props.onDaysChange(opt.d)}
                style={{
                  display:'flex', alignItems:'center', gap:10,
                  padding:'10px 12px',
                  borderRadius:10,
                  border: selected
                    ? '1px solid color-mix(in srgb, var(--gold) 65%, var(--border))'
                    : '1px solid var(--border)',
                  background: selected
                    ? 'color-mix(in srgb, var(--gold) 8%, var(--surface))'
                    : 'var(--surface)',
                  color:'var(--text)',
                  fontSize:13,
                  cursor: historicalImportBusy ? 'default' : 'pointer',
                  fontFamily:'inherit',
                  textAlign:'left',
                }}
              >
                <span style={{
                  width:14, height:14, borderRadius:'50%',
                  border:'1px solid ' + (selected ? 'var(--gold)' : 'var(--border-hi)'),
                  background: selected ? 'var(--gold)' : 'transparent',
                  flexShrink:0,
                }}/>
                <span>{opt.label}</span>
              </button>
            );
          })}
        </div>

        <div className="row" style={{marginTop:18, gap:8, justifyContent:'flex-end'}}>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            disabled={historicalImportBusy}
            onClick={props.onSkip}
          >
            Skip
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={historicalImportBusy}
            onClick={props.onImport}
          >
            {historicalImportBusy ? (
              historicalImportProgress &&
              historicalImportProgress.provider === historicalImport.provider
                ? (
                    historicalImportProgress.total != null && historicalImportProgress.total > 0
                      ? `Importing… ${historicalImportProgress.current}/${historicalImportProgress.total}`
                      : `Importing… ${historicalImportProgress.current}`
                  )
                : 'Importing…'
            ) : 'Import'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
