import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { bybitPublicGet, listBybitLinearInstruments, type BybitRequestOptions } from "@/lib/data/bybitPublic";
import { SUPPORTED_ASSETS } from "@/lib/market";

/**
 * Bounded historical backfill for research: closed 1h and 1d candles, funding
 * settlements and the daily long/short account ratio since listing, one
 * compressed file per symbol under <archive>/backfill/. Research input only;
 * promotion still needs forward shadow evidence.
 */
export interface BackfillSeries {
  symbol: string;
  fetchedAtMs: number;
  /** [startMs, open, high, low, close, volume], oldest first, closed bars only. */
  candles1h: number[][];
  candles1d: number[][];
  funding: Array<[number, number]>;
  accountRatio1d: Array<[number, number]>;
}

const INTERVALS = { "60": 3_600_000, D: 86_400_000 } as const;
const MAX_PAGES = 120;

async function pagedKlines(symbol: string, interval: keyof typeof INTERVALS, fromMs: number, nowMs: number, options: BybitRequestOptions) {
  const rows = new Map<number, number[]>();
  let end = nowMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { result } = await bybitPublicGet<{ list?: string[][] }>(
      `/v5/market/kline?category=linear&symbol=${encodeURIComponent(symbol)}&interval=${interval}&start=${fromMs}&end=${end}&limit=1000`, options);
    const list = result.list ?? [];
    for (const row of list) {
      const start = Number(row[0]);
      if (start + INTERVALS[interval] <= nowMs) rows.set(start, row.slice(0, 6).map(Number));
    }
    if (list.length < 1000) break;
    end = Math.min(...list.map((row) => Number(row[0]))) - 1;
  }
  return [...rows.values()].sort((a, b) => a[0] - b[0]);
}

async function pagedList<T>(pathFor: (endMs: number) => string, timeOf: (row: T) => number, nowMs: number, pageSize: number, options: BybitRequestOptions) {
  const rows: T[] = [];
  let end = nowMs;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { result } = await bybitPublicGet<{ list?: T[] }>(pathFor(end), options);
    const list = result.list ?? [];
    rows.push(...list);
    if (list.length < pageSize) break;
    end = Math.min(...list.map(timeOf)) - 1;
  }
  return rows;
}

export async function fetchBackfill(symbol: string, fromMs: number, nowMs: number, options: BybitRequestOptions = {}): Promise<BackfillSeries> {
  const s = encodeURIComponent(symbol);
  const funding = await pagedList<{ fundingRate: string; fundingRateTimestamp: string }>(
    (end) => `/v5/market/funding/history?category=linear&symbol=${s}&startTime=${fromMs}&endTime=${end}&limit=200`,
    (row) => Number(row.fundingRateTimestamp), nowMs, 200, options);
  const ratio = await pagedList<{ buyRatio: string; timestamp: string }>(
    (end) => `/v5/market/account-ratio?category=linear&symbol=${s}&period=1d&startTime=${fromMs}&endTime=${end}&limit=500`,
    (row) => Number(row.timestamp), nowMs, 500, options);
  const unique = <T extends [number, number]>(rows: T[]) => [...new Map(rows.map((row) => [row[0], row])).values()].sort((a, b) => a[0] - b[0]);
  return {
    symbol, fetchedAtMs: nowMs,
    candles1h: await pagedKlines(symbol, "60", fromMs, nowMs, options),
    candles1d: await pagedKlines(symbol, "D", fromMs, nowMs, options),
    funding: unique(funding.map((row) => [Number(row.fundingRateTimestamp), Number(row.fundingRate)] as [number, number])),
    accountRatio1d: unique(ratio.map((row) => [Number(row.timestamp), Number(row.buyRatio)] as [number, number])),
  };
}

function folderBytes(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const filename = path.join(directory, entry.name);
    return total + (entry.isFile() ? fs.statSync(filename).size : entry.isDirectory() ? folderBytes(filename) : 0);
  }, 0);
}

/** Replaces the symbol's file only if the archive stays within its cap. */
export function writeBackfill(archiveDirectory: string, series: BackfillSeries, maxBytes: number) {
  const directory = path.join(path.resolve(archiveDirectory), "backfill");
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, `${series.symbol}.json.gz`);
  const payload = gzipSync(Buffer.from(JSON.stringify(series)));
  const existing = fs.existsSync(filename) ? fs.statSync(filename).size : 0;
  if (folderBytes(archiveDirectory) - existing + payload.length > maxBytes) return { status: "STORAGE_LIMIT" as const, bytes: payload.length };
  const temporary = filename + ".tmp";
  fs.writeFileSync(temporary, payload);
  fs.renameSync(temporary, filename);
  return { status: "WRITTEN" as const, bytes: payload.length };
}

export function readBackfill(archiveDirectory: string, symbol: string): BackfillSeries | null {
  const filename = path.join(path.resolve(archiveDirectory), "backfill", `${symbol}.json.gz`);
  return fs.existsSync(filename) ? JSON.parse(gunzipSync(fs.readFileSync(filename)).toString("utf8")) as BackfillSeries : null;
}

/** Refreshes every configured contract; one line per symbol, never throws. */
export async function refreshAllBackfill(input: { archiveDirectory: string; maxBytes: number; nowMs: number; options?: BybitRequestOptions }) {
  const instruments = await listBybitLinearInstruments(input.options).catch(() => []);
  const lines: string[] = [];
  let failed = 0;
  for (const config of Object.values(SUPPORTED_ASSETS)) {
    const symbol = config.bybitLinearSymbol;
    const listedMs = instruments.find((row) => row.symbol === symbol)?.launchTimeMs ?? Date.parse("2020-01-01T00:00:00Z");
    try {
      const series = await fetchBackfill(symbol, listedMs, input.nowMs, input.options);
      const result = writeBackfill(input.archiveDirectory, series, input.maxBytes);
      lines.push(`${symbol}: ${series.candles1h.length} 1h, ${series.candles1d.length} 1d, ${series.funding.length} funding, ${series.accountRatio1d.length} ratio -> ${result.status} ${(result.bytes / 1024).toFixed(0)} KiB`);
      if (result.status !== "WRITTEN") failed++;
    } catch (error) {
      failed++;
      lines.push(`${symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failed, lines };
}
