// ================================================================
// Upstash Redis Local Proxy using ioredis
// ================================================================

import Redis from "ioredis";
import fs from "fs";
import { createHash } from 'node:crypto';

/** Exact stored bytes; decoded get() is unsuitable for migration comparisons. */
export type RawRedisValue = { type: "none" } | { type: "string"; value: string } | { type: "list"; value: string[] };
export type RawRedisSnapshot = Record<string, RawRedisValue>;
export interface BrainEntryCommit {
  kind?: 'ENTRY'|'EXIT'|'MARK'|'FUNDING';
  runId: string; transactionId: string; leaseToken: string; expected: RawRedisSnapshot;
  portfolio: string; trades: string[]; events: {id:string;event:string}[]; expiresAtMs: number; receipt: string;
}
export function brainEntryReceipt(input: Pick<BrainEntryCommit,'portfolio'|'trades'|'events'|'kind'>): string {
  return createHash('sha256').update(JSON.stringify({kind:input.kind??'ENTRY',portfolio:input.portfolio,trades:input.trades,events:input.events})).digest('hex');
}
export interface BrainObservationCommit {runId:string;leaseToken:string;expected:RawRedisSnapshot;writes:Record<string,string>}
export function validateBrainObservationCommit(input:BrainObservationCommit):void{
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.runId)||!input.leaseToken||input.expected['brain:v6:activeRun']?.type!=='string')throw new Error('Invalid observation epoch or lease');
  const prefix=`brain:v6:run:${input.runId}:`;
  const allowed=(key:string)=>[prefix+'shadow',prefix+'breakers',prefix+'drawdown'].includes(key)||
    key.startsWith(prefix)&&/^(?:proof|latest):[a-f0-9]{64}$/.test(key.slice(prefix.length))||/^brain:v6:retired:[a-f0-9]{64}$/.test(key);
  if(Object.keys(input.writes).length===0||Object.keys(input.writes).some(k=>!allowed(k)||!Object.hasOwn(input.expected,k)))throw new Error('Forbidden observation write or missing previous head');
  // Redis scripts do not roll back earlier commands after a runtime error.
  // Validate every SET argument before allowing the first observation write.
  if(Object.values(input.writes).some(value=>typeof value!=='string'))throw new Error('Observation write values must be strings');
}
export function validateBrainEntryCommit(input: BrainEntryCommit): void {
  // JSON.parse coerces arrays and objects. Lua SET/LPUSH require actual strings
  // so reject all malformed arguments before any financial write can begin.
  if(typeof input.portfolio!=='string'||!Array.isArray(input.trades)||input.trades.some(trade=>typeof trade!=='string')||
    !Array.isArray(input.events)||input.events.some(event=>!event||typeof event.event!=='string'))throw new Error('Financial payload values must be strings');
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.runId)||!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$/.test(input.transactionId)||
    !input.leaseToken||!Number.isFinite(input.expiresAtMs)||input.receipt!==brainEntryReceipt(input))throw new Error('Invalid entry identity, deadline or financial payload receipt');
  const prefix=`brain:v6:run:${input.runId}:`;
  if(input.expected['brain:v6:activeRun']?.type!=='string'||input.expected[prefix+'portfolio']?.type!=='string')throw new Error('Entry requires exact epoch and portfolio snapshots');
  const portfolio=JSON.parse(input.portfolio);
  const kind=input.kind??'ENTRY';
  if(!['ENTRY','EXIT','MARK','FUNDING'].includes(kind)||!portfolio||!Number.isFinite(portfolio.usd)||(kind==='ENTRY'&&portfolio.usd<0)||!portfolio.openPositions||!Array.isArray(input.trades)||input.trades.length>9||!Array.isArray(input.events)||input.events.length>5000||
    (kind==='ENTRY'||kind==='EXIT')&&(input.trades.length<1||input.events.length<1)||
    (kind==='MARK'||kind==='FUNDING')&&input.trades.length!==0)throw new Error('Invalid financial mutation payload');
  const ids=new Set<string>(),positions=new Set<string>();
  for(const raw of input.trades){const t=JSON.parse(raw);if(typeof t.id!=='string'||!t.id||t.id.length>512||ids.has(t.id)||
    kind==='ENTRY'&&(typeof t.positionId!=='string'||!t.positionId||t.positionId.length>512||positions.has(t.positionId))||
    t.brainRunId!==input.runId||!(kind==='EXIT'?['SELL','COVER']:['BUY','SHORT']).includes(t.action))throw new Error('Invalid or duplicate financial trade');ids.add(t.id);positions.add(t.positionId);}
  const events=new Set<string>();
  for(const item of input.events){if(!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,511}$/.test(item.id)||events.has(item.id)||JSON.parse(item.event).id!==item.id)throw new Error('Invalid entry ledger event');events.add(item.id);}
}
export const AI_RESET_EVIDENCE_PATTERNS = ["learning:*", "opportunity:*", "tradeReview:*", "research:*", "brain:v6:run:*", "brain:v6:retired:*"] as const;
export interface AiRunResetCommit {
  receiptKey: string;
  receipt: string;
  leases: Record<string, string>;
  expected: RawRedisSnapshot;
  writes: Record<string, string>;
  acknowledgeOnly?: boolean;
  inventories?: Record<string, string[]>;
}

