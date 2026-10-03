import { bybitPublicGet, type BybitRequestOptions } from "@/lib/data/bybitPublic";

/**
 * Crowding filter: skip entries that join an extremely crowded side. Crowded
 * long means the share of accounts long and the funding rate are both in the
 * top decile of their own recent history, with longs paying; crowded short is
 * the mirror. Positioning is used only to avoid trades, never to open them.
 * Evidence: Schmeling, Schrimpf and Todorov, "Crypto carry", BIS WP 1087 (high
 * funding predicts crashes); extreme account ratios are a contrarian warning.
 */
export const CROWDING_DECILE = 0.9;
export const MIN_RATIO_SAMPLES = 50;
export const MIN_FUNDING_SAMPLES = 30;

export interface CrowdingInputs {
  /** Share of accounts long (0..1), oldest first; the last value is current. */
  buyRatios: number[];
  /** Funding rates, oldest first; the last value is the current rate. */
  fundingRates: number[];
}

export interface CrowdingDecision {
  crowded: boolean;
  reason: string;
  ratioRank: number | null;
  fundingRank: number | null;
}

/** Fraction of the history at or below the latest value. */
function rank(values: number[]): number {
  const latest = values[values.length - 1];
  return values.filter((value) => value <= latest).length / values.length;
}

export function evaluateCrowding(direction: "LONG" | "SHORT", inputs: CrowdingInputs): CrowdingDecision {
  const ratios = inputs.buyRatios.filter(Number.isFinite);
  const rates = inputs.fundingRates.filter(Number.isFinite);
  if (ratios.length < MIN_RATIO_SAMPLES || rates.length < MIN_FUNDING_SAMPLES) {
    return { crowded: false, reason: "Not enough positioning history to judge crowding.", ratioRank: null, fundingRank: null };
  }
  const ratioRank = rank(ratios);
  const fundingRank = rank(rates);
  const latestRate = rates[rates.length - 1];
  const latestRatio = ratios[ratios.length - 1];
  const crowded = direction === "LONG"
    ? ratioRank >= CROWDING_DECILE && fundingRank >= CROWDING_DECILE && latestRate > 0
    : ratioRank <= 1 - CROWDING_DECILE && fundingRank <= 1 - CROWDING_DECILE && latestRate < 0;
  const side = direction === "LONG" ? "long" : "short";
  return {
    crowded,
    reason: crowded
      ? `CROWDED_${direction}: ${(latestRatio * 100).toFixed(0)}% of accounts long and funding ${(latestRate * 100).toFixed(4)}% are both at the ${side} extreme of their history.`
      : `Positioning is not crowded on the ${side} side.`,
    ratioRank,
    fundingRank,
  };
}

const CACHE_MS = 15 * 60_000;
const cache = new Map<string, { atMs: number; inputs: CrowdingInputs }>();

/** 500 hourly account-ratio points and the last 200 funding settlements. */
export async function loadCrowdingInputs(symbol: string, currentFundingRate?: number, options: BybitRequestOptions = {}): Promise<CrowdingInputs> {
  const now = (options.nowMs ?? Date.now)();
  const hit = cache.get(symbol);
  let inputs = hit && now - hit.atMs < CACHE_MS ? hit.inputs : null;
  if (!inputs) {
    const encoded = encodeURIComponent(symbol);
    const [ratio, funding] = await Promise.all([
      bybitPublicGet<{ list?: Array<{ buyRatio?: string; timestamp?: string }> }>(
        `/v5/market/account-ratio?category=linear&symbol=${encoded}&period=1h&limit=500`, options),
      bybitPublicGet<{ list?: Array<{ fundingRate?: string; fundingRateTimestamp?: string }> }>(
        `/v5/market/funding/history?category=linear&symbol=${encoded}&limit=200`, options),
    ]);
    // Bybit lists newest first.
    inputs = {
      buyRatios: (ratio.result.list ?? []).map((row) => Number(row.buyRatio)).reverse(),
      fundingRates: (funding.result.list ?? []).map((row) => Number(row.fundingRate)).reverse(),
    };
    cache.set(symbol, { atMs: now, inputs });
  }
  const current = Number(currentFundingRate);
  return Number.isFinite(current) ? { ...inputs, fundingRates: [...inputs.fundingRates, current] } : inputs;
}

export function clearCrowdingCache(): void {
  cache.clear();
}
