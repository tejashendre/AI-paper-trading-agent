import WebSocket from "ws";
import { getRedis } from "../lib/redis";
import { Logger } from "../lib/logger";
import { liveQuoteKey, SUPPORTED_ASSETS } from "../lib/market";
import path from "node:path";
import { BybitTickerBook, BybitTickerState } from "../lib/data/bybitPublic";
import { appendLiquidationMinutes, LiquidationMinutes } from "../lib/data/liquidationRecorder";
import { DEFAULT_RESEARCH_ARCHIVE_BYTES } from "../lib/research/researchArchive";

const BYBIT_LINEAR_STREAM = "wss://stream.bybit.com/v5/public/linear";
const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const QUOTE_RETENTION_SECONDS = 90;
const FLUSH_INTERVAL_MS = 1_000;
/** Topics per subscribe request, kept small to stay inside venue limits. */
const SUBSCRIBE_BATCH = 10;
const LIQUIDATION_FLUSH_MS = 60_000;

/**
 * One public Bybit linear connection for every configured instrument.
 *
 * The stream is a transport, not an independent source: REST from the same
 * venue recovers a quiet or disconnected stream, and nothing here compares
 * prices across venues. Ticker state belongs to one connection session; after
 * a reconnect a symbol has no quote until its fresh snapshot arrives, so a
 * delta is never applied on top of another session's state.
 */
