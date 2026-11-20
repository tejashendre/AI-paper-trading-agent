import { NextResponse } from "next/server";
import { PortfolioManager } from "@/lib/portfolio";
import { verifyAuth } from "@/lib/auth";
import { DEFAULT_RESET_CAPITAL, resetArena } from "@/lib/admin/resetArena";
import { resetHumanPortfolio } from "@/lib/admin/resetHuman";

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

    let body: { capital?: unknown; scope?: unknown } = {};
    try {
        body = (await request.json()) ?? {};
    } catch {
        // Ignore parse errors and reset with the defaults.
    }

    // scope "human" resets only the Human portfolio. It never touches the AI
    // run, so it still works while a V6 AI epoch is active.
    if (body.scope === "human") {
        const release = await PortfolioManager.acquireWriteLock("user");
        if (!release) {
            return NextResponse.json({ success: false, error: "Human portfolio is busy; retry in a moment." }, { status: 409 });
        }
        try {
            const result = await resetHumanPortfolio({ capital: body.capital, source: "ADMIN_DASHBOARD" });
            return NextResponse.json({
                success: true,
                message: `Human portfolio reset to $${result.capital.toLocaleString()} USD. AI and book unchanged.`,
                ...result,
            });
        } catch (error) {
            return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
        } finally {
            await release();
        }
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

        const capital = typeof body.capital === "number" ? body.capital : DEFAULT_RESET_CAPITAL;

        const result = await resetArena({ capital, source: "ADMIN_DASHBOARD" });

        return NextResponse.json({
            success: true,
            message: `Arena reset. Human, AI swing and cross-sectional book all set to $${result.capital.toLocaleString()} USD.`,
            strategyState: {
                clearedVersion: result.swingStrategyVersion,
                clearedBookVersion: result.bookStrategyVersion,
                clearedKeys: result.clearedKeys.length,
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
