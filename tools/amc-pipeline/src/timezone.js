/**
 * Default IANA timezone for ranking/scoring when the caller does not pass `timeZone`.
 * Uses the host environment (Node: OS TZ; browser: user settings).
 */
export function defaultPipelineTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
  } catch {
    return "UTC";
  }
}
