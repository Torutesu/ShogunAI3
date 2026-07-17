import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PaneIntegrations } from './PaneIntegrations';
import { SettingsHydrationContext } from '../types';

function mount() {
  const executeAction = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const openPasteToken = vi.fn().mockReturnValue(true);
  (window as any).SHOGUN_RUNTIME = {
    executeAction, requestWriteAction: vi.fn(), pushToast: vi.fn(), openPasteToken,
  };
  const view = render(
    <SettingsHydrationContext.Provider value={{ sections: {}, refreshSections: null }}>
      <PaneIntegrations />
    </SettingsHydrationContext.Provider>,
  );
  return { openPasteToken, ...view };
}

function providerRow(title: string): HTMLElement {
  return screen.getByText(title).closest('.s-row') as HTMLElement;
}

describe('PaneIntegrations — token-import providers unlocked', () => {
  beforeEach(() => { delete (window as any).SHOGUN_RUNTIME; });
  afterEach(() => { delete (window as any).SHOGUN_RUNTIME; });

  it('renders a working Connect (not "Coming soon") for Slack and opens the paste-token dialog', () => {
    const { openPasteToken } = mount();
    const row = providerRow('Slack');
    const btn = within(row).getByRole('button', { name: 'Connect' });
    expect(btn).toBeEnabled();
    btn.click();
    expect(openPasteToken).toHaveBeenCalledWith('slack');
  });

  it('unlocks every provider whose connector ingests real data', () => {
    mount();
    for (const title of ['Slack', 'Notion', 'GitHub', 'Linear', 'Zoom', 'Outlook']) {
      const row = providerRow(title);
      expect(within(row).getByRole('button', { name: 'Connect' })).toBeEnabled();
    }
  });

  it('keeps Figma and Claude locked — their sync only writes a heartbeat', () => {
    // Both are accepted by the backend's supports_token_import, but their sync
    // ingests nothing real and points at a setting with no UI. "Coming soon" is
    // the honest label until that config UI exists.
    mount();
    for (const title of ['Figma', 'Claude']) {
      const row = providerRow(title);
      expect(within(row).getByRole('button', { name: 'Coming soon' })).toBeDisabled();
    }
  });

  it('keeps OAuth-only providers (e.g. Google Drive) as Coming soon', () => {
    mount();
    const row = providerRow('Google Drive');
    expect(within(row).getByRole('button', { name: 'Coming soon' })).toBeDisabled();
  });
});
