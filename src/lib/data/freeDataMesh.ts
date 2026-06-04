// ================================================================
// Free Data Mesh — Unified Market Data with Health & Sentiment
// The AI's primary sensory layer. Wraps existing MarketService
// and enriches it with feed health, source agreement, and sentiment.
// ================================================================

import type { Timeframe, FreeMarketFrame, DataSource } from '@/lib/types';
import { MarketService, SUPPORTED_ASSETS } from '@/lib/market';
import { getRedis } from '@/lib/redis';
import { scoreFeedHealth } from './feedHealth';
import { checkSourceAgreement } from './sourceAgreement';
import { getSentiment } from './sentiment';

const FAILURE_STREAK_KEY_PREFIX = 'mesh:fail_streak:';

/**
 * Builds a complete FreeMarketFrame for a given asset and timeframe.
 *
 * This is the AI's primary data input. It:
 * 1. Fetches candles via MarketService (Kraken → Yahoo → CoinGecko fallback chain)
 * 2. Fetches current price
 * 3. Checks source agreement (Kraken vs CoinGecko for crypto)
 * 4. Scores feed health (staleness, missing candles, anomalies)
 * 5. Optionally attaches crypto sentiment (Fear & Greed Index)
 *
 * Never throws — returns a degraded frame with warnings if data is unavailable.
 */
export async function buildMarketFrame(
  assetKey: string,
  timeframe: Timeframe,
  limit: number = 200,
  includeSentiment: boolean = true
): Promise<FreeMarketFrame | null> {
  const config = SUPPORTED_ASSETS[assetKey];
  if (!config) {
    console.error(`[FreeDataMesh] Unknown asset: ${assetKey}`);
    return null;
  }

  const redis = getRedis();
  const failKey = `${FAILURE_STREAK_KEY_PREFIX}${assetKey}:${timeframe}`;
  const warnings: string[] = [];

  // ── 1. Fetch candles ─────────────────────────────────────────
  let candles = [];
  let primarySource: DataSource = 'CACHE';
  let fallbackUsed = false;
  let cacheAgeSeconds = 0;

  try {
    candles = await MarketService.getCandles(timeframe, limit, assetKey);

    // Determine source heuristically:
    // If the asset has a Kraken pair, Kraken was likely primary
    if (config.krakenPair) {
      primarySource = 'KRAKEN';
    } else {
      primarySource = 'YAHOO';
    }

    // Reset failure streak on success
    await redis.set(failKey, 0, { ex: 3600 });
  } catch (err) {
    warnings.push(`Failed to fetch candles for ${assetKey}/${timeframe}: ${err}`);

    // Increment failure streak
    try {
      const current = await redis.get<number>(failKey) || 0;
      await redis.set(failKey, current + 1, { ex: 3600 });
    } catch {}

    // Cannot build a frame without candles
    return null;
  }

  // ── 2. Fetch current price ───────────────────────────────────
  let currentPrice = 0;
  try {
    currentPrice = await MarketService.getCurrentPrice(assetKey);
  } catch {
    // Fall back to latest candle close
    if (candles.length > 0) {
      currentPrice = candles[candles.length - 1].close;
      warnings.push('Using latest candle close as current price (live price fetch failed)');
    } else {
      warnings.push('No current price available');
      return null;
    }
  }

  // ── 3. Check source agreement (crypto only) ──────────────────
  let sourceAgreementScore = 1.0;
  try {
    const agreement = await checkSourceAgreement(assetKey);
    sourceAgreementScore = agreement.score;

    if (agreement.warnings.length > 0) {
      warnings.push(...agreement.warnings);
    }

    // If primary source was actually a fallback, mark it
    if (agreement.sourcesChecked.length > 0 && !agreement.sourcesChecked.includes('KRAKEN') && config.krakenPair) {
      fallbackUsed = true;
      primarySource = 'YAHOO';
    }
  } catch {
    // Source agreement is supplementary; don't fail the frame
    warnings.push('Source agreement check failed, assuming 1.0');
  }

  // ── 4. Get failure streak ────────────────────────────────────
  let apiFailureStreak = 0;
  try {
    apiFailureStreak = (await redis.get<number>(failKey)) || 0;
  } catch {}

  // ── 5. Calculate cache age ───────────────────────────────────
  if (candles.length > 0) {
    const latestTime = candles[candles.length - 1].time * 1000;
    cacheAgeSeconds = Math.round((Date.now() - latestTime) / 1000);
  }

  // ── 6. Score feed health ─────────────────────────────────────
  const feedHealth = scoreFeedHealth({
    asset: assetKey,
    timeframe,
    candles,
    primarySource,
    fallbackUsed,
    cacheAgeSeconds,
    sourceAgreementScore,
    apiFailureStreak,
  });

  // Merge feed health warnings into frame warnings
  warnings.push(...feedHealth.warnings);

  // ── 7. Fetch sentiment (crypto only, optional) ───────────────
  let sentiment = undefined;
  let openInterest = undefined;
  let fundingRate = undefined;
  
  if (config.category === 'crypto') {
    try {
      const sensors = await MarketService.getDeepSensors(assetKey);
      openInterest = sensors.openInterest;
      fundingRate = sensors.fundingRate;
    } catch {}
    
    if (includeSentiment) {
      try {
        sentiment = await getSentiment() ?? undefined;
      } catch {
        // Sentiment is supplementary; don't fail the frame
      }
    }
  }

  // ── 8. Detect staleness from feed health ─────────────────────
  const stale = feedHealth.stale;

  return {
    asset: assetKey,
    category: config.category,
    timeframe,
    candles,
    currentPrice,
    openInterest,
    fundingRate,
    primarySource,
    fallbackUsed,
    cacheAgeSeconds,
    stale,
    sourceAgreementScore,
    feedHealth,
    warnings,
    sentiment,
  };
}

/**
 * Builds FreeMarketFrames for all supported assets at a given timeframe.
 * Useful for the autonomous cycle's asset scanning phase.
 *
 * Returns a map of assetKey → FreeMarketFrame (or null if data unavailable).
 */
export async function buildAllMarketFrames(
  timeframe: Timeframe,
  limit: number = 200,
  includeSentiment: boolean = true
): Promise<Record<string, FreeMarketFrame | null>> {
  const assets = Object.keys(SUPPORTED_ASSETS);
  const results: Record<string, FreeMarketFrame | null> = {};

  // Fetch in parallel for speed
  const promises = assets.map(async (assetKey) => {
    const frame = await buildMarketFrame(assetKey, timeframe, limit, includeSentiment);
    results[assetKey] = frame;
  });

  await Promise.all(promises);
  return results;
}

/**
 * Quick health check: returns true if the asset's data is safe for trading.
 */
export function isDataSafeForTrading(frame: FreeMarketFrame | null): boolean {
  if (!frame) return false;
  if (frame.feedHealth.status === 'BAD') return false;
  if (frame.stale) return false;
  if (frame.currentPrice <= 0) return false;
  if (frame.candles.length < 10) return false;
  return true;
}
