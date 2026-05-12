import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { TWEAK_DEFAULTS } from '../lib/constants';

export interface UseTweaksResult {
  tweaks: typeof TWEAK_DEFAULTS;
  setTweaks: Dispatch<SetStateAction<typeof TWEAK_DEFAULTS>>;
}

export function useTweaks(): UseTweaksResult {
  const [tweaks, setTweaks] = useState(TWEAK_DEFAULTS);
  return { tweaks, setTweaks };
}