/** Restrict the migration primitive to the reviewed reset control surface. */
export function validateAiRunResetCommit(input: AiRunResetCommit): void {
  const match = /^brain:v6:reset:([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(input.receiptKey);
  if (!match) throw new Error("Invalid reset receipt key");
  const prefix = `brain:v6:run:${match[1]}:`;
  if (input.acknowledgeOnly && Object.keys(input.writes).some((key) => key !== prefix + "ledgerAcknowledged")) throw new Error("Forbidden acknowledgement write");
  for (const key of Object.keys(input.writes)) {
    if (!["brain:v6:activeRun", "ai:portfolio", "brain:v6:xsecMode"].includes(key) &&
        !["portfolio", "counters", "ledgerAcknowledged"].some((suffix) => key === prefix + suffix)) {
      throw new Error(`Forbidden AI reset write: ${key}`);
    }
  }
  for (const key of ["brain:v6:migration-freeze", "portfolio:write-lock:ai", "portfolio:write-lock:user", "xsec:lock"]) {
    if (!input.leases[key]) throw new Error(`Missing required lease: ${key}`);
  }
  for (const pattern of Object.keys(input.inventories ?? {})) {
    if (!(AI_RESET_EVIDENCE_PATTERNS as readonly string[]).includes(pattern)) throw new Error("Forbidden reset inventory pattern");
  }
}

const RAW_VALUE_LUA = `
local function raw(key)
  local kind = redis.call('type', key).ok
  if kind == 'none' then return {type='none'} end
  if kind == 'string' then return {type='string', value=redis.call('get', key)} end
  if kind == 'list' then return {type='list', value=redis.call('lrange', key, 0, -1)} end
  error('Unsupported reset payload type: '..key..' '..kind)
end
local function same(a,b)
  if a.type ~= b.type then return false end
  if a.type == 'string' then return a.value == b.value end
  if a.type == 'list' then
    if #a.value ~= #b.value then return false end
    for i=1,#a.value do if a.value[i] ~= b.value[i] then return false end end
  end
  return true
end
`;

function isDocker(): boolean {
  try {
    return fs.existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

export class LocalRedisProxy {
  private client: Redis;

  constructor(redisUrl?: string) {
    // Connect to the local docker redis container, or fallback to localhost if running outside Docker
    const defaultUrl = isDocker() ? "redis://redis:6379" : "redis://127.0.0.1:6379";
    // Bound how long a command may hang, without breaking normal startup.
    //
    // ioredis defaults to unlimited per-request retries, so a Redis outage does
    // not surface as an error a caller can handle - it surfaces as a daemon
    // that silently stops doing anything, every `await redis.get()` pending
    // forever. `maxRetriesPerRequest` fixes that: once the limit is reached the
    // queued commands are flushed with an error instead of waiting.
    //
    // The offline queue stays ENABLED. Disabling it also rejects commands
    // issued during the normal connect handshake, which turned every container
    // restart into a window of HTTP 500s from the status API and lost the
    // daemons' own startup logs. Queue-then-bound is the correct combination:
    // a brief reconnect is absorbed, a genuine outage still fails fast.
    this.client = new Redis(redisUrl ?? (process.env.REDIS_URL || defaultUrl), {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      connectTimeout: 10_000,
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

  async readRaw(keys: string[]): Promise<RawRedisSnapshot> {
    if (keys.length === 0) return {};
    const encoded = await this.client.eval(RAW_VALUE_LUA +
      "local out = {}; for _,key in ipairs(KEYS) do out[key] = raw(key) end; return cjson.encode(out)", keys.length, ...keys);
    const result = JSON.parse(String(encoded)) as RawRedisSnapshot;
    // Redis's Lua cjson encodes an empty Lua table as {}, including empty lists.
    for (const value of Object.values(result)) if (value.type === "list" && !Array.isArray(value.value)) value.value = [];
    return result;
  }

  /** One fenced compare-and-switch, with an immutable receipt for ambiguous replies. */
  async commitAiRunReset(input: AiRunResetCommit): Promise<string> {
    validateAiRunResetCommit(input);
    return String(await this.client.eval(RAW_VALUE_LUA + `
      local p = cjson.decode(ARGV[1])
      for key,token in pairs(p.leases) do
        if redis.call('get', key) ~= token or redis.call('pttl',key) <= 0 then return redis.error_reply('Stale lease: '..key) end
      end
      local prior = redis.call('get',p.receiptKey)
      if prior then
        if prior ~= p.receipt then return redis.error_reply('Run ID already used') end
        if not p.acknowledgeOnly then return prior end
      elseif p.acknowledgeOnly then
        return redis.error_reply('Missing reset commit receipt')
      end
      for pattern,keys in pairs(p.inventories or {}) do
        local expected = {}; for _,key in ipairs(keys) do expected[key] = true end
        local observed = {}; local cursor = '0'
        repeat
          local page = redis.call('scan',cursor,'MATCH',pattern,'COUNT',500)
          cursor = page[1]
          for _,key in ipairs(page[2]) do
            if not expected[key] then return redis.error_reply('Archive inventory changed: '..key) end
            observed[key] = true
          end
        until cursor == '0'
        for key,_ in pairs(expected) do if not observed[key] then return redis.error_reply('Archive inventory changed: '..key) end end
      end
      for key,value in pairs(p.expected) do
        if not same(raw(key),value) then return redis.error_reply('Source changed: '..key) end
      end
      for key,value in pairs(p.writes) do redis.call('set',key,value) end
      redis.call('set',p.receiptKey,p.receipt)
      return p.receipt
    `, 0, JSON.stringify(input)));
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

  /** A fill and its durable financial outbox are one fenced state change. */
  async commitBrainEntry(input: BrainEntryCommit): Promise<string> {
    validateBrainEntryCommit(input);
    return String(await this.client.eval(RAW_VALUE_LUA+`
      local p=cjson.decode(ARGV[1]); local prefix='brain:v6:run:'..p.runId..':'
      if redis.call('get','portfolio:write-lock:ai')~=p.leaseToken or redis.call('pttl','portfolio:write-lock:ai')<=0 then return redis.error_reply('Stale entry lease') end
      local clock=redis.call('time'); local now=tonumber(clock[1])*1000+tonumber(clock[2])/1000
      if now>p.expiresAtMs then return redis.error_reply('Entry deadline expired') end
      local active=redis.call('get','brain:v6:activeRun')
      if not active or cjson.decode(active).runId~=p.runId then return redis.error_reply('AI epoch changed') end
      if redis.call('get',prefix..'ledgerAcknowledged')~='true' then return redis.error_reply('AI run ledger not acknowledged') end
      if (not p.kind or p.kind=='ENTRY') and redis.call('exists','brain:v6:migration-freeze','swing:entryFreeze')>0 then return redis.error_reply('Entry frozen') end
      local receiptKey=prefix..'transaction:'..p.transactionId; local prior=redis.call('get',receiptKey)
      if prior then if prior~=p.receipt then return redis.error_reply('Entry transaction already used') end; return prior end
      for key,value in pairs(p.expected) do if not same(raw(key),value) then return redis.error_reply('Entry source changed: '..key) end end
      local kind=redis.call('type',prefix..'trades').ok
      if kind~='none' and kind~='list' then return redis.error_reply('Invalid trade history type') end
      for _,item in ipairs(p.events) do
        local previous=redis.call('get',prefix..'outbox:'..item.id)
        if previous and previous~=item.event then return redis.error_reply('Entry ledger event conflict') end
      end
      local entryKeys={}
      if not p.kind or p.kind=='ENTRY' then
        for _,encoded in ipairs(p.trades) do
          local trade=cjson.decode(encoded)
          for _,key in ipairs({prefix..'entryTrade:'..trade.id,prefix..'entryPosition:'..trade.positionId}) do
            if redis.call('exists',key)>0 then return redis.error_reply('Entry already committed') end
            entryKeys[#entryKeys+1]=key
          end
        end
      end
      redis.call('set',prefix..'portfolio',p.portfolio); redis.call('set','ai:portfolio',p.portfolio)
      for _,trade in ipairs(p.trades) do redis.call('lpush',prefix..'trades',trade) end
      for _,item in ipairs(p.events) do redis.call('set',prefix..'outbox:'..item.id,item.event) end
      for _,key in ipairs(entryKeys) do redis.call('set',key,p.receipt) end
      redis.call('set',receiptKey,p.receipt); return p.receipt
    `,0,JSON.stringify(input)));
  }

  async commitBrainObservation(input:BrainObservationCommit):Promise<void>{
    validateBrainObservationCommit(input);
    await this.client.eval(RAW_VALUE_LUA+`
      local p=cjson.decode(ARGV[1])
      if redis.call('get','portfolio:write-lock:ai')~=p.leaseToken or redis.call('pttl','portfolio:write-lock:ai')<=0 then return redis.error_reply('Stale observation lease') end
      local active=redis.call('get','brain:v6:activeRun')
      if not active or cjson.decode(active).runId~=p.runId then return redis.error_reply('Observation epoch changed') end
      for key,value in pairs(p.expected) do if not same(raw(key),value) then return redis.error_reply('Observation source changed: '..key) end end
      local prefix='brain:v6:run:'..p.runId..':'
      for key,value in pairs(p.writes) do
        local mutable=key==prefix..'shadow' or key==prefix..'breakers' or string.sub(key,1,#prefix+7)==prefix..'latest:'
        if not mutable then local old=redis.call('get',key); if old and old~=value then return redis.error_reply('Immutable evidence changed: '..key) end end
      end
      for key,value in pairs(p.writes) do redis.call('set',key,value) end
      return 1
    `,0,JSON.stringify(input));
  }

  async set(key: string, val: any, opts?: { ex?: number; nx?: boolean }): Promise<any> {
    const v = typeof val === 'string' || typeof val === 'number' ? String(val) : JSON.stringify(val);
    if (opts?.ex && opts?.nx) return this.client.set(key, v, 'EX', opts.ex, 'NX');
    if (opts?.ex) return this.client.set(key, v, 'EX', opts.ex);
    if (opts?.nx) return this.client.set(key, v, 'NX');
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

  /** Replace a bounded list atomically, fenced by the caller's live lease. */
  async replaceList(key: string, rows: string[], lockKey: string, token: string): Promise<boolean> {
    return Number(await this.client.eval(
      "if redis.call('get', KEYS[2]) ~= ARGV[1] then return 0 end " +
      "redis.call('del', KEYS[1]); for i=2,#ARGV do redis.call('rpush', KEYS[1], ARGV[i]) end; return 1",
      2, key, lockKey, token, ...rows
    )) === 1;
  }

  async publish(channel: string, message: string): Promise<number> {
    return this.client.publish(channel, message);
  }

  /**
   * Non-blocking key enumeration. Uses SCAN rather than KEYS: KEYS walks the
   * whole keyspace in one blocking call, which stalls every other client on a
   * single-threaded Redis - including the trading daemons.
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

/** The public surface every caller uses; an in-memory stand-in implements the same. */
export type RedisClient = Pick<
  LocalRedisProxy,
  "get" | "getdel" | "set" | "del" | "compareAndDelete" | "lpush" | "ltrim" | "lrange" | "replaceList" | "publish" | "scanKeys" | "ttl" | "memoryUsage" | "quit" | "readRaw" | "commitAiRunReset" | "commitBrainEntry" | "commitBrainObservation"
>;

/**
 * Replace the shared client, e.g. with an in-memory store for an offline
 * integration test. Pass null to return to the real connection.
 */
export function setRedisClient(replacement: RedisClient | null): void {
  client = replacement as LocalRedisProxy | null;
}

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
