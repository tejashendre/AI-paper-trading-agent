import { validateAiRunResetCommit, validateBrainEntryCommit, validateBrainObservationCommit, type BrainObservationCommit, type BrainEntryCommit, type AiRunResetCommit, type RawRedisSnapshot, type RedisClient } from "@/lib/redis";

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

  async readRaw(keys: string[]): Promise<RawRedisSnapshot> {
    const values: RawRedisSnapshot = {};
    for (const key of keys) {
      const entry = this.live(key);
      values[key] = entry ? { type: "string", value: entry.value } : this.lists.has(key)
        ? { type: "list", value: [...this.lists.get(key)!] } : { type: "none" };
    }
    return values;
  }

  async commitAiRunReset(input: AiRunResetCommit): Promise<string> {
    validateAiRunResetCommit(input);
    // No awaits inside this block: matches the indivisible Redis script.
    for (const [key, token] of Object.entries(input.leases)) {
      const lease = this.live(key);
      if (lease?.value !== token || lease.expiresAt === null) throw new Error(`Stale lease: ${key}`);
    }
    const prior = this.live(input.receiptKey)?.value;
    if (prior) {
      if (prior !== input.receipt) throw new Error("Run ID already used");
      if (!input.acknowledgeOnly) return prior;
    } else if (input.acknowledgeOnly) throw new Error("Missing reset commit receipt");
    for (const [pattern, expected] of Object.entries(input.inventories ?? {})) {
      const prefix = pattern.slice(0, -1);
      const observed = [...new Set([...this.strings.keys(), ...this.lists.keys()])]
        .filter((key) => key.startsWith(prefix) && (this.live(key) || this.lists.has(key))).sort();
      if (JSON.stringify(observed) !== JSON.stringify([...expected].sort())) throw new Error(`Archive inventory changed: ${pattern}`);
    }
    for (const [key, expected] of Object.entries(input.expected)) {
      const entry = this.live(key);
      const actual = entry ? { type: "string", value: entry.value } : this.lists.has(key)
        ? { type: "list", value: this.lists.get(key) } : { type: "none" };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Source changed: ${key}`);
    }
    for (const [key, value] of Object.entries(input.writes)) {
      this.lists.delete(key);
      this.strings.set(key, { value, expiresAt: null });
    }
    this.strings.set(input.receiptKey, { value: input.receipt, expiresAt: null });
    return input.receipt;
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

  async commitBrainEntry(input:BrainEntryCommit):Promise<string>{
    validateBrainEntryCommit(input);
    const prefix=`brain:v6:run:${input.runId}:`,lease=this.live('portfolio:write-lock:ai');
    if(lease?.value!==input.leaseToken||lease.expiresAt===null)throw new Error('Stale entry lease');
    if(Date.now()>input.expiresAtMs)throw new Error('Entry deadline expired');
    const active=this.live('brain:v6:activeRun');
    if(!active||JSON.parse(active.value).runId!==input.runId)throw new Error('AI epoch changed');
    if(this.live(prefix+'ledgerAcknowledged')?.value!=='true')throw new Error('AI run ledger not acknowledged');
    if((!input.kind||input.kind==='ENTRY')&&(this.live('brain:v6:migration-freeze')||this.live('swing:entryFreeze')))throw new Error('Entry frozen');
    const receiptKey=prefix+'transaction:'+input.transactionId,prior=this.live(receiptKey)?.value;
    if(prior){if(prior!==input.receipt)throw new Error('Entry transaction already used');return prior;}
    for(const [key,expected] of Object.entries(input.expected)){
      const entry=this.live(key),actual=entry?{type:'string',value:entry.value}:this.lists.has(key)?{type:'list',value:this.lists.get(key)}:{type:'none'};
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Entry source changed: '+key);
    }
    if(this.live(prefix+'trades'))throw new Error('Invalid trade history type');
    for(const item of input.events){const old=this.live(prefix+'outbox:'+item.id)?.value;if(old&&old!==item.event)throw new Error('Entry ledger event conflict');}
    const entryKeys=(!input.kind||input.kind==='ENTRY')?input.trades.flatMap(encoded=>{
      const trade=JSON.parse(encoded);return [prefix+'entryTrade:'+trade.id,prefix+'entryPosition:'+trade.positionId];
    }):[];
    if(entryKeys.some(key=>this.live(key)||this.lists.has(key)))throw new Error('Entry already committed');
    for(const key of [prefix+'portfolio','ai:portfolio'])this.strings.set(key,{value:input.portfolio,expiresAt:null});
    const trades=this.lists.get(prefix+'trades')??[];for(const trade of input.trades)trades.unshift(trade);this.lists.set(prefix+'trades',trades);
    for(const item of input.events)this.strings.set(prefix+'outbox:'+item.id,{value:item.event,expiresAt:null});
    for(const key of entryKeys)this.strings.set(key,{value:input.receipt,expiresAt:null});
    this.strings.set(receiptKey,{value:input.receipt,expiresAt:null});return input.receipt;
  }

  async commitBrainObservation(input:BrainObservationCommit):Promise<void>{
    validateBrainObservationCommit(input);
    const lease=this.live('portfolio:write-lock:ai');
    if(lease?.value!==input.leaseToken||lease.expiresAt===null)throw new Error('Stale observation lease');
    const active=this.live('brain:v6:activeRun');
    if(!active||JSON.parse(active.value).runId!==input.runId)throw new Error('Observation epoch changed');
    for(const [key,expected] of Object.entries(input.expected)){
      const entry=this.live(key),actual=entry?{type:'string',value:entry.value}:this.lists.has(key)?{type:'list',value:this.lists.get(key)}:{type:'none'};
      if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Observation source changed: '+key);
    }
    const prefix=`brain:v6:run:${input.runId}:`;
    for(const [key,value] of Object.entries(input.writes)){
      const mutable=[prefix+'shadow',prefix+'breakers'].includes(key)||key.startsWith(prefix+'latest:');
      if(!mutable&&(this.lists.has(key)||this.live(key)&&this.live(key)!.value!==value))throw new Error('Immutable evidence changed: '+key);
    }
    for(const [key,value] of Object.entries(input.writes))this.strings.set(key,{value,expiresAt:null});
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
    return [...new Set([...this.strings.keys(), ...this.lists.keys()])].filter((key) => regex.test(key) && (this.live(key) || this.lists.has(key)));
  }

  async ttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return this.lists.has(key) ? -1 : -2;
    return entry.expiresAt === null ? -1 : Math.ceil((entry.expiresAt - Date.now()) / 1000);
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
