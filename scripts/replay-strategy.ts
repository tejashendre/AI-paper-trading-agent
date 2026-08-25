import fs from "fs";
import path from "path";
import { runReplay } from "@/lib/backtest/replayEngine";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { Candle, Timeframe } from "@/lib/types";

interface CliOptions {
  assets: string[];
  timeframe: Timeframe;
  limit: number;
  maxHold: number;
  json: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const readValue = (name: string, fallback: string) => {
    const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
    if (prefixed) return prefixed.slice(name.length + 1);
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };

  const assetsRaw = readValue("--assets", Object.keys(SUPPORTED_ASSETS).join(","));
  const timeframeRaw = readValue("--timeframe", "15m") as Timeframe;
  const limitRaw = readValue("--limit", "5000");
  const maxHoldRaw = readValue("--max-hold", "192");

  return {
    assets: assetsRaw.split(",").map((asset) => asset.trim().toUpperCase()).filter(Boolean),
    timeframe: timeframeRaw,
    limit: Math.max(200, Math.min(30_000, Number.parseInt(limitRaw, 10) || 5_000)),
    maxHold: Math.max(8, Math.min(2000, Number.parseInt(maxHoldRaw, 10) || 192)),
    json: args.includes("--json"),
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatCurrency(value: number) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function yahooInterval(timeframe: Timeframe): string {
  switch (timeframe) {
    case "1m": return "1m";
    case "5m": return "5m";
    case "15m": return "15m";
    case "30m": return "30m";
    case "1h": return "60m";
    case "4h": return "60m";
    default: return "15m";
  }
}

function yahooRange(timeframe: Timeframe, limit: number): string {
  if (timeframe === "1m") return "7d";
  if (timeframe === "5m" || timeframe === "15m" || timeframe === "30m") {
    return limit > 500 ? "1mo" : "5d";
  }
  return limit > 500 ? "3mo" : "1mo";
}

async function fetchYahooCandles(asset: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const ticker = SUPPORTED_ASSETS[asset]?.yahooTicker;
  if (!ticker) throw new Error(`No Yahoo ticker configured for ${asset}.`);

  const interval = yahooInterval(timeframe);
  const range = yahooRange(timeframe, limit);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
    {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    }
  );
  clearTimeout(timeout);

  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
  const data = await response.json();
  const chart = data.chart?.result?.[0];
  if (!chart) throw new Error("Yahoo returned no chart result.");

  const timestamps = chart.timestamp || [];
  const quote = chart.indicators?.quote?.[0] || {};
  const candles: Candle[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const close = quote.close?.[i];
    if (open === null || open === undefined || close === null || close === undefined) continue;
    candles.push({
      time: Number(timestamps[i]),
      open: Number(open),
      high: Number(quote.high?.[i] ?? open),
      low: Number(quote.low?.[i] ?? open),
      close: Number(close),
      volume: Number(quote.volume?.[i] ?? 0),
    });
  }

  return candles.slice(-limit);
}

// Candle history is cached on disk so repeated research runs do not re-download
// hundreds of pages. Delete the directory to force a refresh.
const CACHE_DIR = path.join(process.cwd(), ".replay-cache");

function cacheKey(asset: string, timeframe: Timeframe, limit: number) {
  return path.join(CACHE_DIR, `${asset}_${timeframe}_${limit}.json`);
}

function readCache(asset: string, timeframe: Timeframe, limit: number): Candle[] | null {
  try {
    const file = cacheKey(asset, timeframe, limit);
    if (!fs.existsSync(file)) return null;
    const ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
    if (ageHours > 12) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Candle[];
  } catch {
    return null;
  }
}

function writeCache(asset: string, timeframe: Timeframe, limit: number, candles: Candle[]) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheKey(asset, timeframe, limit), JSON.stringify(candles));
  } catch {
    // A cache miss is never fatal.
  }
}

const BYBIT_INTERVAL: Partial<Record<Timeframe, string>> = {
  "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60", "4h": "240",
};

/**
 * Crypto is replayed against Bybit, the venue the daemon actually executes on,
 * and paginated so the sample can span months. Yahoo only serves a few days of
 * intraday history, which is far too short to judge a strategy that now holds
 * positions for roughly a day.
 */
