import { SUPPORTED_ASSETS } from "@/lib/market";

export interface MarketSessionState {
  /** The contract accepts orders. Every configured perpetual trades 24/7. */
  isOpen: boolean;
  /** The underlying market's deepest hours; always true for crypto. */
  isPeakLiquidity: boolean;
  /** Whether the TradFi underlying (FX, COMEX/NYMEX) is open; true for crypto. */
  underlyingOpen: boolean;
  reason: string;
  warnings: string[];
}

// Peak liquidity windows of the TradFi underlyings (UTC hours). The perpetual
// itself trades 24/7; outside these hours, and while the underlying is shut
// for the weekend, entries are not blocked but require higher conviction.
// Exchange holidays are not modeled. Crypto has no window.
const PEAK_HOURS_UTC: Record<string, { open: number; close: number }> = {
  // London + New York overlap — highest EURUSD/GBPUSD volume (07:00–17:00 UTC)
  EURUSD: { open: 7,  close: 17 },
  GBPUSD: { open: 7,  close: 17 },
  // Tokyo + London overlap — best for USDJPY (00:00–09:00 UTC)
  USDJPY: { open: 0,  close: 9  },
  // US futures session — COMEX/NYMEX peak hours (13:00–20:00 UTC)
  GOLD:   { open: 13, close: 20 },
  OIL:    { open: 13, close: 20 },
  SILVER: { open: 13, close: 20 },
};

// ─── Weekday market open check (unchanged from v1) ─────────────────────────
/**
 * Exported so the feed-health scorer can tell a market being shut from a feed
 * dropping data. Without that distinction every weekend looks like an outage.
 */
export function isWeekdayMarketOpen(now: Date): boolean {
  const day     = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 0) return minutes >= 22 * 60;            // Sunday: open after 22:00 UTC
  if (day >= 1 && day <= 4) return true;               // Mon–Thu: always open
  if (day === 5) return minutes < 21 * 60;             // Friday: open until 21:00 UTC
  return false;                                         // Saturday: closed
}

// ─── Peak liquidity check ──────────────────────────────────────────────────
function isInPeakWindow(asset: string, now: Date): boolean {
  const window = PEAK_HOURS_UTC[asset];
  if (!window) return true; // No defined window → treat as always peak (crypto)
  const hour = now.getUTCHours();
  return hour >= window.open && hour < window.close;
}

// Public API
export function getMarketSessionState(
  asset: string,
  now = new Date()
): MarketSessionState {
  const config = SUPPORTED_ASSETS[asset];
  if (!config) {
    return {
      isOpen: false,
      isPeakLiquidity: false,
      underlyingOpen: false,
      reason: `Unsupported asset ${asset}.`,
      warnings: [],
    };
  }

  if (config.category === "crypto") {
    return {
      isOpen: true,
      isPeakLiquidity: true,
      underlyingOpen: true,
      reason: `${config.name} perpetual (${config.bybitLinearSymbol}) trades 24/7.`,
      warnings: [],
    };
  }

  // The contract trades through the weekend; the market behind its price
  // does not, so liquidity follows the underlying's session.
  const contract = `${config.name} perpetual (${config.bybitLinearSymbol}) trades 24/7`;
  const underlyingOpen = isWeekdayMarketOpen(now);
  if (!underlyingOpen) {
    return {
      isOpen: true,
      isPeakLiquidity: false,
      underlyingOpen: false,
      reason: `${contract}, but the underlying ${config.category} market is closed for the weekend, so new entries require higher conviction.`,
      warnings: [`Underlying ${config.category} market is closed for the weekend; perpetual liquidity and price discovery are thin.`],
    };
  }

  const isPeakLiquidity = isInPeakWindow(asset, now);
  return {
    isOpen: true,
    isPeakLiquidity,
    underlyingOpen: true,
    reason: isPeakLiquidity
      ? `${contract}; the underlying ${config.category} market is in its peak liquidity session.`
      : `${contract}; the underlying ${config.category} market is outside peak liquidity hours, so new entries require higher conviction.`,
    warnings: [],
  };
}
