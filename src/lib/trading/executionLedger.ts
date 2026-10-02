import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { getRedis } from "@/lib/redis";
import { EXECUTION_COST_MODEL_VERSION } from "./executionCostModel";

export const TRADING_STRATEGY_VERSION = "swing-v5.0.0-2026-10-01";
export const EXECUTION_LEDGER_SCHEMA_VERSION = 1;

export type ExecutionLedgerEventType =
  | "RESEARCH_CANDIDATE_REGISTERED"
  | "RESEARCH_REVIEWED"
  | "LEDGER_COMPACTED"
  | "RESEARCH_PROMOTED"
  | "RESEARCH_DEMOTED"
  | "BOOK_RISK_RELEASED"
  | "SYSTEM_RESET"
  | "SCAN_COMPLETED"
  | "ENTRY_APPROVED"
  | "ENTRY_FILLED"
  | "ENTRY_BLOCKED"
  | "EXIT_FILLED"
  | "SCALE_IN_FILLED"
  | "PARTIAL_EXIT_FILLED"
  | "FUNDING_SETTLED"
  | "POSITION_COMPLETED"
  | "RISK_CIRCUIT_BREAKER"
  | "SYSTEM_ERROR";

export interface ExecutionLedgerEventInput {
  /** Immutable id for an event that may be retried; generated when absent. */
  id?: string;
  type: ExecutionLedgerEventType;
  source: string;
  asset?: string;
  decisionId?: string;
  tradeId?: string;
  /** Position the event belongs to. Absent on events written before position identity existed. */
  positionId?: string;
  timestamp?: string;
  payload: unknown;
}

export interface ExecutionLedgerRecord {
  schemaVersion: number;
  id: string;
  timestamp: string;
  type: ExecutionLedgerEventType;
  source: string;
  asset?: string;
  decisionId?: string;
  tradeId?: string;
  positionId?: string;
  strategyVersion: string;
  executionCostModelVersion: string;
  previousHash: string | null;
  payload: unknown;
  /** Set by compaction: this event's hash in the chain it was copied from. */
  originalHash?: string;
  hash: string;
}

export interface ExecutionLedgerVerification {
  valid: boolean;
  files: number;
  events: number;
  headHash: string | null;
  errors: string[];
}

const RECENT_KEY = "execution:ledger:recent";
const HEAD_KEY = "execution:ledger:head";
let writeQueue: Promise<unknown> = Promise.resolve();

function ledgerDirectory(): string {
  return process.env.EXECUTION_LEDGER_DIR || path.join(process.cwd(), "data", "execution-ledger");
}

function dayFile(timestamp: string, directory = ledgerDirectory()): string {
  return path.join(directory, `${timestamp.slice(0, 10)}.ndjson`);
}

function headFile(directory = ledgerDirectory()): string {
  return path.join(directory, "head.json");
}

/** Matches a day file whether or not it has been archived. */
const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.ndjson(\.gz)?$/;

/**
 * Every day file in chronological order, archived or not.
 *
 * The hash chain runs across day boundaries, so verification has to read the
 * archived days too. Sorting on the date prefix keeps plain and compressed
 * files interleaved correctly; a plain lexical sort would group every .gz
 * after every .ndjson, walk the chain out of order, and report a break on
 * essentially every file.
 */
function dayFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((file) => DAY_FILE_PATTERN.test(file))
    .sort((a, b) => {
      const dayA = a.slice(0, 10);
      const dayB = b.slice(0, 10);
      return dayA === dayB ? a.localeCompare(b) : dayA.localeCompare(dayB);
    });
}

/** Read a day file, transparently decompressing an archived one. */
function readDayFile(directory: string, file: string): string {
  const full = path.join(directory, file);
  return file.endsWith(".gz")
    ? zlib.gunzipSync(fs.readFileSync(full)).toString("utf8")
    : fs.readFileSync(full, "utf8");
}

