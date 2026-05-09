/** Normalized result of a `shogun-chat-composer-seed` memory-assembly preset. */
export interface MemoryAssemblyPreset {
  query: string;
  limit: number;
  semantic: boolean;
}

/**
 * One-shot Memory assembly overrides from `shogun-chat-composer-seed`
 * (Memory / Agents). Returns `null` when the input carries no valid preset.
 */
export function normalizeSeedMemoryAssembly(d: unknown): MemoryAssemblyPreset | null {
  if (!d || typeof d !== 'object') return null;
  const data = d as Record<string, unknown>;

  if (data.memoryAssemblyPreset && typeof data.memoryAssemblyPreset === 'object') {
    const p = data.memoryAssemblyPreset as Record<string, unknown>;
    const q = String(p.query || '').trim().slice(0, 480);
    const limRaw = p.limit != null ? Number(p.limit) : 12;
    const lim = Number.isFinite(limRaw) ? Math.min(80, Math.max(1, Math.floor(limRaw))) : 12;
    const semantic = p.semantic !== false;
    return { query: q, limit: lim, semantic };
  }

  if (data.memoryAssemblyQuery != null && String(data.memoryAssemblyQuery).trim()) {
    const q = String(data.memoryAssemblyQuery).trim().slice(0, 480);
    const limRaw = data.memoryAssemblyLimit != null ? Number(data.memoryAssemblyLimit) : 12;
    const lim = Number.isFinite(Number(limRaw)) ? Math.min(80, Math.max(1, Math.floor(Number(limRaw)))) : 12;
    const semantic = data.memoryAssemblySemantic !== false;
    return { query: q, limit: lim, semantic };
  }

  return null;
}
