import { AutonomousDecision, Portfolio, Trade, OpenPosition, MarketWorldModel } from '@/lib/types';
import { FillSimulator } from './fillSimulator';
import { LiveExchange } from './liveExchange';
import { getEnv } from '@/lib/env';

export class PaperExchange {
  /**
   * Executes a risk-approved autonomous decision on the paper exchange.
   * Simulates fills with slippage, updates the portfolio, and returns the modified objects.
   */
  static async executeDecision(
    decision: AutonomousDecision,
    worldModel: MarketWorldModel,
    portfolio: Portfolio
  ): Promise<{ success: boolean; message: string; fillDetails?: any; updatedPortfolio: Portfolio; trade?: Trade; }> {
    
    if (decision.blockedByRisk) {
      return { success: false, message: decision.riskBlockReason || 'Blocked by risk governor.', updatedPortfolio: portfolio };
    }

    if (decision.action === 'HOLD' || decision.action === 'REQUEST_DATA') {
      return { success: true, message: `AI decided to ${decision.action}.`, updatedPortfolio: portfolio };
    }

    const { action, approvedSizeUsd, asset, riskAdjustedStopLoss, riskAdjustedTakeProfit } = decision;
    const currentPrice = worldModel.currentPrice;
    
    let fillPrice = 0;
    let feeIncurredUsd = 0;
    let liveExecutionId: string | undefined;

    const env = getEnv();
    const hasLiveKeys = !!(env.BINANCE_API_KEY || env.BYBIT_API_KEY);

    if (hasLiveKeys) {
      // ── LIVE TESTNET EXECUTION ─────────────────────────────────────
      const amount = approvedSizeUsd / currentPrice; // approximate size
      const targetExchange = env.BINANCE_API_KEY ? 'BINANCE' : 'BYBIT';
      const direction = action.includes('SHORT') || action === 'COVER' ? 'SHORT' : 'LONG';
      
      const liveRes = await LiveExchange.executeTrade(
        targetExchange,
        asset,
        direction,
        action,
        amount,
        currentPrice
      );

      if (!liveRes.success) {
        return { success: false, message: `Live Execution failed: ${liveRes.error}`, updatedPortfolio: portfolio };
      }

      fillPrice = liveRes.executedPrice || currentPrice;
      feeIncurredUsd = liveRes.feeUsd || 0;
      liveExecutionId = liveRes.orderId;
    } else {
      // ── PAPER SIMULATION ───────────────────────────────────────────
      const simulatedFill = FillSimulator.simulateFill(
        action,
        currentPrice,
        approvedSizeUsd,
        worldModel.volatilityRegime
      );

      if (!simulatedFill.success || !simulatedFill.fillPrice) {
        return { success: false, message: `Execution failed: ${simulatedFill.rejectionReason}`, updatedPortfolio: portfolio };
      }

      fillPrice = simulatedFill.fillPrice;
      feeIncurredUsd = simulatedFill.feeIncurredUsd;
    }
    portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + feeIncurredUsd;
    const actualUsdInvested = approvedSizeUsd;
    const amount = actualUsdInvested / fillPrice;
    const currentPosition = portfolio.openPositions?.[asset] || null;

    let pnl = 0;
    let pnlPercent = 0;
    let trade: Trade | undefined;

    // Execute the trade state changes
    if (action === 'BUY' && !currentPosition) {
      // ── Open LONG ──────────────────────────────────────────────────────────
      if (actualUsdInvested + feeIncurredUsd > portfolio.usd) {
         return { success: false, message: `Insufficient margin for BUY`, updatedPortfolio: portfolio };
      }
      portfolio.usd -= (actualUsdInvested + feeIncurredUsd);
      if (portfolio.balances) {
        portfolio.balances[asset] = (portfolio.balances[asset] || 0) + amount;
      }
      
      const newPos: OpenPosition = {
        asset,
        entryPrice: fillPrice,
        amount,
        btcAmount: amount, // legacy
        usdInvested: actualUsdInvested,
        stopLoss: riskAdjustedStopLoss || (fillPrice * 0.95), // Fallback
        takeProfit: riskAdjustedTakeProfit || (fillPrice * 1.05), // Fallback
        entryTime: new Date().toISOString(),
        signalScore: decision.confidence,
        reasoning: decision.thesis,
        direction: 'LONG',
        entryFeePaid: feeIncurredUsd
      };

      if (!portfolio.openPositions) portfolio.openPositions = {};
      portfolio.openPositions[asset] = newPos;

      trade = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        asset,
        action: 'BUY',
        direction: 'LONG',
        amount,
        btcAmount: amount,
        price: fillPrice,
        usdValue: actualUsdInvested,
        stopLoss: newPos.stopLoss,
        takeProfit: newPos.takeProfit,
        signalScore: decision.confidence,
        reasoning: decision.thesis
      };

     } else if (action === 'SELL' && currentPosition && currentPosition.direction === 'LONG') {
      // ── Close LONG ─────────────────────────────────────────────────────────
      const proceeds = currentPosition.amount * fillPrice;
      const netProceeds = proceeds - feeIncurredUsd;
      const entryFee = currentPosition.entryFeePaid || 0;
      pnl = netProceeds - currentPosition.usdInvested - entryFee;
      pnlPercent = (pnl / currentPosition.usdInvested) * 100;

      portfolio.usd += netProceeds;
      if (portfolio.balances) {
        portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - currentPosition.amount);
      }
      
