// High-impact macroeconomic event blackout calendar.
// Update the EVENTS array once per month by looking up the next month's events at:
//   Fed decisions:  https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
//   NFP / CPI:      https://www.bls.gov/schedule/news_release/empsit.htm
//
// Add each event as an ISO 8601 UTC datetime string.
// The blackout window is PRE_EVENT_BLACKOUT_MS before and POST_EVENT_BLACKOUT_MS after.
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
  // Add upcoming month's events here
];

// ─── Blackout window configuration ────────────────────────────────────────────
const PRE_EVENT_BLACKOUT_MS  = 4 * 60 * 60_000;  // 4 hours before event
const POST_EVENT_BLACKOUT_MS = 1 * 60 * 60_000;  // 1 hour after event

// ─── Public API ───────────────────────────────────────────────────────────────
export function isEventBlackout(
  asset: string,
  now = new Date()
): { blocked: boolean; reason: string } {
  const nowMs = now.getTime();

  for (const event of EVENTS) {
    // If affectedAssets is empty, the event applies to all non-crypto assets
    const affects =
      event.affectedAssets.length === 0 || event.affectedAssets.includes(asset);
    if (!affects) continue;

    const eventMs = new Date(event.utc).getTime();
    if (!Number.isFinite(eventMs)) continue; // Skip malformed dates

    const windowStart = eventMs - PRE_EVENT_BLACKOUT_MS;
    const windowEnd   = eventMs + POST_EVENT_BLACKOUT_MS;

    if (nowMs >= windowStart && nowMs <= windowEnd) {
      const minutesTo = Math.round((eventMs - nowMs) / 60_000);
      const label =
        minutesTo > 0
          ? `${minutesTo} minutes until ${event.name}`
          : `${Math.abs(minutesTo)} minutes after ${event.name}`;
      return {
        blocked: true,
        reason: `High-impact event blackout: ${event.name} (${label}). New entries paused to avoid event-driven volatility.`,
      };
    }
  }

  return { blocked: false, reason: "" };
}
