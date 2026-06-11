import { describe, it, expect } from 'vitest';
import { mapCalendarEvents } from './useMeetingsCalendar';

describe('mapCalendarEvents', () => {
  it('maps API events to coming-up row shape', () => {
    const rows = mapCalendarEvents([
      {
        id: 'ev-1',
        summary: 'Design review',
        startDateTimeMs: Date.UTC(2026, 5, 11, 1, 0),
        endDateTimeMs: Date.UTC(2026, 5, 11, 2, 0),
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('ev-1');
    expect(rows[0].title).toBe('Design review');
    expect(rows[0].startMs).toBe(Date.UTC(2026, 5, 11, 1, 0));
    expect(rows[0].monthLabel).toMatch(/月$/);
  });
});
