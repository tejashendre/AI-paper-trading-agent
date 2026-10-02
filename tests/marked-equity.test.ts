import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PortfolioGuards } from '@/lib/trading/portfolioGuards';
import { TradeAdmissionController } from '@/lib/trading/tradeAdmission';
import { evaluatePortfolioRiskBudget } from '@/lib/trading/portfolioRiskBudget';
import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import type { Portfolio } from '@/lib/types';

function portfolio(mark: number): Portfolio {
  return { usd: 9000, btc: 0, balances: {}, openPosition: null,
    openPositions: { BTC: { asset: 'BTC', direction: 'LONG', amount: 0.1, btcAmount: 0.1,
      entryPrice: 100000, usdInvested: 1000, stopLoss: 70000, takeProfit: 120000,
      entryTime: new Date().toISOString(), signalScore: 20, reasoning: 'fixture', strategyType: 'swing',
      instrument: getConfiguredInstrument('BTC'), lastMarkPrice: mark, lastMarkAt: new Date().toISOString() } },
    peakValue: 10000, initialCapital: 10000, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    totalPnl: 0, grossProfit: 0, grossLoss: 0, consecutiveWins: 0, consecutiveLosses: 0,
    maxConsecutiveWins: 0, maxConsecutiveLosses: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
    returns: [], lastUpdated: new Date().toISOString() } as Portfolio;
}
test('unrealized loss moves exposure guards into recovery', () => {
  const decision = PortfolioGuards.evaluateNewSwing({ portfolio: portfolio(80000), asset: 'OIL', direction: 'LONG', dataQuality: 100, finalConviction: 85 });
  assert.equal(decision.mode, 'RECOVERY');
});
test('an open loss triggers the unchanged hard drawdown breaker', () => {
  const decision = evaluatePortfolioRiskBudget({ portfolio: portfolio(80000), trades: [], asset: 'OIL', direction: 'LONG', candidateNotionalUsd: 100, candidateMaxLossUsd: 1, candidateEntryCostUsd: 0 });
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /drawdown circuit breaker/);
  assert.ok(decision.diagnostics.currentDrawdownPercent >= 20);
});
test('drawdown admission reduces approved risk before losses are realized', () => {
  const input = { asset: 'OIL', direction: 'LONG' as const, entryPrice: 80, stopLoss: 78, takeProfit: 86,
    signalScore: 20, finalConviction: 80, reasoning: 'fixture', strategyType: 'swing' as const, dataQuality: 100 };
  const flat = TradeAdmissionController.evaluate({ ...input, portfolio: portfolio(100000) });
  const losing = TradeAdmissionController.evaluate({ ...input, portfolio: portfolio(80000) });
  assert.ok(flat.approved && losing.approved, `${flat.reason}; ${losing.reason}`);
  assert.ok(losing.riskAmountUsd < flat.riskAmountUsd / 3);
});
