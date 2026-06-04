import { getEnv } from '@/lib/env';
import { MarketWorldModel, OpenPosition, BrainDecision, AutonomousDecision, Portfolio } from '@/lib/types';
import { getPredictionPerformanceSummary, savePredictionFromDecision } from './predictionLedger';
import { buildAutonomousPrompt } from './prompts/autonomousDecisionPrompt';
import { brainDecisionSchema } from './schemas';
import { AutonomousRiskGovernor } from './autonomousRiskGovernor';
import { LLMProxy } from '@/lib/llmProxy';
import { MarketService } from '@/lib/market';
import { computeAllIndicators, getLatestSnapshot } from '@/lib/indicators';

export class AutonomousBrain {
  private static decisionCache = new Map<string, { decision: AutonomousDecision, timestamp: number, price: number }>();

  /**
   * The core cognitive loop.
   * 1. Reads the world model
   * 2. Prompts Gemini 2.0 Flash
   * 3. Parses and validates the strict JSON output
   * 4. Passes the raw decision through the Risk Governor
   */
  static async evaluateMarket(
    worldModel: MarketWorldModel,
    portfolio: Portfolio,
    openPositions: OpenPosition[],
    recentLessons: string[] = [],
    btcWorldModel?: MarketWorldModel
  ): Promise<AutonomousDecision> {
    
    const predictionStats = await getPredictionPerformanceSummary();

    // 1.5 Check Cached Decisions
    const cached = this.decisionCache.get(worldModel.asset);
    if (cached && (Date.now() - cached.timestamp < 3 * 60_000)) {
      // If price hasn't moved more than 0.5%
      if (Math.abs(cached.price - worldModel.currentPrice) / cached.price < 0.005) {
         console.log(`[AutonomousBrain] Using cached decision for ${worldModel.asset} (Price moved < 0.5%)`);
         return cached.decision;
      }
    }

    // 2. Query LLM & Validate (Failover Proxy with strict Zod parsing)
    let rawDecision: BrainDecision | null = null;
    let turnCount = 0;
    let requestedContext = '';

    while (turnCount < 2) {
      const prompt = buildAutonomousPrompt(
        worldModel,
        openPositions,
        portfolio.usd,
        recentLessons,
        predictionStats,
        requestedContext
      );

      try {
        rawDecision = await LLMProxy.queryAndValidate<BrainDecision>(prompt, brainDecisionSchema as any, 45000);
        
        if (rawDecision.action === 'REQUEST_DATA') {
          turnCount++;
          const timeframe = (rawDecision.dataRequest?.timeframe || '1d') as any;
          try {
            console.log(`[AutonomousBrain] AI requested deeper context: ${timeframe}`);
            const candles = await MarketService.getCandles(timeframe, 100, worldModel.asset);
            const series = computeAllIndicators(candles);
            const latest = getLatestSnapshot(candles, series);
            requestedContext = `Requested Timeframe (${timeframe}):\nClose: $${candles[candles.length - 1].close}\nRSI: ${latest.rsi.toFixed(2)}\nMACD: ${latest.macd.line.toFixed(2)}\nEMA 20: $${latest.ema21.toFixed(2)}\nATR: ${latest.atr.toFixed(2)}`;
          } catch (e: any) {
            requestedContext = `Failed to fetch data for ${timeframe}: ${e.message}`;
          }
          continue; // Loop back and query again
        } else {
          break; // Final decision reached
        }
      } catch (err: any) {
        console.error("[AutonomousBrain] Critical LLM failure:", err);
        // ── Enhanced Statistical Fallback ──────────────────────────
        // When all LLM providers are rate-limited (HTTP 429), we use
        // the world model's mathematical signals to trade autonomously.
        const score = worldModel.biasScore;
        const absScore = Math.abs(score);
        const price = worldModel.currentPrice;
        const atrPercent = worldModel.atrPercent || 1.0; // ATR as % of price
        const atr = price * (atrPercent / 100);
        const regime = worldModel.regime;

        let fallbackAction: 'BUY' | 'SHORT' | 'HOLD' = 'HOLD';
        let thesis = `LLM parsing or network failure: ${err.message}. Defaulting to HOLD for safety.`;
        let sl: number | null = null;
        let tp: number | null = null;

        // Regime-aware thresholds: strong trends need lower confluence
        const isTrending = regime === 'STRONG_TREND_UP' || regime === 'STRONG_TREND_DOWN'
          || regime === 'WEAK_TREND_UP' || regime === 'WEAK_TREND_DOWN'
          || regime === 'BREAKOUT' || regime === 'PANIC';
        const entryThreshold = isTrending ? 10 : 18;

        if (score >= entryThreshold) {
           fallbackAction = 'BUY';
           // ATR-calibrated stops: 1.5x ATR stop, 2.5x ATR target (1.67:1 R:R minimum)
           sl = price - (atr * 1.5);
           tp = price + (atr * 2.5);
           thesis = `[STAT FALLBACK] BUY — Bias ${score}, Regime ${regime}, ATR ${atrPercent.toFixed(2)}%. SL $${sl.toFixed(2)}, TP $${tp.toFixed(2)}. Pure math execution.`;
        } else if (score <= -entryThreshold) {
           fallbackAction = 'SHORT';
           sl = price + (atr * 1.5);
           tp = price - (atr * 2.5);
           thesis = `[STAT FALLBACK] SHORT — Bias ${score}, Regime ${regime}, ATR ${atrPercent.toFixed(2)}%. SL $${sl.toFixed(2)}, TP $${tp.toFixed(2)}. Pure math execution.`;
        }

        // Confidence scales with bias strength: 20→0.45, 40→0.60, 60→0.75, 80→0.85
        const confidence = fallbackAction !== 'HOLD'
          ? Math.min(0.90, 0.35 + (absScore / 100) * 0.55)
          : 0;

        rawDecision = {
          action: fallbackAction,
          confidence,
          conviction: absScore > 60 ? 'HIGH' : absScore > 35 ? 'MEDIUM' : 'LOW',
          thesis,
          takeProfitPrice: tp,
          stopLossPrice: sl,
          suggestedSizeUsd: null,
          timeHorizon: isTrending ? 'SWING' : 'DAY',
          expected15mDirection: score > 0 ? 'UP' : 'DOWN',
          expected1hDirection: score > 0 ? 'UP' : 'DOWN',
          expected4hDirection: score > 0 ? 'UP' : 'DOWN',
        };
        console.log(`[AutonomousBrain] Statistical fallback: ${fallbackAction} ${worldModel.asset} (bias=${score}, threshold=${entryThreshold}, regime=${regime})`);
        break;
      }
    }

    if (!rawDecision || rawDecision.action === 'REQUEST_DATA') {
      rawDecision = {
        action: 'HOLD',
        confidence: 0,
        conviction: 'LOW',
        thesis: `AI stuck in data request loop. Defaulting to HOLD.`,
        takeProfitPrice: null,
        stopLossPrice: null,
        suggestedSizeUsd: null,
        timeHorizon: 'DAY',
        expected15mDirection: 'SIDEWAYS',
        expected1hDirection: 'SIDEWAYS',
        expected4hDirection: 'SIDEWAYS',
      };
    }

    // 4. Pass through Risk Governor
    const finalDecision = AutonomousRiskGovernor.enforceRiskLimits(
      rawDecision,
      worldModel,
      portfolio,
      predictionStats,
      undefined,
      btcWorldModel
    );

    // 5. Log prediction to ledger
    if (finalDecision.action !== 'HOLD') {
      // Don't await to avoid blocking the main execution path
      savePredictionFromDecision(finalDecision, worldModel.currentPrice).catch(console.error);
    }

    this.decisionCache.set(worldModel.asset, { decision: finalDecision, timestamp: Date.now(), price: worldModel.currentPrice });

    return finalDecision;
  }
}
