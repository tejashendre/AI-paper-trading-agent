import WebSocket from "ws";
import { getRedis } from "../lib/redis";
import { Logger } from "../lib/logger";
import {
    marketImbalanceKey,
    marketLiveMetaKey,
    marketLivePriceKey,
    SUPPORTED_ASSETS,
} from "../lib/market";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 30_000;
const SOURCE_RETENTION_SECONDS = 90;
const SOURCE_PERSIST_INTERVAL_MS = 1_000;

interface LiveTickDetails {
    imbalance?: number;
    bid?: number;
    ask?: number;
    providerEventTime?: number | string;
}

export class WebsocketDataMesh {
    private krakenWs: WebSocket | null = null;
    private bybitWs: WebSocket | null = null;
    private binanceWs: WebSocket | null = null;
    private isRunning = false;
    private krakenReconnectTimeout: NodeJS.Timeout | null = null;
    private bybitReconnectTimeout: NodeJS.Timeout | null = null;
    private binanceReconnectTimeout: NodeJS.Timeout | null = null;
    private krakenLastMarketDataAt = 0;
    private bybitLastMarketDataAt = 0;
    private binanceLastMarketDataAt = 0;
    private krakenConnectedAt = 0;
    private bybitConnectedAt = 0;
    private binanceConnectedAt = 0;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private lastPersistedAt = new Map<string, number>();

    private getCryptoAssets() {
        return Object.keys(SUPPORTED_ASSETS).filter((key) => SUPPORTED_ASSETS[key].category === "crypto");
    }

    private async writeLiveTick(symbol: string, price: number, source: string, details: LiveTickDetails = {}) {
        const persistenceKey = `${source}:${symbol}`;
        const now = Date.now();
        if (now - (this.lastPersistedAt.get(persistenceKey) || 0) < SOURCE_PERSIST_INTERVAL_MS) return;
        this.lastPersistedAt.set(persistenceKey, now);

        const redis = getRedis();
        const updatedAt = new Date().toISOString();
        const providerTimestamp = new Date(details.providerEventTime || updatedAt);
        const providerEventTime = Number.isFinite(providerTimestamp.getTime())
            ? providerTimestamp.toISOString()
            : updatedAt;
        await redis.set(marketLivePriceKey(source, symbol), price.toString(), { ex: SOURCE_RETENTION_SECONDS });
        await redis.set(marketLiveMetaKey(source, symbol), {
            source,
            updatedAt,
            providerEventTime,
            price,
            bid: Number.isFinite(details.bid) ? details.bid : null,
            ask: Number.isFinite(details.ask) ? details.ask : null,
            imbalance: Number.isFinite(details.imbalance) ? details.imbalance : null,
        }, { ex: SOURCE_RETENTION_SECONDS });
        if (Number.isFinite(details.imbalance)) {
            await redis.set(
                marketImbalanceKey(source, symbol),
                String(details.imbalance),
                { ex: SOURCE_RETENTION_SECONDS }
            );
        }
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await Logger.info("WebSocket Data Mesh starting...");
        this.connectKraken();
        this.connectBybit();
        this.connectBinance();
        this.heartbeatInterval = setInterval(() => this.checkStaleness(), HEARTBEAT_INTERVAL_MS);
    }

