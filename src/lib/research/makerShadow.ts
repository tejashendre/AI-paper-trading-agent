import { getRedis } from "@/lib/redis";
import type { Candle } from "@/lib/types";

/**
 * Maker-entry shadow comparison. Every research candidate is also evaluated as
 * a post-only limit at the signal price. Paper maker fills are easy to fake, so
 * the rule is conservative: the order fills only when price trades through the
 * limit by at least one tick within the wait window; otherwise it is cancelled
 * and the setup is recorded as a miss, with zero result even if it would have
 * won. Results are in R (initial stop distance) so assets compare.
 */
export const MAKER_WAIT_MS = 30 * 60_000;
export const MAKER_SHADOW_KEY = "research:makerShadow";
export const MAKER_SHADOW_CAP = 2_000;

export interface MakerComparisonInput {
  direction: "LONG" | "SHORT";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  /** Closed bars from the signal time onward. */
  bars: Candle[];
  barIntervalMs: number;
  startMs: number;
  tickSize: number;
  makerFeeRate: number;
  takerFeeRate: number;
  halfSpreadBps?: number;
}

export interface MakerComparison {
  makerFilled: boolean;
  makerNetR: number;
  takerNetR: number;
}

/** Exit along the path from bar index `from`: stop wins an ambiguous bar; otherwise the last close. */
function exitFrom(input: MakerComparisonInput, from: number): number {
  const long = input.direction === "LONG";
  for (const bar of input.bars.slice(from)) {
    if (long ? bar.low <= input.stopLoss : bar.high >= input.stopLoss) return long ? Math.min(bar.open, input.stopLoss) : Math.max(bar.open, input.stopLoss);
    if (long ? bar.high >= input.takeProfit : bar.low <= input.takeProfit) return input.takeProfit;
  }
  return input.bars[input.bars.length - 1].close;
}

export function compareMakerEntry(input: MakerComparisonInput): MakerComparison | null {
  const risk = Math.abs(input.entryPrice - input.stopLoss);
  if (!(risk > 0) || input.bars.length === 0 || !(input.tickSize > 0)) return null;
  const sign = input.direction === "LONG" ? 1 : -1;
  const netR = (entry: number, exit: number, entryFeeRate: number) =>
    (sign * (exit - entry) - entry * entryFeeRate - exit * input.takerFeeRate) / risk;

  // Taker: immediate entry paying half the spread and the taker fee.
  const takerEntry = input.entryPrice * (1 + sign * (input.halfSpreadBps ?? 0) / 10_000);
  const takerNetR = netR(takerEntry, exitFrom(input, 0), input.takerFeeRate);

  // Maker: rests at the signal price; needs a trade-through by one tick.
  const limit = input.entryPrice;
  const fillIndex = input.bars.findIndex((bar) => bar.time * 1000 < input.startMs + MAKER_WAIT_MS &&
    (sign > 0 ? bar.low <= limit - input.tickSize : bar.high >= limit + input.tickSize));
  if (fillIndex < 0) return { makerFilled: false, makerNetR: 0, takerNetR };
  // The fill bar itself may also reach the stop; checking it again is conservative.
  return { makerFilled: true, makerNetR: netR(limit, exitFrom(input, fillIndex), input.makerFeeRate), takerNetR };
}

export interface MakerShadowRow extends MakerComparison {
  candidateId: string;
  asset: string;
  family?: string;
  evaluatedAt: string;
}

export async function recordMakerComparison(row: MakerShadowRow): Promise<void> {
  const redis = getRedis();
  await redis.lpush(MAKER_SHADOW_KEY, JSON.stringify(row));
  await redis.ltrim(MAKER_SHADOW_KEY, 0, MAKER_SHADOW_CAP - 1);
}

/** Fill rate and mean R of both entry styles over the recorded comparisons. */
export function summarizeMakerShadow(rows: MakerComparison[]) {
  const n = rows.length;
  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  return {
    comparisons: n,
    makerFillRate: n ? rows.filter((r) => r.makerFilled).length / n : null,
    /** Misses count as zero: the setup was skipped. */
    makerMeanNetR: mean(rows.map((r) => r.makerNetR)),
    takerMeanNetR: mean(rows.map((r) => r.takerNetR)),
  };
}

export async function loadMakerShadowSummary() {
  const raw = await getRedis().lrange(MAKER_SHADOW_KEY, 0, MAKER_SHADOW_CAP - 1).catch(() => [] as string[]);
  return summarizeMakerShadow(raw.map((line) => JSON.parse(line) as MakerComparison));
}
