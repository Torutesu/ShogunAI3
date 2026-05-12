import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseWriteConfirmResult {
  writeConfirm: any;
  writePending: boolean;
  setWriteConfirm: Dispatch<SetStateAction<any>>;
  setWritePending: Dispatch<SetStateAction<boolean>>;
}

export function useWriteConfirm(): UseWriteConfirmResult {
  const [writeConfirm, setWriteConfirm] = useState<any>({ open: false, actionKey: null, payload: null, title: null, description: null });
  const [writePending, setWritePending] = useState(false);
  return {
    writeConfirm,
    writePending,
    setWriteConfirm,
    setWritePending,
  };
}
