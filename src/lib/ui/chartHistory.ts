import type { Candle } from '@/lib/types';

export const MAX_CHART_CANDLES = 20_000;

/** Keep loaded history during refresh; older browsing rolls the bounded window back. */
export function mergeChartCandles(existing: Candle[], incoming: Candle[], direction: 'latest' | 'older', cap = MAX_CHART_CANDLES): Candle[] {
  const unique = new Map(existing.map(c => [c.time, c]));
  for (const candle of incoming) unique.set(candle.time, candle);
  const sorted = [...unique.values()].sort((a, b) => a.time - b.time);
  return direction === 'older' ? sorted.slice(0, cap) : sorted.slice(-cap);
}

/** Format each actual UTC instant, keeping chart coordinates unchanged across DST. */
export function formatChartTime(utcSeconds: number, timeZone: string, kind: 'clock' | 'date' | 'month' | 'year' | 'full' = 'full'): string {
  const options: Intl.DateTimeFormatOptions = { timeZone, hourCycle: 'h23' };
  if (kind === 'clock' || kind === 'full') Object.assign(options, { hour: '2-digit', minute: '2-digit' });
  if (kind === 'date' || kind === 'full') Object.assign(options, { day: '2-digit', month: 'short' });
  if (kind === 'month') options.month = 'short';
  if (kind === 'year' || kind === 'full') options.year = 'numeric';
  return new Intl.DateTimeFormat('en-GB', options).format(new Date(utcSeconds * 1000));
}
