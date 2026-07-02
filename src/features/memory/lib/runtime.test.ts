import { describe, expect, it, vi } from 'vitest';

import { openMemoryItem } from './runtime';

describe('memory runtime navigation helpers', () => {
  it('dispatches a jump event for a concrete memory id', async () => {
    const setActiveScreen = vi.fn();
    (window as any).SHOGUN_RUNTIME = { setActiveScreen };

    const detail = await new Promise<Record<string, unknown>>((resolve) => {
      const onJump = (event: Event) => {
        window.removeEventListener('shogun-jump-memory-timeline', onJump);
        resolve((event as CustomEvent<Record<string, unknown>>).detail);
      };
      window.addEventListener('shogun-jump-memory-timeline', onJump);
      openMemoryItem({
        memoryId: 'mem-123',
        query: 'Aurora context capture',
        view: 'river',
      });
    });

    expect(setActiveScreen).toHaveBeenCalledWith('memory');
    expect(detail).toEqual({
      memoryId: 'mem-123',
      query: 'Aurora context capture',
      view: 'river',
    });
  });
});
