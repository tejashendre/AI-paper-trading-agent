import { getRedis } from "./redis";
import { Logger } from "./logger";
import { Portfolio, Trade, CompositeSignal } from "./types";
import crypto from "crypto";

function isValidPortfolio(value: unknown): value is Portfolio {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<Portfolio>;
    return Number.isFinite(Number(candidate.usd)) && Number(candidate.usd) >= 0;
}

function writeJsonAtomic(filePath: string, value: unknown) {
    const fs = require("fs");
    const path = require("path");
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2));
        fs.renameSync(temporaryPath, filePath);
    } finally {
        if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
}

export class PortfolioManager {
    static async acquireWriteLock(type: "user" | "ai", ttlSeconds = 300): Promise<(() => Promise<void>) | null> {
        const redis = getRedis();
        const key = `portfolio:write-lock:${type}`;
        const token = crypto.randomUUID();
        const acquired = await redis.set(key, token, { ex: ttlSeconds, nx: true });
        if (acquired !== "OK") return null;

        return async () => {
            await redis.compareAndDelete(key, token);
        };
    }

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
        let data = await redis.get<Portfolio>(keys.portfolio);
        
        // If data is null or failed to parse into an object (e.g. malformed string), try to recover from backup
        if (!isValidPortfolio(data)) {
            try {
                const fs = require('fs');
                const path = require('path');
                const backupPath = path.join(process.cwd(), 'data', `${type}_portfolio_backup.json`);
                if (fs.existsSync(backupPath)) {
                    const backupRaw = fs.readFileSync(backupPath, 'utf-8');
                    const backup = JSON.parse(backupRaw) as unknown;
                    if (isValidPortfolio(backup)) {
                        data = backup;
                        await Logger.info(`Redis portfolio [${type.toUpperCase()}] corrupted/missing. Auto-recovered from local JSON backup.`);
                        await redis.set(keys.portfolio, data);
                    }
                }
            } catch (e) {
                console.error("Backup recovery failed:", e);
            }

            if (!isValidPortfolio(data)) {
                return this.resetPortfolio(type, 10000, false);
            }
        }

        // Initialize dynamic fields if they do not exist
        if (!data.balances) {
            data.balances = {
                BTC: data.btc || 0,
                ETH: 0,
                SOL: 0,
                EURUSD: 0,
                GBPUSD: 0,
                GOLD: 0,
                OIL: 0,
                SILVER: 0
            };
        }
        for (const asset of ["BTC", "ETH", "SOL", "EURUSD", "GBPUSD", "USDJPY", "GOLD", "OIL", "SILVER"]) {
            if (data.balances[asset] === undefined) data.balances[asset] = 0;
        }
        if (data.totalFeesPaid === undefined) {
            data.totalFeesPaid = 0;
        }
        if (data.totalExecutionCostsPaid === undefined) {
            data.totalExecutionCostsPaid = data.totalFeesPaid || 0;
        }
        if (data.totalCarryPaid === undefined) {
            data.totalCarryPaid = 0;
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

    static async resetPortfolio(
        type: "user" | "ai" = "user",
        initialCapital: number = 10000,
        clearHistory = true
    ): Promise<Portfolio> {
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
                GBPUSD: 0,
                USDJPY: 0,
                GOLD: 0,
                OIL: 0,
                SILVER: 0
            },
            openPositions: {},
            scalpPositions: {},
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
            totalExecutionCostsPaid: 0,
            totalCarryPaid: 0,
            openPosition: null
        };
        await redis.set(keys.portfolio, initial);
        if (clearHistory) {
            await redis.del(keys.trades);
            await redis.del(keys.signals);
        }

        // A reset must also replace local recovery files. Otherwise a later
        // Redis loss can resurrect the portfolio and trade history that the
        // administrator intentionally cleared.
        try {
            const path = require('path');
            const dataDir = path.join(process.cwd(), 'data');
            writeJsonAtomic(path.join(dataDir, `${type}_portfolio_backup.json`), initial);
            if (clearHistory) writeJsonAtomic(path.join(dataDir, `${type}_trades_backup.json`), []);
        } catch (e) {
            console.error("Failed to synchronize reset backups:", e);
        }
        await Logger.info(`Portfolio [${type.toUpperCase()}] reset to initial state ($${initialCapital.toLocaleString()} USD)`);
        return initial;
    }

    static async updatePortfolio(portfolio: Portfolio, type: "user" | "ai" = "user"): Promise<void> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        portfolio.lastUpdated = new Date().toISOString();
        await redis.set(keys.portfolio, portfolio);

        // Save local backup to prevent total data loss if Redis crashes
        try {
            const path = require('path');
            const dataDir = path.join(process.cwd(), 'data');
            const backupPath = path.join(dataDir, `${type}_portfolio_backup.json`);
            writeJsonAtomic(backupPath, portfolio);
        } catch (e) {
            console.error("Failed to save portfolio backup:", e);
        }
    }

    static async logTrade(trade: Trade, type: "user" | "ai" = "user"): Promise<void> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        await redis.lpush(keys.trades, JSON.stringify(trade));
        // Trades are only ever read via lrange(0, 999); without a trim the
        // list grows forever and slowly eats the free-tier Redis storage.
        await redis.ltrim(keys.trades, 0, 999);

        // Save local backup to prevent total data loss if Redis crashes
        try {
            const fs = require('fs');
            const path = require('path');
            const dataDir = path.join(process.cwd(), 'data');
            if (!fs.existsSync(dataDir)) {
                fs.mkdirSync(dataDir, { recursive: true });
            }
            const backupPath = path.join(dataDir, `${type}_trades_backup.json`);
            let trades: Trade[] = [];
            if (fs.existsSync(backupPath)) {
                trades = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
            }
            trades.unshift(trade);
            if (trades.length > 1000) trades = trades.slice(0, 1000);
            writeJsonAtomic(backupPath, trades);
        } catch (e) {
            console.error("Failed to save trades backup:", e);
        }
    }

    static async getTrades(type: "user" | "ai" = "user"): Promise<Trade[]> {
        const redis = getRedis();
        const keys = this.getKeys(type);
        const rawTrades = await redis.lrange(keys.trades, 0, 999);
        let parsed = rawTrades.map((t) => {
            if (typeof t === "string") {
                try { return JSON.parse(t) as Trade; } catch { return null; }
            }
            return t as Trade;
        }).filter(t => t !== null) as Trade[];

        // If data is empty or failed to parse into an object, try to recover from backup
        if (parsed.length === 0) {
            try {
                const fs = require('fs');
                const path = require('path');
                const backupPath = path.join(process.cwd(), 'data', `${type}_trades_backup.json`);
                if (fs.existsSync(backupPath)) {
                    const backupRaw = fs.readFileSync(backupPath, 'utf-8');
                    const backup = JSON.parse(backupRaw) as unknown;
                    if (Array.isArray(backup)) {
                        parsed = backup as Trade[];
                        await Logger.info(`Redis trades [${type.toUpperCase()}] corrupted/missing. Auto-recovered from local JSON backup.`);
                        await redis.del(keys.trades);
                        for (let i = parsed.length - 1; i >= 0; i--) {
                            await redis.lpush(keys.trades, JSON.stringify(parsed[i]));
                        }
                    }
                }
            } catch (e) {
                console.error("Trades backup recovery failed:", e);
            }
        }
        
        return parsed;
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
