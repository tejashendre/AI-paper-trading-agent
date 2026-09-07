// ================================================================
// Feed Health Layer — Autonomous AI Data Quality Scoring
// Evaluates whether market data is safe for autonomous decision-making.
// ================================================================

import type { Candle, Timeframe, FeedHealthReport, FeedHealthStatus, DataSource } from '@/lib/types';
import { TIMEFRAME_MS } from '@/lib/types';
import { SUPPORTED_ASSETS } from '@/lib/market';
import { isWeekdayMarketOpen } from '@/lib/trading/marketSession';

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
 *   -10 per 5% missing candles, counting only bars the market was open for (max -30)
 *   -5  per 5% zero-volume candles, only when the venue reports volume at all (max -15)
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
  // Follows the instrument, not the asset class: a commodity quoted from a
  // perpetual trades continuously and is held to the continuous standard.
  const continuous = Boolean(config?.bybitLinearSymbol);
  const ageMultiplier = continuous ? 2.5 : 8.0;
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
  const { missing, duplicates, zeroVolume, abnormalRange, venueReportsVolume } =
    analyzeCandles(candles, intervalMs, continuous);

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
  // Only meaningful when the venue publishes volume for this instrument at all.
  // Yahoo reports no volume for spot FX, so every bar reads zero forever; before
  // this check that cost a permanent 15 points and pushed USDJPY under the
  // threshold that disables autonomous entries. A feed that reports volume and
  // then drops it on some bars is still a genuine anomaly and still penalised.
  if (zeroVolume > 0 && venueReportsVolume) {
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

function analyzeCandles(candles: Candle[], intervalMs: number, expectsContinuousTrading: boolean): {
  missing: number;
  duplicates: number;
  zeroVolume: number;
  abnormalRange: number;
  /** Whether this venue publishes volume for this instrument at all. */
  venueReportsVolume: boolean;
} {
  if (candles.length < 2) {
    return { missing: 0, duplicates: 0, zeroVolume: 0, abnormalRange: 0, venueReportsVolume: false };
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
        const absent = Math.max(0, Math.floor(gap / intervalSec) - 1);
        missing += expectsContinuousTrading
          ? absent
          : absentWhileOpen(candles[i - 1].time, absent, intervalSec);
      }
    }
  }

  return {
    missing,
    duplicates,
    zeroVolume,
    abnormalRange,
    venueReportsVolume: zeroVolume < candles.length,
  };
}

/**
 * How many of the absent bars fall in hours the market was actually open.
 *
 * Forex and futures shut every weekend, so on a 15-minute series a normal
 * weekend is roughly 200 absent bars. Counting those as missing data made
 * every non-crypto feed look broken and cost the full 30-point gap penalty
 * permanently, which is most of the distance between a healthy score and the
 * one that disables trading. A gap during an open session is still real data
 * loss and is still counted.
 */
function absentWhileOpen(lastSeenSec: number, absent: number, intervalSec: number): number {
  // Long gaps are almost always closures; sampling caps the work while staying
  // accurate enough, since the penalty saturates well before this many bars.
  const inspect = Math.min(absent, 512);
  let open = 0;
  for (let step = 1; step <= inspect; step++) {
    if (isWeekdayMarketOpen(new Date((lastSeenSec + step * intervalSec) * 1000))) open++;
  }
  // Scale back up if the gap was longer than the sample.
  return absent > inspect ? Math.round((open / inspect) * absent) : open;
}
