
const TZ = "America/Chicago";

/**
 * Returns the current CST/CDT offset string, e.g. "-05:00" (CDT) or "-06:00" (CST).
 * Respects daylight saving automatically via Intl.
 */
function getCSTOffset(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    timeZoneName: "shortOffset",
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const match = tzPart.match(/GMT([+-]\d+)/);
  if (!match) return "-06:00";
  const hours = parseInt(match[1], 10);
  const sign = hours < 0 ? "-" : "+";
  return `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
}

/**
 * Returns today's date string in CST/CDT as "YYYY-MM-DD".
 * Safe to use even when the server is running in UTC.
 */
function getCSTTodayDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

/**
 * Returns the start/end of a CST calendar day as UTC Date objects.
 * Uses CST midnight boundaries — NOT UTC midnight — so entries at
 * 11 PM or later CST are correctly included in that CST day.
 *
 * @param {string} [dateStr] - "YYYY-MM-DD" in CST. Defaults to today in CST.
 */
function getCSTDayBounds(dateStr) {
  const isoDate = dateStr ?? getCSTTodayDate();
  const offset  = getCSTOffset(new Date(`${isoDate}T12:00:00Z`));
  const dayStart = new Date(`${isoDate}T00:00:00.000${offset}`);
  const dayEnd   = new Date(`${isoDate}T23:59:59.999${offset}`);
  return { dayStart, dayEnd };
}

/**
 * Returns start/end of a CST date range as UTC Date objects.
 *
 * @param {string} from - "YYYY-MM-DD" in CST
 * @param {string} to   - "YYYY-MM-DD" in CST
 */
function getCSTRangeBounds(from, to) {
  const offsetFrom = getCSTOffset(new Date(`${from}T12:00:00Z`));
  const offsetTo   = getCSTOffset(new Date(`${to}T12:00:00Z`));
  const rangeStart = new Date(`${from}T00:00:00.000${offsetFrom}`);
  const rangeEnd   = new Date(`${to}T23:59:59.999${offsetTo}`);
  return { rangeStart, rangeEnd };
}

module.exports = { getCSTDayBounds, getCSTRangeBounds, getCSTTodayDate, getCSTOffset };