      delete portfolio.openPositions[asset];
      
      trade = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        asset,
        action: 'SELL',
        direction: 'LONG',
        amount: currentPosition.amount,
        btcAmount: currentPosition.amount,
        price: fillPrice,
        usdValue: proceeds,
        stopLoss: currentPosition.stopLoss,
        takeProfit: currentPosition.takeProfit,
        signalScore: decision.confidence,
        reasoning: decision.thesis,
        pnl,
        pnlPercent,
        entryPrice: currentPosition.entryPrice,
        entryTime: currentPosition.entryTime,
        exitPrice: fillPrice,
        exitTime: new Date().toISOString(),
        exitReason: 'SIGNAL_REVERSAL'
      };

    } else if (action === 'SHORT' && !currentPosition) {
      // ── Open SHORT ─────────────────────────────────────────────────────────
      if (actualUsdInvested + feeIncurredUsd > portfolio.usd) {
         return { success: false, message: `Insufficient margin for SHORT`, updatedPortfolio: portfolio };
      }
      
      // Lock margin and deduct fee
      portfolio.usd -= (actualUsdInvested + feeIncurredUsd);

      const newPos: OpenPosition = {
        asset,
        entryPrice: fillPrice,
        amount,
        btcAmount: amount, // legacy
        usdInvested: actualUsdInvested,
        stopLoss: riskAdjustedStopLoss || (fillPrice * 1.05),
        takeProfit: riskAdjustedTakeProfit || (fillPrice * 0.95),
        entryTime: new Date().toISOString(),
        signalScore: decision.confidence,
        reasoning: decision.thesis,
        direction: 'SHORT',
        entryFeePaid: feeIncurredUsd
      };

      if (!portfolio.openPositions) portfolio.openPositions = {};
      portfolio.openPositions[asset] = newPos;

      trade = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        asset,
        action: 'SHORT',
        direction: 'SHORT',
        amount,
        btcAmount: amount,
        price: fillPrice,
        usdValue: actualUsdInvested,
        stopLoss: newPos.stopLoss,
        takeProfit: newPos.takeProfit,
        signalScore: decision.confidence,
        reasoning: decision.thesis
      };

    } else if (action === 'COVER' && currentPosition && currentPosition.direction === 'SHORT') {
      // ── Close SHORT ────────────────────────────────────────────────────────
      // Profit is made when exit price is LOWER than entry price.
      const grossPnl = (currentPosition.entryPrice - fillPrice) * currentPosition.amount;
      const entryFee = currentPosition.entryFeePaid || 0;
      pnl = grossPnl - entryFee - feeIncurredUsd;
      pnlPercent = (pnl / currentPosition.usdInvested) * 100;

      // Return margin + gross P&L - exit fee (i.e. margin + entryFee + netPnl)
      portfolio.usd += currentPosition.usdInvested + entryFee + pnl;

      delete portfolio.openPositions[asset];

      trade = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        asset,
        action: 'COVER',
        direction: 'SHORT',
        amount: currentPosition.amount,
        btcAmount: currentPosition.amount,
        price: fillPrice,
        usdValue: currentPosition.usdInvested + entryFee + pnl, // return value
        stopLoss: currentPosition.stopLoss,
        takeProfit: currentPosition.takeProfit,
        signalScore: decision.confidence,
        reasoning: decision.thesis,
        pnl,
        pnlPercent,
        entryPrice: currentPosition.entryPrice,
        entryTime: currentPosition.entryTime,
        exitPrice: fillPrice,
        exitTime: new Date().toISOString(),
        exitReason: 'SIGNAL_REVERSAL'
      };

    } else {
      return { success: false, message: `Invalid action sequence: ${action} with position state`, updatedPortfolio: portfolio };
    }

    // Update global portfolio metrics if a trade was closed
    if (action === 'SELL' || action === 'COVER') {
      portfolio.totalPnl += pnl;
      portfolio.totalTrades++;
      portfolio.returns.push(pnlPercent);
      if (portfolio.returns.length > 2000) {
        portfolio.returns.shift();
      }

      if (pnl >= 0) {
        portfolio.winningTrades++;
        portfolio.grossProfit += pnl;
        portfolio.consecutiveWins++;
        portfolio.consecutiveLosses = 0;
        portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
      } else {
        portfolio.losingTrades++;
        portfolio.grossLoss += Math.abs(pnl);
        portfolio.consecutiveLosses++;
        portfolio.consecutiveWins = 0;
        portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
      }
    }

    // Keep legacy single-position key in sync for backwards compatibility
    if (asset === 'BTC') {
      portfolio.openPosition = portfolio.openPositions?.[asset] || null;
      if (action === 'BUY' || action === 'SHORT') {
        portfolio.btc = amount;
      } else {
        portfolio.btc = 0;
      }
    }

    return {
      success: true,
      message: `Order filled via ${hasLiveKeys ? 'LiveExchange' : 'PaperExchange'}: ${action} $${actualUsdInvested.toFixed(2)}.`,
      updatedPortfolio: portfolio,
      trade
    };
  }
}
