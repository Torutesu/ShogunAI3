import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseHistoricalImportResult {
  historicalImport: any;
  historicalImportBusy: boolean;
  historicalImportProgress: any;
  setHistoricalImport: Dispatch<SetStateAction<any>>;
  setHistoricalImportBusy: Dispatch<SetStateAction<boolean>>;
  setHistoricalImportProgress: Dispatch<SetStateAction<any>>;
}

export function useHistoricalImport(): UseHistoricalImportResult {
  // { provider: 'gmail' | 'google_calendar', days: 30 } when prompting; null when hidden.
  const [historicalImport, setHistoricalImport] = useState<any>(null);
  const [historicalImportBusy, setHistoricalImportBusy] = useState(false);
  // { current, total, phase } — live status from the backend `historical-sync-progress` event.
  const [historicalImportProgress, setHistoricalImportProgress] = useState<any>(null);
  return {
    historicalImport,
    historicalImportBusy,
    historicalImportProgress,
    setHistoricalImport,
    setHistoricalImportBusy,
    setHistoricalImportProgress,
  };
}
