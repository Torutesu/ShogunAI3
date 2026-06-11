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
