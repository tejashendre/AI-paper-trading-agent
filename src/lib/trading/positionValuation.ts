import { calculateInstrumentPnl, instrumentFee, instrumentNotional, positionInstrument } from '@/lib/trading/assetSpecs';
import { estimateCarryCostUsd, estimatePaperFill, getExecutionCostProfile } from '@/lib/trading/executionCostModel';
import type { PositionValuation } from '@/lib/ui/livePortfolioGain';

export function modeledPositionMark(asset: string, pos: any, currentPrice: number) {
    // Marked under the model frozen on the position, not today's routing.
    const instrument = positionInstrument({ ...pos, asset });
    const exit = estimatePaperFill({
        asset,
        instrument,
        action: pos.direction === "SHORT" ? "COVER" : "SELL",
        requestedPrice: currentPrice,
        amount: pos.amount,
        context: {
            reason: "MARK",
            assetMode: ["BTC", "ETH", "SOL"].includes(asset) ? "REALTIME_FAST" : "SLOW_SWING",
            dataQuality: pos.dataQuality,
            isPeakLiquidity: false,
            liquidityState: pos.liquidityState,
            orderbookImbalanceRatio: pos.orderbookImbalanceRatio,
        },
    });
    const grossPnl = calculateInstrumentPnl({
        instrument, entryPrice: pos.entryPrice, exitPrice: exit.fillPrice, quantity: pos.amount, direction: pos.direction,
    });
    const entryFee = pos.entryFeePaid ?? instrumentFee(instrument, pos.amount, pos.entryPrice);
    // Linear positions book funding to cash at each settlement; marking it
    // again here would count it twice.
    const carryCost = instrument.economicsModel === "BYBIT_LINEAR_USDT_V1" ? 0 : estimateCarryCostUsd({
        asset,
        notionalUsd: pos.notionalUsd ?? instrumentNotional(instrument, pos.amount, pos.entryPrice),
        openedAt: pos.entryTime,
        fundingRate: pos.fundingRate,
    });
    const profile = getExecutionCostProfile(asset);
    const baseAdverseBps = exit.spreadBps * (1 + profile.baseSlippageBps / profile.halfSpreadBps);
    const valuation: PositionValuation = { asset, priceAtSync: currentPrice, entryPrice: pos.entryPrice,
        quantity: pos.amount, short: pos.direction === "SHORT",
        legacyJPY: asset === 'USDJPY' && instrument.economicsModel !== 'BYBIT_LINEAR_USDT_V1',
        baseAdverseBps, sizeAdverseBps: Math.max(0, exit.totalAdverseBps - baseAdverseBps),
        exitFeeRate: exit.feeUsd / exit.notionalUsd, carryCost,
        netPnlAtSync: grossPnl - exit.feeUsd - carryCost };
    return { grossPnl, entryFee, exitFee: exit.feeUsd, carryCost, valuation };
}

