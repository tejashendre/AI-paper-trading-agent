import { bybitPublicGet, type BybitRequestOptions } from "@/lib/data/bybitPublic";
import { evaluateShadowEvidence } from "@/lib/execution/bookRiskPolicy";
import type { EquityPoint } from "@/lib/execution/equityCurve";

/**
 * Simple baselines the bot has to beat, recomputed from Bybit daily closes and
 * real funding settlements, net of taker fees on turnover:
 * - EQUAL_WEIGHT_HOLD: the nine contracts long, equal weight, rebalanced daily
 *   (an asset joins once it has a close).
 * - TREND_DAILY: preregistered daily trend. Per asset, the average sign of the
 *   20, 60 and 120 day returns (a blend, not a picked lookback), scaled by
 *   min(1, 20% / 30-day realized volatility), one ninth of capital each.
 *   Evidence: Moskowitz, Ooi and Pedersen 2012; volatility scaling per
 *   Moreira and Muir 2017. Shadow only: no capital and no orders.
 */
export const BASELINES_VERSION = "baselines-v1-2026-10-03";
export const TREND_LOOKBACK_DAYS = [20, 60, 120] as const;
export const TREND_VOL_WINDOW_DAYS = 30;
export const TREND_TARGET_ANNUAL_VOL = 0.2;
/** Forward shadow evidence for TREND_DAILY counts from this day only. */
export const TREND_REGISTERED_AT_MS = Date.parse("2026-10-04T00:00:00Z");
export const DAY_MS = 86_400_000;

export interface DailySeries {
  asset: string;
  /** Daily closes keyed by the UTC day start. */
  closes: Map<number, number>;
  /** Funding settlements; a positive rate is paid by longs. */
  funding: Array<{ atMs: number; rate: number }>;
  takerFeeRate: number;
}

/** Target weight in [-1, 1] from closes up to and including the current day, or null without enough history. */
export function trendWeight(closes: number[]): number | null {
  const needed = Math.max(...TREND_LOOKBACK_DAYS) + 1;
  if (closes.length < Math.max(needed, TREND_VOL_WINDOW_DAYS + 1) || closes.some((c) => !(c > 0))) return null;
  const last = closes[closes.length - 1];
  const signal = TREND_LOOKBACK_DAYS.reduce((sum, days) => sum + Math.sign(last / closes[closes.length - 1 - days] - 1), 0) / TREND_LOOKBACK_DAYS.length;
  const window = closes.slice(-TREND_VOL_WINDOW_DAYS - 1);
  const returns = window.slice(1).map((c, i) => c / window[i] - 1);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const vol = Math.sqrt(returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1)) * Math.sqrt(365);
  return signal * Math.min(1, TREND_TARGET_ANNUAL_VOL / Math.max(vol, 1e-9));
}

export interface BaselineResult {
  name: "EQUAL_WEIGHT_HOLD" | "TREND_DAILY";
  curve: EquityPoint[];
  returnPercent: number;
  maxDrawdownPercent: number;
  feesUsd: number;
  fundingUsd: number;
}

