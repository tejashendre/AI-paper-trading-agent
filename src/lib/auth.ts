// Bearer-token authentication for dashboard, read-only spectator,
// and VPS daemon/cron requests. Infrastructure headers are not trusted.

import { isOwnerSession, matchesOwnerSecret, OWNER_COOKIE } from "@/lib/ownerSession";
import { getEnv } from "@/lib/env";

export interface AuthResult {
  authorized: boolean;
  source: string;
  error?: string;
}

export function verifyAuth(request: Request): AuthResult {
  const authHeader = request.headers.get("authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    
    if (token === "SPECTATOR") {
      const path = new URL(request.url).pathname;
      const allowedPaths = ["/api/user/status", "/api/prices", "/api/live-prices", "/api/chart", "/api/signals", "/api/backtest"];
      if (request.method === "GET" && allowedPaths.includes(path)) {
        return { authorized: true, source: "spectator" };
      }
      return { authorized: false, source: "auth", error: "Spectator access is read-only" };
    }

    if (matchesOwnerSecret(token)) {
      return { authorized: true, source: "dashboard" };
    }

    const env = getEnv();
    // Check strict CRON token
    if (env.CRON_SECRET && token === env.CRON_SECRET) {
      return { authorized: true, source: "cron" };
    }

    return { authorized: false, source: "auth", error: "Invalid token" };
  }

  const session = request.headers.get("cookie")?.split(";")
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(OWNER_COOKIE + "="))
    ?.slice(OWNER_COOKIE.length + 1);
  // A cross-origin form cannot add this header to a cookie-authenticated write.
  if (session && (request.method === "GET" || request.headers.get("x-owner-action") === "1") && isOwnerSession(session)) {
    return { authorized: true, source: "dashboard" };
  }

  return { authorized: false, source: "none", error: "No auth provided" };
}
