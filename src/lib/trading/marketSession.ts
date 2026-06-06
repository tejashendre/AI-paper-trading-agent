import { SUPPORTED_ASSETS } from "@/lib/market";

export interface MarketSessionState {
  isOpen: boolean;
  reason: string;
}

function isWeekdayMarketOpen(now: Date): boolean {
  const day = now.getUTCDay();
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();

  if (day === 0) return minutes >= 22 * 60;
  if (day >= 1 && day <= 4) return true;
  if (day === 5) return minutes < 21 * 60;
  return false;
}

export function getMarketSessionState(asset: string, now = new Date()): MarketSessionState {
  const config = SUPPORTED_ASSETS[asset];
  if (!config) {
    return { isOpen: false, reason: `Unsupported asset ${asset}.` };
  }

  if (config.category === "crypto") {
    return { isOpen: true, reason: "Crypto market is open 24/7." };
  }

  const isOpen = isWeekdayMarketOpen(now);
  return {
    isOpen,
    reason: isOpen
      ? `${config.category} market session is open.`
      : `${config.category} market is closed; skipping new entries to avoid stale weekend prices.`,
  };
}
