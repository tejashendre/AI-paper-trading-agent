import * as ccxt from 'ccxt';
import { Logger } from '../logger';
import { getEnv } from '../env';
import { Portfolio, Trade } from '../types';

export class LiveExchange {
    private static binanceClient: ccxt.binance | null = null;
    private static bybitClient: ccxt.bybit | null = null;
    private static isInitialized = false;
    private static configuredSymbols = new Set<string>();

    private static init() {
        if (this.isInitialized) return;
        const env = getEnv();

        if (env.BINANCE_API_KEY && env.BINANCE_API_SECRET) {
            this.binanceClient = new ccxt.binance({
                apiKey: env.BINANCE_API_KEY,
                secret: env.BINANCE_API_SECRET,
                enableRateLimit: true,
                options: { defaultType: 'future' }
            });
            // If testnet:
            // this.binanceClient.setSandboxMode(true);
        }

        if (env.BYBIT_API_KEY && env.BYBIT_API_SECRET) {
            this.bybitClient = new ccxt.bybit({
                apiKey: env.BYBIT_API_KEY,
                secret: env.BYBIT_API_SECRET,
                enableRateLimit: true,
                options: { defaultType: 'future' }
            });
            // If testnet:
            // this.bybitClient.setSandboxMode(true);
        }

        this.isInitialized = true;
    }

    /**
     * Executes a real market order on the designated exchange.
     */
    public static async executeTrade(
        exchange: 'BINANCE' | 'BYBIT',
        asset: string,
        direction: 'LONG' | 'SHORT',
        action: 'BUY' | 'SELL' | 'SHORT' | 'COVER' | 'SCALP_BUY' | 'SCALP_SHORT' | 'SCALP_SELL' | 'SCALP_COVER',
        amount: number, // asset amount (e.g. BTC)
        currentPrice: number
    ): Promise<{ success: boolean; executedPrice?: number; feeUsd?: number; orderId?: string; error?: string }> {
        this.init();

        try {
            const client = exchange === 'BINANCE' ? this.binanceClient : this.bybitClient;
            if (!client) {
                return { success: false, error: `${exchange} API keys not configured.` };
            }

            const symbol = `${asset}/USDT:USDT`;

            // Configure margin mode if not already done for this symbol
            const configuredKey = `${exchange}:${symbol}`;
            if (!LiveExchange.configuredSymbols.has(configuredKey)) {
                try {
                    const env = getEnv();
                    const mode = (env.MARGIN_MODE || 'CROSS').toLowerCase();
                    // Bybit non-unified accounts require leverage parameter
                    const params: any = {};
                    if (exchange === 'BYBIT') {
                        params.leverage = 20; // Default fallback to 20x leverage setup
                    }
                    await client.setMarginMode(mode, symbol, params);
                    await Logger.info(`🔧 [LIVE EXECUTION] Set ${exchange} margin mode to ${mode.toUpperCase()} for ${symbol}`);
                    LiveExchange.configuredSymbols.add(configuredKey);
                } catch (e: any) {
                    const msg = e instanceof Error ? e.message : String(e);
                    await Logger.warn(`⚠️ [LIVE EXECUTION] Could not set margin mode to ${getEnv().MARGIN_MODE || 'CROSS'} on ${exchange} for ${symbol}: ${msg}`);
                    LiveExchange.configuredSymbols.add(configuredKey);
                }
            }
            
            // CCXT Market Order Side logic:
            // Opening Long -> buy
            // Closing Long -> sell
            // Opening Short -> sell
            // Closing Short -> buy
            
            let side: 'buy' | 'sell';
            if (action.includes('BUY') || action === 'COVER') {
                side = 'buy';
            } else {
                side = 'sell';
            }

            // In production HFT, limit orders save maker fees. 
            // We implement a 3-attempt order chasing algorithm.
            await Logger.info(`🚀 [LIVE EXECUTION] Routing ${side.toUpperCase()} ${amount.toFixed(6)} ${symbol} to ${exchange} via LIMIT order with chasing...`);

            let executedPrice = currentPrice;
            let feeUsd = 0;
            let orderId: string | undefined;
            let filledAmount = 0;
            let targetPrice = currentPrice;

            // 3 attempts at chasing the book
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    // Place Limit Order
                    const order = await client.createLimitOrder(symbol, side, amount - filledAmount, targetPrice);
                    await Logger.info(`⏳ [LIVE EXECUTION] Attempt ${attempt}: Limit order ${order.id} placed at $${targetPrice}`);
                    
                    // Wait 5 seconds for fill
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    
                    // Check order status
                    const status = await client.fetchOrder(order.id, symbol);
                    const newlyFilled = status.filled || 0;
                    
                    if (status.status === 'closed' || newlyFilled >= (amount - filledAmount)) {
                        // Fully filled!
                        filledAmount += newlyFilled;
                        executedPrice = status.average || targetPrice;
                        if (status.fee && status.fee.cost) {
                            feeUsd += status.fee.cost;
                        }
                        orderId = order.id;
                        await Logger.info(`✅ [LIVE EXECUTION] Limit Order Fully Filled at $${executedPrice}`);
                        break;
                    } else {
                        // Cancel and chase
                        await client.cancelOrder(order.id, symbol);
                        filledAmount += newlyFilled;
                        await Logger.warn(`⚠️ [LIVE EXECUTION] Order partially or not filled. Canceling ${order.id}. Filled: ${filledAmount}/${amount}`);
                        
                        // Re-fetch ticker to get new best bid/ask
                        const ticker = await client.fetchTicker(symbol);
                        targetPrice = side === 'buy' ? (ticker.ask || currentPrice) : (ticker.bid || currentPrice);
                        // Add tiny slippage buffer on attempt 3 to guarantee fill
                        if (attempt === 2) {
                             targetPrice = side === 'buy' ? targetPrice * 1.0005 : targetPrice * 0.9995;
                        }
                    }
                } catch (e) {
                    await Logger.error(`❌ [LIVE EXECUTION] Chasing error on attempt ${attempt}: ${e}`);
                }
            }

            // Fallback to market order if still not filled
            if (filledAmount < amount) {
                 await Logger.warn(`⚠️ [LIVE EXECUTION] Falling back to MARKET order for remaining ${(amount - filledAmount).toFixed(6)} units...`);
                 const marketOrder = await client.createMarketOrder(symbol, side, amount - filledAmount);
                 executedPrice = marketOrder.average || marketOrder.price || targetPrice;
                 if (marketOrder.fee && marketOrder.fee.cost) {
                     feeUsd += marketOrder.fee.cost;
                 }
                 orderId = marketOrder.id;
            }

            // Estimate maker fee if none provided (Binance/Bybit Maker limits are ~0.02%)
            if (feeUsd === 0) {
                const feeRate = exchange === 'BINANCE' ? 0.0002 : 0.0002; 
                feeUsd = (amount * executedPrice) * feeRate;
            }

            await Logger.info(`✅ [LIVE EXECUTION] ${exchange} Final Fill at ~$${executedPrice.toFixed(2)} (Est Fee: $${feeUsd.toFixed(4)})`);

            return {
                success: true,
                executedPrice,
                feeUsd,
                orderId: orderId || "unknown"
            };

        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await Logger.error(`❌ [LIVE EXECUTION] ${exchange} Error: ${msg}`);
            return { success: false, error: msg };
        }
    }
}
