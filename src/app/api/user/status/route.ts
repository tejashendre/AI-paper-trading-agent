import { NextResponse } from "next/server";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { MarketService } from "@/lib/market";
import { TradeLedger } from "@/lib/memory/tradeLedger";
import { verifyAuth } from "@/lib/auth";
import { calculateInstrumentPnl, instrumentFee, instrumentNotional, positionInstrument } from "@/lib/trading/assetSpecs";
import { buildPositionOutcomes, summarizeCompletedPositions } from "@/lib/trading/positionOutcomes";
import { buildCoverageSnapshot, DailyFunnel, ScanDecision, VetoCode } from "@/lib/trading/coverageStatus";
import { CONFIGURED_ASSETS } from "@/lib/trading/instrumentRegistry";
import { getRedis } from "@/lib/redis";
import { OpportunityJournal } from "@/lib/trading/opportunityJournal";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { SetupPerformance } from "@/lib/trading/setupPerformance";
import { FeedHealthSummary } from "@/lib/data/feedHealthSummary";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { EXECUTION_COST_MODEL_VERSION, estimateCarryCostUsd, estimatePaperFill } from "@/lib/trading/executionCostModel";
import { PORTFOLIO_RISK_POLICY_VERSION } from "@/lib/trading/portfolioRiskBudget";
import { PAPER_MARGIN_POLICY_VERSION } from "@/lib/trading/tradeAdmission";
import { RESEARCH_HARNESS_VERSION } from "@/lib/research/walkForward";

export const dynamic = "force-dynamic";

function modeledPositionMark(asset: string, pos: any, currentPrice: number) {
    // Marked under the model frozen on the position, not today's routing.
    const instrument = positionInstrument({ ...pos, asset });
    const exit = estimatePaperFill({
        asset,
        instrument,
        action: pos.direction === "SHORT" ? "COVER" : "SELL",
        requestedPrice: currentPrice,
        amount: pos.amount,
        context: {
            reason: "MARK",
            assetMode: ["BTC", "ETH", "SOL"].includes(asset) ? "REALTIME_FAST" : "SLOW_SWING",
            dataQuality: pos.dataQuality,
            isPeakLiquidity: false,
            liquidityState: pos.liquidityState,
            orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
        },
    });
    const grossPnl = calculateInstrumentPnl({
        instrument, entryPrice: pos.entryPrice, exitPrice: exit.fillPrice, quantity: pos.amount, direction: pos.direction,
    });
    const entryFee = pos.entryFeePaid ?? instrumentFee(instrument, pos.amount, pos.entryPrice);
    // Linear positions book funding to cash at each settlement; marking it
    // again here would count it twice.
    const carryCost = instrument.economicsModel === "BYBIT_LINEAR_USDT_V1" ? 0 : estimateCarryCostUsd({
        asset,
        notionalUsd: pos.notionalUsd ?? instrumentNotional(instrument, pos.amount, pos.entryPrice),
        openedAt: pos.entryTime,
        fundingRate: pos.fundingRate,
    });
    return { grossPnl, entryFee, exitFee: exit.feeUsd, carryCost };
}

function buildLearningDigest(localLearningRules: any[], opportunitySummary: any, setupPerformance: any) {
    const boostRules = (localLearningRules || []).filter((rule) => rule.action === "BOOST");
    const reduceRules = (localLearningRules || []).filter((rule) => rule.action === "REDUCE");
    const watchOnlyRules = (localLearningRules || []).filter((rule) => rule.action === "WATCH_ONLY");
    const totalEvaluated = Number(opportunitySummary?.totalEvaluated || 0);
    const favorableRate = Number(opportunitySummary?.favorableRate || 0);
    const bestSetup = setupPerformance?.bestSetup;
    const worstSetup = setupPerformance?.worstSetup;

    let headline = "Learning is active, but still collecting enough proof.";
    if (totalEvaluated >= 20 && boostRules.length > reduceRules.length) {
        headline = "Learning is finding more helpful patterns than caution patterns.";
    } else if (totalEvaluated >= 20 && reduceRules.length > boostRules.length) {
        headline = "Learning is currently making the bot more selective.";
    } else if (totalEvaluated >= 4) {
        headline = "Learning has started comparing watched setups against later price movement.";
    }

    const plainFindings = [
        bestSetup
            ? bestSetup.promotionEligible
                ? `${bestSetup.label} has passed its later closed-trade validation sample.`
                : `${bestSetup.label} is the best observed setup so far, but has not earned a size boost.`
            : null,
        worstSetup && worstSetup.key !== bestSetup?.key ? `${worstSetup.label} still needs caution.` : null,
        boostRules[0]?.message || null,
        reduceRules[0]?.message || null,
    ].filter(Boolean);

    return {
        headline,
        totalEvaluated,
        favorableRate,
        activeRules: localLearningRules?.length || 0,
        boostCount: boostRules.length,
        cautionCount: reduceRules.length,
        watchOnlyCount: watchOnlyRules.length,
        bestSetup: bestSetup ? {
            key: bestSetup.key,
            label: bestSetup.label,
            tradeCount: bestSetup.tradeCount,
            opportunityCount: bestSetup.opportunityCount,
            favorableRate: bestSetup.opportunityFavorableRate,
            confidenceAdjustment: bestSetup.confidenceAdjustment,
            outOfSampleTradeCount: bestSetup.outOfSampleTradeCount,
            outOfSampleWinRate: bestSetup.outOfSampleWinRate,
            outOfSampleProfitFactor: bestSetup.outOfSampleProfitFactor,
            promotionEligible: bestSetup.promotionEligible,
        } : null,
        plainFindings: plainFindings.slice(0, 4),
        lastUpdated: opportunitySummary?.lastUpdated || setupPerformance?.generatedAt || null,
    };
}

