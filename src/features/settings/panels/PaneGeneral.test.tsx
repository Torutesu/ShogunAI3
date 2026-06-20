import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaneGeneral } from './PaneGeneral';
import { SettingsHydrationContext } from '../types';

function mountPane(sections: Record<string, any>) {
  const executeAction = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const refreshSections = vi.fn().mockResolvedValue(undefined);
  (window as any).SHOGUN_RUNTIME = {
    executeAction,
    requestWriteAction: vi.fn(),
    pushToast: vi.fn(),
  };
  render(
    <SettingsHydrationContext.Provider value={{ sections, refreshSections }}>
      <PaneGeneral />
    </SettingsHydrationContext.Provider>,
  );
  return { executeAction, refreshSections };
}

describe('PaneGeneral', () => {
  beforeEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('hydrates the display name from sections.general', async () => {
    mountPane({ general: { name: 'Alice Smith', email: 'alice@example.com' } });
    const input = screen.getByPlaceholderText('Your name') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Alice Smith'));
  });

  it('calls settings.save with the general section on name change blur', async () => {
    const { executeAction } = mountPane({ general: { name: 'Bob' } });
    const input = screen.getByPlaceholderText('Your name');
    fireEvent.change(input, { target: { value: 'Carol' } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'settings.save',
        expect.objectContaining({ section: 'general', name: 'Carol' }),
        expect.any(Object),
      );
    });
  });

  it('calls settings.save with the developer section when Memory DBG is toggled', async () => {
    const { executeAction } = mountPane({
      general: { name: 'Bob' },
      developer: { memoryDebugger: false },
    });
    const toggle = screen.getByRole('switch', { name: 'Memory DBG' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'settings.save',
        expect.objectContaining({ section: 'developer', memoryDebugger: true }),
        expect.any(Object),
      );
    });
  });
});
