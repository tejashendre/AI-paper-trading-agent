import { SUPPORTED_ASSETS } from "@/lib/market";

export interface MarketSessionState {
  isOpen: boolean;
  isPeakLiquidity: boolean;
  reason: string;
}

// ─── Peak institutional liquidity windows by asset (UTC hours) ─────────────
// Outside these windows, entries are not blocked — they require higher conviction (75+).
// Crypto has no window (always peak, 24/7).
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

// ─── Public API ────────────────────────────────────────────────────────────
export function getMarketSessionState(
  asset: string,
  now = new Date()
): MarketSessionState {
  const config = SUPPORTED_ASSETS[asset];
  if (!config) {
    return {
      isOpen: false,
      isPeakLiquidity: false,
      reason: `Unsupported asset ${asset}.`,
    };
  }

  // Continuously quoted instruments are open 24/7. This follows the contract
  // rather than the underlying: a gold perpetual keeps trading through the
  // weekend even though the metal's futures pit does not.
  if (config.bybitLinearSymbol) {
    return {
      isOpen: true,
      isPeakLiquidity: true,
      reason: "Crypto market is open 24/7.",
    };
  }

  const isOpen = isWeekdayMarketOpen(now);
  if (!isOpen) {
    return {
      isOpen: false,
      isPeakLiquidity: false,
      reason: `${config.category} market is closed; skipping new entries to avoid stale weekend prices.`,
    };
  }

  const isPeakLiquidity = isInPeakWindow(asset, now);
  return {
    isOpen: true,
    isPeakLiquidity,
    reason: isPeakLiquidity
      ? `${config.category} market is in peak liquidity session.`
      : `${config.category} market is open but outside peak liquidity hours; requiring higher conviction for new entries.`,
  };
}
