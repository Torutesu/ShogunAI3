/**
 * Rule-based priority ranker (spec §4).
 */

import { defaultPipelineTimeZone } from "./timezone.js";

const CATEGORY_SCORES = {
  meeting: 25,
  commitment: 30,
  decision: 25,
  followup: 15,
  prep: 10,
  review: 10,
  signal: 5,
};

/**
 * @param {{ hour: number, minute: number }} parts
 */
function minutesSinceMidnight(parts) {
  return parts.hour * 60 + parts.minute;
}

/**
 * @param {string} timeZone IANA e.g. "Asia/Tokyo"
 * @param {Date} [now]
 */
export function zonedNowParts(timeZone, now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = fmt.formatToParts(now);
  const hour = Number(p.find((x) => x.type === "hour")?.value || 0);
  const minute = Number(p.find((x) => x.type === "minute")?.value || 0);
  return { hour, minute };
}

/**
 * Start time from "HH:MM-HH:MM" is before noon.
 * @param {string} [timeHint]
 */
export function hintStartsBeforeNoon(timeHint) {
  if (!timeHint || typeof timeHint !== "string") return false;
  const m = timeHint.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return false;
  const hh = Number(m[1]);
  return hh < 12;
}

/**
 * Brief run is "this morning" before local noon (for +30 urgency).
 * @param {string} timeZone
 * @param {Date} [now]
 */
export function isNowBeforeLocalNoon(timeZone, now = new Date()) {
  const { hour } = zonedNowParts(timeZone, now);
  return hour < 12;
}

/**
 * For same-day Morning Brief, any time_hint implies calendar relevance today (+20).
 * @param {string} [timeHint]
 */
export function hasTimeHintToday(timeHint) {
  return Boolean(timeHint && String(timeHint).includes("-"));
}

/**
 * @param {string} why
 */
export function extractStuckDaysFromWhyNow(why) {
  const m = why.match(/停滞\s*(\d+)\s*日|stuck\s*(\d+)\s*d/i);
  if (!m) return 0;
  return Number(m[1] || m[2] || 0);
}

/**
 * @param {object} item
 */
function itemHasPendingDecisionFollowup(item) {
  return Boolean(item._pending_decision_followup);
}

/**
 * @param {object} item
 * @param {{ timeZone?: string, now?: Date }} [ctx]
 */
export function calculateScore(item, ctx = {}) {
  const timeZone = ctx.timeZone || defaultPipelineTimeZone();
  const now = ctx.now || new Date();
  let score = 0;

  if (
    item.time_hint &&
    hintStartsBeforeNoon(item.time_hint) &&
    isNowBeforeLocalNoon(timeZone, now)
  ) {
    score += 30;
  }
  if (item.time_hint && hasTimeHintToday(item.time_hint)) score += 20;

  score += CATEGORY_SCORES[item.category] ?? 0;

  if (itemHasPendingDecisionFollowup(item)) score += 20;

  const stuck =
    typeof item.stuck_days === "number"
      ? item.stuck_days
      : extractStuckDaysFromWhyNow(item.why_now);
  if (stuck) score += Math.min(stuck * 3, 30);

  score += Math.round(Number(item.confidence || 0) * 10);

  return score;
}

/**
 * @param {number} score
 */
export function scoreToBand(score) {
  if (score >= 60) return 1;
  if (score >= 35) return 2;
  return 3;
}

/**
 * @param {object} it
 * @param {number} band
 */
function stripMeta(it, band) {
  const { _score, _band, ...rest } = it;
  return { ...rest, priority: /** @type {1|2|3} */ (band) };
}

/**
 * Assign bands from score, sort by urgency, then cap P1≤3, P2≤3, P3≤1, total≤7.
 * @param {object[]} items
 */
export function rankAndCap(items, ctx = {}) {
  const withMeta = items.map((it) => {
    const s = calculateScore(it, ctx);
    return { ...it, _score: s, _band: scoreToBand(s) };
  });

  withMeta.sort((a, b) => b._score - a._score);

  const out = [];
  let n1 = 0,
    n2 = 0,
    n3 = 0;

  for (const it of withMeta) {
    if (out.length >= 7) continue;
    let placed = false;
    for (let tryBand = it._band; tryBand <= 3; tryBand++) {
      if (tryBand === 1 && n1 < 3) {
        n1++;
        out.push(stripMeta(it, 1));
        placed = true;
        break;
      }
      if (tryBand === 2 && n2 < 3) {
        n2++;
        out.push(stripMeta(it, 2));
        placed = true;
        break;
      }
      if (tryBand === 3 && n3 < 1) {
        n3++;
        out.push(stripMeta(it, 3));
        placed = true;
        break;
      }
    }
  }

  const pickedIds = new Set(out.map((x) => x.id));
  const deferred = withMeta
    .filter((x) => !pickedIds.has(x.id))
    .map(({ _score, _band, ...r }) => r);

  return { items: out, deferred };
}
