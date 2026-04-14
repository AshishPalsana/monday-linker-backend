
const TZ = "America/Chicago";

function getCSTDayBounds(dateStr) {
  // Use UTC-based day boundaries. Technicians work 7 AM–6 PM CDT which maps
  // to 12 PM–11 PM UTC — always within the same UTC calendar day — so UTC
  // bounds are equivalent to CST bounds for normal working hours and avoid
  // mismatches when the server or client is in a different timezone (e.g. IST).
  const isoDate = dateStr ?? new Date().toISOString().split("T")[0];
  const dayStart = new Date(`${isoDate}T00:00:00.000Z`);
  const dayEnd   = new Date(`${isoDate}T23:59:59.999Z`);
  return { dayStart, dayEnd };
}

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

function getCSTRangeBounds(from, to) {
  const offset = getCSTOffset(new Date(`${from}T12:00:00Z`));
  const rangeStart = new Date(`${from}T00:00:00.000${offset}`);
  const rangeEnd   = new Date(`${to}T23:59:59.999${offset}`);
  return { rangeStart, rangeEnd };
}

module.exports = { getCSTDayBounds, getCSTRangeBounds };
