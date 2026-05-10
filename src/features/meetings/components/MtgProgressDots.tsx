
interface MtgProgressDotsProps {
  storageKey: string;
  listVersion: number;
}

/** Memo / transcript / summary / minutes completion (4 dots). listVersion bumps parent to refresh. */
export function MtgProgressDots({ storageKey, listVersion }: MtgProgressDotsProps) {
  void listVersion;
  const L: any = typeof window !== 'undefined' ? (window as any).MeetingNoteLocal : null;
  if (!L || !storageKey) return null;
  const saved = L.loadNote ? L.loadNote(storageKey) : null;
  const p = L.noteProgress ? L.noteProgress(saved) : null;
  if (!p || p.pct === 0) return null;
  function dot(on: boolean) {
    return (
      <span style={{
        display: 'inline-block', width: 6, height: 6, borderRadius: 999,
        background: on ? 'var(--gold)' : 'var(--border)',
        opacity: on ? 1 : 0.35,
      }}/>
    );
  }
  return (
    <span className="row" style={{ gap: 3, marginLeft: 6 }} title={p.pct + '%'}>
      {dot(p.memo)}{dot(p.transcript)}{dot(p.summary)}{dot(p.minutes)}
    </span>
  );
}