function buildEquityCurveTrades(trades: any[]) {
    return (trades || [])
        .filter((trade) => trade?.timestamp && trade.pnl !== undefined && trade.pnl !== null)
        .map((trade) => ({
            timestamp: trade.timestamp,
            asset: trade.asset,
            action: trade.action,
            direction: trade.direction,
            exitReason: trade.exitReason,
            pnl: Number(trade.pnl),
        }));
}

/**
 * Position-level statistics: win rate, profit factor and expectancy count
 * completed positions, with partial exits inside their position. Realized
 * cash from every exit leg is reported separately and labeled as cash.
 */
function buildClosedTradeStats(trades: any[], initialCapital = 10_000, openPositions: any[] = []) {
    const { completed, conflicts } = buildPositionOutcomes({ trades: trades || [], openPositions });
    const summary = summarizeCompletedPositions({ outcomes: completed, trades: trades || [], initialCapital });
    return {
        source: summary.source,
        unit: "completed_position" as const,
        totalTrades: summary.completedPositions,
        winningTrades: summary.winningPositions,
        losingTrades: summary.losingPositions,
        winRate: summary.winRate,
        grossProfit: summary.grossProfit,
        grossLoss: summary.grossLoss,
        profitFactor: summary.profitFactor,
        totalPnl: summary.totalPnl,
        averageWin: summary.averageWin,
        averageLoss: summary.averageLoss,
        expectancy: summary.expectancy,
        maxDrawdown: summary.maxDrawdown,
        maxDrawdownPercent: summary.maxDrawdownPercent,
        latestClosedAt: summary.latestClosedAt,
        exitLegs: summary.exitLegs,
        realizedCashFromExitLegs: summary.realizedCashFromExitLegs,
        positionConflicts: conflicts.length,
    };
}

/**
 * One row per configured asset: data readiness, the latest decision's first
 * binding veto, and 7/30-day funnels. Funnel counts were written by the
 * daemon once per decision; reading them here never increments anything.
 */
async function buildAssetCoverage(aiTrades: any[], aiPortfolio: any, swingScan: any, feedHealthMatrix: any) {
    const redis = getRedis();
    const outcomes = buildPositionOutcomes({ trades: aiTrades || [], openPositions: Object.values(aiPortfolio?.openPositions || {}) }).completed;
    const funnels: Record<string, DailyFunnel[]> = {};
    const assets: Record<string, any> = {};
    await Promise.all(CONFIGURED_ASSETS.map(async (asset) => {
        funnels[asset] = (await redis.get<DailyFunnel[]>(`coverage:funnel:v1:${asset}`).catch(() => null)) ?? [];
        const feed = (feedHealthMatrix?.assets || []).find((row: any) => row.asset === asset);
        const result = (swingScan?.results || []).find((row: any) => row.asset === asset);
        const metadata = await MarketService.getInstrumentMetadata(asset).catch(() => null);
        const lastDecision: ScanDecision | null = result
            ? {
                decisionId: `${swingScan.startedAt}:${asset}`,
                asset,
                at: swingScan.completedAt || swingScan.startedAt,
                action: result.action,
                vetoCode: (result.vetoCode ?? null) as VetoCode | null,
                reason: result.reason,
            }
            : null;
        assets[asset] = {
            dataEligibility: feed?.dataEligibility ?? null,
            quoteEventTimeMs: feed?.dataEligibility?.quoteEventTimeMs ?? null,
            lastDecision,
            fundingIntervalMinutes: metadata?.fundingIntervalMinutes ?? null,
        };
    }));
    return buildCoverageSnapshot({ nowMs: Date.now(), assets, outcomes, trades: aiTrades || [], funnels });
}

