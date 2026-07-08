import WebSocket from 'ws';
import { getRedis } from '../lib/redis';
import { Logger } from '../lib/logger';
import { SUPPORTED_ASSETS } from '../lib/market';

const REDIS_KEY_PREFIX = 'market:live:';
const REDIS_META_PREFIX = 'market:liveMeta:';
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 30_000;

export class WebsocketDataMesh {
    private binanceWs: WebSocket | null = null;
    private bybitWs: WebSocket | null = null;
    private isRunning = false;
    private binanceReconnectTimeout: NodeJS.Timeout | null = null;
    private bybitReconnectTimeout: NodeJS.Timeout | null = null;
    private binanceLastMessageAt = 0;
    private bybitLastMessageAt = 0;
    private heartbeatInterval: NodeJS.Timeout | null = null;

    // We focus on Crypto assets for websocket feeds
    private getCryptoAssets() {
        return Object.keys(SUPPORTED_ASSETS).filter(key => SUPPORTED_ASSETS[key].category === 'crypto');
    }

    private async writeLiveTick(symbol: string, price: number, source: string, imbalance?: number) {
        const redis = getRedis();
        const updatedAt = new Date().toISOString();
        await redis.set(`${REDIS_KEY_PREFIX}${symbol}`, price.toString(), { ex: 10 });
        await redis.set(`${REDIS_META_PREFIX}${symbol}`, {
            source,
            updatedAt,
            price,
            imbalance: Number.isFinite(imbalance) ? imbalance : null,
        }, { ex: 10 });
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await Logger.info("🔌 WebSocket Data Mesh starting...");
        this.connectBinance();
        this.connectBybit();
        this.heartbeatInterval = setInterval(() => this.checkStaleness(), HEARTBEAT_INTERVAL_MS);
    }

    public stop() {
        this.isRunning = false;
        if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
        if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
        if (this.binanceWs) {
            this.binanceWs.terminate();
            this.binanceWs = null;
        }
        if (this.bybitWs) {
            this.bybitWs.terminate();
            this.bybitWs = null;
        }
    }

    // Some network paths (proxies, NAT timeouts, silent drops) never fire a
    // 'close' or 'error' event on a dead socket — the connection just stops
    // delivering data forever. Ping/pong alone doesn't help if the transport
    // is truly stuck, so we track wall-clock time since the last message and
    // force a hard reconnect if either feed goes quiet for too long.
    private checkStaleness() {
        if (!this.isRunning) return;
        const now = Date.now();

        if (this.binanceWs?.readyState === WebSocket.OPEN) {
            if (this.binanceLastMessageAt > 0 && now - this.binanceLastMessageAt > STALE_THRESHOLD_MS) {
                Logger.warn(`⚠️ Binance WS stale (${Math.round((now - this.binanceLastMessageAt) / 1000)}s since last tick). Forcing reconnect.`);
                this.binanceWs.terminate();
                this.binanceWs = null;
                this.connectBinance();
            } else {
                try { this.binanceWs.ping(); } catch { /* ignore */ }
            }
        }

        if (this.bybitWs?.readyState === WebSocket.OPEN) {
            if (this.bybitLastMessageAt > 0 && now - this.bybitLastMessageAt > STALE_THRESHOLD_MS) {
                Logger.warn(`⚠️ Bybit WS stale (${Math.round((now - this.bybitLastMessageAt) / 1000)}s since last tick). Forcing reconnect.`);
                this.bybitWs.terminate();
                this.bybitWs = null;
                this.connectBybit();
            } else {
                try { this.bybitWs.send(JSON.stringify({ op: 'ping' })); } catch { /* ignore */ }
            }
        }
    }

    private connectBinance() {
        if (!this.isRunning) return;

        try {
            this.binanceWs = new WebSocket('wss://fstream.binance.com/ws');
            this.binanceLastMessageAt = Date.now();

            this.binanceWs.on('open', () => {
                Logger.info("✅ Connected to Binance Futures WebSocket");
                this.binanceLastMessageAt = Date.now();

                const cryptoAssets = this.getCryptoAssets();
                const streams = cryptoAssets.map(asset => `${asset.toLowerCase()}usdt@ticker`);

                const subscribeMessage = {
                    method: 'SUBSCRIBE',
                    params: streams,
                    id: 1
                };

                this.binanceWs?.send(JSON.stringify(subscribeMessage));
            });

            this.binanceWs.on('pong', () => {
                this.binanceLastMessageAt = Date.now();
            });

            this.binanceWs.on('message', async (data: string) => {
                this.binanceLastMessageAt = Date.now();
                try {
                    const parsed = JSON.parse(data);
                    // Binance ticker event: e: '24hrTicker', s: 'BTCUSDT', c: 'lastPrice'
                    if (parsed.e === '24hrTicker' && parsed.s && parsed.c) {
                        const symbol = parsed.s.replace('USDT', '');
                        const price = parseFloat(parsed.c);

                        if (!isNaN(price)) {
                            // Calculate order book imbalance: (Bids - Asks) / (Bids + Asks)
                            const bidQty = parseFloat(parsed.B);
                            const askQty = parseFloat(parsed.A);
                            let imbalance: number | undefined;
                            if (!isNaN(bidQty) && !isNaN(askQty) && (bidQty + askQty) > 0) {
                                imbalance = (bidQty - askQty) / (bidQty + askQty);
                            }

                            await this.writeLiveTick(symbol, price, 'BINANCE_FUTURES_WS', imbalance);

                            if (imbalance !== undefined) {
                                const redis = getRedis();
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
            this.bybitLastMessageAt = Date.now();

            this.bybitWs.on('open', () => {
                Logger.info("✅ Connected to Bybit Futures WebSocket");
                this.bybitLastMessageAt = Date.now();

                const cryptoAssets = this.getCryptoAssets();
                const streams = cryptoAssets.map(asset => `tickers.${asset}USDT`);

                const subscribeMessage = {
                    op: 'subscribe',
                    args: streams
                };

                this.bybitWs?.send(JSON.stringify(subscribeMessage));
            });

            this.bybitWs.on('message', async (data: string) => {
                this.bybitLastMessageAt = Date.now();
                try {
                    const parsed = JSON.parse(data);
                    // Bybit ticker event
                    if (parsed.topic && parsed.topic.startsWith('tickers.') && parsed.data) {
                        const symbol = parsed.topic.split('.')[1].replace('USDT', '');
                        const price = parseFloat(parsed.data.lastPrice);

                        if (!isNaN(price)) {
                            // Calculate Bybit order book imbalance
                            const bidQty = parseFloat(parsed.data.bid1Size);
                            const askQty = parseFloat(parsed.data.ask1Size);
                            let imbalance: number | undefined;
                            if (!isNaN(bidQty) && !isNaN(askQty) && (bidQty + askQty) > 0) {
                                imbalance = (bidQty - askQty) / (bidQty + askQty);
                            }

                            await this.writeLiveTick(symbol, price, 'BYBIT_LINEAR_WS', imbalance);

                            if (imbalance !== undefined) {
                                const redis = getRedis();
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
        if (source === 'binance') {
            if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
            this.binanceReconnectTimeout = setTimeout(() => this.connectBinance(), 5000);
        } else {
            if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
            this.bybitReconnectTimeout = setTimeout(() => this.connectBybit(), 5000);
        }
    }
}
