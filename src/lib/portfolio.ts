import { getRedis } from "./redis";
import { Logger } from "./logger";
import { Portfolio, Trade, CompositeSignal } from "./types";

export class PortfolioManager {
    static getKeys(type: "user" | "ai" = "user") {
        return {
            portfolio: type === "ai" ? "ai:portfolio" : "user:portfolio",
            trades: type === "ai" ? "ai:trades" : "user:trades",
            signals: type === "ai" ? "ai:signals" : "user:signals"
        };
    }

    static async getPortfolio(type: "user" | "ai" = "user"): Promise<Portfolio> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        const data = await redis.get<Portfolio>(keys.portfolio);
        if (!data) {
            return this.resetPortfolio(type);
        }
        // Initialize dynamic fields if they do not exist
        if (!data.balances) {
            data.balances = {
                BTC: data.btc || 0,
                ETH: 0,
                SOL: 0,
                EURUSD: 0,
                GOLD: 0,
                OIL: 0,
                SILVER: 0
            };
        }
        if (data.totalFeesPaid === undefined) {
            data.totalFeesPaid = 0;
        }
        if (!data.openPositions) {
            data.openPositions = {};
            if (data.openPosition) {
                data.openPositions.BTC = {
                    ...data.openPosition,
                    asset: "BTC",
                    amount: data.openPosition.btcAmount
                };
            }
        }
        return data;
    }

    static async resetPortfolio(type: "user" | "ai" = "user", initialCapital: number = 10000): Promise<Portfolio> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        const initial: Portfolio = {
            usd: initialCapital,
            btc: 0,
            balances: {
                BTC: 0,
                ETH: 0,
                SOL: 0,
                EURUSD: 0,
                GOLD: 0,
                OIL: 0,
                SILVER: 0
            },
            openPositions: {},
            initialCapital: initialCapital,
            lastUpdated: new Date().toISOString(),
            totalPnl: 0,
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            grossProfit: 0,
            grossLoss: 0,
            consecutiveWins: 0,
            consecutiveLosses: 0,
            maxConsecutiveWins: 0,
            maxConsecutiveLosses: 0,
            peakValue: initialCapital,
            maxDrawdown: 0,
            maxDrawdownPercent: 0,
            returns: [],
            totalFeesPaid: 0,
            openPosition: null
        };
        await redis.set(keys.portfolio, initial);
        await redis.del(keys.trades);
        await redis.del(keys.signals);
        await Logger.info(`Portfolio [${type.toUpperCase()}] reset to initial state ($${initialCapital.toLocaleString()} USD)`);
        return initial;
    }

    static async updatePortfolio(portfolio: Portfolio, type: "user" | "ai" = "user"): Promise<void> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        portfolio.lastUpdated = new Date().toISOString();
        await redis.set(keys.portfolio, portfolio);
    }

    static async logTrade(trade: Trade, type: "user" | "ai" = "user"): Promise<void> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        await redis.lpush(keys.trades, JSON.stringify(trade));
    }

    static async getTrades(type: "user" | "ai" = "user"): Promise<Trade[]> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        const rawTrades = await redis.lrange(keys.trades, 0, 999);
        return rawTrades.map((t) => {
            if (typeof t === "string") {
                try { return JSON.parse(t) as Trade; } catch { return t as unknown as Trade; }
            }
            return t as Trade;
        });
    }

    static async saveSignal(signal: CompositeSignal, type: "user" | "ai" = "user"): Promise<void> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        await redis.lpush(keys.signals, JSON.stringify(signal));
        await redis.ltrim(keys.signals, 0, 99);
    }

    static async getRecentSignals(type: "user" | "ai" = "user"): Promise<CompositeSignal[]> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        const raw = await redis.lrange(keys.signals, 0, 10);
        return raw.map((s) => {
            if (typeof s === "string") {
                try { return JSON.parse(s) as CompositeSignal; } catch { return s as unknown as CompositeSignal; }
            }
            return s as CompositeSignal;
        });
    }
}
