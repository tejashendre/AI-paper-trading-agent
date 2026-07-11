import WebSocket from "ws";
import { getRedis } from "../lib/redis";
import { Logger } from "../lib/logger";
import { SUPPORTED_ASSETS } from "../lib/market";

const REDIS_KEY_PREFIX = "market:live:";
const REDIS_META_PREFIX = "market:liveMeta:";
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 30_000;

export class WebsocketDataMesh {
    private krakenWs: WebSocket | null = null;
    private bybitWs: WebSocket | null = null;
    private isRunning = false;
    private krakenReconnectTimeout: NodeJS.Timeout | null = null;
    private bybitReconnectTimeout: NodeJS.Timeout | null = null;
    private krakenLastMarketDataAt = 0;
    private bybitLastMarketDataAt = 0;
    private krakenConnectedAt = 0;
    private bybitConnectedAt = 0;
    private heartbeatInterval: NodeJS.Timeout | null = null;

    private getCryptoAssets() {
        return Object.keys(SUPPORTED_ASSETS).filter((key) => SUPPORTED_ASSETS[key].category === "crypto");
    }

    private async writeLiveTick(symbol: string, price: number, source: string, imbalance?: number) {
        const redis = getRedis();
        const updatedAt = new Date().toISOString();
        await redis.set(`${REDIS_KEY_PREFIX}${source}:${symbol}`, price.toString(), { ex: 10 });
        await redis.set(`${REDIS_META_PREFIX}${source}:${symbol}`, {
            source,
            updatedAt,
            price,
            imbalance: Number.isFinite(imbalance) ? imbalance : null,
        }, { ex: 10 });

        // Kraken is primary. Bybit fills the shared key only when Kraken's
        // observation for the symbol is unavailable.
        const primaryKey = `${REDIS_KEY_PREFIX}KRAKEN_SPOT_WS:${symbol}`;
        const primaryAvailable = await redis.get<string>(primaryKey).catch(() => null);
        if (source === "KRAKEN_SPOT_WS" || !primaryAvailable) {
            await redis.set(`${REDIS_KEY_PREFIX}${symbol}`, price.toString(), { ex: 10 });
            await redis.set(`${REDIS_META_PREFIX}${symbol}`, {
                source,
                updatedAt,
                price,
                imbalance: Number.isFinite(imbalance) ? imbalance : null,
            }, { ex: 10 });
            if (Number.isFinite(imbalance)) {
                await redis.set(`market:imbalance:${symbol}`, String(imbalance), { ex: 10 });
            }
        }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await Logger.info("WebSocket Data Mesh starting...");
        this.connectKraken();
        this.connectBybit();
        this.heartbeatInterval = setInterval(() => this.checkStaleness(), HEARTBEAT_INTERVAL_MS);
    }

    public stop() {
        this.isRunning = false;
        if (this.krakenReconnectTimeout) clearTimeout(this.krakenReconnectTimeout);
        if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.krakenReconnectTimeout = null;
        this.bybitReconnectTimeout = null;
        this.heartbeatInterval = null;
        if (this.krakenWs) {
            this.krakenWs.terminate();
            this.krakenWs = null;
        }
        if (this.bybitWs) {
            this.bybitWs.terminate();
            this.bybitWs = null;
        }
    }

    private checkStaleness() {
        if (!this.isRunning) return;
        const now = Date.now();

        if (this.krakenWs?.readyState === WebSocket.OPEN) {
            const reference = this.krakenLastMarketDataAt || this.krakenConnectedAt;
            if (reference > 0 && now - reference > STALE_THRESHOLD_MS) {
                Logger.warn(`Kraken WS stale (${Math.round((now - reference) / 1000)}s since last market tick). Forcing reconnect.`);
                this.krakenWs.terminate();
                this.krakenWs = null;
                this.scheduleReconnect("kraken");
            } else {
                try { this.krakenWs.ping(); } catch { /* no-op */ }
            }
        }

        if (this.bybitWs?.readyState === WebSocket.OPEN) {
            const reference = this.bybitLastMarketDataAt || this.bybitConnectedAt;
            if (reference > 0 && now - reference > STALE_THRESHOLD_MS) {
                Logger.warn(`Bybit WS stale (${Math.round((now - reference) / 1000)}s since last market tick). Forcing reconnect.`);
                this.bybitWs.terminate();
                this.bybitWs = null;
                this.scheduleReconnect("bybit");
            } else {
                try { this.bybitWs.send(JSON.stringify({ op: "ping" })); } catch { /* no-op */ }
            }
        }
    }

