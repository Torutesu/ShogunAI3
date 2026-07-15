import type { AgentDemo, AgentRun, AgentTool } from '../types';

const CUSTOM_AGENTS_LS = 'shogun-agents-custom-v1';
const AGENT_OVERRIDES_LS = 'shogun-agents-overrides-v1';

export interface PersistedAgentState {
  customAgents: AgentDemo[];
  agentOverrides: Record<string, Partial<AgentDemo>>;
}

interface PersistedRunRecord {
  atMs: number;
  ok: boolean;
  summary: string;
  source?: string;
}

function hasWindowStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sanitizeTool(raw: unknown): AgentTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const name = String(item.name || '').trim();
  const icon = String(item.icon || '').trim();
  if (!name || !icon) return null;
  return { name, icon };
}

function sanitizeRun(raw: unknown): AgentRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || '').trim();
  const t = String(item.t || '').trim();
  const msg = String(item.msg || '').trim();
  const level = String(item.level || '').trim();
  if (!id || !t || !msg || !['success', 'info', 'error'].includes(level)) return null;
  const tools = Array.isArray(item.tools)
    ? item.tools.map((tool) => String(tool || '').trim()).filter(Boolean)
    : [];
  const memoryTouched = Array.isArray(item.memoryTouched)
    ? item.memoryTouched
        .map((memory) => {
          if (!memory || typeof memory !== 'object') return null;
          const memoryItem = memory as Record<string, unknown>;
          const memoryId = String(memoryItem.id || '').trim();
          const title = String(memoryItem.title || '').trim();
          const note = String(memoryItem.note || '').trim();
          if (!memoryId || !title) return null;
          return note ? { id: memoryId, title, note } : { id: memoryId, title };
        })
        .filter(isNonNull)
    : [];
  const run: AgentRun = {
    id,
    atMs: Number(item.atMs) || 0,
    t,
    msg,
    level: level as AgentRun['level'],
    durationMs: Number(item.durationMs) || 0,
    tools,
    input: String(item.input || ''),
    output: String(item.output || ''),
    memoryTouched,
  };
  const source = String(item.source || '').trim();
  if (source) run.source = source;
  const error = String(item.error || '').trim();
  if (error) run.error = error;
  return run;
}

function sanitizeAgent(raw: unknown): AgentDemo | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const id = String(item.id || '').trim();
  const name = String(item.name || '').trim();
  const icon = String(item.icon || '').trim();
  const status = String(item.status || '').trim();
  const trigger = String(item.trigger || '').trim();
  const triggerSince = String(item.triggerSince || '').trim();
  const description = String(item.description || '').trim();
  if (!id || !name || !icon || !trigger || !triggerSince || !description) return null;
  if (!['running', 'idle', 'scheduled', 'paused', 'error'].includes(status)) return null;
  const tools = Array.isArray(item.tools)
    ? item.tools.map(sanitizeTool).filter(isNonNull)
    : [];
  const recentRuns = Array.isArray(item.recentRuns)
    ? item.recentRuns.map(sanitizeRun).filter(isNonNull)
    : [];
  const agent: AgentDemo = {
    id,
    name,
    icon,
    status: status as AgentDemo['status'],
    trigger,
    triggerSince,
    description,
    tools,
    lastRunMs: item.lastRunMs == null ? null : Number(item.lastRunMs) || null,
    nextRunMs: item.nextRunMs == null ? null : Number(item.nextRunMs) || null,
    recentRuns,
  };
  if (item.attention != null) {
    const attention = String(item.attention || '').trim();
    if (attention) agent.attention = attention;
  }
  if (item.paused != null) agent.paused = item.paused === true;
  if (item.isCustom != null) agent.isCustom = item.isCustom === true;
  if (item.prompt != null) {
    const prompt = String(item.prompt || '').trim();
    if (prompt) agent.prompt = prompt;
  }
  return agent;
}

function sanitizePersistedRunRecord(raw: unknown): PersistedRunRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const atMs = Number(item.atMs) || 0;
  const summary = String(item.summary || '').trim();
  if (!atMs || !summary) return null;
  const source = String(item.source || '').trim();
  return {
    atMs,
    ok: item.ok !== false,
    summary,
    ...(source ? { source } : {}),
  };
}

function formatPersistedRunTime(atMs: number): string {
  if (!atMs) return '';
  const date = new Date(atMs);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function mergePersistedRunRecordIntoAgent(agent: AgentDemo, run: PersistedRunRecord): AgentDemo {
  const syntheticRun: AgentRun = {
    id: `settings-run-${agent.id}-${run.atMs}`,
    atMs: run.atMs,
    t: formatPersistedRunTime(run.atMs),
    msg: run.summary,
    level: run.ok ? 'success' : 'error',
    durationMs: 0,
    tools: agent.tools.map((tool) => tool.name),
    input: agent.prompt || '',
    output: run.summary,
    memoryTouched: [],
    ...(run.source ? { source: run.source } : {}),
    ...(run.ok ? {} : { error: run.summary }),
  };
  const recentRuns = agent.recentRuns.some((item) => item.atMs === run.atMs)
    ? agent.recentRuns
    : [syntheticRun, ...agent.recentRuns].slice(0, 5);
  return {
    ...agent,
    status: !run.ok && !agent.paused ? 'error' : agent.status,
    lastRunMs: run.atMs,
    recentRuns,
  };
}

export function applyPersistedAgentRunsFromSettingsSections(
  agents: AgentDemo[],
  sections: Record<string, unknown> | null | undefined,
): AgentDemo[] {
  const agentsSection = sections?.agents && typeof sections.agents === 'object'
    ? sections.agents as Record<string, unknown>
    : null;
  const rawRuns = (
    agentsSection?.runs &&
    typeof agentsSection.runs === 'object' &&
    !Array.isArray(agentsSection.runs)
  )
    ? agentsSection.runs as Record<string, unknown>
    : null;
  if (!rawRuns) return agents;

  return agents.map((agent) => {
    const persistedRun = sanitizePersistedRunRecord(rawRuns[agent.id]);
    if (!persistedRun) return agent;
    if (agent.lastRunMs != null && agent.lastRunMs >= persistedRun.atMs) return agent;
    return mergePersistedRunRecordIntoAgent(agent, persistedRun);
  });
}

export function loadCustomAgents(): AgentDemo[] {
  if (!hasWindowStorage()) return [];
  const raw = parseJson<unknown[]>(window.localStorage.getItem(CUSTOM_AGENTS_LS), []);
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeAgent).filter(isNonNull);
}

