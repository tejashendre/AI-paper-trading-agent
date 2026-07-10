import { NextResponse } from "next/server";
import { MarketService } from "@/lib/market";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { verifyAuth } from "@/lib/auth";
import { Timeframe } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const asset = searchParams.get("asset") || "BTC";
  const timeframeValue = searchParams.get("timeframe") || "1h";
  const parsedLimit = Number.parseInt(searchParams.get("limit") || "500", 10);
  const allowedTimeframes = new Set<Timeframe>(["1m", "5m", "15m", "30m", "1h", "4h"]);

  if (!SUPPORTED_ASSETS[asset]) {
    return NextResponse.json({ success: false, error: "Unsupported asset" }, { status: 400 });
  }
  if (!allowedTimeframes.has(timeframeValue as Timeframe)) {
    return NextResponse.json({ success: false, error: "Unsupported timeframe" }, { status: 400 });
  }
  if (!Number.isFinite(parsedLimit) || parsedLimit < 50 || parsedLimit > 1_000) {
    return NextResponse.json({ success: false, error: "Limit must be between 50 and 1000" }, { status: 400 });
  }

  const timeframe = timeframeValue as Timeframe;
  const limit = parsedLimit;

  try {
    const candles = await MarketService.getCandles(timeframe, limit, asset);
    return NextResponse.json({ success: true, candles });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Failed to fetch historical candles" },
      { status: 500 }
    );
  }
}
