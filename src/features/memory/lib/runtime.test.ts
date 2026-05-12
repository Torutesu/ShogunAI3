import { describe, it, expect } from 'vitest';
import {
  deriveLocalProvenance,
  memoryProviderKey,
  memoryProvenanceLabel,
  extractWindowLabel,
  clusterScreenSessions,
} from './runtime';

// ─── deriveLocalProvenance ────────────────────────────────────────────────────

describe('deriveLocalProvenance', () => {
  it('maps capture_sampler to "screen"', () => {
    expect(deriveLocalProvenance('capture_sampler')).toBe('screen');
  });

  it('maps capture_ax to "screen"', () => {
    expect(deriveLocalProvenance('capture_ax')).toBe('screen');
  });

  it('maps google_calendar to "connector"', () => {
    expect(deriveLocalProvenance('google_calendar')).toBe('connector');
  });

  it('maps gmail to "connector"', () => {
    expect(deriveLocalProvenance('gmail')).toBe('connector');
  });

  it('maps meeting to "meeting"', () => {
    expect(deriveLocalProvenance('meeting')).toBe('meeting');
  });

  it('maps meetings_xyz to "meeting" (startsWith)', () => {
    expect(deriveLocalProvenance('meetings_weekly')).toBe('meeting');
  });

  it('defaults unknown source to "user"', () => {
    expect(deriveLocalProvenance('slack')).toBe('user');
    expect(deriveLocalProvenance('')).toBe('user');
    expect(deriveLocalProvenance(null)).toBe('user');
  });
});

// ─── memoryProviderKey ────────────────────────────────────────────────────────

describe('memoryProviderKey', () => {
  it('maps capture_sampler to "screen"', () => {
    expect(memoryProviderKey('capture_sampler')).toBe('screen');
  });

  it('maps capture_ax to "screen"', () => {
    expect(memoryProviderKey('capture_ax')).toBe('screen');
  });

  it('maps gmail to "gmail"', () => {
    expect(memoryProviderKey('gmail')).toBe('gmail');
  });

  it('maps google_calendar to "google_calendar"', () => {
    expect(memoryProviderKey('google_calendar')).toBe('google_calendar');
  });

  it('maps slack to "slack"', () => {
    expect(memoryProviderKey('slack')).toBe('slack');
  });

  it('maps notion to "notion"', () => {
    expect(memoryProviderKey('notion')).toBe('notion');
  });

  it('maps github to "github"', () => {
    expect(memoryProviderKey('github')).toBe('github');
  });

  it('maps meeting to "meeting"', () => {
    expect(memoryProviderKey('meeting')).toBe('meeting');
  });

  it('maps meetings_xyz to "meeting"', () => {
    expect(memoryProviderKey('meetings_daily')).toBe('meeting');
  });

  it('defaults unknown to "manual"', () => {
    expect(memoryProviderKey('unknown_source')).toBe('manual');
    expect(memoryProviderKey('')).toBe('manual');
    expect(memoryProviderKey(null)).toBe('manual');
  });

  it('is case-insensitive', () => {
    expect(memoryProviderKey('GMAIL')).toBe('gmail');
    expect(memoryProviderKey('Slack')).toBe('slack');
  });
});

// ─── memoryProvenanceLabel ────────────────────────────────────────────────────

describe('memoryProvenanceLabel', () => {
  it('returns Screen label for "screen"', () => {
    expect(memoryProvenanceLabel('screen')).toEqual({ en: 'Screen', jp: '画面' });
  });

  it('returns Connector label for "connector"', () => {
    expect(memoryProvenanceLabel('connector')).toEqual({ en: 'Connector', jp: '連携' });
  });

  it('returns Meeting label for "meeting"', () => {
    expect(memoryProvenanceLabel('meeting')).toEqual({ en: 'Meeting', jp: '会議' });
  });

  it('returns User label for unrecognized provenance', () => {
    expect(memoryProvenanceLabel('unknown')).toEqual({ en: 'User', jp: '手動' });
  });

  it('returns User label for null', () => {
    expect(memoryProvenanceLabel(null)).toEqual({ en: 'User', jp: '手動' });
  });

  it('returns User label for empty string', () => {
    expect(memoryProvenanceLabel('')).toEqual({ en: 'User', jp: '手動' });
  });
});

