import { RiskParameters, Portfolio, OpenPosition, StatisticalMetrics } from "@/lib/types";

export class RiskManager {
  static calculatePosition(
    capital: number,
    riskPercent: number,
    entryPrice: number,
    atr: number,
    portfolio: Portfolio,
    assetKey: string = "BTC",
    direction: 'LONG' | 'SHORT' = 'LONG',
    stats?: StatisticalMetrics
  ): RiskParameters {
    const isForex = assetKey.includes("USD") && assetKey !== "GOLD" && assetKey !== "OIL";
    
    // Stop distance based on volatility (ATR). Squeezed tightly for Forex to match typical pips.
    let atrMultiplier = isForex ? 1.2 : 1.5;
    
    if (stats) {
      if (stats.hurstExponent > 0.55) {
        // High trend structure: tighten stops by 15% to lock in early momentum breakout
        atrMultiplier = atrMultiplier * 0.85;
      } else if (stats.hurstExponent < 0.45 || stats.volatilityPercentile > 75) {
        // High random noise or extreme volatility spike: expand stops by 35% to withstand spikes
        atrMultiplier = atrMultiplier * 1.35;
      }
    }

    const stopDistance = atr * atrMultiplier;
    const stopLoss = direction === 'SHORT' ? entryPrice + stopDistance : entryPrice - stopDistance;
    const takeProfit = direction === 'SHORT' ? entryPrice - (stopDistance * 2.0) : entryPrice + (stopDistance * 2.0);
    
    const riskAmount = capital * (riskPercent / 100);

    // Dynamic Equity Curve Drawdown Guard
    let adjustedRiskPercent = riskPercent;
    if (portfolio.peakValue > 0) {
      const currentDrawdown = (portfolio.peakValue - capital) / portfolio.peakValue;
      if (currentDrawdown > 0.08) {
        adjustedRiskPercent = riskPercent * 0.25; // 75% size reduction in severe drawdown
      } else if (currentDrawdown > 0.05) {
        adjustedRiskPercent = riskPercent * 0.5;  // 50% size reduction in moderate drawdown
      } else if (currentDrawdown > 0.03) {
        adjustedRiskPercent = riskPercent * 0.75; // 25% size reduction in mild drawdown
      }
    }

    // Correlation & Concentration Sizing Modifier
    let correlationMultiplier = 1.0;
    if (portfolio.openPositions) {
      const openKeys = Object.keys(portfolio.openPositions);
      if (openKeys.length > 0) {
        // 1. Sector correlation check (e.g., multi-crypto exposure)
        const isNewCrypto = assetKey === "BTC" || assetKey === "ETH" || assetKey === "SOL";
        const hasExistingCrypto = openKeys.some(k => k === "BTC" || k === "ETH" || k === "SOL");
        
        const isNewCommodity = assetKey === "GOLD" || assetKey === "SILVER";
        const hasExistingCommodity = openKeys.some(k => k === "GOLD" || k === "SILVER");
        
        if ((isNewCrypto && hasExistingCrypto) || (isNewCommodity && hasExistingCommodity)) {
          correlationMultiplier = correlationMultiplier * 0.65; // 35% risk reduction for sector concentration
        }
        
        // 2. Over-exposure scaling cap
        if (openKeys.length >= 3) {
          correlationMultiplier = correlationMultiplier * 0.60; // 40% risk reduction for broad overexposure
        } else if (openKeys.length === 2) {
          correlationMultiplier = correlationMultiplier * 0.80; // 20% risk reduction for moderate overexposure
        }
      }
    }
    
    adjustedRiskPercent = adjustedRiskPercent * correlationMultiplier;
    const dynamicRiskAmount = capital * (adjustedRiskPercent / 100);

    const positionSizeUsd = dynamicRiskAmount / (stopDistance / entryPrice);
    
    let amount = positionSizeUsd / entryPrice;
    let actualPositionUsd = positionSizeUsd;
    
    // Hard ceiling sizing per asset (Institutional risk parity allocation)
    const maxAllocationPercent = isForex ? 0.15 : 0.10; // Capped to ensure multi-asset diversification and prevent cash locks
    if (actualPositionUsd > capital * maxAllocationPercent) {
      actualPositionUsd = capital * maxAllocationPercent;
      amount = actualPositionUsd / entryPrice;
    }

    // Cap at available cash to prevent insufficient margin errors
    if (actualPositionUsd > portfolio.usd) {
      actualPositionUsd = portfolio.usd;
      amount = actualPositionUsd / entryPrice;
    }

    // Initialize Kelly Fraction calculations
    let kellyFraction = riskPercent / 100;
    const p = portfolio.totalTrades > 0 ? portfolio.winningTrades / portfolio.totalTrades : 0;
    const avgWin = portfolio.winningTrades > 0 ? portfolio.grossProfit / portfolio.winningTrades : 0;
    const avgLoss = portfolio.losingTrades > 0 ? portfolio.grossLoss / portfolio.losingTrades : 0;
    
    if (portfolio.totalTrades >= 8 && avgLoss > 0) {
      const b = avgWin / avgLoss;
      const f = (p * b - (1 - p)) / b;
      if (f > 0) {
        kellyFraction = f;
      } else {
        kellyFraction = 0;
      }
    }
    const halfKellyFraction = kellyFraction / 2;
    const var95 = capital * 0.05 * 1.645; // 95% Daily Value at Risk

    return {
      positionSizeBtc: amount, // Keep for backward type compatibility
      positionSizeUsd: actualPositionUsd,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2.0,
      riskAmount,
      riskPercent,
      kellyFraction,
      halfKellyFraction,
      var95
    };
  }

