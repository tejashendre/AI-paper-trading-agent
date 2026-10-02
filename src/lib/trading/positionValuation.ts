import { calculateInstrumentPnl, instrumentFee, instrumentNotional, positionInstrument, positionFeeScheduleVersion } from '@/lib/trading/assetSpecs';
import { estimateCarryCostUsd, estimatePaperFill, getExecutionCostProfile } from '@/lib/trading/executionCostModel';
import type { PositionValuation } from '@/lib/ui/livePortfolioGain';

export async function calculateAccountValue(portfolio: any, getPrice: (asset: string) => Promise<number>) {
    let totalValue: number = portfolio.usd, complete = Number.isFinite(portfolio.usd), live = true;
    const assets = [...new Set([...Object.keys(portfolio.openPositions || {}), ...Object.keys(portfolio.scalpPositions || {})])];
    const prices: Record<string, number> = {}, valuations: PositionValuation[] = [];
    for (const asset of assets) {
        const held = [portfolio.openPositions?.[asset], portfolio.scalpPositions?.[asset]].filter(Boolean);
        let price: number | undefined;
        try { const fresh = await getPrice(asset); if (Number.isFinite(fresh) && fresh > 0) {price=fresh;prices[asset]=fresh;} }
        catch { /* Preserve the actual last mark instead of resetting P&L to cost. */ }
        if (price === undefined) live = false;
        for (const pos of held) {
            const storedAt = Date.parse(pos.lastMarkAt ?? '');
            const markPrice = price ?? (Number.isFinite(storedAt) && storedAt <= Date.now()+2000 ? pos.lastMarkPrice : undefined);
            if (!Number.isFinite(markPrice) || !(markPrice > 0)) {complete=false;continue;}
            try {
                const mark = modeledPositionMark(asset, pos, markPrice);
                const value = pos.usdInvested + mark.grossPnl - mark.exitFee - mark.carryCost;
                if (!Number.isFinite(value)) {complete=false;continue;}
                totalValue += value;
                if (price !== undefined) valuations.push(mark.valuation);
            } catch {complete=false;}
        }
    }
    const count = [...Object.values(portfolio.openPositions || {}), ...Object.values(portfolio.scalpPositions || {})].filter(Boolean).length;
    return {totalValue:complete ? totalValue : null, prices, valuations:complete && live && valuations.length===count ? valuations : null};
}

export function modeledPositionMark(asset: string, pos: any, currentPrice: number) {
    // Marked under the model frozen on the position, not today's routing.
    const instrument = positionInstrument({ ...pos, asset });
    const exit = estimatePaperFill({
        asset,
        instrument,
        feeScheduleVersion: positionFeeScheduleVersion({...pos, asset}),
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
    const entryFee = pos.entryFeePaid ?? instrumentFee(instrument, pos.amount, pos.entryPrice, 'taker', positionFeeScheduleVersion({...pos, asset}));
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
