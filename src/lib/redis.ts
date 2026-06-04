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
    this.client = new Redis(process.env.REDIS_URL || defaultUrl);
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

  async set(key: string, val: any, opts?: { ex?: number; nx?: boolean }): Promise<any> {
    const v = typeof val === 'string' || typeof val === 'number' ? String(val) : JSON.stringify(val);
    if (opts?.ex && opts?.nx) return this.client.set(key, v, 'EX', opts.ex, 'NX');
    if (opts?.ex) return this.client.set(key, v, 'EX', opts.ex);
    return this.client.set(key, v);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
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
}

let client: LocalRedisProxy | null = null;

export function getRedis(): LocalRedisProxy {
  if (!client) {
    client = new LocalRedisProxy();
  }
  return client;
}
