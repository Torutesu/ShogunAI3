import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseHummingbirdResult {
  hummingbirdOpen: boolean;
  hummingbirdInput: string;
  setHummingbirdOpen: Dispatch<SetStateAction<boolean>>;
  setHummingbirdInput: Dispatch<SetStateAction<string>>;
}

export function useHummingbird(): UseHummingbirdResult {
  const [hummingbirdOpen, setHummingbirdOpen] = useState(false);
  const [hummingbirdInput, setHummingbirdInput] = useState('');
  return { hummingbirdOpen, hummingbirdInput, setHummingbirdOpen, setHummingbirdInput };
}
