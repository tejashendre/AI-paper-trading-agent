// ================================================================
// Sentiment — Free Crypto Market Sentiment via Alternative.me
// Provides the Fear & Greed Index as a SentimentSnapshot.
// ================================================================

import type { SentimentSnapshot } from '@/lib/types';
import { getRedis } from '@/lib/redis';

const FEAR_GREED_API = 'https://api.alternative.me/fng/?limit=1';
const CACHE_KEY = 'cache:sentiment:fear_greed';
const CACHE_TTL = 3600; // 1 hour — the index updates once daily

/**
 * Fetches the current Crypto Fear & Greed Index.
 *
 * The Alternative.me API is free, public, and updates once per day.
 * We cache it for 1 hour to avoid unnecessary API calls.
 *
 * Returns null (instead of throwing) if the API is unavailable —
 * sentiment is supplementary, not critical for trading decisions.
 */
export async function getSentiment(): Promise<SentimentSnapshot | null> {
  const redis = getRedis();

  // ── Check cache first ────────────────────────────────────────
  try {
    const cached = await redis.get<string>(CACHE_KEY);
    if (cached) {
      const parsed: SentimentSnapshot = typeof cached === 'string' ? JSON.parse(cached) : cached;
      // Update cache age before returning
      const cachedTime = new Date(parsed.timestamp).getTime();
      parsed.cacheAgeSeconds = Math.round((Date.now() - cachedTime) / 1000);
      return parsed;
    }
  } catch {}

  // ── Fetch from Alternative.me ────────────────────────────────
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(FEAR_GREED_API, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) {
      console.warn(`Fear & Greed API returned HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const entry = data?.data?.[0];

    if (!entry || entry.value === undefined) {
      console.warn('Fear & Greed API returned unexpected format');
      return null;
    }

    const index = parseInt(entry.value, 10);
    const label = entry.value_classification || classifyFearGreed(index);

    const snapshot: SentimentSnapshot = {
      fearGreedIndex: index,
      fearGreedLabel: label,
      timestamp: new Date().toISOString(),
      source: 'alternative.me',
      cacheAgeSeconds: 0,
    };

    // Cache for 1 hour
    await redis.set(CACHE_KEY, JSON.stringify(snapshot), { ex: CACHE_TTL });

    return snapshot;
  } catch (err) {
    console.warn('Failed to fetch Fear & Greed Index:', err);
    return null;
  }
}

/**
 * Fallback classification if the API doesn't provide one.
 */
function classifyFearGreed(index: number): string {
  if (index <= 10) return 'Extreme Fear';
  if (index <= 25) return 'Fear';
  if (index <= 45) return 'Neutral';
  if (index <= 55) return 'Neutral';
  if (index <= 75) return 'Greed';
  return 'Extreme Greed';
}
