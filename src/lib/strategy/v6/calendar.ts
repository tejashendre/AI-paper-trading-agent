import type { ConfiguredAsset } from '@/lib/trading/instrumentRegistry';
import type { CalendarManifest, CalendarRelease } from './engine';

const DAY = 86_400_000;
export const EVENT_WINDOW_MS = 3_600_000;
const HOSTS: Record<CalendarRelease, string> = {
  FED: 'federalreserve.gov', US_CPI: 'bls.gov', US_PAYROLLS: 'bls.gov',
  ECB: 'ecb.europa.eu', BOE: 'bankofengland.co.uk', BOJ: 'boj.or.jp', EIA_WPSR: 'eia.gov',
};

function localTime(nowMs: number, timezone: string): { date: string; weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(nowMs);
  const value = (key: string) => parts.find(p => p.type === key)!.value;
  return { date: `${value('year')}-${value('month')}-${value('day')}`, weekday: value('weekday'), hour: Number(value('hour')) };
}

export function strategySessionAllowed(asset: ConfiguredAsset, nowMs: number): boolean {
  if (!Number.isFinite(nowMs)) return false;
  if (asset === 'BTC' || asset === 'ETH' || asset === 'SOL') return true;
  const ny = localTime(nowMs, 'America/New_York');
  if (ny.weekday === 'Sat' || ny.weekday === 'Sun') return false;
  if (asset === 'OIL') return ny.weekday !== 'Fri' && ny.hour >= 8 && ny.hour < 16;
  const fx = asset === 'EURUSD' || asset === 'GBPUSD' || asset === 'USDJPY';
  if (fx && ny.weekday === 'Fri' && ny.hour >= 12) return false;
  const london = localTime(nowMs, 'Europe/London');
  return (london.hour >= 8 && london.hour < 17) || (ny.hour >= 8 && ny.hour < 17);
}

function requiredReleases(asset: ConfiguredAsset): CalendarRelease[] {
  if (asset === 'BTC' || asset === 'ETH' || asset === 'SOL') return [];
  if (asset === 'OIL') return ['EIA_WPSR'];
  const common: CalendarRelease[] = ['FED', 'US_CPI', 'US_PAYROLLS'];
  if (asset === 'EURUSD') common.push('ECB');
  if (asset === 'GBPUSD') common.push('BOE');
  if (asset === 'USDJPY') common.push('BOJ');
  return common;
}

function officialSource(release: CalendarRelease, source: string): boolean {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && !url.username && !url.password &&
      (url.hostname === HOSTS[release] || url.hostname.endsWith(`.${HOSTS[release]}`));
  } catch { return false; }
}

function validTimezone(timezone: string): boolean {
  if (typeof timezone !== 'string' || !timezone) return false;
  try { localTime(0, timezone); return true; } catch { return false; }
}

/** Coverage is an explicit verified source assertion, never inferred from event count or weekday recurrence. */
export function validateCalendar(input: { asset: ConfiguredAsset; manifest: CalendarManifest | null; nowMs: number }): { allowed: boolean; reason: string } {
  const { asset, manifest: m, nowMs } = input;
  const blocked = (reason: string) => ({ allowed: false, reason });
  const required = requiredReleases(asset);
  if (!Number.isFinite(nowMs)) return blocked('Calendar decision clock is invalid');
  if (required.length === 0) return { allowed: true, reason: 'No calendar-gated releases for crypto' };
  if (!m || m.version !== 'v6-calendar-1' || !Array.isArray(m.sources) || !Array.isArray(m.events)) return blocked('Calendar manifest is missing or unsupported');
  if ([...m.sources, ...m.events].some(row => !row || typeof row !== 'object' || !Object.prototype.hasOwnProperty.call(HOSTS, row.release))) return blocked('Calendar contains an unparseable source or event row');
  const stamps = [m.retrievedAtMs, m.expiresAtMs, m.coverageStartMs, m.coverageEndMs];
  if (!stamps.every(Number.isFinite) || m.retrievedAtMs > nowMs || nowMs - m.retrievedAtMs > DAY ||
      m.expiresAtMs <= nowMs || m.expiresAtMs <= m.retrievedAtMs || m.expiresAtMs - m.retrievedAtMs > DAY ||
      m.coverageStartMs > nowMs || m.coverageEndMs < nowMs + 7 * DAY) return blocked('Calendar timing, freshness or seven-day coverage is invalid');
  for (const release of required) {
    const sources = m.sources.filter(s => s.release === release);
    if (sources.length !== 1) return blocked(`${release} requires one verified coverage source`);
    const s = sources[0];
    if (!officialSource(release, s.source) || !validTimezone(s.timezone) ||
        ![s.retrievedAtMs, s.coverageStartMs, s.coverageEndMs].every(Number.isFinite) ||
        s.retrievedAtMs > m.retrievedAtMs || nowMs - s.retrievedAtMs > DAY ||
        s.coverageStartMs > nowMs || s.coverageEndMs < nowMs + 7 * DAY) return blocked(`${release} source provenance or coverage is invalid`);
    const seen = new Set<string>();
    for (const event of m.events.filter(e => e.release === release)) {
      if (typeof event.id !== 'string' || !event.id || seen.has(event.id) || event.source !== s.source || !validTimezone(event.timezone) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(event.date) || !Number.isFinite(Date.parse(`${event.date}T00:00:00Z`)) ||
          new Date(`${event.date}T00:00:00Z`).toISOString().slice(0, 10) !== event.date ||
          typeof event.timeUncertain !== 'boolean') return blocked(`${release} event is ambiguous or malformed`);
      seen.add(event.id);
      if (event.confirmedPastAtMs !== undefined && (!Number.isFinite(event.confirmedPastAtMs) || event.confirmedPastAtMs > m.retrievedAtMs || localTime(event.confirmedPastAtMs, event.timezone).date < event.date)) return blocked(`${release} confirmation was unavailable at retrieval or precedes its release date`);
      if (event.timeUncertain) {
        if (event.timeMs !== null) return blocked(`${release} uncertain event has a contradictory exact time`);
        if (localTime(nowMs, event.timezone).date === event.date && event.confirmedPastAtMs === undefined) return blocked(`${release} has an uncertain release time today`);
      } else {
        if (event.timeMs === null || !Number.isFinite(event.timeMs) || localTime(event.timeMs, event.timezone).date !== event.date) return blocked(`${release} release time is unavailable or contradictory`);
        if (Math.abs(nowMs - event.timeMs) <= EVENT_WINDOW_MS) return blocked(`${release} scheduled release exclusion window`);
      }
    }
  }
  return { allowed: true, reason: 'Verified source coverage and event windows permit entry' };
}
