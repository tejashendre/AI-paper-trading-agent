import { BrainDecision, AutonomousDecision, RiskGovernorLimits, Portfolio, MarketWorldModel, PredictionPerformanceSummary } from '@/lib/types';
import { SUPPORTED_ASSETS } from '@/lib/market';

// Default conservative risk parameters
const DEFAULT_LIMITS: RiskGovernorLimits = {
  maxLeverage: 1.0,
  maxDrawdownPercent: 15.0, // Stop all trading if portfolio drops 15% from peak
  maxPositionSizeUsd: 10000,
  minStopLossPercent: 0.5,
  maxStopLossPercent: 10.0,
  maxDailyTrades: 50,
  haltTradingIfDataBad: true,
};

export class AutonomousRiskGovernor {
  /**
   * Evaluates the Brain's raw decision against immutable risk laws.
   * Modifies sizes, enforces stops, or outright blocks the trade if unsafe.
   */
  static enforceRiskLimits(
    brainDecision: BrainDecision,
    worldModel: MarketWorldModel,
    portfolio: Portfolio,
    predictionStats?: PredictionPerformanceSummary,
    limits: RiskGovernorLimits = DEFAULT_LIMITS,
    btcWorldModel?: MarketWorldModel
  ): AutonomousDecision {
    const { action, suggestedSizeUsd, stopLossPrice, takeProfitPrice } = brainDecision;
    const currentPrice = worldModel.currentPrice;

    let blocked = false;
    let blockReason: string | null = null;
    let approvedSizeUsd = 0;
    let adjustedStopLoss = stopLossPrice;
    let adjustedTakeProfit = takeProfitPrice;

    // 1. Data Quality Halt
    if (limits.haltTradingIfDataBad && worldModel.dataQuality < 50) {
      if (action === 'BUY' || action === 'SHORT') {
        blocked = true;
        blockReason = `Data quality too low (${worldModel.dataQuality}/100) to safely enter a new position.`;
      }
    }

    // 2. Drawdown Halt
    if (portfolio.maxDrawdownPercent > limits.maxDrawdownPercent) {
      if (action === 'BUY' || action === 'SHORT') {
        blocked = true;
        blockReason = `Max drawdown exceeded (${portfolio.maxDrawdownPercent.toFixed(2)}% > ${limits.maxDrawdownPercent}%). Trading halted to protect capital.`;
      }
    }

    // 2.5 Macro-Correlation Matrix (Bitcoin Anchor)
    const isCryptoAlt = worldModel.asset !== 'BTC' && Object.keys(SUPPORTED_ASSETS).includes(worldModel.asset) && SUPPORTED_ASSETS[worldModel.asset]?.category === 'crypto';
    if (isCryptoAlt && btcWorldModel) {
      const btcBearish = btcWorldModel.regime === 'PANIC' || btcWorldModel.regime === 'STRONG_TREND_DOWN' || btcWorldModel.regime === 'WEAK_TREND_DOWN';
      const btcBullish = btcWorldModel.regime === 'STRONG_TREND_UP' || btcWorldModel.regime === 'WEAK_TREND_UP' || btcWorldModel.regime === 'BREAKOUT';
      
      if (action === 'BUY' && btcBearish) {
        blocked = true;
        blockReason = `Macro Correlation Block: BTC is ${btcWorldModel.regime}. Altcoin LONGs are vetoed to prevent fakeout losses.`;
      }
      
      if (action === 'SHORT' && btcBullish) {
        blocked = true;
        blockReason = `Macro Correlation Block: BTC is ${btcWorldModel.regime}. Altcoin SHORTs are vetoed to prevent short-squeeze losses.`;
      }
    }

    // 2.6 Conviction and Profitable logic bias check
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      if (action === 'BUY' && worldModel.biasScore < 8) {
        blocked = true;
        blockReason = `Low Conviction Block: Bias score ${worldModel.biasScore} is below the logical LONG entry requirement (>= 8).`;
      } else if (action === 'SHORT' && worldModel.biasScore > -8) {
        blocked = true;
        blockReason = `Low Conviction Block: Bias score ${worldModel.biasScore} is above the logical SHORT entry requirement (<= -8).`;
      }
    }

