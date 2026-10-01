// ================================================================
// Transport consistency for the single venue every asset trades on.
//
// Bybit's WebSocket stream and REST API are two transports from one venue,
// so comparing them can catch a stale or broken stream but can never confirm
// a price independently. This module therefore reports transport consistency
// and states `independentVenues: 1`; it does not fabricate multi-venue
// agreement, and it compares last price with last price only (mark, index,
// bid and ask legitimately differ from last and are not compared).
// ================================================================

import { MarketPriceSnapshot, MarketService, SUPPORTED_ASSETS } from '@/lib/market';

export interface AgreementResult {
  score: number;               // 0-1; 1 = transports agree or only one is available
  primaryPrice: number;
  secondaryPrice: number | null;
  priceDivergencePercent: number;
  sourcesChecked: string[];
  independentVenues: 0 | 1;
  policy: 'SINGLE_VENUE_TRANSPORT_CONSISTENCY';
  warnings: string[];
}

const POLICY = 'SINGLE_VENUE_TRANSPORT_CONSISTENCY' as const;

export async function checkSourceAgreement(assetKey: string): Promise<AgreementResult> {
  if (!SUPPORTED_ASSETS[assetKey]) {
    return {
      score: 0.5, primaryPrice: 0, secondaryPrice: null, priceDivergencePercent: 0,
      sourcesChecked: [], independentVenues: 0, policy: POLICY, warnings: [`Unknown asset: ${assetKey}`],
    };
  }

  const [streamed, rest] = await Promise.all([
    MarketService.getCurrentPriceSnapshot(assetKey, { transport: 'WS' }).catch(() => null),
    MarketService.getCurrentPriceSnapshot(assetKey, { transport: 'REST' }).catch(() => null),
  ]);
  const checked = [streamed, rest].filter((quote): quote is MarketPriceSnapshot => quote !== null);
  const sourcesChecked = checked.map((quote) => `BYBIT_LINEAR_${quote.transport}`);

  if (!streamed && !rest) {
    return {
      score: 0, primaryPrice: 0, secondaryPrice: null, priceDivergencePercent: 0,
      sourcesChecked, independentVenues: 1, policy: POLICY, warnings: ['Bybit stream and REST quotes are both unavailable'],
    };
  }
  if (!streamed || !rest) {
    const only = (streamed ?? rest)!;
    return {
      score: 1, primaryPrice: only.price, secondaryPrice: null, priceDivergencePercent: 0,
      sourcesChecked, independentVenues: 1, policy: POLICY,
      warnings: [streamed ? 'Bybit REST quote unavailable; stream consistency unchecked' : 'Bybit stream quote not fresh; serving REST, stream consistency unchecked'],
    };
  }

  const mid = (streamed.price + rest.price) / 2;
  const divergence = mid > 0 ? Math.abs(streamed.price - rest.price) / mid : 0;
  const divergencePercent = divergence * 100;
  const warnings: string[] = [];
  if (divergencePercent > 0.5) {
    warnings.push(`Bybit stream and REST last prices differ by ${divergencePercent.toFixed(2)}%; the stream may be stale`);
  }
  return {
    score: Math.max(0, Math.min(1, 1 - divergence / 0.02)),
    primaryPrice: streamed.price,
    secondaryPrice: rest.price,
    priceDivergencePercent: divergencePercent,
    sourcesChecked,
    independentVenues: 1,
    policy: POLICY,
    warnings,
  };
}
