export type Posture = 'focus' | 'meeting-heavy' | 'recovery' | 'launch';

export type ContextItemType =
  | 'document'
  | 'person'
  | 'decision'
  | 'slack_thread'
  | 'email'
  | 'commit'
  | 'calendar';

export interface ContextItem {
  type: ContextItemType;
  title: string;
  uri?: string;
}

export interface NextAction {
  label?: string;
  key?: string;
  payload?: Record<string, unknown>;
}

export interface FocusBlock {
  start: string;
  end: string;
  duration_minutes?: number;
}

export interface BriefSummary {
  headline?: string;
  posture?: Posture;
  total_meeting_minutes?: number | null;
  focus_blocks?: FocusBlock[];
}

export interface BriefItem {
  id?: string;
  what: string;
  why_now: string;
  time_hint?: string | null;
  related_context?: ContextItem[];
  next_action?: NextAction;
}

export interface DeferredItem {
  id: string;
  snippet: string;
  reason?: string;
}

export interface MorningBriefV2 {
  version: '2.0';
  date?: string;
  summary?: BriefSummary;
  items?: BriefItem[];
  deferred?: DeferredItem[];
}

export interface MorningBriefV1 {
  version?: string;
  sections?: Array<{ title: string; body: string }>;
}

export type MorningBrief = MorningBriefV2 | MorningBriefV1;