function portfolioWithClosedStats(portfolio: any, stats: ReturnType<typeof buildClosedTradeStats>) {
    return {
        ...portfolio,
        totalTrades: stats.totalTrades,
        winningTrades: stats.winningTrades,
        losingTrades: stats.losingTrades,
        totalPnl: stats.totalPnl,
        grossProfit: stats.grossProfit,
        grossLoss: stats.grossLoss,
        maxDrawdown: stats.maxDrawdown,
        maxDrawdownPercent: stats.maxDrawdownPercent,
    };
}

function buildAssetBookDigest(input: {
    portfolio: any;
    profitByAsset: Record<string, { realized: number; unrealized: number; total: number }>;
    prices: Record<string, number>;
    swingScan: any;
    feedHealthMatrix: any;
    localLearningRules: any[];
    tradeReviewSignals: any[];
}) {
    const scanRows = new Map<string, any>(
        (input.swingScan?.results || []).map((row: any) => [row.asset, row])
    );
    const feedRows = new Map<string, any>(
        (input.feedHealthMatrix?.assets || []).map((row: any) => [row.asset, row])
    );
    const reviewSignals = new Map<string, any>(
        (input.tradeReviewSignals || []).map((signal: any) => [signal.asset, signal])
    );
    const reduceAssets = new Set(
        (input.localLearningRules || [])
            .filter((rule: any) => rule?.scope === "asset" && (rule.action === "REDUCE" || rule.action === "WATCH_ONLY"))
            .map((rule: any) => rule.key)
    );

    const books = Object.entries(SUPPORTED_ASSETS).map(([asset, config]: [string, any]) => {
        const swing = input.portfolio?.openPositions?.[asset] || null;
        const scalp = input.portfolio?.scalpPositions?.[asset] || null;
        const scan = scanRows.get(asset);
        const feed = feedRows.get(asset);
        const review = reviewSignals.get(asset);
        const pnl = input.profitByAsset?.[asset] || { realized: 0, unrealized: 0, total: 0 };
        const openPositions = [swing, scalp].filter(Boolean);
        const directions = new Set(openPositions.map((position: any) => position.direction));
        const netExposure = directions.size > 1
            ? "MIXED"
            : directions.has("LONG")
                ? "LONG"
                : directions.has("SHORT")
                    ? "SHORT"
                    : "NEUTRAL";
        const usedMargin = openPositions.reduce((sum: number, position: any) => sum + Number(position?.usdInvested || 0), 0);
        const plannedRisk = openPositions.reduce((sum: number, position: any) => {
            const risk = Number(position?.riskAmountUsd ?? position?.maxLossUsd ?? 0);
            return sum + (Number.isFinite(risk) ? Math.max(0, risk) : 0);
        }, 0);
        const thesisStatus = swing?.thesisStatus || (swing ? "MONITORING" : "NO_POSITION");
        const dataQuality = Number(feed?.score ?? scan?.dataQuality ?? swing?.dataQuality ?? 0);
        const reviewAction = review?.action || (reduceAssets.has(asset) ? "REDUCE" : "NEUTRAL");

        let state = "WATCHING";
        let headline = "Waiting for a cleaner setup.";
        let nextAction = scan?.nextStep || "Keep scanning until price, structure, data, and risk agree.";

        if (swing) {
            if (thesisStatus === "OPPOSITE_EDGE_CONFIRMED" || thesisStatus === "INVALID") {
                state = "REVERSAL_WATCH";
                headline = "Open trade is under reversal review.";
                nextAction = "Exit watchdog should tighten, close, or wait for a clearly stronger opposite setup.";
            } else if (thesisStatus === "WEAKENING") {
                state = "PROTECTING";
                headline = "Open trade is weakening; the bot should protect capital.";
                nextAction = swing.scaleInBlockedReason || "Scale-in is paused while the thesis is weakening.";
            } else {
                state = "MANAGING";
                headline = "Open trade is being managed by the exit watchdog.";
                nextAction = "Trail profit, respect stop loss, and re-check thesis health.";
            }
        } else if (feed?.status === "BAD") {
            state = "DATA_BLOCKED";
            headline = "Data is not safe enough for a new entry.";
            nextAction = "Wait for a healthier feed before trading this asset.";
        } else if (reviewAction === "REDUCE") {
            state = "CAUTION";
            headline = "Recent trade reviews say this asset needs stronger proof.";
            nextAction = review?.message || "Require stronger confirmation or smaller size.";
        } else if (scan?.action === "ENTRY") {
            state = "READY";
            headline = "A trade setup was detected in the latest scan.";
            nextAction = scan.simpleReason || scan.reason || "Risk admission decides whether the setup can be executed.";
        } else if (scan?.decisionState === "TRIGGER_PENDING") {
            state = "ALMOST_READY";
            headline = "The higher-timeframe idea exists, but the short-term trigger is not ready.";
        } else if (scan?.action === "SKIPPED") {
            state = "PAUSED";
            headline = scan.simpleReason || scan.reason || "The bot intentionally skipped this asset.";
        }

        return {
            asset,
            category: config?.category || "unknown",
            state,
            headline,
            nextAction,
            netExposure,
            openPositionCount: openPositions.length,
            swingOpen: Boolean(swing),
            scalpOpen: Boolean(scalp),
            direction: swing?.direction || scalp?.direction || null,
            thesisStatus,
            thesisReason: swing?.thesisReason || null,
            scaleInBlockedReason: swing?.scaleInBlockedReason || null,
            usedMargin,
            plannedRisk,
            realizedPnl: Number(pnl.realized || 0),
            unrealizedPnl: Number(pnl.unrealized || 0),
            totalPnl: Number(pnl.total || 0),
            livePrice: input.prices?.[asset] || null,
            dataStatus: feed?.status || "UNKNOWN",
            dataQuality,
            latestDecision: scan?.simpleStatus || scan?.decisionState || scan?.action || "NO_SCAN",
            latestReason: scan?.simpleReason || scan?.reason || null,
            learningAction: reviewAction,
            learningMessage: review?.message || null,
            layeringEnabled: false,
            layeringNote: "Layering is visibility-only for now; same-asset hedge/probe execution remains disabled until the asset-book engine is intentionally built.",
        };
    });

    const activeBooks = books.filter((book) => book.openPositionCount > 0);
    const cautionBooks = books.filter((book) => book.state === "CAUTION" || book.state === "PROTECTING" || book.state === "REVERSAL_WATCH" || book.state === "DATA_BLOCKED");
    const readyBooks = books.filter((book) => book.state === "READY" || book.state === "ALMOST_READY");
    const totalMargin = books.reduce((sum, book) => sum + book.usedMargin, 0);
    const totalPlannedRisk = books.reduce((sum, book) => sum + book.plannedRisk, 0);

    return {
        generatedAt: new Date().toISOString(),
        headline: activeBooks.length > 0
            ? `${activeBooks.length} asset book${activeBooks.length === 1 ? "" : "s"} active; exit watchdog is managing risk.`
            : "No active asset books; the bot is waiting for confirmed setups.",
        activeBooks: activeBooks.length,
        readyBooks: readyBooks.length,
        cautionBooks: cautionBooks.length,
        totalMargin,
        totalPlannedRisk,
        books,
        topWatchlist: [...activeBooks, ...readyBooks, ...cautionBooks, ...books.filter((book) => book.state === "WATCHING")].slice(0, 5),
    };
}

