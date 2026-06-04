// ================================================================
// Feed Health Layer — Autonomous AI Data Quality Scoring
// Evaluates whether market data is safe for autonomous decision-making.
// ================================================================

import type { Candle, Timeframe, FeedHealthReport, FeedHealthStatus, DataSource } from '@/lib/types';
import { TIMEFRAME_MS } from '@/lib/types';
import { SUPPORTED_ASSETS } from '@/lib/market';

interface FeedHealthInput {
  asset: string;
  timeframe: Timeframe;
  candles: Candle[];
  primarySource: DataSource;
  fallbackUsed: boolean;
  cacheAgeSeconds: number;
  sourceAgreementScore: number;
  apiFailureStreak: number;
}

/**
 * Scores the health of a data feed.
 *
 * Scoring starts at 100 and subtracts penalties for:
 *   -20 stale data (latest candle older than 2x expected interval)
 *   -15 fallback source used
 *   -20 large source price disagreement (agreement < 0.95)
 *   -10 per 5% missing candles (max -30)
 *   -5  per 5% zero-volume candles when volume expected (max -15)
 *   -5  per abnormal range candle (high/low range > 5x median range)
 *   -20 API failure streak >= 3
 *   -5  duplicate timestamps detected
 */
export function scoreFeedHealth(input: FeedHealthInput): FeedHealthReport {
  const { asset, timeframe, candles, primarySource, fallbackUsed, cacheAgeSeconds, sourceAgreementScore, apiFailureStreak } = input;

  const warnings: string[] = [];
  let score = 100;

  // ── Staleness detection ──────────────────────────────────────
  const intervalMs = TIMEFRAME_MS[timeframe] || 3_600_000;
  const nowMs = Date.now();
  const latestCandleTime = candles.length > 0 ? candles[candles.length - 1].time * 1000 : 0;
  const candleAge = nowMs - latestCandleTime;
  const config = SUPPORTED_ASSETS[asset];
  const isCrypto = config?.category === 'crypto';
  const ageMultiplier = isCrypto ? 2.5 : 8.0;
  const stale = candles.length > 0 && candleAge > intervalMs * ageMultiplier;

  if (stale) {
    score -= 20;
    warnings.push(`Latest candle is stale (${Math.round(candleAge / 60_000)}min old, expected fresh within ${Math.round(intervalMs * ageMultiplier / 60_000)}min)`);
  }

  // ── Fallback source ──────────────────────────────────────────
  if (fallbackUsed) {
    score -= 15;
    warnings.push(`Primary source failed, using fallback source: ${primarySource}`);
  }

  // ── Source agreement ─────────────────────────────────────────
  if (sourceAgreementScore < 0.95) {
    const penalty = sourceAgreementScore < 0.90 ? 20 : 10;
    score -= penalty;
    warnings.push(`Source price disagreement detected (agreement: ${(sourceAgreementScore * 100).toFixed(1)}%)`);
  }

  // ── Missing candles ──────────────────────────────────────────
  const { missing, duplicates, zeroVolume, abnormalRange } = analyzeCandles(candles, intervalMs);

  if (missing > 0) {
    const missingPct = (missing / Math.max(candles.length, 1)) * 100;
    const penalty = Math.min(30, Math.floor(missingPct / 5) * 10);
    score -= penalty;
    warnings.push(`${missing} missing candle gap(s) detected`);
  }

  // ── Duplicate timestamps ─────────────────────────────────────
  if (duplicates > 0) {
    score -= 5;
    warnings.push(`${duplicates} duplicate candle timestamp(s) found`);
  }

  // ── Zero-volume anomalies ────────────────────────────────────
  if (zeroVolume > 0) {
    const zvPct = (zeroVolume / Math.max(candles.length, 1)) * 100;
    const penalty = Math.min(15, Math.floor(zvPct / 5) * 5);
    score -= penalty;
    warnings.push(`${zeroVolume} candle(s) with zero volume`);
  }

  // ── Abnormal range candles ───────────────────────────────────
  if (abnormalRange > 0) {
    score -= Math.min(15, abnormalRange * 5);
    warnings.push(`${abnormalRange} candle(s) with abnormally large high-low range`);
  }

  // ── API failure streak ───────────────────────────────────────
  if (apiFailureStreak >= 3) {
    score -= 20;
    warnings.push(`API failure streak: ${apiFailureStreak} consecutive failures`);
  } else if (apiFailureStreak >= 1) {
    score -= 5;
    warnings.push(`Recent API failure (streak: ${apiFailureStreak})`);
  }

  // ── Clamp and classify ───────────────────────────────────────
  score = Math.max(0, Math.min(100, score));

  let status: FeedHealthStatus;
  if (score >= 80) {
    status = 'GOOD';
  } else if (score >= 50) {
    status = 'DEGRADED';
  } else {
    status = 'BAD';
  }

  return {
    asset,
    timeframe,
    status,
    score,
    stale,
    missingCandles: missing,
    duplicateCandles: duplicates,
    zeroVolumeCandles: zeroVolume,
    abnormalRangeCandles: abnormalRange,
    sourceAgreementScore,
    primarySource,
    fallbackUsed,
    cacheAgeSeconds,
    apiFailureStreak,
    lastUpdated: new Date().toISOString(),
    warnings,
  };
}

// ── Internal candle analysis helpers ─────────────────────────────

function analyzeCandles(candles: Candle[], intervalMs: number): {
  missing: number;
  duplicates: number;
  zeroVolume: number;
  abnormalRange: number;
} {
  if (candles.length < 2) {
    return { missing: 0, duplicates: 0, zeroVolume: 0, abnormalRange: 0 };
  }

  let missing = 0;
  let duplicates = 0;
  let zeroVolume = 0;
  let abnormalRange = 0;

  const intervalSec = intervalMs / 1000;
  const tolerance = intervalSec * 1.5; // Allow 50% tolerance for gap detection

  // Compute median range for abnormal-range detection
  const ranges = candles.map(c => Math.abs(c.high - c.low)).filter(r => r > 0);
  ranges.sort((a, b) => a - b);
  const medianRange = ranges.length > 0 ? ranges[Math.floor(ranges.length / 2)] : 0;

  const seen = new Set<number>();

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Duplicate check
    if (seen.has(c.time)) {
      duplicates++;
    }
    seen.add(c.time);

    // Zero volume
    if (c.volume === 0) {
      zeroVolume++;
    }

    // Abnormal range (> 5x median)
    if (medianRange > 0) {
      const range = Math.abs(c.high - c.low);
      if (range > medianRange * 5) {
        abnormalRange++;
      }
    }

    // Gap detection (compare with previous candle)
    if (i > 0) {
      const gap = c.time - candles[i - 1].time;
      if (gap > tolerance) {
        // Count how many candles are missing in this gap
        missing += Math.max(0, Math.floor(gap / intervalSec) - 1);
      }
    }
  }

  return { missing, duplicates, zeroVolume, abnormalRange };
}
