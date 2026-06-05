import { NextResponse } from "next/server";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { MarketService } from "@/lib/market";
import { TradeLedger } from "@/lib/memory/tradeLedger";
import { verifyAuth } from "@/lib/auth";
import { calculatePnlUsd } from "@/lib/trading/assetSpecs";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    try {
        const authResult = verifyAuth(request);
        if (!authResult.authorized) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        
        const isSpectator = authResult.source === "spectator";

        const redis = getRedis();

        const [userPortfolio, userTrades, aiPortfolio, aiTrades, logs, swingScan, lastExitSweep] = await Promise.all([
            PortfolioManager.getPortfolio("user"),
            PortfolioManager.getTrades("user"),
            PortfolioManager.getPortfolio("ai"),
            PortfolioManager.getTrades("ai"),
            Logger.getLogs(),
            redis.get("swing:lastScan:ai"),
            redis.get("swing:lastExitSweep:ai"),
        ]);

        const calculateTrueValue = async (portfolio: any, type: "user" | "ai") => {
            let totalValue = portfolio.usd;
            const openAssets = Object.keys(portfolio.openPositions || {});
            const scalpAssets = Object.keys(portfolio.scalpPositions || {});
            const allActiveAssets = Array.from(new Set([...openAssets, ...scalpAssets]));
            const prices: Record<string, number> = {};
            for (const asset of allActiveAssets) {
                try {
                    const price = await MarketService.getCurrentPrice(asset);
                    prices[asset] = price;
                    
                    const calculatePosValue = (pos: any, currentPrice: number) => {
                        if (!pos) return 0;
                        const pnl = calculatePnlUsd(asset, pos.entryPrice, currentPrice, pos.amount, pos.direction);
                        return pos.usdInvested + pnl;
                    };

                    if (portfolio.openPositions?.[asset]) {
                        totalValue += calculatePosValue(portfolio.openPositions[asset], price);
                    }
                    if (portfolio.scalpPositions?.[asset]) {
                        totalValue += calculatePosValue(portfolio.scalpPositions[asset], price);
                    }
                } catch (err) {
                    console.error(`Error getting current price for ${asset} during sync:`, err);
                    if (portfolio.openPositions?.[asset]) totalValue += portfolio.openPositions[asset].usdInvested;
                    if (portfolio.scalpPositions?.[asset]) totalValue += portfolio.scalpPositions[asset].usdInvested;
                }
            }

            // Recalculate and update peakValue and drawdown dynamically to ensure synchronization
            let updated = false;
            if (!portfolio.peakValue || totalValue > portfolio.peakValue) {
                portfolio.peakValue = totalValue;
                updated = true;
            }
            const currentDrawdown = (portfolio.peakValue - totalValue) / portfolio.peakValue;
            const currentDrawdownPercent = currentDrawdown * 100;
            if (portfolio.maxDrawdownPercent === undefined || portfolio.maxDrawdownPercent === null || currentDrawdownPercent > portfolio.maxDrawdownPercent) {
                portfolio.maxDrawdownPercent = currentDrawdownPercent;
                updated = true;
            }
            if (updated) {
                try {
                    await PortfolioManager.updatePortfolio(portfolio, type);
                } catch (e) {
                    console.warn(`[Status API] Failed to update synchronized peakValue/drawdown for ${type}:`, e);
                }
            }

            return { totalValue, prices };
        };

        const [userSync, aiSync] = await Promise.all([
            calculateTrueValue(userPortfolio, "user"),
            calculateTrueValue(aiPortfolio, "ai")
        ]);

        // Fetch BTC price as a baseline indicator price for dashboard header compatibility
        let btcPrice = 0;
        try {
            btcPrice = userSync.prices["BTC"] || aiSync.prices["BTC"] || await MarketService.getCurrentPrice("BTC");
        } catch {
            btcPrice = 0;
        }

        const calculateProfitByAsset = (trades: any[], portfolio: any, prices: any) => {
            const profitByAsset: Record<string, { realized: number; unrealized: number; total: number }> = {};
            const SUPPORTED_ASSETS_KEYS = ["BTC", "ETH", "SOL", "EURUSD", "GBPUSD", "USDJPY", "GOLD", "OIL", "SILVER"];
            
            for (const asset of SUPPORTED_ASSETS_KEYS) {
                profitByAsset[asset] = { realized: 0, unrealized: 0, total: 0 };
            }

            // Realized profits
            for (const trade of trades) {
                if (trade.asset && trade.pnl !== undefined) {
                    if (!profitByAsset[trade.asset]) {
                        profitByAsset[trade.asset] = { realized: 0, unrealized: 0, total: 0 };
                    }
                    profitByAsset[trade.asset].realized += trade.pnl;
                }
            }

            // Unrealized profits
            const openAssets = Object.keys(portfolio.openPositions || {});
            const scalpAssets = Object.keys(portfolio.scalpPositions || {});
            const allActiveAssets = Array.from(new Set([...openAssets, ...scalpAssets]));
            
            for (const asset of allActiveAssets) {
                if (!profitByAsset[asset]) {
                    profitByAsset[asset] = { realized: 0, unrealized: 0, total: 0 };
                }
                
                const calculateUnrealized = (pos: any) => {
                    if (!pos) return 0;
                    const currentPrice = prices[asset] || pos.entryPrice;
                    return calculatePnlUsd(asset, pos.entryPrice, currentPrice, pos.amount, pos.direction);
                };

                const openUnrealized = calculateUnrealized(portfolio.openPositions?.[asset]);
                const scalpUnrealized = calculateUnrealized(portfolio.scalpPositions?.[asset]);
                
                profitByAsset[asset].unrealized += (openUnrealized + scalpUnrealized);
            }

            // Sum up totals
            for (const asset of Object.keys(profitByAsset)) {
                profitByAsset[asset].total = profitByAsset[asset].realized + profitByAsset[asset].unrealized;
            }

            return profitByAsset;
        };

        const userProfitByAsset = calculateProfitByAsset(userTrades, userPortfolio, userSync.prices);
        const aiProfitByAsset = calculateProfitByAsset(aiTrades, aiPortfolio, aiSync.prices);

        // Fetch AI Brain Intelligence Data (non-blocking, failures return nulls)
        let aiReflection = null;
        let aiScalpReflection = null;
        let aiRecentJournal: any[] = [];

        // Calculate detailed stats by type
        const calculateStatsByType = (trades: any[]) => {
            const stats = {
                scalp: { trades: 0, wins: 0, pnl: 0 },
                swing: { trades: 0, wins: 0, pnl: 0 }
            };
            
            trades.forEach(t => {
                const isScalp = t.action.startsWith("SCALP_");
                const typeStr = isScalp ? 'scalp' : 'swing';
                
                if (t.pnl !== undefined) {
                    stats[typeStr].trades++;
                    stats[typeStr].pnl += t.pnl;
                    if (t.pnl > 0) stats[typeStr].wins++;
                }
            });
            return stats;
        };

        const aiDetailedStats = calculateStatsByType(aiTrades);

        // Only fetch sensitive AI logs/journals if NOT a spectator
        if (!isSpectator) {
            try {
                const [journal] = await Promise.all([
                    TradeLedger.getRecentTrades(5),
                ]);
                aiReflection = null;
                aiScalpReflection = null;
                aiRecentJournal = journal;
            } catch (e) {
                console.error("Error fetching AI intelligence data:", e);
            }
        }

        return NextResponse.json({
            // User (Human) Data
            portfolio: userPortfolio,
            userPortfolio: userPortfolio,
            userTrades: isSpectator ? userTrades.slice(0, 100) : userTrades, // Keep restored history visible while bounded
            userTotalValue: userSync.totalValue,
            userProfitByAsset,

            // AI Data
            aiPortfolio: aiPortfolio,
            aiTrades: isSpectator ? aiTrades.slice(0, 100) : aiTrades, // Keep restored history visible while bounded
            aiTotalValue: aiSync.totalValue,
            aiProfitByAsset,
            aiDetailedStats,

            // AI Brain Intelligence (Sanitized)
            aiReflection: isSpectator ? null : aiReflection,
            aiScalpReflection: isSpectator ? null : aiScalpReflection,
            aiRecentJournal: isSpectator ? [] : aiRecentJournal,

            // Shared
            btcPrice,
            totalValue: userSync.totalValue,
            profitByAsset: userProfitByAsset,
            swingScan,
            lastExitSweep,
            logs: isSpectator ? logs.slice(0, 20) : logs // Limit logs for spectators
        });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
