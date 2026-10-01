import path from "node:path";
import { bybitPublicGet, getBybitInstrumentMetadata } from "../src/lib/data/bybitPublic";
import { CONFIGURED_ASSETS, getConfiguredInstrument, isConfiguredAsset } from "../src/lib/trading/instrumentRegistry";
import { appendResearchEvidence } from "../src/lib/research/researchArchive";

const INTERVALS: Record<string, { venue: string; seconds: number }> = {
  "15m": { venue: "15", seconds: 900 }, "1h": { venue: "60", seconds: 3600 },
  "4h": { venue: "240", seconds: 14400 }, "1w": { venue: "W", seconds: 604800 },
};
function arg(name: string, fallback?: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}
export async function captureBybitEvidence(input: { assets: string[]; intervals: string[]; output: string }) {
  const reports = [];
  for (const asset of input.assets) {
    if (!isConfiguredAsset(asset)) throw new Error("Unknown configured asset " + asset);
    const instrument = getConfiguredInstrument(asset);
    const metadata = await getBybitInstrumentMetadata(instrument.symbol);
    const candles: Record<string, unknown[]> = {}, raw: Record<string, unknown[]> = {};
    let recordedAtMs = Date.now();
    for (const interval of input.intervals) {
      const spec = INTERVALS[interval];
      if (!spec) throw new Error("Unsupported research interval " + interval);
      const response = await bybitPublicGet<{ list: string[][] }>(`/v5/market/kline?category=linear&symbol=${instrument.symbol}&interval=${spec.venue}&limit=1000`);
      recordedAtMs = response.serverTimeMs;
      raw[interval] = response.result.list;
      candles[interval] = response.result.list.map(row => ({ time: Number(row[0]) / 1000,
        open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]),
        volume: Number(row[5]), turnover: Number(row[6]) }))
        .filter(bar => (bar.time + spec.seconds) * 1000 <= recordedAtMs)
        .sort((a, b) => a.time - b.time);
    }
    const ticker = await bybitPublicGet<{ list: unknown[] }>(`/v5/market/tickers?category=linear&symbol=${instrument.symbol}`);
    const depth = await bybitPublicGet<unknown>(`/v5/market/orderbook?category=linear&symbol=${instrument.symbol}&limit=50`);
    const funding = await bybitPublicGet<unknown>(`/v5/market/funding/history?category=linear&symbol=${instrument.symbol}&limit=200`);
    // Raw transport evidence is inside the immutable metadata envelope.
    const result = appendResearchEvidence({ directory: path.resolve(input.output),
      record: { asset, recordedAtMs, candles, quote: ticker.result.list[0], depth: depth.result, funding: funding.result,
        metadata: { instrument, metadata, rawCandles: raw, captureSource: "BYBIT_PUBLIC_REST" } } });
    reports.push({ asset, ...result, closedBarCounts: Object.fromEntries(Object.entries(candles).map(([key, bars]) => [key, bars.length])) });
    if (result.status === "STORAGE_LIMIT") break;
  }
  return reports;
}
async function main() {
  const assets = arg("--assets", "all")!;
  const output = arg("--output");
  if (!output) throw new Error("--output requires an explicit local directory");
  const reports = await captureBybitEvidence({ assets: assets === "all" ? [...CONFIGURED_ASSETS] : assets.split(","),
    intervals: arg("--intervals", "15m,1h,4h,1w")!.split(","), output });
  console.log(JSON.stringify({ schemaVersion: 1, reports }, null, 2));
  if (reports.some(report => report.status === "STORAGE_LIMIT")) process.exitCode = 2;
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