async function fetchBybitCandles(asset: string, timeframe: Timeframe, limit: number): Promise<Candle[]> {
  const cached = readCache(asset, timeframe, limit);
  if (cached && cached.length > 0) {
    console.log(`[REPLAY] Reusing cached ${cached.length} ${timeframe} candles for ${asset}.`);
    return cached;
  }

  const symbol = SUPPORTED_ASSETS[asset]?.bybitLinearSymbol;
  const interval = BYBIT_INTERVAL[timeframe];
  if (!symbol || !interval) throw new Error(`No Bybit mapping for ${asset} ${timeframe}.`);

  const byTime = new Map<number, Candle>();
  let end = Date.now();

  while (byTime.size < limit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let rows: string[][] = [];
    try {
      const response = await fetch(
        `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&end=${end}`,
        { signal: controller.signal, headers: { "User-Agent": "quant-replay/1.0" } }
      );
      if (!response.ok) throw new Error(`Bybit HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.retCode !== 0) throw new Error(`Bybit ${payload.retMsg}`);
      rows = payload.result?.list || [];
    } finally {
      clearTimeout(timer);
    }
    if (rows.length === 0) break;

    let oldestMs = end;
    for (const row of rows) {
      const openTimeMs = Number(row[0]);
      byTime.set(Math.floor(openTimeMs / 1000), {
        time: Math.floor(openTimeMs / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
      });
      oldestMs = Math.min(oldestMs, openTimeMs);
    }
    if (oldestMs >= end) break;
    end = oldestMs - 1;
  }

  const candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-limit);
  writeCache(asset, timeframe, limit, candles);
  return candles;
}

async function loadCandles(assets: string[], timeframe: Timeframe, limit: number): Promise<Record<string, Candle[]>> {
  const candlesByAsset: Record<string, Candle[]> = {};

  for (const asset of assets) {
    if (!SUPPORTED_ASSETS[asset]) {
      console.warn(`[REPLAY] Skipping unsupported asset: ${asset}`);
      continue;
    }

    const isCrypto = SUPPORTED_ASSETS[asset].category === "crypto";
    try {
      candlesByAsset[asset] = isCrypto
        ? await fetchBybitCandles(asset, timeframe, limit)
        : await fetchYahooCandles(asset, timeframe, limit);
      const venue = isCrypto ? "Bybit" : "Yahoo";
      console.log(`[REPLAY] Loaded ${candlesByAsset[asset].length} ${timeframe} candles for ${asset} from ${venue}.`);
    } catch (error: any) {
      console.warn(`[REPLAY] Failed to load ${asset}: ${error?.message || error}`);
      candlesByAsset[asset] = [];
    }
  }

  return candlesByAsset;
}

function printHumanReport(report: ReturnType<typeof runReplay>) {
  console.log("");
  console.log("Replay Strategy Report");
  console.log("======================");
  console.log(`Generated: ${report.generatedAt}`);
  console.log(`Trades: ${report.totalTrades} (${report.winningTrades}W / ${report.losingTrades}L)`);
  console.log(`Win rate: ${formatPercent(report.winRate)}`);
  console.log(`Profit factor: ${Number.isFinite(report.profitFactor) ? report.profitFactor.toFixed(2) : "inf"}`);
  console.log(`Return: ${formatCurrency(report.totalReturnUsd)} (${report.totalReturnPercent.toFixed(2)}%)`);
  console.log(`Max drawdown: ${report.maxDrawdownPercent.toFixed(2)}%`);
  console.log(`Average trade return: ${report.averageReturnPercent.toFixed(2)}%`);
  console.log(`Average hold: ${report.averageHoldCandles.toFixed(1)} candles`);
  console.log(`False positive rate: ${formatPercent(report.falsePositiveRate)}`);
  console.log(`Missed opportunity rate: ${formatPercent(report.missedOpportunityRate)}`);
  console.log(`Stale windows skipped: ${report.staleWindowsSkipped}`);
  if (report.triggerCoverageSkipped > 0) {
    console.log(`Bars skipped for missing 1m trigger history: ${report.triggerCoverageSkipped}`);
  }
  console.log(`Best asset: ${report.bestAsset ? `${report.bestAsset.asset} ${formatCurrency(report.bestAsset.pnlUsd)}` : "None"}`);
  console.log(`Worst asset: ${report.worstAsset ? `${report.worstAsset.asset} ${formatCurrency(report.worstAsset.pnlUsd)}` : "None"}`);

  console.log("");
  console.log("Score Distribution");
  for (const [bucket, count] of Object.entries(report.scoreDistribution)) {
    console.log(`- ${bucket}: ${count}`);
  }

  console.log("");
  console.log("Top Setup Stats");
  for (const setup of report.setupStats.slice(0, 8)) {
    console.log(`- ${setup.setup}: trades=${setup.trades}, watched=${setup.watched}, missed=${setup.missed}, win=${formatPercent(setup.winRate)}, pnl=${formatCurrency(setup.realizedPnl)}`);
  }

  console.log("");
  console.log("Acceptance");
  for (const message of report.acceptance.messages) {
    console.log(`- ${message}`);
  }
  console.log(`Engineering integrity: ${report.acceptance.integrityPassed ? "PASS" : "FAIL"}`);
  console.log(`Research quality: ${report.acceptance.researchQualityPassed ? "PASS" : "FAIL"}`);
  console.log(report.acceptance.passed ? "RESULT: PASS" : "RESULT: FAIL");
}

/**
 * The short-term trigger is scored on 1m/5m data. Without it the trigger score
 * is computed from the base timeframe and the replay silently grades a
 * different entry gate than the daemon uses.
 */
async function loadFastCandles(assets: string[], baseLimit: number) {
  const fast: Record<string, { m1?: Candle[]; m5?: Candle[] }> = {};
  for (const asset of assets) {
    if (SUPPORTED_ASSETS[asset]?.category !== "crypto") continue;
    try {
      const [m1, m5] = await Promise.all([
        fetchBybitCandles(asset, "1m", Math.min(220_000, baseLimit * 15)),
        fetchBybitCandles(asset, "5m", Math.min(80_000, baseLimit * 3)),
      ]);
      fast[asset] = { m1, m5 };
      console.log(`[REPLAY] Loaded ${m1.length} 1m and ${m5.length} 5m trigger candles for ${asset}.`);
    } catch (error: any) {
      console.warn(`[REPLAY] Trigger candles unavailable for ${asset}: ${error?.message || error}`);
    }
  }
  return fast;
}

async function main() {
  const options = parseArgs();
  const candlesByAsset = await loadCandles(options.assets, options.timeframe, options.limit);
  const fastCandles = options.timeframe === "15m"
    ? await loadFastCandles(options.assets, options.limit)
    : {};
  const report = runReplay({ assets: candlesByAsset, fastCandles, maxHoldCandles: options.maxHold });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }

  const exitCode = report.acceptance.passed ? 0 : 1;
  setTimeout(() => process.exit(exitCode), 50);
}

main().catch((error) => {
  console.error(`[REPLAY] Fatal error: ${error?.message || error}`);
  setTimeout(() => process.exit(1), 50);
});
