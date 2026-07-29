// Bearer-token authentication for dashboard, read-only spectator,
// and VPS daemon/cron requests. Infrastructure headers are not trusted.

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
