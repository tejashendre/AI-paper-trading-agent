import { NextResponse } from "next/server";
import { PortfolioManager } from "@/lib/portfolio";
import { Logger } from "@/lib/logger";
import { verifyAuth } from "@/lib/auth";

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

    try {
        let capital = 10000;
        try {
            const body = await request.json();
            if (body && typeof body.capital === "number" && body.capital > 0) {
                capital = body.capital;
            }
        } catch {
            // Ignore parse errors, use default 10000
        }

        await Promise.all([
            PortfolioManager.resetPortfolio("user", capital),
            PortfolioManager.resetPortfolio("ai", capital)
        ]);
        await Logger.info(`[${auth.source}] Admin reset both Human and AI portfolios with starting capital $${capital.toLocaleString()} USD.`);
        return NextResponse.json({ success: true, message: `Competition reset! Both Human and AI portfolios set to $${capital.toLocaleString()} USD.` });
    } catch (error) {
        return NextResponse.json({ success: false, error: String(error) }, { status: 500 });
    }
}
