import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Icon } from '@/shared/icons';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import {
  memoryProviderKey,
  MEMORY_PROVIDER_META,
  clusterScreenSessions,
  mergeIndexHitsIntoRiver,
  isRiverSummarizableEvent,
  buildLocalDraftSummary,
} from './lib/runtime';
import { MemoryDigestView } from './components/MemoryDigestView';
import { MemorySearchView } from './components/MemorySearchView';
import { MemoryRiverView } from './components/MemoryRiverView';
import { MemoryKakejikuView } from './components/MemoryKakejikuView';
import { MemoryHeatmapView } from './components/MemoryHeatmapView';
import { useMemoryWorkspace } from './hooks/useMemoryWorkspace';
import { useMemoryFilters } from './hooks/useMemoryFilters';
import { useMemoryRetrievalSettings } from './hooks/useMemoryRetrievalSettings';

export function MemoryScreen() {
  const [view, setView] = useState('river');
  const [digestState, setDigestState] = useState({
    week: null, day: null, loading: false, error: null, generatingWeek: false, generatingDay: false,
  });
  const { workspaceAssignments, setWorkspaceAssignments, workProjects, assignMemoryToWorkspace } = useMemoryWorkspace();
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [newWorkspaceDraft, setNewWorkspaceDraft] = useState('');

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
  const {
    activeFilters,
    filtersOpen,
    setFiltersOpen,
    toggleFilter,
    activeFilterCount,
    resetFilters,
    applyFilters,
  } = useMemoryFilters();
  const {
    graphReadPath,
    summaryEnabled,
    allowServerMemoryAssembly,
    loaded: memorySettingsLoaded,
    withSemantic,
  } = useMemoryRetrievalSettings();
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
  const [sourceEntities, setSourceEntities] = useState<any[]>([]);
  const [scrubSummary, setScrubSummary] = useState<any>(null);
  const [scrubSummaryLoading, setScrubSummaryLoading] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const timelineLoading = !memorySettingsLoaded;
  const refreshSourceEntities = () => {
    runRuntimeAction('entity.query', { query: '' }, { silentError: true }).then((res: any) => {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.entities)) return;
      setSourceEntities(res.data.entities);
    });
  };
  useEffect(() => {
    refreshSourceEntities();
  }, []);
  const activeKinds = useMemo(
    () => Object.entries(activeFilters.sources).filter(([, on]) => on).map(([k]) => k),
    [activeFilters.sources],
  );
  const reloadTimeline = useCallback(async () => {
    const res = await runRuntimeAction(
      'memory.timelineSearch',
      withSemantic({ query: '', kinds: activeKinds, limit: 40 }),
      { silentError: true },
    );
    mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
    return res;
  }, [withSemantic, activeKinds]);
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
      .filter((e) => isRiverSummarizableEvent(e) && !summaryByMemId[e.memoryId])
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
        const res = await runRuntimeAction('memory.summary.batch', { items: connectorItems, lang }, { silentError: true });
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
        const res = await runRuntimeAction('memory.rollup.get', { weekStartMs, lang }, { silentError: true });
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
  }, [timelineSpan, timelineCursor, summaryEnabled, graphReadPath]);
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
        const res = await runRuntimeAction('memory.rollup.day.get', { dayStartMs, lang }, { silentError: true });
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
        const res = await runRuntimeAction('memory.rollup.month.get', { monthStartMs, lang }, { silentError: true });
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
  }, [timelineSpan, selectedDate, timelineCursor, summaryEnabled, batchSummarizing]);
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
        const res = await runRuntimeAction('memory.rollup.year.get', { yearStartMs, lang }, { silentError: true });
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
  }, [timelineSpan, selectedDate, timelineCursor, summaryEnabled, batchSummarizing]);
  useEffect(() => {
    if (!memorySettingsLoaded) return;
    let cancelled = false;
    void (async () => {
      const res = await reloadTimeline();
      if (cancelled || !res?.ok) return;
    })();
    return () => { cancelled = true; };
  }, [memorySettingsLoaded, reloadTimeline, graphReadPath]);
  useEffect(() => {
    const onIndexChanged = async () => {
      await reloadTimeline();
      refreshSourceEntities();
    };
    window.addEventListener('shogun-memory-index-changed', onIndexChanged);
    return () => window.removeEventListener('shogun-memory-index-changed', onIndexChanged);
  }, [reloadTimeline]);
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
  const scrubbed = useMemo(() => timelineLoading
    ? { t: '--', h: 12, src: 'note', title: '', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null }
    : events.length
      ? events[Math.min(scrubIdx, events.length - 1)]
      : { t: '--', h: 12, src: 'note', title: 'No memories', snippet: '', memoryId: null, provenance: null, sourceRaw: '', entityId: null },
  [timelineLoading, events, scrubIdx]);
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
    if (!isRiverSummarizableEvent(scrubbed)) {
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
    setScrubSummary(buildLocalDraftSummary(scrubbed));
    setScrubSummaryLoading(true);

    let cancelled = false;
    (async () => {
      try {
        const lang = (typeof document !== 'undefined' && document.body && document.body.getAttribute('data-lang')) || 'en';
        const res = await runRuntimeAction('memory.summary.get', {
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
  }, [scrubbed, summaryEnabled, summaryByMemId]);

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
                    <button type="button" onClick={() => void applyFilters(withSemantic, setRawEvents, setScrubIdx)} style={{flex:1, padding:'6px 10px', borderRadius:8, border:'1px solid var(--border-hi)', background:'var(--gold)', color:'var(--bg)', fontSize:12, cursor:'pointer', fontFamily:'inherit', fontWeight:500}}>Apply</button>
                    <button type="button" onClick={resetFilters} style={{padding:'6px 10px', borderRadius:8, border:'1px solid var(--border)', background:'transparent', color:'var(--text-mute)', fontSize:12, cursor:'pointer', fontFamily:'inherit'}}>Reset</button>
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
                    const res = await runRuntimeAction('memory.rollup.day.get', {
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
                    const res = await runRuntimeAction('memory.rollup.get', {
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
                    const res = await runRuntimeAction('memory.rollup.month.get', {
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
                    const res = await runRuntimeAction('memory.rollup.year.get', {
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
      <MemoryRiverView
        timelineLoading={timelineLoading}
        events={events}
        rawEvents={rawEvents}
        scrubIdx={scrubIdx}
        setScrubIdx={setScrubIdx}
        scrubbed={scrubbed}
        scrubSummary={scrubSummary}
        scrubSummaryLoading={scrubSummaryLoading}
        setScrubSummary={setScrubSummary}
        setScrubSummaryLoading={setScrubSummaryLoading}
        showRaw={showRaw}
        setShowRaw={setShowRaw}
        setSummaryByMemId={setSummaryByMemId}
        batchSummarizing={batchSummarizing}
        timelineScrollRef={timelineScrollRef}
        scrollTimeline={scrollTimeline}
        hourIndexFromEvents={hourIndexFromEvents}
        timeSpanLabel={timeSpanLabel}
        srcIcon={srcIcon}
        srcLabel={srcLabel}
        workProjects={workProjects}
        workspaceAssignments={workspaceAssignments}
        assignMenuOpen={assignMenuOpen}
        setAssignMenuOpen={setAssignMenuOpen}
        newWorkspaceDraft={newWorkspaceDraft}
        setNewWorkspaceDraft={setNewWorkspaceDraft}
        assignMemoryToWorkspace={assignMemoryToWorkspace}
        allowServerMemoryAssembly={allowServerMemoryAssembly}
      />
      )}

      {/* Kakejiku view */}
      {view === 'kakejiku' && (
        <MemoryKakejikuView
          selectedDate={selectedDate}
          events={events}
          timelineLoading={timelineLoading}
          fmtFullDate={fmtFullDate}
          fmtFullDateJp={fmtFullDateJp}
          srcIcon={srcIcon}
          srcLabel={srcLabel}
          allowServerMemoryAssembly={allowServerMemoryAssembly}
        />
      )}

      {/* Heatmap view */}
      {view === 'heatmap' && (
        <MemoryHeatmapView
          weekDays={weekDays}
          events={events}
          selectedDayOffset={selectedDayOffset}
          setSelectedDayOffset={setSelectedDayOffset}
          timelineLoading={timelineLoading}
        />
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