// ─── extractWindowLabel ───────────────────────────────────────────────────────

describe('extractWindowLabel', () => {
  it('extracts window label from window= line', () => {
    const snippet = 'window=VS Code — index.ts\nother content';
    expect(extractWindowLabel(snippet)).toBe('VS Code · index.ts');
  });

  it('truncates window label to 60 chars', () => {
    const longTitle = 'A'.repeat(80);
    const snippet = `window=${longTitle}`;
    const result = extractWindowLabel(snippet);
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it('falls back to title= line when window= is absent', () => {
    const snippet = 'title=My Document Title\nother content';
    expect(extractWindowLabel(snippet)).toBe('My Document Title');
  });

  it('falls back to AX prefix when only roleDesc= is present', () => {
    const snippet = 'roleDesc=AXWindow\nother content';
    expect(extractWindowLabel(snippet)).toBe('AX · AXWindow');
  });

  it('returns "Screen capture" for empty snippet', () => {
    expect(extractWindowLabel('')).toBe('Screen capture');
  });

  it('returns "Screen capture" for null', () => {
    expect(extractWindowLabel(null)).toBe('Screen capture');
  });

  it('returns "Screen capture" when no match at all', () => {
    expect(extractWindowLabel('just some random text')).toBe('Screen capture');
  });

  it('only joins first two parts for window= with multiple separators', () => {
    const snippet = 'window=App — Page — Tab\nmore';
    const result = extractWindowLabel(snippet);
    // Should join first two parts: "App · Page"
    expect(result).toBe('App · Page');
  });
});

// ─── clusterScreenSessions ────────────────────────────────────────────────────

describe('clusterScreenSessions', () => {
  const baseTs = 1_700_000_000_000;
  const gapMs = 15 * 60 * 1000;

  function makeScreenEvent(ts: number, snippet = 'window=VSCode\n'): any {
    return { ts, src: 'screen', sourceRaw: 'capture_ax', snippet, title: 'Screen' };
  }

  function makeOtherEvent(ts: number): any {
    return { ts, src: 'note', sourceRaw: 'gmail', snippet: '', title: 'Email' };
  }

  it('returns original array when empty', () => {
    expect(clusterScreenSessions([])).toEqual([]);
  });

  it('passes through non-screen events unchanged', () => {
    const events = [makeOtherEvent(baseTs)];
    const result = clusterScreenSessions(events);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceRaw).toBe('gmail');
  });

  it('clusters two screen events with the same label within gap', () => {
    const events = [
      makeScreenEvent(baseTs, 'window=VSCode\n'),
      makeScreenEvent(baseTs + 5 * 60 * 1000, 'window=VSCode\n'),
    ];
    const result = clusterScreenSessions(events, gapMs);
    expect(result).toHaveLength(1);
    expect(result[0]?.clusterCount).toBe(2);
  });

  it('does not cluster screen events with different labels', () => {
    const events = [
      makeScreenEvent(baseTs, 'window=VSCode\n'),
      makeScreenEvent(baseTs + 5 * 60 * 1000, 'window=Chrome\n'),
    ];
    const result = clusterScreenSessions(events, gapMs);
    expect(result).toHaveLength(2);
  });

  it('does not cluster screen events beyond the gap', () => {
    const events = [
      makeScreenEvent(baseTs, 'window=VSCode\n'),
      makeScreenEvent(baseTs + 20 * 60 * 1000, 'window=VSCode\n'),
    ];
    const result = clusterScreenSessions(events, gapMs);
    expect(result).toHaveLength(2);
  });

  it('flushes current cluster when a non-screen event appears', () => {
    const events = [
      makeScreenEvent(baseTs, 'window=VSCode\n'),
      makeOtherEvent(baseTs + 1000),
      makeScreenEvent(baseTs + 2000, 'window=VSCode\n'),
    ];
    const result = clusterScreenSessions(events, gapMs);
    // screen-cluster, other event, new screen-cluster = 3 items
    expect(result).toHaveLength(3);
  });

  it('sets title to "Session · <label>" for clustered events', () => {
    const events = [makeScreenEvent(baseTs, 'window=VSCode\n')];
    const result = clusterScreenSessions(events, gapMs);
    expect(result[0]?.title).toContain('Session ·');
  });
});
