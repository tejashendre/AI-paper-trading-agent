/**
 * Recorded equity history, one series per sleeve.
 *
 * Two things read these curves and they want different measures, so both are
 * stored on every point:
 *
 *   - `equityUsd` is mark-to-market, including open positions. This is what
 *     rolling edge re-validation needs, because a strategy holding a losing
 *     book has lost the money whether or not it has closed the trade.
 *   - `realizedEquityUsd` counts only closed trades. This is what the sleeve
 *     correlation needs, because the two sleeves mark on wildly different
 *     schedules and comparing a continuously-marked series against one that
 *     only moves on exits would measure the recording schedule rather than
 *     the strategies.
 */

import { getRedis } from "@/lib/redis";

export const EQUITY_CURVE_MAX_POINTS = 2000;

/** Redis keys, one per sleeve. */
export const BOOK_EQUITY_CURVE_KEY = "xsec:equityCurve";
export const SWING_EQUITY_CURVE_KEY = "swing:equityCurve";

export interface EquityPoint {
  at: string;
  equityUsd: number;
  /** Closed-trade equity. Falls back to equityUsd on older points. */
  realizedEquityUsd?: number;
}

export async function recordEquityPoint(
  key: string,
  point: { equityUsd: number; realizedEquityUsd?: number }
): Promise<void> {
  if (!Number.isFinite(point.equityUsd) || point.equityUsd <= 0) return;
  const redis = getRedis();
  const record: EquityPoint = {
    at: new Date().toISOString(),
    equityUsd: point.equityUsd,
    realizedEquityUsd: Number.isFinite(point.realizedEquityUsd ?? NaN)
      ? point.realizedEquityUsd
      : point.equityUsd,
  };
  await redis.lpush(key, record);
  await redis.ltrim(key, 0, EQUITY_CURVE_MAX_POINTS - 1);
}

/** Oldest first, which is the order every downstream statistic assumes. */
export async function getEquityCurve(
  key: string,
  limit = EQUITY_CURVE_MAX_POINTS
): Promise<EquityPoint[]> {
  const rows = await getRedis().lrange(key, 0, limit - 1).catch(() => [] as string[]);
  return rows
    .map((row) => { try { return JSON.parse(row) as EquityPoint; } catch { return null; } })
    .filter((p): p is EquityPoint => p !== null && Number.isFinite(p.equityUsd))
    .reverse();
}

/** Project a curve onto whichever measure the caller needs. */
export function asSeries(
  points: EquityPoint[],
  measure: "marked" | "realized"
): Array<{ at: string; equityUsd: number }> {
  return points.map((p) => ({
    at: p.at,
    equityUsd: measure === "realized" ? (p.realizedEquityUsd ?? p.equityUsd) : p.equityUsd,
  }));
}
