// Whether sample/demo data (Agents roster, seeded chat history) should be shown.
//
// Real distributed builds must start empty — a fresh user seeing 9 agents they
// never created, or demo chats from "Kitazawa Tech", reads as broken. Demo data
// is therefore ON only in dev (`vite dev`) or when explicitly opted in with
// `VITE_SHOGUN_DEMO=1` at build time; a production `vite build` ships it OFF.

/** Pure core, separated so the env can be injected in tests. */
export function computeDemoDataEnabled(env: Record<string, unknown> | null | undefined): boolean {
  if (!env) return false;
  const flag = env.VITE_SHOGUN_DEMO;
  if (flag === '1' || flag === 'true' || flag === true) return true;
  if (flag === '0' || flag === 'false' || flag === false) return false;
  return !!env.DEV;
}

export function demoDataEnabled(): boolean {
  try {
    return computeDemoDataEnabled((import.meta as any).env || {});
  } catch {
    return false;
  }
}
