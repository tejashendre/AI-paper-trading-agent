import type { Candle } from '@/lib/types';
import type { MarketPriceSnapshot } from '@/lib/market';
import type { ConfiguredAsset } from '@/lib/trading/instrumentRegistry';
import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import { ATR, EMA } from '@/lib/indicators';
import { QUOTE_MAX_AGE_MS, validateExitQuote } from '@/lib/trading/entryEligibility';
import { createHash } from 'node:crypto';
import { EVENT_WINDOW_MS, strategySessionAllowed, validateCalendar } from './calendar';

export type CalendarRelease = 'FED' | 'US_CPI' | 'US_PAYROLLS' | 'ECB' | 'BOE' | 'BOJ' | 'EIA_WPSR';
export interface CalendarSource {
  release: CalendarRelease;
  source: string;
  timezone: string;
  retrievedAtMs: number;
  coverageStartMs: number;
  coverageEndMs: number;
}
export interface CalendarEvent {
  id: string;
  release: CalendarRelease;
  source: string;
  timezone: string;
  date: string;
  timeMs: number | null;
  timeUncertain: boolean;
  confirmedPastAtMs?: number;
}
export interface CalendarManifest {
  version: 'v6-calendar-1';
  retrievedAtMs: number;
  expiresAtMs: number;
  coverageStartMs: number;
  coverageEndMs: number;
  sources: CalendarSource[];
  events: CalendarEvent[];
}
export interface BrainSnapshot {
  asset: ConfiguredAsset;
  nowMs: number;
  h4: readonly Candle[];
  d1: readonly Candle[];
  quote: MarketPriceSnapshot | null;
  calendar: CalendarManifest | null;
  /**
   * Actual snapshot receipt/capture clocks. Runtime must supply these.
   * Omitted clocks support pure research fixtures only: engine output then
   * models close-time availability and cannot certify activation evidence.
   */
  h4AvailableAtMs?: number;
  d1AvailableAtMs?: number;
}
export interface BrainParameters {
  h4FastEma: number;
  h4SlowEma: number;
  slopeBars: number;
  returnFastBars: number;
  returnSlowBars: number;
  adverseExtremeBars: number;
  atrPeriod: number;
  rangeMaxAtr: number;
  shockMaxPriorAtr: number;
  dailyWarmup: number;
  h4Warmup: number;
  dailyFastEma: number;
  dailySlowEma: number;
  channelBars: number;
  minStopAtr: number;
  maxStopAtr: number;
  stopBufferAtr: number;
  targetR: number;
  trailActivationR: number;
  trailAtr: number;
  maxHoldMs: number;
  setupTtlMs: number;
  entryDriftAtr: number;
  eventWindowMs: number;
}
export interface BrainDefinition {
  asset: ConfiguredAsset;
  strategyId: string;
  configHash: string;
  version: 'v6';
  riskBucket: 'crypto' | 'fx' | 'metals' | 'oil';
  parameters: BrainParameters;
  emaSeed: 'SMA_FIRST_PERIOD';
  atrMethod: 'WILDER_14';
}
export interface BrainPositionPolicy {
  version: 'v6';
  strategyId: string;
  configHash: string;
  initialAtr: number;
  priceRDistance: number;
  targetR: number;
  trailActivationR: number;
  trailAtr: number;
  maxHoldMs: number;
}
export interface SwingSetup {
  id: string;
  asset: ConfiguredAsset;
  strategyId: string;
  configHash: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  referencePrice: number;
  stopLoss: number;
  takeProfit: number;
  atr: number;
  priceRDistance: number;
  featureStartMs: number;
  featureCutoffMs: number;
  setupBarMs: number;
  expiresAtMs: number;
  channel: { current: number; previous: number } | null;
  policy: BrainPositionPolicy;
}
export type BrainNoTradeCode = 'WARMING_UP' | 'INVALID_DATA' | 'STALE_SETUP' | 'QUOTE' | 'SESSION' | 'CALENDAR' | 'NO_SIGNAL' | 'STOP_GEOMETRY' | 'PRICE_DRIFT' | 'SHOCK';
export type BrainDecision = { status: 'SETUP'; setup: SwingSetup } | { status: 'NO_TRADE'; code: BrainNoTradeCode; reason: string };
export interface BrainExitDecision {
  action: 'HOLD' | 'EXIT';
  reason: 'STOP' | 'TARGET' | 'TIME' | 'TRAILING' | 'INVALID_INPUT' | null;
  stopLoss: number;
  watermark: number;
}
export interface BrainExitInput {
  policy: BrainPositionPolicy;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  currentPrice: number;
  openedAtMs: number;
  nowMs: number;
  watermark: number;
}

const DAY = 86_400_000;
const H4 = 14_400_000;