export async function GET(request: Request) {
    try {
        const authResult = verifyAuth(request);
        if (!authResult.authorized) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        
        const isSpectator = authResult.source === "spectator";

        const redis = getRedis();

        const [userPortfolio, userTrades, aiPortfolio, aiTrades, logs, swingScan, lastExitSweep, opportunitySummary, recentOpportunities, localLearningRules, feedHealthMatrix, tradeReviewDigest, recentTradeReviews, tradeReviewSignals] = await Promise.all([
            PortfolioManager.getPortfolio("user"),
            PortfolioManager.getTrades("user"),
            PortfolioManager.getPortfolio("ai"),
            PortfolioManager.getTrades("ai"),
            Logger.getLogs(),
            redis.get("swing:lastScan:ai"),
            redis.get("swing:lastExitSweep:ai"),
            OpportunityJournal.getSummary(),
            OpportunityJournal.getRecent(12),
            LocalLearningMemory.getRules(),
            FeedHealthSummary.build(),
            TradeReviewJournal.getDigest(),
            TradeReviewJournal.getRecent(8),
            TradeReviewJournal.getAssetSignals(),
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
                        const mark = modeledPositionMark(asset, pos, currentPrice);
                        return pos.usdInvested + mark.grossPnl - mark.exitFee - mark.carryCost;
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
                    const mark = modeledPositionMark(asset, pos, currentPrice);
                    return mark.grossPnl - mark.entryFee - mark.exitFee - mark.carryCost;
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
        const setupPerformance = SetupPerformance.build(aiTrades, opportunitySummary, {
            strategyVersion: TRADING_STRATEGY_VERSION,
        });
        const learningDigest = buildLearningDigest(localLearningRules, opportunitySummary, setupPerformance);
        const userEquityTrades = buildEquityCurveTrades(userTrades);
        const aiEquityTrades = buildEquityCurveTrades(aiTrades);
        const userClosedStats = buildClosedTradeStats(userTrades, Number(userPortfolio?.initialCapital || 10_000), Object.values(userPortfolio?.openPositions || {}));
        const aiClosedStats = buildClosedTradeStats(aiTrades, Number(aiPortfolio?.initialCapital || 10_000), Object.values(aiPortfolio?.openPositions || {}));
        const userPortfolioDisplay = portfolioWithClosedStats(userPortfolio, userClosedStats);
        const aiPortfolioDisplay = portfolioWithClosedStats(aiPortfolio, aiClosedStats);
        const aiAssetBookDigest = buildAssetBookDigest({
            portfolio: aiPortfolio,
            profitByAsset: aiProfitByAsset,
            prices: aiSync.prices,
            swingScan,
            feedHealthMatrix,
            localLearningRules,
            tradeReviewSignals,
        });
        const executionLedger = ExecutionLedger.quickStatus();

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

        const assetCoverage = await buildAssetCoverage(aiTrades, aiPortfolio, swingScan, feedHealthMatrix).catch(() => []);

        return NextResponse.json({
            assetCoverage,
            deployment: {
                commit: process.env.APP_COMMIT_SHA || null,
                deployedAt: process.env.APP_DEPLOYED_AT || null,
                strategyVersion: TRADING_STRATEGY_VERSION,
                executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
                portfolioRiskPolicyVersion: PORTFOLIO_RISK_POLICY_VERSION,
                paperMarginPolicyVersion: PAPER_MARGIN_POLICY_VERSION,
                researchHarnessVersion: RESEARCH_HARNESS_VERSION,
                capitalMode: "PAPER_ONLY",
            },
            executionLedger,
            // User (Human) Data
            portfolio: userPortfolioDisplay,
            userPortfolio: userPortfolioDisplay,
            userTrades: isSpectator ? userTrades.slice(0, 100) : userTrades, // Keep restored history visible while bounded
            userEquityTrades,
            userTotalValue: userSync.totalValue,
            userProfitByAsset,

            // AI Data
            aiPortfolio: aiPortfolioDisplay,
            aiTrades: isSpectator ? aiTrades.slice(0, 100) : aiTrades, // Keep restored history visible while bounded
            aiEquityTrades,
            aiTotalValue: aiSync.totalValue,
            aiProfitByAsset,
            aiDetailedStats,
            aiClosedStats,

            // AI Brain Intelligence (Sanitized)
            aiReflection: isSpectator ? null : aiReflection,
            aiScalpReflection: isSpectator ? null : aiScalpReflection,
            aiRecentJournal: isSpectator ? [] : aiRecentJournal,

            // Shared
            btcPrice,
            totalValue: userSync.totalValue,
            profitByAsset: userProfitByAsset,
            userClosedStats,
            swingScan,
            lastExitSweep,
            opportunitySummary,
            setupPerformance,
            learningDigest,
            tradeReviewDigest,
            tradeReviewSignals: isSpectator ? tradeReviewSignals.slice(0, 8) : tradeReviewSignals,
            aiAssetBookDigest,
            recentTradeReviews: isSpectator ? recentTradeReviews.slice(0, 5) : recentTradeReviews,
            feedHealthMatrix,
            recentOpportunities: isSpectator ? recentOpportunities.slice(0, 8) : recentOpportunities,
            localLearningRules: isSpectator ? localLearningRules.slice(0, 8) : localLearningRules,
            logs: isSpectator ? logs.slice(0, 20) : logs // Limit logs for spectators
        }, {
            headers: {
                "Cache-Control": "no-store, max-age=0",
            },
        });
    } catch (error) {
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
