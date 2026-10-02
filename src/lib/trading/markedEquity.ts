import type { Portfolio } from '@/lib/types';
import { calculateInstrumentPnl, instrumentFee, positionInstrument } from './assetSpecs';

/** Cash already includes entry fees and booked funding. Do not subtract them twice. */
export function markedEquity(portfolio: Portfolio): number {
  let equity = portfolio.usd;
  for (const pos of [...Object.values(portfolio.openPositions ?? {}), ...Object.values(portfolio.scalpPositions ?? {})]) {
    if (!pos) continue;
    equity += pos.usdInvested;
    const price = pos.lastMarkPrice;
    // Old snapshots remain readable at cost until the watchdog marks them.
    // The daemon refuses new risk while any held position is unmarked/stale.
    if (!Number.isFinite(price) || !(price! > 0)) continue;
    const instrument = positionInstrument(pos);
    equity += calculateInstrumentPnl({ instrument, entryPrice: pos.entryPrice, exitPrice: price!, quantity: pos.amount, direction: pos.direction })
      - instrumentFee(instrument, pos.amount, price!);
  }
  return Math.max(0, equity);
}

export function riskMarksReady(portfolio: Portfolio, nowMs = Date.now()): boolean {
  return [...Object.values(portfolio.openPositions ?? {}), ...Object.values(portfolio.scalpPositions ?? {})].every(pos => {
    if (!pos) return true;
    const age = nowMs - Date.parse(pos.lastMarkAt ?? '');
    return Number.isFinite(pos.lastMarkPrice) && pos.lastMarkPrice! > 0 && age >= 0 && age <= 60000;
  });
}

export function updateMarkedRiskStats(portfolio: Portfolio): boolean {
  const equity = markedEquity(portfolio);
  if (!Number.isFinite(equity)) return false;
  const oldPeak = portfolio.peakValue, oldDrawdown = portfolio.maxDrawdownPercent;
  portfolio.peakValue = Math.max(portfolio.peakValue || portfolio.initialCapital || equity, equity);
  const drawdown = portfolio.peakValue > 0 ? Math.max(0, (portfolio.peakValue - equity) / portfolio.peakValue * 100) : 0;
  portfolio.maxDrawdownPercent = Math.max(portfolio.maxDrawdownPercent || 0, drawdown);
  return oldPeak !== portfolio.peakValue || oldDrawdown !== portfolio.maxDrawdownPercent;
}
