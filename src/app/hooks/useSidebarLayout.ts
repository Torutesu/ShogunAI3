import React, { useState, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { SIDEBAR_WIDTH_LS, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from '../lib/constants';

declare const window: any;

export interface UseSidebarLayoutResult {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  sidebarResizeHint: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  setSidebarWidth: Dispatch<SetStateAction<number>>;
  setSidebarResizeHint: Dispatch<SetStateAction<boolean>>;
  resizeStateRef: React.MutableRefObject<{ active: boolean; moved: boolean; startX: number; startWidth: number }>;
  beginSidebarResize: (e: any) => void;
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
  const resizeStateRef = useRef({ active: false, moved: false, startX: 0, startWidth: 240 });

  const beginSidebarResize = (e: any) => {
    if (!e || typeof e.clientX !== 'number') return;
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    resizeStateRef.current = { active: true, moved: false, startX, startWidth };
    setSidebarResizeHint(true);
    const prevBodySelect = document.body.style.userSelect;
    const prevBodyCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev: any) => {
      if (!resizeStateRef.current.active || !ev || typeof ev.clientX !== 'number') return;
      const dx = ev.clientX - resizeStateRef.current.startX;
      if (Math.abs(dx) > 3) resizeStateRef.current.moved = true;
      const next = Math.max(
        SIDEBAR_MIN_WIDTH,
        Math.min(SIDEBAR_MAX_WIDTH, Math.round(resizeStateRef.current.startWidth + dx)),
      );
      setSidebarWidth(next);
      if (sidebarCollapsed && next > SIDEBAR_MIN_WIDTH) setSidebarCollapsed(false);
    };
    const endResize = () => {
      const moved = resizeStateRef.current.moved;
      resizeStateRef.current.active = false;
      document.body.style.userSelect = prevBodySelect;
      document.body.style.cursor = prevBodyCursor;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      if (!moved) setSidebarCollapsed((v) => !v);
      setSidebarResizeHint(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  };

  return {
    sidebarCollapsed,
    sidebarWidth,
    sidebarResizeHint,
    setSidebarCollapsed,
    setSidebarWidth,
    setSidebarResizeHint,
    resizeStateRef,
    beginSidebarResize,
  };
}
