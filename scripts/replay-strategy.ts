import { runReplay } from "@/lib/backtest/replayEngine";
import { SUPPORTED_ASSETS } from "@/lib/market";
import { Candle, Timeframe } from "@/lib/types";

interface CliOptions {
  assets: string[];
  timeframe: Timeframe;
  limit: number;
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
  const limitRaw = readValue("--limit", "720");

  return {
    assets: assetsRaw.split(",").map((asset) => asset.trim().toUpperCase()).filter(Boolean),
    timeframe: timeframeRaw,
    limit: Math.max(200, Math.min(1500, Number.parseInt(limitRaw, 10) || 720)),
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

async function loadCandles(assets: string[], timeframe: Timeframe, limit: number): Promise<Record<string, Candle[]>> {
  const candlesByAsset: Record<string, Candle[]> = {};

  for (const asset of assets) {
    if (!SUPPORTED_ASSETS[asset]) {
      console.warn(`[REPLAY] Skipping unsupported asset: ${asset}`);
      continue;
    }

    try {
      candlesByAsset[asset] = await fetchYahooCandles(asset, timeframe, limit);
      console.log(`[REPLAY] Loaded ${candlesByAsset[asset].length} ${timeframe} candles for ${asset}.`);
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
  console.log(report.acceptance.passed ? "RESULT: PASS" : "RESULT: FAIL");
}

async function main() {
  const options = parseArgs();
  const candlesByAsset = await loadCandles(options.assets, options.timeframe, options.limit);
  const report = runReplay({ assets: candlesByAsset });

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
