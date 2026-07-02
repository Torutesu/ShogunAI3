import { beforeEach, describe, expect, it } from 'vitest';

import {
  applyPersistedAgentRunsFromSettingsSections,
  buildPersistedAgentSettingsPatch,
  loadAgentOverrides,
  loadCustomAgents,
  loadPersistedAgentStateFromLocalStorage,
  loadPersistedAgentStateFromSettingsSections,
  saveAgentOverrides,
  saveCustomAgents,
} from './storage';

describe('agents storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips custom agents through localStorage', () => {
    saveCustomAgents([
      {
        id: 'custom-1',
        name: 'Aurora watcher',
        icon: 'memory',
        status: 'scheduled',
        trigger: 'every 1 hour',
        triggerSince: '2026-06-30',
        description: 'Tracks Aurora',
        tools: [{ name: 'memory', icon: 'memory' }],
        lastRunMs: null,
        nextRunMs: 123,
        recentRuns: [],
        isCustom: true,
        prompt: 'Review Aurora memory.',
      },
    ]);

    expect(loadCustomAgents()).toEqual([
      {
        id: 'custom-1',
        name: 'Aurora watcher',
        icon: 'memory',
        status: 'scheduled',
        trigger: 'every 1 hour',
        triggerSince: '2026-06-30',
        description: 'Tracks Aurora',
        tools: [{ name: 'memory', icon: 'memory' }],
        lastRunMs: null,
        nextRunMs: 123,
        recentRuns: [],
        isCustom: true,
        prompt: 'Review Aurora memory.',
      },
    ]);
  });

  it('drops malformed custom agent records', () => {
    window.localStorage.setItem(
      'shogun-agents-custom-v1',
      JSON.stringify([{ id: '', name: 'Broken' }, { id: 'ok', name: 'Missing fields' }]),
    );

    expect(loadCustomAgents()).toEqual([]);
  });

  it('round-trips agent overrides through localStorage', () => {
    saveAgentOverrides({
      'custom-1': {
        name: 'Updated Aurora watcher',
        prompt: 'Review updated memory.',
        paused: true,
      },
    });

    expect(loadAgentOverrides()).toEqual({
      'custom-1': {
        name: 'Updated Aurora watcher',
        prompt: 'Review updated memory.',
        paused: true,
      },
    });
  });

  it('loads persisted agent state from settings sections', () => {
    expect(
      loadPersistedAgentStateFromSettingsSections({
        agents: {
          customAgents: [
            {
              id: 'custom-1',
              name: 'Aurora watcher',
              icon: 'memory',
              status: 'scheduled',
              trigger: 'every 1 hour',
              triggerSince: '2026-06-30',
              description: 'Tracks Aurora',
              tools: [{ name: 'memory', icon: 'memory' }],
              lastRunMs: null,
              nextRunMs: 123,
              recentRuns: [],
              isCustom: true,
              prompt: 'Review Aurora memory.',
            },
          ],
          customAgentOverrides: {
            'custom-1': {
              paused: true,
            },
          },
        },
      }),
    ).toEqual({
      customAgents: [
        {
          id: 'custom-1',
          name: 'Aurora watcher',
          icon: 'memory',
          status: 'scheduled',
          trigger: 'every 1 hour',
          triggerSince: '2026-06-30',
          description: 'Tracks Aurora',
          tools: [{ name: 'memory', icon: 'memory' }],
          lastRunMs: null,
          nextRunMs: 123,
          recentRuns: [],
          isCustom: true,
          prompt: 'Review Aurora memory.',
        },
      ],
      agentOverrides: {
        'custom-1': {
          paused: true,
        },
      },
    });
  });

  it('builds one settings patch containing both custom agents and overrides', () => {
    expect(
      buildPersistedAgentSettingsPatch({
        customAgents: [{ id: 'custom-1' } as any],
        agentOverrides: { 'custom-1': { paused: true } },
      }),
    ).toEqual({
      section: 'agents',
      customAgents: [{ id: 'custom-1' }],
      customAgentOverrides: { 'custom-1': { paused: true } },
    });
  });

  it('loads both custom agents and overrides from localStorage as one state object', () => {
    saveCustomAgents([
      {
        id: 'custom-1',
        name: 'Aurora watcher',
        icon: 'memory',
        status: 'scheduled',
        trigger: 'every 1 hour',
        triggerSince: '2026-06-30',
        description: 'Tracks Aurora',
        tools: [{ name: 'memory', icon: 'memory' }],
        lastRunMs: null,
        nextRunMs: 123,
        recentRuns: [],
        isCustom: true,
        prompt: 'Review Aurora memory.',
      },
    ]);
    saveAgentOverrides({
      'custom-1': {
        paused: true,
      },
    });

    expect(loadPersistedAgentStateFromLocalStorage()).toEqual({
      customAgents: [
        {
          id: 'custom-1',
          name: 'Aurora watcher',
          icon: 'memory',
          status: 'scheduled',
          trigger: 'every 1 hour',
          triggerSince: '2026-06-30',
          description: 'Tracks Aurora',
          tools: [{ name: 'memory', icon: 'memory' }],
          lastRunMs: null,
          nextRunMs: 123,
          recentRuns: [],
          isCustom: true,
          prompt: 'Review Aurora memory.',
        },
      ],
      agentOverrides: {
        'custom-1': {
          paused: true,
        },
      },
    });
  });

  it('merges persisted run records from settings into custom agents', () => {
    expect(
      applyPersistedAgentRunsFromSettingsSections(
        [
          {
            id: 'custom-1',
            name: 'Aurora watcher',
            icon: 'memory',
            status: 'scheduled',
            trigger: 'every 1 hour',
            triggerSince: '2026-06-30',
            description: 'Tracks Aurora',
            tools: [{ name: 'memory', icon: 'memory' }],
            lastRunMs: null,
            nextRunMs: 123,
            recentRuns: [],
            isCustom: true,
            prompt: 'Review Aurora memory.',
          },
        ],
        {
          agents: {
            runs: {
              'custom-1': {
                atMs: 1710000000000,
                ok: false,
                summary: 'Draft failed for Aurora watcher',
                source: 'custom_agent_event:memory',
              },
            },
          },
        },
      ),
    ).toEqual([
      expect.objectContaining({
        id: 'custom-1',
        status: 'error',
        lastRunMs: 1710000000000,
        recentRuns: [
          expect.objectContaining({
            id: 'settings-run-custom-1-1710000000000',
            atMs: 1710000000000,
            msg: 'Draft failed for Aurora watcher',
            level: 'error',
            source: 'custom_agent_event:memory',
            error: 'Draft failed for Aurora watcher',
          }),
        ],
      }),
    ]);
  });
});
