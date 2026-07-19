import { NextResponse } from "next/server";
import { verifyAuth } from "@/lib/auth";
import { Logger } from "@/lib/logger";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { requestSwingScan } from "@/lib/trading/scanControl";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function POST(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });
  if (auth.source !== "dashboard" && auth.source !== "cron") {
    return NextResponse.json({ error: "Admin or cron authorization is required." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const targetAsset = searchParams.get("asset") || "all";
  if (targetAsset !== "all" && !SUPPORTED_ASSETS[targetAsset]) {
    return NextResponse.json({ error: `Asset ${targetAsset} is not supported.` }, { status: 400 });
  }

  await requestSwingScan({
    requestedAt: new Date().toISOString(),
    requestedBy: auth.source,
    targetAsset,
  });
  await Logger.info(`[SCAN CONTROL] ${auth.source} requested an audited daemon scan for ${targetAsset}.`);

  return NextResponse.json({
    success: true,
    accepted: true,
    action: "SCAN_REQUESTED",
    targetAsset,
    message: "The single-writer swing daemon will consume this request within five seconds.",
  }, { status: 202 });
}
