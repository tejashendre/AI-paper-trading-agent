/**
 * Replay the cross-sectional momentum book over cached Bybit history.
 *
 * This drives the real strategy module — decideBook / planRebalance — so the
 * numbers it prints describe the code that runs in production, not a parallel
 * reimplementation. That distinction is what went wrong with the swing
 * replay, which for months graded a strategy the daemon never ran.
 *
 *   npm run replay:xsec
 *   npm run replay:xsec -- --months 12 --lookback 72 --hold 24 --book 8
 */
import fs from "fs";
import path from "path";
import {
  DEFAULT_STRATEGY,
  DEFAULT_UNIVERSE,
  decideBook,
  screenUniverse,
  StrategyConfig,
  UniverseCandidate,
} from "@/lib/strategy/crossSectionalMomentum";
import { deflatedSharpeRatio, returnMoments } from "@/lib/research/deflatedSharpe";
import { analyseEdgeDecay, renderEdgePlot } from "@/lib/research/edgeDecay";
import { estimateOneWayCostBps } from "@/lib/execution/liquidityCost";
import { analyseRegimeConditioning } from "@/lib/research/regimeConditioning";
import { hurstExponent } from "@/lib/statistics";

const CACHE = path.join(process.cwd(), ".replay-cache", "perps");
const HOUR = 3600;

interface Bar { time: number; close: number; turnover: number }
interface Options {
  months: number; lookback: number; hold: number; book: number;
  oneWayBps: number; flatCost: boolean;
  minTurnover: number; maxSymbols: number; trials: number; json: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const read = (name: string, fallback: number) => {
    const inline = args.find((a) => a.startsWith(`${name}=`));
    if (inline) return Number(inline.slice(name.length + 1));
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
  };
  return {
    months: read("--months", 12),
    lookback: read("--lookback", DEFAULT_STRATEGY.lookbackHours),
    hold: read("--hold", DEFAULT_STRATEGY.holdHours),
    book: read("--book", DEFAULT_STRATEGY.bookSize),
    // Only used with --flat-cost. By default each name is charged according
    // to its own liquidity, because a flat rate makes thin markets look as
    // cheap as deep ones and so decides the breadth question in advance.
    oneWayBps: read("--cost-bps", 6),
    flatCost: args.includes("--flat-cost"),
    minTurnover: read("--min-turnover", DEFAULT_UNIVERSE.minTurnover24hUsd),
    maxSymbols: read("--max-symbols", DEFAULT_UNIVERSE.maxSymbols),
    // How many configurations were evaluated before this one was chosen.
    // Reporting a t-statistic without this number overstates the evidence,
    // so it is a required input to the acceptance test rather than a note.
    trials: read("--trials", 100),
    json: args.includes("--json"),
  };
}

