import { OpenPosition } from "@/lib/types";
import { SwingSignal } from "@/lib/swingEngine";

export const EXIT_POLICY_VERSION = "r-multiple-exit-v1-2026-08-25";

/**
 * Every threshold here is expressed in R — multiples of the trade's own
 * planned loss — never in absolute dollars.
 *
 * The previous policy mixed the two: it closed a trade once it gave back $3
 * from a $20 peak, tightened stops to a fixed 0.35% of price whenever an
 * opposing signal appeared, and closed on a fixed $8 profit decay. Those
 * dollar constants are meaningless across position sizes and volatility
 * regimes: on a normally-sized crypto swing they fire inside ordinary noise.
 * Measured over 3 months of Bybit 15m data on BTC/ETH/SOL, that stack cut the
 * average winner to 0.79R while losers still ran the full 0.97R, taking the
 * profit factor from 1.03 down to 0.71 on identical entries.
 */
export const EXIT_POLICY = {
  /** Move the stop to a small locked profit once the trade is this far ahead. */
  lockActivationR: 1.2,
  /** Size of the locked profit, in R, once lock activates. */
  lockProfitR: 0.15,
  /** Start trailing only after the trade has genuinely run. */
  trailActivationR: 2.0,
  /** How far behind the watermark the trail sits, in R. */
  trailDistanceR: 1.15,
  /** Only protect a giveback once the open profit was this large. */
  givebackActivationR: 2.0,
  /** Never close a giveback below this remaining profit. */
  givebackFloorR: 0.5,
  /** Close when this fraction of the peak open profit has been surrendered. */
  givebackFraction: 0.45,
  /**
   * Backstop only. The protective stop is the primary loss control; this
   * catches a position whose loss has run well past plan because price gapped
   * straight through the stop between watchdog ticks.
   */
  backstopLossR: 1.5,
  /** A backstop must also clear this absolute floor to avoid dust exits. */
  backstopMinimumUsd: 5,
} as const;

export type ExitAction =
  | { kind: "HOLD" }
  | { kind: "CLOSE"; reason: ExitCloseReason; explanation: string }
  | { kind: "MOVE_STOP"; newStopLoss: number; trailing: boolean; explanation: string };

export type ExitCloseReason = "STOP_LOSS" | "TAKE_PROFIT" | "SIGNAL_REVERSAL" | "SIGNAL_INVALIDATION";

export interface ExitPolicyInput {
  position: OpenPosition;
  currentPrice: number;
  /** Net unrealized PnL after both fee legs and carry. */
  netPnlUsd: number;
  /** Highest net unrealized PnL this position has reached. */
  peakNetPnlUsd: number;
  /** True only for a strong, confirmed opposite thesis. */
  oppositeEdgeConfirmed: boolean;
}

function plannedRiskUsd(position: OpenPosition): number {
  const planned = Number(position.maxLossUsd ?? position.riskAmountUsd ?? 0);
  return Number.isFinite(planned) && planned > 0 ? planned : 0;
}

function riskDistance(position: OpenPosition): number {
  const basis = Number(position.initialStopLoss);
  const stopBasis = Number.isFinite(basis) && basis > 0 ? basis : position.stopLoss;
  const distance = Math.abs(position.entryPrice - stopBasis);
  return Number.isFinite(distance) && distance > 0 ? distance : 0;
}

/** How far the trade has run in its favour, measured in R, using the watermark. */
export function favourableRMultiple(position: OpenPosition, currentPrice: number): number {
  const distance = riskDistance(position);
  if (distance <= 0) return 0;

  const isShort = position.direction === "SHORT";
  const watermark = isShort
    ? Math.min(position.lowestPriceReached ?? currentPrice, currentPrice)
    : Math.max(position.highestPriceReached ?? currentPrice, currentPrice);
  const move = isShort ? position.entryPrice - watermark : watermark - position.entryPrice;
  return move / distance;
}

function betterStop(position: OpenPosition, candidate: number): boolean {
  return position.direction === "SHORT" ? candidate < position.stopLoss : candidate > position.stopLoss;
}

function stillProtective(position: OpenPosition, candidate: number, currentPrice: number): boolean {
  return position.direction === "SHORT" ? candidate > currentPrice : candidate < currentPrice;
}

/**
 * Single decision point for an open swing position. Callers apply the result;
 * this function performs no I/O so it can be replayed in research.
 */
