import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseProfileResult {
  profileDisplayName: string;
  profileAvatarGlyph: string;
  profileAvatarImageDataUrl: string;
  setProfileDisplayName: Dispatch<SetStateAction<string>>;
  setProfileAvatarGlyph: Dispatch<SetStateAction<string>>;
  setProfileAvatarImageDataUrl: Dispatch<SetStateAction<string>>;
}

export function useProfile(): UseProfileResult {
  const [profileDisplayName, setProfileDisplayName] = useState('');
  const [profileAvatarGlyph, setProfileAvatarGlyph] = useState('');
  const [profileAvatarImageDataUrl, setProfileAvatarImageDataUrl] = useState('');
  return {
    profileDisplayName,
    profileAvatarGlyph,
    profileAvatarImageDataUrl,
    setProfileDisplayName,
    setProfileAvatarGlyph,
    setProfileAvatarImageDataUrl,
  };
}
