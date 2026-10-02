// ================================================================
// Lazy Environment Validation
// Only validates when getEnv() is first called, not at build time.
// The bot needs no exchange, LLM or messaging keys: market data is public
// and every fill is simulated. Only the settings below are read anywhere.
// ================================================================

export interface Env {
  DASHBOARD_SECRET: string;
  CRON_SECRET: string;
  RISK_PER_TRADE: number;
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  if (!process.env.DASHBOARD_SECRET) {
    throw new Error("Missing required environment variables: DASHBOARD_SECRET");
  }

  cached = {
    DASHBOARD_SECRET: process.env.DASHBOARD_SECRET,
    CRON_SECRET: process.env.CRON_SECRET || "",
    RISK_PER_TRADE: parseFloat(process.env.RISK_PER_TRADE || "1"),
  };

  return cached;
}