  static shouldTrade(portfolio: Portfolio, currentValue: number, assetKey: string = "BTC"): { allowed: boolean; reason: string } {
    // 1. Max portfolio drawdown guard (Institutional 10% draw cap)
    if (portfolio.peakValue > 0) {
      const dd = (portfolio.peakValue - currentValue) / portfolio.peakValue;
      if (dd > 0.10) {
        return { allowed: false, reason: "10% maximum portfolio drawdown reached" };
      }
    }

    // 2. Dynamic capital floor (lowered to $0.50 to allow micro-fractional trades)
    if (portfolio.usd < 0.50) {
      return { allowed: false, reason: "Insufficient USD capital (below $0.50 floor)" };
    }

    // 3. Prevent overlapping trades in the exact same asset
    if (portfolio.openPositions && portfolio.openPositions[assetKey]) {
      return { allowed: false, reason: `Active position in ${assetKey} already open` };
    }

    return { allowed: true, reason: "" };
  }

  static checkStopLossOrTakeProfit(
    position: OpenPosition,
    currentPrice: number
  ): { 
    triggered: boolean; 
    reason: "STOP_LOSS" | "TAKE_PROFIT" | null; 
    exitPrice: number;
    trailed?: boolean;
    newStopLoss?: number;
    newTakeProfit?: number;
  } {
    // ══════════════════════════════════════════════════════════════
    // High-Frequency Scalping Trailing Logic
    // ══════════════════════════════════════════════════════════════
    if (position.isScalp) {
      const isShort = position.direction === 'SHORT';
      const feesPercent = 0.0008;          // 0.08% total entry + exit taker fee rate
      const breakevenThreshold = 0.0015;   // Activate breakeven fee lock at +0.15% profit

      const currentProfitPercent = isShort
        ? (position.entryPrice - currentPrice) / position.entryPrice
        : (currentPrice - position.entryPrice) / position.entryPrice;

      // 1. Absolute Stop Loss & Take Profit limits
      if (isShort) {
        if (currentPrice >= position.stopLoss) {
          return { triggered: true, reason: "STOP_LOSS", exitPrice: position.stopLoss };
        }
      } else {
        if (currentPrice <= position.stopLoss) {
          return { triggered: true, reason: "STOP_LOSS", exitPrice: position.stopLoss };
        }
      }

      // 2. Dynamic Trailing Take Profit (Approaching Target Extension)
      const tpDistance = Math.abs(position.entryPrice - position.takeProfit);
      const progress = tpDistance > 0 ? (currentProfitPercent / (tpDistance / position.entryPrice)) : 0;
      if (progress >= 0.85) {
        const extension = tpDistance * 0.5;
        const newTakeProfit = isShort ? position.takeProfit - extension : position.takeProfit + extension;
        // Tighten stop-loss behind price to lock in significant gains (trail at 30% of target distance)
        const tightTrail = tpDistance * 0.3;
        const newStopLoss = isShort ? currentPrice + tightTrail : currentPrice - tightTrail;

        const isBetterStop = isShort ? newStopLoss < position.stopLoss : newStopLoss > position.stopLoss;
        if (isBetterStop) {
          return {
            triggered: false,
            reason: null,
            exitPrice: currentPrice,
            trailed: true,
            newStopLoss,
            newTakeProfit
          };
        }
      }

      // If TP extension wasn't triggered, check standard take profit limit
      if (isShort) {
        if (currentPrice <= position.takeProfit) {
          return { triggered: true, reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
        }
      } else {
        if (currentPrice >= position.takeProfit) {
          return { triggered: true, reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
        }
      }

      // 3. Breakeven Lock (Move Stop Loss to Entry + Transaction Fees)
      if (currentProfitPercent >= breakevenThreshold) {
        const breakevenPrice = isShort
          ? position.entryPrice * (1 - feesPercent) // lower than entry for short
          : position.entryPrice * (1 + feesPercent); // higher than entry for long
        
        const isBetterStop = isShort
          ? breakevenPrice < position.stopLoss
          : breakevenPrice > position.stopLoss;

        if (isBetterStop) {
          return { triggered: false, reason: null, exitPrice: currentPrice, trailed: true, newStopLoss: breakevenPrice };
        }
      }

      // 4. Micro-Trailing Stop: trail behind peak price at 80% of the entry ATR stop distance
      const originalStopDistance = Math.abs(position.entryPrice - position.stopLoss);
      const trailDistance = originalStopDistance * 0.8; // trail tightly at 0.8 * ATR

      if (isShort) {
        const potentialStop = currentPrice + trailDistance;
        if (potentialStop < position.stopLoss) {
          return { triggered: false, reason: null, exitPrice: currentPrice, trailed: true, newStopLoss: potentialStop };
        }
      } else {
        const potentialStop = currentPrice - trailDistance;
        if (potentialStop > position.stopLoss) {
          return { triggered: false, reason: null, exitPrice: currentPrice, trailed: true, newStopLoss: potentialStop };
        }
      }

      return { triggered: false, reason: null, exitPrice: currentPrice };
    }

    // ══════════════════════════════════════════════════════════════
    // Advanced Swing Trade Trailing Logic (Dynamic Watermark)
    // ══════════════════════════════════════════════════════════════
    const originalRiskPercent = Math.abs(position.entryPrice - position.stopLoss) / position.entryPrice;
    const activationThreshold = originalRiskPercent * 2.0; // Let swing winners breathe before hard trailing
    const trailDistancePercent = originalRiskPercent * 1.15; // Wider trail helps capture larger directional runs
    const isShort = position.direction === 'SHORT';

    // Track watermarks (Peak profitable price)
    let trailed = false;
    if (isShort) {
      if (!position.lowestPriceReached || currentPrice < position.lowestPriceReached) {
        position.lowestPriceReached = currentPrice;
        trailed = true; // Needs saving to portfolio
      }
    } else {
      if (!position.highestPriceReached || currentPrice > position.highestPriceReached) {
        position.highestPriceReached = currentPrice;
        trailed = true; // Needs saving to portfolio
      }
    }

    const watermarkProfitPercent = isShort
      ? (position.entryPrice - (position.lowestPriceReached || currentPrice)) / position.entryPrice
      : ((position.highestPriceReached || currentPrice) - position.entryPrice) / position.entryPrice;

    const currentProfitPercent = isShort
      ? (position.entryPrice - currentPrice) / position.entryPrice
      : (currentPrice - position.entryPrice) / position.entryPrice;

    // 1. Hard Stop Loss & Take Profit Trigger checks.
    // If price has already moved beyond the stop between checks, fill at the
    // current observed price instead of the stale stop level. This avoids
    // overstating paper fills when an invalid/stale trailing stop is crossed.
    if (isShort) {
      if (currentPrice >= position.stopLoss) return { triggered: true, reason: "STOP_LOSS", exitPrice: Math.max(currentPrice, position.stopLoss) };
      if (currentPrice <= position.takeProfit && !position.isTrailing) return { triggered: true, reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
    } else {
      if (currentPrice <= position.stopLoss) return { triggered: true, reason: "STOP_LOSS", exitPrice: Math.min(currentPrice, position.stopLoss) };
      if (currentPrice >= position.takeProfit && !position.isTrailing) return { triggered: true, reason: "TAKE_PROFIT", exitPrice: position.takeProfit };
    }

    // 2. Swing profit protection: protect fees first, then lock part of the move
    // only after the trade has already travelled far enough to avoid choking rallies.
    let newStopLoss = position.stopLoss;
    if (originalRiskPercent > 0 && currentProfitPercent >= originalRiskPercent * 1.0) {
      const feeBufferPercent = 0.001;
      const breakevenLockPercent = Math.max(feeBufferPercent, originalRiskPercent * 0.1);
      const protectedStop = isShort
        ? position.entryPrice * (1 - breakevenLockPercent)
        : position.entryPrice * (1 + breakevenLockPercent);
      const isBetterStop = isShort ? protectedStop < newStopLoss : protectedStop > newStopLoss;
      const isProtectiveStop = isShort ? protectedStop > currentPrice : protectedStop < currentPrice;
      if (isBetterStop && isProtectiveStop) {
        newStopLoss = protectedStop;
      }
    }

    if (originalRiskPercent > 0 && currentProfitPercent >= originalRiskPercent * 1.6) {
      const profitLockPercent = originalRiskPercent * 0.45;
      const protectedStop = isShort
        ? position.entryPrice * (1 - profitLockPercent)
        : position.entryPrice * (1 + profitLockPercent);
      const isBetterStop = isShort ? protectedStop < newStopLoss : protectedStop > newStopLoss;
      const isProtectiveStop = isShort ? protectedStop > currentPrice : protectedStop < currentPrice;
      if (isBetterStop && isProtectiveStop) {
        newStopLoss = protectedStop;
      }
    }

    // 3. Dynamic Trailing Stop calculation
    if (watermarkProfitPercent > activationThreshold) {
      position.isTrailing = true; // Once activated, we ignore the static Take Profit and let it run
      if (isShort) {
        const trailingStopLevel = (position.lowestPriceReached || currentPrice) * (1 + trailDistancePercent);
        if (trailingStopLevel < position.stopLoss && trailingStopLevel > currentPrice) {
          newStopLoss = trailingStopLevel;
        }
      } else {
        const trailingStopLevel = (position.highestPriceReached || currentPrice) * (1 - trailDistancePercent);
        if (trailingStopLevel > position.stopLoss && trailingStopLevel < currentPrice) {
          newStopLoss = trailingStopLevel;
        }
      }
    }

    if (newStopLoss !== position.stopLoss) {
      return { triggered: false, reason: null, exitPrice: currentPrice, trailed: true, newStopLoss };
    } else if (trailed) {
      // Return trailed true just to save the updated highestPriceReached
      return { triggered: false, reason: null, exitPrice: currentPrice, trailed: true };
    }

    return { triggered: false, reason: null, exitPrice: currentPrice };
  }
}
