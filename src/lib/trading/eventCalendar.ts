// High-impact macroeconomic event blackout calendar.
// Update the EVENTS array once per month by looking up the next month's events at:
//   Fed decisions:  https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
//   NFP / CPI:      https://www.bls.gov/schedule/news_release/empsit.htm
//
// Add each event as an ISO 8601 UTC datetime string.
// The release guard only covers the most chaotic event minutes.
// The rest of the event day remains tradable for high-volume follow-through.
// If EVENTS is empty or outdated, the system fails OPEN — trading continues normally.

interface CalendarEvent {
  name: string;
  utc: string;                  // ISO 8601 UTC datetime of event release
  affectedAssets: string[];     // Asset keys to protect (empty array = all forex/commodity)
}

// ─── Monthly event list — update these dates each month ───────────────────────
// Uncomment and fill in real dates when you update:
//
// { name: "FOMC Decision",  utc: "2026-07-30T18:00:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD","SILVER"] },
// { name: "US NFP",         utc: "2026-08-07T12:30:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD"] },
// { name: "US CPI",         utc: "2026-07-15T12:30:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD"] },
// { name: "BOE Decision",   utc: "2026-08-07T11:00:00Z", affectedAssets: ["GBPUSD"] },
// { name: "ECB Decision",   utc: "2026-07-24T12:15:00Z", affectedAssets: ["EURUSD"] },
// { name: "BOJ Decision",   utc: "2026-07-31T03:00:00Z", affectedAssets: ["USDJPY"] },
// { name: "EIA Oil Report", utc: "2026-07-09T14:30:00Z", affectedAssets: ["OIL"] },

const EVENTS: CalendarEvent[] = [
  { name: "FOMC Decision",  utc: "2026-07-29T18:00:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD","SILVER"] },
  { name: "US NFP",         utc: "2026-08-07T12:30:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD"] },
  { name: "US CPI",         utc: "2026-07-14T12:30:00Z", affectedAssets: ["EURUSD","GBPUSD","USDJPY","GOLD"] },
  { name: "BOE Decision",   utc: "2026-07-30T11:00:00Z", affectedAssets: ["GBPUSD"] },
  { name: "ECB Decision",   utc: "2026-07-23T12:15:00Z", affectedAssets: ["EURUSD"] },
  { name: "BOJ Decision",   utc: "2026-07-31T03:00:00Z", affectedAssets: ["USDJPY"] },
];

// ─── Blackout window configuration ────────────────────────────────────────────
const PRE_EVENT_BLACKOUT_MS  = 30 * 60_000;  // 30 minutes before event
const POST_EVENT_BLACKOUT_MS = 15 * 60_000;  // 15 minutes after event

function nthSundayUtc(year: number, month: number, nth: number, hour: number) {
  const first = new Date(Date.UTC(year, month, 1, hour));
  const day = 1 + ((7 - first.getUTCDay()) % 7) + (nth - 1) * 7;
  return Date.UTC(year, month, day, hour);
}

function isUsDaylightTime(now: Date) {
  const year = now.getUTCFullYear();
  const starts = nthSundayUtc(year, 2, 2, 7); // 02:00 EST, second Sunday in March
  const ends = nthSundayUtc(year, 10, 1, 6);  // 02:00 EDT, first Sunday in November
  return now.getTime() >= starts && now.getTime() < ends;
}

function eventWindowReason(name: string, eventMs: number, nowMs: number) {
  if (nowMs < eventMs - PRE_EVENT_BLACKOUT_MS || nowMs > eventMs + POST_EVENT_BLACKOUT_MS) return null;
  const minutesTo = Math.round((eventMs - nowMs) / 60_000);
  const label = minutesTo > 0 ? `${minutesTo} minutes until ${name}` : `${Math.abs(minutesTo)} minutes after ${name}`;
  return `High-impact event release guard: ${name} (${label}). New entries pause only during the release spike; the rest of the event day remains tradable.`;
}

// ─── Public API ───────────────────────────────────────────────────────────────
export function isEventBlackout(
  asset: string,
  now = new Date()
): { blocked: boolean; reason: string } {
  const nowMs = now.getTime();

  // The EIA Weekly Petroleum Status Report normally releases Wednesday at
  // 10:30 US Eastern. Handle the recurring schedule instead of relying on a
  // single date that silently expires; holiday exceptions can still be added
  // to EVENTS when EIA announces them.
  if (asset === "OIL" && now.getUTCDay() === 3) {
    const releaseHourUtc = isUsDaylightTime(now) ? 14 : 15;
    const eventMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), releaseHourUtc, 30);
    const reason = eventWindowReason("EIA Weekly Petroleum Status Report", eventMs, nowMs);
    if (reason) return { blocked: true, reason };
  }

  for (const event of EVENTS) {
    // If affectedAssets is empty, the event applies to all non-crypto assets
    const affects =
      event.affectedAssets.length === 0 || event.affectedAssets.includes(asset);
    if (!affects) continue;

    const eventMs = new Date(event.utc).getTime();
    if (!Number.isFinite(eventMs)) continue; // Skip malformed dates

    const reason = eventWindowReason(event.name, eventMs, nowMs);
    if (reason) return { blocked: true, reason };
  }

  return { blocked: false, reason: "" };
}