/** Simulates both baselines over [startMs, endMs) on whole UTC days. */
export function simulateBaselines(input: { series: DailySeries[]; startMs: number; endMs: number; capitalUsd: number }): BaselineResult[] {
  const n = input.series.length;
  const firstDay = Math.ceil(input.startMs / DAY_MS) * DAY_MS;
  const books = (["EQUAL_WEIGHT_HOLD", "TREND_DAILY"] as const).map((name) => ({
    name, equity: input.capitalUsd, weights: new Map<string, number>(), feesUsd: 0, fundingUsd: 0,
    curve: [{ at: new Date(firstDay).toISOString(), equityUsd: input.capitalUsd }] as EquityPoint[],
  }));
  for (let day = firstDay; day + DAY_MS <= input.endMs; day += DAY_MS) {
    const tradable = input.series.filter((s) => s.closes.has(day) && s.closes.has(day + DAY_MS));
    if (tradable.length === 0) continue;
    for (const book of books) {
      const target = new Map<string, number>();
      for (const s of tradable) {
        if (book.name === "EQUAL_WEIGHT_HOLD") target.set(s.asset, 1 / tradable.length);
        else {
          const history = [...s.closes.entries()].filter(([at]) => at <= day).sort((a, b) => a[0] - b[0]).map(([, c]) => c);
          const weight = trendWeight(history);
          if (weight !== null && weight !== 0) target.set(s.asset, weight / n);
        }
      }
      let pnl = 0;
      for (const s of input.series) {
        const before = book.weights.get(s.asset) ?? 0;
        const after = target.get(s.asset) ?? 0;
        const fee = Math.abs(after - before) * book.equity * s.takerFeeRate;
        book.feesUsd += fee;
        pnl -= fee;
        if (after === 0 || !tradable.includes(s)) continue;
        pnl += after * book.equity * (s.closes.get(day + DAY_MS)! / s.closes.get(day)! - 1);
        const paid = s.funding.filter((f) => f.atMs > day && f.atMs <= day + DAY_MS).reduce((sum, f) => sum + f.rate, 0) * after * book.equity;
        book.fundingUsd += paid;
        pnl -= paid;
      }
      book.weights = target;
      book.equity += pnl;
      book.curve.push({ at: new Date(day + DAY_MS).toISOString(), equityUsd: book.equity });
    }
  }
  return books.map((book) => {
    let peak = book.curve[0].equityUsd, maxDrawdownPercent = 0;
    for (const point of book.curve) {
      peak = Math.max(peak, point.equityUsd);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - point.equityUsd) / peak) * 100);
    }
    return {
      name: book.name, curve: book.curve, feesUsd: book.feesUsd, fundingUsd: book.fundingUsd, maxDrawdownPercent,
      returnPercent: (book.equity / input.capitalUsd - 1) * 100,
    };
  });
}

/** Forward-only evidence for the trend shadow: days after registration, through the same gate as the XSEC shadow. */
export function trendForwardEvidence(trend: BaselineResult) {
  return evaluateShadowEvidence(trend.curve.filter((point) => Date.parse(point.at) >= TREND_REGISTERED_AT_MS));
}

/** Daily closes (closed days only) and funding since fromMs for one symbol. */
export async function loadDailySeries(input: { asset: string; symbol: string; takerFeeRate: number; fromMs: number; nowMs: number }, options: BybitRequestOptions = {}): Promise<DailySeries> {
  const closes = new Map<number, number>();
  let end = input.nowMs;
  for (let page = 0; page < 5; page++) {
    const { result } = await bybitPublicGet<{ list?: string[][] }>(
      `/v5/market/kline?category=linear&symbol=${encodeURIComponent(input.symbol)}&interval=D&start=${input.fromMs}&end=${end}&limit=1000`, options);
    const rows = result.list ?? [];
    for (const row of rows) {
      const start = Number(row[0]);
      // Only closed days: the bar starting today is still forming.
      if (start + DAY_MS <= input.nowMs) closes.set(start, Number(row[4]));
    }
    if (rows.length < 1000) break;
    end = Math.min(...rows.map((row) => Number(row[0]))) - 1;
  }
  const funding: DailySeries["funding"] = [];
  let fundingEnd = input.nowMs;
  for (let page = 0; page < 20; page++) {
    const { result } = await bybitPublicGet<{ list?: Array<{ fundingRate?: string; fundingRateTimestamp?: string }> }>(
      `/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(input.symbol)}&startTime=${input.fromMs}&endTime=${fundingEnd}&limit=200`, options);
    const rows = (result.list ?? []).map((row) => ({ atMs: Number(row.fundingRateTimestamp), rate: Number(row.fundingRate) }))
      .filter((row) => Number.isFinite(row.atMs) && Number.isFinite(row.rate));
    funding.push(...rows);
    if (rows.length < 200) break;
    fundingEnd = Math.min(...rows.map((row) => row.atMs)) - 1;
  }
  return { asset: input.asset, closes, funding, takerFeeRate: input.takerFeeRate };
}
