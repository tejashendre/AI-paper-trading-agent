import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AI_RESET_EVIDENCE_PATTERNS, getRedis, type RedisClient, type RawRedisSnapshot, type RawRedisValue } from "@/lib/redis";
import { ExecutionLedger, type ExecutionLedgerEventType } from "@/lib/trading/executionLedger";

export const REPLACEMENT_BRAIN_VERSION = "replacement-swing-v6-2026-10-24" as const;
export const ACTIVE_AI_RUN_KEY = "brain:v6:activeRun";
export const REQUIRED_AI_RESET_LEASE_KEYS = [
  "brain:v6:migration-freeze", "portfolio:write-lock:ai", "portfolio:write-lock:user", "xsec:lock",
] as const;

export interface ActiveAiRun {
  runId: string;
  brainVersion: typeof REPLACEMENT_BRAIN_VERSION;
  startedAt: string;
  initialCapital: 10000;
  capital: 10000;
  highWaterEquity: 10000;
  mode: "SHADOW";
  xsecMode: "HISTORICAL_ONLY";
  archive: { path: string; sha256: string };
  ledgerEventId: string;
}

function validRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) throw new Error("Invalid run ID");
}

export function aiRunKeys(runId: string) {
  validRunId(runId);
  const prefix = `brain:v6:run:${runId}:`;
  return {
    portfolio: prefix + "portfolio", trades: prefix + "trades", signals: prefix + "signals",
    outcomes: prefix + "outcomes", counters: prefix + "counters", equity: prefix + "equity",
    ledgerAcknowledged: prefix + "ledgerAcknowledged",
  };
}

const HUMAN_KEYS = ["user:portfolio", "user:trades", "user:signals", "user:positionOutcomes", "swing:lastExitSweep:user",
  ...["BTC", "ETH", "SOL", "EURUSD", "GBPUSD", "USDJPY", "GOLD", "OIL", "SILVER"].map((asset) => `swing:cooldown:${asset}`),
];
const SOURCE_KEYS = [
  "ai:portfolio", "ai:trades", "ai:signals", "ai:positionOutcomes", "swing:equityCurve", "swing:lastExitSweep:ai",
  "swing:lifetimeStats:ai", "swing:lastScan:ai", "swing:scan:request",
  "xsec:portfolio", "xsec:trades", "xsec:lastRebalance", "xsec:equity", "xsec:equityCurve",
  "xsec:lastRebalanceAt", "xsec:riskRelease", "xsec:edgeVerdict", "swing:entryFreeze", "execution:ledger:head", ACTIVE_AI_RUN_KEY,
  "brain:v6:xsecMode",
];
// Only confirmed project payload namespaces. No all-keyspace scan or environment/config reads.
const EVIDENCE_PATTERNS = AI_RESET_EVIDENCE_PATTERNS;

export interface AiRunResetPreview {
  schemaVersion: 1;
  runId: string;
  brainVersion: typeof REPLACEMENT_BRAIN_VERSION;
  startedAt: string;
  archiveDirectory: string;
  capital: 10000;
  canReset: boolean;
  blockers: string[];
  requiredPreparation: string[];
  affectedKeys: string[];
  sources: RawRedisSnapshot;
  human: RawRedisSnapshot;
  sourceDigest: string;
  humanDigest: string;
  inventories: Record<string, string[]>;
  coverage: { archivedKeys: string[]; evidencePatterns: string[]; gaps: string[] };
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function safeArchiveDirectory(directory: string): string {
  if (!path.isAbsolute(directory)) throw new Error("Archive directory must be absolute");
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|99_PRIVATE|\.ssh)(?:$|[\\/])/i.test(resolved)) {
    throw new Error("Unsafe archive directory");
  }
  let current = resolved;
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Archive directory cannot contain symlinks");
    current = path.dirname(current);
  }
  return resolved;
}

