import { SwingEngine } from "../lib/swingEngine";
import { MarketService, SUPPORTED_ASSETS } from "../lib/market";
import { PortfolioManager } from "../lib/portfolio";
import { Logger } from "../lib/logger";
import { getRedis } from "../lib/redis";
import { RiskManager } from "../lib/riskManager";
import { Trade, OpenPosition } from "../lib/types";
import { WebsocketDataMesh } from "./websocketDataMesh";
import { TradeLedger } from "../lib/memory/tradeLedger";
import crypto from "crypto";

// Use the dedicated AI portfolio key
const getAIPortfolio = () => PortfolioManager.getPortfolio("ai");
const updateAIPortfolio = (p: any) => PortfolioManager.updatePortfolio(p, "ai");
const logAITrade = (t: any) => PortfolioManager.logTrade(t, "ai");

const TICK_INTERVAL_MS = 60000; // 1-minute interval for Swing tracking
const RISK_PER_TRADE_PERCENT = 0.015; // Strict 1.5% portfolio equity risk per trade
const MAX_LEVERAGE = 5.0; // Hard cap on leverage for swing trades to prevent liquidation
const TRANSACTION_FEE_RATE = 0.0005;

// Start Live Websocket Mesh
const wsMesh = new WebsocketDataMesh();
wsMesh.start();

let isTicking = false;
let lastSummaryLogTime = 0;

