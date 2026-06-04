import { SlippageEstimate, VolatilityRegime } from '@/lib/types';

export class SlippageModel {
  /**
   * Estimates slippage based on volatility regime and trade size.
   * Higher volatility and larger sizes cause more slippage.
   */
  static estimate(
    price: number,
    sizeUsd: number,
    volatilityRegime: VolatilityRegime
  ): SlippageEstimate {
    // Base slippage % by regime
    let baseSlippagePct = 0;
    switch (volatilityRegime) {
      case 'ULTRA_LOW': baseSlippagePct = 0.01; break;
      case 'LOW': baseSlippagePct = 0.02; break;
      case 'NORMAL': baseSlippagePct = 0.05; break;
      case 'HIGH': baseSlippagePct = 0.15; break;
      case 'EXTREME': baseSlippagePct = 0.50; break;
    }

    // Size multiplier: > $10,000 adds slippage
    const sizeMultiplier = sizeUsd > 10000 ? 1 + Math.log10(sizeUsd / 10000) : 1;
    
    const expectedSlippagePercent = baseSlippagePct * sizeMultiplier;
    const expectedSlippageUsd = sizeUsd * (expectedSlippagePercent / 100);
    
    // Worst case is 3x expected
    const worstCaseSlippageUsd = expectedSlippageUsd * 3;

    return {
      expectedSlippagePercent,
      expectedSlippageUsd,
      worstCaseSlippageUsd
    };
  }
}
