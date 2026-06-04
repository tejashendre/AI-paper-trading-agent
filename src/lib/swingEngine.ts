import { Portfolio, OpenPosition, StatisticalMetrics, Timeframe, Candle } from "@/lib/types";
import { MarketService } from "./market";
import { computeAllIndicators, getLatestSnapshot } from "./indicators";
import { computeStatistics } from "./statistics";

export interface SwingSignal {
  asset: string;
  action: 'SWING_BUY' | 'SWING_SHORT' | 'HOLD';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  score: number;
  expectedMove?: number;
}

export class SwingEngine {
  /**
   * Analyzes an asset for higher-timeframe swing opportunities (15m, 1h, 4h).
   * Swings focus on robust structural moves, immune to 1m noise.
   */
  static async analyze(assetKey: string = "BTC"): Promise<SwingSignal> {
    try {
      // 1. Fetch multi-timeframe candles (Higher Timeframes)
      const [candles15m, candles1h, candles4h] = await Promise.all([
        MarketService.getCandles("15m", 100, assetKey),
        MarketService.getCandles("1h", 100, assetKey),
        MarketService.getCandles("4h", 100, assetKey)
      ]);

      if (candles15m.length === 0 || candles1h.length === 0 || candles4h.length === 0) {
        return { asset: assetKey, action: "HOLD", entryPrice: 0, stopLoss: 0, takeProfit: 0, reasoning: "Insufficient historical data", score: 0, expectedMove: 0 };
      }

      // Compute indicators
      const ind15m = computeAllIndicators(candles15m);
      const ind1h = computeAllIndicators(candles1h);
      const ind4h = computeAllIndicators(candles4h);

      const snap15m = getLatestSnapshot(candles15m, ind15m);
      const snap1h = getLatestSnapshot(candles1h, ind1h);
      const snap4h = getLatestSnapshot(candles4h, ind4h);

      const stats15m = computeStatistics(candles15m, snap15m, ind15m.atr);
      const stats1h = computeStatistics(candles1h, snap1h, ind1h.atr);
      const stats4h = computeStatistics(candles4h, snap4h, ind4h.atr);
      
      const currentPrice = snap15m.price;

      // 2. Regime Filter Setup (Based on 1H structural data)
      const isMeanReverting = stats1h.hurstExponent < 0.55;
      const isVolatilitySqueeze = stats1h.volatilityPercentile < 30;

      // 3. Quantitative Confluence Signal Calculations
      let buyScore = 0;
      let shortScore = 0;
      const details: string[] = [];

      // A. HTF Z-Score Reversion (1H)
      const zScore1h = stats1h.priceZScore;
      if (isMeanReverting) {
        if (zScore1h < -2.5) {
          buyScore += 10;
          details.push(`1H Z-Score Oversold (${zScore1h.toFixed(2)}) + Mean Reversion`);
        } else if (zScore1h > 2.5) {
          shortScore += 10;
          details.push(`1H Z-Score Overbought (${zScore1h.toFixed(2)}) + Mean Reversion`);
        }
      }

      // B. Structural Momentum Breakout (4H)
      if (stats4h.hurstExponent > 0.60) {
        if (stats4h.regressionSlope > 0 && stats1h.priceZScore < 1.0) {
          buyScore += 8;
          details.push(`4H Structural Uptrend (Hurst: ${stats4h.hurstExponent.toFixed(2)})`);
        } else if (stats4h.regressionSlope < 0 && stats1h.priceZScore > -1.0) {
          shortScore += 8;
          details.push(`4H Structural Downtrend (Hurst: ${stats4h.hurstExponent.toFixed(2)})`);
        }
      }

      // C. HTF Volatility Squeeze Breakout
      if (stats4h.volatilityPercentile < 20 && stats1h.volatilityPercentile > 40) {
        if (stats1h.regressionSlope > 0) {
          buyScore += 6;
          details.push("HTF Volatility Squeeze Breakout (Bullish)");
        } else {
          shortScore += 6;
          details.push("HTF Volatility Squeeze Breakout (Bearish)");
        }
      }

      // D. Institutional VWAP Deviations (15m execution trigger)
      const vwapDeviation = (currentPrice - snap15m.vwap) / snap15m.vwap;
      if (isMeanReverting) {
        if (vwapDeviation < -0.015) { // 1.5% below VWAP is extreme for 15m
          buyScore += 5;
          details.push("Extreme HTF VWAP Deviation (Oversold)");
        } else if (vwapDeviation > 0.015) {
          shortScore += 5;
          details.push("Extreme HTF VWAP Deviation (Overbought)");
        }
      }

      // 4. Determine Action
      let action: 'SWING_BUY' | 'SWING_SHORT' | 'HOLD' = 'HOLD';
      let finalScore = 0;
      // Require strong HTF alignment (score >= 14)
      if (buyScore >= 14 && buyScore > shortScore) {
        action = 'SWING_BUY';
        finalScore = buyScore;
      } else if (shortScore >= 14 && shortScore > buyScore) {
        action = 'SWING_SHORT';
        finalScore = shortScore;
      }

      if (action === 'HOLD') {
        return {
          asset: assetKey,
          action: "HOLD",
          entryPrice: currentPrice,
          stopLoss: 0,
          takeProfit: 0,
          reasoning: "Waiting for robust HTF statistical confluence (Score < 14)",
          score: Math.max(buyScore, shortScore)
        };
      }

      // 5. Dynamic Wide HTF Stops
      // In swing trading, ATR is larger, and we use a 1.5x / 3.0x multiplier.
      const htfAtr = snap1h.atr;
      const expectedMovePercent = (htfAtr / currentPrice) * 100;

      const stopDistance = htfAtr * 1.5;
      const takeProfitDistance = htfAtr * 3.0;

      const stopLoss = action === 'SWING_BUY' ? currentPrice - stopDistance : currentPrice + stopDistance;
      const takeProfit = action === 'SWING_BUY' ? currentPrice + takeProfitDistance : currentPrice - takeProfitDistance;

      return {
        asset: assetKey,
        action,
        entryPrice: currentPrice,
        stopLoss,
        takeProfit,
        reasoning: `HTF Confluence ${finalScore}. Signals: ${details.join(" | ")}. Expected spread ${expectedMovePercent.toFixed(2)}%`,
        score: finalScore,
        expectedMove: expectedMovePercent
      };
    } catch (err) {
      return {
        asset: assetKey,
        action: "HOLD",
        entryPrice: 0,
        stopLoss: 0,
        takeProfit: 0,
        reasoning: `Swing scan failed: ${err instanceof Error ? err.message : String(err)}`,
        score: 0,
        expectedMove: 0
      };
    }
  }
}
