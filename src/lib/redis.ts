// ================================================================
// Upstash Redis Local Proxy using ioredis
// ================================================================

import Redis from "ioredis";
import fs from "fs";

function isDocker(): boolean {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export class LocalRedisProxy {
  private client: Redis;

  constructor() {
    // Connect to the local docker redis container, or fallback to localhost if running outside Docker
    const defaultUrl = isDocker() ? "redis://redis:6379" : "redis://127.0.0.1:6379";
    // Fail commands fast instead of queueing them forever. ioredis defaults to
    // an unbounded offline queue with infinite retries, so a Redis outage does
    // not surface as an error the caller can handle — it surfaces as a daemon
    // that silently stops doing anything, with every `await redis.get()`
    // pending indefinitely. Callers here already treat a rejected read as a
    // cache miss and fall through to the live source.
    this.client = new Redis(process.env.REDIS_URL || defaultUrl, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      retryStrategy: (attempt) => Math.min(2_000, attempt * 200),
    });
    // Without a listener an emitted connection error is an unhandled event and
    // takes the process down.
    this.client.on("error", () => undefined);
  }

  async get<T>(key: string): Promise<T | null> {
    const val = await this.client.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as any as T;
    }
  }

  async getdel<T>(key: string): Promise<T | null> {
    const val = await this.client.getdel(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return val as any as T;
    }
  }

  async set(key: string, val: any, opts?: { ex?: number; nx?: boolean }): Promise<any> {
    const v = typeof val === 'string' || typeof val === 'number' ? String(val) : JSON.stringify(val);
    if (opts?.ex && opts?.nx) return this.client.set(key, v, 'EX', opts.ex, 'NX');
    if (opts?.ex) return this.client.set(key, v, 'EX', opts.ex);
    return this.client.set(key, v);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<number> {
    return Number(await this.client.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      expectedValue
    ));
  }

  async lpush(key: string, val: any): Promise<number> {
    const v = typeof val === 'string' ? val : JSON.stringify(val);
    return this.client.lpush(key, v);
  }

  async ltrim(key: string, start: number, end: number): Promise<string> {
    const res = await this.client.ltrim(key, start, end);
    return res === "OK" ? "OK" : String(res);
  }

  async lrange(key: string, start: number, end: number): Promise<string[]> {
    return this.client.lrange(key, start, end);
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /**
   * Non-blocking key enumeration. Uses SCAN rather than KEYS: KEYS walks the
   * whole keyspace in one blocking call, which stalls every other client on a
   * single-threaded Redis — including the trading daemons.
   */
  async scanKeys(pattern: string, limit = 10_000): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.client.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      for (const key of batch) {
        found.push(key);
        if (found.length >= limit) return found;
      }
    } while (cursor !== "0");
    return found;
  }

  /** Remaining TTL in seconds: -1 means no expiry, -2 means the key is gone. */
  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  /** Approximate serialized size of a value, in bytes. */
  async memoryUsage(key: string): Promise<number> {
    try {
      const bytes = await this.client.memory("USAGE", key);
      return Number(bytes) || 0;
    } catch {
      return 0;
    }
  }

  async quit(): Promise<void> {
    await this.client.quit();
  }
}

let client: LocalRedisProxy | null = null;

export function getRedis(): LocalRedisProxy {
  if (!client) {
    client = new LocalRedisProxy();
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  const activeClient = client;
  client = null;
  if (activeClient) await activeClient.quit();
}
