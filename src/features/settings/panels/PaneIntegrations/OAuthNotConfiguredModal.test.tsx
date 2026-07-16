import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { OAuthNotConfiguredModal } from './OAuthNotConfiguredModal';

function mountModal(onSaved = vi.fn(), onClose = vi.fn()) {
  const executeAction = vi.fn().mockResolvedValue({ ok: true, data: { saved: true, configured: true } });
  (window as any).SHOGUN_RUNTIME = { executeAction, requestWriteAction: vi.fn(), pushToast: vi.fn() };
  const view = render(<OAuthNotConfiguredModal onClose={onClose} onSaved={onSaved} />);
  return { executeAction, onSaved, onClose, ...view };
}

describe('OAuthNotConfiguredModal', () => {
  beforeEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });
  afterEach(() => {
    delete (window as any).SHOGUN_RUNTIME;
  });

  it('disables Save until both id and secret are entered', () => {
    mountModal();
    const save = screen.getByRole('button', { name: /Save & connect|保存して接続/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/googleusercontent\.com/), { target: { value: 'abc.apps.googleusercontent.com' } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/GOCSPX/), { target: { value: 'GOCSPX-secret' } });
    expect(save).toBeEnabled();
  });

  it('dispatches oauth.google.app_set with the entered credentials, then calls onSaved + onClose', async () => {
    const { executeAction, onSaved, onClose } = mountModal();
    fireEvent.change(screen.getByPlaceholderText(/googleusercontent\.com/), { target: { value: '  123.apps.googleusercontent.com  ' } });
    fireEvent.change(screen.getByPlaceholderText(/GOCSPX/), { target: { value: ' GOCSPX-xyz ' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect|保存して接続/ }));

    await waitFor(() => {
      expect(executeAction).toHaveBeenCalledWith(
        'oauth.google.app_set',
        { clientId: '123.apps.googleusercontent.com', clientSecret: 'GOCSPX-xyz' },
        expect.any(Object),
      );
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an error and keeps the modal open when the save fails', async () => {
    const executeAction = vi.fn().mockResolvedValue({ ok: false, error: 'keychain_write_failed' });
    (window as any).SHOGUN_RUNTIME = { executeAction, pushToast: vi.fn() };
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<OAuthNotConfiguredModal onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText(/googleusercontent\.com/), { target: { value: 'x.apps.googleusercontent.com' } });
    fireEvent.change(screen.getByPlaceholderText(/GOCSPX/), { target: { value: 'GOCSPX-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Save & connect|保存して接続/ }));

    await waitFor(() => expect(screen.getByText('keychain_write_failed')).toBeInTheDocument());
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
