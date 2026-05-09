// Types for the agents feature.
// Phase 2: using interfaces where obvious; `any` where typing is deferred to Phase 3.

export interface AgentTool {
  name: string;
  icon: string;
}

export interface MemoryRef {
  id: string;
  title: string;
  note?: string;
}

export interface AgentRun {
  id: string;
  atMs: number;
  t: string;
  msg: string;
  level: 'success' | 'info' | 'error';
  durationMs: number;
  tools: string[];
  input: string;
  output: string;
  error?: string;
  memoryTouched: MemoryRef[];
}

export interface AgentDemo {
  id: string;
  name: string;
  icon: string;
  status: 'running' | 'idle' | 'scheduled' | 'paused' | 'error';
  trigger: string;
  triggerSince: string;
  description: string;
  tools: AgentTool[];
  lastRunMs: number | null;
  nextRunMs: number | null;
  recentRuns: AgentRun[];
  attention?: string;
  paused?: boolean;
}

export interface AgentLiveEntry {
  t: string;
  agent: string;
  msg: string;
  level: 'success' | 'info' | 'error';
}

export interface TriggerForm {
  type: 'interval' | 'event' | 'daily' | 'weekly';
  value?: number | undefined;
  unit?: string | undefined;
  source?: string | undefined;
  time?: string | undefined;
}