export function saveCustomAgents(items: AgentDemo[]): void {
  if (!hasWindowStorage()) return;
  window.localStorage.setItem(CUSTOM_AGENTS_LS, JSON.stringify(Array.isArray(items) ? items : []));
}

export function loadAgentOverrides(): Record<string, Partial<AgentDemo>> {
  if (!hasWindowStorage()) return {};
  const raw = parseJson<Record<string, unknown>>(window.localStorage.getItem(AGENT_OVERRIDES_LS), {});
  if (!raw || typeof raw !== 'object') return {};
  return loadAgentOverridesFromRawObject(raw);
}

export function saveAgentOverrides(items: Record<string, Partial<AgentDemo>>): void {
  if (!hasWindowStorage()) return;
  window.localStorage.setItem(AGENT_OVERRIDES_LS, JSON.stringify(items || {}));
}

export function loadPersistedAgentStateFromLocalStorage(): PersistedAgentState {
  return {
    customAgents: loadCustomAgents(),
    agentOverrides: loadAgentOverrides(),
  };
}

export function loadPersistedAgentStateFromSettingsSections(
  sections: Record<string, unknown> | null | undefined,
): PersistedAgentState | null {
  const agentsSection = sections?.agents && typeof sections.agents === 'object'
    ? sections.agents as Record<string, unknown>
    : null;
  if (!agentsSection) return null;

  const customAgents = Array.isArray(agentsSection.customAgents)
    ? agentsSection.customAgents.map(sanitizeAgent).filter(isNonNull)
    : [];
  const customAgentsWithRuns = applyPersistedAgentRunsFromSettingsSections(customAgents, sections);
  const customAgentOverrides = (
    agentsSection.customAgentOverrides &&
    typeof agentsSection.customAgentOverrides === 'object' &&
    !Array.isArray(agentsSection.customAgentOverrides)
  )
    ? loadAgentOverridesFromRawObject(agentsSection.customAgentOverrides as Record<string, unknown>)
    : {};

  if (customAgents.length === 0 && Object.keys(customAgentOverrides).length === 0) {
    return null;
  }

  return {
    customAgents: customAgentsWithRuns,
    agentOverrides: customAgentOverrides,
  };
}

export function buildPersistedAgentSettingsPatch(state: PersistedAgentState): Record<string, unknown> {
  return {
    section: 'agents',
    customAgents: state.customAgents,
    customAgentOverrides: state.agentOverrides,
  };
}

function loadAgentOverridesFromRawObject(raw: Record<string, unknown>): Record<string, Partial<AgentDemo>> {
  return Object.entries(raw).reduce<Record<string, Partial<AgentDemo>>>((acc, [id, value]) => {
    if (!value || typeof value !== 'object') return acc;
    const item = value as Record<string, unknown>;
    const next: Partial<AgentDemo> = {};
    if (item.name != null) next.name = String(item.name || '').trim();
    if (item.description != null) next.description = String(item.description || '').trim();
    if (item.trigger != null) next.trigger = String(item.trigger || '').trim();
    if (item.icon != null) next.icon = String(item.icon || '').trim();
    if (item.status != null) {
      const status = String(item.status || '').trim();
      if (['running', 'idle', 'scheduled', 'paused', 'error'].includes(status)) {
        next.status = status as AgentDemo['status'];
      }
    }
    if (item.triggerSince != null) next.triggerSince = String(item.triggerSince || '').trim();
    if (item.tools != null && Array.isArray(item.tools)) next.tools = item.tools.map(sanitizeTool).filter(isNonNull);
    if (item.lastRunMs !== undefined) next.lastRunMs = item.lastRunMs == null ? null : Number(item.lastRunMs) || null;
    if (item.nextRunMs !== undefined) next.nextRunMs = item.nextRunMs == null ? null : Number(item.nextRunMs) || null;
    if (item.recentRuns != null && Array.isArray(item.recentRuns)) next.recentRuns = item.recentRuns.map(sanitizeRun).filter(isNonNull);
    if (item.paused != null) next.paused = item.paused === true;
    if (item.isCustom != null) next.isCustom = item.isCustom === true;
    if (item.prompt != null) next.prompt = String(item.prompt || '').trim();
    acc[id] = next;
    return acc;
  }, {});
}
