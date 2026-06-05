// ================================================================
// Lazy Environment Validation
// Only validates when getEnv() is first called — NOT at build time.
// ================================================================

  export interface Env {
    GEMINI_API_KEY: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    DASHBOARD_SECRET: string;
    QSTASH_CURRENT_SIGNING_KEY: string;
    QSTASH_NEXT_SIGNING_KEY: string;
    TRADING_TIMEFRAME: string;
    RISK_PER_TRADE: number;
    ADMIN_SECRET: string;
    CRON_SECRET: string;
    GROQ_API_KEY?: string;
    OPENROUTER_API_KEY?: string;
    SUPABASE_URL?: string;
    SUPABASE_KEY?: string;
    SUPABASE_ENABLED?: boolean;
    BINANCE_API_KEY?: string;
    BINANCE_API_SECRET?: string;
    BYBIT_API_KEY?: string;
    BYBIT_API_SECRET?: string;
    MARGIN_MODE?: string;
    LIVE_TRADING_ENABLED?: boolean;
  }
  
  let cached: Env | null = null;
  
  export function getEnv(): Env {
    if (cached) return cached;
  
    const required = [
      "DASHBOARD_SECRET",
      "ADMIN_SECRET",
    ] as const;
  
    const missing: string[] = [];
    for (const key of required) {
      if (!process.env[key]) missing.push(key);
    }
  
    if (missing.length > 0) {
      throw new Error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
    }
  
    cached = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
      DASHBOARD_SECRET: process.env.DASHBOARD_SECRET!,
      QSTASH_CURRENT_SIGNING_KEY: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
      QSTASH_NEXT_SIGNING_KEY: process.env.QSTASH_NEXT_SIGNING_KEY || "",
      TRADING_TIMEFRAME: process.env.TRADING_TIMEFRAME || "1h",
      RISK_PER_TRADE: parseFloat(process.env.RISK_PER_TRADE || "1"),
      ADMIN_SECRET: process.env.ADMIN_SECRET!,
      CRON_SECRET: process.env.CRON_SECRET || "",
      GROQ_API_KEY: process.env.GROQ_API_KEY || "",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "",
      SUPABASE_URL: process.env.SUPABASE_URL || "",
      SUPABASE_KEY: process.env.SUPABASE_KEY || "",
      SUPABASE_ENABLED: process.env.SUPABASE_ENABLED !== "false" && !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
      BINANCE_API_KEY: process.env.BINANCE_API_KEY || "",
      BINANCE_API_SECRET: process.env.BINANCE_API_SECRET || "",
      BYBIT_API_KEY: process.env.BYBIT_API_KEY || "",
      BYBIT_API_SECRET: process.env.BYBIT_API_SECRET || "",
      MARGIN_MODE: process.env.MARGIN_MODE || "CROSS",
      LIVE_TRADING_ENABLED: process.env.LIVE_TRADING_ENABLED === "true",
    };

  return cached;
}
