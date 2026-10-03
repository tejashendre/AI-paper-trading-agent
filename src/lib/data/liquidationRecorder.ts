import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * Liquidation recording. Bybit's allLiquidation stream has no history, so it
 * is recorded going forward as per-minute totals per symbol. Research only:
 * nothing here feeds a live decision until the data passes the gates.
 */
export interface LiquidationMinute {
  symbol: string;
  minuteStartMs: number;
  count: number;
  /** USDT notional of liquidated long positions (Bybit side "Buy"). */
  longLiquidatedUsdt: number;
  /** USDT notional of liquidated short positions (Bybit side "Sell"). */
  shortLiquidatedUsdt: number;
}

const MINUTE_MS = 60_000;
const FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/;

export class LiquidationMinutes {
  private buckets = new Map<string, LiquidationMinute>();

  /** Adds one allLiquidation message; returns false when it is not one. */
  add(message: unknown): boolean {
    const { topic, data } = (message ?? {}) as { topic?: unknown; data?: unknown };
    if (typeof topic !== "string" || !topic.startsWith("allLiquidation.") || !Array.isArray(data)) return false;
    for (const row of data as Array<{ T?: unknown; s?: unknown; S?: unknown; v?: unknown; p?: unknown }>) {
      const at = Number(row.T), size = Number(row.v), price = Number(row.p);
      if (typeof row.s !== "string" || !Number.isFinite(at) || !(size > 0) || !(price > 0)) continue;
      const minuteStartMs = Math.floor(at / MINUTE_MS) * MINUTE_MS;
      const key = `${row.s}:${minuteStartMs}`;
      const bucket = this.buckets.get(key) ?? { symbol: row.s, minuteStartMs, count: 0, longLiquidatedUsdt: 0, shortLiquidatedUsdt: 0 };
      bucket.count += 1;
      if (row.S === "Buy") bucket.longLiquidatedUsdt += size * price;
      else bucket.shortLiquidatedUsdt += size * price;
      this.buckets.set(key, bucket);
    }
    return true;
  }

  /** Removes and returns every minute that has fully closed by nowMs. */
  drainClosed(nowMs: number): LiquidationMinute[] {
    const closed = [...this.buckets.entries()].filter(([, bucket]) => bucket.minuteStartMs + MINUTE_MS <= nowMs);
    for (const [key] of closed) this.buckets.delete(key);
    return closed.map(([, bucket]) => bucket).sort((a, b) => a.minuteStartMs - b.minuteStartMs || a.symbol.localeCompare(b.symbol));
  }
}

function folderBytes(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const filename = path.join(directory, entry.name);
    return total + (entry.isFile() ? fs.statSync(filename).size : entry.isDirectory() ? folderBytes(filename) : 0);
  }, 0);
}

/**
 * Appends closed minutes under <archive>/liquidations/, one gzip member per
 * flush, so the research archive cap covers them. Over the cap, the oldest
 * liquidation days rotate out; when that is not enough the minutes are dropped.
 */
export function appendLiquidationMinutes(input: { archiveDirectory: string; minutes: LiquidationMinute[]; maxBytes: number }) {
  if (input.minutes.length === 0) return { status: "EMPTY" as const, written: 0 };
  const directory = path.join(path.resolve(input.archiveDirectory), "liquidations");
  fs.mkdirSync(directory, { recursive: true });
  const byDay = new Map<string, LiquidationMinute[]>();
  for (const minute of input.minutes) {
    const day = new Date(minute.minuteStartMs).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), minute]);
  }
  let written = 0;
  const rotatedOut: string[] = [];
  for (const [day, minutes] of byDay) {
    const payload = gzipSync(Buffer.from(minutes.map((minute) => JSON.stringify(minute)).join("\n") + "\n"));
    const older = fs.readdirSync(directory).filter((file) => FILE_PATTERN.test(file) && file.slice(0, 10) < day).sort();
    while (folderBytes(input.archiveDirectory) + payload.length > input.maxBytes && older.length) {
      const oldest = older.shift()!;
      fs.rmSync(path.join(directory, oldest), { force: true });
      rotatedOut.push(oldest);
    }
    if (folderBytes(input.archiveDirectory) + payload.length > input.maxBytes) return { status: "STORAGE_LIMIT" as const, written, rotatedOut };
    fs.appendFileSync(path.join(directory, `${day}.ndjson.gz`), payload);
    written += minutes.length;
  }
  return { status: "CAPTURED" as const, written, rotatedOut };
}

export function readLiquidationMinutes(archiveDirectory: string): LiquidationMinute[] {
  const directory = path.join(path.resolve(archiveDirectory), "liquidations");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => FILE_PATTERN.test(file)).sort().flatMap((file) =>
    gunzipSync(fs.readFileSync(path.join(directory, file))).toString("utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as LiquidationMinute));
}
