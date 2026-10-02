import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

/** 256 MiB: the owner's storage cap (2026-10-02); oldest days rotate out. */
export const DEFAULT_RESEARCH_ARCHIVE_BYTES = 256 * 1024 ** 2;
export interface ResearchEvidence {
  asset: string;
  recordedAtMs: number;
  candles: Record<string, unknown[]>;
  quote: unknown;
  metadata: unknown;
  funding?: unknown;
  depth?: unknown;
}
export function readResearchEvidence(directory:string):ResearchEvidence[] {
  return fs.readdirSync(directory).filter(f=>/^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(f)).sort().flatMap(filename=>
    gunzipSync(fs.readFileSync(path.join(directory,filename))).toString('utf8').trim().split('\n').filter(Boolean).map(line=> {
      const envelope=JSON.parse(line);
      const actual=createHash('sha256').update(JSON.stringify(envelope.record)).digest('hex');
      if (envelope.schemaVersion!==1 || envelope.recordHash!==actual) throw new Error('Research evidence integrity check failed: '+filename);
      return envelope.record as ResearchEvidence;
    }));
}
function archiveBytes(directory: string): number {
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const filename = path.join(directory, entry.name);
    return total + (entry.isFile() ? fs.statSync(filename).size : entry.isDirectory() ? archiveBytes(filename) : 0);
  }, 0);
}
export function appendResearchEvidence(input: { directory: string; record: ResearchEvidence; maxBytes?: number }) {
  const { record } = input, maxBytes = input.maxBytes ?? DEFAULT_RESEARCH_ARCHIVE_BYTES;
  if (!/^[A-Z0-9]+$/.test(record.asset) || !Number.isFinite(record.recordedAtMs) || !(maxBytes > 0))
    throw new Error("Invalid research archive input");
  const directory = path.resolve(input.directory);
  fs.mkdirSync(directory, { recursive: true });
  const statePath = path.join(directory, "capture-state.json");
  const state: Record<string, { recordHash: string; cursors: Record<string, number>; quoteBucket: number }> =
    fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
  const recordHash = createHash("sha256").update(JSON.stringify(record)).digest("hex");
  const previous = state[record.asset];
  const quoteBucket = Math.floor(record.recordedAtMs / 900000);
  if (previous?.recordHash === recordHash || previous?.quoteBucket === quoteBucket) return { status: "UNCHANGED", recordHash };
  const cursors = { ...previous?.cursors }, candles: Record<string, unknown[]> = {};
  for (const [interval, bars] of Object.entries(record.candles)) {
    const closed = bars as { time: number }[];
    candles[interval] = closed.filter(bar => bar.time > (cursors[interval] ?? -Infinity));
    if (closed.length) cursors[interval] = Math.max(...closed.map(bar => bar.time));
  }
  const storedRecord = { ...record, candles };
  const storedHash = createHash("sha256").update(JSON.stringify(storedRecord)).digest("hex");
  const payload = gzipSync(Buffer.from(JSON.stringify({ schemaVersion: 1, recordHash: storedHash, record: storedRecord }) + "\n"));
  const date = new Date(record.recordedAtMs).toISOString().slice(0, 10);
  const nextState = { ...state, [record.asset]: { recordHash, cursors, quoteBucket } };
  const stateBytes = Buffer.byteLength(JSON.stringify(nextState));
  const oldStateBytes = fs.existsSync(statePath) ? fs.statSync(statePath).size : 0;
  const fits = () => archiveBytes(directory) + payload.length + stateBytes - oldStateBytes <= maxBytes;
  // Over the cap, whole older days rotate out, oldest first; the day being
  // written is never touched. Only when that day alone fills the cap does
  // capture pause.
  const rotatedOut: string[] = [];
  const olderDays = fs.readdirSync(directory).filter(f => /^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(f) && f.slice(0, 10) < date).sort();
  while (!fits() && olderDays.length) {
    const oldest = olderDays.shift()!;
    fs.rmSync(path.join(directory, oldest), { force: true });
    rotatedOut.push(oldest);
  }
  const bytes = archiveBytes(directory);
  if (!fits()) return { status: "STORAGE_LIMIT", bytes, maxBytes, recordHash, rotatedOut };
  const filename = path.join(directory, date + ".ndjson.gz");
  fs.appendFileSync(filename, payload);
  const temporary = statePath + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(nextState));
  fs.renameSync(temporary, statePath);
  return { status: "CAPTURED", recordHash, bytes: bytes + payload.length, maxBytes, rotatedOut };
}
