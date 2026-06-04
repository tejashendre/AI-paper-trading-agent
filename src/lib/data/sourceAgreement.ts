// ================================================================
// Source Agreement — Cross-Source Price Comparison
// Detects price divergence between independent data sources.
// ================================================================

import { MarketService, SUPPORTED_ASSETS } from '@/lib/market';
import { getRedis } from '@/lib/redis';

interface SourcePrice {
  source: string;
  price: number;
  success: boolean;
}

interface AgreementResult {
  score: number;               // 0-1 (1 = perfect agreement)
  primaryPrice: number;
  secondaryPrice: number | null;
  priceDivergencePercent: number;
  sourcesChecked: string[];
  warnings: string[];
}

/**
 * Compares the current price of an asset across independent sources.
 *
 * For crypto assets: compares Kraken ticker vs CoinGecko spot.
 * For forex/commodities: only Yahoo is available, so agreement defaults to 1.0.
 *
 * Returns a score from 0 to 1:
 *   1.00        = prices match exactly or only one source available
 *   0.95 - 0.99 = minor divergence (< 0.5%)
 *   0.90 - 0.94 = moderate divergence (0.5% - 1.0%)
 *   < 0.90      = significant divergence (> 1.0%)
 */
export async function checkSourceAgreement(assetKey: string): Promise<AgreementResult> {
  const config = SUPPORTED_ASSETS[assetKey];
  if (!config) {
    return {
      score: 0.5,
      primaryPrice: 0,
      secondaryPrice: null,
      priceDivergencePercent: 0,
      sourcesChecked: [],
      warnings: [`Unknown asset: ${assetKey}`],
    };
  }

  // Non-crypto assets only have Yahoo — no cross-source comparison possible
  if (config.category !== 'crypto') {
    try {
      const price = await MarketService.getCurrentPrice(assetKey);
      return {
        score: 1.0,
        primaryPrice: price,
        secondaryPrice: null,
        priceDivergencePercent: 0,
        sourcesChecked: ['YAHOO'],
        warnings: [],
      };
    } catch {
      return {
        score: 0.5,
        primaryPrice: 0,
        secondaryPrice: null,
        priceDivergencePercent: 0,
        sourcesChecked: [],
        warnings: [`Failed to fetch any price for ${assetKey}`],
      };
    }
  }

  // ── Crypto: compare Kraken vs CoinGecko ────────────────────
  const prices: SourcePrice[] = [];

  // Kraken
  if (config.krakenPair) {
    try {
      const price = await fetchKrakenSpot(config.krakenPair);
      prices.push({ source: 'KRAKEN', price, success: true });
    } catch {
      prices.push({ source: 'KRAKEN', price: 0, success: false });
    }
  }

  // CoinGecko
  if (config.coingeckoId) {
    try {
      const price = await fetchCoinGeckoSpot(config.coingeckoId);
      prices.push({ source: 'COINGECKO', price, success: true });
    } catch {
      prices.push({ source: 'COINGECKO', price: 0, success: false });
    }
  }

  const successes = prices.filter(p => p.success);
  const sourcesChecked = successes.map(p => p.source);
  const warnings: string[] = [];

  if (successes.length === 0) {
    return {
      score: 0,
      primaryPrice: 0,
      secondaryPrice: null,
      priceDivergencePercent: 0,
      sourcesChecked: prices.map(p => p.source),
      warnings: ['All price sources failed'],
    };
  }

  if (successes.length === 1) {
    return {
      score: 1.0,
      primaryPrice: successes[0].price,
      secondaryPrice: null,
      priceDivergencePercent: 0,
      sourcesChecked,
      warnings: [`Only ${successes[0].source} returned a valid price`],
    };
  }

  // Two sources available — compare
  const p1 = successes[0].price;
  const p2 = successes[1].price;
  const mid = (p1 + p2) / 2;
  const divergence = mid > 0 ? Math.abs(p1 - p2) / mid : 0;
  const divergencePercent = divergence * 100;

  // Score: linearly degrade from 1.0 to 0 as divergence goes from 0% to 2%
  const score = Math.max(0, Math.min(1, 1 - (divergence / 0.02)));

  if (divergencePercent > 1.0) {
    warnings.push(`Significant price divergence: ${divergencePercent.toFixed(2)}% between ${successes[0].source} ($${p1.toFixed(2)}) and ${successes[1].source} ($${p2.toFixed(2)})`);
  } else if (divergencePercent > 0.5) {
    warnings.push(`Moderate price divergence: ${divergencePercent.toFixed(2)}% between sources`);
  }

  return {
    score,
    primaryPrice: p1,
    secondaryPrice: p2,
    priceDivergencePercent: divergencePercent,
    sourcesChecked,
    warnings,
  };
}

// ── Direct source fetchers (bypass MarketService cache) ──────────

async function fetchKrakenSpot(pair: string): Promise<number> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);

  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, {
    signal: controller.signal,
  });
  clearTimeout(id);

  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const data = await res.json();
  if (data.error?.length) throw new Error(data.error[0]);

  const pairKey = Object.keys(data.result)[0];
  const price = parseFloat(data.result[pairKey].c[0]);
  if (isNaN(price)) throw new Error('Kraken returned NaN price');
  return price;
}

async function fetchCoinGeckoSpot(coingeckoId: string): Promise<number> {
  const redis = getRedis();
  const cacheKey = `cache:cg_agreement:${coingeckoId}`;

  // CoinGecko free tier is heavily rate-limited; cache aggressively
  try {
    const cached = await redis.get<number>(cacheKey);
    if (cached && !isNaN(cached)) return cached;
  } catch {}

  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 5000);

  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`,
    { signal: controller.signal }
  );
  clearTimeout(id);

  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  const price = data[coingeckoId]?.usd;
  if (!price || isNaN(price)) throw new Error('CoinGecko returned invalid price');

  // Cache for 2 minutes to avoid rate limits
  await redis.set(cacheKey, price, { ex: 120 });
  return price;
}
