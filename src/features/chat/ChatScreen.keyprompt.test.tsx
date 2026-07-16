import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ChatScreen } from './ChatScreen';

function mountWithKey(configured: boolean) {
  const executeAction = vi.fn().mockImplementation((key: string) => {
    if (key === 'llm.api_key_status') return Promise.resolve({ ok: true, data: { configured } });
    if (key === 'stats.get') return Promise.resolve({ ok: true, data: { memoryTotal: 0 } });
    return Promise.resolve({ ok: true, data: {} });
  });
  (window as any).SHOGUN_RUNTIME = { executeAction, requestWriteAction: vi.fn(), pushToast: vi.fn() };
  return render(<ChatScreen />);
}

describe('ChatScreen — API-key empty state', () => {
  beforeEach(() => { delete (window as any).SHOGUN_RUNTIME; });
  afterEach(() => { delete (window as any).SHOGUN_RUNTIME; });

  it('shows the add-a-key prompt when no LLM key is configured', async () => {
    mountWithKey(false);
    await waitFor(() => {
      expect(screen.getByText(/Add an API key to start chatting/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Add your key — Settings/)).toBeInTheDocument();
  });

  it('does not show the key prompt when a key is configured', async () => {
    mountWithKey(true);
    // let the status effect resolve
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(/Add an API key to start chatting/)).toBeNull();
  });
});
