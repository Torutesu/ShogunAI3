import { useEffect, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { MEETINGS_COMING_UP_STORAGE, toastM } from '../lib/runtime';

const WKD = ['日', '月', '火', '水', '木', '金', '土'];

export function mapCalendarEvents(events: any[]): any[] {
  return events.map((ev: any, idx: number) => {
    const start = ev.startDateTimeMs != null
      ? new Date(ev.startDateTimeMs)
      : (ev.start ? new Date(ev.start) : new Date());
    const end = ev.endDateTimeMs != null
      ? new Date(ev.endDateTimeMs)
      : (ev.end ? new Date(ev.end) : start);
    return {
      id: String(ev.id || `ev-${idx}`),
      day: start.getDate(),
      monthLabel: `${start.getMonth() + 1}月`,
      weekday: WKD[start.getDay()],
      title: ev.summary || ev.title || '予定',
      timeRange: `${start.getHours()}:${String(start.getMinutes()).padStart(2, '0')}〜${end.getHours()}:${String(end.getMinutes()).padStart(2, '0')}`,
      startMs: start.getTime(),
      endMs: end.getTime(),
    };
  });
}

/** Hydrates coming-up list from localStorage cache, then syncs via calendar.sync. */
export function useMeetingsCalendar(): any[] {
  const [comingUp, setComingUp] = useState<any[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MEETINGS_COMING_UP_STORAGE);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length) setComingUp(parsed);
      }
    } catch {
      /* ignore */
    }
    runRuntimeAction('calendar.sync', { calendarId: 'primary', maxResults: 25 }, { silentError: true }).then((r) => {
      if (!r || !r.ok) {
        const errMsg = r && r.error && typeof r.error.message === 'string' ? r.error.message : '';
        if (errMsg && errMsg.indexOf('not configured') < 0) {
          toastM(`カレンダー同期に失敗しました — ${errMsg}`, 'warn');
        }
        return;
      }
      if (!r.data || !Array.isArray(r.data.events) || !r.data.events.length) return;
      const mapped = mapCalendarEvents(r.data.events);
      setComingUp(mapped);
      try {
        localStorage.setItem(MEETINGS_COMING_UP_STORAGE, JSON.stringify(mapped));
      } catch {
        /* ignore */
      }
    });
  }, []);

  return comingUp;
}
