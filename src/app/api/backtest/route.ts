import { NextResponse } from "next/server";
import { MarketService } from "@/lib/market";
import { verifyAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const asset = searchParams.get("asset") || "BTC";
  const timeframe = (searchParams.get("timeframe") || "1h") as any;
  const limit = parseInt(searchParams.get("limit") || "500", 10);

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
