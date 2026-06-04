import { getRedis } from "./redis";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "SUCCESS";

export interface LogEntry {
    id: string;
    timestamp: string;
    level: LogLevel;
    message: string;
    details?: unknown;
}

export class Logger {
    private static readonly LOG_KEY = "system:logs";
    private static readonly MAX_LOGS = 100;

    static async log(level: LogLevel, message: string, details?: unknown) {
        const entry: LogEntry = {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            level,
            message,
            details,
        };

        // 1. Console Log (for Vercel logs)
        const consoleMethod =
            level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
        consoleMethod(`[${level}] ${message}`, details ?? "");

        // 2. Redis Log (for Dashboard)
        try {
            const redis = getRedis();
            await redis.lpush(this.LOG_KEY, JSON.stringify(entry));
            await redis.ltrim(this.LOG_KEY, 0, this.MAX_LOGS - 1);
        } catch (error) {
            console.error("Failed to write log to Redis:", error);
        }
    }

    static async info(message: string, details?: unknown) {
        await this.log("INFO", message, details);
    }

    static async warn(message: string, details?: unknown) {
        await this.log("WARN", message, details);
    }

    static async error(message: string, details?: unknown) {
        await this.log("ERROR", message, details);
    }

    static async success(message: string, details?: unknown) {
        await this.log("SUCCESS", message, details);
    }

    static async getLogs(): Promise<LogEntry[]> {
        try {
            const redis = getRedis();
            const logs = await redis.lrange(this.LOG_KEY, 0, -1);
            // @upstash/redis auto-deserializes JSON strings, so logs are already objects.
            // No JSON.parse needed — that would crash!
            return logs.map((log) => {
                if (typeof log === "string") {
                    try { return JSON.parse(log); } catch { return { id: "", timestamp: "", level: "INFO", message: log }; }
                }
                return log as LogEntry;
            });
        } catch (error) {
            console.error("Failed to fetch logs:", error);
            return [];
        }
    }
}
