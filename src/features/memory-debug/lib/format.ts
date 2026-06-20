/**
 * Format helpers for the memory-debug feature.
 */

/** Format a millisecond timestamp into a locale string, or "—" for falsy/invalid input. */
export function msToLocal(ms: number | null | undefined): string {
  if (!ms) return "—";
  try {
    const d = new Date(Number(ms));
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  } catch (_) {
    return "—";
  }
}

/** Format a millisecond timestamp as a rough relative age, or "—" for falsy/invalid input. */
export function msToRelative(ms: number | null | undefined, nowMs: number = Date.now()): string {
  if (!ms) return "—";
  const time = Number(ms);
  if (!Number.isFinite(time) || !Number.isFinite(nowMs)) return "—";
  const diff = Math.max(0, nowMs - time);
  if (diff < 60_000) return "just now";
  if (diff < 60 * 60_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))}h ago`;
  return `${Math.round(diff / (24 * 60 * 60_000))}d ago`;
}

/** Format a byte count into a human-readable string (e.g. "1.0 KB"). */
export function humanBytes(n: number | null | undefined): string {
  if (!n || n < 1024) return `${n || 0} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
