import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { MarketService, setMarketServiceDeps, SUPPORTED_ASSETS } from "../src/lib/market";
import { BybitTickerBook, fetchFundingSettlements } from "../src/lib/data/bybitPublic";
import { getConfiguredInstrument } from "../src/lib/trading/instrumentRegistry";
import { evaluateEntryEligibility } from "../src/lib/trading/entryEligibility";

// Read-only public network verification. No account client or Redis connection.
async function streamProbe(durationMs: number) {
  const symbols = new Set(Object.keys(SUPPORTED_ASSETS).map((asset) => getConfiguredInstrument(asset).symbol));
  return new Promise<{ symbols: string[]; updates: Record<string, number> }>((resolve, reject) => {
    const book = new BybitTickerBook();
    const updates: Record<string, number> = {};
    const socket = new WebSocket("wss://stream.bybit.com/v5/public/linear");
    const timer = setTimeout(() => {
      socket.terminate();
      const seen = Object.keys(updates).sort();
      const missing = [...symbols].filter((symbol) => !book.get(symbol));
      if (missing.length) reject(new Error(`Missing public stream snapshots: ${missing.join(", ")}`));
      else resolve({ symbols: seen, updates });
    }, durationMs);
    socket.on("open", () => socket.send(JSON.stringify({ op: "subscribe", args: [...symbols].map((symbol) => `tickers.${symbol}`) })));
    socket.on("message", (raw) => {
      let frame: unknown;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      const state = book.apply(frame, Date.now());
      if (state && symbols.has(state.symbol)) updates[state.symbol] = (updates[state.symbol] ?? 0) + 1;
    });
    socket.on("error", (error) => { clearTimeout(timer); socket.terminate(); reject(error); });
  });
}

async function main() {
  const outputIndex = process.argv.indexOf("--output");
  const output = outputIndex < 0 ? null : process.argv[outputIndex + 1];
  if (outputIndex >= 0 && !output) throw new Error("--output requires a path");
  const cache = new Map<string, unknown>();
  const restore = setMarketServiceDeps({ cache: {
    get: async <T>(key: string) => (cache.get(key) as T | undefined) ?? null,
    set: async (key, value) => { cache.set(key, value); return "OK"; },
  } });
  const assets = [];
  try {
    for (const asset of Object.keys(SUPPORTED_ASSETS)) {
      const instrument = getConfiguredInstrument(asset);
      const metadata = await MarketService.getInstrumentMetadata(asset);
      const [m15, h1, h4] = await Promise.all([
        MarketService.getCandles("15m", 100, asset),
        MarketService.getCandles("1h", 100, asset),
        MarketService.getCandles("4h", 100, asset),
      ]);
      const weekly = await MarketService.getWeeklyCandles(20, asset);
      const liquidity = await MarketService.getLiquiditySnapshot(asset);
      const funding = await fetchFundingSettlements(instrument.symbol, Date.now() - 9 * 3_600_000, Date.now());
      if (funding.some((event) => !Number.isFinite(event.markPrice) || event.markPrice <= 0)) {
        throw new Error(`${asset}: published funding has no usable boundary mark price`);
      }
      const quote = await MarketService.getCurrentPriceSnapshot(asset, { transport: "REST" });
      const eligibility = evaluateEntryEligibility({
        instrument, metadata, quote,
        closedBarCounts: { m15: m15.length, h1: h1.length, h4: h4.length, w1: weekly.length },
        nowMs: Date.now(), fastExecution: false, depthAvailable: true,
      });
      if (!eligibility.allowed) throw new Error(`${asset}: ${eligibility.reasons.join("; ")}`);
      const row = {
        asset, symbol: instrument.symbol, metadataVersion: metadata.metadataVersion,
        fundingIntervalMinutes: metadata.fundingIntervalMinutes,
        completedBars: { m15: m15.length, h1: h1.length, h4: h4.length, w1: weekly.length },
        spreadBps: (quote.ask! - quote.bid!) / ((quote.ask! + quote.bid!) / 2) * 10_000,
        depthLevels: { bids: liquidity.bids.length, asks: liquidity.asks.length },
        publishedFundingSettlements: funding.length, entryDataReady: eligibility.allowed,
        notes: eligibility.reasons,
      };
      assets.push(row);
      console.log(`${asset} ${instrument.symbol}: data ready; ${funding.length} funding boundaries; ${weekly.length} completed weeks`);
    }
    const first = await streamProbe(10_000);
    const reconnect = await streamProbe(10_000);
    const result = { capturedAt: new Date().toISOString(), accountAccessed: false, assets, websocket: { first, reconnect } };
    if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`PASS: ${assets.length} public REST instrument paths and two fresh nine-symbol WebSocket sessions`);
  } finally {
    restore();
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
