export const MOCK_SETTINGS_LS = "shogun.hifi.mock.settings.sections.v1";
export const MOCK_LLM_KEY_LS = "shogun.hifi.mock.llm.keyConfigured.v1";
export const MOCK_MEMORY_INDEX_LS = "shogun.hifi.mock.memory.index.v1";
export const MOCK_AI_FIELDS_LS = "shogun.hifi.mock.ai_fields.v1";
export const MOCK_CONTEXT_ACTIONS_LS = "shogun.hifi.mock.context_actions.v1";
export const MOCK_CONTEXT_ACTION_AUDIT_LS = "shogun.hifi.mock.context_action_audit.v1";

type MockGlobal = typeof globalThis & { localStorage?: Storage };

function resolveGlobal(global?: MockGlobal): MockGlobal {
  return global ?? (typeof window !== "undefined" ? window : globalThis);
}

export function readMockSettingsSections(global?: MockGlobal): Record<string, unknown> {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return {};
    const raw = g.localStorage.getItem(MOCK_SETTINGS_LS);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (!o || typeof o !== "object") return {};
    if (Object.prototype.hasOwnProperty.call(o, "subscription")) {
      const { subscription: _legacySubscription, ...rest } = o;
      try {
        g.localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(rest));
      } catch (_) {
        /* ignore */
      }
      return rest;
    }
    return o;
  } catch (_) {
    return {};
  }
}

export function mergeMockSettingsSection(
  section: string,
  patch: Record<string, unknown>,
  global?: MockGlobal,
): void {
  const g = resolveGlobal(global);
  if (!g.localStorage || !section || typeof patch !== "object") return;
  const sections = readMockSettingsSections(g);
  const prev =
    sections[section] && typeof sections[section] === "object"
      ? (sections[section] as Record<string, unknown>)
      : {};
  sections[section] = { ...prev, ...patch };
  g.localStorage.setItem(MOCK_SETTINGS_LS, JSON.stringify(sections));
}

export function readMockLlmKeyConfigured(global?: MockGlobal): boolean {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return false;
    return g.localStorage.getItem(MOCK_LLM_KEY_LS) === "1";
  } catch (_) {
    return false;
  }
}

export function writeMockLlmKeyConfigured(on: boolean, global?: MockGlobal): void {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return;
    if (on) g.localStorage.setItem(MOCK_LLM_KEY_LS, "1");
    else g.localStorage.removeItem(MOCK_LLM_KEY_LS);
  } catch (_) {
    /* ignore */
  }
}

export function readMockAiFields(global?: MockGlobal): Record<string, unknown>[] {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return [];
    const raw = g.localStorage.getItem(MOCK_AI_FIELDS_LS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function writeMockAiFields(items: Record<string, unknown>[], global?: MockGlobal): void {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return;
    g.localStorage.setItem(MOCK_AI_FIELDS_LS, JSON.stringify(items));
  } catch (_) {
    /* ignore */
  }
}

export function readMockContextActions(global?: MockGlobal): Record<string, unknown>[] {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return [];
    const raw = g.localStorage.getItem(MOCK_CONTEXT_ACTIONS_LS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function writeMockContextActions(items: Record<string, unknown>[], global?: MockGlobal): void {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return;
    g.localStorage.setItem(MOCK_CONTEXT_ACTIONS_LS, JSON.stringify(items));
  } catch (_) {
    /* ignore */
  }
}

export function readMockContextActionAudit(global?: MockGlobal): Record<string, unknown>[] {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return [];
    const raw = g.localStorage.getItem(MOCK_CONTEXT_ACTION_AUDIT_LS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function writeMockContextActionAudit(items: Record<string, unknown>[], global?: MockGlobal): void {
  const g = resolveGlobal(global);
  try {
    if (!g.localStorage) return;
    g.localStorage.setItem(MOCK_CONTEXT_ACTION_AUDIT_LS, JSON.stringify(items));
  } catch (_) {
    /* ignore */
  }
}
