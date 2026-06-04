// ================================================================
// AI Position Manager — Dynamic Trade Lifecycle Management
// Evaluates open positions every cycle and adjusts SL/TP based
// on how the trade is progressing relative to the market state.
// ================================================================

import { OpenPosition, MarketWorldModel } from '@/lib/types';

/**
 * The result of evaluating an open position.
 * Contains the updated position (with potentially modified SL/TP)
 * and a description of what was changed and why.
 */
export interface PositionManagementResult {
  updatedPosition: OpenPosition;
  action: 'NO_CHANGE' | 'MOVED_TO_BREAKEVEN' | 'TRAILING_STOP' | 'TIGHTENED_STOP' | 'THESIS_INVALIDATED';
  message: string;
  shouldForceExit: boolean;
}

export class PositionManager {
  /**
   * Evaluates an open position against the current market state.
   *
   * This is called during the stop-loss sweep phase of every trade cycle.
   * It does NOT decide whether to exit — the stop sweep and PaperExchange
   * handle that. It adjusts the SL/TP so that the existing sweep logic
   * acts on smarter levels.
   *
   * Management logic (in priority order):
   * 1. Thesis invalidation — if market regime has completely flipped against us
   * 2. Trailing stop — if profit exceeds 2R, trail the stop to lock in 1R
   * 3. Break-even — if profit exceeds 1R, move stop to entry price
   * 4. Tighten on degraded data — if feed health is bad, narrow the stop
   */
  static evaluatePosition(
    position: OpenPosition,
    currentPrice: number,
    worldModel: MarketWorldModel
  ): PositionManagementResult {
    const isLong = position.direction === 'LONG';
    const entryPrice = position.entryPrice;
    const currentSL = position.stopLoss;

    // Calculate the original risk distance (1R)
    const originalRiskDistance = isLong
      ? entryPrice - currentSL
      : currentSL - entryPrice;

    // Safety: if risk distance is zero or negative, something is wrong — don't touch
    if (originalRiskDistance <= 0) {
      return {
        updatedPosition: position,
        action: 'NO_CHANGE',
        message: `Risk distance is zero or negative ($${originalRiskDistance.toFixed(2)}). Skipping management.`,
        shouldForceExit: false,
      };
    }

    // Calculate current profit in R-multiples
    const unrealizedPnl = isLong
      ? currentPrice - entryPrice
      : entryPrice - currentPrice;
    const rMultiple = unrealizedPnl / originalRiskDistance;

    // 0. Macro Catalyst Panic (Emergency Exit)
    if (worldModel.newsCatalyst && worldModel.newsCatalyst.sentiment === 'PANIC') {
      const updated = { ...position };
      // Slam the stop loss tight against current price to force an exit on next tick
      updated.stopLoss = isLong ? currentPrice * 1.001 : currentPrice * 0.999;
      return {
        updatedPosition: updated,
        action: 'THESIS_INVALIDATED',
        message: `EMERGENCY EXIT: Macro Panic Detected (${worldModel.newsCatalyst.reasoning})`,
        shouldForceExit: true,
      };
    }

    // ── 1. Thesis Invalidation Check ──────────────────────────────
    // If the AI entered LONG during an uptrend and the regime has flipped to
    // a strong downtrend (or vice versa), the thesis is dead.
    const thesisInvalidated = isThesisInvalidated(position, worldModel);
    if (thesisInvalidated) {
      // Tighten stop aggressively — move it to just 0.3R from current price
      const tightDistance = originalRiskDistance * 0.3;
      const newSL = isLong
        ? currentPrice - tightDistance
        : currentPrice + tightDistance;

      // Only move if it's actually tighter than current
      const isTighter = isLong ? newSL > currentSL : newSL < currentSL;
      if (isTighter) {
        const updated = { ...position, stopLoss: newSL };
        return {
          updatedPosition: updated,
          action: 'THESIS_INVALIDATED',
          message: `Regime flipped to ${worldModel.regime}. Original thesis likely invalidated. Tightened SL to $${newSL.toFixed(4)} (0.3R from price).`,
          shouldForceExit: false, // Let the stop sweep handle the exit naturally
        };
      }
    }

    // ── 2. Trailing Stop (≥ 2R profit) ────────────────────────────
    // If trade has moved 2R in our favor, trail the stop to lock in 1R.
    if (rMultiple >= 2.0) {
      const trailDistance = originalRiskDistance; // Lock in 1R profit
      const newSL = isLong
        ? currentPrice - trailDistance
        : currentPrice + trailDistance;

      // Only move the stop in the favorable direction
      const isBetter = isLong ? newSL > currentSL : newSL < currentSL;
      if (isBetter) {
        const updated = { ...position, stopLoss: newSL };
        return {
          updatedPosition: updated,
          action: 'TRAILING_STOP',
          message: `Trade at ${rMultiple.toFixed(1)}R profit. Trailing stop to $${newSL.toFixed(4)} (locking in ~1R profit).`,
          shouldForceExit: false,
        };
      }
    }

    // ── 3. Break-Even (≥ 1R profit) ──────────────────────────────
    // If trade has moved 1R in our favor, move stop to entry (risk-free trade).
    if (rMultiple >= 1.0) {
      const breakEvenSL = entryPrice;
      const isBetter = isLong ? breakEvenSL > currentSL : breakEvenSL < currentSL;
      if (isBetter) {
        const updated = { ...position, stopLoss: breakEvenSL };
        return {
          updatedPosition: updated,
          action: 'MOVED_TO_BREAKEVEN',
          message: `Trade at ${rMultiple.toFixed(1)}R profit. Moved SL to break-even ($${breakEvenSL.toFixed(4)}).`,
          shouldForceExit: false,
        };
      }
    }

    // ── 4. Tighten on Degraded Data ──────────────────────────────
    // If we can't trust the data, reduce risk exposure.
    if (worldModel.dataQuality < 40 && rMultiple > 0) {
      const tightDistance = originalRiskDistance * 0.5;
      const newSL = isLong
        ? Math.max(currentSL, currentPrice - tightDistance)
        : Math.min(currentSL, currentPrice + tightDistance);

      const isTighter = isLong ? newSL > currentSL : newSL < currentSL;
      if (isTighter) {
        const updated = { ...position, stopLoss: newSL };
        return {
          updatedPosition: updated,
          action: 'TIGHTENED_STOP',
          message: `Data quality degraded (${worldModel.dataQuality}/100). Tightened SL to $${newSL.toFixed(4)} to protect capital.`,
          shouldForceExit: false,
        };
      }
    }

    // ── No change needed ─────────────────────────────────────────
    return {
      updatedPosition: position,
      action: 'NO_CHANGE',
      message: `Position healthy at ${rMultiple.toFixed(1)}R. No SL adjustment needed.`,
      shouldForceExit: false,
    };
  }
}

// ── Helper: Thesis Invalidation Detection ──────────────────────────

function isThesisInvalidated(position: OpenPosition, worldModel: MarketWorldModel): boolean {
  const isLong = position.direction === 'LONG';

  // A LONG position's thesis is invalidated when:
  // - Regime has flipped to STRONG_TREND_DOWN or PANIC
  // - Directional bias has become STRONG_BEAR
  if (isLong) {
    if (worldModel.regime === 'STRONG_TREND_DOWN' || worldModel.regime === 'PANIC') return true;
    if (worldModel.directionalBias === 'STRONG_BEAR') return true;
  }

  // A SHORT position's thesis is invalidated when:
  // - Regime has flipped to STRONG_TREND_UP or BREAKOUT (bullish)
  // - Directional bias has become STRONG_BULL
  if (!isLong) {
    if (worldModel.regime === 'STRONG_TREND_UP') return true;
    if (worldModel.regime === 'BREAKOUT' && worldModel.directionalBias === 'STRONG_BULL') return true;
    if (worldModel.directionalBias === 'STRONG_BULL') return true;
  }

  return false;
}
