import { MarketRegime } from '@/lib/types';

/**
 * Returns regime-specific trading principles to inject into the LLM prompt.
 * This prevents the AI from using trend-following logic in a range, or vice-versa.
 */
export function getTradingKnowledge(regime: MarketRegime): string {
  switch (regime) {
    case 'STRONG_TREND_UP':
      return `REGIME PRINCIPLES: STRONG UPTREND
- Do not fight the trend. Look for pullbacks to dynamic support (EMA21/VWAP) to buy.
- Breakouts of resistance are high probability.
- Shorting is strictly prohibited unless clear structural failure (LH + LL) occurs.
- Hold winners longer. Trail stop loss under recent swing lows.`;
      
    case 'WEAK_TREND_UP':
      return `REGIME PRINCIPLES: WEAK UPTREND
- Price is grinding higher but momentum is weak.
- Buying breakouts is risky; prefer buying at established support or lower Bollinger band.
- Take profits at resistance; do not expect massive follow-through.
- Keep position sizes moderate.`;

    case 'STRONG_TREND_DOWN':
      return `REGIME PRINCIPLES: STRONG DOWNTREND
- Do not catch falling knives. Look for rallies into dynamic resistance (EMA21/VWAP) to short.
- Breakdowns of support are high probability.
- Buying is strictly prohibited unless clear structural failure (HL + HH) occurs.
- Trail stop loss above recent swing highs.`;

    case 'WEAK_TREND_DOWN':
      return `REGIME PRINCIPLES: WEAK DOWNTREND
- Price is bleeding lower but lacks aggressive selling.
- Shorting breakdowns is risky; prefer shorting at established resistance or upper Bollinger band.
- Take profits at support; do not expect a crash.
- Keep position sizes moderate.`;

    case 'MEAN_REVERTING':
      return `REGIME PRINCIPLES: CHOP / MEAN REVERSION
- Buy the lower bound of the range/Bollinger Band, sell the upper bound.
- Breakouts and breakdowns will likely fail (fakeouts). Do not trade breakouts.
- Rely heavily on oscillators (RSI, StochRSI). Overbought = short, Oversold = buy.
- Keep stops tight outside the range.`;

    case 'SQUEEZE':
      return `REGIME PRINCIPLES: VOLATILITY SQUEEZE
- Volatility is artificially low. A massive expansion is imminent.
- Do NOT trade mean-reversion. Oscillators are useless here.
- Prepare to trade the breakout. If price breaks resistance with volume, BUY. If support breaks, SHORT.
- Place wider stops to survive the initial fakeout/liquidation wick.`;

    case 'BREAKOUT':
      return `REGIME PRINCIPLES: MOMENTUM BREAKOUT
- Volatility has just expanded. The market is choosing a direction.
- Do not fade this move. Enter in the direction of the break.
- If long, place stop loss just inside the broken resistance (now support).
- Ride the momentum until volume dries up or divergence appears.`;

    case 'PANIC':
      return `REGIME PRINCIPLES: PANIC / LIQUIDATION CASCADE
- Extreme fear and aggressive forced selling.
- Wait for a climatic volume spike and a long lower wick (hammer) to signal exhaustion.
- Counter-trend bounces (dead cat bounces) can be violent and highly profitable.
- Keep tight stops; if the knife keeps falling, exit immediately.`;

    case 'FAKEOUT_RISK':
      return `REGIME PRINCIPLES: LOW-CONVICTION BREAKOUT
- A structure broke, but without volume or momentum backing it.
- High probability of a trap. Be highly skeptical of the current direction.
- Wait for confirmation or trade the failure (e.g., if a bullish breakout fails, aggressively short).
- Reduce position size.`;

    case 'RANDOM':
      return `REGIME PRINCIPLES: NO CLEAR EDGE
- Price action is erratic. Statistical edge is low.
- Capital preservation is the priority.
- Default to HOLD unless there is overwhelming multi-timeframe confluence.
- If you must trade, use minimal size and scalp quick profits.`;

    default:
      return `REGIME PRINCIPLES: GENERAL
- Protect capital first. Cut losers quickly, let winners run.
- Trade in the direction of the primary trend.
- Use confluence: don't rely on a single indicator.`;
  }
}
