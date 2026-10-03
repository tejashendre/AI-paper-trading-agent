import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePortfolioRiskBudget, LOSS_STREAK_COOL_OFF_HOURS } from "@/lib/trading/portfolioRiskBudget";
import { autonomousPositionIdentity } from "@/lib/trading/assetSpecs";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import type { OpenPosition, Portfolio, Trade } from "@/lib/types";

const NOW = new Date("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;

function fullStop(asset: string, hoursAgo: number): Trade {
  const at = new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
  return {
    id: `${asset}-${hoursAgo}`, timestamp: at, exitTime: at, asset, action: "SELL", amount: 1, btcAmount: 1, price: 1,
    usdValue: 100, stopLoss: 0, takeProfit: 0, signalScore: 0, exitReason: "STOP_LOSS", pnl: -5, maxLossUsd: 5,
  } as Trade;
}

function book(open: OpenPosition[] = []): Portfolio {
  return {
    usd: 10_000, btc: 0, balances: {}, openPositions: Object.fromEntries(open.map((p) => [p.asset, p])), openPosition: null,
    peakValue: 10_000, initialCapital: 10_000, totalTrades: 4, winningTrades: 0, losingTrades: 4, totalPnl: -20,
    grossProfit: 0, grossLoss: 20, consecutiveWins: 0, consecutiveLosses: 4, maxConsecutiveWins: 0,
    maxConsecutiveLosses: 4, maxDrawdown: 0, maxDrawdownPercent: 0, returns: [], lastUpdated: NOW.toISOString(),
  };
}

const candidate = { asset: "OIL", direction: "LONG" as const, candidateNotionalUsd: 500, candidateMaxLossUsd: 5, candidateEntryCostUsd: 0.1, now: NOW };
// The production state on 2026-10-03: four small full stops in a row, the newest on 2026-10-02.
const streak = (newestHoursAgo: number) => [fullStop("GOLD", newestHoursAgo), fullStop("SOL", newestHoursAgo + 94), fullStop("BTC", newestHoursAgo + 227), fullStop("ETH", newestHoursAgo + 228)];

test("a loss streak cools off and then admits one probation position, instead of locking forever", async (t) => {
  await t.test("inside the cool-off the streak still blocks every entry", () => {
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book(), trades: streak(LOSS_STREAK_COOL_OFF_HOURS - 1) });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /loss streak/i);
    assert.match(decision.reason, /cool-off/i);
  });

  await t.test("after the cool-off a flat book may open one probation position", () => {
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book(), trades: streak(LOSS_STREAK_COOL_OFF_HOURS + 1) });
    assert.equal(decision.approved, true, decision.reason);
    assert.equal(decision.diagnostics.lossStreakProbation, true);
    assert.match(decision.reason, /probation/i);
  });

  await t.test("probation allows only one open position at a time", () => {
    const open: OpenPosition = {
      asset: "GOLD", direction: "LONG", amount: 0.01, btcAmount: 0.01, entryPrice: 4000, usdInvested: 40, stopLoss: 3900, takeProfit: 4200,
      entryTime: NOW.toISOString(), signalScore: 70, reasoning: "fixture", strategyType: "swing", maxLossUsd: 5,
      ...autonomousPositionIdentity({ instrument: getConfiguredInstrument("GOLD"), initialRiskUsdt: 5, costModelVersion: "c" }),
    };
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book([open]), trades: streak(LOSS_STREAK_COOL_OFF_HOURS + 1) });
    assert.equal(decision.approved, false);
    assert.match(decision.reason, /probation/i);
  });

  await t.test("a cluster streak follows the same cool-off and probation rule", () => {
    const crypto = [fullStop("SOL", 1), fullStop("BTC", 2), fullStop("ETH", 3)];
    const btc = { ...candidate, asset: "BTC", portfolio: book() };
    assert.equal(evaluatePortfolioRiskBudget({ ...btc, trades: crypto }).approved, false);
    const cooled = crypto.map((trade, i) => fullStop(trade.asset, LOSS_STREAK_COOL_OFF_HOURS + 1 + i));
    const decision = evaluatePortfolioRiskBudget({ ...btc, trades: cooled });
    assert.equal(decision.approved, true, decision.reason);
    assert.equal(decision.diagnostics.lossStreakProbation, true);
  });

  await t.test("without a streak nothing changes", () => {
    const decision = evaluatePortfolioRiskBudget({ ...candidate, portfolio: book(), trades: [] });
    assert.equal(decision.approved, true);
    assert.equal(decision.diagnostics.lossStreakProbation, false);
  });
});
