import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { PaneMeetings } from './PaneMeetings';
import { SettingsHydrationContext } from '../types';

function mountPane(sections: Record<string, any>) {
  const executeAction = vi.fn().mockResolvedValue({ ok: true, data: {} });
  (window as any).SHOGUN_RUNTIME = {
    executeAction,
    requestWriteAction: vi.fn(),
    pushToast: vi.fn(),
  };
  const view = render(
    <SettingsHydrationContext.Provider value={{ sections, refreshSections: null }}>
      <PaneMeetings />
    </SettingsHydrationContext.Provider>,
  );
  return { executeAction, ...view };
}

describe('PaneMeetings', () => {
  beforeEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('hydrates meeting language from sections.meetings', async () => {
    mountPane({ meetings: { meetingLang: 'en', autoIngestToMemory: true } });
    const langRow = screen.getByText('Meeting Language').closest('.s-row') as HTMLElement;
    const select = within(langRow).getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('en'));
  });

  it('persists autoIngestToMemory toggle via settings.save', async () => {
    const { executeAction, container } = mountPane({
      meetings: { autoIngestToMemory: true, meetingLang: 'ja' },
    });
    const row = screen.getByText('Auto-Save Meetings to Memory').closest('.s-row')!;
    const toggle = row!.querySelector('.s-toggle') as HTMLElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'settings.save',
        expect.objectContaining({ section: 'meetings', autoIngestToMemory: false }),
        expect.any(Object),
      );
    });
    expect(container).toBeTruthy();
  });
});
