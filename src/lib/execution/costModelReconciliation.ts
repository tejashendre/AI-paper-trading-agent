import { getRedis } from "@/lib/redis";
import { Logger } from "@/lib/logger";
import { PerpTicker } from "@/lib/data/perpUniverse";
import { PaperFillEstimate } from "@/lib/trading/executionCostModel";

/**
 * Does the execution cost model tell the truth?
 *
 * Every performance number this system produces rests on
 * `executionCostModel.ts` — its spread, slippage, stop-gap and carry
 * assumptions. Nothing checked whether those assumptions matched reality, so
 * the backtest was resting on an unverified instrument. If real spreads are
 * three times the modelled figure, the reported edge is fiction and there was
 * previously no way to discover that.
 *
 * A paper system has no real fill to compare against, so the naive version of
 * this check is meaningless. Three things *are* genuinely observable, and this
 * module records all three:
 *
 *  1. **Spread.** The model assumes a half-spread per asset. The ticker gives a
 *     live bid and ask, so the true half-spread at the moment of the fill is
 *     known exactly.
 *  2. **Slippage.** The model assumes a fixed adverse move. Sampling the same
 *     market a minute later shows how far price actually moved against the
 *     position, which is the cost a real order would have paid chasing it.
 *  3. **Carry.** The model uses a per-day rate. The venue publishes the funding
 *     it actually charged.
 *
 * Each is stored as predicted-versus-observed so the ratio can be tracked over
 * time. A ratio near 1.0 means the model is honest. Persistently above 1.0
 * means the backtest was optimistic and the live edge is smaller than reported.
 */

export const RECONCILIATION_KEY = "xsec:costReconciliation";
export const PENDING_SAMPLE_KEY = "xsec:pendingSlippageSamples";
export const RECONCILIATION_VERDICT_KEY = "xsec:costVerdict";

/** How long after a fill to sample the market for realised adverse movement. */
export const SLIPPAGE_SAMPLE_DELAY_MS = 60_000;
/** Observations older than this stop counting toward the verdict. */
const MAX_OBSERVATIONS = 500;

export interface FillObservation {
  at: string;
  symbol: string;
  side: "BUY" | "SELL";
  notionalUsd: number;
  /** Half-spread the model charged, in basis points. */
  modelHalfSpreadBps: number;
  /** Half-spread actually quoted at that instant, from bid/ask. */
  observedHalfSpreadBps: number | null;
  /** Adverse move the model charged, in basis points. */
  modelSlippageBps: number;
  /** Adverse move actually observed a minute later. Null until sampled. */
  observedSlippageBps: number | null;
  referencePrice: number;
}

interface PendingSample {
  at: number;
  symbol: string;
  side: "BUY" | "SELL";
  referencePrice: number;
  modelSlippageBps: number;
  modelHalfSpreadBps: number;
  observedHalfSpreadBps: number | null;
  notionalUsd: number;
}

/**
 * True half-spread from the live quote, in basis points of mid.
 * Returns null when the venue reports a crossed or absent book, which happens
 * briefly around a rebalance and should not be recorded as a real measurement.
 */
export function observedHalfSpreadBps(ticker: PerpTicker): number | null {
  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= bid) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / 2 / mid) * 10_000;
}

/**
 * Record a fill for later comparison. Called at execution time, when the quote
 * that produced the fill is still available; the slippage half is completed by
 * `settlePendingSlippageSamples` a minute later.
 */
export async function recordFillForReconciliation(input: {
  symbol: string;
  side: "BUY" | "SELL";
  ticker: PerpTicker;
  fill: PaperFillEstimate;
}): Promise<void> {
  const spread = observedHalfSpreadBps(input.ticker);
  const pending: PendingSample = {
    at: Date.now(),
    symbol: input.symbol,
    side: input.side,
    referencePrice: input.ticker.markPrice,
    modelSlippageBps: input.fill.slippageBps,
    modelHalfSpreadBps: input.fill.spreadBps,
    observedHalfSpreadBps: spread,
    notionalUsd: Math.abs(input.fill.notionalUsd),
  };
  await getRedis().lpush(PENDING_SAMPLE_KEY, pending).catch(() => undefined);
  await getRedis().ltrim(PENDING_SAMPLE_KEY, 0, 200).catch(() => undefined);
}

/**
 * Complete any fill old enough to be sampled, by measuring how far the market
 * actually moved against the position since execution.
 *
 * Adverse movement is signed against the side traded: a buy that saw price
 * fall afterwards paid no slippage, so the observation is clamped at zero
 * rather than recorded as a negative cost.
 */
