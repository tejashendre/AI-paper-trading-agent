/**
 * V4 Institutional Web Worker
 * Offloads heavy mathematical backtesting simulations and Monte Carlo paths to the client CPU.
 * Prevents Vercel free-tier serverless execution timeouts (10s cap).
 */

self.onmessage = function (e) {
  const { type, data } = e.data;

  if (type === "BACKTEST") {
    const { candles, riskPercent = 2 } = data;
    try {
      const results = runBacktest(candles, riskPercent);
      self.postMessage({ type: "BACKTEST_SUCCESS", data: results });
    } catch (err) {
      self.postMessage({ type: "ERROR", error: err.message });
    }
  }

  if (type === "MONTE_CARLO") {
    const { currentPrice, volatility, paths = 1000, steps = 24 } = data;
    try {
      const results = runMonteCarlo(currentPrice, volatility, paths, steps);
      self.postMessage({ type: "MONTE_CARLO_SUCCESS", data: results });
    } catch (err) {
      self.postMessage({ type: "ERROR", error: err.message });
    }
  }
};

// ==================== Simple Technical Indicators ====================

function calculateRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

function calculateEMA(closes, period) {
  const ema = [];
  if (closes.length === 0) return ema;
  const k = 2 / (period + 1);
  let prevEma = closes[0];
  ema.push(prevEma);

  for (let i = 1; i < closes.length; i++) {
    const current = closes[i] * k + prevEma * (1 - k);
    ema.push(current);
    prevEma = current;
  }
  return ema;
}

function calculateATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(0);
  if (candles.length <= 1) return atr;

  const trs = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    );
    trs.push(tr);
  }

  let sum = trs.slice(0, period).reduce((s, x) => s + x, 0);
  atr[period - 1] = sum / period;

  for (let i = period; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ==================== Backtesting Simulation Engine ====================

function runBacktest(candles, riskPercent) {
  if (candles.length < 50) {
    throw new Error("Insufficient historical data for simulation (minimum 50 candles required)");
  }

  const closes = candles.map(c => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(candles, 14);

  let usd = 10000;
  let shares = 0;
  let activeTrade = null;
  const trades = [];
  let peakValue = 10000;
  let maxDrawdown = 0;

  for (let i = 50; i < candles.length; i++) {
    const price = candles[i].close;
    const currentAtr = atr[i] || (price * 0.02);

    // 1. Portfolio Value Tracking
    const portfolioValue = usd + shares * price;
    if (portfolioValue > peakValue) peakValue = portfolioValue;
    const dd = (peakValue - portfolioValue) / peakValue;
    if (dd > maxDrawdown) maxDrawdown = dd;

    // 2. Check Active Position Stop/Take targets
    if (activeTrade) {
      if (price <= activeTrade.stopLoss) {
        // Stop Loss triggered
        usd += shares * activeTrade.stopLoss;
        const pnl = (shares * activeTrade.stopLoss) - activeTrade.usdInvested;
        trades.push({
          entryPrice: activeTrade.entryPrice,
          exitPrice: activeTrade.stopLoss,
          exitTime: candles[i].time,
          usdInvested: activeTrade.usdInvested,
          pnl,
          pnlPercent: (pnl / activeTrade.usdInvested) * 100,
          outcome: "STOP_LOSS"
        });
        shares = 0;
        activeTrade = null;
        continue;
      }

      if (price >= activeTrade.takeProfit) {
        // Take Profit triggered
        usd += shares * activeTrade.takeProfit;
        const pnl = (shares * activeTrade.takeProfit) - activeTrade.usdInvested;
        trades.push({
          entryPrice: activeTrade.entryPrice,
          exitPrice: activeTrade.takeProfit,
          exitTime: candles[i].time,
          usdInvested: activeTrade.usdInvested,
          pnl,
          pnlPercent: (pnl / activeTrade.usdInvested) * 100,
          outcome: "TAKE_PROFIT"
        });
        shares = 0;
        activeTrade = null;
        continue;
      }

      // Exit Signal: SMA Crossover reversal
      if (ema9[i] < ema21[i]) {
        usd += shares * price;
        const pnl = (shares * price) - activeTrade.usdInvested;
        trades.push({
          entryPrice: activeTrade.entryPrice,
          exitPrice: price,
          exitTime: candles[i].time,
          usdInvested: activeTrade.usdInvested,
          pnl,
          pnlPercent: (pnl / activeTrade.usdInvested) * 100,
          outcome: "REVERSAL"
        });
        shares = 0;
        activeTrade = null;
        continue;
      }
    }

    // 3. Entry Signals Crossover Logic (EMA Stack + RSI Momentum)
    if (!activeTrade) {
      const isBullishStack = ema9[i] > ema21[i] && ema21[i] > ema50[i];
      const isRsiBullish = rsi[i] > 50 && rsi[i] < 70;

      if (isBullishStack && isRsiBullish) {
        // Size Position via ATR Volatility
        const stopDistance = currentAtr * 1.5;
        const stopLoss = price - stopDistance;
        const takeProfit = price + (stopDistance * 2);

        const riskAmount = portfolioValue * (riskPercent / 100);
        let sizeUsd = riskAmount / (stopDistance / price);

        if (sizeUsd > usd * 0.95) sizeUsd = usd * 0.95;

        if (sizeUsd > 10) {
          shares = sizeUsd / price;
          usd -= sizeUsd;
          activeTrade = {
            entryPrice: price,
            usdInvested: sizeUsd,
            stopLoss,
            takeProfit
          };
        }
      }
    }
  }

  // Close any lingering trade at simulation end
  const finalPrice = candles[candles.length - 1].close;
  if (activeTrade) {
    usd += shares * finalPrice;
    const pnl = (shares * finalPrice) - activeTrade.usdInvested;
    trades.push({
      entryPrice: activeTrade.entryPrice,
      exitPrice: finalPrice,
      exitTime: candles[candles.length - 1].time,
      usdInvested: activeTrade.usdInvested,
      pnl,
      pnlPercent: (pnl / activeTrade.usdInvested) * 100,
      outcome: "END_SIM"
    });
  }

  // Calculate Metrics
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.pnl > 0).length;
  const losingTrades = totalTrades - winningTrades;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const totalReturn = usd - 10000;
  const totalReturnPercent = (totalReturn / 10000) * 100;

  const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  // Institutional Risk Ratios
  const returns = trades.map(t => t.pnlPercent);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length || 1);
  const stdDev = Math.sqrt(variance);

  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  const downsideReturns = returns.filter(r => r < 0);
  const downsideVariance = downsideReturns.reduce((a, b) => a + Math.pow(b, 2), 0) / (downsideReturns.length || 1);
  const downsideStdDev = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideStdDev > 0 ? (meanReturn / downsideStdDev) * Math.sqrt(252) : 0;

  return {
    totalTrades,
    winningTrades,
    losingTrades,
    winRate,
    profitFactor,
    totalReturnPercent,
    maxDrawdownPercent: maxDrawdown * 100,
    sharpeRatio,
    sortinoRatio,
    trades: trades.slice(-30) // Return last 30 trades for visual logging
  };
}