function parsePortfolio(value: RawRedisValue | undefined, key: string, blockers: string[]): Record<string, unknown> | null {
  if (!value || value.type === "none") {
    if (key !== "xsec:portfolio") blockers.push(`${key}: missing source portfolio`);
    return null;
  }
  try {
    if (value.type !== "string") throw new Error("wrong type");
    const parsed = JSON.parse(value.value);
    const cash = parsed?.[key === "xsec:portfolio" ? "cashUsd" : "usd"];
    if (!parsed || Array.isArray(parsed) || typeof cash !== "number" || !Number.isFinite(cash)) throw new Error("invalid cash");
    return parsed;
  } catch {
    blockers.push(`${key}: malformed source portfolio`);
    return null;
  }
}

function activeSourcePortfolioKey(sources: RawRedisSnapshot, blockers: string[]): string | null {
  const raw = sources[ACTIVE_AI_RUN_KEY];
  if (!raw || raw.type === "none") return null;
  try {
    if (raw.type !== "string") throw new Error("wrong type");
    const active = JSON.parse(raw.value);
    if (!active || typeof active !== "object" || Array.isArray(active) || typeof active.runId !== "string") throw new Error("invalid active run");
    validRunId(active.runId);
    return aiRunKeys(active.runId).portfolio;
  } catch {
    blockers.push("Invalid active AI run ID/control record");
    return null;
  }
}

function readiness(sources: RawRedisSnapshot): string[] {
  const blockers: string[] = [];
  const activeKey = activeSourcePortfolioKey(sources, blockers);
  for (const key of ["ai:portfolio", "xsec:portfolio", ...(activeKey ? [activeKey] : [])]) {
    const p = parsePortfolio(sources[key], key, blockers);
    if (!p) continue;
    for (const field of ["openPositions", "scalpPositions", "positions", "balances"]) {
      const record = p[field];
      if (record === undefined) continue;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        blockers.push(`${key}.${field}: invalid position map`);
        continue;
      }
      for (const [asset, value] of Object.entries(record)) {
        if (field === "balances" ? value !== 0 : value !== null) blockers.push(`${key}.${field}.${asset}: requires staged REDUCE_ONLY closure and settlement`);
      }
    }
    if (p.openPosition != null || (p.btc !== undefined && p.btc !== 0)) blockers.push(`${key}: legacy position requires staged REDUCE_ONLY closure`);
    for (const field of ["fundingTail", "pendingLedgerEvents", "fundingPendingTimes", "pendingFundingEvents"]) {
      if (p[field] !== undefined && (!Array.isArray(p[field]) || (p[field] as unknown[]).length > 0)) blockers.push(`${key}.${field}: drain liabilities before reset`);
    }
  }
  return blockers;
}

function validatePreview(preview: AiRunResetPreview): void {
  const runKeys = Object.values(aiRunKeys(preview.runId));
  if (preview.schemaVersion !== 1 || preview.brainVersion !== REPLACEMENT_BRAIN_VERSION || preview.capital !== 10000 ||
      !Number.isFinite(Date.parse(preview.startedAt)) || digest(preview.sources) !== preview.sourceDigest || digest(preview.human) !== preview.humanDigest) throw new Error("Invalid preview digest/schema");
  const sourceKeys = [...SOURCE_KEYS, ...runKeys];
  if (sourceKeys.some((key) => !Object.hasOwn(preview.sources, key)) ||
      JSON.stringify(Object.keys(preview.human).sort()) !== JSON.stringify([...HUMAN_KEYS].sort())) throw new Error("Incomplete preview source/human snapshot");
  for (const key of Object.keys(preview.sources)) {
    if (!sourceKeys.includes(key) && !EVIDENCE_PATTERNS.some((pattern) => key.startsWith(pattern.slice(0, -1)))) throw new Error("Unexpected preview source key");
  }
  if (EVIDENCE_PATTERNS.some((pattern) => !Array.isArray(preview.inventories?.[pattern]))) throw new Error("Incomplete preview evidence inventory");
  if (runKeys.some((key) => preview.sources[key].type !== "none")) throw new Error("Target run ID already has run data");
}

export async function activeAiRun(redis: RedisClient = getRedis()): Promise<ActiveAiRun | null> {
  return redis.get<ActiveAiRun>(ACTIVE_AI_RUN_KEY);
}

