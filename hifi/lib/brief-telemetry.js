/* global window */
/**
 * Morning Brief evaluation events (spec §7) — console + optional ingest hook.
 */
(function initBriefTelemetry(global) {
  const EVENTS = {
    NEXT_ACTION_CLICK: "brief.next_action.click",
    ITEM_DISMISS: "brief.item.dismiss",
    RATING: "brief.rating.submitted",
    BRIEF_RENDERED: "brief.rendered",
  };

  /** @type {Array<{ t: string, name: string, payload: object }>} */
  const buffer = [];
  const MAX = 200;

  function log(name, payload) {
    const row = {
      t: new Date().toISOString(),
      name: name,
      payload: payload || {},
    };
    buffer.push(row);
    if (buffer.length > MAX) buffer.shift();
    if (global.console && console.debug) {
      console.debug("[BriefTelemetry]", name, payload);
    }
    const hook = global.shogunBriefTelemetrySink;
    if (typeof hook === "function") {
      try {
        hook(row);
      } catch (_) {}
    }
  }

  global.BriefTelemetry = {
    EVENTS: EVENTS,
    log: log,
    /** Dev helper: last N events */
    peek: (n) => buffer.slice(-(n || 20)),
  };
})(window);
