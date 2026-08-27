import { NextResponse } from "next/server";
import {
  asSeries,
  BOOK_EQUITY_CURVE_KEY,
  getEquityCurve,
  SWING_EQUITY_CURVE_KEY,
} from "@/lib/execution/equityCurve";
import { compareSleeves } from "@/lib/research/sleeveCorrelation";

export const dynamic = "force-dynamic";

/**
 * How independent this system's two strategies actually are.
 *
 * The system has always run two sleeves and has never checked whether they are
 * the same bet in different clothing. If they move together, the second one is
 * carrying operational risk without buying any protection — a bad stretch for
 * one is a bad stretch for both, and the apparent safety of "two strategies"
 * is an illusion.
 *
 * Both sides use realised equity. The swing engine only books a result when a
 * position closes, so correlating its curve against the book's continuously
 * marked one would measure the recording schedules rather than the strategies.
 */
export async function GET() {
  try {
    const [bookCurve, swingCurve] = await Promise.all([
      getEquityCurve(BOOK_EQUITY_CURVE_KEY).catch(() => []),
      getEquityCurve(SWING_EQUITY_CURVE_KEY).catch(() => []),
    ]);

    const comparison = compareSleeves(
      { name: "Cross-sectional book", points: asSeries(bookCurve, "realized") },
      { name: "Swing engine", points: asSeries(swingCurve, "realized") }
    );

    return NextResponse.json({
      comparison,
      coverage: {
        bookPoints: bookCurve.length,
        swingPoints: swingCurve.length,
        bookFirstAt: bookCurve[0]?.at ?? null,
        swingFirstAt: swingCurve[0]?.at ?? null,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to compare sleeves" },
      { status: 500 }
    );
  }
}
