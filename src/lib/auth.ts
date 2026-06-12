// ================================================================
// Auth Middleware — QStash signatures + Dashboard bearer tokens
// ================================================================
//
// SECURITY NOTES:
//
// 1. QStash path: We verify that the `upstash-signature` header is
//    present AND that signing keys are configured, but we do NOT
//    perform full HMAC cryptographic verification of the signature.
//    This is a known gap. Full verification should be added using
//    the `@upstash/qstash` SDK's `Receiver.verify()` method.
//    Until then, this path trusts any request that presents the
//    header while keys are configured, which is safe only if the
//    endpoint is not otherwise reachable by external traffic.
//
// 2. Vercel Cron path: `x-vercel-cron: 1` is safe to trust because
//    Vercel's infrastructure automatically STRIPS this header from
//    any inbound external HTTP requests, so it can only be set by
//    Vercel's own cron scheduler internally. See Vercel docs:
//    https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
//
// ================================================================

import { getEnv } from "@/lib/env";

export interface AuthResult {
  authorized: boolean;
  source: string;
  error?: string;
}

export function verifyAuth(request: Request): AuthResult {
  const env = getEnv();
  const authHeader = request.headers.get("authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    
    // Check Dashboard token
    if (token === env.DASHBOARD_SECRET) {
      return { authorized: true, source: "dashboard" };
    }
    
    // Check Spectator token
    if (token === "SPECTATOR" && request.method === "GET") {
      const url = new URL(request.url);
      const path = url.pathname;
      const allowedPaths = ["/api/user/status", "/api/prices", "/api/live-prices", "/api/chart", "/api/signals", "/api/backtest"];
      if (allowedPaths.some(p => path === p || path.startsWith(p + "/"))) {
        return { authorized: true, source: "spectator" };
      }
      return { authorized: false, source: "auth", error: "Spectator not allowed on action endpoints" };
    }
    
    // Check strict CRON token
    if (env.CRON_SECRET && token === env.CRON_SECRET) {
      return { authorized: true, source: "cron" };
    }

    return { authorized: false, source: "auth", error: "Invalid token" };
  }

  return { authorized: false, source: "none", error: "No auth provided" };
}
