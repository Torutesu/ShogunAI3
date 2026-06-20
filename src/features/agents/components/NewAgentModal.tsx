interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onOpenPlayground: () => void;
}

export function NewAgentModal({ open, onClose, onOpenPlayground }: NewAgentModalProps) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New agent"
      onMouseDown={onClose}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(0,0,0,0.5)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background:'var(--surface)',
          border:`1px solid var(--border-hi)`,
          borderRadius:'var(--radius-lg)',
          padding:'var(--space-8)',
          maxWidth:480, width:'90%',
          boxShadow:'var(--shadow-lg)',
        }}
      >
        <div className="t-mono" style={{color:'var(--gold)', marginBottom:'var(--space-3)'}}>+ NEW AGENT</div>
        <div style={{fontSize:18, fontWeight:600, marginBottom:'var(--space-3)', letterSpacing:'-0.01em'}}>
          Custom agents — coming in v0.5
        </div>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-2)'}}>
          The four agents above are the curated default set. Custom agent
          creation (your own triggers, prompts, and tool selections) is
          coming in v0.5.
        </p>
        <p className="t-sm" style={{color:'var(--text-mute)', lineHeight:1.6, marginTop:0, marginBottom:'var(--space-6)'}}>
          Want to experiment with agent-style prompts in the meantime?
        </p>
        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={onOpenPlayground}>Open Playground</button>
        </div>
      </div>
    </div>
  );
}
