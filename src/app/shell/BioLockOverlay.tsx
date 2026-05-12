import React from 'react';
import { Kamon } from '@/shared/icons';

interface BioLockOverlayProps {
  open: boolean;
  onUnlock: () => Promise<void>;
}

export function BioLockOverlay({ open, onUnlock }: BioLockOverlayProps): React.ReactElement | null {
  if (!open) return null;
  return (
    <div
      className="bio-lock-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        background: 'rgba(10,9,8,0.92)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 20,
      }}
    >
      <Kamon size={56} color="var(--gold)" />
      <div style={{ fontSize: 18, fontWeight: 600 }} className="en-only">
        Unlock SHOGUN
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }} className="jp">
        SHOGUN を解除
      </div>
      <div className="s-field-hint" style={{ textAlign: 'center', maxWidth: 320, padding: '0 20px' }}>
        <span className="en-only">Continue with Touch ID or Face ID.</span>
        <span className="jp">Touch ID または Face ID で続行してください。</span>
      </div>
      <button
        className="btn btn-secondary"
        type="button"
        onClick={onUnlock}
      >
        <span className="en-only">Unlock with biometrics</span>
        <span className="jp">生体認証で解除</span>
      </button>
    </div>
  );
}
