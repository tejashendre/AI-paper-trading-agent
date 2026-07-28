import { NextResponse } from "next/server";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { verifyAuth } from "@/lib/auth";
import { ExecutionLedger, TRADING_STRATEGY_VERSION } from "@/lib/trading/executionLedger";
import { LocalLearningMemory } from "@/lib/trading/localLearning";
import { OpportunityJournal } from "@/lib/trading/opportunityJournal";
import { TradeReviewJournal } from "@/lib/trading/tradeReviewJournal";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
    // SECURITY: This endpoint wipes the entire simulation state.
    // It MUST be protected — only authenticated administrators may call it.
    const auth = verifyAuth(request);
    if (!auth.authorized || auth.source !== "dashboard") {
        return NextResponse.json(
            { success: false, error: "Unauthorized. Admin/Dashboard credentials required to reset the arena." },
            { status: 403 }
        );
    }

    let aiRelease: (() => Promise<void>) | null = null;
    let userRelease: (() => Promise<void>) | null = null;
    try {
        aiRelease = await PortfolioManager.acquireWriteLock("ai");
        if (!aiRelease) {
            return NextResponse.json({ success: false, error: "AI portfolio is busy; retry after the active scan completes." }, { status: 409 });
        }
        userRelease = await PortfolioManager.acquireWriteLock("user");
        if (!userRelease) {
            return NextResponse.json({ success: false, error: "User portfolio is busy; retry after the active update completes." }, { status: 409 });
        }
        let capital = 10000;
        try {
            const body = await request.json();
            if (body && typeof body.capital === "number" && Number.isFinite(body.capital) && body.capital >= 100 && body.capital <= 1_000_000) {
                capital = body.capital;
            }
        } catch {
            // Ignore parse errors, use default 10000
        }

        await Promise.all([
            PortfolioManager.resetPortfolio("user", capital),
            PortfolioManager.resetPortfolio("ai", capital)
        ]);
        await Promise.all([
            LocalLearningMemory.clearCurrentStrategyState(),
            OpportunityJournal.clearCurrentStrategyState(),
            TradeReviewJournal.clearCurrentStrategyState(),
        ]);
        await ExecutionLedger.recordBestEffort({
            type: "SYSTEM_RESET",
            source: "ADMIN_DASHBOARD",
            payload: {
                capital,
                portfolios: ["user", "ai"],
                clearedStrategyVersion: TRADING_STRATEGY_VERSION,
                preservedVersionedHistory: true,
            },
        });
        await Logger.info(`[${auth.source}] Admin reset both Human and AI portfolios with starting capital $${capital.toLocaleString()} USD.`);
        return NextResponse.json({
            success: true,
            message: `Competition reset! Both Human and AI portfolios set to $${capital.toLocaleString()} USD.`,
            strategyState: {
                clearedVersion: TRADING_STRATEGY_VERSION,
                priorVersionHistoryPreserved: true,
            },
        });
    } catch (error) {
        return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
    } finally {
        if (userRelease) await userRelease();
        if (aiRelease) await aiRelease();
    }
}
