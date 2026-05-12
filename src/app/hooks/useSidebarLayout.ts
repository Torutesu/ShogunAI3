import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { SIDEBAR_WIDTH_LS, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/constants';

export interface UseSidebarLayoutResult {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarResizeHint: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  setSidebarResizeHint: Dispatch<SetStateAction<boolean>>;
}

export function useSidebarLayout(): UseSidebarLayoutResult {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_LS));
      if (Number.isFinite(raw)) return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, Math.round(raw)));
    } catch (_) {
      /* ignore */
    }
    return 240;
  });
  const [sidebarResizeHint, setSidebarResizeHint] = useState(false);
  return {
    sidebarCollapsed,
    sidebarWidth,
    sidebarResizeHint,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarResizeHint,
  };
}
