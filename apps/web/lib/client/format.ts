/** Display formatting for CaseDesk. Fixed locale so screenshots and tests are stable. */
const LOCALE = "en-GB";

const EUR = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const PCT = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });
const DATE = new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export function formatEur(amount: number): string {
  return EUR.format(amount);
}

export function formatPct(value: number): string {
  return `${PCT.format(value)} %`;
}

/** An ISO calendar date (`2026-09-12`) as `12 Sept 2026`. */
export function formatIsoDate(isoDate: string): string {
  return DATE.format(new Date(`${isoDate}T00:00:00Z`));
}

/** Relationship age: `New relationship`, `7 months`, `2 yr 3 mo`. */
export function formatRelationshipAge(months: number): string {
  if (months === 0) return "New relationship";
  if (months < 12) return `${months} ${months === 1 ? "month" : "months"}`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest === 0 ? `${years} yr` : `${years} yr ${rest} mo`;
}

/** A position in a recording (milliseconds) as `m:ss.s`. */
export function formatTimestamp(ms: number): string {
  const totalTenths = Math.floor(ms / 100);
  const minutes = Math.floor(totalTenths / 600);
  const seconds = (totalTenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** First segment of an opaque id, for compact display (the full id stays available as a title). */
export function shortId(id: string): string {
  return id.split("-")[0] ?? id;
}