/** Server-side preview contains raw data. Public routes must explicitly sanitize it. */
export async function previewAiRunReset(input: {
  runId: string; archiveDirectory: string; redis?: RedisClient; now?: string;
}): Promise<AiRunResetPreview> {
  validRunId(input.runId);
  const archiveDirectory = safeArchiveDirectory(input.archiveDirectory);
  const redis = input.redis ?? getRedis();
  const evidenceKeys: string[] = [];
  const inventories: Record<string, string[]> = {};
  for (const pattern of EVIDENCE_PATTERNS) {
    const keys = await redis.scanKeys(pattern, 10_001);
    if (keys.length >= 10_001) throw new Error(`Archive inventory exceeds safe bound: ${pattern}`);
    inventories[pattern] = [...new Set(keys)].sort();
    evidenceKeys.push(...keys);
  }
  const runKeys = Object.values(aiRunKeys(input.runId));
  const activeKey = activeSourcePortfolioKey(await redis.readRaw([ACTIVE_AI_RUN_KEY]), []);
  const sourceKeys = [...new Set([...SOURCE_KEYS, ...evidenceKeys, ...runKeys, ...(activeKey ? [activeKey] : [])])].sort();
  const snapshot = await redis.readRaw([...sourceKeys, ...HUMAN_KEYS]);
  const sources = Object.fromEntries(sourceKeys.map((key) => [key, snapshot[key]]));
  const human = Object.fromEntries(HUMAN_KEYS.map((key) => [key, snapshot[key]]));
  const blockers = readiness(sources);
  if (runKeys.some((key) => sources[key].type !== "none")) blockers.push("Target run ID already has run data");
  if (human["user:portfolio"].type !== "string") blockers.push("Missing raw human portfolio");
  const startedAt = input.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error("Invalid reset timestamp");
  return {
    schemaVersion: 1, runId: input.runId, brainVersion: REPLACEMENT_BRAIN_VERSION, startedAt,
    archiveDirectory, capital: 10000, canReset: blockers.length === 0, blockers,
    requiredPreparation: blockers.length ? [...blockers] : [],
    affectedKeys: ["ai:portfolio", ACTIVE_AI_RUN_KEY, "brain:v6:xsecMode", aiRunKeys(input.runId).portfolio, aiRunKeys(input.runId).counters],
    sources, human, sourceDigest: digest(sources), humanDigest: digest(human), inventories,
    coverage: { archivedKeys: sourceKeys, evidencePatterns: [...EVIDENCE_PATTERNS], gaps: [
      "Redis payload archive only. Ledger files remain in their existing append-only store; ledger head is captured.",
      "Only enumerated AI/XSEC keys and confirmed versioned evidence namespaces are captured; unknown scheduler namespaces are not claimed.",
    ] },
  };
}

