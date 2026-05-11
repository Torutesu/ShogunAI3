/* eslint-disable max-lines -- Phase 2 Step 8: feature split. Will tighten in Phase 3 with finer component extraction. */
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeActionA } from '@/shared/ipc/runtime-actions';
import {
  memoryProviderKey,
  MEMORY_PROVIDER_META,
  memoryProvenanceLabel,
  clusterScreenSessions,
  renderHighlighted,
  mergeIndexHitsIntoRiver,
  openMemoryEntryInChat,
} from './lib/runtime';
import { MemoryDigestView } from './components/MemoryDigestView';
import { MemorySearchView } from './components/MemorySearchView';

export function MemoryScreen() {
  const [view, setView] = useState('river');
  const [digestState, setDigestState] = useState({
    week: null, day: null, loading: false, error: null, generatingWeek: false, generatingDay: false,
  });
  const [workspaceAssignments, setWorkspaceAssignments] = useState<Record<string, string>>({});
  const [workProjects, setWorkProjectsLocal] = useState<any[]>(() => {
    const get = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.getWorkProjects;
    return typeof get === 'function' ? get() : [];
  });
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [newWorkspaceDraft, setNewWorkspaceDraft] = useState('');

  useEffect(() => {
    const syncProjects = () => {
      const get = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.getWorkProjects;
      if (typeof get === 'function') setWorkProjectsLocal(get());
    };
    syncProjects();
    window.addEventListener('shogun-work-projects-changed', syncProjects);
    return () => window.removeEventListener('shogun-work-projects-changed', syncProjects);
  }, []);

  useEffect(() => {
    runRuntimeActionA('settings.load', {}, { silentError: true }).then((r: any) => {
      const map = r && r.ok
        && r.data && r.data.settings && r.data.settings.sections
        && r.data.settings.sections.workspace_memberships
        && r.data.settings.sections.workspace_memberships.memberships;
      if (map && typeof map === 'object') {
        setWorkspaceAssignments(map);
      }
    });
  }, []);

  const assignMemoryToWorkspace = useCallback(async (memoryId: string, workspaceId: string | null) => {
    if (!memoryId) return;
    const next = { ...workspaceAssignments };
    if (workspaceId) next[memoryId] = workspaceId;
    else delete next[memoryId];
    setWorkspaceAssignments(next);
    await runRuntimeActionA(
      'settings.save',
      { section: 'workspace_memberships', memberships: next },
      { silentError: true },
    );
    try {
      window.dispatchEvent(new CustomEvent('shogun-workspace-memberships-changed', {
        detail: { memberships: next },
      }));
    } catch (_) { /* ignore */ }
  }, [workspaceAssignments]);

  const [rawEvents, setRawEvents] = useState<any[]>(() => []);
  const [summaryByMemId, setSummaryByMemId] = useState<Record<string, any>>(() => ({}));
  const [batchSummarizing, setBatchSummarizing] = useState(0);
  const [weekRollup, setWeekRollup] = useState<any>(null);
  const [weekRollupLoading, setWeekRollupLoading] = useState(false);
  const [dayRollup, setDayRollup] = useState<any>(null);
  const [dayRollupLoading, setDayRollupLoading] = useState(false);
  const [monthRollup, setMonthRollup] = useState<any>(null);
  const [monthRollupLoading, setMonthRollupLoading] = useState(false);
  const [yearRollup, setYearRollup] = useState<any>(null);
  const [yearRollupLoading, setYearRollupLoading] = useState(false);
  const [scrubIdx, setScrubIdx] = useState(0);
  const [timelineSpan, setTimelineSpan] = useState('week');
  const [timelineCursor, setTimelineCursor] = useState(() => new Date());
  const [selectedDayOffset, setSelectedDayOffset] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState(() => ({
    sources: { screen: false, audio: true, input: true, calendar: true, mail: true },
    priority: { high: true, medium: true, low: false },
    providers: {
      screen: true,
      meeting: true,
      gmail: true,
      google_calendar: true,
      slack: true,
      notion: true,
      github: true,
      manual: true,
    },
  }));
  const timelineScrollRef = useRef<any>(null);
  const scrollTimeline = useCallback((dir: number) => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const step = Math.max(160, Math.floor(el.clientWidth * 0.6));
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  }, []);
  const timelineMsPerSpan = useMemo(() => {
    if (timelineSpan === 'day') return 24 * 60 * 60 * 1000;
    if (timelineSpan === 'week') return 7 * 24 * 60 * 60 * 1000;
    if (timelineSpan === 'month') return 30 * 24 * 60 * 60 * 1000;
    return 365 * 24 * 60 * 60 * 1000;
  }, [timelineSpan]);
  const shiftCursor = useCallback((dir: number) => {
    setTimelineCursor((d) => new Date(d.getTime() + dir * timelineMsPerSpan));
  }, [timelineMsPerSpan]);
  const jumpToToday = useCallback(() => {
    setTimelineCursor(new Date());
    setSelectedDayOffset(0);
  }, []);
  const spanDayCount = useMemo(() => {
    if (timelineSpan === 'day') return 1;
    if (timelineSpan === 'week') return 7;
    if (timelineSpan === 'month') return 12;
    return 12;
  }, [timelineSpan]);
  const weekDays = useMemo(() => {
    const out: Date[] = [];
    const base = new Date(timelineCursor);
    base.setHours(0, 0, 0, 0);
    if (timelineSpan === 'year') {
      for (let i = 12 - 1; i >= 0; i -= 1) {
        const d = new Date(base);
        d.setMonth(0, 1);
        d.setFullYear(d.getFullYear() - i);
        out.push(d);
      }
    } else if (timelineSpan === 'month') {
      for (let i = 12 - 1; i >= 0; i -= 1) {
        const d = new Date(base);
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        out.push(d);
      }
    } else {
      for (let i = spanDayCount - 1; i >= 0; i -= 1) {
        out.push(new Date(base.getTime() - i * 24 * 60 * 60 * 1000));
      }
    }
    return out;
  }, [timelineCursor, timelineSpan, spanDayCount]);
  const fmtMonthDay = (d: Date) => d.toLocaleString('en-US', { month: 'short', day: 'numeric' }).toUpperCase();
  const selectedDate = useMemo(() => {
    const last = weekDays.length - 1;
    const idx = Math.min(last, Math.max(0, last - selectedDayOffset));
    return weekDays[idx] || timelineCursor;
  }, [weekDays, selectedDayOffset, timelineCursor]);
  const fmtFullDate = (d: Date) => {
    try {
      if (timelineSpan === 'year')  return d.toLocaleString('en-US', { year: 'numeric' });
      if (timelineSpan === 'month') return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      return d.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    } catch (_e) { return d.toDateString(); }
  };
  const fmtFullDateJp = (d: Date) => {
    try {
      if (timelineSpan === 'year')  return d.toLocaleString('ja-JP', { year: 'numeric' });
      if (timelineSpan === 'month') return d.toLocaleString('ja-JP', { year: 'numeric', month: 'long' });
      return d.toLocaleString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    } catch (_e) { return ''; }
  };
  const rangeLabel = useMemo(() => {
    const first: Date | undefined = weekDays[0];
    const last: Date | undefined = weekDays[weekDays.length - 1];
    if (timelineSpan === 'day') return first ? fmtMonthDay(first) : '';
    if (timelineSpan === 'year') {
      return first && last ? `${first.getFullYear()} – ${last.getFullYear()}` : '';
    }
    if (timelineSpan === 'month') {
      if (!first || !last) return '';
      return `${first.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()} – ${last.toLocaleString('en-US', { month: 'short', year: 'numeric' }).toUpperCase()}`;
    }
    return first && last ? `${fmtMonthDay(first)} – ${fmtMonthDay(last)}` : '';
  }, [weekDays, timelineSpan]);
  const weekHistograms = useMemo(() => {
    let globalMax = 1;
    const src = Array.isArray(rawEvents) ? rawEvents : [];
    const perDay = weekDays.map((d) => {
      let bars: number[];
      let count = 0;
      if (timelineSpan === 'year') {
        bars = new Array(12).fill(0);
        const slotYear = d.getFullYear();
        src.forEach((e) => {
          if (!Number.isFinite(e.ts)) return;
          const ed = new Date(e.ts);
          if (ed.getFullYear() !== slotYear) return;
          const mi = Math.min(11, ed.getMonth()); bars[mi] = (bars[mi] ?? 0) + 1;
          count += 1;
        });
      } else if (timelineSpan === 'month') {
        bars = new Array(4).fill(0);
        const slotYear = d.getFullYear();
        const slotMonth = d.getMonth();
        src.forEach((e) => {
          if (!Number.isFinite(e.ts)) return;
          const ed = new Date(e.ts);
          if (ed.getFullYear() !== slotYear || ed.getMonth() !== slotMonth) return;
          const mi2 = Math.min(3, Math.floor((ed.getDate() - 1) / 7)); bars[mi2] = (bars[mi2] ?? 0) + 1;
          count += 1;
        });
      } else {
        bars = new Array(12).fill(0);
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const startMs = start.getTime();
        const endMs = startMs + 24 * 60 * 60 * 1000;
        src.forEach((e) => {
          if (!Number.isFinite(e.ts) || e.ts < startMs || e.ts >= endMs) return;
          const h = Math.max(0, Math.min(23, Math.floor(Number(e.h))));
          const mi3 = Math.min(11, Math.floor(h / 2)); bars[mi3] = (bars[mi3] ?? 0) + 1;
          count += 1;
        });
      }
      const dayMax = bars.reduce((a, b) => Math.max(a, b), 0);
      if (dayMax > globalMax) globalMax = dayMax;
      return { bars, count, dayMax };
    });
    return { perDay, globalMax };
  }, [weekDays, rawEvents, timelineSpan]);
  const memoryTotals = useMemo(() => {
    const counts = weekHistograms.perDay.map((d) => d.count);
    const total = counts.reduce((a, b) => a + b, 0);
    return { counts, total };
  }, [weekHistograms]);
  const activeFilterCount =
    Object.values(activeFilters.sources).filter(Boolean).length +
    Object.values(activeFilters.priority).filter(Boolean).length +
    Object.values(activeFilters.providers || {}).filter((v) => v === false).length;
  const toggleFilter = useCallback((group: string, key: string) => {
    setActiveFilters((prev: any) => ({
      ...prev,
      [group]: { ...prev[group], [key]: !prev[group][key] },
    }));
  }, []);
  const [sourceEntities, setSourceEntities] = useState<any[]>([]);
  const [semanticMemorySearch, setSemanticMemorySearch] = useState(true);
  const [allowServerMemoryAssembly, setAllowServerMemoryAssembly] = useState(true);
  const [memorySettingsLoaded, setMemorySettingsLoaded] = useState(false);
  const [scrubSummary, setScrubSummary] = useState<any>(null);
  const [scrubSummaryLoading, setScrubSummaryLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [summaryEnabled, setSummaryEnabled] = useState(true);
  const timelineLoading = !memorySettingsLoaded;
  const withSemantic = useCallback(
    (payload: any) => {
      if (!semanticMemorySearch) return payload;
      const q = String((payload && payload.query) || '').trim();
      if (!q) return payload;
      return { ...payload, semantic: true };
    },
    [semanticMemorySearch],
  );
  const refreshSourceEntities = () => {
    runRuntimeActionA('entity.query', { query: '' }, { silentError: true }).then((res: any) => {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.entities)) return;
      setSourceEntities(res.data.entities);
    });
  };
  useEffect(() => {
    refreshSourceEntities();
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await runRuntimeActionA('settings.load', {}, { silentError: true });
      if (cancelled) return;
      const mem = r?.ok && r.data?.settings?.sections?.memory;
      if (mem && typeof mem === 'object' && typeof mem.semanticRerank === 'boolean') {
        setSemanticMemorySearch(mem.semanticRerank);
      }
      if (mem && typeof mem === 'object') {
        setSummaryEnabled(mem.enableMemorySummary !== false);
      }
      const priv = r?.ok && r.data?.settings?.sections?.privacy;
      if (priv && typeof priv === 'object') {
        setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
      }
      setMemorySettingsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onPrivacy = () => {
      void runRuntimeActionA('settings.load', {}, { silentError: true }).then((r: any) => {
        const priv = r?.ok && r.data?.settings?.sections?.privacy;
        if (priv && typeof priv === 'object') {
          setAllowServerMemoryAssembly(priv.allowChatServerMemoryAssembly !== false);
        }
      });
    };
    window.addEventListener('shogun-privacy-settings-changed', onPrivacy);
    return () => window.removeEventListener('shogun-privacy-settings-changed', onPrivacy);
  }, []);
  const activeKinds = useMemo(
    () => Object.entries(activeFilters.sources).filter(([, on]) => on).map(([k]) => k),
    [activeFilters.sources],
  );
  const events = useMemo(() => {
    const showLow = !!activeFilters.priority.low;
    const provs = activeFilters.providers || {};
    const matchesProvider = (e: any) => (provs as any)[memoryProviderKey(e.sourceRaw)] !== false;
    const effectivePriority = (s: any) => (s && (s.userPriority || s.priority)) || null;
    const filtered = rawEvents.filter((e) => {
      if (!matchesProvider(e)) return false;
      if (showLow) return true;
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      if (!s) return true;
      return effectivePriority(s) !== 'low';
    });
    const clustered = clusterScreenSessions(filtered);
    const rank = (e: any) => {
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      const p = effectivePriority(s);
      if (!p) return 2;
      if (p === 'high') return 0;
      if (p === 'medium') return 1;
      if (p === 'low') return 3;
      return 2;
    };
    return clustered
      .slice()
      .sort((a, b) => {
        const rA = rank(a);
        const rB = rank(b);
        if (rA !== rB) return rA - rB;
        return (b.ts || 0) - (a.ts || 0);
      });
  }, [rawEvents, summaryByMemId, activeFilters.priority.low, activeFilters.providers]);
  useEffect(() => {
    if (!summaryEnabled || rawEvents.length === 0) return;
    let cancelled = false;
    const connectorItems = rawEvents
      .filter((e) => {
        const r = String(e.sourceRaw || '').toLowerCase();
        const isSummarizable =
          r === 'gmail' ||
          r === 'google_calendar' ||
          r === 'meetings' ||
          r === 'meeting_note' ||
          r === 'audio_meeting' ||
          e.provenance === 'connector' ||
          e.provenance === 'meeting';
        return isSummarizable && e.memoryId && !summaryByMemId[e.memoryId];
      })
      .slice(0, 30)
      .map((e) => ({
        id: e.memoryId,
        title: e.title || '',
        snippet: e.snippet || '',
        source: e.sourceRaw || '',
      }));
    if (connectorItems.length === 0) return;
    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
    setBatchSummarizing(connectorItems.length);
    (async () => {
      try {
        const res = await runRuntimeActionA('memory.summary.batch', { items: connectorItems, lang }, { silentError: true });
        if (cancelled || !res?.ok || !res.data?.ok) return;
        const next: Record<string, any> = {};
        for (const s of res.data.ok) {
          if (s && s.targetId) next[s.targetId] = s;
        }
        if (Object.keys(next).length === 0) return;
        setSummaryByMemId((prev) => ({ ...prev, ...next }));
      } finally {
        if (!cancelled) setBatchSummarizing(0);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawEvents, summaryEnabled]);
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'week') {
      setWeekRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const day = cursor.getDay();
    const mondayOffset = (day === 0 ? -6 : 1 - day);
    const monday = new Date(cursor);
    monday.setDate(cursor.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    const weekStartMs = monday.getTime();
    let cancelled = false;
    setWeekRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.get', { weekStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setWeekRollup(res.data.rollup);
        } else {
          setWeekRollup(null);
        }
      } finally {
        if (!cancelled) setWeekRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'day') {
      setDayRollup(null);
      return;
    }
    const cursor = new Date(timelineCursor);
    const day = new Date(cursor);
    day.setHours(0, 0, 0, 0);
    const dayStartMs = day.getTime();
    let cancelled = false;
    setDayRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.day.get', { dayStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setDayRollup(res.data.rollup);
        } else {
          setDayRollup(null);
        }
      } finally {
        if (!cancelled) setDayRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'month') {
      setMonthRollup(null);
      return;
    }
    const sel = selectedDate || timelineCursor;
    const monthStart = new Date(sel.getFullYear(), sel.getMonth(), 1, 0, 0, 0, 0);
    const monthStartMs = monthStart.getTime();
    let cancelled = false;
    setMonthRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.month.get', { monthStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setMonthRollup(res.data.rollup);
        } else {
          setMonthRollup(null);
        }
      } finally {
        if (!cancelled) setMonthRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, selectedDate, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!summaryEnabled || timelineSpan !== 'year') {
      setYearRollup(null);
      return;
    }
    const sel = selectedDate || timelineCursor;
    const yearStart = new Date(sel.getFullYear(), 0, 1, 0, 0, 0, 0);
    const yearStartMs = yearStart.getTime();
    let cancelled = false;
    setYearRollupLoading(true);
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.rollup.year.get', { yearStartMs, lang }, { silentError: true });
        if (cancelled) return;
        if (res?.ok && res.data?.rollup) {
          setYearRollup(res.data.rollup);
        } else {
          setYearRollup(null);
        }
      } finally {
        if (!cancelled) setYearRollupLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [timelineSpan, selectedDate, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
    let cancelled = false;
    (async () => {
      const res = await runRuntimeActionA('memory.search', withSemantic({ query: '', kinds: activeKinds, limit: 40 }), { silentError: true });
      if (cancelled) return;
      mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
    })();
    return () => { cancelled = true; };
  }, [memorySettingsLoaded, withSemantic, activeKinds]);
  useEffect(() => {
    const onIndexChanged = async () => {
      const r = await runRuntimeActionA('memory.search', withSemantic({ query: '', kinds: activeKinds, limit: 40 }), { silentError: true });
      mergeIndexHitsIntoRiver(r, setRawEvents, setScrubIdx);
      refreshSourceEntities();
    };
    window.addEventListener('shogun-memory-index-changed', onIndexChanged);
    return () => window.removeEventListener('shogun-memory-index-changed', onIndexChanged);
  }, [withSemantic, activeKinds]);
  useEffect(() => {
    setScrubIdx((i) => {
      if (events.length === 0) return 0;
      return Math.min(i, events.length - 1);
    });
  }, [events.length]);
  useEffect(() => {
    setSelectedDayOffset(0);
  }, [timelineSpan]);
  useEffect(() => {
    const onJump = () => {
      setView('river');
      requestAnimationFrame(() => {
        const el = document.querySelector('.memory-scrub-stage');
        if (el && typeof (el as any).scrollIntoView === 'function') {
          (el as any).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    };
    window.addEventListener('shogun-jump-memory-timeline', onJump);
    return () => window.removeEventListener('shogun-jump-memory-timeline', onJump);
  }, []);
  const { bins: _bins, maxBin: _maxBin } = useMemo(() => {
    const binCount = 64;
    const b = new Array(binCount).fill(0);
    events.forEach((e) => {
      const p = Math.max(0, Math.min(1, (e.h - 6) / (22 - 6)));
      b[Math.floor(p * (binCount - 1))] += e.big ? 2 : 1;
    });
    return { bins: b, maxBin: Math.max(...b, 1) };
  }, [events]);
  const scrubbed = timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null }
    : events.length
      ? events[Math.min(scrubIdx, events.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null };
  const srcIcon = (s: any) => s==='chat'?'chat':s==='meet'?'calendar':s==='note'?'note':s==='mail'?'mail':s==='agent'?'bot':s==='code'?'terminal':'file';
  const srcLabel = (s: any) => ({chat:'Conversation',meet:'Meeting',note:'Note',mail:'Email',agent:'Agent run',code:'Code'} as any)[s]||'Event';

  useEffect(() => {
    if (!summaryEnabled) {
      setScrubSummary(null);
      setShowRaw(true);
      return;
    }
    if (!scrubbed || !scrubbed.memoryId) {
      setScrubSummary(null);
      setShowRaw(false);
      return;
    }
    const rawSrc = String(scrubbed.sourceRaw || '').toLowerCase();
    const isSummarizable =
      rawSrc === 'gmail' ||
      rawSrc === 'google_calendar' ||
      rawSrc === 'meetings' ||
      rawSrc === 'meeting_note' ||
      rawSrc === 'audio_meeting' ||
      scrubbed.provenance === 'connector' ||
      scrubbed.provenance === 'meeting';
    if (!isSummarizable) {
      setScrubSummary(null);
      setShowRaw(true);
      return;
    }

    setShowRaw(false);
    const cached = summaryByMemId[scrubbed.memoryId];
    if (cached) {
      setScrubSummary(cached);
      setScrubSummaryLoading(false);
      return;
    }
    setScrubSummary(null);
    setScrubSummaryLoading(true);

    let cancelled = false;
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeActionA('memory.summary.get', {
          targetId: scrubbed.memoryId,
          targetKind: 'item',
          lang,
          item: {
            id: scrubbed.memoryId,
            title: scrubbed.title || '',
            snippet: scrubbed.snippet || '',
            source: scrubbed.sourceRaw || '',
          },
        }, { silentError: true });
        if (cancelled) return;
        if (res && res.ok && res.data && res.data.summary) {
          setScrubSummary(res.data.summary);
          const s = res.data.summary;
          if (s.targetId) {
            setSummaryByMemId((prev) => (prev[s.targetId] ? prev : { ...prev, [s.targetId]: s }));
          }
        } else {
          setScrubSummary(null);
        }
      } catch {
        if (!cancelled) setScrubSummary(null);
      } finally {
        if (!cancelled) setScrubSummaryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [scrubbed?.memoryId, scrubbed?.sourceRaw, scrubbed?.provenance, summaryEnabled, summaryByMemId]);

  // memoryHeadDate removed — was unused in JSX (Phase 2 split).

  const hourIndexFromEvents = useMemo(() => {
    const counts = new Array(24).fill(0);
    const firstIdx = new Array(24).fill(-1);
    const topPriority = new Array(24).fill(null);
    const priorityRank = (p: any) => (p === 'high' ? 2 : p === 'medium' ? 1 : 0);
    events.forEach((e, i) => {
      const hh = Math.floor(Number(e.h));
      const h = Math.max(0, Math.min(23, Number.isFinite(hh) ? hh : 12));
      if (firstIdx[h] < 0) firstIdx[h] = i;
      counts[h] += 1;
      const s = e.memoryId ? summaryByMemId[e.memoryId] : null;
      const p = s && (s.userPriority || s.priority);
      if (p === 'high' || p === 'medium') {
        if (priorityRank(p) > priorityRank(topPriority[h])) {
          topPriority[h] = p;
        }
      }
    });
    const maxC = Math.max(1, ...counts);
    return { counts, firstIdx, maxC, topPriority };
  }, [events, summaryByMemId]);

  const timeSpanLabel = useMemo(() => {
    if (!events.length) return '—';
    const hs = events.map((e) => Number(e.h)).filter((n) => Number.isFinite(n));
    if (!hs.length) return '—';
    const mn = Math.min(...hs);
    const mx = Math.max(...hs);
    const fmt = (x: number) => {
      const h = Math.floor(x);
      const m = Math.round((x - h) * 60) % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };
    return `${fmt(mn)}–${fmt(mx)}`;
  }, [events]);

  return (
    <div className="content-inner wide memory-screen" style={{padding:0, height:'100%', display:'flex', flexDirection:'column', overflowY:'auto'}}>
      {/* Header */}
      <div style={{padding:'24px 40px 0', display:'flex', alignItems:'flex-start', gap:20, flexWrap:'wrap'}}>
        <div style={{flex:1, minWidth:240}}>
          <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)'}}>Memory / Timeline</div>
          <h1 style={{margin:'10px 0 0', fontSize:32, fontWeight:600, letterSpacing:'-0.02em'}}>
            <span className="en-only">{fmtFullDate(selectedDate)}</span>
            <span className="jp" style={{display:'block', fontSize:14, color:'var(--text-mute)', fontWeight:400, marginTop:4}}>{fmtFullDateJp(selectedDate)}</span>
          </h1>
        </div>
        <div style={{display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}>
          <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:999, padding:2, background:'var(--surface)'}}>
            {[['river','River'],['kakejiku','Kakejiku'],['heatmap','Heatmap'],['digest','Digest'],['search','Search']].map(([k,l])=>(
              <button key={k ?? ''} type="button" onClick={()=>setView(k ?? '')} style={{
                padding:'6px 14px', borderRadius:999, border:'none',
                background: view===(k ?? '') ? 'var(--surface-2)' : 'transparent',
                color: view===(k ?? '') ? 'var(--text)' : 'var(--text-mute)',
                fontSize:12, fontWeight:500, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            ))}
          </div>
          <div style={{position:'relative'}}>
            <button type="button" aria-expanded={filtersOpen} style={{
              display:'inline-flex', alignItems:'center', gap:6,
              padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)',
              background: filtersOpen ? 'var(--surface-2)' : 'var(--surface)',
              color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
            }} onClick={()=>setFiltersOpen(v=>!v)}>
              <Icon name="filter" size={12}/>
              Filters{activeFilterCount>0 ? ` · ${activeFilterCount}` : ''}
            </button>
            {filtersOpen && (
              <>
                <div role="presentation" onMouseDown={()=>setFiltersOpen(false)} style={{position:'fixed', inset:0, zIndex:40}}/>
                <div role="menu" onMouseDown={(e)=>e.stopPropagation()} style={{
                  position:'absolute', top:'calc(100% + 6px)', right:0, zIndex:41,
                  minWidth:420, padding:10, borderRadius:12,
                  border:'1px solid var(--border-hi)', background:'var(--surface-2)',
                  boxShadow:'var(--shadow-md, 0 10px 30px rgba(0,0,0,0.25))',
                }}>
                  <div style={{ display: 'flex', gap: 20 }}>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Sources</div>
                      {[['screen','Screen capture'],['audio','Audio / Meetings'],['input','Manual input'],['calendar','Calendar'],['mail','Mail']].map(([k,l])=>(
                        <label key={k ?? ''} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={!!(activeFilters.sources as any)[k ?? '']} onChange={()=>toggleFilter('sources', k ?? '')}/>
                          <span>{l}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Priority</div>
                      {[['high','High'],['medium','Medium'],['low','Low']].map(([k,l])=>(
                        <label key={k ?? ''} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={!!(activeFilters.priority as any)[k ?? '']} onChange={()=>toggleFilter('priority', k ?? '')}/>
                          <span>{l}</span>
                        </label>
                      ))}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="t-mono" style={{fontSize:11, color:'var(--text-dim)', padding:'2px 6px 6px'}}>Providers</div>
                      {Object.entries(MEMORY_PROVIDER_META).map(([k,meta])=>(
                        <label key={k} style={{display:'flex', alignItems:'center', gap:10, padding:'8px 6px', cursor:'pointer', fontSize:13, color:'var(--text)'}}>
                          <input type="checkbox" checked={(activeFilters.providers as any)?.[k] !== false} onChange={()=>toggleFilter('providers', k)}/>
                          <span style={{display:'inline-flex', alignItems:'center', gap:6}}>
                            <span style={{width:8, height:8, borderRadius:2, background: meta.color, flexShrink:0}} aria-hidden="true"/>
                            {meta.en}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{display:'flex', gap:8, marginTop:8}}>
                    <button type="button" onClick={async ()=>{
                      const kinds = Object.entries(activeFilters.sources).filter(([,on])=>on).map(([x])=>x);
                      const res = await runRuntimeActionA('memory.search', withSemantic({ query:'', kinds, limit:80 }), { successMessage:'Filters applied' });
                      mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
                      setFiltersOpen(false);
                    }} style={{flex:1, padding:'6px 10px', borderRadius:8, border:'1px solid var(--border-hi)', background:'var(--gold)', color:'var(--bg)', fontSize:12, cursor:'pointer', fontFamily:'inherit', fontWeight:500}}>Apply</button>
                    <button type="button" onClick={()=>{ setActiveFilters({
                      sources: { screen: false, audio: true, input: true, calendar: true, mail: true },
                      priority: { high: true, medium: true, low: false },
                      providers: {
                        screen: true, meeting: true, gmail: true, google_calendar: true,
                        slack: true, notion: true, github: true, manual: true,
                      },
                    }); }} style={{padding:'6px 10px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>Reset</button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div style={{padding:'20px 40px 0', display:'flex', alignItems:'center', gap:16, flexWrap:'wrap'}}>
        <div style={{display:'inline-flex', border:'1px solid var(--border)', borderRadius:8, overflow:'hidden', background:'var(--surface)'}}>
          {[['day','Day'],['week','Week'],['month','Month'],['year','Year']].map(([k,l])=>{
            const on = timelineSpan===(k ?? '');
            return (
              <button key={k ?? ''} type="button" onClick={()=>setTimelineSpan(k ?? '')} style={{
                padding:'7px 16px', border:'none',
                background: on?'var(--surface-2)':'transparent',
                color: on?'var(--text)':'var(--text-mute)',
                fontSize:12, cursor:'pointer', fontFamily:'inherit',
              }}>{l}</button>
            );
          })}
        </div>
        <div style={{display:'flex', alignItems:'center', gap:6}}>
          <button type="button" onClick={()=>shiftCursor(-1)} aria-label="Previous range" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={13}/></button>
          <span className="t-mono" style={{fontSize:13, color:'var(--text)', padding:'0 8px'}}>{rangeLabel}</span>
          <button type="button" onClick={()=>shiftCursor(1)} aria-label="Next range" style={{width:30, height:30, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={13}/></button>
        </div>
        <button type="button" onClick={jumpToToday} style={{
          padding:'7px 14px', borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
        }}>
          <span className="en-only">Today</span>
          <span className="jp" style={{marginLeft:4, fontSize:11}}>· 今日</span>
        </button>
        <label
          style={{display:'inline-flex', alignItems:'center', gap:8, fontSize:12, color:'var(--text-mute)', cursor:'pointer', userSelect:'none'}}
          title="Use semantic re-rank for non-empty memory searches"
        >
          <input
            data-testid="memory-semantic-rerank"
            type="checkbox"
            checked={semanticMemorySearch}
            onChange={async (e) => {
              const prev = semanticMemorySearch;
              const next = e.target.checked;
              setSemanticMemorySearch(next);
              const r = await runRuntimeActionA(
                'settings.save',
                { section: 'memory', semanticRerank: next },
                { silentError: true },
              );
              if (!r?.ok) {
                setSemanticMemorySearch(prev);
                (window as any).SHOGUN_RUNTIME?.pushToast?.('Failed to save Semantic re-rank setting', 'warn');
              }
            }}
          />
          <span>Semantic re-rank</span>
        </label>
        <span style={{flex:1}}/>
        <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>{memoryTotals.total} MEMORIES · {Math.round(memoryTotals.total * 0.25)}H</span>
      </div>

      {/* Span cards */}
      <div style={{padding:'18px 40px 0', display:'grid', gridTemplateColumns:`repeat(${weekDays.length}, minmax(0, 1fr))`, gap:10}}>
        {weekDays.map((d, i)=>{
          const offset = (weekDays.length - 1) - i;
          const active = offset === selectedDayOffset;
          const { bars } = weekHistograms.perDay[i] || { bars: new Array(12).fill(0) };
          const maxBar = Math.max(1, weekHistograms.globalMax);
          return (
            <button key={d.toISOString()} type="button" onClick={()=>setSelectedDayOffset(offset)} style={{
              padding:'14px 16px 12px',
              borderRadius:14,
              border: active ? '1px solid color-mix(in srgb, var(--gold) 65%, var(--border))' : '1px solid var(--border)',
              background: active ? 'color-mix(in srgb, var(--gold) 8%, var(--surface))' : 'var(--surface)',
              minHeight:96,
              display:'flex', flexDirection:'column', gap:10,
              cursor:'pointer', fontFamily:'inherit', textAlign:'left',
              boxShadow: active ? '0 0 0 1px color-mix(in srgb, var(--gold) 25%, transparent)' : 'none',
              transition: 'border-color 120ms, background 120ms',
            }}>
              <div className="t-mono" style={{fontSize:11, color: active ? 'var(--gold)' : 'var(--text-dim)', letterSpacing:'0.14em'}}>
                {timelineSpan === 'year'
                  ? String(d.getFullYear())
                  : timelineSpan === 'month'
                    ? d.toLocaleString('en-US', { month: 'short', year: '2-digit' }).toUpperCase()
                    : fmtMonthDay(d)}
              </div>
              <div style={{position:'relative', height:28}} aria-hidden="true">
                <div style={{position:'absolute', inset:0, display:'flex', justifyContent:'space-between', pointerEvents:'none'}}>
                  {[0,1,2,3,4].map((k)=>(
                    <span key={k} style={{
                      width:1,
                      background: active
                        ? 'color-mix(in srgb, var(--gold) 22%, transparent)'
                        : 'color-mix(in srgb, var(--border) 90%, transparent)',
                      opacity: (k === 0 || k === 4) ? 0 : 0.55,
                    }}/>
                  ))}
                </div>
                <div style={{display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap:2, height:'100%'}}>
                  {bars.map((v: number, j: number)=>{
                    const h = v > 0 ? Math.round((v / maxBar) * 22) + 4 : 3;
                    return (
                      <span key={j} style={{
                        flex:'1 1 0',
                        height: h,
                        borderRadius:2,
                        background: active
                          ? (v > 0 ? 'var(--gold)' : 'color-mix(in srgb, var(--gold) 18%, transparent)')
                          : (v > 0 ? 'var(--border-hi)' : 'var(--border)'),
                        opacity: active ? (v > 0 ? 0.95 : 0.4) : (v > 0 ? 0.7 : 0.45),
                      }}/>
                    );
                  })}
                </div>
              </div>
              <div className="t-mono" style={{
                display:'flex',
                justifyContent:'space-between',
                fontSize:9,
                color: active ? 'color-mix(in srgb, var(--gold) 70%, var(--text-dim))' : 'var(--text-dim)',
                letterSpacing:0,
                opacity:0.75,
                marginTop:3,
                pointerEvents:'none',
              }} aria-hidden="true">
                {timelineSpan === 'year' ? (
                  <>
                    <span>Jan</span>
                    <span>Dec</span>
                  </>
                ) : timelineSpan === 'month' ? (
                  <>
                    <span>W1</span>
                    <span>W4</span>
                  </>
                ) : (
                  <>
                    <span>0</span>
                    <span>12</span>
                    <span>24</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Day rollup banner */}
      {timelineSpan === 'day' && summaryEnabled && (dayRollup || dayRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">DAY ROLLUP</span>
                <span className="jp">本日のまとめ</span>
              </span>
              {dayRollupLoading && !dayRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {dayRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const day = new Date(timelineCursor);
                    day.setHours(0, 0, 0, 0);
                    setDayRollupLoading(true);
                    setDayRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.day.get', {
                      dayStartMs: day.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setDayRollup(res.data.rollup);
                    setDayRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate today's rollup"
                >Regenerate</button>
              )}
            </div>
            {dayRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {dayRollup.title}
                </div>
                {Array.isArray(dayRollup.keyPoints) && dayRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {dayRollup.keyPoints.slice(0, 6).map((k: any, i: number) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Week rollup banner */}
      {timelineSpan === 'week' && summaryEnabled && (weekRollup || weekRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">WEEK ROLLUP</span>
                <span className="jp">週次サマリ</span>
              </span>
              {weekRollupLoading && !weekRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {weekRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const cursor = new Date(timelineCursor);
                    const day = cursor.getDay();
                    const mondayOffset = (day === 0 ? -6 : 1 - day);
                    const monday = new Date(cursor);
                    monday.setDate(cursor.getDate() + mondayOffset);
                    monday.setHours(0, 0, 0, 0);
                    setWeekRollupLoading(true);
                    setWeekRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.get', {
                      weekStartMs: monday.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setWeekRollup(res.data.rollup);
                    setWeekRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this week's rollup"
                >Regenerate</button>
              )}
            </div>
            {weekRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {weekRollup.title}
                </div>
                {Array.isArray(weekRollup.keyPoints) && weekRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {weekRollup.keyPoints.slice(0, 6).map((k: any, i: number) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Month rollup banner */}
      {timelineSpan === 'month' && summaryEnabled && (monthRollup || monthRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">MONTH ROLLUP</span>
                <span className="jp">今月のまとめ</span>
              </span>
              {monthRollupLoading && !monthRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {monthRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const sel = selectedDate || timelineCursor;
                    const monthStart = new Date(sel.getFullYear(), sel.getMonth(), 1, 0, 0, 0, 0);
                    setMonthRollupLoading(true);
                    setMonthRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.month.get', {
                      monthStartMs: monthStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setMonthRollup(res.data.rollup);
                    setMonthRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this month's rollup"
                >Regenerate</button>
              )}
            </div>
            {monthRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {monthRollup.title}
                </div>
                {Array.isArray(monthRollup.keyPoints) && monthRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {monthRollup.keyPoints.slice(0, 6).map((k: any, i: number) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Year rollup banner */}
      {timelineSpan === 'year' && summaryEnabled && (yearRollup || yearRollupLoading) && (
        <div style={{padding:'4px 40px 16px'}}>
          <div style={{
            padding:'14px 18px', borderRadius:12,
            border:'1px solid var(--border)',
            background:'color-mix(in srgb, var(--gold) 4%, var(--surface-2))',
            display:'flex', flexDirection:'column', gap:10,
          }}>
            <div style={{display:'flex', alignItems:'center', gap:10}}>
              <Icon name="memory" size={14} className="gold"/>
              <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.14em'}}>
                <span className="en-only">YEAR ROLLUP</span>
                <span className="jp">今年のまとめ</span>
              </span>
              {yearRollupLoading && !yearRollup && (
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', marginLeft:'auto'}}>
                  <span className="en-only">generating…</span>
                  <span className="jp">生成中…</span>
                </span>
              )}
              {yearRollup && (
                <button
                  type="button"
                  onClick={async () => {
                    const sel = selectedDate || timelineCursor;
                    const yearStart = new Date(sel.getFullYear(), 0, 1, 0, 0, 0, 0);
                    setYearRollupLoading(true);
                    setYearRollup(null);
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.rollup.year.get', {
                      yearStartMs: yearStart.getTime(), lang, regenerate: true,
                    }, { silentError: true });
                    if (res?.ok && res.data?.rollup) setYearRollup(res.data.rollup);
                    setYearRollupLoading(false);
                  }}
                  style={{
                    marginLeft:'auto',
                    padding:'2px 0', border:'none', background:'transparent',
                    color:'var(--text-dim)', fontSize:10, cursor:'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                  }}
                  title="Regenerate this year's rollup (cached monthly rollups are reused)"
                >Regenerate</button>
              )}
            </div>
            {yearRollup && (
              <>
                <div style={{fontSize:16, fontWeight:600, lineHeight:1.3, wordBreak:'break-word'}}>
                  {yearRollup.title}
                </div>
                {Array.isArray(yearRollup.keyPoints) && yearRollup.keyPoints.length > 0 && (
                  <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                    {yearRollup.keyPoints.slice(0, 6).map((k: any, i: number) => (
                      <li key={i} style={{fontSize:13, color:'var(--text)', lineHeight:1.5}}>{k}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div style={{padding:'12px 40px 0'}}>
        <div
          data-testid="memory-entity-sources"
          className="card"
          style={{padding:'12px 14px', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap'}}
        >
          <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.1em'}}>SOURCES IN INDEX</span>
          <span className="label">{sourceEntities.length}</span>
          <span style={{fontSize:12, color:'var(--text-mute)'}}>
            {sourceEntities.length > 0 ? 'entity sources discovered' : 'no entity sources yet'}
          </span>
        </div>
      </div>

      {/* River view */}
      {view === 'river' && (
      <>
      <div className="memory-scrub-stage" style={{padding:'24px 40px 24px', display:'grid', gridTemplateColumns:'minmax(0, 1fr) minmax(0, 1fr)', gap:20, minHeight:420}}>
        {/* Left: the scrubbed memory */}
        <div style={{
          padding:'24px 26px',
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--surface) 94%, var(--bg))',
          display:'flex', flexDirection:'column',
        }}>
          <div style={{display:'flex', alignItems:'center', gap:10, marginBottom:14}}>
            <div style={{width:32, height:32, borderRadius:8, background:'color-mix(in srgb, var(--gold) 14%, var(--surface-2))', display:'flex', alignItems:'center', justifyContent:'center', color:'var(--gold)'}}>
              <Icon name={srcIcon(scrubbed.src)} size={15}/>
            </div>
            <div className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.14em'}}>
              {srcLabel(scrubbed.src).toUpperCase()} · {scrubbed.t}
            </div>
            {(() => {
              const pk = memoryProviderKey(scrubbed.sourceRaw);
              const meta = MEMORY_PROVIDER_META[pk];
              if (!meta) return null;
              return (
                <span style={{
                  display:'inline-flex', alignItems:'center', gap:5,
                  padding:'2px 7px', borderRadius:4,
                  border:`1px solid color-mix(in srgb, ${meta.color} 50%, var(--border))`,
                  background:`color-mix(in srgb, ${meta.color} 10%, transparent)`,
                  color: meta.color,
                  fontSize:10, letterSpacing:'0.06em',
                  fontFamily:'var(--font-mono)',
                }}>
                  <span style={{width:6, height:6, borderRadius:'50%', background: meta.color}} aria-hidden="true"/>
                  {meta.en}
                </span>
              );
            })()}
            {events.length > 0 && !timelineLoading && (
              <div style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:4}}>
                <button
                  type="button"
                  aria-label="Previous memory"
                  onClick={() => setScrubIdx((i) => Math.max(0, i - 1))}
                  disabled={scrubIdx === 0}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx === 0 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx === 0 ? 0.35 : 1}}
                ><Icon name="chevronLeft" size={11}/></button>
                <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', padding:'0 2px'}}>
                  {Math.min(scrubIdx + 1, events.length)} / {events.length}
                  {rawEvents.length > events.length && (
                    <span style={{marginLeft:6, color:'var(--text-mute)'}} title="Low-priority items hidden. Toggle in Filters to show.">
                      (+{rawEvents.length - events.length})
                    </span>
                  )}
                  {batchSummarizing > 0 && (
                    <span style={{marginLeft:8, color:'var(--gold)'}} title={`Summarizing ${batchSummarizing} item(s)…`}>
                      · summarizing {batchSummarizing}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label="Next memory"
                  onClick={() => setScrubIdx((i) => Math.min(events.length - 1, i + 1))}
                  disabled={scrubIdx >= events.length - 1}
                  style={{width:22, height:22, borderRadius:6, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor: scrubIdx >= events.length - 1 ? 'default' : 'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center', opacity: scrubIdx >= events.length - 1 ? 0.35 : 1}}
                ><Icon name="chevronRight" size={11}/></button>
              </div>
            )}
          </div>
          {timelineLoading && (
            <>
              <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
                <span className="muted" style={{fontWeight:400, fontSize:16}}>
                  <span className="en-only">Loading timeline…</span>
                  <span className="jp">読み込み中…</span>
                </span>
              </h2>
              <p style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap'}}>
                <span className="muted">
                  <span className="en-only">Applying Memory search preferences before the first fetch.</span>
                  <span className="jp" style={{display:'block', marginTop:4}}>初回取得の前に設定を適用しています。</span>
                </span>
              </p>
            </>
          )}
          {!timelineLoading && (
            <div style={{display:'flex', gap:6, flexWrap:'wrap', marginBottom:12}}>
              {scrubbed.memoryId && (
                <span className="label">index</span>
              )}
              {scrubbed.provenance && (
                <span className="label" style={{borderColor:'var(--gold-dim)', color:'var(--gold)'}} title={scrubbed.sourceRaw || ''}>
                  <span className="en-only">{memoryProvenanceLabel(scrubbed.provenance).en}</span>
                  <span className="jp" style={{fontSize:10}}>{memoryProvenanceLabel(scrubbed.provenance).jp}</span>
                </span>
              )}
              {scrubbed.entityId && (
                <span className="label t-mono" style={{fontSize:9, maxWidth:140, overflow:'hidden', textOverflow:'ellipsis'}} title={scrubbed.entityId}>
                  id · {scrubbed.entityId.slice(0, 24)}{scrubbed.entityId.length > 24 ? '…' : ''}
                </span>
              )}
            </div>
          )}
          {!timelineLoading && scrubSummary && !showRaw && (() => {
            const effPriority = scrubSummary.userPriority || scrubSummary.priority;
            const pinned = !!scrubSummary.userPriority;
            const setPinPriority = async (tier: any) => {
              if (!scrubbed?.memoryId) return;
              const targetId = scrubbed.memoryId;
              const nextValue = tier === scrubSummary.userPriority ? null : tier;
              const nextSummary = { ...scrubSummary, userPriority: nextValue };
              setScrubSummary(nextSummary);
              setSummaryByMemId((prev) => ({ ...prev, [targetId]: nextSummary }));
              await runRuntimeActionA('memory.summary.set_priority', {
                targetId, targetKind: 'item', priority: nextValue,
              }, { silentError: true });
            };
            return (
            <div className="memory-summary-card" style={{
              display:'flex', flexDirection:'column', gap:10,
              marginBottom:14,
              borderLeft: effPriority === 'high'
                ? '2px solid var(--gold)'
                : '2px solid var(--border)',
              paddingLeft:14,
            }}>
              <div style={{display:'flex', alignItems:'baseline', gap:10, flexWrap:'wrap'}}>
                <div style={{fontSize:18, fontWeight:600, lineHeight:1.3, wordBreak:'break-word', flex:1, minWidth:0}}>{scrubSummary.title}</div>
                {pinned && (
                  <span className="t-mono" style={{fontSize:9, color:'var(--gold)', letterSpacing:'0.12em', padding:'2px 6px', border:'1px solid var(--gold-dim)', borderRadius:4}}>
                    <span className="en-only">PINNED</span>
                    <span className="jp">手動</span>
                  </span>
                )}
              </div>
              {Array.isArray(scrubSummary.keyPoints) && scrubSummary.keyPoints.length > 0 && (
                <ul style={{margin:0, paddingLeft:16, display:'flex', flexDirection:'column', gap:4}}>
                  {scrubSummary.keyPoints.slice(0, 4).map((k: any, i: number) => (
                    <li key={i} style={{fontSize:13, color: i === 0 ? 'var(--text)' : 'var(--text-mute)', lineHeight:1.5}}>{k}</li>
                  ))}
                </ul>
              )}
              <div style={{display:'flex', gap:14, marginTop:2, alignItems:'center', flexWrap:'wrap'}}>
                <div style={{display:'flex', gap:4, alignItems:'center'}} title="Set the priority for this item. Click the active tier to clear the override.">
                  <span className="t-mono" style={{fontSize:9, color:'var(--text-dim)', letterSpacing:'0.1em', marginRight:2}}>PIN</span>
                  {[{k:'high', label:'H'}, {k:'medium', label:'M'}, {k:'low', label:'L'}].map(({k, label}) => {
                    const active = effPriority === k;
                    const isOverride = scrubSummary.userPriority === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPinPriority(k)}
                        style={{
                          width:18, height:18, padding:0,
                          border:'1px solid ' + (active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'var(--border)'),
                          background: active ? (k === 'high' ? 'var(--gold)' : 'var(--border-hi)') : 'transparent',
                          color: active ? 'var(--bg)' : 'var(--text-dim)',
                          fontFamily: 'inherit', fontSize: 10, fontWeight: isOverride ? 700 : 500,
                          borderRadius: 3, cursor: 'pointer',
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                      >{label}</button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => setShowRaw(true)} style={{
                  padding:'4px 0', borderRadius:0, border:'none',
                  background:'transparent', color:'var(--text-dim)', fontSize:11, cursor:'pointer', fontFamily:'inherit', textDecoration:'underline',
                }}>Show raw</button>
                <button
                  type="button"
                  disabled={scrubSummaryLoading}
                  onClick={async () => {
                    if (!scrubbed?.memoryId) return;
                    const targetId = scrubbed.memoryId;
                    setScrubSummaryLoading(true);
                    setScrubSummary(null);
                    setSummaryByMemId((prev) => {
                      const next = { ...prev };
                      delete next[targetId];
                      return next;
                    });
                    await runRuntimeActionA('memory.summary.invalidate', {
                      targetId, targetKind: 'item',
                    }, { silentError: true });
                    const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
                    const res = await runRuntimeActionA('memory.summary.get', {
                      targetId, targetKind: 'item', lang,
                      item: {
                        id: targetId,
                        title: scrubbed.title || '',
                        snippet: scrubbed.snippet || '',
                        source: scrubbed.sourceRaw || '',
                      },
                    }, { silentError: true });
                    if (res?.ok && res.data?.summary) {
                      setScrubSummary(res.data.summary);
                      setSummaryByMemId((prev) => ({ ...prev, [targetId]: res.data.summary }));
                    }
                    setScrubSummaryLoading(false);
                  }}
                  style={{
                    padding:'4px 0', borderRadius:0, border:'none',
                    background:'transparent',
                    color: scrubSummaryLoading ? 'var(--text-mute)' : 'var(--text-dim)',
                    fontSize:11,
                    cursor: scrubSummaryLoading ? 'default' : 'pointer',
                    fontFamily:'inherit', textDecoration:'underline',
                    opacity: scrubSummaryLoading ? 0.5 : 1,
                  }}
                  title="Regenerate this summary (clears cache)"
                >
                  {scrubSummaryLoading ? 'Regenerating…' : 'Regenerate'}
                </button>
              </div>
            </div>
            );
          })()}
          {!timelineLoading && scrubSummaryLoading && !scrubSummary && (
            <div style={{padding:'20px 18px', marginBottom:16, color:'var(--text-dim)', fontSize:13, textAlign:'center', border:'1px solid var(--border)', borderRadius:12, background:'var(--surface)'}}>
              <span className="en-only">Generating summary…</span>
              <span className="jp">要約を生成中…</span>
            </div>
          )}
          {!timelineLoading && (showRaw || (!scrubSummary && !scrubSummaryLoading)) && (
            <>
              <h2 style={{margin:'0 0 14px', fontSize:22, fontWeight:600, letterSpacing:'-0.01em', wordBreak:'break-word'}}>
                {renderHighlighted(scrubbed.titleHighlight || scrubbed.title)}
              </h2>
              {scrubbed.clusterCount > 1 && (
                <div className="t-mono" style={{margin:'-8px 0 14px', fontSize:11, color:'var(--text-dim)', letterSpacing:'0.06em'}}>
                  {scrubbed.clusterCount} captures · {new Date(scrubbed.clusterStart).toTimeString().slice(0,5)}
                  {' – '}
                  {new Date(scrubbed.clusterEnd).toTimeString().slice(0,5)}
                </div>
              )}
              <div style={{margin:'0 0 16px', fontSize:14, lineHeight:1.6, color:'var(--text)', whiteSpace:'pre-wrap', maxHeight:320, overflowY:'auto', wordBreak:'break-word'}}>
                {scrubbed.snippetHighlight
                  ? renderHighlighted(scrubbed.snippetHighlight)
                  : scrubbed.snippet || (events.length ? 'No snippet text for this entry.' : 'No memories in the index yet.')}
              </div>
              {scrubSummary && (
                <div style={{marginBottom:16}}>
                  <button type="button" onClick={() => setShowRaw(false)} style={{
                    padding:'6px 12px', borderRadius:8, border:'1px solid var(--border)',
                    background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit',
                  }}>Show summary</button>
                </div>
              )}
            </>
          )}
          <span style={{flex:1}}/>
          <div style={{display:'flex', gap:8, marginTop:18, paddingTop:14, borderTop:'1px solid var(--border)', flexWrap:'wrap', alignItems:'center', position:'relative'}}>
            {scrubbed.memoryId && !timelineLoading && (
              <button
                type="button"
                onClick={() => {
                  openMemoryEntryInChat(
                    { title: scrubbed.title, snippet: scrubbed.snippet },
                    {
                      memoryAssemblyQuery: scrubbed.title,
                      memoryAssemblyLimit: 14,
                      allowServerMemoryAssembly,
                      newChat: true,
                    },
                  );
                }}
                style={{display:'inline-flex', alignItems:'center', gap:6, padding:'7px 12px', borderRadius:10, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}
              >
                <Icon name="chat" size={13}/>
                <span className="en-only">Open in Chat</span>
                <span className="jp" style={{fontSize:11}}>チャットへ</span>
              </button>
            )}
            {scrubbed.memoryId && !timelineLoading && (() => {
              const assignedId = workspaceAssignments[scrubbed.memoryId];
              const assignedProject = assignedId
                ? workProjects.find((p) => p.id === assignedId)
                : null;
              const label = assignedProject ? assignedProject.name : 'Assign to workspace';
              return (
                <>
                  <button
                    type="button"
                    onClick={() => setAssignMenuOpen((v) => !v)}
                    style={{
                      display:'inline-flex', alignItems:'center', gap:6,
                      padding:'7px 12px', borderRadius:10,
                      border:'1px solid ' + (assignedProject ? 'var(--gold-dim)' : 'var(--border)'),
                      background: assignedProject ? 'color-mix(in srgb, var(--gold) 10%, var(--surface))' : 'var(--surface)',
                      color: assignedProject ? 'var(--gold)' : 'var(--text-mute)',
                      fontSize:12, cursor:'pointer', fontFamily:'inherit', maxWidth:240,
                      overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                    }}
                  >
                    <Icon name="work" size={13}/>
                    <span style={{overflow:'hidden', textOverflow:'ellipsis'}}>{label}</span>
                  </button>
                  {assignMenuOpen && (
                    <>
                      <div role="presentation" onMouseDown={()=>setAssignMenuOpen(false)} style={{position:'fixed', inset:0, zIndex:40}}/>
                      <div
                        role="menu"
                        onMouseDown={(e)=>e.stopPropagation()}
                        style={{
                          position:'absolute', top:'calc(100% + 6px)', left:0, zIndex:41,
                          minWidth:240, padding:6, borderRadius:10,
                          border:'1px solid var(--border-hi)', background:'var(--surface-2)',
                          boxShadow:'0 10px 30px rgba(0,0,0,0.35)',
                          display:'flex', flexDirection:'column', gap:2,
                          maxHeight:280, overflowY:'auto',
                        }}
                      >
                        {workProjects.length === 0 && (
                          <div style={{padding:'8px 10px', fontSize:12, color:'var(--text-dim)'}}>
                            No workspaces yet.
                          </div>
                        )}
                        {workProjects
                          .filter((p) => !p.archived)
                          .map((p) => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={async () => {
                                await assignMemoryToWorkspace(scrubbed.memoryId, p.id);
                                setAssignMenuOpen(false);
                              }}
                              style={{
                                textAlign:'left', padding:'8px 10px', borderRadius:6,
                                border:0, background: p.id === assignedId ? 'color-mix(in srgb, var(--gold) 12%, transparent)' : 'transparent',
                                color: 'var(--text)', fontSize:13, cursor:'pointer',
                                display:'flex', alignItems:'center', gap:8, fontFamily:'inherit',
                              }}
                            >
                              <Icon name="work" size={12} className={p.id === assignedId ? 'gold' : 'dim'}/>
                              <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{p.name}</span>
                              {p.id === assignedId && <Icon name="check" size={11} className="gold"/>}
                            </button>
                          ))}
                        {assignedId && (
                          <button
                            type="button"
                            onClick={async () => {
                              await assignMemoryToWorkspace(scrubbed.memoryId, null);
                              setAssignMenuOpen(false);
                            }}
                            style={{
                              textAlign:'left', padding:'8px 10px', borderRadius:6,
                              border:0, background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer',
                              borderTop:'1px solid var(--border)', marginTop:2, fontFamily:'inherit',
                            }}
                          >
                            Unassign
                          </button>
                        )}
                        <div style={{borderTop:'1px solid var(--border)', marginTop:4, paddingTop:6, display:'flex', gap:6}}>
                          <input
                            type="text"
                            value={newWorkspaceDraft}
                            onChange={(e) => setNewWorkspaceDraft(e.target.value)}
                            onKeyDown={async (e) => {
                              if (e.key !== 'Enter') return;
                              const name = newWorkspaceDraft.trim();
                              if (!name) return;
                              const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
                              const newId = typeof create === 'function' ? create(name) : null;
                              if (newId) {
                                setNewWorkspaceDraft('');
                                await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                                setAssignMenuOpen(false);
                              }
                            }}
                            placeholder="New workspace…"
                            style={{
                              flex:1, padding:'6px 8px', borderRadius:6,
                              border:'1px solid var(--border)', background:'var(--bg)', color:'var(--text)',
                              fontSize:12, fontFamily:'inherit',
                            }}
                          />
                          <button
                            type="button"
                            onClick={async () => {
                              const name = newWorkspaceDraft.trim();
                              if (!name) return;
                              const create = (window as any).SHOGUN_RUNTIME && (window as any).SHOGUN_RUNTIME.createWorkProject;
                              const newId = typeof create === 'function' ? create(name) : null;
                              if (newId) {
                                setNewWorkspaceDraft('');
                                await assignMemoryToWorkspace(scrubbed.memoryId, newId);
                                setAssignMenuOpen(false);
                              }
                            }}
                            disabled={!newWorkspaceDraft.trim()}
                            style={{
                              padding:'6px 10px', borderRadius:6,
                              border:'1px solid var(--border-hi)',
                              background:'var(--surface)', color:'var(--text)',
                              fontSize:12, cursor: newWorkspaceDraft.trim() ? 'pointer' : 'default',
                              opacity: newWorkspaceDraft.trim() ? 1 : 0.5,
                              fontFamily:'inherit',
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </>
              );
            })()}
            <span style={{flex:1}}/>
          </div>
        </div>

        {/* Right: details panel */}
        <div style={{
          borderRadius:18,
          border:'1px solid var(--border)',
          background:'color-mix(in srgb, var(--bg) 60%, var(--surface))',
          overflow:'hidden',
          display:'flex', flexDirection:'column',
        }}>
          <div style={{padding:'14px 18px', borderBottom:'1px solid var(--border)', display:'flex', alignItems:'center', gap:10}}>
            <Icon name="memory" size={14} className="gold"/>
            <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.12em'}}>
              <span className="en-only">Memory details</span>
              <span className="jp" style={{marginLeft:6, fontSize:10}}>メモリ詳細</span>
            </span>
          </div>
          <div style={{flex:1, padding:'18px 22px', display:'flex', flexDirection:'column', gap:14, minHeight:280, overflowY:'auto'}}>
            {scrubbed.memoryId ? (
              <>
                <div style={{display:'grid', gridTemplateColumns:'110px 1fr', rowGap:10, columnGap:12, fontSize:12}}>
                  <span className="t-mono" style={{color:'var(--text-dim)'}}>Source</span>
                  <span style={{color:'var(--text)', wordBreak:'break-word'}}>{scrubbed.sourceRaw || srcLabel(scrubbed.src)}</span>
                  <span className="t-mono" style={{color:'var(--text-dim)'}}>Captured</span>
                  <span style={{color:'var(--text)'}}>{scrubbed.t}</span>
                  {scrubSummary && scrubSummary.priority && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Priority</span>
                      <span style={{color:'var(--text)'}}>{String(scrubSummary.priority).toUpperCase()}</span>
                    </>
                  )}
                  {scrubSummary && scrubSummary.reason && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Reason</span>
                      <span style={{color:'var(--text-mute)', wordBreak:'break-word', fontSize:12}}>{scrubSummary.reason}</span>
                    </>
                  )}
                  {scrubbed.entityId && (
                    <>
                      <span className="t-mono" style={{color:'var(--text-dim)'}}>Entity</span>
                      <span className="t-mono" style={{color:'var(--text-mute)', wordBreak:'break-all', fontSize:11}}>{scrubbed.entityId}</span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <div style={{flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:8, color:'var(--text-dim)', fontSize:13, textAlign:'center', padding:'0 20px'}}>
                <Icon name="memory" size={22}/>
                <span className="en-only">Select a memory to see its details.</span>
                <span className="jp" style={{fontSize:12}}>メモリを選ぶと詳細が表示されます。</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Timeline scrubber */}
      <div style={{marginTop:'auto', padding:'18px 40px 28px', borderTop:'1px solid var(--border)'}}>
        <div style={{display:'flex', alignItems:'center', gap:14, marginBottom:12}}>
          <span style={{fontSize:11, color:'var(--text-mute)', letterSpacing:'0.08em', fontFamily:'inherit'}}>Timeline</span>
          <span style={{flex:1}}/>
          <button type="button" onClick={()=>scrollTimeline(-1)} aria-label="Scroll timeline left" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronLeft" size={12}/></button>
          <button type="button" onClick={()=>scrollTimeline(1)} aria-label="Scroll timeline right" style={{width:26, height:26, borderRadius:999, border:'1px solid var(--border)', background:'var(--surface)', color:'var(--text-mute)', cursor:'pointer', display:'inline-flex', alignItems:'center', justifyContent:'center'}}><Icon name="chevronRight" size={12}/></button>
          <span className="t-mono" style={{fontSize:11, color:'var(--text-mute)'}}>{events.length} events · {timeSpanLabel}</span>
        </div>
        <div
          ref={timelineScrollRef}
          role="group"
          aria-label="Event timeline"
          style={{
            overflowX:'auto',
            overflowY:'hidden',
            paddingBottom:2,
            scrollbarWidth:'thin',
            WebkitOverflowScrolling:'touch',
            width:'100%',
            maxWidth:'100%',
            minWidth:0,
          }}
        >
          <div style={{position:'relative', width: 24 * 96, height:72, flexShrink:0}}>
            <div style={{position:'absolute', inset:'0 0 26px 0', display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', alignItems:'end', gap:3}}>
              {[...Array(24)].map((_,h)=>{
                const count = hourIndexFromEvents.counts[h] || 0;
                const firstIdx = hourIndexFromEvents.firstIdx[h];
                const height = count > 0 ? Math.round((count / hourIndexFromEvents.maxC) * 42) + 6 : 4;
                const active = firstIdx >= 0 && scrubIdx >= firstIdx && scrubIdx < firstIdx + count;
                const clickable = firstIdx >= 0;
                const topTier = hourIndexFromEvents.topPriority[h];
                const inactiveBg = topTier === 'high'
                  ? 'var(--gold)'
                  : topTier === 'medium'
                    ? 'var(--border-hi)'
                    : 'var(--border)';
                const inactiveOpacity = topTier === 'high'
                  ? 0.9
                  : topTier === 'medium'
                    ? 0.6
                    : (clickable ? 0.4 : 0.3);
                return (
                  <button
                    key={h}
                    type="button"
                    disabled={!clickable}
                    onClick={() => { if (clickable) setScrubIdx(firstIdx); }}
                    aria-label={`${count} memories at ${String(h).padStart(2,'0')}:00${topTier ? ` (top priority: ${topTier})` : ''}`}
                    style={{
                      height,
                      padding:0,
                      border:'none',
                      background: active ? 'var(--gold)' : inactiveBg,
                      opacity: clickable ? (active ? 0.95 : inactiveOpacity) : 0.3,
                      borderRadius:2,
                      cursor: clickable ? 'pointer' : 'default',
                      transition: 'opacity 120ms, background 120ms',
                    }}
                  />
                );
              })}
            </div>
            <div className="t-mono" style={{position:'absolute', left:0, bottom:0, right:0, display:'grid', gridTemplateColumns:'repeat(24, minmax(0, 1fr))', fontSize:10, color:'var(--text-dim)'}}>
              {[...Array(24)].map((_,h)=>(
                <span key={h} style={{textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
              ))}
            </div>
          </div>
        </div>
      </div>
      </>
      )}

      {/* Kakejiku view */}
      {view === 'kakejiku' && (
        <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
          <div style={{maxWidth:820, margin:'0 auto'}}>
            {(() => {
              const dayStart = new Date(selectedDate);
              dayStart.setHours(0, 0, 0, 0);
              const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000;
              const dayEvents = events.filter((e) => Number.isFinite(e.ts) && e.ts >= dayStart.getTime() && e.ts < dayEnd);
              if (timelineLoading) {
                return (
                  <div className="muted" style={{padding:'40px 0', textAlign:'center', fontSize:13}}>
                    <span className="en-only">Loading timeline…</span>
                    <span className="jp" style={{display:'block', marginTop:6}}>読み込み中…</span>
                  </div>
                );
              }
              if (dayEvents.length === 0) {
                return (
                  <div style={{padding:'60px 0', textAlign:'center', color:'var(--text-dim)', fontSize:13, display:'flex', flexDirection:'column', alignItems:'center', gap:10}}>
                    <Icon name="memory" size={28}/>
                    <span className="en-only">No memories for {fmtFullDate(selectedDate)}.</span>
                    <span className="jp" style={{fontSize:12}}>{fmtFullDateJp(selectedDate)} のメモリはまだありません。</span>
                  </div>
                );
              }
              return dayEvents.map((e, i) => {
                const solid = e.src === 'agent' || e.src === 'meet';
                return (
                  <button
                    key={e.memoryId || `${e.ts}-${i}`}
                    type="button"
                    disabled={!e.memoryId}
                    onClick={() => {
                      if (!e.memoryId) return;
                      openMemoryEntryInChat(
                        { title: e.title, snippet: e.snippet },
                        { memoryAssemblyQuery: e.title, memoryAssemblyLimit: 14, allowServerMemoryAssembly },
                      );
                    }}
                    className="memory-scrub-stage"
                    style={{
                      all: 'unset',
                      display:'grid',
                      gridTemplateColumns:'76px 1px 1fr',
                      columnGap:24,
                      padding:'22px 0',
                      borderBottom:'1px solid var(--border)',
                      width:'100%',
                      boxSizing:'border-box',
                      cursor: e.memoryId ? 'pointer' : 'default',
                      fontFamily:'inherit',
                    }}
                  >
                    <div style={{textAlign:'right', paddingTop:4}}>
                      <span className="t-mono" style={{fontSize:12, color:'var(--text)', letterSpacing:'0.06em'}}>{e.t}</span>
                    </div>
                    <div style={{background:'var(--border)', alignSelf:'stretch', position:'relative'}}>
                      <span style={{
                        position:'absolute', left:-4, top:8, width:9, height:9, borderRadius:'50%',
                        background: solid ? 'var(--gold)' : 'transparent',
                        border: solid ? 'none' : '1.5px solid var(--text-mute)',
                        boxShadow:'0 0 0 3px var(--bg)',
                      }}/>
                    </div>
                    <div style={{minWidth:0, display:'flex', flexDirection:'column', gap:6}}>
                      <div style={{display:'flex', alignItems:'center', gap:8}}>
                        <Icon name={srcIcon(e.src)} size={13} className="dim"/>
                        <span className="t-mono" style={{fontSize:11, color:'var(--text-dim)', letterSpacing:'0.14em'}}>{srcLabel(e.src)}</span>
                      </div>
                      <div style={{fontSize:15, fontWeight:500, color:'var(--text)', lineHeight:1.45, wordBreak:'break-word'}}>
                        {renderHighlighted(e.titleHighlight || e.title)}
                      </div>
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* Heatmap view */}
      {view === 'heatmap' && (
        <div style={{flex:1, padding:'24px 40px 40px', minHeight:0, overflowY:'auto'}}>
          <div style={{maxWidth:900, margin:'0 auto'}}>
            {(() => {
              const grid = weekDays.map((d) => {
                const start = new Date(d);
                start.setHours(0, 0, 0, 0);
                const startMs = start.getTime();
                const endMs = startMs + 24 * 60 * 60 * 1000;
                const hours = new Array(24).fill(0);
                events.forEach((e) => {
                  if (!Number.isFinite(e.ts) || e.ts < startMs || e.ts >= endMs) return;
                  const hh = Math.max(0, Math.min(23, Math.floor(Number(e.h))));
                  hours[hh] += 1;
                });
                return hours;
              });
              const max = Math.max(1, ...grid.flat());
              const fmtWk = (d: Date) => d.toLocaleString('en-US', { weekday: 'short' }).toUpperCase();
              return (
                <div style={{display:'flex', flexDirection:'column', gap:6}}>
                  <div style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'end', paddingBottom:4}}>
                    <span/>
                    {[...Array(24)].map((_, h) => (
                      <span key={h} className="t-mono" style={{fontSize:9, color:'var(--text-dim)', textAlign:'center'}}>{String(h).padStart(2,'0')}</span>
                    ))}
                  </div>
                  {grid.map((row, i) => {
                    const offset = 6 - i;
                    const isActiveDay = offset === selectedDayOffset;
                    return (
                      <div key={i} style={{display:'grid', gridTemplateColumns:'44px repeat(24, minmax(0, 1fr))', columnGap:3, alignItems:'stretch'}}>
                        <button
                          type="button"
                          onClick={() => setSelectedDayOffset(offset)}
                          className="t-mono"
                          style={{
                            all:'unset',
                            fontSize:10,
                            color: isActiveDay ? 'var(--gold)' : 'var(--text-dim)',
                            letterSpacing:'0.14em',
                            cursor:'pointer',
                            paddingRight:8,
                            textAlign:'right',
                            alignSelf:'center',
                          }}
                          title={weekDays[i]?.toDateString()}
                        >
                          {weekDays[i] ? fmtWk(weekDays[i]!) : ''}
                        </button>
                        {row.map((v, h) => {
                          const intensity = v / max;
                          const bg = v === 0
                            ? 'var(--border)'
                            : `color-mix(in srgb, var(--gold) ${Math.round(15 + intensity * 75)}%, var(--surface))`;
                          return (
                            <span
                              key={h}
                              title={`${weekDays[i] ? fmtWk(weekDays[i]!) : ''} ${String(h).padStart(2,'0')}:00 · ${v} ${v === 1 ? 'memory' : 'memories'}`}
                              style={{
                                height:24,
                                borderRadius:4,
                                background: bg,
                                outline: isActiveDay ? '1px solid color-mix(in srgb, var(--gold) 35%, transparent)' : 'none',
                                opacity: v === 0 ? 0.35 : 1,
                              }}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                  <div style={{marginTop:18, display:'flex', alignItems:'center', gap:10, justifyContent:'flex-end'}}>
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>LESS</span>
                    {[0, 0.25, 0.5, 0.75, 1].map((p, idx) => (
                      <span key={idx} style={{
                        width:18, height:10, borderRadius:3,
                        background: p === 0 ? 'var(--border)' : `color-mix(in srgb, var(--gold) ${Math.round(15 + p * 75)}%, var(--surface))`,
                      }}/>
                    ))}
                    <span className="t-mono" style={{fontSize:10, color:'var(--text-dim)', letterSpacing:'0.12em'}}>MORE</span>
                  </div>
                  {events.length === 0 && !timelineLoading && (
                    <div style={{marginTop:20, color:'var(--text-dim)', fontSize:13, textAlign:'center'}}>
                      <span className="en-only">No memories indexed yet — ingest or sync to populate the grid.</span>
                      <span className="jp" style={{display:'block', fontSize:12, marginTop:4}}>まだインデックス化されたメモリがありません。</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {view === 'digest' && (
        <MemoryDigestView state={digestState} setState={setDigestState} />
      )}

      {view === 'search' && (
        <MemorySearchView
          workProjects={workProjects}
          assignments={workspaceAssignments}
          setAssignments={setWorkspaceAssignments}
        />
      )}

      <style>{`
        .memory-scrub-stage mark {
          background: color-mix(in srgb, var(--gold) 28%, transparent);
          color: inherit;
          padding: 0 2px;
          border-radius: 2px;
        }
      `}</style>
    </div>
  );
}

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).ScreenMemory = MemoryScreen;
}
