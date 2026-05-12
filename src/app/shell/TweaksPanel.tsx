import React from 'react';
import { Kamon } from '@/shared/icons';

interface TweaksPanelProps {
  editMode: boolean;
  tweaks: { language: string; accentDensity: string; goldIntensity: string; dotGrid: boolean };
  onUpdate: (key: string, value: any) => void;
}

export function TweaksPanel({ editMode, tweaks, onUpdate }: TweaksPanelProps): React.ReactElement | null {
  if (!editMode) {
    return <div id="tweaks-panel" className="" />;
  }
  return (
    <div id="tweaks-panel" className="show">
      <h6>TWEAKS · 調整 <Kamon size={12} color="var(--gold)" /></h6>
      <div className="tweak-row">
        <label>Language</label>
        <select value={tweaks.language} onChange={(e) => onUpdate('language', e.target.value)}>
          <option value="en">English</option>
          <option value="jp">日本語</option>
          <option value="bi">Bilingual</option>
        </select>
      </div>
      <div className="tweak-row">
        <label>Accent density</label>
        <select value={tweaks.accentDensity} onChange={(e) => onUpdate('accentDensity', e.target.value)}>
          <option value="minimal">Minimal</option>
          <option value="standard">Standard</option>
          <option value="rich">Rich</option>
        </select>
      </div>
      <div className="tweak-row">
        <label>Gold intensity</label>
        <select value={tweaks.goldIntensity} onChange={(e) => onUpdate('goldIntensity', e.target.value)}>
          <option value="muted">Muted</option>
          <option value="standard">Standard</option>
          <option value="bright">Bright</option>
        </select>
      </div>
      <div className="tweak-row">
        <label>Dot-grid background</label>
        <div
          className={'switch ' + (tweaks.dotGrid ? 'on' : '')}
          onClick={() => onUpdate('dotGrid', !tweaks.dotGrid)}
        />
      </div>
    </div>
  );
}
