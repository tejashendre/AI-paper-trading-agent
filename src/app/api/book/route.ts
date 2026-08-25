import { NextResponse } from "next/server";
import { getRedis } from "@/lib/redis";
import { fetchTickers } from "@/lib/data/perpUniverse";
import {
  bookEquityUsd,
  getBookTrades,
  loadBookPortfolio,
} from "@/lib/execution/bookRebalancer";
import { DEFAULT_STRATEGY, DEFAULT_UNIVERSE } from "@/lib/strategy/crossSectionalMomentum";

export const dynamic = "force-dynamic";

/**
 * Read-only view of the cross-sectional book.
 *
 * Deliberately safe for the public spectator view: it exposes positions,
 * exposure and realised performance, which are the things that let someone
 * judge whether the strategy is working, and nothing that would let them
 * act on the live ranking before the bot does.
 */
export async function GET() {
  try {
    const [portfolio, prices, trades, lastRebalance, equitySnapshot] = await Promise.all([
      loadBookPortfolio(),
      fetchTickers().catch(() => new Map()),
      getBookTrades(40).catch(() => []),
      getRedis().get<any>("xsec:lastRebalance").catch(() => null),
      getRedis().get<any>("xsec:equity").catch(() => null),
    ]);

    const positions = Object.values(portfolio.positions).map((position) => {
      const mark = prices.get(position.symbol)?.markPrice ?? position.entryPrice;
      const unrealizedUsd = position.quantity * (mark - position.entryPrice);
      const notionalUsd = Math.abs(position.quantity) * mark;
      return {
        symbol: position.symbol,
        side: position.quantity > 0 ? "LONG" : "SHORT",
        quantity: position.quantity,
        entryPrice: position.entryPrice,
        markPrice: mark,
        notionalUsd,
        unrealizedUsd,
        unrealizedPercent: notionalUsd > 0 ? (unrealizedUsd / notionalUsd) * 100 : 0,
        weight: position.weight,
        openedAt: position.openedAt,
        feesPaidUsd: position.feesPaidUsd,
        fundingPaidUsd: position.fundingPaidUsd,
      };
    }).sort((a, b) => b.unrealizedUsd - a.unrealizedUsd);

    const equity = bookEquityUsd(portfolio, prices);
    const grossNotional = positions.reduce((sum, p) => sum + p.notionalUsd, 0);
    const netNotional = positions.reduce((sum, p) => sum + (p.side === "LONG" ? p.notionalUsd : -p.notionalUsd), 0);

    return NextResponse.json({
      strategy: {
        name: "Cross-Sectional Momentum",
        version: portfolio.strategyVersion,
        lookbackHours: DEFAULT_STRATEGY.lookbackHours,
        holdHours: DEFAULT_STRATEGY.holdHours,
        bookSize: DEFAULT_STRATEGY.bookSize,
        rankBuffer: DEFAULT_STRATEGY.rankBuffer,
        universeCap: DEFAULT_UNIVERSE.maxSymbols,
        minTurnover24hUsd: DEFAULT_UNIVERSE.minTurnover24hUsd,
      },
      performance: {
        equityUsd: equity,
        cashUsd: portfolio.cashUsd,
        initialCapitalUsd: portfolio.initialCapitalUsd,
        totalReturnUsd: equity - portfolio.initialCapitalUsd,
        totalReturnPercent: portfolio.initialCapitalUsd > 0
          ? ((equity - portfolio.initialCapitalUsd) / portfolio.initialCapitalUsd) * 100
          : 0,
        realizedPnlUsd: portfolio.realizedPnlUsd,
        unrealizedPnlUsd: positions.reduce((sum, p) => sum + p.unrealizedUsd, 0),
        feesPaidUsd: portfolio.feesPaidUsd,
        fundingPaidUsd: portfolio.fundingPaidUsd,
        executionCostsUsd: portfolio.executionCostsUsd,
        maxDrawdownPercent: portfolio.maxDrawdownPercent,
        peakEquityUsd: portfolio.peakEquityUsd,
        totalRebalances: portfolio.totalRebalances,
        totalFills: portfolio.totalFills,
      },
      exposure: {
        openPositions: positions.length,
        longs: positions.filter((p) => p.side === "LONG").length,
        shorts: positions.filter((p) => p.side === "SHORT").length,
        grossNotionalUsd: grossNotional,
        netNotionalUsd: netNotional,
        grossExposure: equity > 0 ? grossNotional / equity : 0,
        // A dollar-neutral book should sit near zero here. A drift away from
        // zero means one side filled and the other did not.
        netExposure: equity > 0 ? netNotional / equity : 0,
      },
      positions,
      recentTrades: trades,
      lastRebalance,
      liveSnapshot: equitySnapshot,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read cross-sectional book" },
      { status: 500 }
    );
  }
}