    public stop() {
        this.isRunning = false;
        if (this.krakenReconnectTimeout) clearTimeout(this.krakenReconnectTimeout);
        if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
        if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.krakenReconnectTimeout = null;
        this.bybitReconnectTimeout = null;
        this.binanceReconnectTimeout = null;
        this.heartbeatInterval = null;
        if (this.krakenWs) {
            this.krakenWs.terminate();
            this.krakenWs = null;
        }
        if (this.bybitWs) {
            this.bybitWs.terminate();
            this.bybitWs = null;
        }
        if (this.binanceWs) {
            this.binanceWs.terminate();
            this.binanceWs = null;
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

        if (this.binanceWs?.readyState === WebSocket.OPEN) {
            const reference = this.binanceLastMarketDataAt || this.binanceConnectedAt;
            if (reference > 0 && now - reference > STALE_THRESHOLD_MS) {
                Logger.warn(`Binance WS stale (${Math.round((now - reference) / 1000)}s since last market tick). Forcing reconnect.`);
                this.binanceWs.terminate();
                this.binanceWs = null;
                this.scheduleReconnect("binance");
            } else {
                try { this.binanceWs.ping(); } catch { /* no-op */ }
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
                ws.send(JSON.stringify({
                    method: "subscribe",
                    params: { channel: "trade", symbol: symbols },
                }));
            });

            ws.on("message", async (data) => {
                try {
                    const parsed = JSON.parse(data.toString());
                    const ticker = parsed.channel === "ticker" ? parsed.data?.[0] : null;
                    const trades = parsed.channel === "trade" && Array.isArray(parsed.data) ? parsed.data : [];
                    const trade = trades.length > 0 ? trades[trades.length - 1] : null;
                    const observation = ticker || trade;
                    if (!observation?.symbol) return;

                    const symbol = String(observation.symbol).split("/")[0];
                    const price = Number(ticker?.last ?? trade?.price);
                    if (!Number.isFinite(price) || price <= 0) return;

                    this.krakenLastMarketDataAt = Date.now();
                    const bidQty = Number(ticker?.bid_qty);
                    const askQty = Number(ticker?.ask_qty);
                    const imbalance = Number.isFinite(bidQty) && Number.isFinite(askQty) && bidQty + askQty > 0
                        ? (bidQty - askQty) / (bidQty + askQty)
                        : undefined;
                    await this.writeLiveTick(symbol, price, "KRAKEN_SPOT_WS", {
                        imbalance,
                        bid: Number(ticker?.bid),
                        ask: Number(ticker?.ask),
                        providerEventTime: ticker?.timestamp || trade?.timestamp,
                    });
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
                const streams = this.getCryptoAssets().flatMap((asset) => [
                    `tickers.${asset}USDT`,
                    `publicTrade.${asset}USDT`,
                ]);
                ws.send(JSON.stringify({ op: "subscribe", args: streams }));
            });

            ws.on("message", async (data) => {
                try {
                    const parsed = JSON.parse(data.toString());
                    const isTicker = parsed.topic?.startsWith("tickers.");
                    const isTrade = parsed.topic?.startsWith("publicTrade.");
                    if ((!isTicker && !isTrade) || !parsed.data) return;

                    // Public trades prove the socket is alive, but only the
                    // ticker carries the selected venue's bid/ask context.
                    // Letting high-frequency trades share the persistence
                    // throttle can starve ticker snapshots and erase spread
                    // and imbalance provenance.
                    if (isTrade) {
                        this.bybitLastMarketDataAt = Date.now();
                        return;
                    }

                    const trades = isTrade && Array.isArray(parsed.data) ? parsed.data : [];
                    const trade = trades.length > 0 ? trades[trades.length - 1] : null;
                    const symbol = String(isTicker ? parsed.topic.split(".")[1] : trade?.s || "").replace("USDT", "");
                    const price = Number(isTicker ? parsed.data.lastPrice : trade?.p);
                    if (!Number.isFinite(price) || price <= 0) return;

                    this.bybitLastMarketDataAt = Date.now();
                    const bidQty = Number(isTicker ? parsed.data.bid1Size : undefined);
                    const askQty = Number(isTicker ? parsed.data.ask1Size : undefined);
                    const imbalance = Number.isFinite(bidQty) && Number.isFinite(askQty) && bidQty + askQty > 0
                        ? (bidQty - askQty) / (bidQty + askQty)
                        : undefined;
                    await this.writeLiveTick(symbol, price, "BYBIT_LINEAR_WS", {
                        imbalance,
                        bid: Number(isTicker ? parsed.data.bid1Price : undefined),
                        ask: Number(isTicker ? parsed.data.ask1Price : undefined),
                        providerEventTime: Number(isTicker ? parsed.ts : trade?.T),
                    });
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

    private connectBinance() {
        if (!this.isRunning) return;
        if (this.binanceWs && (
            this.binanceWs.readyState === WebSocket.OPEN ||
            this.binanceWs.readyState === WebSocket.CONNECTING
        )) return;

        try {
            const ws = new WebSocket("wss://data-stream.binance.vision/ws");
            this.binanceWs = ws;
            this.binanceLastMarketDataAt = 0;
            this.binanceConnectedAt = Date.now();

            ws.on("open", () => {
                if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
                this.binanceReconnectTimeout = null;
                this.binanceConnectedAt = Date.now();
                Logger.info("Connected to Binance Spot market-data WebSocket");
                ws.send(JSON.stringify({
                    method: "SUBSCRIBE",
                    params: this.getCryptoAssets().map((asset) => `${asset.toLowerCase()}usdt@trade`),
                    id: 1,
                }));
            });

            ws.on("message", async (data) => {
                try {
                    const parsed = JSON.parse(data.toString());
                    if (parsed?.e !== "trade" || !parsed?.s) return;

                    const symbol = String(parsed.s).replace("USDT", "");
                    const price = Number(parsed.p);
                    if (!Number.isFinite(price) || price <= 0) return;

                    this.binanceLastMarketDataAt = Date.now();
                    await this.writeLiveTick(symbol, price, "BINANCE_SPOT_WS", {
                        providerEventTime: Number(parsed.T || parsed.E),
                    });
                } catch {
                    // Ignore malformed exchange frames; staleness detection
                    // reconnects the source if valid market data stops.
                }
            });

            ws.on("close", () => {
                if (this.binanceWs === ws) this.binanceWs = null;
                Logger.warn("Binance WebSocket disconnected. Reconnecting in 5s...");
                this.scheduleReconnect("binance");
            });

            ws.on("error", (error) => {
                console.error("Binance WebSocket Error:", error);
            });
        } catch (error) {
            console.error("Failed to start Binance WebSocket:", error);
            this.scheduleReconnect("binance");
        }
    }

    private scheduleReconnect(source: "kraken" | "bybit" | "binance") {
        if (!this.isRunning) return;
        if (source === "kraken") {
            if (this.krakenReconnectTimeout) clearTimeout(this.krakenReconnectTimeout);
            this.krakenReconnectTimeout = setTimeout(() => this.connectKraken(), 5_000);
        } else if (source === "bybit") {
            if (this.bybitReconnectTimeout) clearTimeout(this.bybitReconnectTimeout);
            this.bybitReconnectTimeout = setTimeout(() => this.connectBybit(), 5_000);
        } else {
            if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
            this.binanceReconnectTimeout = setTimeout(() => this.connectBinance(), 5_000);
        }
    }
}