function syncDirectory(directory: string): void {
  // Windows does not permit opening a directory for fsync. File handles are synced on every platform.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Exclusive publish makes a completed archive immutable, including concurrent retries. */
function durableArchive(preview: AiRunResetPreview): { path: string; sha256: string } {
  const directory = safeArchiveDirectory(preview.archiveDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${preview.runId}.json`);
  const bytes = JSON.stringify({ schemaVersion: 1, preview });
  const sha256 = digest(bytes);
  if (!fs.existsSync(filename)) {
    const temporary = path.join(directory, `${preview.runId}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.linkSync(temporary, filename); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { fs.unlinkSync(temporary); }
    syncDirectory(directory);
  }
  if (fs.lstatSync(filename).isSymbolicLink() || digest(fs.readFileSync(filename, "utf8")) !== sha256) throw new Error("Archive hash mismatch or run ID reused");
  return { path: filename, sha256 };
}

function freshPortfolio(startedAt: string) {
  return {
    usd: 10000, btc: 0, accountingCurrency: "USDT", balances: {}, openPositions: {}, scalpPositions: {}, openPosition: null,
    initialCapital: 10000, peakValue: 10000, totalPnl: 0, totalTrades: 0, winningTrades: 0, losingTrades: 0,
    grossProfit: 0, grossLoss: 0, consecutiveWins: 0, consecutiveLosses: 0, maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0, maxDrawdown: 0, maxDrawdownPercent: 0, returns: [], totalFeesPaid: 0,
    totalExecutionCostsPaid: 0, totalCarryPaid: 0, pendingLedgerEvents: [], fundingTail: [], lastUpdated: startedAt,
  };
}

/** Callers hold the freeze and all expiring write leases through durable acknowledgement. */
export async function resetAiRun(input: {
  preview: AiRunResetPreview; leases: Record<string, string>; redis?: RedisClient;
  acknowledge?: (run: ActiveAiRun) => Promise<void>;
}): Promise<ActiveAiRun> {
  const { preview } = input;
  validRunId(preview.runId);
  validatePreview(preview);
  if (!preview.canReset || readiness(preview.sources).length > 0) throw new Error(`AI reset not ready: ${preview.blockers.join("; ")}`);
  const redis = input.redis ?? getRedis();
  for (const key of REQUIRED_AI_RESET_LEASE_KEYS) {
    const raw = (await redis.readRaw([key]))[key];
    if (!input.leases[key] || raw.type !== "string" || raw.value !== input.leases[key] || await redis.ttl(key) <= 0) throw new Error(`Stale lease: ${key}`);
  }
  const archive = durableArchive(preview);
  const active: ActiveAiRun = {
    runId: preview.runId, brainVersion: REPLACEMENT_BRAIN_VERSION, startedAt: preview.startedAt,
    initialCapital: 10000, capital: 10000, highWaterEquity: 10000, mode: "SHADOW", xsecMode: "HISTORICAL_ONLY",
    archive, ledgerEventId: `AI_RUN_STARTED:${preview.runId}`,
  };
  const keys = aiRunKeys(preview.runId);
  const portfolio = JSON.stringify(freshPortfolio(preview.startedAt));
  const receipt = JSON.stringify({ active, sourceDigest: preview.sourceDigest, humanDigest: preview.humanDigest });
  const receiptKey = `brain:v6:reset:${preview.runId}`;
  const priorReceipt = (await redis.readRaw([receiptKey]))[receiptKey];
  const recovering = priorReceipt.type === "string" && priorReceipt.value === receipt;
  await redis.commitAiRunReset({
    receiptKey, receipt, leases: input.leases,
    expected: { ...preview.sources, ...preview.human },
    inventories: preview.inventories,
    writes: { [ACTIVE_AI_RUN_KEY]: JSON.stringify(active), "ai:portfolio": portfolio, [keys.portfolio]: portfolio,
      [keys.counters]: JSON.stringify({ scans: 0, decisions: 0, trades: 0 }), "brain:v6:xsecMode": "HISTORICAL_ONLY" },
  });
  const protectedHuman = await redis.readRaw(Object.keys(preview.human));
  // The immutable receipt proves the original switch compared the original raw
  // human bytes. A retry holds a new lease window: legitimate intervening human
  // activity is preserved, and only changes within this new window abort ack.
  // Lua cjson may reorder object metadata; raw strings and list order/bytes
  // still must match exactly. Preserve persisted preview digests and receipts.
  if (!recovering && !isDeepStrictEqual(protectedHuman, preview.human)) throw new Error("Human values changed after commit");
  // A failed/ambiguous acknowledgement leaves the immutable commit receipt intact.
  // recordOnce's deterministic ID prevents a retry appending a second start event.
  if (await redis.get(keys.ledgerAcknowledged) !== true) {
    if (input.acknowledge) await input.acknowledge(active);
    else await ExecutionLedger.recordOnce({
      id: active.ledgerEventId, type: "AI_RUN_STARTED" as ExecutionLedgerEventType,
      timestamp: active.startedAt, source: "reset-ai-run", payload: { ...active, humanDigest: preview.humanDigest, sourceDigest: preview.sourceDigest },
    });
  }
  await redis.commitAiRunReset({
    receiptKey, receipt, leases: input.leases, acknowledgeOnly: true,
    expected: { ...protectedHuman, [ACTIVE_AI_RUN_KEY]: { type: "string", value: JSON.stringify(active) } },
    writes: { [keys.ledgerAcknowledged]: "true" },
  });
  return active;
}