export class WebsocketDataMesh {
    private ws: WebSocket | null = null;
    private isRunning = false;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private heartbeatInterval: NodeJS.Timeout | null = null;
    private flushInterval: NodeJS.Timeout | null = null;
    private liquidationInterval: NodeJS.Timeout | null = null;
    private liquidations = new LiquidationMinutes();
    private lastMarketDataAt = 0;
    private connectedAt = 0;
    private reconnectAttempts = 0;
    private book = new BybitTickerBook();
    private dirty = new Map<string, BybitTickerState>();
    private assetBySymbol = new Map(
        Object.entries(SUPPORTED_ASSETS).map(([asset, config]) => [config.bybitLinearSymbol, asset])
    );

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        await Logger.info("WebSocket Data Mesh starting (Bybit linear, all configured instruments)...");
        this.connect();
        this.heartbeatInterval = setInterval(() => this.checkStaleness(), HEARTBEAT_INTERVAL_MS);
        this.flushInterval = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
        this.liquidationInterval = setInterval(() => this.flushLiquidations(), LIQUIDATION_FLUSH_MS);
    }

    public stop() {
        this.isRunning = false;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        if (this.flushInterval) clearInterval(this.flushInterval);
        if (this.liquidationInterval) clearInterval(this.liquidationInterval);
        this.liquidationInterval = null;
        this.reconnectTimeout = null;
        this.heartbeatInterval = null;
        this.flushInterval = null;
        if (this.ws) {
            this.ws.terminate();
            this.ws = null;
        }
    }

    /**
     * Persist the latest state of every symbol that changed since the last
     * flush. Trailing, so the final update of a quiet market is still stored.
     */
    private async flush() {
        if (this.dirty.size === 0) return;
        const pending = [...this.dirty.values()];
        this.dirty.clear();
        const redis = getRedis();
        await Promise.all(pending.map(async (state) => {
            const asset = this.assetBySymbol.get(state.symbol);
            if (!asset) return;
            await redis.set(liveQuoteKey(asset), state, { ex: QUOTE_RETENTION_SECONDS }).catch(() => undefined);
        }));
    }

    /** Research recording only; a storage failure never touches quotes. */
    private flushLiquidations() {
        try {
            appendLiquidationMinutes({
                archiveDirectory: path.join(process.cwd(), "data", "research"),
                minutes: this.liquidations.drainClosed(Date.now()),
                maxBytes: Number(process.env.RESEARCH_ARCHIVE_MAX_BYTES || DEFAULT_RESEARCH_ARCHIVE_BYTES),
            });
        } catch (error) {
            Logger.warn(`Liquidation recording failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private checkStaleness() {
        if (!this.isRunning) return;
        // A socket stuck in CONNECTING (half-open TCP, proxy stall) never emits
        // close, so without this the mesh would wait forever with no quotes.
        if (this.ws?.readyState === WebSocket.CONNECTING && Date.now() - this.connectedAt > CONNECT_TIMEOUT_MS) {
            Logger.warn("Bybit WS connect timed out. Forcing reconnect.");
            const stalled = this.ws;
            this.ws = null;
            try { stalled.terminate(); } catch { /* no-op */ }
            this.scheduleReconnect();
            return;
        }
        // No socket and no pending reconnect (e.g. a constructor throw path): recover.
        if (!this.ws && !this.reconnectTimeout) { this.scheduleReconnect(); return; }
        if (this.ws?.readyState !== WebSocket.OPEN) return;
        const reference = this.lastMarketDataAt || this.connectedAt;
        if (reference > 0 && Date.now() - reference > STALE_THRESHOLD_MS) {
            void Logger.warn(`Bybit WS stale (${Math.round((Date.now() - reference) / 1000)}s since last market update). Forcing reconnect.`);
            this.ws.terminate();
            this.ws = null;
            this.scheduleReconnect();
            return;
        }
        // A pong proves the socket is alive; it is never treated as a quote.
        try { this.ws.send(JSON.stringify({ op: "ping" })); } catch { /* no-op */ }
    }

    private connect() {
        if (!this.isRunning) return;
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

        try {
            const ws = new WebSocket(BYBIT_LINEAR_STREAM);
            this.ws = ws;
            this.lastMarketDataAt = 0;
            this.connectedAt = Date.now();
            // New session: nothing from the previous connection may be extended.
            this.book.reset();
            this.dirty.clear();

            ws.on("open", () => {
                if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
                this.reconnectTimeout = null;
                this.connectedAt = Date.now();
                this.reconnectAttempts = 0;
                void Logger.info("Connected to Bybit linear WebSocket").catch(() => undefined);
                const topics = [...this.assetBySymbol.keys()].flatMap((symbol) => [`tickers.${symbol}`, `publicTrade.${symbol}`, `allLiquidation.${symbol}`]);
                for (let index = 0; index < topics.length; index += SUBSCRIBE_BATCH) {
                    ws.send(JSON.stringify({ op: "subscribe", args: topics.slice(index, index + SUBSCRIBE_BATCH) }));
                }
            });

            ws.on("message", (data) => {
                if (this.ws !== ws) return;
                let parsed: unknown;
                try {
                    parsed = JSON.parse(data.toString());
                } catch {
                    return;
                }
                if (this.liquidations.add(parsed)) return;
                const state = this.book.apply(parsed, Date.now());
                if (!state) return;
                this.lastMarketDataAt = Date.now();
                this.dirty.set(state.symbol, state);
            });

            ws.on("close", () => {
                // A socket already replaced by a forced reconnect must not reschedule.
                if (this.ws !== ws) return;
                this.ws = null;
                Logger.warn("Bybit WebSocket disconnected. Reconnecting...");
                this.scheduleReconnect();
            });

            ws.on("error", (error) => {
                console.error("Bybit WebSocket Error:", error instanceof Error ? error.message : error);
            });
        } catch (error) {
            console.error("Failed to start Bybit WebSocket:", error);
            this.scheduleReconnect();
        }
    }

    private scheduleReconnect() {
        if (!this.isRunning) return;
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        // 5s, 10s, 20s ... capped at 60s with jitter, so a venue outage or IP
        // throttle is not hammered while a brief blip still recovers quickly.
        const base = Math.min(MAX_RECONNECT_DELAY_MS, 5_000 * 2 ** Math.min(this.reconnectAttempts, 4));
        this.reconnectAttempts += 1;
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, base + Math.floor(Math.random() * 1_000));
    }
}
