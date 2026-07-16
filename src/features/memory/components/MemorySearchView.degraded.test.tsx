import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemorySearchView } from './MemorySearchView';

function mount(executeAction: ReturnType<typeof vi.fn>) {
  (window as any).SHOGUN_RUNTIME = { executeAction, requestWriteAction: vi.fn(), pushToast: vi.fn() };
  return render(
    <MemorySearchView workProjects={[]} assignments={{}} setAssignments={vi.fn()} />,
  );
}

describe('MemorySearchView — embedding-degraded notice', () => {
  beforeEach(() => { delete (window as any).SHOGUN_RUNTIME; });
  afterEach(() => { delete (window as any).SHOGUN_RUNTIME; });

  it('shows the notice when a query search reports embeddingDegraded', async () => {
    const executeAction = vi.fn().mockImplementation((key: string, payload: any) => {
      const degraded = key === 'memory.timelineSearch' && !!payload?.query;
      return Promise.resolve({ ok: true, data: { hits: [], embeddingDegraded: degraded } });
    });
    mount(executeAction);
    fireEvent.change(screen.getByPlaceholderText(/Search indexed memory/), { target: { value: 'invoices' } });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/Semantic search needs an OpenAI or Gemini embedding key/);
    }, { timeout: 1500 });
  });

  it('does not show the notice when the search is not degraded', async () => {
    const executeAction = vi.fn().mockResolvedValue({ ok: true, data: { hits: [], embeddingDegraded: false } });
    mount(executeAction);
    fireEvent.change(screen.getByPlaceholderText(/Search indexed memory/), { target: { value: 'invoices' } });
    // give the debounced search time to resolve
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('status')).toBeNull();
  });
});