async function runSwingTick() {
  if (isTicking) return;
  isTicking = true;
  try {
    const redis = getRedis();
    const portfolio = await getAIPortfolio();
    
    if (!portfolio.openPositions) {
      portfolio.openPositions = {};
    }
    if (!portfolio.balances) {
      portfolio.balances = {};
    }

    const activeKeys = Object.keys(portfolio.openPositions);
    const supportedAssets = Object.keys(SUPPORTED_ASSETS);

    // ══════════════════════════════════════════════════════════════
    // Phase 1: Sweep Active Swings for Exits
    // ══════════════════════════════════════════════════════════════
    for (const asset of activeKeys) {
      const pos = portfolio.openPositions[asset];
      if (!pos) continue;

      try {
        let currentLivePrice = 0;
        const livePriceStr = await redis.get<string>(`market:live:${asset}`);
        if (livePriceStr) {
          currentLivePrice = parseFloat(livePriceStr);
        } else {
          currentLivePrice = await MarketService.getCurrentPrice(asset);
        }
        if (isNaN(currentLivePrice) || currentLivePrice <= 0) continue;

        // Check SL/TP and Trail Triggers
        const sltp = RiskManager.checkStopLossOrTakeProfit(pos, currentLivePrice);

        if (sltp.triggered) {
          const isShort = pos.direction === "SHORT";
          
          const priceChange = isShort
            ? pos.entryPrice - sltp.exitPrice
            : sltp.exitPrice - pos.entryPrice;
          
          const grossPnl = priceChange * pos.amount;
          
          const entryFee = pos.entryFeePaid !== undefined 
            ? pos.entryFeePaid 
            : ((pos.amount * pos.entryPrice) * TRANSACTION_FEE_RATE);
          
          const exitFee = (pos.amount * sltp.exitPrice) * TRANSACTION_FEE_RATE;
          const totalFees = entryFee + exitFee;
          
          const netPnl = grossPnl - totalFees;
          const pnlPercent = (netPnl / pos.usdInvested) * 100;

          portfolio.usd += pos.usdInvested + entryFee + netPnl;
          portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exitFee;
          
          if (portfolio.balances && !isShort) {
            portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - pos.amount);
          }

          portfolio.totalPnl += netPnl;
          portfolio.totalTrades++;
          portfolio.returns.push(pnlPercent);
          if (portfolio.returns.length > 2000) {
            portfolio.returns.shift();
          }

          if (netPnl >= 0) {
            portfolio.winningTrades++;
            portfolio.grossProfit += netPnl;
            portfolio.consecutiveWins++;
            portfolio.consecutiveLosses = 0;
            portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
          } else {
            portfolio.losingTrades++;
            portfolio.grossLoss += Math.abs(netPnl);
            portfolio.consecutiveLosses++;
            portfolio.consecutiveWins = 0;
            portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
          }

          delete portfolio.openPositions[asset];
          
          await redis.set(`swing:cooldown:${asset}`, "1", { ex: 3600 }); // 1 hour cooldown after swing trade

          const closeTrade: Trade = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            asset,
            action: isShort ? "COVER" : "SELL",
            direction: isShort ? "SHORT" : "LONG",
            amount: pos.amount,
            btcAmount: pos.amount,
            price: sltp.exitPrice,
            usdValue: pos.usdInvested + netPnl,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            signalScore: pos.signalScore,
            reasoning: `Swing exit triggered: ${sltp.reason} | Net PnL: $${netPnl.toFixed(2)}`,
            pnl: netPnl,
            pnlPercent,
            entryPrice: pos.entryPrice,
            entryTime: pos.entryTime,
            exitPrice: sltp.exitPrice,
            exitTime: new Date().toISOString(),
            exitReason: sltp.reason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_LOSS",
          };

          await updateAIPortfolio(portfolio);
          await logAITrade(closeTrade);

          await Logger.info(`⚡ [SWING EXIT] ${asset} ${isShort ? 'SHORT COVER' : 'LONG SELL'} via ${sltp.reason}. Net PnL: ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
        } else if (sltp.trailed) {
          if (sltp.newStopLoss) pos.stopLoss = sltp.newStopLoss;
          if (sltp.newTakeProfit) pos.takeProfit = sltp.newTakeProfit;
          await updateAIPortfolio(portfolio);
          console.log(`[SWING ENGINE] Trailed levels for ${asset} | SL: $${pos.stopLoss.toFixed(2)}`);
        }

      } catch (sweepErr) {
        console.error(`[SWING ENGINE] Sweep error on ${asset}:`, sweepErr);
      }
    }

    // ══════════════════════════════════════════════════════════════
    // Phase 2: Scan for New HTF Swing Setups
    // ══════════════════════════════════════════════════════════════
    for (const asset of supportedAssets) {
      const hasPosition = portfolio.openPositions && portfolio.openPositions[asset];
      if (hasPosition) continue;

      const onCooldown = await redis.get(`swing:cooldown:${asset}`);
      if (onCooldown) continue;

      try {
        const swingSignal = await SwingEngine.analyze(asset);

        if (swingSignal.action === "HOLD") continue;

        const currentLivePrice = swingSignal.entryPrice;
        const isShort = swingSignal.action === "SWING_SHORT";

        // Institutional Position Sizing: Risk exactly 1.5% of Equity
        const riskAmountUsd = portfolio.usd * RISK_PER_TRADE_PERCENT;
        const priceDistance = Math.abs(currentLivePrice - swingSignal.stopLoss);
        
        if (priceDistance <= 0) continue; // Invalid SL

        // Calculate amount of asset to buy so that (amount * priceDistance) == riskAmountUsd
        const amount = riskAmountUsd / priceDistance;
        const notionalPositionSizeUsd = amount * currentLivePrice;
        
        // Calculate required margin (Assuming max 5x leverage for swings)
        const requiredMarginUsd = notionalPositionSizeUsd / MAX_LEVERAGE;
        
        if (requiredMarginUsd > portfolio.usd) {
           // Skip if we don't have enough margin for even a 5x leveraged trade
           await Logger.warn(`[SWING ENGINE] Skipped ${asset} - Insufficient margin for strict risk parameters.`);
           continue;
        }

        const entryFee = notionalPositionSizeUsd * TRANSACTION_FEE_RATE;

        if (requiredMarginUsd + entryFee > portfolio.usd) continue;

        portfolio.usd -= (requiredMarginUsd + entryFee);
        portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;

        if (!isShort) {
          portfolio.balances[asset] = (portfolio.balances[asset] || 0) + amount;
        }

        const newPos: OpenPosition = {
          asset,
          entryPrice: currentLivePrice,
          amount,
          btcAmount: amount, 
          usdInvested: requiredMarginUsd,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          entryTime: new Date().toISOString(),
          signalScore: swingSignal.score,
          reasoning: swingSignal.reasoning,
          direction: isShort ? "SHORT" : "LONG",
          isScalp: false,
          entryFeePaid: entryFee
        };

        portfolio.openPositions[asset] = newPos;

        const entryTrade: Trade = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          asset,
          action: isShort ? "SHORT" : "BUY",
          direction: isShort ? "SHORT" : "LONG",
          amount,
          btcAmount: amount,
          price: currentLivePrice,
          usdValue: requiredMarginUsd,
          stopLoss: swingSignal.stopLoss,
          takeProfit: swingSignal.takeProfit,
          signalScore: swingSignal.score,
          reasoning: swingSignal.reasoning
        };

        await updateAIPortfolio(portfolio);
        await logAITrade(entryTrade);

        await Logger.info(`⚡ [SWING ENTRY] ${asset} ${isShort ? 'SHORT' : 'LONG'} @ $${currentLivePrice.toLocaleString()} | Risking $${riskAmountUsd.toFixed(2)} | Margin: $${requiredMarginUsd.toFixed(2)} | SL: $${swingSignal.stopLoss.toFixed(2)}`);

      } catch (scanErr) {
        console.error(`[SWING ENGINE] Scan error on ${asset}:`, scanErr);
      }
    }

    if (Date.now() - lastSummaryLogTime > 300000) {
      lastSummaryLogTime = Date.now();
      const activeCount = Object.keys(portfolio.openPositions || {}).length;
      await Logger.info(`[SWING DAEMON] Scanning HTF. Active Positions: ${activeCount}`);
    }

  } catch (err) {
    console.error("[SWING ENGINE] Core Loop Crash:", err);
  } finally {
    isTicking = false;
  }
}

console.log("🚀 Starting V6 Institutional HTF Swing Daemon...");
runSwingTick();
const intervalId = setInterval(runSwingTick, TICK_INTERVAL_MS);

const shutdown = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Shutting down swingDaemon gracefully...`);
  clearInterval(intervalId);
  try {
    wsMesh.stop();
  } catch (err) {}
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
