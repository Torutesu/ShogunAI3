import React, { useState } from 'react';
import { Pane } from '../components/Pane';
import { Field } from '../components/Field';
import { useRuntimeActions } from '../lib/hooks';
import { readSectionValue } from '../lib/utils';
import { SettingsHydrationContext } from '../types';

export function PaneChat() {
  const { run, toast } = useRuntimeActions();
  const { sections, refreshSections } = React.useContext(SettingsHydrationContext);
  const [instr, setInstr] = useState('');
  const [notes, setNotes] = useState('');
  React.useEffect(() => {
    const vi = readSectionValue(sections, 'chat.instructions');
    const vn = readSectionValue(sections, 'chat.notes');
    if (vi !== undefined) setInstr(vi);
    if (vn !== undefined) setNotes(vn);
  }, [sections]);
  return (
    <Pane title="Chat" jp="対話">
      <Field label="Custom Instructions" hint="Personalize your interactions with SHOGUN by providing your own instructions">
        <textarea className="s-textarea" value={instr} onChange={e => setInstr(e.target.value)} placeholder="Enter your custom instructions" rows={7} />
        <div className="row" style={{ marginTop: 8 }}>
          <span className="s-field-hint">No unsaved changes</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setInstr('')}>Discard</button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const r = await run(
                'settings.save',
                { section: 'chat.instructions', value: instr },
                { successMessage: 'Instructions saved' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          >
            Save
          </button>
        </div>
      </Field>
      <Field label="Assistant Notes" hint="Review and edit what SHOGUN has remembered from past chats to guide future conversations">
        <textarea className="s-textarea" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Edit SHOGUN's memory" rows={8} />
        <div className="row" style={{ marginTop: 8 }}>
          <span className="s-field-hint">{notes.length} / 2000 characters</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNotes('')}>Discard</button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              if (notes.length > 2000) return toast('Assistant notes exceed 2000 characters', 'error');
              const r = await run(
                'settings.save',
                { section: 'chat.notes', value: notes },
                { successMessage: 'Assistant notes saved' },
              );
              if (r && r.ok && refreshSections) await refreshSections();
            }}
          >
            Save
          </button>
        </div>
      </Field>
    </Pane>
  );
}
