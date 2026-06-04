import { SwingEngine } from "./swingEngine";

export class SignalEngine {
  static async analyze(assetKey: string = "BTC"): Promise<any> {
    const swingSignal = await SwingEngine.analyze(assetKey);
    
    // Map V6 SWING actions to V5 actions for Dashboard compatibility
    let mappedAction: 'BUY' | 'SHORT' | 'SELL' | 'COVER' | 'HOLD' = 'HOLD';
    if (swingSignal.action === 'SWING_BUY') {
      mappedAction = 'BUY';
    } else if (swingSignal.action === 'SWING_SHORT') {
      mappedAction = 'SHORT';
    }

    // Determine regime from reasoning
    let regime = "RANDOM";
    if (swingSignal.reasoning.includes("Mean Reversion")) {
      regime = "MEAN_REVERTING";
    } else if (swingSignal.reasoning.includes("Trend") || swingSignal.reasoning.includes("Structural")) {
      regime = "TRENDING";
    }

    // Map the 0-25 Swing score to a 0-100 scale for visual gauge compatibility
    const normalizedScore = Math.min(100, Math.max(0, 50 + (swingSignal.score * 2)));

    return {
      totalScore: normalizedScore,
      action: mappedAction,
      confidence: swingSignal.score / 25,
      regime,
      reasoning: swingSignal.reasoning,
      timestamp: new Date().toISOString(),
      timeframes: [] // Retain structure but keep empty to avoid old indicators bloat
    };
  }
}
