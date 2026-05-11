/**
 * Morning Brief evaluation events (spec §7) — console + optional ingest hook.
 */

const EVENTS = {
  NEXT_ACTION_CLICK: "brief.next_action.click",
  ITEM_DISMISS: "brief.item.dismiss",
  RATING: "brief.rating.submitted",
  BRIEF_RENDERED: "brief.rendered",
  /** Chat send: whether manual memoryContext vs server memoryAssembly was used (privacy-respecting). */
  CHAT_COMPLETION_CONTEXT: "chat.completion.context",
};

/** @type {Array<{ t: string, name: string, payload: object }>} */
const buffer: any[] = [];
const MAX = 200;

function log(name: any, payload: any) {
  const row = {
    t: new Date().toISOString(),
    name: name,
    payload: payload || {},
  };
  buffer.push(row);
  if (buffer.length > MAX) buffer.shift();
  if (console && console.debug) {
    console.debug("[BriefTelemetry]", name, payload);
  }
  const global = typeof window !== 'undefined' ? window : globalThis;
  const hook = (global as any).shogunBriefTelemetrySink;
  if (typeof hook === "function") {
    try {
      hook(row);
    } catch (_) {}
  }
}

export const BriefTelemetry = {
  EVENTS: EVENTS,
  log: log,
  /** Dev helper: last N events */
  peek: (n: any) => buffer.slice(-(n || 20)),
};