function dayFileBytes(directory: string): number {
  return dayFiles(directory).reduce((sum, file) => sum + fs.statSync(path.join(directory, file)).size, 0);
}

/**
 * Compress day files older than `keepDays` so the ledger stops growing without
 * bound, while remaining fully verifiable.
 *
 * Deleting old events was the obvious alternative and is wrong: the records are
 * hash-chained, so removing any of them breaks every verification that follows.
 * Compression keeps every event and reclaims most of the space anyway --
 * measured at 8.7x on this schema, which turns 1.4GB into about 160MB.
 *
 * Today's file is never touched, because it is still being appended to.
 */
export function archiveLedgerDays(options: { keepDays?: number; directory?: string } = {}): {
  archived: string[];
  bytesBefore: number;
  bytesAfter: number;
  skipped: string[];
} {
  const directory = options.directory ?? ledgerDirectory();
  const keepDays = Math.max(1, options.keepDays ?? 7);
  const bytesBefore = dayFileBytes(directory);
  const archived: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(directory)) return { archived, bytesBefore: 0, bytesAfter: 0, skipped };

  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  for (const file of dayFiles(directory)) {
    if (file.endsWith(".gz")) continue;
    const day = file.slice(0, 10);
    if (day >= cutoff || day === today) continue;

    const source = path.join(directory, file);
    const target = `${source}.gz`;
    if (fs.existsSync(target)) { skipped.push(`${file} (archive already exists)`); continue; }

    try {
      const raw = fs.readFileSync(source);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, zlib.gzipSync(raw, { level: 9 }));
      // Prove the archive reads back byte-identical before removing the
      // original. A truncated archive would silently destroy audit evidence.
      const check = zlib.gunzipSync(fs.readFileSync(temporary));
      if (!check.equals(raw)) {
        fs.unlinkSync(temporary);
        skipped.push(`${file} (archive did not round-trip)`);
        continue;
      }
      fs.renameSync(temporary, target);
      fs.unlinkSync(source);
      archived.push(file);
    } catch (error) {
      skipped.push(`${file} (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  return { archived, bytesBefore, bytesAfter: dayFileBytes(directory), skipped };
}

export interface LedgerCompactionReport {
  status: "COMPACTED" | "WOULD_COMPACT" | "SKIPPED_BELOW_THRESHOLD" | "REFUSED_INVALID_SOURCE" | "REFUSED_UNSAFE_OPERATION" | "EMPTY";
  sourceEvents: number;
  keptEvents: number;
  droppedByType: Record<string, number>;
  droppedBytes: number;
  bytesBefore: number;
  bytesAfter: number;
  previousHeadHash: string | null;
  newHeadHash: string | null;
  errors: string[];
}

/**
 * Re-seal the ledger without the given event types (the owner chose this on
 * 2026-10-02 to drop the old per-minute scan records). Every other event is
 * copied with its id, content and timestamp, re-chained, and carries its old
 * hash as `originalHash`. The new chain starts with a LEDGER_COMPACTED
 * checkpoint naming the old head. The source must verify first, the result
 * must verify before it replaces the source, and the old files are then
 * removed. Run only while no process is appending (the deploy stops the
 * daemons first).
 */
export function compactLedger(options: {
  directory?: string;
  dropTypes: string[];
  /** Skip unless at least this many raw bytes would be reclaimed. */
  minDropBytes?: number;
  nowIso?: string;
  /** Report what would be reclaimed without changing anything. */
  dryRun?: boolean;
}): LedgerCompactionReport {
  const directory = options.directory ?? ledgerDirectory();
  const drop = new Set(options.dropTypes);
  const files = dayFiles(directory);
  const report: LedgerCompactionReport = {
    status: "EMPTY", sourceEvents: 0, keptEvents: 0, droppedByType: {}, droppedBytes: 0,
    bytesBefore: dayFileBytes(directory), bytesAfter: 0, previousHeadHash: null, newHeadHash: null, errors: [],
  };
  // Only scan telemetry was approved for removal. Never permit this utility
  // to erase financial evidence or overwrite an interrupted recovery copy.
  if ([...drop].some(type => type !== "SCAN_COMPLETED") ||
      fs.existsSync(`${directory}.pre-compaction`) || fs.existsSync(`${directory}.compacting`) ||
      fs.existsSync(path.join(directory, ".append.lock")) ||
      !Number.isFinite(options.minDropBytes ?? 0) || (options.minDropBytes ?? 0) < 0) {
    return { ...report, status: "REFUSED_UNSAFE_OPERATION", errors: ["Unsafe removal type, active writer, recovery files or invalid threshold; no files changed."] };
  }
  if (files.length === 0) return report;

  const source = ExecutionLedger.verify(directory);
  report.sourceEvents = source.events;
  report.previousHeadHash = source.headHash;
  if (!source.valid) {
    return { ...report, status: "REFUSED_INVALID_SOURCE", errors: source.errors.slice(0, 20) };
  }

  // First pass: what would be reclaimed.
  for (const file of files) {
    for (const line of readDayFile(directory, file).split(/\r?\n/)) {
      if (!line) continue;
      const type = (JSON.parse(line) as ExecutionLedgerRecord).type;
      if (!drop.has(type)) continue;
      report.droppedByType[type] = (report.droppedByType[type] ?? 0) + 1;
      report.droppedBytes += Buffer.byteLength(line) + 1;
    }
  }
  if (report.droppedBytes === 0 || report.droppedBytes < (options.minDropBytes ?? 50 * 1024 * 1024)) {
    return { ...report, status: "SKIPPED_BELOW_THRESHOLD", bytesAfter: report.bytesBefore };
  }
  if (options.dryRun) return { ...report, status: "WOULD_COMPACT", bytesAfter: report.bytesBefore };

  const staging = `${directory}.compacting`;
  fs.mkdirSync(staging, { recursive: true });
  let previousHash: string | null = null;
  let last: ExecutionLedgerRecord | null = null;
  const sign = (unsigned: Omit<ExecutionLedgerRecord, "hash">): ExecutionLedgerRecord => {
    const record = { ...unsigned, hash: computeExecutionEventHash(unsigned) };
    previousHash = record.hash;
    last = record;
    return record;
  };

  files.forEach((file, fileIndex) => {
    const out: string[] = [];
    const records = readDayFile(directory, file).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ExecutionLedgerRecord);
    if (fileIndex === 0) {
      out.push(JSON.stringify(sign({
        schemaVersion: EXECUTION_LEDGER_SCHEMA_VERSION,
        id: `ledger-compacted:${report.previousHeadHash}`,
        timestamp: records[0]?.timestamp ?? options.nowIso ?? new Date().toISOString(),
        type: "LEDGER_COMPACTED",
        source: "MAINTENANCE",
        strategyVersion: TRADING_STRATEGY_VERSION,
        executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
        previousHash: null,
        payload: {
          compactedAt: options.nowIso ?? new Date().toISOString(),
          compactedFromHeadHash: report.previousHeadHash,
          sourceEvents: report.sourceEvents,
          sourceVerified: true,
          droppedTypes: [...drop],
          droppedByType: report.droppedByType,
          reason: "Owner-approved storage reduction: per-minute scan records removed; every other event kept with its original hash.",
        },
      })));
    }
    for (const record of records) {
      if (drop.has(record.type)) continue;
      const { hash, previousHash: _oldPrevious, originalHash, ...content } = record;
      out.push(JSON.stringify(sign({ ...content, previousHash, originalHash: originalHash ?? hash })));
      report.keptEvents++;
    }
    if (out.length === 0) return;
    const text = `${out.join("\n")}\n`;
    const target = path.join(staging, file);
    fs.writeFileSync(target, file.endsWith(".gz") ? zlib.gzipSync(Buffer.from(text), { level: 9 }) : text);
  });
  if (last) writeHeadAtomic(staging, last);

  const check = ExecutionLedger.verify(staging);
  if (!check.valid || check.events !== report.keptEvents + 1) {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ...report, status: "REFUSED_INVALID_SOURCE", errors: ["Compacted chain failed verification", ...check.errors.slice(0, 20)] };
  }

  const retired = `${directory}.pre-compaction`;
  fs.renameSync(directory, retired);
  try {
    fs.renameSync(staging, directory);
  } catch (error) {
    // Restore the original directory if the replacement cannot be installed.
    fs.renameSync(retired, directory);
    throw error;
  }
  fs.rmSync(retired, { recursive: true, force: true });
  report.newHeadHash = check.headHash;
  report.bytesAfter = dayFileBytes(directory);
  report.status = "COMPACTED";
  return report;
}

/**
 * Point the Redis mirror (head and recent events) at the ledger on disk,
 * e.g. after a compaction re-sealed the chain.
 */
export async function refreshLedgerMirror(directory = ledgerDirectory()): Promise<void> {
  const files = dayFiles(directory);
  const tail: ExecutionLedgerRecord[] = [];
  for (let i = files.length - 1; i >= 0 && tail.length < 1000; i--) {
    const records = readDayFile(directory, files[i]).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ExecutionLedgerRecord);
    tail.unshift(...records.slice(-(1000 - tail.length)));
  }
  const redis = getRedis();
  await redis.del(RECENT_KEY);
  for (const record of tail) await redis.lpush(RECENT_KEY, JSON.stringify(record));
  const head = tail[tail.length - 1];
  if (head) {
    await redis.set(HEAD_KEY, { hash: head.hash, timestamp: head.timestamp, type: head.type,
      strategyVersion: head.strategyVersion, executionCostModelVersion: head.executionCostModelVersion });
  }
}

function sanitize(value: unknown, depth = 0, arrayLimit = 250): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, arrayLimit).map((entry) => sanitize(entry, depth + 1, arrayLimit));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|password|authorization|api.?key|signing.?key|token)/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = sanitize(entry, depth + 1, arrayLimit);
      }
    }
    return output;
  }
  return String(value);
}

function hashableRecord(record: Omit<ExecutionLedgerRecord, "hash">): string {
  return JSON.stringify(record);
}

export function computeExecutionEventHash(record: Omit<ExecutionLedgerRecord, "hash">): string {
  return crypto.createHash("sha256").update(hashableRecord(record)).digest("hex");
}

function readLastRecord(filePath: string): ExecutionLedgerRecord | null {
  if (!fs.existsSync(filePath)) return null;
  const stats = fs.statSync(filePath);
  if (stats.size <= 0) return null;
  let bytes = Math.min(stats.size, 128 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const buffer = Buffer.alloc(bytes);
      fs.readSync(descriptor, buffer, 0, bytes, stats.size - bytes);
      const tail = buffer.toString("utf8").trimEnd();
      const delimiter = tail.lastIndexOf('\n');
      if (delimiter >= 0 || bytes === stats.size) {
        const last = tail.slice(delimiter + 1);
        return last ? JSON.parse(last) as ExecutionLedgerRecord : null;
      }
      // A rare evidence record can exceed the normal tail window.
      bytes = Math.min(stats.size, bytes * 2);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function readHead(directory: string, currentFile: string): ExecutionLedgerRecord | null {
  const current = readLastRecord(currentFile);
  if (current) return current;
  const filePath = headFile(directory);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ExecutionLedgerRecord;
  } catch {
    return null;
  }
}

function writeHeadAtomic(directory: string, record: ExecutionLedgerRecord): void {
  const target = headFile(directory);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(record, null, 2));
    fs.renameSync(temporary, target);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

const APPEND_LOCK_STALE_MS = 30_000;
const APPEND_LOCK_WAIT_MS = 15_000;

/**
 * Hold an exclusive lock file for one append. The swing and cross-sectional
 * daemons (and an admin reset) are separate processes writing one chain;
 * without this, two of them can read the same head and fork it. A lock left
 * by a process that died is taken over once it is older than 30 seconds.
 */
async function withAppendLock<T>(directory: string, fn: () => T): Promise<T> {
  const lockPath = path.join(directory, ".append.lock");
  const deadline = Date.now() + APPEND_LOCK_WAIT_MS;
  for (;;) {
    try {
      const descriptor = fs.openSync(lockPath, "wx");
      fs.writeSync(descriptor, `${process.pid} ${new Date().toISOString()}`);
      fs.closeSync(descriptor);
      break;
    } catch (error) {
      // EEXIST is the normal "held" signal; Windows reports a lock file that
      // is mid-deletion as EPERM or EACCES, which is the same contention.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > APPEND_LOCK_STALE_MS) fs.unlinkSync(lockPath);
      } catch { /* released or taken over meanwhile */ }
      if (Date.now() > deadline) throw new Error("Execution ledger append lock is held by another process");
      await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

async function appendRecord(input: ExecutionLedgerEventInput): Promise<ExecutionLedgerRecord> {
  const timestamp = input.timestamp || new Date().toISOString();
  const directory = ledgerDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const record = await withAppendLock(directory, () => appendUnderLock(input, timestamp, directory));
  await mirrorToRedis(record);
  return record;
}

function appendUnderLock(input: ExecutionLedgerEventInput, timestamp: string, directory: string): ExecutionLedgerRecord {
  const filePath = dayFile(timestamp, directory);
  const previous = readHead(directory, filePath);
  const unsigned: Omit<ExecutionLedgerRecord, "hash"> = {
    schemaVersion: EXECUTION_LEDGER_SCHEMA_VERSION,
    id: input.id ?? crypto.randomUUID(),
    timestamp,
    type: input.type,
    source: input.source,
    asset: input.asset,
    decisionId: input.decisionId,
    tradeId: input.tradeId,
    // Undefined is dropped by JSON.stringify, so records without a position
    // hash exactly as they did before this field existed.
    positionId: input.positionId,
    strategyVersion: TRADING_STRATEGY_VERSION,
    executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
    previousHash: previous?.hash || null,
    payload: sanitize(input.payload, 0,
      ["RESEARCH_PROMOTED", "RESEARCH_DEMOTED", "BOOK_RISK_RELEASED"].includes(input.type) ? Infinity : 250),
  };
  const record: ExecutionLedgerRecord = {
    ...unsigned,
    hash: computeExecutionEventHash(unsigned),
  };

  const descriptor = fs.openSync(filePath, "a");
  try {
    fs.writeSync(descriptor, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  writeHeadAtomic(directory, record);
  return record;
}

async function mirrorToRedis(record: ExecutionLedgerRecord): Promise<void> {
  try {
    const redis = getRedis();
    await redis.lpush(RECENT_KEY, JSON.stringify(record));
    await redis.ltrim(RECENT_KEY, 0, 999);
    await redis.set(HEAD_KEY, {
      hash: record.hash,
      timestamp: record.timestamp,
      type: record.type,
      strategyVersion: record.strategyVersion,
      executionCostModelVersion: record.executionCostModelVersion,
    });
  } catch (error) {
    console.warn("[EXECUTION LEDGER] Redis mirror unavailable; durable file append succeeded.", error);
  }
}

export class ExecutionLedger {
  /** Rare decision proofs are retried after durable append but failed acknowledgement. */
  static recordOnce(input: ExecutionLedgerEventInput & { id: string }): Promise<ExecutionLedgerRecord> {
    const task = writeQueue.then(async () => {
      if (this.hasEvent(input.id, '1970-01-01')) {
        if (!this.verify().valid) throw new Error('Existing decision proof ledger is invalid');
        for (const file of dayFiles(ledgerDirectory())) {
          for (const row of readDayFile(ledgerDirectory(), file).split(/\r?\n/).filter(Boolean)) {
            const record = JSON.parse(row) as ExecutionLedgerRecord;
            if (record.id === input.id) return record;
          }
        }
        throw new Error('Existing decision proof is missing');
      }
      return appendRecord(input);
    });
    writeQueue = task.catch(() => undefined);
    return task;
  }

  static record(input: ExecutionLedgerEventInput): Promise<ExecutionLedgerRecord> {
    const task = writeQueue.then(() => appendRecord(input));
    writeQueue = task.catch(() => undefined);
    return task;
  }

  static async recordBestEffort(input: ExecutionLedgerEventInput): Promise<ExecutionLedgerRecord | null> {
    try {
      return await this.record(input);
    } catch (error) {
      console.error("[EXECUTION LEDGER] Failed to append event.", error);
      return null;
    }
  }

  /**
   * Whether an event id is already recorded in any day file from `sinceIso`'s
   * day onward. Used before re-appending a retried event, so a crash between
   * append and acknowledgement never duplicates it.
   */
  static hasEvent(id: string, sinceIso: string, directory = ledgerDirectory()): boolean {
    const since = sinceIso.slice(0, 10);
    const needle = `"id":${JSON.stringify(id)}`;
    return dayFiles(directory)
      .filter((file) => file.slice(0, 10) >= since)
      .some((file) => readDayFile(directory, file).includes(needle));
  }

  static verify(directory = ledgerDirectory(), throughHash?: string): ExecutionLedgerVerification {
    if (!fs.existsSync(directory)) {
      return { valid: true, files: 0, events: 0, headHash: null, errors: [] };
    }

    const files = dayFiles(directory);
    const errors: string[] = [];
    let previousHash: string | null = null;
    let events = 0;

    for (const file of files) {
      const rows = readDayFile(directory, file).split(/\r?\n/).filter(Boolean);
      for (let index = 0; index < rows.length; index++) {
        events++;
        try {
          const record = JSON.parse(rows[index]) as ExecutionLedgerRecord;
          const { hash, ...unsigned } = record;
          const expectedHash = computeExecutionEventHash(unsigned);
          if (record.previousHash !== previousHash) {
            errors.push(`${file}:${index + 1} previous hash mismatch`);
          }
          if (hash !== expectedHash) {
            errors.push(`${file}:${index + 1} event hash mismatch`);
          }
          previousHash = hash;
          // Maintenance can verify the same immutable prefix even if the
          // running daemons append new records during compression.
          if (throughHash && hash === throughHash) {
            return { valid: errors.length === 0, files: files.indexOf(file) + 1, events, headHash: hash, errors };
          }
        } catch (error) {
          errors.push(`${file}:${index + 1} invalid JSON (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }

    if (throughHash) errors.push("Requested ledger head was not found");
    return {
      valid: errors.length === 0,
      files: files.length,
      events,
      headHash: previousHash,
      errors,
    };
  }

  static status() {
    const directory = ledgerDirectory();
    const verification = this.verify(directory);
    const bytes = dayFileBytes(directory);
    return {
      ...verification,
      bytes,
      directory: path.relative(process.cwd(), directory) || ".",
      strategyVersion: TRADING_STRATEGY_VERSION,
      executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
    };
  }

  static quickStatus() {
    const directory = ledgerDirectory();
    const files = dayFiles(directory);
    const bytes = dayFileBytes(directory);
    let head: ExecutionLedgerRecord | null = null;
    const filePath = headFile(directory);
    if (fs.existsSync(filePath)) {
      try {
        head = JSON.parse(fs.readFileSync(filePath, "utf8")) as ExecutionLedgerRecord;
      } catch {}
    }
    return {
      files: files.length,
      bytes,
      headHash: head?.hash || null,
      lastEventAt: head?.timestamp || null,
      lastEventType: head?.type || null,
      strategyVersion: TRADING_STRATEGY_VERSION,
      executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
    };
  }
}
