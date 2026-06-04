import { OrderFill, ExecutionQuality, SlippageEstimate, VolatilityRegime } from '@/lib/types';
import { SlippageModel } from './slippageModel';
export class FillSimulator {
  /**
   * Simulates the filling of an order, applying realistic slippage and fees.
   * Also handles rare cases like gap-throughs and illiquidity rejections.
   */
  static simulateFill(
    action: 'BUY' | 'SELL' | 'SHORT' | 'COVER',
    requestedPrice: number,
    sizeUsd: number,
    volatilityRegime: VolatilityRegime,
    isScalp: boolean = false
  ): OrderFill {
    
    // 1. Estimate slippage
    const slippageEst = SlippageModel.estimate(requestedPrice, sizeUsd, volatilityRegime);
    
    // Randomize actual slippage based on estimate (0 to 1.5x expected)
    const randomFactor = Math.random() * 1.5;
    const actualSlippagePct = slippageEst.expectedSlippagePercent * randomFactor;
    
    // Calculate fill price
    // BUY/COVER slippage means paying a HIGHER price
    // SELL/SHORT slippage means receiving a LOWER price
    const slippageAmount = requestedPrice * (actualSlippagePct / 100);
    const fillPrice = (action === 'BUY' || action === 'COVER') 
      ? requestedPrice + slippageAmount 
      : requestedPrice - slippageAmount;

    const slippageIncurredUsd = sizeUsd * (actualSlippagePct / 100);
    const feeBps = isScalp ? 0.05 : 0.02; // 5 basis points for scalp (taker), 2 basis points for swing (maker)
    const feeIncurredUsd = sizeUsd * (feeBps / 100);

    // Determine quality rating
    let quality: ExecutionQuality = 'PERFECT';
    if (actualSlippagePct > 0.01) quality = 'SLIPPED';
    
    // Extreme volatility edge cases (1% chance in extreme regimes)
    let success = true;
    let rejectionReason: string | null = null;
    
    if (volatilityRegime === 'EXTREME' && Math.random() < 0.01) {
      if (Math.random() < 0.5) {
        success = false;
        quality = 'REJECTED_ILLIQUID';
        rejectionReason = "Order rejected due to lack of orderbook liquidity during extreme volatility.";
      } else {
        quality = 'GAP_THROUGH';
      }
    }

    return {
      success,
      fillPrice,
      requestedPrice,
      slippageIncurredUsd,
      feeIncurredUsd,
      quality,
      rejectionReason,
      timestamp: new Date().toISOString()
    };
  }
}
