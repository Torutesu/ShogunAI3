import React from 'react';
import { Toggle } from '../../components/Toggle';
import { timeBlockMinutesToHHMM, hhmmToMinutes, newQuietBlock } from '../../lib/privacy';
import { DAY_LABELS, FULL_DAY_NAMES } from '../../lib/defaults';

interface TimeBlock {
  id: string;
  label: string;
  startMinute: number;
  endMinute: number;
  days: number;
  enabled: boolean;
}

interface TimeBlocksSectionProps {
  apps: any[];
  sites: any[];
  timeBlocks: TimeBlock[];
  setTimeBlocks: (v: TimeBlock[]) => void;
  pendingTimeBlocksSaveRef: React.MutableRefObject<any>;
  persistPrivacy: (apps: any[], sites: any[], overrides?: any) => Promise<any>;
}

export function TimeBlocksSection({
  apps,
  sites,
  timeBlocks,
  setTimeBlocks,
  pendingTimeBlocksSaveRef,
  persistPrivacy,
}: TimeBlocksSectionProps) {
  return (
    <div className="s-card" style={{ marginBottom: 14, padding: '12px 16px 14px' }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Quiet hours</div>
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          onClick={async () => {
            const next = timeBlocks.concat([newQuietBlock()]);
            setTimeBlocks(next);
            await persistPrivacy(apps, sites, { timeBlocks: next });
          }}
        >
          + Add quiet block
        </button>
      </div>
      <div className="s-field-hint" style={{ marginBottom: 10, fontSize: 11 }}>
        Captures are skipped during these windows. Cross-midnight ranges (e.g. 22:00–07:00) are supported and applied based on the selected days.
      </div>
      {timeBlocks.length === 0 ? (
        <div className="s-field-hint" style={{ padding: 8 }}>No quiet blocks configured.</div>
      ) : (
        <div className="s-card">
          {timeBlocks.map((tb, i, arr) => (
            <div key={tb.id} className={'s-row' + (i === arr.length - 1 ? ' last' : '')} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  className="s-input"
                  style={{ flex: 1 }}
                  placeholder="Label (optional)"
                  value={tb.label}
                  onChange={(e) => {
                    const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, label: e.target.value } : x);
                    setTimeBlocks(next);
                    pendingTimeBlocksSaveRef.current = next;
                  }}
                  onBlur={async () => {
                    const next = pendingTimeBlocksSaveRef.current ?? timeBlocks;
                    pendingTimeBlocksSaveRef.current = null;
                    await persistPrivacy(apps, sites, { timeBlocks: next });
                  }}
                />
                <input
                  type="time"
                  className="s-input"
                  style={{ width: 110 }}
                  value={timeBlockMinutesToHHMM(tb.startMinute)}
                  onChange={async (e) => {
                    const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, startMinute: hhmmToMinutes(e.target.value) } : x);
                    setTimeBlocks(next);
                    await persistPrivacy(apps, sites, { timeBlocks: next });
                  }}
                />
                <span style={{ color: 'var(--text-dim)' }}>–</span>
                <input
                  type="time"
                  className="s-input"
                  style={{ width: 110 }}
                  value={timeBlockMinutesToHHMM(tb.endMinute)}
                  onChange={async (e) => {
                    const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, endMinute: hhmmToMinutes(e.target.value) } : x);
                    setTimeBlocks(next);
                    await persistPrivacy(apps, sites, { timeBlocks: next });
                  }}
                />
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  title="Remove quiet block"
                  onClick={async () => {
                    const next = timeBlocks.filter((x) => x.id !== tb.id);
                    setTimeBlocks(next);
                    await persistPrivacy(apps, sites, { timeBlocks: next });
                  }}
                >
                  ×
                </button>
                <Toggle
                  on={tb.enabled}
                  onClick={async () => {
                    const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, enabled: !x.enabled } : x);
                    setTimeBlocks(next);
                    await persistPrivacy(apps, sites, { timeBlocks: next });
                  }}
                />
              </div>
              <div className="row" style={{ gap: 4, marginTop: 8 }}>
                {DAY_LABELS.map((lbl, dayIdx) => {
                  const bit = 1 << dayIdx;
                  const on = (tb.days & bit) !== 0;
                  return (
                    <button
                      key={dayIdx}
                      type="button"
                      className="btn btn-sm"
                      aria-label={FULL_DAY_NAMES[dayIdx]}
                      aria-pressed={on}
                      style={{ minWidth: 28, height: 28, padding: 0, background: on ? 'var(--accent)' : 'var(--surface-2)', color: on ? 'var(--on-accent)' : 'inherit' }}
                      onClick={async () => {
                        const nextDays = on ? tb.days & ~bit : tb.days | bit;
                        const next = timeBlocks.map((x) => x.id === tb.id ? { ...x, days: nextDays & 0x7F } : x);
                        setTimeBlocks(next);
                        await persistPrivacy(apps, sites, { timeBlocks: next });
                      }}
                    >
                      {lbl}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