    // 2.7 Overlapping Position Filter (Decoupled Swing Strategy check)
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      const asset = worldModel.asset;
      const hasSwingPosition = portfolio.openPositions && portfolio.openPositions[asset];

      if (hasSwingPosition) {
        blocked = true;
        blockReason = `Exposure Governance Block: An open swing position already exists for ${asset}.`;
      }
    }

    // 2.7.5 Global Open Swing Limit
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      const openSwingCount = Object.keys(portfolio.openPositions || {}).length;
      if (openSwingCount >= 3) {
        blocked = true;
        blockReason = `Global Exposure Limit: You already have ${openSwingCount} open swing positions. Max allowed is 3.`;
      }
    }

    // 2.8 Cross-Asset Correlation Guard (Decoupled Swing check)
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      const asset = worldModel.asset;
      const cryptoGroup = ['BTC', 'ETH', 'SOL'];
      const commodityGroup = ['GOLD', 'SILVER'];

      let group: string[] | null = null;
      if (cryptoGroup.includes(asset)) group = cryptoGroup;
      if (commodityGroup.includes(asset)) group = commodityGroup;

      if (group) {
        let openCorrelatedCount = 0;
        for (const correlatedAsset of group) {
          if (correlatedAsset !== asset) {
            const hasSwing = portfolio.openPositions && portfolio.openPositions[correlatedAsset];
            if (hasSwing) {
              openCorrelatedCount++;
            }
          }
        }

        const maxAllowed = group === cryptoGroup ? 3 : 2;
        if (openCorrelatedCount >= maxAllowed) {
          blocked = true;
          blockReason = `Correlation Guard Block: You already have ${openCorrelatedCount} open swing positions in this correlated asset cluster (${group.join(', ')}). Max allowed is ${maxAllowed}.`;
        }
      }
    }

    // 2.9 Risk-to-Reward Ratio Governor (Enforces min 1.5:1 R:R)
    if (!blocked && (action === 'BUY' || action === 'SHORT') && stopLossPrice && takeProfitPrice) {
      const stopDistance = Math.abs(currentPrice - stopLossPrice);
      const profitDistance = Math.abs(takeProfitPrice - currentPrice);
      if (stopDistance > 0) {
        const rr = profitDistance / stopDistance;
        if (rr < 1.5) {
          // Adjust take profit to meet a strict 1.5x minimum R:R to "rip" the reward ratio properly
          if (action === 'BUY') {
            adjustedTakeProfit = currentPrice + (stopDistance * 1.5);
          } else {
            adjustedTakeProfit = currentPrice - (stopDistance * 1.5);
          }
        }
      }
    }

    // 3. Size Limits (Kelly Criterion Integration & Margin Ceiling)
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      let baseRisk = 0.05; // 5% base risk

      // Drawdown scaling modifier
      let drawdownMultiplier = 1.0;
      if (portfolio.peakValue > 0) {
        const activeMargin = (Object.values(portfolio.openPositions || {}) as any[]).reduce((sum, pos) => sum + (pos.usdInvested || 0), 0) +
          (Object.values((portfolio as any).scalpPositions || {}) as any[]).reduce((sum, pos) => sum + (pos.usdInvested || 0), 0);
        const totalVal = portfolio.usd + activeMargin;
        const currentDrawdown = (portfolio.peakValue - totalVal) / portfolio.peakValue;
        if (currentDrawdown > 0.08) {
          drawdownMultiplier = 0.25; // 75% size reduction in severe drawdown
        } else if (currentDrawdown > 0.05) {
          drawdownMultiplier = 0.50;  // 50% size reduction in moderate drawdown
        } else if (currentDrawdown > 0.03) {
          drawdownMultiplier = 0.75; // 25% size reduction in mild drawdown
        }
      }

      // True Kelly Sizing scaling modifier if prediction stats are available
      let kellyMultiplier = 1.0;
      if (predictionStats && predictionStats.totalResolved >= 10) {
        const w = Math.max(0.01, Math.min(0.99, predictionStats.accuracy));
        const r = 2.0;
        const kelly = w - ((1 - w) / r);
        if (kelly <= 0) {
          kellyMultiplier = 0.20; // 80% size reduction if edge is gone
        } else {
          kellyMultiplier = Math.max(0.25, Math.min(2.0, kelly / 0.10));
        }
      }

      let riskPercent = baseRisk * drawdownMultiplier * kellyMultiplier;
      riskPercent = Math.max(0.01, Math.min(0.10, riskPercent)); // Cap between 1% and 10%

      let targetSize = portfolio.usd * riskPercent;

      // If AI specifically suggested a smaller size, respect its caution
      if (suggestedSizeUsd && suggestedSizeUsd < targetSize) {
        targetSize = suggestedSizeUsd;
      }

      // Enforce hard ceiling on total margin utilized across all open positions (max 25% of portfolio total value)
      const currentActiveMargin = (Object.values(portfolio.openPositions || {}) as any[]).reduce((sum, pos) => sum + (pos.usdInvested || 0), 0) +
        (Object.values((portfolio as any).scalpPositions || {}) as any[]).reduce((sum, pos) => sum + (pos.usdInvested || 0), 0);
      const totalPortfolioValue = portfolio.usd + currentActiveMargin;
      const maxAllowedMargin = totalPortfolioValue * 0.25;

      if (currentActiveMargin >= maxAllowedMargin) {
        blocked = true;
        blockReason = `Margin Cap Block: Open positions utilize $${currentActiveMargin.toFixed(2)} margin, which is at or exceeds the 25% margin cap ($${maxAllowedMargin.toFixed(2)}).`;
      } else if (currentActiveMargin + targetSize > maxAllowedMargin) {
        const originalSize = targetSize;
        targetSize = Math.max(0, maxAllowedMargin - currentActiveMargin);
        if (targetSize < 10) {
          blocked = true;
          blockReason = `Margin Cap Block: Proposed trade of $${originalSize.toFixed(2)} would exceed the 25% margin cap ($${maxAllowedMargin.toFixed(2)}). Remaining margin room ($${targetSize.toFixed(2)}) is below the $10 minimum.`;
        }
      }

      // Cap at Risk Limits
      if (targetSize > limits.maxPositionSizeUsd) {
        targetSize = limits.maxPositionSizeUsd;
      }

      // Cap at available USD
      if (targetSize > portfolio.usd) {
        targetSize = portfolio.usd * 0.95; // Leave 5% buffer
      }

      // If available is too small, block
      if (targetSize < 10) {
        blocked = true;
        blockReason = "Insufficient USD balance to execute meaningful trade.";
      }

      approvedSizeUsd = targetSize;
    }

    // 4. Enforce Stop Loss Presence for New Positions
    if (!blocked && (action === 'BUY' || action === 'SHORT')) {
      if (!stopLossPrice) {
        blocked = true;
        blockReason = "AI proposed a trade without a stop loss. Denied by Risk Governor.";
      }
    }

    // Convert to Autonomous Decision
    return {
      ...brainDecision,
      id: crypto.randomUUID(),
      asset: worldModel.asset,
      approvedSizeUsd,
      riskAdjustedStopLoss: adjustedStopLoss,
      riskAdjustedTakeProfit: adjustedTakeProfit,
      blockedByRisk: blocked,
      riskBlockReason: blockReason,
      timestamp: new Date().toISOString()
    };
  }
}