export function decideSwingExit(input: ExitPolicyInput): ExitAction {
  const { position, currentPrice, netPnlUsd, peakNetPnlUsd } = input;
  const riskUsd = plannedRiskUsd(position);
  const distance = riskDistance(position);

  if (input.oppositeEdgeConfirmed) {
    return {
      kind: "CLOSE",
      reason: "SIGNAL_REVERSAL",
      explanation: "A stronger, confirmed opposite setup replaced this thesis, so the trade is closed rather than defended.",
    };
  }

  if (riskUsd > 0) {
    const backstop = Math.max(EXIT_POLICY.backstopMinimumUsd, riskUsd * EXIT_POLICY.backstopLossR);
    if (netPnlUsd <= -backstop) {
      return {
        kind: "CLOSE",
        reason: "SIGNAL_INVALIDATION",
        explanation: `Loss ran to $${Math.abs(netPnlUsd).toFixed(2)}, past the $${backstop.toFixed(2)} backstop for a $${riskUsd.toFixed(2)} planned risk. Price moved through the protective stop between checks.`,
      };
    }

    const peakR = peakNetPnlUsd / riskUsd;
    const nowR = netPnlUsd / riskUsd;
    if (
      peakR >= EXIT_POLICY.givebackActivationR &&
      nowR > EXIT_POLICY.givebackFloorR &&
      peakR - nowR >= peakR * EXIT_POLICY.givebackFraction
    ) {
      return {
        kind: "CLOSE",
        reason: "TAKE_PROFIT",
        explanation: `Open profit peaked at ${peakR.toFixed(2)}R and has given back more than ${Math.round(EXIT_POLICY.givebackFraction * 100)}% of it. Banking ${nowR.toFixed(2)}R.`,
      };
    }
  }

  if (distance <= 0) return { kind: "HOLD" };

  const runR = favourableRMultiple(position, currentPrice);
  const isShort = position.direction === "SHORT";

  if (runR >= EXIT_POLICY.trailActivationR) {
    const watermark = isShort
      ? Math.min(position.lowestPriceReached ?? currentPrice, currentPrice)
      : Math.max(position.highestPriceReached ?? currentPrice, currentPrice);
    const candidate = isShort
      ? watermark + distance * EXIT_POLICY.trailDistanceR
      : watermark - distance * EXIT_POLICY.trailDistanceR;
    if (betterStop(position, candidate) && stillProtective(position, candidate, currentPrice)) {
      return {
        kind: "MOVE_STOP",
        newStopLoss: candidate,
        trailing: true,
        explanation: `Trade has run ${runR.toFixed(2)}R, so the stop now trails ${EXIT_POLICY.trailDistanceR}R behind the best price reached.`,
      };
    }
  }

  if (runR >= EXIT_POLICY.lockActivationR) {
    const candidate = isShort
      ? position.entryPrice - distance * EXIT_POLICY.lockProfitR
      : position.entryPrice + distance * EXIT_POLICY.lockProfitR;
    if (betterStop(position, candidate) && stillProtective(position, candidate, currentPrice)) {
      return {
        kind: "MOVE_STOP",
        newStopLoss: candidate,
        trailing: true,
        explanation: `Trade has run ${runR.toFixed(2)}R, so the stop moves up to lock ${EXIT_POLICY.lockProfitR}R of profit.`,
      };
    }
  }

  return { kind: "HOLD" };
}

/**
 * A confirmed opposite edge is the only signal-based reason to close early.
 * Everything weaker is recorded on the position for the dashboard but does not
 * touch the stop: the previous "tighten to 0.35% of price" reaction stopped
 * trades out inside routine crypto noise.
 */
export function isOppositeEdgeConfirmed(position: OpenPosition, signal: SwingSignal): boolean {
  const opposedLong = position.direction === "SHORT" && signal.action === "SWING_BUY";
  const opposedShort = position.direction === "LONG" && signal.action === "SWING_SHORT";
  if (!opposedLong && !opposedShort) return false;

  const isFastCrypto = position.asset === "BTC" || position.asset === "ETH" || position.asset === "SOL";
  const heldConviction = Number(position.finalConviction || 0);

  return (
    signal.dataQuality >= (isFastCrypto ? 80 : 74) &&
    signal.triggerScore >= (isFastCrypto ? 16 : 12) &&
    signal.htfScore >= (isFastCrypto ? 8 : 10) &&
    signal.finalConviction >= Math.max(isFastCrypto ? 72 : 82, heldConviction + (isFastCrypto ? 6 : 10)) &&
    signal.slippagePercent <= (isFastCrypto ? 0.25 : 0.35)
  );
}

/** Weaker opposing evidence: informational only, used for dashboard copy. */
export function isThesisWeakening(position: OpenPosition, signal: SwingSignal): boolean {
  const opposed =
    (position.direction === "SHORT" && signal.action === "SWING_BUY") ||
    (position.direction === "LONG" && signal.action === "SWING_SHORT");
  return opposed && signal.finalConviction >= Math.max(62, Number(position.finalConviction || 0) - 4);
}
