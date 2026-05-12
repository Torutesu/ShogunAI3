import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface UseMeetingHudResult {
  meetingHud: any;
  meetingHudTick: number;
  setMeetingHud: Dispatch<SetStateAction<any>>;
  setMeetingHudTick: Dispatch<SetStateAction<number>>;
}

export function useMeetingHud(): UseMeetingHudResult {
  const [meetingHud, setMeetingHud] = useState<any>(null);
  const [meetingHudTick, setMeetingHudTick] = useState(0);
  return {
    meetingHud,
    meetingHudTick,
    setMeetingHud,
    setMeetingHudTick,
  };
}
