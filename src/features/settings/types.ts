import React from 'react';

export interface SettingsHydrationContextValue {
  sections: Record<string, any>;
  refreshSections: (() => Promise<void>) | null;
  setPane?: (pane: string) => void;
}

export const SettingsHydrationContext = React.createContext<SettingsHydrationContextValue>({
  sections: {},
  refreshSections: null,
});

export interface RuntimeActions {
  run: (key: string, payload?: any, options?: any) => Promise<any>;
  confirmWrite: (key: string, payload: any, title: string, description: string) => void;
  toast: (message: string, kind?: string) => void;
}
