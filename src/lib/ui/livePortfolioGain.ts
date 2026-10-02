/** Browser-safe coefficients from the server's frozen position and exit-cost model. */
export interface PositionValuation {
  asset: string; priceAtSync: number; entryPrice: number; quantity: number; short: boolean;
  legacyJPY: boolean; baseAdverseBps: number; sizeAdverseBps: number; exitFeeRate: number;
  carryCost: number; netPnlAtSync: number;
}

export function displayNetPnl(mark: PositionValuation, price: number): number {
  const adverseBps = mark.baseAdverseBps + mark.sizeAdverseBps *
    Math.sqrt(mark.legacyJPY ? 1 : price / mark.priceAtSync);
  const fillPrice = price * (1 + (mark.short ? 1 : -1) * adverseBps / 10000);
  const gross = (mark.short ? mark.entryPrice - fillPrice : fillPrice - mark.entryPrice) *
    mark.quantity / (mark.legacyJPY ? fillPrice : 1);
  const exitFee = mark.quantity * (mark.legacyJPY ? 1 : fillPrice) * mark.exitFeeRate;
  return gross - exitFee - mark.carryCost;
}

/** Rebase on each server snapshot so booked fees, funding and completed trades are never counted twice. */
export function livePortfolioGain(totalAtSync: number | null | undefined, initialCapital: number | undefined,
  valuations: PositionValuation[] | null | undefined, quotes: Record<string, any> | null, nowMs = Date.now()) {
  const empty = { totalValue: null, gain: null, live: false };
  if (typeof totalAtSync !== 'number' || !Number.isFinite(totalAtSync) ||
    typeof initialCapital !== 'number' || !Number.isFinite(initialCapital) || initialCapital <= 0) return empty;
  const anchored = { totalValue: totalAtSync, gain: totalAtSync - initialCapital, live: false };
  if (!Array.isArray(valuations)) return anchored;
  let delta = 0;
  for (const mark of valuations) {
    const quote = quotes?.[mark.asset];
    const age = nowMs - Date.parse(quote?.updatedAt ?? '');
    if (!quote?.fresh || !Number.isFinite(quote.price) || quote.price <= 0 ||
      !Number.isFinite(age) || age < -2000 || age > 10000) return anchored;
    const nextNet = displayNetPnl(mark, quote.price);
    if (!Number.isFinite(nextNet) || !Number.isFinite(mark.netPnlAtSync)) return anchored;
    delta += nextNet - mark.netPnlAtSync;
  }
  return { totalValue: totalAtSync + delta, gain: totalAtSync + delta - initialCapital, live: true };
}

export function formatSignedGain(gain: number | null): string {
  if (gain === null || !Number.isFinite(gain)) return 'Loading...';
  const rounded = Math.round(Math.abs(gain) * 100) / 100;
  return `${gain < 0 && rounded > 0 ? '-' : '+'}$${rounded.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function portfolioEquityMetrics(total: number | null | undefined, initialCapital: number | undefined, margin: number) {
  const known = typeof total === 'number' && Number.isFinite(total);
  const capitalKnown = typeof initialCapital === 'number' && Number.isFinite(initialCapital) && initialCapital > 0;
  const gain = known && capitalKnown ? total - initialCapital : null;
  return { gain, returnPercent:gain !== null ? gain / initialCapital! * 100 : null,
    marginPercent:known && total > 0 && Number.isFinite(margin) && margin >= 0 ? margin / total * 100 : null };
}