// ==================== Monte Carlo Price Simulator ====================

function runMonteCarlo(currentPrice, volatility, pathsCount, stepsCount) {
  const paths = [];
  const dt = 1 / stepsCount; // step size in daily units

  for (let p = 0; p < pathsCount; p++) {
    const singlePath = [currentPrice];
    let price = currentPrice;
    for (let s = 0; s < stepsCount; s++) {
      // Box-Muller transform for normal distribution rand value
      const u1 = Math.random();
      const u2 = Math.random();
      const randNormal = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

      // Geometric Brownian Motion (GBM) equation
      const drift = 0.0; // Assume zero drift for short term daily forecast
      const shock = price * volatility * Math.sqrt(dt) * randNormal;
      price = price + price * drift * dt + shock;
      singlePath.push(price);
    }
    paths.push(singlePath);
  }

  // Calculate quantile distributions for shading (e.g. 5%, 25%, 50%, 75%, 95%)
  const distributions = [];
  for (let s = 0; s <= stepsCount; s++) {
    const stepPrices = paths.map(p => p[s]).sort((a, b) => a - b);
    distributions.push({
      step: s,
      q05: stepPrices[Math.floor(pathsCount * 0.05)] || currentPrice,
      q25: stepPrices[Math.floor(pathsCount * 0.25)] || currentPrice,
      median: stepPrices[Math.floor(pathsCount * 0.50)] || currentPrice,
      q75: stepPrices[Math.floor(pathsCount * 0.75)] || currentPrice,
      q95: stepPrices[Math.floor(pathsCount * 0.95)] || currentPrice
    });
  }

  return distributions;
}