export function brainDefinition(asset: ConfiguredAsset): BrainDefinition {
  getConfiguredInstrument(asset);
  const fx = asset === 'EURUSD' || asset === 'GBPUSD' || asset === 'USDJPY';
  const metals = asset === 'GOLD' || asset === 'SILVER';
  const oil = asset === 'OIL';
  const parameters: BrainParameters = {
    h4FastEma: fx || metals ? 20 : 0, h4SlowEma: fx ? 50 : 0, slopeBars: 5,
    returnFastBars: !fx && !metals && !oil ? 20 : 0, returnSlowBars: !fx && !metals && !oil ? 60 : 0,
    adverseExtremeBars: 5, atrPeriod: 14, rangeMaxAtr: fx ? 6 : 0, shockMaxPriorAtr: oil ? 3 : 0,
    dailyWarmup: fx ? 0 : metals ? 181 : 151,
    h4Warmup: fx ? 151 : metals ? 61 : oil ? 32 : 22,
    dailyFastEma: metals || oil ? 20 : 0, dailySlowEma: metals ? 60 : fx ? 0 : 50,
    channelBars: fx ? 12 : oil ? 30 : metals ? 0 : 20,
    minStopAtr: oil ? 2.5 : 2, maxStopAtr: oil ? 5 : 4, stopBufferAtr: metals || oil ? .2 : .1,
    targetR: fx ? 2.5 : 3, trailActivationR: 2, trailAtr: oil ? 2.5 : 2,
    maxHoldMs: (fx ? 5 : oil ? 7 : 10) * DAY,
    setupTtlMs: 300_000, entryDriftAtr: .25, eventWindowMs: EVENT_WINDOW_MS,
  };
  const definition = {
    asset, strategyId: fx ? 'FX_SESSION_BREAKOUT_V1' : metals ? 'METALS_TREND_RECLAIM_V1' : oil ? 'OIL_TREND_EXPANSION_V1' : 'CRYPTO_TREND_BREAKOUT_V1',
    version: 'v6' as const, riskBucket: fx ? 'fx' as const : metals ? 'metals' as const : oil ? 'oil' as const : 'crypto' as const,
    parameters, emaSeed: 'SMA_FIRST_PERIOD' as const, atrMethod: 'WILDER_14' as const,
  };
  return { ...definition, configHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex') };
}

function noTrade(code: BrainNoTradeCode, reason: string): BrainDecision {
  return { status: 'NO_TRADE', code, reason };
}

function barProblem(bars: readonly Candle[], intervalMs: number, nowMs: number): boolean {
  return bars.some((b, i) => {
    const timeMs = b.time * 1000;
    return ![b.time, b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
      timeMs < 0 || timeMs % intervalMs !== 0 || timeMs + intervalMs > nowMs ||
      b.low <= 0 || b.volume < 0 || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close) ||
      (i > 0 && timeMs - bars[i - 1].time * 1000 !== intervalMs);
  });
}

function regime(input: BrainSnapshot, def: BrainDefinition): 'LONG' | 'SHORT' | null {
  const p = def.parameters;
  const daily = input.d1.map(b => b.close);
  const h4 = input.h4.map(b => b.close);
  if (def.riskBucket === 'fx') {
    const fast = EMA(h4, p.h4FastEma), slow = EMA(h4, p.h4SlowEma);
    const n = h4.length - 1;
    if (fast[n] > slow[n] && slow[n] > slow[n - p.slopeBars] && h4[n] > fast[n]) return 'LONG';
    if (fast[n] < slow[n] && slow[n] < slow[n - p.slopeBars] && h4[n] < fast[n]) return 'SHORT';
    return null;
  }
  const n = daily.length - 1;
  const slow = EMA(daily, p.dailySlowEma);
  if (def.riskBucket === 'crypto') {
    if (daily[n] > slow[n] && daily[n] > daily[n - p.returnFastBars] && daily[n] > daily[n - p.returnSlowBars]) return 'LONG';
    if (daily[n] < slow[n] && daily[n] < daily[n - p.returnFastBars] && daily[n] < daily[n - p.returnSlowBars]) return 'SHORT';
    return null;
  }
  const fast = EMA(daily, p.dailyFastEma);
  if (def.riskBucket === 'metals') {
    if (fast[n] > slow[n] && daily[n] > fast[n] && slow[n] > slow[n - p.slopeBars]) return 'LONG';
    if (fast[n] < slow[n] && daily[n] < fast[n] && slow[n] < slow[n - p.slopeBars]) return 'SHORT';
  } else {
    if (daily[n] > slow[n] && fast[n] > slow[n] && slow[n] > slow[n - p.slopeBars]) return 'LONG';
    if (daily[n] < slow[n] && fast[n] < slow[n] && slow[n] < slow[n - p.slopeBars]) return 'SHORT';
  }
  return null;
}

/**
 * Pure closed-feature evaluation, not a certificate of observed availability.
 * Runtime requires actual capture clocks; historical fixtures without them
 * are modeled-at-close and cannot feed activation evidence. Cost, metadata,
 * depth and evidence admission remain separate binding gates.
 */
export function evaluateBrain(input: BrainSnapshot): BrainDecision {
  const { asset, nowMs, h4, d1, quote } = input;
  const def = brainDefinition(asset), p = def.parameters;
  if (!Number.isFinite(nowMs) || barProblem(h4, H4, nowMs) || barProblem(d1, DAY, nowMs)) return noTrade('INVALID_DATA', 'Bars must be finite, closed, UTC-aligned, unique and contiguous');
  for (const [bars, available, interval] of [[h4, input.h4AvailableAtMs, H4], [d1, input.d1AvailableAtMs, DAY]] as const) {
    if (available !== undefined && (!Number.isFinite(available) || available > nowMs || (bars.length > 0 && available < bars[bars.length - 1].time * 1000 + interval))) return noTrade('INVALID_DATA', 'Feature capture time precedes completion or exceeds decision time');
  }
  if (h4.length < p.h4Warmup || d1.length < p.dailyWarmup) return noTrade('WARMING_UP', 'Native completed feature history is insufficient');
  const n = h4.length - 1, signal = h4[n], prev = h4[n - 1];
  const cutoff = signal.time * 1000 + H4;
  if (nowMs >= cutoff + p.setupTtlMs) return noTrade('STALE_SETUP', 'Completed setup bar expired');
  if (p.dailyWarmup > 0 && d1[d1.length - 1].time * 1000 + DAY !== Math.floor(nowMs / DAY) * DAY) return noTrade('INVALID_DATA', 'Most recent completed UTC daily bar is missing');
  if (!strategySessionAllowed(asset, nowMs)) return noTrade('SESSION', 'Outside approved underlying liquid entry hours');
  const calendar = validateCalendar({ asset, manifest: input.calendar, nowMs });
  if (!calendar.allowed) return noTrade('CALENDAR', calendar.reason);
  const quoteCheck = validateExitQuote({ instrument: getConfiguredInstrument(asset), quote, nowMs });
  if (!quote || !quoteCheck.valid) return noTrade('QUOTE', quoteCheck.reasons.join('; '));
  const times = [quote.eventTimeMs, quote.receivedAtMs, quote.quoteTimes.lastPriceMs, quote.quoteTimes.bidAskMs, quote.quoteTimes.markMs];
  if (times.some(t => t === null || !Number.isFinite(t) || t > nowMs || t > quote.receivedAtMs || nowMs - t > QUOTE_MAX_AGE_MS) ||
      !(Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid! > 0 && quote.ask! > quote.bid!) ||
      !(Number.isFinite(quote.markPrice) && quote.markPrice! > 0 && Number.isFinite(quote.indexPrice) && quote.indexPrice! > 0)) return noTrade('QUOTE', 'Bid/ask, mark/index or actual component clocks are unavailable, future or stale');
  const direction = regime(input, def);
  if (!direction) return noTrade('NO_SIGNAL', 'Directional regime is absent');
  const sign = direction === 'LONG' ? 1 : -1;
  const atrs = ATR([...h4], p.atrPeriod), atr = atrs[n];
  if (!(Number.isFinite(atr) && atr > 0)) return noTrade('INVALID_DATA', 'Wilder ATR is unavailable');
  let channel: SwingSetup['channel'] = null;
  if (def.riskBucket === 'metals') {
    const ema = EMA(h4.map(b => b.close), p.h4FastEma);
    if (!(sign * (prev.close - ema[n - 1]) <= 0 && sign * (signal.close - ema[n]) > 0 && sign * (signal.close - prev.close) > 0)) return noTrade('NO_SIGNAL', 'No fresh closed-bar EMA reclaim');
  } else {
    const channelAt = (end: number) => {
      const bars = h4.slice(end - p.channelBars, end);
      return direction === 'LONG' ? Math.max(...bars.map(b => b.high)) : Math.min(...bars.map(b => b.low));
    };
    channel = { current: channelAt(n), previous: channelAt(n - 1) };
    if (!(sign * (signal.close - channel.current) > 0 && sign * (prev.close - channel.previous) <= 0)) return noTrade('NO_SIGNAL', 'No fresh prior-channel crossing');
    if (def.riskBucket === 'fx') {
      const bars = h4.slice(n - p.channelBars, n);
      if (Math.max(...bars.map(b => b.high)) - Math.min(...bars.map(b => b.low)) > p.rangeMaxAtr * atr) return noTrade('NO_SIGNAL', 'Prior FX range exceeds approved ATR limit');
    }
    if (def.riskBucket === 'oil') {
      const tr = Math.max(signal.high - signal.low, Math.abs(signal.high - prev.close), Math.abs(signal.low - prev.close));
      if (tr > p.shockMaxPriorAtr * atrs[n - 1]) return noTrade('SHOCK', 'Signal true range exceeds three prior known ATR');
    }
  }
  const entryPrice = direction === 'LONG' ? quote.ask! : quote.bid!;
  if (Math.abs(entryPrice - signal.close) > p.entryDriftAtr * atr) return noTrade('PRICE_DRIFT', 'Executable quote drift exceeds signal ATR allowance');
  const adverse = h4.slice(n - p.adverseExtremeBars, n);
  const extreme = direction === 'LONG' ? Math.min(...adverse.map(b => b.low)) : Math.max(...adverse.map(b => b.high));
  const stopLoss = direction === 'LONG' ? Math.min(entryPrice - p.minStopAtr * atr, extreme - p.stopBufferAtr * atr) : Math.max(entryPrice + p.minStopAtr * atr, extreme + p.stopBufferAtr * atr);
  const priceRDistance = sign * (entryPrice - stopLoss);
  if (!(stopLoss > 0 && priceRDistance > 0 && priceRDistance <= p.maxStopAtr * atr)) return noTrade('STOP_GEOMETRY', 'Structural stop exceeds approved distance or was crossed');
  const takeProfit = entryPrice + sign * p.targetR * priceRDistance;
  if (!(takeProfit > 0 && Number.isFinite(takeProfit))) return noTrade('STOP_GEOMETRY', 'Target is not a valid positive price');
  const policy: BrainPositionPolicy = { version: 'v6', strategyId: def.strategyId, configHash: def.configHash, initialAtr: atr, priceRDistance, targetR: p.targetR, trailActivationR: p.trailActivationR, trailAtr: p.trailAtr, maxHoldMs: p.maxHoldMs };
  const id = createHash('sha256').update(JSON.stringify([asset, def.strategyId, def.configHash, direction, cutoff])).digest('hex');
  return { status: 'SETUP', setup: { id, asset, strategyId: def.strategyId, configHash: def.configHash, direction, entryPrice, referencePrice: signal.close, stopLoss, takeProfit, atr, priceRDistance, featureStartMs: Math.min(h4[0].time * 1000, ...(p.dailyWarmup > 0 ? [d1[0].time * 1000] : [])), featureCutoffMs: cutoff, setupBarMs: signal.time * 1000, expiresAtMs: cutoff + p.setupTtlMs, channel, policy } };
}

export function decideBrainExit(input: BrainExitInput): BrainExitDecision {
  const { policy: p, direction, entryPrice, currentPrice, openedAtMs, nowMs } = input;
  let { stopLoss, watermark } = input;
  const done = (reason: BrainExitDecision['reason'], action: 'HOLD' | 'EXIT' = 'EXIT'): BrainExitDecision => ({ action, reason, stopLoss, watermark });
  if (p.version !== 'v6' || ![p.initialAtr, p.priceRDistance, p.targetR, p.trailActivationR, p.trailAtr, p.maxHoldMs, entryPrice, currentPrice, stopLoss, watermark].every(v => Number.isFinite(v) && v > 0) ||
      ![openedAtMs, nowMs].every(Number.isFinite) || nowMs < openedAtMs || (direction !== 'LONG' && direction !== 'SHORT')) return done('INVALID_INPUT', 'HOLD');
  const sign = direction === 'LONG' ? 1 : -1;
  watermark = direction === 'LONG' ? Math.max(watermark, entryPrice, currentPrice) : Math.min(watermark, entryPrice, currentPrice);
  const trailed = sign * (input.stopLoss - (entryPrice - sign * p.priceRDistance)) > 1e-10;
  if (sign * (currentPrice - stopLoss) <= 0) return done(trailed ? 'TRAILING' : 'STOP');
  if (sign * (currentPrice - entryPrice) >= p.targetR * p.priceRDistance) return done('TARGET');
  if (nowMs - openedAtMs >= p.maxHoldMs) return done('TIME');
  if (sign * (watermark - entryPrice) >= p.trailActivationR * p.priceRDistance) {
    const proposed = watermark - sign * p.trailAtr * p.initialAtr;
    stopLoss = direction === 'LONG' ? Math.max(stopLoss, proposed) : Math.min(stopLoss, proposed);
    if (sign * (currentPrice - stopLoss) <= 0) return done('TRAILING');
  }
  return done(null, 'HOLD');
}