    private connectKraken() {
        if (!this.isRunning) return;
        if (this.krakenWs && (
            this.krakenWs.readyState === WebSocket.OPEN ||
            this.krakenWs.readyState === WebSocket.CONNECTING
        )) return;

        try {
            const ws = new WebSocket("wss://ws.kraken.com/v2");
            this.krakenWs = ws;
            this.krakenLastMarketDataAt = 0;
            this.krakenConnectedAt = Date.now();

            ws.on("open", () => {
                if (this.krakenReconnectTimeout) clearTimeout(this.krakenReconnectTimeout);
                this.krakenReconnectTimeout = null;
                this.krakenConnectedAt = Date.now();
                Logger.info("Connected to Kraken Spot WebSocket");
                const symbols = this.getCryptoAssets().map((asset) => `${asset}/USD`);
                ws.send(JSON.stringify({
                    method: "subscribe",
                    params: { channel: "ticker", symbol: symbols },
                }));
            });

            ws.on("message", async (data) => {
                try {
                    const parsed = JSON.parse(data.toString());
                    const ticker = parsed.channel === "ticker" ? parsed.data?.[0] : null;
                    if (!ticker?.symbol || !ticker?.last) return;

                    const symbol = String(ticker.symbol).split("/")[0];
                    const price = Number(ticker.last);
                    if (!Number.isFinite(price) || price <= 0) return;

                    this.krakenLastMarketDataAt = Date.now();
                    const bidQty = Number(ticker.bid_qty);
                    const askQty = Number(ticker.ask_qty);
                    const imbalance = Number.isFinite(bidQty) && Number.isFinite(askQty) && bidQty + askQty > 0
                        ? (bidQty - askQty) / (bidQty + askQty)
                        : undefined;
                    await this.writeLiveTick(symbol, price, "KRAKEN_SPOT_WS", imbalance);
                } catch {
                    // Ignore malformed exchange frames; staleness detection
                    // reconnects the source if valid market data stops.
                }
            });

            ws.on("close", () => {
                if (this.krakenWs === ws) this.krakenWs = null;
                Logger.warn("Kraken WebSocket disconnected. Reconnecting in 5s...");
                this.scheduleReconnect("kraken");
            });

            ws.on("error", (error) => {
                console.error("Kraken WebSocket Error:", error);
            });
        } catch (error) {
            console.error("Failed to start Kraken WebSocket:", error);
            this.scheduleReconnect("kraken");
        }
    }

    private connectBybit() {
        if (!this.isRunning) return;
        if (this.bybitWs && (
            this.bybitWs.readyState === WebSocket.OPEN ||
            this.bybitWs.readyState === WebSocket.CONNECTING
        )) return;

        try {
            const ws = new WebSocket("wss://stream.bybit.com/v5/public/linear");
            this.bybitWs = ws;
            this.bybitLastMarketDataAt = 0;
            this.bybitConnectedAt = Date.now();

            ws.on("open", () => {
                if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
                this.bybitReconnectTimeout = null;
                this.bybitConnectedAt = Date.now();
                Logger.info("Connected to Bybit Futures WebSocket");
                const streams = this.getCryptoAssets().map((asset) => `tickers.${asset}USDT`);
                ws.send(JSON.stringify({ op: "subscribe", args: streams }));
            });

            ws.on("message", async (data) => {
                try {
                    const parsed = JSON.parse(data.toString());
                    if (!parsed.topic?.startsWith("tickers.") || !parsed.data) return;

                    const symbol = parsed.topic.split(".")[1].replace("USDT", "");
                    const price = Number(parsed.data.lastPrice);
                    if (!Number.isFinite(price) || price <= 0) return;

                    this.bybitLastMarketDataAt = Date.now();
                    const bidQty = Number(parsed.data.bid1Size);
                    const askQty = Number(parsed.data.ask1Size);
                    const imbalance = Number.isFinite(bidQty) && Number.isFinite(askQty) && bidQty + askQty > 0
                        ? (bidQty - askQty) / (bidQty + askQty)
                        : undefined;
                    await this.writeLiveTick(symbol, price, "BYBIT_LINEAR_WS", imbalance);
                } catch {
                    // Ignore malformed exchange frames; staleness detection
                    // reconnects the source if valid market data stops.
                }
            });

            ws.on("close", () => {
                if (this.bybitWs === ws) this.bybitWs = null;
                Logger.warn("Bybit WebSocket disconnected. Reconnecting in 5s...");
                this.scheduleReconnect("bybit");
            });

            ws.on("error", (error) => {
                console.error("Bybit WebSocket Error:", error);
            });
        } catch (error) {
            console.error("Failed to start Bybit WebSocket:", error);
            this.scheduleReconnect("bybit");
        }
    }

    private scheduleReconnect(source: "kraken" | "bybit") {
        if (!this.isRunning) return;
        if (source === "kraken") {
            if (this.krakenReconnectTimeout) clearTimeout(this.krakenReconnectTimeout);
            this.krakenReconnectTimeout = setTimeout(() => this.connectKraken(), 5_000);
        } else {
            if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
            this.bybitReconnectTimeout = setTimeout(() => this.connectBybit(), 5_000);
        }
    }
}
