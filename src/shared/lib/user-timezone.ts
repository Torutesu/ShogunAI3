/**
 * User-facing dates/times use the browser/OS timezone (Intl).
 * Loaded before screen bundles so `window.ShogunUserTimezone` is available at runtime.
 */

function getTimeZone() {
  try {
    var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && String(tz).trim() ? String(tz).trim() : "UTC";
  } catch (_e) {
    return "UTC";
  }
}

/**
 * @param {string} isoString
 * @param {string} [timeZone] IANA id; defaults to getTimeZone()
 * @returns {{ time: string, tzShort: string }}
 */
function formatIsoInTimeZone(isoString: any, timeZone?: any) {
  var d = new Date(isoString || "");
  if (Number.isNaN(d.getTime())) return { time: "", tzShort: "" };
  var tz = timeZone || getTimeZone();
  try {
    var parts = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    }).formatToParts(d);
    var h = "";
    var m = "";
    var tname = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p && p.type === "hour") h = p.value;
      if (p && p.type === "minute") m = p.value;
      if (p && p.type === "timeZoneName") tname = p.value;
    }
    return { time: h + ":" + m, tzShort: tname || "" };
  } catch (_e2) {
    return { time: d.toTimeString().slice(0, 5), tzShort: "" };
  }
}

export const ShogunUserTimezone = {
  getTimeZone: getTimeZone,
  formatIsoInTimeZone: formatIsoInTimeZone,
};