export async function settlePendingSlippageSamples(prices: Map<string, PerpTicker>): Promise<number> {
  const redis = getRedis();
  const raw = await redis.lrange(PENDING_SAMPLE_KEY, 0, 200).catch(() => [] as string[]);
  if (raw.length === 0) return 0;

  const pending: PendingSample[] = raw
    .map((row) => { try { return JSON.parse(row) as PendingSample; } catch { return null; } })
    .filter((row): row is PendingSample => row !== null);

  const now = Date.now();
  const ready = pending.filter((p) => now - p.at >= SLIPPAGE_SAMPLE_DELAY_MS);
  if (ready.length === 0) return 0;

  const settled: FillObservation[] = [];
  for (const p of ready) {
    const ticker = prices.get(p.symbol);
    if (!ticker || !(ticker.markPrice > 0) || !(p.referencePrice > 0)) continue;
    const movePct = (ticker.markPrice - p.referencePrice) / p.referencePrice;
    // A buy is hurt by price rising; a sell is hurt by price falling.
    const adverse = p.side === "BUY" ? movePct : -movePct;
    settled.push({
      at: new Date(p.at).toISOString(),
      symbol: p.symbol,
      side: p.side,
      notionalUsd: p.notionalUsd,
      modelHalfSpreadBps: p.modelHalfSpreadBps,
      observedHalfSpreadBps: p.observedHalfSpreadBps,
      modelSlippageBps: p.modelSlippageBps,
      observedSlippageBps: Math.max(0, adverse * 10_000),
      referencePrice: p.referencePrice,
    });
  }
  if (settled.length === 0) return 0;

  for (const observation of settled) await redis.lpush(RECONCILIATION_KEY, observation).catch(() => undefined);
  await redis.ltrim(RECONCILIATION_KEY, 0, MAX_OBSERVATIONS - 1).catch(() => undefined);

  // Keep only the samples that were not settled on this pass.
  const settledKeys = new Set(settled.map((s) => `${s.symbol}:${s.at}`));
  const remaining = pending.filter((p) => !settledKeys.has(`${p.symbol}:${new Date(p.at).toISOString()}`));
  await redis.del(PENDING_SAMPLE_KEY).catch(() => undefined);
  for (const p of remaining.reverse()) await redis.lpush(PENDING_SAMPLE_KEY, p).catch(() => undefined);

  return settled.length;
}

export interface CostVerdict {
  at: string;
  sampleSize: number;
  /** Observed / modelled. 1.0 means the model is honest. */
  spreadRatio: number | null;
  slippageRatio: number | null;
  /** Combined adverse cost, modelled and observed, in basis points. */
  modelTotalBps: number;
  observedTotalBps: number;
  totalRatio: number | null;
  verdict: "INSUFFICIENT_DATA" | "MODEL_HONEST" | "MODEL_OPTIMISTIC" | "MODEL_CONSERVATIVE";
  message: string;
}

/** Minimum settled observations before a verdict means anything. */
const MIN_SAMPLE = 30;

export async function buildCostVerdict(): Promise<CostVerdict> {
  const rows = await getRedis().lrange(RECONCILIATION_KEY, 0, MAX_OBSERVATIONS - 1).catch(() => [] as string[]);
  const observations: FillObservation[] = rows
    .map((row) => { try { return JSON.parse(row) as FillObservation; } catch { return null; } })
    .filter((row): row is FillObservation => row !== null);

  const at = new Date().toISOString();
  if (observations.length < MIN_SAMPLE) {
    return {
      at, sampleSize: observations.length,
      spreadRatio: null, slippageRatio: null,
      modelTotalBps: 0, observedTotalBps: 0, totalRatio: null,
      verdict: "INSUFFICIENT_DATA",
      message: `${observations.length} of ${MIN_SAMPLE} fills measured. The cost model cannot be judged yet.`,
    };
  }

  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
  const withSpread = observations.filter((o) => o.observedHalfSpreadBps !== null);
  const withSlip = observations.filter((o) => o.observedSlippageBps !== null);

  const modelSpread = mean(withSpread.map((o) => o.modelHalfSpreadBps));
  const obsSpread = mean(withSpread.map((o) => o.observedHalfSpreadBps as number));
  const modelSlip = mean(withSlip.map((o) => o.modelSlippageBps));
  const obsSlip = mean(withSlip.map((o) => o.observedSlippageBps as number));

  const modelTotalBps = modelSpread + modelSlip;
  const observedTotalBps = obsSpread + obsSlip;
  const totalRatio = modelTotalBps > 0 ? observedTotalBps / modelTotalBps : null;

  let verdict: CostVerdict["verdict"] = "MODEL_HONEST";
  let message = "";
  if (totalRatio === null) {
    verdict = "INSUFFICIENT_DATA";
    message = "Modelled cost is zero, so no ratio can be formed.";
  } else if (totalRatio > 1.5) {
    verdict = "MODEL_OPTIMISTIC";
    message =
      `Real execution is costing ${totalRatio.toFixed(2)}x the modelled figure. ` +
      `Backtested returns are overstated: every replay result should be read as if ` +
      `costs were ${observedTotalBps.toFixed(1)}bps rather than ${modelTotalBps.toFixed(1)}bps.`;
  } else if (totalRatio < 0.67) {
    verdict = "MODEL_CONSERVATIVE";
    message =
      `Real execution is cheaper than modelled (${totalRatio.toFixed(2)}x). ` +
      `Backtests understate the edge, and trades rejected on marginal economics may be viable.`;
  } else {
    message =
      `Observed cost ${observedTotalBps.toFixed(1)}bps against ${modelTotalBps.toFixed(1)}bps modelled ` +
      `(${totalRatio.toFixed(2)}x). The cost model is behaving honestly, so backtest figures can be trusted at face value.`;
  }

  const result: CostVerdict = {
    at, sampleSize: observations.length,
    spreadRatio: modelSpread > 0 ? obsSpread / modelSpread : null,
    slippageRatio: modelSlip > 0 ? obsSlip / modelSlip : null,
    modelTotalBps, observedTotalBps, totalRatio,
    verdict, message,
  };

  await getRedis().set(RECONCILIATION_VERDICT_KEY, result, { ex: 3600 }).catch(() => undefined);
  if (verdict === "MODEL_OPTIMISTIC") {
    await Logger.warn(`[COST] ${message}`).catch(() => undefined);
  }
  return result;
}
