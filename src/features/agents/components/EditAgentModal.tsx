import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from '@/shared/icons';
import type { AgentDemo, TriggerForm } from '../types';
import { parseTrigger, serializeTrigger } from '../lib/metadata';

interface EditAgentModalProps {
  agent: AgentDemo;
  onSave: (patch: { name: string; description: string; trigger: string }) => void;
  onClose: () => void;
}

export function EditAgentModal({ agent, onSave, onClose }: EditAgentModalProps) {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [triggerForm, setTriggerForm] = useState<TriggerForm>(() => parseTrigger(agent.trigger));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const nameValid = name.trim().length >= 1;
  const descValid = description.trim().length >= 1;
  const triggerValid = (() => {
    if (!triggerForm) return false;
    if (triggerForm.type === 'interval') return Number.isInteger(Number(triggerForm.value)) && Number(triggerForm.value) >= 1;
    if (triggerForm.type === 'event') return Boolean(triggerForm.source);
    if (triggerForm.type === 'daily') {
      if (!/^\d{2}:\d{2}$/.test(triggerForm.time || '')) return false;
      const parts = (triggerForm.time as string).split(':').map(Number);
      const h = parts[0] ?? 0;
      const m = parts[1] ?? 0;
      return h < 24 && m < 60;
    }
    if (triggerForm.type === 'weekly') return true;
    return false;
  })();
  const saveEnabled = nameValid && descValid && triggerValid;
  const fieldErrorStyle: CSSProperties = { color: 'var(--danger)', fontSize: 11, marginTop: 'var(--space-1)' };

  const setType = (type: TriggerForm['type']) => {
    if (type === 'interval') setTriggerForm({ type, value: 1, unit: 'hour' });
    else if (type === 'event') setTriggerForm({ type, source: 'calendar' });
    else if (type === 'daily') setTriggerForm({ type, time: '12:00' });
    else if (type === 'weekly') setTriggerForm({ type });
  };

  const onSubmit = () => {
    if (!saveEnabled) return;
    onSave({
      name: name.trim(),
      description: description.trim(),
      trigger: serializeTrigger(triggerForm),
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit agent"
      onClick={onClose}
      style={{
        position:'fixed', inset:0, zIndex:1000,
        background:'rgba(0,0,0,0.5)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background:'var(--surface)',
          border:`1px solid var(--border-hi)`,
          borderRadius:'var(--radius-lg)',
          padding:'var(--space-8)',
          maxWidth:480, width:'90%',
          boxShadow:'var(--shadow-lg)',
          display:'flex', flexDirection:'column', gap:'var(--space-5)',
        }}
      >
        <div style={{display:'flex', alignItems:'center', justifyContent:'space-between'}}>
          <div className="t-mono" style={{color:'var(--gold)'}}>EDIT AGENT</div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              all:'unset', cursor:'pointer',
              padding:6, borderRadius:'var(--radius-sm)', color:'var(--text-dim)',
            }}
          >
            <Icon name="x" size={14}/>
          </button>
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>NAME</div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!nameValid}
            maxLength={60}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:14,
            }}
          />
          {!nameValid && (
            <div style={fieldErrorStyle}>Name is required.</div>
          )}
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>DESCRIPTION</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={!descValid}
            rows={3}
            maxLength={240}
            style={{
              width:'100%',
              padding:'var(--space-2) var(--space-3)',
              background:'var(--surface-2)', border:`1px solid var(--border)`,
              borderRadius:'var(--radius-sm)',
              color:'var(--text)', fontFamily:'inherit', fontSize:13,
              resize:'vertical',
            }}
          />
          {!descValid && (
            <div style={fieldErrorStyle}>Description is required.</div>
          )}
        </div>

        <div>
          <div className="t-mono" style={{color:'var(--text-mute)', fontSize:10, marginBottom:'var(--space-2)'}}>TRIGGER</div>
          <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)', marginBottom:'var(--space-3)'}}>
            <span className="t-sm" style={{color:'var(--text-mute)'}}>Type:</span>
            <select
              value={triggerForm.type}
              onChange={(e) => setType(e.target.value as TriggerForm['type'])}
              style={{
                padding:'var(--space-1) var(--space-3)',
                background:'var(--surface-2)', border:`1px solid var(--border)`,
                borderRadius:'var(--radius-sm)',
                color:'var(--text)', fontFamily:'inherit', fontSize:13,
              }}
            >
              <option value="interval">Interval</option>
              <option value="event">Event</option>
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>

          {triggerForm.type === 'interval' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>Every</span>
              <input
                type="number"
                min={1}
                value={triggerForm.value}
                onChange={(e) => setTriggerForm({ ...triggerForm, value: Number(e.target.value) })}
                style={{
                  width:64, padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <select
                value={triggerForm.unit}
                onChange={(e) => setTriggerForm({ ...triggerForm, unit: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="minute">minutes</option>
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
            </div>
          )}

          {triggerForm.type === 'event' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>On</span>
              <select
                value={triggerForm.source}
                onChange={(e) => setTriggerForm({ ...triggerForm, source: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-3)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              >
                <option value="calendar">calendar</option>
              </select>
              <span className="t-sm" style={{color:'var(--text-mute)'}}>event</span>
            </div>
          )}

          {triggerForm.type === 'daily' && (
            <div style={{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
              <input
                type="time"
                value={triggerForm.time}
                onChange={(e) => setTriggerForm({ ...triggerForm, time: e.target.value })}
                style={{
                  padding:'var(--space-1) var(--space-2)',
                  background:'var(--surface-2)', border:`1px solid var(--border)`,
                  borderRadius:'var(--radius-sm)',
                  color:'var(--text)', fontFamily:'inherit', fontSize:13,
                }}
              />
              <span className="t-sm" style={{color:'var(--text-mute)'}}>daily</span>
            </div>
          )}

          {triggerForm.type === 'weekly' && (
            <div className="t-sm" style={{color:'var(--text-mute)'}}>
              Runs once a week. Specific day/time set by system.
            </div>
          )}
          {!triggerValid && (
            <div style={fieldErrorStyle}>Trigger format is invalid.</div>
          )}
        </div>

        <div className="row" style={{gap:'var(--space-2)', justifyContent:'flex-end', marginTop:'var(--space-2)'}}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!saveEnabled}
            onClick={onSubmit}
            style={{opacity: saveEnabled ? 1 : 0.5, cursor: saveEnabled ? 'pointer' : 'not-allowed'}}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
