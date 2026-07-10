import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { HyperbolicTimeChamber } from '@/lib/ai/hyperbolicTimeChamber';
import { DatabasePruner } from '@/lib/database/databasePruner';
import { verifyAuth } from '@/lib/auth';

export const maxDuration = 30; // Vercel timeout
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const auth = verifyAuth(req);
    if (!auth.authorized || (auth.source !== "dashboard" && auth.source !== "cron")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const start = Date.now();
    
    // Run the optimization simulation
    const optimizedParams = await HyperbolicTimeChamber.runOptimization();
    
    // Trigger Python ML microservice retraining
    try {
      await fetch("http://python-worker:5000/train", { method: "POST" });
    } catch (e) {
      try {
        await fetch("http://localhost:5000/train", { method: "POST" });
      } catch (err) {
        console.warn("[Optimize Route] Failed to trigger Python ML retrain:", err);
      }
    }

    // Trigger Database Pruner
    await DatabasePruner.pruneOldDecisions(30);

    const duration = Date.now() - start;

    return NextResponse.json({
      success: true,
      message: "Hyperbolic Time Chamber optimization complete.",
      optimizedParams,
      durationMs: duration
    });
  } catch (error: any) {
    console.error("[Optimize Route] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
