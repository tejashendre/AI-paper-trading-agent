import type { RedisClient } from "@/lib/redis";

/**
 * In-memory stand-in for the Redis wrapper, with the same value encoding
 * (strings stored as-is, everything else JSON) and TTLs measured on
 * Date.now(), so expiry follows a mocked clock.
 */
export class MemoryRedis implements RedisClient {
  private strings = new Map<string, { value: string; expiresAt: number | null }>();
  private lists = new Map<string, string[]>();

  private live(key: string) {
    const entry = this.strings.get(key);
    if (entry && entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.live(key);
    if (!entry || !entry.value) return null;
    try {
      return JSON.parse(entry.value) as T;
    } catch {
      return entry.value as unknown as T;
    }
  }

  async getdel<T>(key: string): Promise<T | null> {
    const value = await this.get<T>(key);
    this.strings.delete(key);
    return value;
  }

  async set(key: string, val: unknown, opts?: { ex?: number; nx?: boolean }): Promise<"OK" | null> {
    if (opts?.nx && this.live(key)) return null;
    const value = typeof val === "string" || typeof val === "number" ? String(val) : JSON.stringify(val);
    this.strings.set(key, { value, expiresAt: opts?.ex ? Date.now() + opts.ex * 1000 : null });
    return "OK";
  }

  async del(key: string): Promise<number> {
    const removed = Number(this.strings.delete(key)) + Number(this.lists.delete(key));
    return removed > 0 ? 1 : 0;
  }

  async compareAndDelete(key: string, expectedValue: string): Promise<number> {
    if (this.live(key)?.value !== expectedValue) return 0;
    this.strings.delete(key);
    return 1;
  }

  async lpush(key: string, val: unknown): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(typeof val === "string" ? val : JSON.stringify(val));
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, end: number): Promise<string> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, end < 0 ? undefined : end + 1));
    return "OK";
  }

  async lrange(key: string, start: number, end: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, end < 0 ? undefined : end + 1);
  }

  async replaceList(key:string, rows:string[], lockKey:string, token:string):Promise<boolean> {
    if (this.live(lockKey)?.value!==token) return false;
    this.lists.set(key,[...rows]); return true;
  }

  async publish(): Promise<number> {
    return 0;
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    return [...this.strings.keys(), ...this.lists.keys()].filter((key) => regex.test(key));
  }

  async ttl(): Promise<number> {
    return -1;
  }

  async memoryUsage(): Promise<number> {
    return 0;
  }

  async quit(): Promise<void> {}

  /** Raw list rows, for assertions. */
  listRows(key: string): string[] {
    return [...(this.lists.get(key) ?? [])];
  }
}