async function bybit(pathname: string, tries = 5): Promise<any> {
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const response = await fetch(`https://api.bybit.com${pathname}`, {
        headers: { "User-Agent": "quant-replay/1.0" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.retCode !== 0) throw new Error(payload.retMsg);
      return payload.result;
    } catch (error) {
      if (attempt === tries - 1) throw error;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

async function loadHistory(symbol: string, months: number): Promise<Bar[]> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${symbol}_${months}m.json`);
  if (fs.existsSync(file)) {
    const ageHours = (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000;
    if (ageHours < 24) return JSON.parse(fs.readFileSync(file, "utf-8"));
  }

  const wanted = Math.ceil(months * 30 * 24);
  const map = new Map<number, Bar>();
  let end = Date.now();
  while (map.size < wanted) {
    const result = await bybit(`/v5/market/kline?category=linear&symbol=${symbol}&interval=60&limit=1000&end=${end}`);
    const list: string[][] = result.list || [];
    if (list.length === 0) break;
    let oldest = end;
    for (const row of list) {
      const ms = Number(row[0]);
      map.set(Math.floor(ms / 1000), {
        time: Math.floor(ms / 1000), close: Number(row[4]), turnover: Number(row[6] ?? 0),
      });
      oldest = Math.min(oldest, ms);
    }
    if (oldest >= end) break;
    end = oldest - 1;
  }
  const bars = [...map.values()].filter((b) => b.close > 0).sort((a, b) => a.time - b.time);
  fs.writeFileSync(file, JSON.stringify(bars));
  return bars;
}

async function main() {
  const options = parseArgs();
  const config: StrategyConfig = {
    ...DEFAULT_STRATEGY,
    lookbackHours: options.lookback,
    holdHours: options.hold,
    bookSize: options.book,
  };

  console.log(`[XSEC] screening universe (>= $${(options.minTurnover / 1e6).toFixed(0)}M turnover, max ${options.maxSymbols})`);
  const tickers = await bybit("/v5/market/tickers?category=linear");
  const excluded = new Set(DEFAULT_UNIVERSE.excluded);
  const shortlist = (tickers.list || [])
    .filter((r: any) => r.symbol.endsWith("USDT") && !excluded.has(r.symbol) && Number(r.turnover24h) >= options.minTurnover)
    .sort((a: any, b: any) => Number(b.turnover24h) - Number(a.turnover24h))
    // Download a wider shortlist than the book needs so the point-in-time
    // screen has real choices at each date. Picking exactly maxSymbols by
    // today's turnover would bake today's winners into every historical
    // rebalance.
    .slice(0, options.maxSymbols * 2)
    .map((r: any) => r.symbol as string);

  const series = new Map<string, Map<number, number>>();
  // Trailing 24h quote turnover at each timestamp, for the point-in-time screen.
  const trailingTurnover = new Map<string, Map<number, number>>();
  const firstSeen = new Map<string, number>();
  let loaded = 0;
  for (const symbol of shortlist) {
    try {
      const bars = await loadHistory(symbol, options.months);
      if (bars.length < options.lookback + 24 * 30) continue;
      series.set(symbol, new Map(bars.map((b) => [b.time, b.close])));

      const rolling = new Map<number, number>();
      let window = 0;
      for (let i = 0; i < bars.length; i++) {
        window += bars[i].turnover;
        if (i >= 24) window -= bars[i - 24].turnover;
        if (i >= 23) rolling.set(bars[i].time, window);
      }
      trailingTurnover.set(symbol, rolling);
      firstSeen.set(symbol, bars[0].time);
      loaded++;
      process.stdout.write(`\r[XSEC] history ${loaded}/${shortlist.length}      `);
    } catch {
      // A symbol that will not load is simply not tradeable in the replay.
    }
  }
  console.log("");

  const symbols = [...series.keys()];
  if (symbols.length < 20) {
    console.error(`[XSEC] only ${symbols.length} symbols loaded; need at least 20 for a cross-section.`);
    process.exit(1);
  }

  const allTimes = [...new Set(symbols.flatMap((s) => [...series.get(s)!.keys()]))].sort((a, b) => a - b);
  const T0 = allTimes[0], T1 = allTimes[allTimes.length - 1];
  const burn = 24 * 30 * HOUR;
  const step = config.holdHours * HOUR;

  const priceAt = (s: string, t: number) => series.get(s)?.get(t);
  const ret = (s: string, a: number, b: number) => {
    const x = priceAt(s, a), y = priceAt(s, b);
    return x && y && x > 0 ? (y - x) / x : null;
  };

  let weights = new Map<string, number>();
  const periodReturns: number[] = [];
  const periodCostBps: number[] = [];
  const stamps: number[] = [];
  let rebalances = 0, holds = 0, totalTurnover = 0;

  let start = Math.max(T0 + burn, T0 + config.lookbackHours * HOUR);
  start -= start % HOUR;

  const universeSizes: number[] = [];
  for (let t = start; t <= T1 - step; t += step) {
    // Rebuild the tradeable universe at this instant using the same screen the
    // daemon runs, rather than a fixed list chosen with hindsight. Screening on
    // *today's* turnover across all of history is look-ahead bias: a symbol
    // that is liquid now may have been untradeable a year ago, and the book
    // would be credited with trades it could never have placed.
    const candidates: UniverseCandidate[] = [];
    for (const s of symbols) {
      const listedAt = firstSeen.get(s) ?? Infinity;
      if (!priceAt(s, t) || !priceAt(s, t + step)) continue;
      const turnover = trailingTurnover.get(s)?.get(t);
      if (turnover === undefined) continue;
      candidates.push({
        symbol: s,
        turnover24h: turnover,
        historyHours: Math.max(0, Math.floor((t - listedAt) / HOUR)),
        // Bars are contiguous in the cached series by construction.
        barCoverage: 1,
      });
    }
    const eligible = screenUniverse(candidates, {
      ...DEFAULT_UNIVERSE,
      minTurnover24hUsd: options.minTurnover,
      maxSymbols: options.maxSymbols,
    });
    universeSizes.push(eligible.length);

    const momentum = new Map<string, number>();
    for (const s of eligible) {
      const m = ret(s, t - config.lookbackHours * HOUR, t);
      if (m !== null) momentum.set(s, m);
    }
    if (momentum.size < 3 * config.bookSize) continue;

    const plan = decideBook({ momentumBySymbol: momentum, currentWeights: weights, config });
    if (plan.skipped) {
      holds++;
    } else {
      rebalances++;
      totalTurnover += plan.turnover;
      const next = new Map(weights);
      for (const order of plan.orders) {
        if (order.toWeight === 0) next.delete(order.symbol);
        else next.set(order.symbol, order.toWeight);
      }
      weights = next;
    }

    // Hold the book for one period and mark it.
    let gross = 0;
    for (const [symbol, weight] of weights) {
      const r = ret(symbol, t, t + step);
      if (r === null) continue;
      gross += weight * r;
    }
    // Charge each order at its own name's liquidity rather than a blanket
    // rate. Without this, adding illiquid names to the universe looks free.
    const cost = plan.skipped ? 0 : plan.orders.reduce((sum, order) => {
      const bps = options.flatCost
        ? options.oneWayBps
        : estimateOneWayCostBps(trailingTurnover.get(order.symbol)?.get(t) ?? 0);
      return sum + Math.abs(order.weightDelta) * (bps / 1e4);
    }, 0);
    periodCostBps.push(plan.skipped || plan.turnover <= 0 ? 0 : (cost / plan.turnover) * 1e4);
    periodReturns.push(gross - cost);
    stamps.push(t);
  }

  if (periodReturns.length < 20) {
    console.error("[XSEC] not enough rebalance periods to evaluate.");
    process.exit(1);
  }

  const n = periodReturns.length;
  const mean = periodReturns.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(periodReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const periodsPerYear = (365 * 24) / config.holdHours;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(periodsPerYear) : 0;

  // The t-statistic above is the headline number, and on its own it is
  // misleading: it was selected as the best of a parameter search. Deflate it.
  const moments = returnMoments(periodReturns);
  const deflated = deflatedSharpeRatio({
    observedSharpePerPeriod: sd > 0 ? mean / sd : 0,
    periods: n,
    skew: moments.skew,
    kurtosis: moments.kurtosis,
    trials: options.trials,
  });

  let equity = 1, peak = 1, maxDd = 0;
  const curve: number[] = [];
  for (const r of periodReturns) {
    equity *= 1 + r; peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, (peak - equity) / peak); curve.push(equity);
  }

  const split = Math.floor(n * 0.6);
  const cum = (a: number[]) => a.reduce((e, r) => e * (1 + r), 1) - 1;
  const isReturn = cum(periodReturns.slice(0, split));
  const oosReturn = cum(periodReturns.slice(split));

  const monthly = new Map<string, number>();
  periodReturns.forEach((r, i) => {
    const key = new Date(stamps[i] * 1000).toISOString().slice(0, 7);
    monthly.set(key, (monthly.get(key) ?? 1) * (1 + r));
  });
  const months = [...monthly.entries()].sort();
  const positiveMonths = months.filter(([, v]) => v > 1).length;

  const report = {
    strategy: "cross-sectional momentum",
    universe: symbols.length,
    window: `${new Date(T0 * 1000).toISOString().slice(0, 10)} .. ${new Date(T1 * 1000).toISOString().slice(0, 10)}`,
    config: { lookbackHours: config.lookbackHours, holdHours: config.holdHours, bookSize: config.bookSize, oneWayBps: options.oneWayBps, flatCost: options.flatCost },
    avgCostBps: periodCostBps.filter((c) => c > 0).length > 0
      ? periodCostBps.filter((c) => c > 0).reduce((a, b) => a + b, 0) / periodCostBps.filter((c) => c > 0).length
      : 0,
    periods: n, rebalances, holds,
    avgUniverse: universeSizes.length > 0 ? universeSizes.reduce((a, b) => a + b, 0) / universeSizes.length : 0,
    avgTurnover: rebalances > 0 ? totalTurnover / rebalances : 0,
    meanPeriodBps: mean * 1e4, tStat, sharpe,
    deflatedSharpe: deflated.deflatedSharpe,
    trialsSearched: options.trials,
    effectiveTrials: deflated.effectiveTrials,
    skew: moments.skew, kurtosis: moments.kurtosis,
    totalReturn: equity - 1, maxDrawdown: maxDd,
    isReturn, oosReturn,
    positiveMonths, totalMonths: months.length,
  };

  if (options.json) {
    console.log(JSON.stringify({ ...report, monthly: months }, null, 2));
  } else {
    console.log("");
    console.log("Cross-Sectional Momentum Replay");
    console.log("===============================");
    console.log(`Universe:        ${report.universe} loaded, ${report.avgUniverse.toFixed(0)} eligible on average (point-in-time)`);
    console.log(`Window:          ${report.window}`);
    const tradedCosts = periodCostBps.filter((c) => c > 0);
    const avgCostBps = tradedCosts.length > 0 ? tradedCosts.reduce((a, b) => a + b, 0) / tradedCosts.length : 0;
    console.log(`Config:          ${config.lookbackHours}h lookback, ${config.holdHours}h hold, ${config.bookSize} per side`);
    console.log(`Cost charged:    ${options.flatCost ? `${options.oneWayBps}bps flat` : `${avgCostBps.toFixed(1)}bps average, by each name's own liquidity`}`);
    console.log(`Periods:         ${n} (${rebalances} rebalanced, ${holds} held below threshold)`);
    console.log(`Avg turnover:    ${(report.avgTurnover * 100).toFixed(1)}% one-way per rebalance`);
    console.log(`Mean period:     ${report.meanPeriodBps.toFixed(1)}bps  (t = ${tStat.toFixed(2)})`);
    console.log(`Sharpe:          ${sharpe.toFixed(2)}`);
    console.log(`Deflated Sharpe: ${(deflated.deflatedSharpe * 100).toFixed(1)}% (after correcting for ${options.trials} configurations tried, ${deflated.effectiveTrials} effective)`);
    console.log(`Return shape:    skew ${moments.skew.toFixed(2)}, kurtosis ${moments.kurtosis.toFixed(2)}`);
    console.log(`Total return:    ${((equity - 1) * 100).toFixed(1)}%`);
    console.log(`Max drawdown:    ${(maxDd * 100).toFixed(1)}%`);
    console.log(`In-sample:       ${(isReturn * 100).toFixed(1)}%`);
    console.log(`Out-of-sample:   ${(oosReturn * 100).toFixed(1)}%`);
    console.log(`Positive months: ${positiveMonths}/${months.length}`);
    console.log("");
    console.log("Monthly");
    for (const [m, v] of months) {
      const pct = (v - 1) * 100;
      console.log(`  ${m}  ${(pct >= 0 ? "+" : "") + pct.toFixed(1)}%`.padEnd(20) + "#".repeat(Math.min(40, Math.round(Math.abs(pct)))));
    }
    console.log("");
    console.log("Acceptance");
    const checks = [
      ["t-statistic >= 2.0", tStat >= 2.0],
      ["deflated Sharpe >= 95%", deflated.passes],
      ["Sharpe >= 1.0", sharpe >= 1.0],
      ["out-of-sample positive", oosReturn > 0],
      ["in-sample positive", isReturn > 0],
      ["max drawdown <= 35%", maxDd <= 0.35],
      ["majority of months positive", positiveMonths * 2 >= months.length],
    ] as const;
    for (const [label, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    const passed = checks.every(([, ok]) => ok);

    // Rolling re-validation. A full-sample statistic can stay positive long
    // after a strategy has stopped working, because a few good early months
    // keep the average alive. This shows whether the edge is a stable property
    // of the data or an artefact of one stretch.
    const decay = analyseEdgeDecay({
      returns: periodReturns,
      timestamps: stamps.map((t) => new Date(t * 1000).toISOString()),
      windowSize: Math.max(20, Math.floor(n / 8)),
      periodHours: config.holdHours,
    });
    console.log("");
    console.log(`Rolling edge, ${decay.windows[0]?.periods ?? 0}-period windows`);
    for (const line of renderEdgePlot(decay.windows)) console.log(line);
    console.log("");
    console.log(`${decay.verdict}: ${decay.explanation}`);

    // Does the regime label the dashboard displays predict anything? Uses the
    // same Hurst estimator and the same thresholds production classifies with,
    // so the answer applies to the label users actually see.
    const reference = series.get("BTCUSDT") ?? series.get(symbols[0]);
    if (reference) {
      const labels: string[] = [];
      const labelled: number[] = [];
      for (let i = 0; i < stamps.length; i++) {
        const t = stamps[i];
        const window: number[] = [];
        for (let h = 200; h >= 1; h--) {
          const price = reference.get(t - h * HOUR);
          if (price !== undefined) window.push(price);
        }
        if (window.length < 60) continue;
        const h = hurstExponent(window, 20);
        labels.push(h > 0.55 ? "TRENDING" : h < 0.45 ? "MEAN_REVERTING" : "CHOPPY");
        labelled.push(periodReturns[i]);
      }
      const regime = analyseRegimeConditioning({ labels, returns: labelled });
      console.log("");
      console.log("Regime conditioning");
      for (const bucket of regime.buckets) {
        console.log(
          `  ${bucket.regime.padEnd(15)}${String(bucket.periods).padStart(5)} periods  ` +
          `${bucket.meanBps >= 0 ? "+" : ""}${bucket.meanBps.toFixed(1)}bps  t=${bucket.tStat.toFixed(2)}  ` +
          `hit ${(bucket.hitRate * 100).toFixed(0)}%`
        );
      }
      console.log("");
      console.log(`${regime.verdict}: ${regime.explanation}`);
    }

    console.log("");
    console.log(deflated.verdict);
    console.log(passed ? "RESULT: PASS" : "RESULT: FAIL");
    setTimeout(() => process.exit(passed ? 0 : 1), 50);
  }
}

main().catch((error) => {
  console.error(`[XSEC] fatal: ${error?.message || error}`);
  setTimeout(() => process.exit(1), 50);
});
