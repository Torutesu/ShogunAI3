import React, { createContext, useContext, type ReactNode } from 'react';

/** Granola overlay session — UI state + handlers shared via context (Phase 5). */
export type GranolaOverlayContextValue = Record<string, any>;

const GranolaOverlayContext = createContext<GranolaOverlayContextValue | null>(null);

export function GranolaOverlayProvider({
  value,
  children,
}: {
  value: GranolaOverlayContextValue;
  children: ReactNode;
}): React.ReactElement {
  return (
    <GranolaOverlayContext.Provider value={value}>
      {children}
    </GranolaOverlayContext.Provider>
  );
}

export function useGranolaOverlay(): GranolaOverlayContextValue {
  const ctx = useContext(GranolaOverlayContext);
  if (!ctx) {
    throw new Error('useGranolaOverlay must be used within GranolaOverlayProvider');
  }
  return ctx;
}
