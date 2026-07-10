import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { Logger } from '@/lib/logger';
import { MarketService, SUPPORTED_ASSETS } from '@/lib/market';
import { PortfolioManager } from '@/lib/portfolio';
import { Trade, OpenPosition } from '@/lib/types';
import { amountFromNotionalUsd, calculatePnlUsd, estimateFeeUsd } from '@/lib/trading/assetSpecs';
import { getMarketSessionState } from '@/lib/trading/marketSession';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized || auth.source !== 'dashboard') {
    return NextResponse.json({ error: 'Unauthorized: Admin/Dashboard access required for manual trading.' }, { status: 403 });
  }

  let portfolioRelease: (() => Promise<void>) | null = null;
  try {
    portfolioRelease = await PortfolioManager.acquireWriteLock("user");
    if (!portfolioRelease) {
      return NextResponse.json({ error: 'User portfolio is busy; retry after the active update completes.' }, { status: 409 });
    }
    const body = await request.json();
    const { asset, action, amount: requestedAmount } = body;

    if (!asset || !SUPPORTED_ASSETS[asset]) {
      return NextResponse.json({ error: 'Invalid or missing asset' }, { status: 400 });
    }
    if (!['BUY', 'SHORT', 'SELL', 'COVER'].includes(action)) {
      return NextResponse.json({ error: 'Invalid action. Use BUY, SHORT, SELL, or COVER' }, { status: 400 });
    }

    const portfolio = await PortfolioManager.getPortfolio();
    const currentPrice = await MarketService.getCurrentPrice(asset);
    const currentPosition = portfolio.openPositions?.[asset] || null;

    if ((action === 'BUY' || action === 'SHORT') && !currentPosition) {
      const session = getMarketSessionState(asset);
      if (!session.isOpen) {
        return NextResponse.json({ success: false, error: session.reason }, { status: 400 });
      }
    }

    if (action === 'BUY') {
      if (currentPosition) {
        return NextResponse.json({ error: `Already have an open position in ${asset}` }, { status: 400 });
      }
      const usdAmount = requestedAmount !== undefined ? Number(requestedAmount) : Math.min(portfolio.usd * 0.1, portfolio.usd);
      if (!Number.isFinite(usdAmount) || usdAmount <= 0 || usdAmount > portfolio.usd) {
        return NextResponse.json({ error: `Invalid amount. Available: $${portfolio.usd.toFixed(2)}` }, { status: 400 });
      }

      const units = amountFromNotionalUsd(asset, usdAmount, currentPrice);
      const entryFee = estimateFeeUsd(asset, units, currentPrice);
      if (usdAmount + entryFee > portfolio.usd) {
        return NextResponse.json({ error: 'Insufficient free cash for amount plus entry fee' }, { status: 400 });
      }
      portfolio.usd -= usdAmount + entryFee;
      portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;
      if (portfolio.balances) portfolio.balances[asset] = (portfolio.balances[asset] || 0) + units;

      const pos: OpenPosition = {
        asset, entryPrice: currentPrice, amount: units, btcAmount: units,
        usdInvested: usdAmount, stopLoss: currentPrice * 0.95, takeProfit: currentPrice * 1.10,
        initialStopLoss: currentPrice * 0.95,
        entryTime: new Date().toISOString(), signalScore: 0, reasoning: 'Manual BUY order', entryFeePaid: entryFee,
        direction: 'LONG'
      };
      if (!portfolio.openPositions) portfolio.openPositions = {};
      portfolio.openPositions[asset] = pos;
      if (asset === 'BTC') { portfolio.btc = units; portfolio.openPosition = pos; }

      await PortfolioManager.updatePortfolio(portfolio);
      const trade: Trade = {
        id: crypto.randomUUID(), timestamp: new Date().toISOString(), asset,
        action: 'BUY', direction: 'LONG', amount: units, btcAmount: units,
        price: currentPrice, usdValue: usdAmount, stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit, signalScore: 0, reasoning: 'Manual BUY order'
      };
      await PortfolioManager.logTrade(trade);
      await Logger.info(`MANUAL BUY [${asset}]: ${units.toFixed(6)} @ $${currentPrice.toLocaleString()}`);
      return NextResponse.json({ success: true, action: 'BUY', asset, price: currentPrice, units, usdAmount });
    }

    if (action === 'SHORT') {
      if (currentPosition) {
        return NextResponse.json({ error: `Already have an open position in ${asset}` }, { status: 400 });
      }
      const usdAmount = requestedAmount !== undefined ? Number(requestedAmount) : Math.min(portfolio.usd * 0.1, portfolio.usd);
      if (!Number.isFinite(usdAmount) || usdAmount <= 0 || usdAmount > portfolio.usd) {
        return NextResponse.json({ error: `Invalid margin amount. Available: $${portfolio.usd.toFixed(2)}` }, { status: 400 });
      }

      const units = amountFromNotionalUsd(asset, usdAmount, currentPrice);
      const entryFee = estimateFeeUsd(asset, units, currentPrice);
      if (usdAmount + entryFee > portfolio.usd) {
        return NextResponse.json({ error: 'Insufficient free cash for margin plus entry fee' }, { status: 400 });
      }
      portfolio.usd -= usdAmount + entryFee;
      portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + entryFee;

      const pos: OpenPosition = {
        asset, entryPrice: currentPrice, amount: units, btcAmount: units,
        usdInvested: usdAmount, stopLoss: currentPrice * 1.05, takeProfit: currentPrice * 0.90,
        initialStopLoss: currentPrice * 1.05,
        entryTime: new Date().toISOString(), signalScore: 0, reasoning: 'Manual SHORT order', entryFeePaid: entryFee,
        direction: 'SHORT'
      };
      if (!portfolio.openPositions) portfolio.openPositions = {};
      portfolio.openPositions[asset] = pos;

      await PortfolioManager.updatePortfolio(portfolio);
      const trade: Trade = {
        id: crypto.randomUUID(), timestamp: new Date().toISOString(), asset,
        action: 'SHORT', direction: 'SHORT', amount: units, btcAmount: units,
        price: currentPrice, usdValue: usdAmount, stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit, signalScore: 0, reasoning: 'Manual SHORT order'
      };
      await PortfolioManager.logTrade(trade);
      await Logger.info(`MANUAL SHORT [${asset}]: ${units.toFixed(6)} @ $${currentPrice.toLocaleString()}`);
      return NextResponse.json({ success: true, action: 'SHORT', asset, price: currentPrice, units, usdAmount });
    }

    if (action === 'SELL') {
      if (!currentPosition || currentPosition.direction === 'SHORT') {
        return NextResponse.json({ error: `No LONG position open in ${asset} to sell` }, { status: 400 });
      }
      const pos = currentPosition;
      const pnl = calculatePnlUsd(asset, pos.entryPrice, currentPrice, pos.amount, 'LONG');
      const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
      const exitFee = estimateFeeUsd(asset, pos.amount, currentPrice);
      const netPnl = pnl - entryFee - exitFee;
      const proceeds = pos.usdInvested + entryFee + netPnl;
      const pnlPercent = (netPnl / pos.usdInvested) * 100;

      portfolio.usd += proceeds;
      portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exitFee;
      if (portfolio.balances) portfolio.balances[asset] = Math.max(0, (portfolio.balances[asset] || 0) - pos.amount);
      portfolio.totalPnl += netPnl;
      portfolio.totalTrades++;
      portfolio.returns.push(pnlPercent);
      if (portfolio.returns.length > 2000) {
        portfolio.returns.shift();
      }
      if (netPnl >= 0) {
        portfolio.winningTrades++; portfolio.grossProfit += netPnl;
        portfolio.consecutiveWins++; portfolio.consecutiveLosses = 0;
        portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
      } else {
        portfolio.losingTrades++; portfolio.grossLoss += Math.abs(netPnl);
        portfolio.consecutiveLosses++; portfolio.consecutiveWins = 0;
        portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
      }

      delete portfolio.openPositions[asset];
      if (asset === 'BTC') { portfolio.btc = 0; portfolio.openPosition = null; }

      await PortfolioManager.updatePortfolio(portfolio);
      const trade: Trade = {
        id: crypto.randomUUID(), timestamp: new Date().toISOString(), asset,
        action: 'SELL', direction: 'LONG', amount: pos.amount, btcAmount: pos.amount,
        price: currentPrice, usdValue: proceeds, stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit, signalScore: 0,
        reasoning: 'Manual SELL order', pnl: netPnl, pnlPercent, exitPrice: currentPrice,
        entryPrice: pos.entryPrice, entryTime: pos.entryTime,
        exitTime: new Date().toISOString(), exitReason: 'MANUAL'
      };
      await PortfolioManager.logTrade(trade);
      await Logger.info(`MANUAL SELL [${asset}]: Net PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);
      return NextResponse.json({ success: true, action: 'SELL', asset, price: currentPrice, pnl: netPnl, pnlPercent });
    }

    if (action === 'COVER') {
      if (!currentPosition || currentPosition.direction !== 'SHORT') {
        return NextResponse.json({ error: `No SHORT position open in ${asset} to cover` }, { status: 400 });
      }
      const pos = currentPosition;
      const pnl = calculatePnlUsd(asset, pos.entryPrice, currentPrice, pos.amount, 'SHORT');
      const entryFee = pos.entryFeePaid ?? estimateFeeUsd(asset, pos.amount, pos.entryPrice);
      const exitFee = estimateFeeUsd(asset, pos.amount, currentPrice);
      const netPnl = pnl - entryFee - exitFee;
      const pnlPercent = (netPnl / pos.usdInvested) * 100;

      portfolio.usd += pos.usdInvested + entryFee + netPnl;
      portfolio.totalFeesPaid = (portfolio.totalFeesPaid || 0) + exitFee;
      portfolio.totalPnl += netPnl;
      portfolio.totalTrades++;
      portfolio.returns.push(pnlPercent);
      if (portfolio.returns.length > 2000) {
        portfolio.returns.shift();
      }
      if (netPnl >= 0) {
        portfolio.winningTrades++; portfolio.grossProfit += netPnl;
        portfolio.consecutiveWins++; portfolio.consecutiveLosses = 0;
        portfolio.maxConsecutiveWins = Math.max(portfolio.maxConsecutiveWins, portfolio.consecutiveWins);
      } else {
        portfolio.losingTrades++; portfolio.grossLoss += Math.abs(netPnl);
        portfolio.consecutiveLosses++; portfolio.consecutiveWins = 0;
        portfolio.maxConsecutiveLosses = Math.max(portfolio.maxConsecutiveLosses, portfolio.consecutiveLosses);
      }

      delete portfolio.openPositions[asset];

      await PortfolioManager.updatePortfolio(portfolio);
      const trade: Trade = {
        id: crypto.randomUUID(), timestamp: new Date().toISOString(), asset,
        action: 'COVER', direction: 'SHORT', amount: pos.amount, btcAmount: pos.amount,
        price: currentPrice, usdValue: pos.usdInvested + entryFee + netPnl, stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit, signalScore: 0,
        reasoning: 'Manual COVER order', pnl: netPnl, pnlPercent, exitPrice: currentPrice,
        entryPrice: pos.entryPrice, entryTime: pos.entryTime,
        exitTime: new Date().toISOString(), exitReason: 'MANUAL'
      };
      await PortfolioManager.logTrade(trade);
      await Logger.info(`MANUAL COVER [${asset}]: Net PnL: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}`);
      return NextResponse.json({ success: true, action: 'COVER', asset, price: currentPrice, pnl: netPnl, pnlPercent });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await Logger.error('Manual trade failed', { error: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    if (portfolioRelease) await portfolioRelease();
  }
}
