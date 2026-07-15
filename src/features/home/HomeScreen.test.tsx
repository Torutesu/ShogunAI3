import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeScreen } from './HomeScreen';

const runRuntimeActionMock = vi.fn();

vi.mock('@/shared/ipc/runtime-actions', () => ({
  runRuntimeAction: (...args: unknown[]) => runRuntimeActionMock(...args),
}));

vi.mock('./hooks/useHomeBriefCards', () => ({
  useHomeBriefCards: () => ({
    morningBrief: null,
    memoryDigest: null,
    setMorningBrief: vi.fn(),
    setMemoryDigest: vi.fn(),
  }),
}));

vi.mock('./components/MorningBriefCard', () => ({
  MorningBriefCard: ({ sliSnapshot }: { sliSnapshot: any }) => (
    <div data-testid="sli-pill">
      {sliSnapshot ? `SLI ${sliSnapshot.successRate}% · backlog ${sliSnapshot.backlog}` : 'no-sli'}
    </div>
  ),
}));

vi.mock('./components/MemoryDigestCard', () => ({
  MemoryDigestCard: () => null,
}));

vi.mock('./components/AiFieldsCard', () => ({
  AiFieldsCard: () => null,
}));

vi.mock('./components/RecentContextCard', () => ({
  RecentContextCard: () => null,
}));

vi.mock('./components/SharedTasksCard', () => ({
  SharedTasksCard: () => null,
}));

vi.mock('./components/ShogunDriveGlyph', () => ({
  ShogunDriveGlyph: () => null,
}));

vi.mock('./lib/runtime', () => ({
  composerPlaceholderForLang: () => 'Ask anything',
  homeFirstNameToken: (fullName: string) => String(fullName || '').split(/\s+/)[0] || '',
  computeHomeGreetingState: () => ({
    greetEn: 'Hello',
    greetJp: 'こんにちは',
    dateEn: 'Thu, Jul 2',
    dateJp: '7月2日',
    dateBi: 'Thu, Jul 2 ／ 7月2日',
  }),
}));

describe('HomeScreen', () => {
  beforeEach(() => {
    document.body.setAttribute('data-lang', 'en');
    (window as any).SHOGUN_RUNTIME = {
      pushToast: vi.fn(),
      openSettingsPane: vi.fn(),
      setActiveScreen: vi.fn(),
    };
  });

  it('refreshes visible profile and memory stats when desktop events fire', async () => {
    let profileName = 'Alice Example';
    let memoryTotal = 42;
    let sliSnapshot = { successRate: 100, p95LatencyMs: 10, backlog: 0 };
    runRuntimeActionMock.mockImplementation((actionKey: string, payload?: any) => {
      if (actionKey === 'stats.get' && !payload?.stage) {
        return Promise.resolve({ ok: true, data: { memoryTotal } });
      }
      if (actionKey === 'stats.get' && payload?.stage === 'sli') {
        return Promise.resolve({ ok: true, data: { sli: sliSnapshot } });
      }
      if (actionKey === 'settings.load') {
        return Promise.resolve({
          ok: true,
          data: {
            settings: {
              sections: {
                general: { name: profileName },
                llm: { model: 'gpt-5' },
                observability: {
                  sliThresholds: {
                    bad: { successLt: 95, p95Gt: 3000, backlogGt: 40 },
                    warn: { successLt: 99, p95Gt: 1500, backlogGt: 15 },
                  },
                },
              },
            },
          },
        });
      }
      return Promise.resolve({ ok: true, data: {} });
    });

    render(<HomeScreen />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello, Alice.' })).toBeInTheDocument();
    });
    expect(screen.getByText(/42/)).toBeInTheDocument();
    expect(screen.getByTestId('sli-pill')).toHaveTextContent('SLI 100% · backlog 0');

    profileName = 'Bob Example';
    window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Hello, Bob.' })).toBeInTheDocument();
    });

    memoryTotal = 84;
    sliSnapshot = { successRate: 98.5, p95LatencyMs: 1800, backlog: 7 };
    window.dispatchEvent(new CustomEvent('shogun-memory-index-changed'));

    await waitFor(() => {
      expect(screen.getByText(/84/)).toBeInTheDocument();
    });
    expect(screen.getByTestId('sli-pill')).toHaveTextContent('SLI 98.5% · backlog 7');

    sliSnapshot = { successRate: 97, p95LatencyMs: 2200, backlog: 11 };
    window.dispatchEvent(new CustomEvent('shogun-settings-refresh'));

    await waitFor(() => {
      expect(screen.getByTestId('sli-pill')).toHaveTextContent('SLI 97% · backlog 11');
    });
  });
});
