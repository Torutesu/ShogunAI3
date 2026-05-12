import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseShareControlsResult {
  shareOpen: boolean;
  shareMode: string;
  shareTip: any;
  editMode: boolean;
  favorited: boolean;
  setShareOpen: Dispatch<SetStateAction<boolean>>;
  setShareMode: Dispatch<SetStateAction<string>>;
  setShareTip: Dispatch<SetStateAction<any>>;
  setEditMode: Dispatch<SetStateAction<boolean>>;
  setFavorited: Dispatch<SetStateAction<boolean>>;
}

export function useShareControls(): UseShareControlsResult {
  const [shareOpen, setShareOpen] = useState(false);
  const [shareMode, setShareMode] = useState('private');
  const [shareTip, setShareTip] = useState<any>(null); // 'popout' | 'star' | 'share' | null
  const [editMode, setEditMode] = useState(false);
  const [favorited, setFavorited] = useState(false);
  return {
    shareOpen,
    shareMode,
    shareTip,
    editMode,
    favorited,
    setShareOpen,
    setShareMode,
    setShareTip,
    setEditMode,
    setFavorited,
  };
}
