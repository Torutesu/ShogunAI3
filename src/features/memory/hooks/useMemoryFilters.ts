import { useCallback, useMemo, useState } from 'react';
import { runRuntimeAction } from '@/shared/ipc/runtime-actions';
import { mergeIndexHitsIntoRiver } from '../lib/runtime';

export const DEFAULT_MEMORY_FILTERS = {
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
};

export type MemoryFilters = typeof DEFAULT_MEMORY_FILTERS;

export function useMemoryFilters() {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<MemoryFilters>(() => ({
    sources: { ...DEFAULT_MEMORY_FILTERS.sources },
    priority: { ...DEFAULT_MEMORY_FILTERS.priority },
    providers: { ...DEFAULT_MEMORY_FILTERS.providers },
  }));

  const activeFilterCount = useMemo(
    () =>
      Object.values(activeFilters.sources).filter(Boolean).length +
      Object.values(activeFilters.priority).filter(Boolean).length +
      Object.values(activeFilters.providers || {}).filter((v) => v === false).length,
    [activeFilters],
  );

  const toggleFilter = useCallback((group: keyof MemoryFilters, key: string) => {
    setActiveFilters((prev) => ({
      ...prev,
      [group]: { ...prev[group], [key]: !(prev[group] as Record<string, boolean>)[key] },
    }));
  }, []);

  const resetFilters = useCallback(() => {
    setActiveFilters({
      sources: { ...DEFAULT_MEMORY_FILTERS.sources },
      priority: { ...DEFAULT_MEMORY_FILTERS.priority },
      providers: { ...DEFAULT_MEMORY_FILTERS.providers },
    });
  }, []);

  const applyFilters = useCallback(
    async (
      withSemantic: (payload: any) => any,
      setRawEvents: (fn: (prev: any[]) => any[]) => void,
      setScrubIdx: (idx: number) => void,
    ) => {
      const kinds = Object.entries(activeFilters.sources)
        .filter(([, on]) => on)
        .map(([x]) => x);
      const res = await runRuntimeAction(
        'memory.timelineSearch',
        withSemantic({ query: '', kinds, limit: 80 }),
        { successMessage: 'Filters applied' },
      );
      mergeIndexHitsIntoRiver(res, setRawEvents, setScrubIdx);
      setFiltersOpen(false);
    },
    [activeFilters],
  );

  return {
    activeFilters,
    filtersOpen,
    setFiltersOpen,
    toggleFilter,
    activeFilterCount,
    resetFilters,
    applyFilters,
  };
}
