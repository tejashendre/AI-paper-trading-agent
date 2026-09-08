import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { getRedis } from "@/lib/redis";
import { EXECUTION_COST_MODEL_VERSION } from "./executionCostModel";

export const TRADING_STRATEGY_VERSION = "swing-v4.2.0-2026-08-04";
export const EXECUTION_LEDGER_SCHEMA_VERSION = 1;

export type ExecutionLedgerEventType =
  | "SYSTEM_RESET"
  | "SCAN_COMPLETED"
  | "ENTRY_APPROVED"
  | "ENTRY_FILLED"
  | "ENTRY_BLOCKED"
  | "EXIT_FILLED"
  | "SCALE_IN_FILLED"
  | "PARTIAL_EXIT_FILLED"
  | "RISK_CIRCUIT_BREAKER"
  | "SYSTEM_ERROR";

export interface ExecutionLedgerEventInput {
  type: ExecutionLedgerEventType;
  source: string;
  asset?: string;
  decisionId?: string;
  tradeId?: string;
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
  strategyVersion: string;
  executionCostModelVersion: string;
  previousHash: string | null;
  payload: unknown;
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

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 10) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 250).map((entry) => sanitize(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|password|authorization|api.?key|signing.?key|token)/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = sanitize(entry, depth + 1);
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
  const bytes = Math.min(stats.size, 128 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    fs.readSync(descriptor, buffer, 0, bytes, stats.size - bytes);
    const lines = buffer.toString("utf8").trim().split(/\r?\n/);
    const last = lines[lines.length - 1];
    return last ? JSON.parse(last) as ExecutionLedgerRecord : null;
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

async function appendRecord(input: ExecutionLedgerEventInput): Promise<ExecutionLedgerRecord> {
  const timestamp = input.timestamp || new Date().toISOString();
  const directory = ledgerDirectory();
  fs.mkdirSync(directory, { recursive: true });
  const filePath = dayFile(timestamp, directory);
  const previous = readHead(directory, filePath);
  const unsigned: Omit<ExecutionLedgerRecord, "hash"> = {
    schemaVersion: EXECUTION_LEDGER_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    timestamp,
    type: input.type,
    source: input.source,
    asset: input.asset,
    decisionId: input.decisionId,
    tradeId: input.tradeId,
    strategyVersion: TRADING_STRATEGY_VERSION,
    executionCostModelVersion: EXECUTION_COST_MODEL_VERSION,
    previousHash: previous?.hash || null,
    payload: sanitize(input.payload),
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

  return record;
}

export class ExecutionLedger {
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

  static verify(directory = ledgerDirectory()): ExecutionLedgerVerification {
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
        } catch (error) {
          errors.push(`${file}:${index + 1} invalid JSON (${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }

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
