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
