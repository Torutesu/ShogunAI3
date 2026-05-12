import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseFloatMenusResult {
  userOpen: boolean;
  userAnchor: { left: number; bottom: number; width: number; maxHeight: number };
  contextPanelOpen: boolean;
  contextPanelAnchor: { left: number; bottom: number; width: number };
  setUserOpen: Dispatch<SetStateAction<boolean>>;
  setUserAnchor: Dispatch<SetStateAction<{ left: number; bottom: number; width: number; maxHeight: number }>>;
  setContextPanelOpen: Dispatch<SetStateAction<boolean>>;
  setContextPanelAnchor: Dispatch<SetStateAction<{ left: number; bottom: number; width: number }>>;
}

export function useFloatMenus(): UseFloatMenusResult {
  const [userOpen, setUserOpen] = useState(false);
  const [userAnchor, setUserAnchor] = useState({ left: 0, bottom: 0, width: 220, maxHeight: 600 });
  const [contextPanelOpen, setContextPanelOpen] = useState(false);
  const [contextPanelAnchor, setContextPanelAnchor] = useState({ left: 0, bottom: 0, width: 320 });
  return {
    userOpen,
    userAnchor,
    contextPanelOpen,
    contextPanelAnchor,
    setUserOpen,
    setUserAnchor,
    setContextPanelOpen,
    setContextPanelAnchor,
  };
}
