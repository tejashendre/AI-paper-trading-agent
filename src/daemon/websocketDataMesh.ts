import WebSocket from 'ws';
import { getRedis } from '../lib/redis';
import { Logger } from '../lib/logger';
import { SUPPORTED_ASSETS } from '../lib/market';

const REDIS_KEY_PREFIX = 'market:live:';

export class WebsocketDataMesh {
    private binanceWs: WebSocket | null = null;
    private bybitWs: WebSocket | null = null;
    private isRunning = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;

    // We focus on Crypto assets for websocket feeds
    private getCryptoAssets() {
        return Object.keys(SUPPORTED_ASSETS).filter(key => SUPPORTED_ASSETS[key].category === 'crypto');
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await Logger.info("🔌 WebSocket Data Mesh starting...");
        this.connectBinance();
        this.connectBybit();
    }

    public stop() {
        this.isRunning = false;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.binanceWs) {
            this.binanceWs.terminate();
            this.binanceWs = null;
        }
        if (this.bybitWs) {
            this.bybitWs.terminate();
            this.bybitWs = null;
        }
    }

    private connectBinance() {
        if (!this.isRunning) return;
        
        try {
            this.binanceWs = new WebSocket('wss://fstream.binance.com/ws');

            this.binanceWs.on('open', () => {
                Logger.info("✅ Connected to Binance Futures WebSocket");
                
                const cryptoAssets = this.getCryptoAssets();
                const streams = cryptoAssets.map(asset => `${asset.toLowerCase()}usdt@ticker`);

                const subscribeMessage = {
                    method: 'SUBSCRIBE',
                    params: streams,
                    id: 1
                };

                this.binanceWs?.send(JSON.stringify(subscribeMessage));
            });

            this.binanceWs.on('message', async (data: string) => {
                try {
                    const parsed = JSON.parse(data);
                    // Binance ticker event: e: '24hrTicker', s: 'BTCUSDT', c: 'lastPrice'
                    if (parsed.e === '24hrTicker' && parsed.s && parsed.c) {
                        const symbol = parsed.s.replace('USDT', '');
                        const price = parseFloat(parsed.c);
                        
                        if (!isNaN(price)) {
                            const redis = getRedis();
                            // Store price in redis with 10s TTL. Fast streaming overwrites this constantly.
                            await redis.set(`${REDIS_KEY_PREFIX}${symbol}`, price.toString(), { ex: 10 });

                            // Calculate order book imbalance: (Bids - Asks) / (Bids + Asks)
                            const bidQty = parseFloat(parsed.B);
                            const askQty = parseFloat(parsed.A);
                            if (!isNaN(bidQty) && !isNaN(askQty) && (bidQty + askQty) > 0) {
                                const imbalance = (bidQty - askQty) / (bidQty + askQty);
                                await redis.set(`market:imbalance:${symbol}`, imbalance.toString(), { ex: 10 });
                            }
                        }
                    }
                } catch (e) {
                    // ignore parse errors
                }
            });

            this.binanceWs.on('close', () => {
                Logger.warn("❌ Binance WebSocket disconnected. Reconnecting in 5s...");
                this.scheduleReconnect('binance');
            });

            this.binanceWs.on('error', (err) => {
                console.error("Binance WebSocket Error:", err);
            });

        } catch (e) {
            console.error("Failed to start Binance WebSocket:", e);
            this.scheduleReconnect('binance');
        }
    }

    private connectBybit() {
        if (!this.isRunning) return;

        try {
            // Bybit Linear public stream
            this.bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');

            this.bybitWs.on('open', () => {
                Logger.info("✅ Connected to Bybit Futures WebSocket");

                const cryptoAssets = this.getCryptoAssets();
                const streams = cryptoAssets.map(asset => `tickers.${asset}USDT`);

                const subscribeMessage = {
                    op: 'subscribe',
                    args: streams
                };

                this.bybitWs?.send(JSON.stringify(subscribeMessage));
            });

            this.bybitWs.on('message', async (data: string) => {
                try {
                    const parsed = JSON.parse(data);
                    // Bybit ticker event
                    if (parsed.topic && parsed.topic.startsWith('tickers.') && parsed.data) {
                        const symbol = parsed.topic.split('.')[1].replace('USDT', '');
                        const price = parseFloat(parsed.data.lastPrice);
                        
                        if (!isNaN(price)) {
                            // If Binance goes down, Bybit data seamlessly acts as fallback in Redis
                            const redis = getRedis();
                            await redis.set(`${REDIS_KEY_PREFIX}${symbol}`, price.toString(), { ex: 10 });

                            // Calculate Bybit order book imbalance
                            const bidQty = parseFloat(parsed.data.bid1Size);
                            const askQty = parseFloat(parsed.data.ask1Size);
                            if (!isNaN(bidQty) && !isNaN(askQty) && (bidQty + askQty) > 0) {
                                const imbalance = (bidQty - askQty) / (bidQty + askQty);
                                await redis.set(`market:imbalance:${symbol}`, imbalance.toString(), { ex: 10 });
                            }
                        }
                    }
                } catch (e) {
                    // ignore parse errors
                }
            });

            this.bybitWs.on('close', () => {
                Logger.warn("❌ Bybit WebSocket disconnected. Reconnecting in 5s...");
                this.scheduleReconnect('bybit');
            });

            this.bybitWs.on('error', (err) => {
                console.error("Bybit WebSocket Error:", err);
            });

        } catch (e) {
            console.error("Failed to start Bybit WebSocket:", e);
            this.scheduleReconnect('bybit');
        }
    }

    private scheduleReconnect(source: 'binance' | 'bybit') {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = setTimeout(() => {
            if (source === 'binance') this.connectBinance();
            if (source === 'bybit') this.connectBybit();
        }, 5000);
    }
}
