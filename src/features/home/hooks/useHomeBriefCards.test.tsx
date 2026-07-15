import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useHomeBriefCards } from './useHomeBriefCards';
import { ACTION_LAYER_REFRESH_EVENT } from '@/shared/context/action-layer-events';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('@/shared/lib/brief-telemetry', () => ({
  BriefTelemetry: {
    EVENTS: {
      BRIEF_RENDERED: 'brief_rendered',
    },
    log: vi.fn(),
  },
}));

vi.mock('../lib/runtime', () => ({
  resolveUserTimeZoneId: () => 'Asia/Tokyo',
}));

function HookProbe() {
  const { morningBrief, memoryDigest } = useHomeBriefCards();
  return (
    <div>
      <div data-testid="brief-title">{String((morningBrief as any)?.title || '')}</div>
      <div data-testid="digest-title">{String((memoryDigest as any)?.day_rollup?.title || '')}</div>
    </div>
  );
}

describe('useHomeBriefCards', () => {
  beforeEach(() => {
    runRuntimeActionMock.mockReset();
    document.body.setAttribute('data-lang', 'en');
  });

  it('loads the morning brief and memory digest', async () => {
    runRuntimeActionMock.mockResolvedValue({
      ok: true,
      data: {
        brief: {
          title: 'Morning Brief Alpha',
          items: [],
        },
        memory_digest: {
          day_rollup: { title: 'Digest Alpha' },
          highlights: [],
        },
        skipped: false,
      },
    });

    render(<HookProbe />);

    await waitFor(() => {
      expect(screen.getByTestId('brief-title')).toHaveTextContent('Morning Brief Alpha');
    });
    expect(screen.getByTestId('digest-title')).toHaveTextContent('Digest Alpha');
    expect(runRuntimeActionMock).toHaveBeenCalledWith(
      'brief.get',
      { span: 'today', source: 'home', user_tz: 'Asia/Tokyo', lang: 'en' },
      { silentError: true },
    );
  });

  it('reloads brief data when shared refresh events fire', async () => {
    let version = 1;
    runRuntimeActionMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        data: {
          brief: {
            title: version === 1 ? 'Morning Brief Alpha' : 'Morning Brief Beta',
            items: [],
          },
          memory_digest: {
            day_rollup: { title: version === 1 ? 'Digest Alpha' : 'Digest Beta' },
            highlights: [],
          },
          skipped: false,
        },
      }),
    );

    render(<HookProbe />);

    await waitFor(() => {
      expect(screen.getByTestId('brief-title')).toHaveTextContent('Morning Brief Alpha');
    });

    version = 2;
    window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));

    await waitFor(() => {
      expect(screen.getByTestId('brief-title')).toHaveTextContent('Morning Brief Beta');
    });
    expect(screen.getByTestId('digest-title')).toHaveTextContent('Digest Beta');

    version = 1;
    window.dispatchEvent(new CustomEvent('shogun-meetings-changed'));
    await waitFor(() => {
      expect(screen.getByTestId('brief-title')).toHaveTextContent('Morning Brief Alpha');
    });

    version = 2;
    window.dispatchEvent(new CustomEvent(ACTION_LAYER_REFRESH_EVENT, { detail: { reason: 'test-refresh' } }));
    await waitFor(() => {
      expect(screen.getByTestId('brief-title')).toHaveTextContent('Morning Brief Beta');
    });
  });
});
