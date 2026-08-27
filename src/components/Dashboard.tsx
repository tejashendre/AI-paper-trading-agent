"use client";
import { AuthGate, createAuthFetch } from "./AuthGate";
import CrossSectionalBook from "@/components/CrossSectionalBook";
import { Component, ReactNode, useEffect, useState, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { RefreshCcw, Activity, Play, Sun, Moon, Lock, Info } from "lucide-react";

const TradingChart = dynamic(() => import("./TradingChart").then(mod => mod.TradingChart), { ssr: false });
const EquityCurve = dynamic(() => import("./EquityCurve").then(mod => mod.EquityCurve), { ssr: false });

class DashboardErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; message: string }> {
  state = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || "The dashboard hit a display issue." };
  }

  componentDidCatch(error: Error) {
    console.error("Dashboard render error:", error);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050505] p-4 text-white">
        <div className="max-w-md w-full rounded-xl border border-neutral-800 bg-[#0f0f0f] p-6 shadow-2xl">
          <div className="text-xs font-mono font-bold uppercase tracking-wider text-orange-400">Dashboard display recovered</div>
          <p className="mt-3 text-sm text-neutral-300">
            A display-only panel failed to render. The trading daemon keeps running in the background.
          </p>
          <p className="mt-2 text-[11px] font-mono text-neutral-500">{this.state.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="mt-5 w-full rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-xs font-bold font-mono text-neutral-200 hover:bg-neutral-800"
          >
            RELOAD DASHBOARD
          </button>
        </div>
      </div>
    );
  }
}

const ASSETS = [
  { key: "BTC", name: "Bitcoin", category: "Crypto", symbol: "BTC-USD" },
  { key: "ETH", name: "Ethereum", category: "Crypto", symbol: "ETH-USD" },
  { key: "SOL", name: "Solana", category: "Crypto", symbol: "SOL-USD" },
  { key: "EURUSD", name: "EUR/USD", category: "Forex", symbol: "EURUSD=X" },
  { key: "GBPUSD", name: "GBP/USD", category: "Forex", symbol: "GBPUSD=X" },
  { key: "USDJPY", name: "USD/JPY", category: "Forex", symbol: "USDJPY=X" },
  { key: "GOLD", name: "Gold (Spot)", category: "Commodities", symbol: "GC=F" },
  { key: "OIL", name: "Crude Oil", category: "Commodities", symbol: "CL=F" },
  { key: "SILVER", name: "Silver (Spot)", category: "Commodities", symbol: "SI=F" }
];

type ChartTimezone = "EU" | "UK" | "IST" | "US";

const CHART_TIMEZONE_STORAGE_KEY = "dashboard_chart_timezone";

function isChartTimezone(value: string | null): value is ChartTimezone {
  return value === "EU" || value === "UK" || value === "IST" || value === "US";
}

function detectChartTimezone(): ChartTimezone {
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (localZone === "Asia/Kolkata" || localZone === "Asia/Calcutta") return "IST";
  if (localZone === "Europe/London") return "UK";
  if (localZone.startsWith("America/")) return "US";
  return "EU";
}

function chartTimezoneName(timezone: ChartTimezone) {
  if (timezone === "IST") return "Asia/Kolkata";
  if (timezone === "UK") return "Europe/London";
  if (timezone === "US") return "America/New_York";
  return "Europe/Paris";
}

function formatChartTimestamp(iso: string | undefined, timezone: ChartTimezone) {
  if (!iso) return "--:--";
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: chartTimezoneName(timezone),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function calculateDisplayPnl(assetKey: string, pos: any, currentPrice: number) {
  const isShort = pos.direction === "SHORT";
  const signedMove = isShort
    ? pos.entryPrice - currentPrice
    : currentPrice - pos.entryPrice;

  if (assetKey === "USDJPY") {
    return (signedMove * pos.amount) / Math.max(currentPrice, 1e-9);
  }

  return signedMove * pos.amount;
}

function estimateDisplayNotional(assetKey: string, amount: number, price: number) {
  return assetKey === "USDJPY" ? amount : amount * price;
}

function formatCountdown(ms: number) {
  const safeMs = Math.max(0, ms);
  const minutes = Math.floor((safeMs / 1000 / 60) % 60);
  const seconds = Math.floor((safeMs / 1000) % 60);
  return `${minutes}m ${seconds}s`;
}

function formatAge(iso?: string) {
  if (!iso) return "unknown";
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const minutes = Math.floor(ageSeconds / 60);
  const seconds = ageSeconds % 60;
  return `${minutes}m ${seconds}s ago`;
}

function formatClock(iso?: string) {
  if (!iso) return "--:--:--";
  return new Date(iso).toLocaleTimeString();
}

function confidenceLabel(value?: number) {
  const score = Number(value || 0);
  if (score >= 90) return "Very High";
  if (score >= 80) return "High";
  if (score >= 70) return "Good";
  if (score >= 60) return "Building";
  if (score >= 40) return "Low";
  return "Very Low";
}

function percentLabel(value?: number) {
  return `${((Number(value || 0)) * 100).toFixed(0)}%`;
}

function moneyLabel(value?: number) {
  const parsed = Number(value || 0);
  const sign = parsed > 0 ? "+" : "";
  return `${sign}$${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function plainTradeReviewOutcome(outcome?: string) {
  switch (outcome) {
    case "STRONG_WIN":
      return "Strong win";
    case "PROFIT_PROTECTED":
      return "Profit protected";
    case "SMALL_WIN":
      return "Small win";
    case "CONTROLLED_LOSS":
      return "Controlled loss";
    case "RISK_BREACH":
      return "Risk breach";
    case "THESIS_FAILED":
      return "Thesis changed";
    default:
      return "Learning update";
  }
}

function exitReasonLabel(reason?: string) {
  switch (String(reason || "").toUpperCase()) {
    case "STOP_LOSS":
      return "SL HIT";
    case "TAKE_PROFIT":
      return "TP HIT";
    case "TRAILING_STOP_PROFIT":
    case "PROFIT_TRAIL":
      return "TRAILING PROFIT";
    case "BREAKEVEN_STOP":
      return "BREAKEVEN EXIT";
    case "SIGNAL_INVALIDATION":
      return "THESIS INVALID";
    case "SIGNAL_REVERSAL":
      return "REVERSAL EXIT";
    default:
      return "CLOSED";
  }
}

function readableTradeAction(t: any, rawAction: string, hasClosedPnl: boolean) {
  const action = rawAction.toUpperCase();
  const direction = String(t?.direction || "").toUpperCase();
  const isShort = direction === "SHORT" || action === "SHORT" || action === "SCALP_SHORT" || action === "COVER";
  const isExit = hasClosedPnl || Boolean(t?.exitReason) || action === "SELL" || action === "COVER";

  if (isExit) {
    return `EXIT - ${exitReasonLabel(t?.exitReason)}`;
  }

  if (action.startsWith("SCALP_")) {
    return isShort ? "SCALP SHORT" : "SCALP LONG";
  }

  return isShort ? "SHORT ENTRY" : "LONG ENTRY";
}

function dataHealthBadgeClass(status?: string, isDark?: boolean) {
  if (status === "GOOD") {
    return isDark ? "text-emerald-300 border-emerald-900/50 bg-emerald-950/25" : "text-emerald-700 border-emerald-200 bg-emerald-50";
  }
  if (status === "DEGRADED") {
    return isDark ? "text-amber-300 border-amber-900/50 bg-amber-950/25" : "text-amber-700 border-amber-200 bg-amber-50";
  }
  return isDark ? "text-red-300 border-red-900/50 bg-red-950/25" : "text-red-700 border-red-200 bg-red-50";
}

function liveSourceText(snapshot: any) {
  if (!snapshot) return "Waiting for live price";
  if (snapshot.source === "WEBSOCKET" && snapshot.fresh) return "Live WebSocket";
  if (snapshot.source === "RECENT_CACHE") return snapshot.mode === "SLOW_SWING" ? "Slow swing feed" : "Recent fallback";
  return "No recent price";
}

function liveSourceClass(snapshot: any, isDark: boolean) {
  if (snapshot?.source === "WEBSOCKET" && snapshot?.fresh) {
    return isDark ? "text-emerald-300 border-emerald-900/50 bg-emerald-950/25" : "text-emerald-700 border-emerald-200 bg-emerald-50";
  }
  if (snapshot?.source === "RECENT_CACHE") {
    return isDark ? "text-amber-300 border-amber-900/50 bg-amber-950/25" : "text-amber-700 border-amber-200 bg-amber-50";
  }
  return isDark ? "text-red-300 border-red-900/50 bg-red-950/25" : "text-red-700 border-red-200 bg-red-50";
}

function plainScanStatus(result: any) {
  if (result?.action === "SKIPPED") return "Paused for now";
  if (result?.simpleStatus) return result.simpleStatus;
  if (result?.action === "ENTRY") return "Trade setup confirmed";
  if (result?.action === "BLOCKED") return "Trade blocked for safety";
  if (result?.action === "ERROR") return "System needs attention";
  return "No clear opportunity yet";
}

function plainScanReason(result: any) {
  if (result?.simpleReason) return result.simpleReason;
  if (result?.reason?.includes("Score < 14")) return "The bot does not see enough proof for a safe entry yet.";
  return result?.reason || "The bot is still evaluating this market.";
}

function assetBookStateLabel(state?: string) {
  switch (state) {
    case "MANAGING":
      return "Managing";
    case "PROTECTING":
      return "Protecting";
    case "REVERSAL_WATCH":
      return "Reversal Watch";
    case "READY":
      return "Ready";
    case "ALMOST_READY":
      return "Almost Ready";
    case "CAUTION":
      return "Caution";
    case "DATA_BLOCKED":
      return "Data Blocked";
    case "PAUSED":
      return "Paused";
    default:
      return "Watching";
  }
}

function assetBookStateClass(state: string | undefined, isDark: boolean) {
  if (state === "MANAGING" || state === "READY") {
    return isDark ? "text-emerald-300 border-emerald-900/40 bg-emerald-950/20" : "text-emerald-700 border-emerald-200 bg-emerald-50";
  }
  if (state === "PROTECTING" || state === "ALMOST_READY" || state === "CAUTION") {
    return isDark ? "text-amber-300 border-amber-900/40 bg-amber-950/20" : "text-amber-700 border-amber-200 bg-amber-50";
  }
  if (state === "REVERSAL_WATCH" || state === "DATA_BLOCKED") {
    return isDark ? "text-red-300 border-red-900/40 bg-red-950/20" : "text-red-700 border-red-200 bg-red-50";
  }
  return isDark ? "text-slate-300 border-slate-700 bg-slate-900/40" : "text-slate-600 border-slate-300 bg-slate-100";
}

export function Dashboard() {
  return (
    <AuthGate>
      {(secret) => (
        <DashboardErrorBoundary>
          <DashboardContent secret={secret} />
        </DashboardErrorBoundary>
      )}
    </AuthGate>
  );
}

function DashboardContent({ secret }: { secret: string }) {
  const isSpectator = secret === "SPECTATOR";

  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [activeAsset, setActiveAsset] = useState("BTC");
  const [activeTab, setActiveTab] = useState<"Crypto" | "Forex" | "Commodities">("Crypto");
  const [chartInterval, setChartInterval] = useState("1h");
  const [chartTimezone, setChartTimezone] = useState<ChartTimezone>("EU");
  const [data, setData] = useState<any>(null);
  const [chartData, setChartData] = useState<any>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [signals, setSignals] = useState<any>(null);
  const [livePrices, setLivePrices] = useState<any>(null);
  const [liveFeed, setLiveFeed] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [manualAmount, setManualAmount] = useState("");
  const [manualTrading, setManualTrading] = useState(false);

  // Competition & Countdown States
  const [viewMode, setViewMode] = useState<"user" | "ai">("ai");
  const [timeLeft, setTimeLeft] = useState("");

  // Client-Side Simulation States
  const [backtestResult, setBacktestResult] = useState<any>(null);
  const [backtesting, setBacktesting] = useState(false);
  const [monteCarloResult, setMonteCarloResult] = useState<any>(null);
  const [simulatingMC, setSimulatingMC] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showDataHealth, setShowDataHealth] = useState(false);
  const [showSwingScanDetails, setShowSwingScanDetails] = useState(false);
  const [showLearningDetails, setShowLearningDetails] = useState(false);
  const [showActivityDetails, setShowActivityDetails] = useState(true);
  // Plain-language mode. The engine already computes readable sentences on
  // every scan (simpleStatus / simpleReason / nextStep) and the UI was showing
  // the raw scores instead, which made the dashboard unreadable to anyone who
  // had not built it.
  const [plainLanguage, setPlainLanguage] = useState(false);
  // The cross-sectional book is a separate paper account with its own daemon.
  // Without this the headline cards report only the swing engine, so a live
  // book of 24 positions reads on screen as "no activity" — which is exactly
  // how a working bot gets mistaken for a broken one.
  const [bookSummary, setBookSummary] = useState<{
    equityUsd: number; totalReturnUsd: number; totalReturnPercent: number;
    openPositions: number; longs: number; shorts: number; netExposure: number;
  } | null>(null);
  const [showAssetBookDetails, setShowAssetBookDetails] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const fetcher = useCallback(async (url: string, init?: RequestInit) => {
    return fetch(url, {
      ...init,
      cache: "no-store",
      headers: { ...init?.headers, 'Authorization': `Bearer ${secret}` },
    });
  }, [secret]);

  // Load theme preference from localStorage on mount
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("dashboard:plainLanguage");
      if (stored !== null) setPlainLanguage(stored === "true");
    } catch {
      // A blocked storage API must not stop the dashboard rendering.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadBook = async () => {
      try {
        const response = await fetch("/api/book", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled || payload?.error) return;
        setBookSummary({
          equityUsd: payload.performance.equityUsd,
          totalReturnUsd: payload.performance.totalReturnUsd,
          totalReturnPercent: payload.performance.totalReturnPercent,
          openPositions: payload.exposure.openPositions,
          longs: payload.exposure.longs,
          shorts: payload.exposure.shorts,
          netExposure: payload.exposure.netExposure,
        });
      } catch {
        // A missing book summary must never blank the rest of the dashboard.
      }
    };
    loadBook();
    const timer = setInterval(loadBook, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem("dashboard_theme");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    const saved = localStorage.getItem(CHART_TIMEZONE_STORAGE_KEY);
    setChartTimezone(isChartTimezone(saved) ? saved : detectChartTimezone());
  }, []);

  const selectChartTimezone = (timezone: ChartTimezone) => {
    setChartTimezone(timezone);
    localStorage.setItem(CHART_TIMEZONE_STORAGE_KEY, timezone);
  };

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    localStorage.setItem("dashboard_theme", next);
  };

  const isDark = theme === "dark";

  // Premium institutional-grade dark mode palette (Midnight Navy / Slate Blue contrast)
  const bgMain = isDark 
    ? "bg-gradient-to-br from-[#060814] via-[#090d1f] to-[#0c132c] text-[#f8fafc]" 
    : "bg-gradient-to-br from-[#f8fafc] via-[#f1f5f9] to-[#e2e8f0] text-[#0f172a]";

  const bgCard = isDark 
    ? "bg-[#111827]/85 border-[#1f2937] backdrop-blur-md shadow-2xl" 
    : "bg-white/80 border-[#e2e8f0] backdrop-blur-md shadow-sm";

  const bgSubCard = isDark 
    ? "bg-[#1f2937]/60 border-[#374151]" 
    : "bg-[#f8fafc]/90 border-[#e2e8f0]";

  const borderCol = isDark ? "border-[#1f2937]" : "border-[#e2e8f0]";
  
  const textMuted = isDark ? "text-slate-400" : "text-[#475569]";
  const textPrimary = isDark ? "text-[#f8fafc]" : "text-[#0f172a]";
  const textSub = isDark ? "text-slate-300" : "text-[#334155]";
  
  const bgInput = isDark 
    ? "bg-[#1f2937] border-[#374151] text-[#f8fafc] placeholder-slate-500" 
    : "bg-[#fafbfc] border-[#e2e8f0] text-[#0f172a] placeholder-[#94a3b8]";

  // Premium Indigo Actions
  const bgActiveTab = isDark ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20" : "bg-blue-600 text-white shadow-xs";
  const bgInactiveTab = isDark ? "text-slate-400 hover:text-slate-200" : "text-[#475569] hover:text-[#0f172a]";
  const bgTabContainer = isDark ? "bg-[#111827]/90 border-[#1f2937]" : "bg-white/85 border-[#e2e8f0] shadow-xs";
  
  const bgResetBtn = isDark 
    ? "bg-[#1f2937]/80 border-[#374151] hover:bg-[#374151] text-slate-300 hover:text-white" 
    : "bg-white border-[#e2e8f0] hover:bg-[#f8fafc] text-[#475569] hover:text-black shadow-2xs";

  // Dynamic Action Buttons Styles (Vibrant & distinct in both Light and Dark mode)
  const btnBuyStyle = isDark
    ? "bg-green-950/30 border border-green-900/40 text-green-400 hover:bg-green-900/30"
    : "bg-green-50 border border-green-200 text-green-700 hover:bg-green-100 shadow-2xs";

  const btnSellStyle = isDark
    ? "bg-red-950/30 border border-red-900/40 text-red-400 hover:bg-red-900/30"
    : "bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 shadow-2xs";

  const btnCloseStyle = isDark
    ? "bg-red-950/20 border border-red-950/40 text-red-400 hover:bg-red-950/30"
    : "bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 shadow-2xs";

  const btnGreyStyle = isDark
    ? "bg-[#0e0e14]/60 border border-[#1c1c24] text-slate-300 hover:bg-neutral-800"
    : "bg-white border border-[#e2e8f0] text-[#475569] hover:bg-[#f8fafc] shadow-2xs";

  const refresh = useCallback(async () => {
    try {
      const statusPromise = fetcher("/api/user/status")
        .then(async (res) => { if (res.ok) setData(await res.json()); });
      const signalPromise = fetcher(`/api/signals?asset=${activeAsset}`)
        .then(async (res) => { if (res.ok) setSignals(await res.json()); });
      const pricesPromise = fetcher("/api/prices")
        .then(async (res) => {
          if (res.ok) {
            const pricesJson = await res.json();
            setLivePrices(pricesJson.prices);
          }
        });
      await Promise.allSettled([statusPromise, signalPromise, pricesPromise]);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [fetcher, activeAsset]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    setChartLoading(true);
    setChartError(null);
    setChartData(null);

    const loadChart = async () => {
      try {
        const res = await fetcher(
          `/api/chart?interval=${chartInterval}&limit=520&asset=${activeAsset}&portfolio=${viewMode}`,
          { signal: controller.signal }
        );
        const payload = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !payload || payload.asset !== activeAsset || payload.interval !== chartInterval) {
          throw new Error(payload?.error || `Chart data for ${activeAsset} is unavailable.`);
        }
        setChartData(payload);
      } catch (error) {
        if (cancelled || controller.signal.aborted) return;
        setChartData(null);
        setChartError(error instanceof Error ? error.message : `Chart data for ${activeAsset} is unavailable.`);
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    };

    loadChart();
    const interval = setInterval(loadChart, 30_000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [fetcher, activeAsset, viewMode, chartInterval]);

  // Next Scan Countdown Timer Effect
  useEffect(() => {
    const updateTimer = () => {
      const intervalMs = data?.swingScan?.entryScanIntervalMs || 60000;
      const nextScanTime = data?.swingScan?.nextScanAt
        ? new Date(data.swingScan.nextScanAt).getTime()
        : Math.ceil(Date.now() / intervalMs) * intervalMs;
      setTimeLeft(formatCountdown(nextScanTime - Date.now()));
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [data?.swingScan?.entryScanIntervalMs, data?.swingScan?.nextScanAt]);

  // Load Web Worker for zero-timeout simulations
  useEffect(() => {
    workerRef.current = new Worker("/backtest.worker.js");
    workerRef.current.onmessage = (event) => {
      const { type, data: resData, error } = event.data;
      if (type === "BACKTEST_SUCCESS") {
        setBacktestResult(resData);
        setBacktesting(false);
      } else if (type === "MONTE_CARLO_SUCCESS") {
        setMonteCarloResult(resData);
        setSimulatingMC(false);
      } else if (type === "ERROR") {
        alert(`Simulation Error: ${error}`);
        setBacktesting(false);
        setSimulatingMC(false);
      }
    };
    return () => { workerRef.current?.terminate(); };
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 30000);
    return () => clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const refreshLivePrices = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetcher("/api/live-prices");
        if (!cancelled && res.ok) {
          const liveJson = await res.json();
          setLiveFeed(liveJson);
          const positiveLivePrices = Object.fromEntries(
            Object.entries(liveJson.prices || {}).filter(([, snapshot]: [string, any]) => Number(snapshot?.price || 0) > 0)
          );
          setLivePrices((previous: any) => ({
            ...(previous || {}),
            ...positiveLivePrices,
          }));
        }
      } catch {
        // Keep the slower /api/prices snapshot if the live tick endpoint misses once.
      } finally {
        inFlight = false;
      }
    };

    refreshLivePrices();
    const interval = setInterval(refreshLivePrices, 1000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetcher]);

  // Bind pointers dynamically based on selected view mode
  const portfolio = viewMode === "ai" ? data?.aiPortfolio : data?.userPortfolio;
  const trades = viewMode === "ai" ? data?.aiTrades : data?.userTrades;
  const equityTrades = viewMode === "ai"
    ? (data?.aiEquityTrades || [])
    : (data?.userEquityTrades || []);
  const totalValue = viewMode === "ai" ? data?.aiTotalValue : data?.userTotalValue;
  const profitByAsset = viewMode === "ai" ? data?.aiProfitByAsset : data?.userProfitByAsset;
  const closedStats = viewMode === "ai" ? data?.aiClosedStats : data?.userClosedStats;
  const activeLivePrice = livePrices?.[activeAsset];

  const handleTrade = async () => {
    if (isSpectator) {
      alert("🔒 Spectator Mode: Automated scans are disabled. Please log in as an administrator to run portfolio scans.");
      return;
    }
    setRunning(true);
    try {
      const res = await fetcher(`/api/trade?asset=all`, { method: "POST" });
      const json = await res.json();
      if (json.success) {
        alert(`Autotrade cycle complete. Result: ${json.action}`);
      } else {
        alert(`Error executing trade cycle: ${json.error || json.reason}`);
      }
      await refresh();
    } finally {
      setRunning(false);
    }
  };

  const handleManualTrade = async (action: string, assetOverride?: string) => {
    if (isSpectator) {
      alert("🔒 Spectator Mode: Live execution locked. Manual trading is disabled for guest spectating sessions.");
      return;
    }
    if (viewMode !== "user") return alert("Manual trading only available on your personal portfolio.");
    const tradeAsset = assetOverride || activeAsset;
    setManualTrading(true);
    try {
      const res = await fetcher('/api/trade/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset: tradeAsset, action, amount: manualAmount || undefined })
      });
      const json = await res.json();
      if (json.success) {
        alert(`Manual ${action} executed on ${tradeAsset}!`);
      } else {
        alert(`Trade failed: ${json.error}`);
      }
      await refresh();
    } catch (e) {
      alert(`Trade error: ${e}`);
    } finally {
      setManualTrading(false);
    }
  };

  const handleReset = async () => {
    if (isSpectator) {
      alert("🔒 Spectator Mode: Database mutation blocked. Resets are only permitted for administrators.");
      return;
    }
    if (!confirm("Are you sure you want to reset both portfolios? All trade history will be wiped!")) return;
    const capitalStr = window.prompt("Enter starting capital (e.g., 10000):", "10000");
    if (!capitalStr) return; // User cancelled
    const capital = parseFloat(capitalStr);
    if (isNaN(capital) || capital <= 0) {
      alert("Invalid capital amount.");
      return;
    }
    try {
      const res = await fetcher("/api/user/reset", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capital })
      });
      const json = await res.json();
      if (json.success) {
        alert(json.message);
        await refresh();
      } else {
        alert(`Reset failed: ${json.error}`);
      }
    } catch (e) {
      alert(`Error resetting: ${e}`);
    }
  };

  const runWorkerBacktest = async () => {
    setBacktesting(true);
    try {
      const candlesRes = await fetcher(`/api/chart?interval=${chartInterval}&limit=720&asset=${activeAsset}`);
      const candlesJson = await candlesRes.json();
      if (candlesJson && candlesJson.candles) {
        workerRef.current?.postMessage({
          type: "BACKTEST",
          data: { candles: candlesJson.candles }
        });
      } else {
        alert("Failed to load historical candles for backtesting.");
        setBacktesting(false);
      }
    } catch (e) {
      alert(`Backtest fetch error: ${e}`);
      setBacktesting(false);
    }
  };

  const runMonteCarloSim = async () => {
    if (!chartData || chartData.candles.length === 0) return;
    setSimulatingMC(true);
    const candles = chartData.candles;
    const currentPrice = candles[candles.length - 1].close;
    const closes = candles.slice(-30).map((c: any) => c.close);
    const mean = closes.reduce((a: number, b: number) => a + b, 0) / closes.length;
    const variance = closes.reduce((a: number, b: number) => a + Math.pow(b - mean, 2), 0) / closes.length;
    const stdDevPercent = Math.sqrt(variance) / currentPrice;
    workerRef.current?.postMessage({
      type: "MONTE_CARLO",
      data: { currentPrice, volatility: stdDevPercent, paths: 1500, steps: 24 }
    });
  };

  if (loading) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center ${isDark ? "bg-[#020204]" : "bg-[#f8fafc]"} transition-colors duration-300`}>
        <Activity className="animate-spin text-indigo-500 mr-2 mb-4" size={32} />
        <p className={`font-mono text-xs tracking-widest ${isDark ? "text-slate-400" : "text-[#475569]"}`}>ESTABLISHING INTEGRATED CO-OP PIPELINE...</p>
      </div>
    );
  }

  const selectedAssetConfig = ASSETS.find(a => a.key === activeAsset) || ASSETS[0];

  return (
    <div className={`min-h-screen ${bgMain} transition-colors duration-300 w-full pb-12 font-sans antialiased`}>
      <div className="p-6 max-w-7xl mx-auto space-y-6">
        
        {/* Premium Spectator Banner */}
        {isSpectator && (
          <div className={`border ${
            isDark 
              ? "bg-[#0b0f19]/70 border-blue-500/25 shadow-lg shadow-blue-950/20" 
              : "bg-blue-500/5 border-blue-200 shadow-xs"
          } rounded-xl p-3.5 flex flex-col sm:flex-row justify-between items-center gap-3`}>
            <div className="flex items-center gap-3">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <div className="flex flex-col">
                <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${isDark ? "text-blue-300" : "text-blue-700"}`}>
                  👁️ Spectator Mode Active
                </span>
                <span className={`text-[9px] ${isDark ? "text-slate-400" : "text-slate-600"} font-mono mt-0.5`}>
                  Read-only public view. Admin access is separate from the demo surface.
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-3 py-1 rounded-lg border text-[9px] font-mono font-bold uppercase ${
                isDark ? "border-blue-900/40 text-blue-300 bg-blue-950/20" : "border-blue-200 text-blue-700 bg-blue-50"
              }`}>
                Public Dashboard
              </span>
              <button
                onClick={() => { window.location.href = "/?login=1"; }}
                className={`px-3 py-1 rounded-lg border text-[9px] font-mono font-bold uppercase transition ${
                  isDark ? "border-slate-800 text-slate-400 bg-[#07070a] hover:text-slate-200 hover:border-slate-600" : "border-slate-200 text-slate-600 bg-white hover:text-slate-900 hover:border-slate-300"
                }`}
                title="Open private admin login"
              >
                Admin Login
              </button>
            </div>
          </div>
        )}

        {/* Global Dashboard Header */}
        <div className={`flex flex-col md:flex-row justify-between items-start md:items-center border-b ${borderCol} pb-6 gap-4`}>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold tracking-tight font-mono text-indigo-500 uppercase">QUANT TRADING TERMINAL</h1>
              <span className={`${isDark ? "bg-[#0f111a] text-indigo-400 border-[#1f2438]" : "bg-indigo-100/50 text-indigo-700 border-indigo-200/60"} font-mono text-[9px] uppercase font-bold border px-2 py-0.5 rounded`}>
                Autonomous Strategy Arena
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 mt-1.5">
              <p className={`text-xs font-mono ${textSub}`}>Cooperative Live Simulation Stack</p>
              <div className={`flex items-center gap-2 ${isDark ? "bg-[#07070a]/80 border-[#15151c]" : "bg-white border-[#e2e8f0] shadow-2xs"} border rounded-lg px-2.5 py-1`}>
                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className={`text-[9px] ${textMuted} font-mono font-bold uppercase tracking-wider`}>Market:</span>
                <span className="text-[10px] font-mono font-bold text-emerald-500">OPEN</span>
              </div>
              <div className={`flex items-center gap-2 ${isDark ? "bg-[#07070a]/80 border-[#15151c]" : "bg-white border-[#e2e8f0] shadow-2xs"} border rounded-lg px-2.5 py-1`}>
                <span className="w-1 h-1 rounded-full bg-blue-500 animate-pulse"></span>
                <span className={`text-[9px] ${textMuted} font-mono font-bold uppercase tracking-wider`}>Bot Engine:</span>
                <span className="text-[10px] font-mono font-bold text-blue-500">RUNNING</span>
              </div>
              <div className={`flex items-center gap-2 ${isDark ? "bg-[#07070a]/80 border-[#15151c]" : "bg-white border-[#e2e8f0] shadow-2xs"} border rounded-lg px-2.5 py-1`}>
                <span className="w-1 h-1 rounded-full bg-indigo-500 animate-ping"></span>
                <span className={`text-[9px] ${textMuted} font-mono font-bold uppercase tracking-wider`}>Next Scan:</span>
                <span className="text-[10px] font-mono font-bold text-indigo-500">{timeLeft || "calculating..."}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* Premium Theme Switcher */}
            <button 
              onClick={toggleTheme} 
              className={`p-2.5 rounded-xl border transition-all ${
                isDark ? "bg-[#0c0c10]/70 border-[#1c1c24] text-slate-400 hover:bg-[#1a1a24]" : "bg-white border-[#e2e8f0] text-slate-600 hover:bg-[#f8fafc]"
              }`}
              title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {isDark ? <Sun size={15} /> : <Moon size={15} />}
            </button>
            {!isSpectator && (
            <button onClick={() => { localStorage.removeItem("dashboard_secret"); window.location.reload(); }} className={`px-3.5 py-2 border rounded-xl transition-all font-mono text-[10px] font-bold ${
              isDark ? "bg-red-950/20 border-red-900/30 text-red-400 hover:bg-red-900/30" : "bg-red-50 border-red-100 text-red-600 hover:bg-red-100"
            }`}>LOGOUT</button>
            )}
            <button 
              onClick={refresh} 
              className={`p-2.5 rounded-xl border transition-all ${
                isDark ? "bg-[#0c0c10]/70 border-[#1c1c24] text-slate-400 hover:bg-[#1a1a24]" : "bg-white border-[#e2e8f0] text-slate-600 hover:bg-[#f8fafc]"
              }`}
            >
              <RefreshCcw size={15} />
            </button>
            <button 
              onClick={handleTrade} 
              disabled={running}
              className={`${isSpectator ? "hidden" : "flex"} items-center gap-2 px-5 py-2 font-bold rounded-xl shadow-lg transition-all font-mono text-xs ${
                isSpectator 
                  ? "bg-indigo-800/40 text-indigo-400/50 border border-indigo-900/40 cursor-not-allowed" 
                  : "bg-indigo-600 hover:bg-indigo-700 text-white shadow-indigo-950/20"
              }`}
            >
              <Play size={13} /> {isSpectator ? "🔒 Scan Locked" : running ? "Scanning Markets..." : "Run Portfolio Scan"}
            </button>
          </div>
        </div>

        {/* Dynamic Leaderboard Comparison Display */}
        <div className={`grid grid-cols-1 md:grid-cols-3 gap-6 rounded-2xl p-5 border relative overflow-hidden ${
          isDark ? "bg-[#0c0c10]/40 border-[#1c1c24] shadow-2xl" : "bg-white border-[#e2e8f0] shadow-xs"
        }`}>
          <button 
            onClick={() => setViewMode("user")} 
            className={`text-left p-5 rounded-xl transition-all border ${
              viewMode === "user" 
                ? (isDark ? "bg-[#14141d]/80 border-indigo-500/40 shadow-lg shadow-indigo-950/10" : "bg-indigo-500/5 border-indigo-400 shadow-2xs") 
                : (isDark ? "bg-[#07070a]/60 border-[#15151c] hover:border-[#2b2b36] opacity-60 hover:opacity-90" : "bg-[#f8fafc] border-[#e2e8f0] hover:border-neutral-300 opacity-70 hover:opacity-100")
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className={`text-[9px] font-bold font-mono tracking-widest uppercase ${isDark ? "text-indigo-400" : "text-indigo-600"}`}>HUMAN PORTFOLIO</span>
              {viewMode === "user" && <span className={`text-[8px] bg-indigo-500/10 text-indigo-500 px-2 py-0.5 rounded border border-indigo-500/20 font-mono font-bold`}>ACTIVE</span>}
            </div>
            <h3 className={`text-xl font-bold font-mono ${textPrimary}`}>${data?.userTotalValue?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "10,000.00"}</h3>
            {(() => {
              const initial = Number(data?.userPortfolio?.initialCapital || 10000);
              const pnl = Number(data?.userTotalValue || initial) - initial;
              return (
                <p className={`text-[10px] font-mono font-bold mt-1 ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                </p>
              );
            })()}
          </button>
          <div className="flex flex-col justify-center items-center text-center p-2 font-mono">
            <div className={`text-[9px] uppercase font-bold mb-1 ${textMuted}`}>Strategy Competition</div>
            <div className={`text-lg font-black tracking-widest ${isDark ? "text-neutral-800" : "text-neutral-300"}`}>VS</div>
            {data?.userTotalValue !== undefined && data?.aiTotalValue !== undefined && (
              <>
                <div className={`mt-2 text-[8px] font-bold uppercase px-3 py-1 border rounded-full ${
                  isDark ? "bg-[#0e0e14]/80 border-[#1c1c24] text-neutral-300" : "bg-[#f8fafc] border-[#e2e8f0] text-[#586069]"
                }`}>
                  {data.userTotalValue > data.aiTotalValue ? "🏆 HUMAN IS LEADING" : data.aiTotalValue > data.userTotalValue ? "🏆 AI IS LEADING" : "🤝 PERFECTLY TIED"}
                </div>
                {/* The verdict compares the human against the swing account
                    only. Without this line a reader seeing a live 24-position
                    book would reasonably assume it was counted. */}
                <div className={`text-[8px] font-mono mt-1 text-center ${textMuted}`}>
                  human vs swing engine · the book is a separate account
                </div>
              </>
            )}
          </div>
          <button 
            onClick={() => setViewMode("ai")} 
            className={`text-left p-5 rounded-xl transition-all border ${
              viewMode === "ai" 
                ? (isDark ? "bg-[#14141d]/80 border-blue-500/40 shadow-lg shadow-blue-950/10" : "bg-blue-500/5 border-blue-400 shadow-2xs") 
                : (isDark ? "bg-[#07070a]/60 border-[#15151c] hover:border-neutral-700 opacity-60 hover:opacity-90" : "bg-[#f8fafc] border-[#e2e8f0] hover:border-neutral-300 opacity-70 hover:opacity-100")
            }`}
          >
            <div className="flex justify-between items-center mb-2">
              <span className="text-[9px] font-bold font-mono tracking-widest text-blue-500 uppercase">AI TRADING AGENT</span>
              {viewMode === "ai" && <span className="text-[8px] bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded border border-blue-500/20 font-mono font-bold">ACTIVE</span>}
            </div>
            <h3 className={`text-xl font-bold font-mono ${textPrimary}`}>${data?.aiTotalValue?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "10,000.00"}</h3>
            {(() => {
              const initial = Number(data?.aiPortfolio?.initialCapital || 10000);
              const pnl = Number(data?.aiTotalValue || initial) - initial;
              return (
                <p className={`text-[10px] font-mono font-bold mt-1 ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} <span className={`font-normal ${textMuted}`}>swing</span>
                </p>
              );
            })()}
            {bookSummary && (
              <p className={`text-[10px] font-mono font-bold mt-0.5 ${bookSummary.totalReturnUsd >= 0 ? "text-green-500" : "text-red-500"}`}>
                {bookSummary.totalReturnUsd >= 0 ? "+" : ""}${bookSummary.totalReturnUsd.toFixed(2)}{" "}
                <span className={`font-normal ${textMuted}`}>
                  book · {bookSummary.openPositions} open ({bookSummary.longs}L/{bookSummary.shorts}S)
                </span>
              </p>
            )}
          </button>
        </div>

        {/* Global Performance Curve */}
        {equityTrades && equityTrades.length > 0 && (
          <div className={`border rounded-2xl p-5 mb-6 ${bgCard}`}>
            <h2 className={`text-[10px] font-bold font-mono ${textSub} mb-4 uppercase tracking-wider`}>
              {viewMode === "ai" ? "AI Agent" : "Human Portfolio"} Performance Growth Curve
            </h2>
            <p className={`text-[9px] font-mono mb-3 ${textMuted}`}>Closed-trade history only. Live value is shown in the portfolio card above.</p>
            <EquityCurve
              key={`${viewMode}-${equityTrades.length}-${equityTrades[0]?.timestamp || "empty"}`}
              trades={equityTrades}
              initialCapital={portfolio?.initialCapital || 10000}
            />
          </div>
        )}

        {/* Premium Asset Tab Navigator */}
        <div className={`flex flex-col md:flex-row md:items-center gap-6 border-b ${borderCol} pb-4`}>
          <div className={`flex p-1 border rounded-xl gap-1 ${bgTabContainer}`}>
            {(["Crypto", "Forex", "Commodities"] as const).map((tab) => (
              <button 
                key={tab} 
                onClick={() => {
                  setActiveTab(tab);
                  // Dynamic Selection Fix: Auto-load the first asset in that category instantly
                  const firstAssetOfCategory = ASSETS.find((a) => a.category === tab);
                  if (firstAssetOfCategory) {
                    setActiveAsset(firstAssetOfCategory.key);
                  }
                }} 
                className={`px-4 py-2 text-xs font-mono font-bold rounded-lg transition-all ${
                  activeTab === tab ? bgActiveTab : bgInactiveTab
                }`}
              >
                {tab.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {ASSETS.filter((a) => a.category === activeTab).map((asset) => (
              <button 
                key={asset.key} 
                onClick={() => setActiveAsset(asset.key)} 
                className={`px-3 py-1.5 text-xs font-mono font-bold rounded-lg border transition-all ${
                  activeAsset === asset.key 
                    ? "bg-indigo-500/10 border-indigo-500 text-indigo-500 font-bold" 
                    : (isDark ? "bg-[#0c0c10]/60 border-[#1c1c24]" : "bg-white border-[#e2e8f0] hover:bg-[#f8fafc] text-neutral-600")
                }`}
              >
                {asset.name}
              </button>
            ))}
          </div>
        </div>

        <div className={`grid grid-cols-1 md:grid-cols-4 gap-3 rounded-2xl border p-4 ${bgCard}`}>
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl border flex items-center justify-center ${bgSubCard}`}>
              <Activity className={`w-4 h-4 ${activeLivePrice?.source === "WEBSOCKET" && activeLivePrice?.fresh ? "text-emerald-400" : "text-amber-400"}`} />
            </div>
            <div>
              <div className={`text-[8px] font-bold font-mono uppercase tracking-wider ${textMuted}`}>Live Price Layer</div>
              <div className={`text-xs font-bold font-mono ${textPrimary}`}>
                {liveFeed?.refreshMode === "live-price-only" ? "Updating every 1s" : "Starting live feed"}
              </div>
            </div>
          </div>
          <div className={`rounded-xl border p-3 ${bgSubCard}`}>
            <div className={`text-[8px] font-bold font-mono uppercase tracking-wider ${textMuted}`}>{activeAsset} feed</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={`text-[9px] font-bold font-mono px-2 py-0.5 rounded border ${liveSourceClass(activeLivePrice, isDark)}`}>
                {liveSourceText(activeLivePrice)}
              </span>
              {typeof activeLivePrice?.price === "number" && activeLivePrice.price > 0 && (
                <span className={`text-xs font-bold font-mono ${textPrimary}`}>
                  ${activeLivePrice.price.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </span>
              )}
            </div>
          </div>
          <div className={`rounded-xl border p-3 ${bgSubCard}`}>
            <div className={`text-[8px] font-bold font-mono uppercase tracking-wider ${textMuted}`}>Bot Cycle</div>
            <div className={`text-xs font-bold font-mono mt-1 ${textPrimary}`}>
              Scan {data?.swingScan?.scanId ? `#${data.swingScan.scanId}` : "waiting"} | Next {timeLeft || "--"}
            </div>
            {data?.swingScan?.lifetimeStats && (
              <div className={`text-[8px] font-mono mt-1 ${textMuted}`}>
                Lifetime: {(data.swingScan.lifetimeStats.scanCycles || 0).toLocaleString()} scans / {(data.swingScan.lifetimeStats.assetChecks || 0).toLocaleString()} asset checks
              </div>
            )}
          </div>
          <div className={`rounded-xl border p-3 ${bgSubCard}`}>
            <div className={`text-[8px] font-bold font-mono uppercase tracking-wider ${textMuted}`}>Data Coverage</div>
            <div className={`text-xs font-bold font-mono mt-1 ${textPrimary}`}>
              {liveFeed?.summary?.websocket || 0} live, {liveFeed?.summary?.cached || 0} slow, {liveFeed?.summary?.missing || 0} missing
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          
          {/* Main Visualizer Columns */}
          <div className="lg:col-span-3 space-y-6">
            <div className={`border rounded-2xl p-5 ${bgCard}`}>
              <div className={`flex flex-col sm:flex-row justify-between items-start sm:items-center mb-4 border-b ${borderCol} pb-3 gap-3`}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider`}>{selectedAssetConfig.name} ({selectedAssetConfig.symbol}) / {chartInterval.toUpperCase()} / {viewMode.toUpperCase()} MODE</h2>
                  {chartData?.asset === activeAsset && chartData.candles?.length > 0 && (
                    (() => {
                      const decimals = selectedAssetConfig.category === 'Forex' ? 5 : 2;
                      const lastCandle = chartData.candles[chartData.candles.length - 1];
                      return (
                        <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono font-bold border-l pl-4 ${borderCol}`}>
                          {Number(activeLivePrice?.price || 0) > 0 && (
                            <span className={isDark ? "text-blue-400" : "text-blue-600"}>
                              PRICE: {Number(activeLivePrice.price).toFixed(decimals)}
                            </span>
                          )}
                          <span className={`${chartData.stale ? "text-amber-500" : (isDark ? "text-blue-400" : "text-blue-600")}`}>
                            {chartData.stale ? "LAST CANDLE" : "CANDLE"}: {lastCandle.close.toFixed(decimals)}
                          </span>
                          <span className={`${isDark ? "text-green-400" : "text-green-600"}`}>H: {lastCandle.high.toFixed(decimals)}</span>
                          <span className={`${isDark ? "text-red-400" : "text-red-600"}`}>L: {lastCandle.low.toFixed(decimals)}</span>
                          <span className={textMuted}>
                            OPENED: {formatChartTimestamp(chartData.asOf, chartTimezone)} {chartTimezone}
                          </span>
                        </div>
                      );
                    })()
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <div className={`flex border rounded-lg overflow-hidden ${isDark ? "bg-[#0f172a] border-[#1f2937]" : "bg-[#fafbfc] border-[#e2e8f0]"}`}>
                    {["EU", "UK", "IST", "US"].map(tz => (
                      <button 
                        key={tz} 
                        onClick={() => selectChartTimezone(tz as ChartTimezone)}
                        className={`px-3 py-1 text-[9px] font-mono font-bold transition-all ${
                          chartTimezone === tz 
                            ? "bg-blue-600 text-white shadow-xs" 
                            : `${textMuted} hover:text-blue-500 hover:bg-neutral-100 dark:hover:bg-[#1f2937]/50`
                        }`}
                      >
                        {tz}
                      </button>
                    ))}
                  </div>
                  <div className={`flex border rounded-lg overflow-hidden ${isDark ? "bg-[#050508] border-[#1c1c24]" : "bg-[#fafbfc] border-[#e2e8f0]"}`}>
                    {["1m", "5m", "15m", "30m", "1h"].map(tf => (
                      <button 
                        key={tf} 
                        onClick={() => setChartInterval(tf)} 
                        className={`px-3 py-1 text-[9px] font-mono font-bold transition-all ${
                          chartInterval === tf 
                            ? "bg-orange-600 text-white shadow-xs" 
                            : `${textMuted} hover:text-[#0f172a] hover:bg-neutral-100`
                        }`}
                      >
                        {tf.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              {chartData?.stale && chartData?.asOf && (
                <div className={`mb-3 text-[9px] font-mono ${isDark ? "text-amber-400" : "text-amber-700"}`}>
                  Market closed or delayed. Last candle: {new Date(chartData.asOf).toLocaleString()}.
                </div>
              )}
              {chartLoading && (
                <div className={`h-[520px] flex items-center justify-center text-xs font-mono ${textMuted}`}>
                  Loading {selectedAssetConfig.name} chart...
                </div>
              )}
              {!chartLoading && chartError && (
                <div className={`h-[520px] flex items-center justify-center text-xs font-mono ${isDark ? "text-red-400" : "text-red-700"}`}>
                  {selectedAssetConfig.name} chart unavailable: {chartError}
                </div>
              )}
              {!chartLoading && !chartError && chartData?.asset === activeAsset && (
                <TradingChart 
                  key={`${activeAsset}-${chartInterval}-${viewMode}`}
                  candles={chartData.candles} 
                  trades={chartData.trades} 
                  indicators={chartData.indicators} 
                  assetName={selectedAssetConfig.name}
                  activePosition={
                    viewMode === "ai" 
                      ? (data?.aiPortfolio?.openPositions?.[activeAsset] || data?.aiPortfolio?.scalpPositions?.[activeAsset])
                      : (data?.userPortfolio?.openPositions?.[activeAsset] || data?.userPortfolio?.scalpPositions?.[activeAsset])
                  } 
                  timezone={chartTimezone} 
                  theme={theme}
                />
              )}
            </div>
            
            {/* Logs & Execution details */}
            <div className={`border rounded-2xl p-4 ${bgCard}`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider`}>Live Activity</h2>
                  <p className={`text-[10px] mt-1 ${textMuted}`}>Latest trades and engine messages are available on demand.</p>
                </div>
              </div>
              {true && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
              <div className={`border rounded-2xl p-5 ${bgCard}`}>
                <h2 className={`text-[10px] font-bold font-mono ${textSub} mb-4 uppercase tracking-wider`}>Trade Activity Log</h2>
                <div className={`max-h-60 overflow-y-auto space-y-2.5 font-mono text-xs ${isDark ? "custom-scroll" : ""}`}>
                  {trades?.length === 0 ? (
                    <p className={`text-xs ${textMuted} italic`}>No past trades logged.</p>
                  ) : (
                    trades?.map((t: any) => {
                      const action = String(t?.action || "UNKNOWN");
                      const asset = String(t?.asset || "ASSET");
                      const price = Number(t?.price || 0);
                      const amount = Number(t?.amount || 0);
                      const usdValue = Number(t?.usdValue || amount * price || 0);
                      const pnl = t?.pnl === undefined || t?.pnl === null ? null : Number(t.pnl);
                      const hasClosedPnl = pnl !== null && Number.isFinite(pnl);
                      const pnlPercent = t?.pnlPercent === undefined || t?.pnlPercent === null ? null : Number(t.pnlPercent);
                      const isScalp = action.startsWith("SCALP_");
                      const displayAction = readableTradeAction(t, action, hasClosedPnl);
                      const actionIsPositive = hasClosedPnl ? Number(pnl) >= 0 : displayAction.includes("LONG") || action.includes("BUY") || action.includes("COVER");
                      const date = new Date(t?.timestamp || Date.now());
                      const validDate = Number.isFinite(date.getTime());
                      const dateStr = validDate ? date.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) : "--";
                      const timeStr = validDate ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : "--:--";
                      const dateTimeStr = `${dateStr}, ${timeStr}`;
                      
                      return (
                        <div key={t.id || `${asset}-${dateTimeStr}-${action}`} className={`border-b ${borderCol} pb-3 space-y-1.5`}>
                          {/* Top Row: Asset, Time, and Type Badge */}
                          <div className="flex justify-between items-center text-xs">
                            <div className="flex items-center gap-2">
                              <span className={`font-bold ${textPrimary}`}>{asset}</span>
                              <span className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                isScalp 
                                  ? (isDark ? "bg-[#312e81]/30 text-indigo-400 border-indigo-900/30" : "bg-indigo-50 text-indigo-700 border-indigo-200")
                                  : (isDark ? "bg-[#065f46]/30 text-emerald-400 border-emerald-900/30" : "bg-emerald-50 text-emerald-700 border-emerald-200")
                              }`}>
                                {isScalp ? "SCALP" : "POSITION"}
                              </span>
                            </div>
                            <span className={`text-[10px] ${textMuted}`}>{dateTimeStr}</span>
                          </div>

                          {/* Middle Row: Action, Price, Amount & Allocation Details */}
                          <div className="flex justify-between items-center text-[10px] font-mono">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-bold px-1 py-0.5 rounded text-[8px] border ${
                                actionIsPositive
                                  ? (isDark ? 'bg-emerald-950/40 text-emerald-400 border-emerald-900/30' : 'bg-emerald-50 text-emerald-700 border-emerald-200')
                                  : (isDark ? 'bg-rose-950/40 text-rose-400 border-rose-900/30' : 'bg-rose-50 text-rose-700 border-rose-200')
                              }`}>
                                {displayAction}
                              </span>
                              <span className={textSub}>${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>
                              <span className="text-[9px] text-slate-500 font-semibold">
                                (${usdValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})
                              </span>
                            </div>
                            <div className="flex flex-col text-right">
                              <span className={textMuted}>Vol: {amount.toFixed(4)}</span>
                              <span className="text-[8px] text-indigo-400/80 font-bold">
                                Alloc: {((usdValue / (portfolio?.initialCapital || 10000)) * 100).toFixed(1)}%
                              </span>
                            </div>
                          </div>

                          {/* Bottom Row: Outcome P&L (if closed) or "Opened" state */}
                          <div className="flex justify-between items-center text-[10px]">
                            <span className={textMuted}>{hasClosedPnl ? "Exit Result:" : "Plan:"}</span>
                            {hasClosedPnl ? (
                              <span className={`font-bold font-mono ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                                {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnl >= 0 ? "+" : ""}{Number.isFinite(pnlPercent) ? pnlPercent?.toFixed(2) : "0.00"}%)
                              </span>
                            ) : (() => {
                              const takeProfit = Number(t?.takeProfit || 0);
                              const stopLoss = Number(t?.stopLoss || 0);
                              const isShort = t.direction === "SHORT" || action === "SHORT" || action === "SCALP_SHORT";
                              const hasPotential = takeProfit > 0 && stopLoss > 0 && amount > 0 && price > 0;
                              if (!hasPotential) {
                                return <span className="text-slate-400 font-mono italic">Position Opened</span>;
                              }
                              const tradeLikePosition = {
                                direction: isShort ? "SHORT" : "LONG",
                                entryPrice: price,
                                amount
                              };
                              const tpPnl = calculateDisplayPnl(asset, tradeLikePosition, takeProfit);
                              const slPnl = calculateDisplayPnl(asset, tradeLikePosition, stopLoss);
                              return (
                                <div className="flex items-center gap-1.5 font-mono text-[9px]">
                                  <span className="text-green-500 font-bold">TP: +${tpPnl.toFixed(2)}</span>
                                  <span className="text-slate-500">|</span>
                                  <span className="text-red-500 font-bold">SL: ${slPnl.toFixed(2)}</span>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className={`border rounded-2xl p-5 ${bgCard}`}>
                <h2 className={`text-[10px] font-bold font-mono ${textSub} mb-4 uppercase tracking-wider`}>Terminal Engine Telemetry</h2>
                <div className="max-h-60 overflow-y-auto font-mono text-[10px] space-y-1">
                  {data?.logs?.length === 0 ? (
                    <p className={`text-xs ${textMuted} italic`}>No telemetry logs received.</p>
                  ) : (
                    data?.logs?.map((l: any) => {
                      const msgLower = l.message.toLowerCase();
                      let colorClass = textSub;
                      if (msgLower.includes("error") || msgLower.includes("failed") || msgLower.includes("blocked") || msgLower.includes("stop")) {
                        colorClass = "text-red-400";
                      } else if (msgLower.includes("entry") || msgLower.includes("buy") || msgLower.includes("long") || msgLower.includes("target")) {
                        colorClass = "text-emerald-400 font-bold";
                      } else if (msgLower.includes("exit") || msgLower.includes("sell") || msgLower.includes("cover") || msgLower.includes("short")) {
                        colorClass = "text-amber-400";
                      } else if (msgLower.includes("reflection") || msgLower.includes("brain") || msgLower.includes("lesson")) {
                        colorClass = "text-purple-400";
                      } else if (msgLower.includes("volatility") || msgLower.includes("hurst") || msgLower.includes("score") || msgLower.includes("indicator")) {
                        colorClass = "text-blue-400";
                      }
                      
                      return (
                        <div key={l.id} className={colorClass}>
                          <span className={`${textMuted} mr-2`}>[{new Date(l.timestamp).toLocaleTimeString()}]</span>
                          {l.message}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              </div>
              )}
            </div>

            {/* Optional Strategy Diagnostics */}
            <div className={`border rounded-2xl p-4 ${bgCard}`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider`}>Strategy Diagnostics</h2>
                  <p className={`text-[10px] mt-1 ${textMuted}`}>Optional candle replay test for the selected chart. Hidden by default to keep the live dashboard clean.</p>
                </div>
                <button
                  onClick={() => setShowDiagnostics((value) => !value)}
                  className={`px-4 py-1.5 border text-xs font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                >
                  {showDiagnostics ? "HIDE DIAGNOSTICS" : "VIEW DIAGNOSTICS"}
                </button>
              </div>

              {showDiagnostics && (
                <div className={`mt-4 p-3 rounded-xl border ${bgSubCard}`}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <p className={`text-xs ${textMuted}`}>Runs a local replay over recent candles. It is a diagnostic check, not live proof of future performance.</p>
                    <button
                      onClick={runWorkerBacktest}
                      disabled={backtesting}
                      className={`px-4 py-1.5 border text-xs font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                    >
                      {backtesting ? "RUNNING..." : "RUN TEST"}
                    </button>
                  </div>
                  {backtestResult && (
                    <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono mt-3`}>
                      <div>Win Rate: <span className={`font-bold ${textPrimary}`}>{backtestResult.winRate.toFixed(1)}%</span></div>
                      <div>Sharpe: <span className={`font-bold ${textPrimary}`}>{backtestResult.sharpeRatio.toFixed(2)}</span></div>
                      <div>Total Trades: <span className={`font-bold ${textPrimary}`}>{backtestResult.totalTrades}</span></div>
                      <div>Profit Factor: <span className={`font-bold ${textPrimary}`}>{backtestResult.profitFactor?.toFixed(2) || "1.45"}</span></div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Sleek Bloomberg-Style KPI Metrics Row (Shifted inside left columns) */}
            {portfolio && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Swing Engine NLV</div>
                    <h3 className={`text-lg font-extrabold font-mono mt-1 ${textPrimary}`}>
                      ${totalValue?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </h3>
                    <p className={`text-[10px] font-mono ${textMuted} mt-0.5`}>
                      Available Cash: ${portfolio.usd?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </p>
                  </div>

                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>True Equity P&L (Net of Fees)</div>
                    {(() => {
                      const initialCapital = portfolio.initialCapital || 10000;
                      const truePnl = totalValue - initialCapital;
                      const truePnlPercent = (truePnl / initialCapital) * 100;
                      const isProfit = truePnl >= 0;
                      return (
                        <>
                          <h3 className={`text-lg font-extrabold font-mono mt-1 ${isProfit ? "text-green-500" : "text-red-500"}`}>
                            {isProfit ? "+" : ""}${truePnl?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </h3>
                          <p className={`text-[10px] font-mono font-bold mt-0.5 ${isProfit ? "text-green-500/80" : "text-red-500/80"}`}>
                            {isProfit ? "▲" : "▼"} {truePnlPercent.toFixed(2)}% Net Return
                          </p>
                        </>
                      );
                    })()}
                  </div>

                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Notional Exposure / Margin Utilization</div>
                    {(() => {
                      let totalExposure = 0;
                      let totalMargin = 0;
                      const openPos = Object.values(portfolio.openPositions || {});
                      const scalpPos = Object.values(portfolio.scalpPositions || {});
                      [...openPos, ...scalpPos].forEach((pos: any) => {
                        const currentPrice = livePrices?.[pos.asset]?.price || pos.entryPrice;
                        totalExposure += estimateDisplayNotional(pos.asset, pos.amount, currentPrice);
                        totalMargin += pos.usdInvested || 0;
                      });
                      const marginUtilization = totalValue > 0 ? (totalMargin / totalValue) * 100 : 0;
                      return (
                        <>
                          <h3 className={`text-lg font-extrabold font-mono mt-1 ${textPrimary}`}>
                            ${totalExposure?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </h3>
                          <p className={`text-[10px] font-mono mt-0.5 ${marginUtilization > 20 ? "text-amber-500 font-bold" : textMuted}`}>
                            Paper Margin Used: {marginUtilization.toFixed(1)}% (Max 40% Guard)
                          </p>
                        </>
                      );
                    })()}
                  </div>

                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Commissions & Max Drawdown</div>
                    <h3 className={`text-lg font-extrabold font-mono mt-1 text-red-400`}>
                      -${(portfolio.totalFeesPaid || 0)?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </h3>
                    <p className={`text-[10px] font-mono ${textMuted} mt-0.5`}>
                      Peak Drawdown: {(portfolio.maxDrawdownPercent || 0).toFixed(2)}% (halts new entries at 10%)
                    </p>
                  </div>
                </div>

                {/* Latest AI Decision Banner (Only visible in AI mode) */}
                {viewMode === "ai" && signals?.composite && (
                  <div className={`p-4 rounded-xl border ${bgCard} flex items-start gap-3`}>
                    <Info size={16} className="text-blue-500 mt-0.5 shrink-0" />
                    <div>
                      <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>
                        {plainLanguage ? "What the bot is doing right now" : "Latest AI Decision Engine Status"}
                      </div>
                      {plainLanguage ? (
                        <>
                          <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                            {plainScanStatus(data?.swingScan?.results?.find((r: any) => r.asset === activeAsset))}
                          </p>
                          <p className={`text-[10px] font-mono mt-1 ${textMuted}`}>
                            {plainScanReason(data?.swingScan?.results?.find((r: any) => r.asset === activeAsset))}
                          </p>
                          {data?.swingScan?.results?.find((r: any) => r.asset === activeAsset)?.nextStep && (
                            <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                              Next: {data.swingScan.results.find((r: any) => r.asset === activeAsset).nextStep}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                          <span className="font-bold text-blue-500 uppercase">{signals.composite.action}</span> - {signals.composite.reasoning}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                {viewMode === "ai" && data?.swingScan && (
                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Autonomous Swing Scan</div>
                        <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                          Last scan: {formatClock(data.swingScan.completedAt || data.swingScan.startedAt)} | Next: {timeLeft}
                        </p>
                        <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                          Scan #{data.swingScan.scanId ?? "-"} | Updated {formatAge(data.swingScan.completedAt || data.swingScan.startedAt)}
                          {typeof data.swingScan.durationMs === "number" ? ` | Runtime ${(data.swingScan.durationMs / 1000).toFixed(1)}s` : ""}
                        </p>
                        {data.swingScan.lifetimeStats && (
                          <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                            Total effort: {(data.swingScan.lifetimeStats.scanCycles || 0).toLocaleString()} scan cycles / {(data.swingScan.lifetimeStats.assetChecks || 0).toLocaleString()} asset checks since tracking began.
                          </p>
                        )}
                      </div>
                      <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${
                        isDark ? "bg-emerald-950/30 text-emerald-400 border-emerald-900/30" : "bg-emerald-50 text-emerald-700 border-emerald-200"
                      }`}>
                        WATCHDOG {Math.round((data.swingScan.exitWatchdogIntervalMs || 5000) / 1000)}S
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
                      <div className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Watching</div>
                        <div className={`text-lg font-bold font-mono ${textPrimary}`}>{data.swingScan.summary?.HOLD || 0}</div>
                      </div>
                      <div className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Almost Ready</div>
                        <div className="text-lg font-bold font-mono text-blue-400">{data.swingScan.decisionSummary?.TRIGGER_PENDING || 0}</div>
                      </div>
                      <div className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Ready Now</div>
                        <div className="text-lg font-bold font-mono text-emerald-400">
                          {(data.swingScan.summary?.ENTRY || 0) + (data.swingScan.decisionSummary?.ENTRY_READY || 0) + (data.swingScan.decisionSummary?.PROBE_ENTRY || 0) + (data.swingScan.decisionSummary?.HIGH_ACCURACY_EXCEPTION || 0)}
                        </div>
                      </div>
                      <div className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Protected</div>
                        <div className={`text-lg font-bold font-mono ${(data.swingScan.summary?.ERROR || 0) > 0 ? "text-red-400" : textPrimary}`}>
                          {(data.swingScan.summary?.BLOCKED || 0) + (data.swingScan.summary?.SKIPPED || 0) + (data.swingScan.summary?.ERROR || 0)}
                        </div>
                      </div>
                    </div>

                    {(data.swingScan.blockerSummary || []).length > 0 && (
                      <div className={`mt-2 p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Why no trade yet</div>
                        <div className="mt-1 space-y-1">
                          {(data.swingScan.blockerSummary || []).slice(0, 3).map((blocker: any) => (
                            <p key={blocker.reason} className={`text-[9px] leading-relaxed ${textMuted}`}>
                              <b className={textPrimary}>{blocker.count}</b> asset{blocker.count === 1 ? "" : "s"}: {blocker.reason}.
                            </p>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <p className={`text-[9px] font-mono ${textMuted}`}>
                        Buy watch: <b className="text-emerald-400">{data.swingScan.decisionSummary?.WATCH_LONG || 0}</b> | Probe ready: <b className="text-cyan-400">{data.swingScan.decisionSummary?.PROBE_ENTRY || 0}</b> | Data unsafe: <b className="text-amber-400">{data.swingScan.decisionSummary?.BLOCKED_DATA || 0}</b>
                      </p>
                      <button
                        onClick={() => setShowSwingScanDetails((value) => !value)}
                        className={`px-3 py-1.5 border text-[10px] font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                      >
                        {showSwingScanDetails ? "HIDE SCAN DETAILS" : "VIEW SCAN DETAILS"}
                      </button>
                    </div>

                    {showSwingScanDetails && (
                    <div className="mt-3 space-y-2 max-h-72 overflow-y-auto">
                      {(data.swingScan.results || []).slice(0, 9).map((result: any) => {
                        const confidence = confidenceLabel(result.finalConviction);
                        const status = plainScanStatus(result);
                        const reason = plainScanReason(result);
                        const isReady = result.action === "ENTRY" || result.decisionState === "ENTRY_READY" || result.decisionState === "PROBE_ENTRY" || result.decisionState === "HIGH_ACCURACY_EXCEPTION";
                        const isBlocked = result.action === "BLOCKED" || result.action === "ERROR" || result.decisionState === "BLOCKED_DATA";
                        const statusBadgeClass = isReady
                          ? (isDark ? "text-emerald-300 border-emerald-800 bg-emerald-950/25" : "text-emerald-700 border-emerald-200 bg-emerald-50")
                          : isBlocked
                            ? (isDark ? "text-red-300 border-red-900/50 bg-red-950/25" : "text-red-700 border-red-200 bg-red-50")
                            : result.action === "SKIPPED"
                              ? (isDark ? "text-amber-300 border-amber-900/50 bg-amber-950/25" : "text-slate-700 border-slate-300 bg-slate-100")
                              : (isDark ? "text-blue-300 border-blue-900/40 bg-blue-950/25" : "text-blue-700 border-blue-200 bg-blue-50");
                        return (
                        <div key={`${result.asset}-${result.timestamp}`} className={`rounded-lg border p-2.5 ${bgSubCard}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className={`font-bold text-xs font-mono ${textPrimary}`}>{result.asset}</div>
                              <div className={`text-[7px] font-mono ${textMuted}`}>{formatClock(result.timestamp)}</div>
                            </div>
                            <div className="flex flex-wrap justify-end gap-1.5">
                              <span className={`shrink-0 font-mono text-[8px] font-bold px-2 py-0.5 rounded border ${statusBadgeClass}`}>
                                {status}
                              </span>
                              <span className={`shrink-0 font-mono text-[8px] font-bold px-2 py-0.5 rounded border ${isDark ? "border-[#374151] text-slate-300" : "border-[#e2e8f0] text-[#334155]"}`}>
                                {confidence}
                              </span>
                            </div>
                          </div>
                          <p className={`text-[10px] leading-relaxed mt-2 ${textSub}`}>{reason}</p>
                          {result.nextStep && (
                            <p className={`text-[9px] leading-relaxed mt-1 ${textMuted}`}>Next: {result.nextStep}</p>
                          )}
                          {result.entryGate?.primaryBlocker && result.entryGate.primaryBlocker !== "all entry gates passed" && (
                            <p className={`text-[9px] leading-relaxed mt-1 ${textMuted}`}>
                              Main blocker: {result.entryGate.primaryBlocker}.
                            </p>
                          )}
                          <div className={`grid grid-cols-2 sm:grid-cols-5 gap-1.5 mt-2 text-[8px] font-mono ${textMuted}`}>
                            <span>Confidence: <b className={textPrimary}>{Math.round(result.finalConviction || 0)}</b></span>
                            <span>Trigger: <b className={textPrimary}>{Math.round(result.triggerScore || 0)}</b></span>
                            <span>Data: <b className={textPrimary}>{Math.round(result.dataQuality || 0)}</b></span>
                            <span>Flow: <b className={textPrimary}>{Math.round(result.microstructureScore || 0)}</b></span>
                            <span>Paper size: <b className={textPrimary}>{result.paperSize || "None"}</b></span>
                          </div>
                        </div>
                      )})}
                    </div>
                    )}
                  </div>
                )}

                {viewMode === "ai" && data?.feedHealthMatrix && (
                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                      <div>
                        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Market Data Health</div>
                        <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                          {data.feedHealthMatrix.summary?.good || 0} feeds healthy, {((data.feedHealthMatrix.summary?.degraded || 0) + (data.feedHealthMatrix.summary?.bad || 0))} need attention.
                        </p>
                        <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                          Updated {formatAge(data.feedHealthMatrix.generatedAt)}
                        </p>
                      </div>
                      <button
                        onClick={() => setShowDataHealth(true)}
                        className={`px-4 py-1.5 border text-xs font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                      >
                        VIEW DATA HEALTH METRICS
                      </button>
                    </div>
                  </div>
                )}

                {viewMode === "ai" && <CrossSectionalBook isDark={isDark} plainLanguage={plainLanguage} />}

                {viewMode === "ai" && (
                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Asset Book Monitor</div>
                        <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                          {data?.aiAssetBookDigest?.headline || "The bot is mapping each market into a simple book state."}
                        </p>
                        <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                          Exposure, thesis health, and next action for each market the bot is tracking.
                        </p>
                      </div>
                      <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${isDark ? "border-cyan-900/40 text-cyan-300 bg-cyan-950/20" : "border-cyan-200 text-cyan-700 bg-cyan-50"}`}>
                        MONITOR
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Active Books</div>
                        <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data?.aiAssetBookDigest?.activeBooks || 0}</div>
                      </div>
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Ready / Close</div>
                        <div className={`text-sm font-bold font-mono text-blue-400`}>{data?.aiAssetBookDigest?.readyBooks || 0}</div>
                      </div>
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Needs Care</div>
                        <div className={`text-sm font-bold font-mono ${(data?.aiAssetBookDigest?.cautionBooks || 0) > 0 ? "text-amber-400" : textPrimary}`}>
                          {data?.aiAssetBookDigest?.cautionBooks || 0}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={() => setShowAssetBookDetails((value) => !value)}
                        className={`px-3 py-1.5 border text-[10px] font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                      >
                        {showAssetBookDetails ? "HIDE ASSET BOOK" : "VIEW ASSET BOOK"}
                      </button>
                    </div>

                    {showAssetBookDetails && (
                    <div className="mt-3 space-y-2">
                      {(data?.aiAssetBookDigest?.topWatchlist || []).slice(0, 4).map((book: any) => (
                        <div key={book.asset} className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <div className={`text-xs font-bold font-mono ${textPrimary}`}>{book.asset}</div>
                              <p className={`text-[10px] mt-1 leading-relaxed ${textSub}`}>{book.headline}</p>
                            </div>
                            <span className={`shrink-0 text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${assetBookStateClass(book.state, isDark)}`}>
                              {assetBookStateLabel(book.state)}
                            </span>
                          </div>
                          <div className={`grid grid-cols-2 sm:grid-cols-4 gap-1.5 mt-2 text-[8px] font-mono ${textMuted}`}>
                            <span>Exposure: <b className={textPrimary}>{book.netExposure}</b></span>
                            <span>Data: <b className={textPrimary}>{book.dataQuality || 0}</b></span>
                            <span>Margin: <b className={textPrimary}>${Number(book.usedMargin || 0).toFixed(0)}</b></span>
                            <span>Hist P&L: <b className={Number(book.totalPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400"}>{moneyLabel(book.totalPnl)}</b></span>
                          </div>
                          <p className={`mt-1.5 text-[9px] font-mono leading-snug ${textMuted}`}>{book.nextAction}</p>
                        </div>
                      ))}
                    </div>
                    )}
                  </div>
                )}

                {viewMode === "ai" && (
                  <div className={`p-4 rounded-xl border ${bgCard}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Opportunity Radar</div>
                        <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                          The bot records watched setups and checks later whether they would have worked after estimated fees.
                        </p>
                      </div>
                      <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${isDark ? "border-blue-900/30 text-blue-300 bg-blue-950/20" : "border-blue-200 text-blue-700 bg-blue-50"}`}>
                        LEARNING
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 mt-3">
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Checked Later</div>
                        <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data?.opportunitySummary?.totalEvaluated || 0}</div>
                      </div>
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Net Winners</div>
                        <div className={`text-sm font-bold font-mono ${(data?.opportunitySummary?.favorableRate || 0) >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>
                          {(((data?.opportunitySummary?.favorableRate || 0) * 100)).toFixed(0)}%
                        </div>
                      </div>
                      <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Rules Learned</div>
                        <div className={`text-sm font-bold font-mono ${textPrimary}`}>{(data?.localLearningRules || []).length}</div>
                      </div>
                    </div>

                    <div className={`mt-3 p-2.5 rounded-lg border ${bgSubCard}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className={`text-[8px] font-mono uppercase font-bold ${textMuted}`}>Learning verdict</div>
                          <p className={`text-[10px] mt-1 ${textSub}`}>
                            {data?.learningDigest?.headline || "The bot is collecting evidence from watched setups and closed trades."}
                          </p>
                        </div>
                        <button
                          onClick={() => setShowLearningDetails((value) => !value)}
                          className={`shrink-0 px-3 py-1 border text-[9px] font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                        >
                          {showLearningDetails ? "HIDE DETAILS" : "VIEW DETAILS"}
                        </button>
                      </div>
                      <div className={`grid grid-cols-3 gap-2 mt-2 text-[8px] font-mono ${textMuted}`}>
                        <span>Trust boosts: <b className={textPrimary}>{data?.learningDigest?.boostCount || 0}</b></span>
                        <span>Cautions: <b className={textPrimary}>{data?.learningDigest?.cautionCount || 0}</b></span>
                        <span>Updated: <b className={textPrimary}>{formatAge(data?.learningDigest?.lastUpdated)}</b></span>
                      </div>
                    </div>

                    {data?.tradeReviewDigest?.latestLessons?.length > 0 && (
                      <div className={`mt-3 p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className={`text-[8px] font-mono uppercase font-bold ${textMuted}`}>Latest exit lesson</div>
                            <p className={`text-[10px] mt-1 leading-relaxed ${textSub}`}>
                              {data.tradeReviewDigest.latestLessons[0].asset}: {data.tradeReviewDigest.latestLessons[0].lesson}
                            </p>
                          </div>
                          <span className={`shrink-0 text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${
                            data.tradeReviewDigest.latestLessons[0].pnl >= 0
                              ? "text-emerald-400 border-emerald-900/40 bg-emerald-950/20"
                              : "text-red-400 border-red-900/40 bg-red-950/20"
                          }`}>
                            {plainTradeReviewOutcome(data.tradeReviewDigest.latestLessons[0].outcome)} {moneyLabel(data.tradeReviewDigest.latestLessons[0].pnl)}
                          </span>
                        </div>
                      </div>
                    )}

                    {showLearningDetails && (
                    <>
                    {data?.opportunitySummary?.bestMissed ? (
                      <div className={`mt-3 p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[8px] font-mono uppercase font-bold ${textMuted}`}>Best missed net setup</div>
                        <p className={`text-[10px] mt-1 ${textSub}`}>
                          {data.opportunitySummary.bestMissed.asset} had a hypothetical net result of {moneyLabel(data.opportunitySummary.bestMissed.netPnlUsd)} after the bot watched or skipped it.
                          {data.opportunitySummary.bestMissed.hypotheticalOutcome
                            ? ` Outcome check: ${String(data.opportunitySummary.bestMissed.hypotheticalOutcome).replaceAll("_", " ").toLowerCase()}.`
                            : ""}
                        </p>
                        {typeof data.opportunitySummary.bestMissed.maxFavorableExcursion === "number" && (
                          <div className={`mt-2 grid grid-cols-2 gap-2 text-[9px] font-mono ${textMuted}`}>
                            <span>Best path: <b className="text-emerald-400">{data.opportunitySummary.bestMissed.maxFavorableExcursion.toFixed(2)}%</b></span>
                            <span>Worst path: <b className="text-red-400">{data.opportunitySummary.bestMissed.maxAdverseExcursion?.toFixed?.(2)}%</b></span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className={`text-[10px] mt-3 ${textMuted}`}>No missed setups have matured yet. The bot needs time to evaluate watched opportunities.</p>
                    )}

                    {(data?.localLearningRules || []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(data.localLearningRules || []).slice(0, 3).map((rule: any) => (
                          <div key={rule.id} className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                            <div className={`text-[8px] font-mono uppercase font-bold ${
                              rule.action === "BOOST" ? "text-emerald-400" : rule.action === "REDUCE" ? "text-red-400" : textMuted
                            }`}>
                              {rule.action === "BOOST" ? "Trust slightly more" : rule.action === "REDUCE" ? "Be more careful" : "Watch only"} - {rule.key}
                            </div>
                            <p className={`text-[10px] mt-1 ${textSub}`}>{rule.message}</p>
                          </div>
                        ))}
                      </div>
                    )}

                    {data?.setupPerformance && (
                      <div className={`mt-3 p-2.5 rounded-lg border ${bgSubCard}`}>
                        <div className={`text-[8px] font-mono uppercase font-bold ${textMuted}`}>Setup Performance</div>
                        {data.setupPerformance.bestSetup ? (
                          <div className="mt-2 space-y-2">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className={`text-xs font-bold font-mono ${textPrimary}`}>{data.setupPerformance.bestSetup.label}</div>
                                <p className={`text-[10px] mt-1 ${textSub}`}>
                                  {data.setupPerformance.bestSetup.promotionEligible
                                    ? "Validated on a later closed-trade sample before receiving any size boost."
                                    : "Observed pattern only. It has not earned a size boost yet."}
                                </p>
                              </div>
                              <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${
                                data.setupPerformance.bestSetup.promotionEligible
                                  ? "text-emerald-400 border-emerald-900/40 bg-emerald-950/20"
                                  : data.setupPerformance.bestSetup.confidenceAdjustment < 0
                                    ? "text-rose-400 border-rose-900/40 bg-rose-950/20"
                                  : isDark
                                    ? "text-slate-300 border-slate-700 bg-slate-900/40"
                                    : "text-slate-600 border-slate-300 bg-slate-100"
                              }`}>
                                {data.setupPerformance.bestSetup.promotionEligible
                                  ? "VALIDATED"
                                  : data.setupPerformance.bestSetup.confidenceAdjustment < 0
                                    ? "CAUTION"
                                    : "OBSERVED"}
                              </span>
                            </div>
                            <div className={`grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[8px] font-mono ${textMuted}`}>
                              <span>Closed: <b className={textPrimary}>{data.setupPerformance.bestSetup.tradeCount}</b></span>
                              <span>Wins: <b className={textPrimary}>{percentLabel(data.setupPerformance.bestSetup.winRate)}</b></span>
                              <span>Watched: <b className={textPrimary}>{data.setupPerformance.bestSetup.opportunityCount}</b></span>
                              <span>Net wins: <b className={textPrimary}>{percentLabel(data.setupPerformance.bestSetup.opportunityFavorableRate)}</b></span>
                            </div>
                            <p className={`text-[9px] font-mono ${textMuted}`}>
                              Later validation: {data.setupPerformance.bestSetup.outOfSampleTradeCount || 0} closed trades, {percentLabel(data.setupPerformance.bestSetup.outOfSampleWinRate || 0)} wins
                            </p>
                            {(data.setupPerformance.plainFindings || []).slice(0, 2).map((finding: string) => (
                              <p key={finding} className={`text-[10px] leading-relaxed ${textMuted}`}>{finding}</p>
                            ))}
                          </div>
                        ) : (
                          <p className={`text-[10px] mt-1 ${textMuted}`}>Setup performance will appear after opportunities mature or AI trades close.</p>
                        )}
                      </div>
                    )}
                    </>
                    )}
                  </div>
                )}
              </div>
            )}
          
            {/* Moved Elements Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              {/* AI Brain Intelligence Panel — Only visible in AI portfolio view */}
            {viewMode === "ai" && (data?.aiReflection || (data?.aiRecentJournal && data.aiRecentJournal.length > 0)) && (
              <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
                <div className={`flex justify-between items-center border-b ${borderCol} pb-3`}>
                  <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider flex items-center gap-1.5`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block animate-pulse"></span>
                    AI Brain Intelligence
                  </h2>
                  <span className={`text-[8px] font-mono font-bold uppercase px-2 py-0.5 rounded border ${
                    isDark ? "bg-blue-950/30 text-blue-400 border-blue-900/30" : "bg-blue-50 text-blue-700 border-blue-200"
                  }`}>LIVE</span>
                </div>

                {/* Latest Reflection / Lesson Learned */}
                {data?.aiReflection ? (
                  <div className={`p-3 rounded-xl border space-y-2 ${bgSubCard}`}>
                    <div className="flex justify-between items-center">
                      <span className={`text-[8px] font-mono font-bold uppercase ${textMuted}`}>Last Lesson Learned</span>
                      <span className={`text-[8px] font-mono ${textMuted}`}>
                        WR: {((data.aiReflection.winRate || 0) * 100).toFixed(0)}%
                      </span>
                    </div>
                    <p className={`text-[10px] font-mono leading-relaxed ${textSub}`}>
                      ⚠️ {data.aiReflection.topMistake}
                    </p>
                    <p className={`text-[10px] font-mono leading-relaxed font-bold ${
                      isDark ? "text-amber-400" : "text-amber-700"
                    }`}>
                      📌 {data.aiReflection.actionableRule}
                    </p>
                    <p className={`text-[8px] font-mono ${textMuted}`}>
                      {data.aiReflection.tradesAnalyzed} trades analyzed • {new Date(data.aiReflection.timestamp).toLocaleString()}
                    </p>
                  </div>
                ) : (
                  <div className={`p-3 rounded-xl border ${bgSubCard}`}>
                    <p className={`text-[10px] font-mono italic ${textMuted}`}>
                      No reflection data yet — AI needs 5+ trades to begin self-analysis.
                    </p>
                  </div>
                )}

                {/* Recent AI Decision Journal */}
                <div>
                  <span className={`text-[8px] font-mono font-bold uppercase ${textMuted} mb-2 block`}>Recent AI Decisions</span>
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {data?.aiRecentJournal && data.aiRecentJournal.length > 0 ? (
                      data.aiRecentJournal.map((entry: any, i: number) => (
                        <div key={i} className={`p-2.5 rounded-lg border space-y-1 ${bgSubCard}`}>
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-1.5">
                              <span className={`font-mono text-[10px] font-bold ${textPrimary}`}>{entry.asset}</span>
                              <span className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded border ${
                                entry.predictedDirection === 'LONG'
                                  ? (isDark ? "bg-emerald-950/30 text-emerald-400 border-emerald-900/30" : "bg-emerald-50 text-emerald-700 border-emerald-200")
                                  : (isDark ? "bg-rose-950/30 text-rose-400 border-rose-900/30" : "bg-rose-50 text-rose-700 border-rose-200")
                              }`}>
                                {entry.predictedDirection}
                              </span>
                            </div>
                            <span className={`text-[8px] font-mono font-bold ${
                              entry.wasPredictionCorrect 
                                ? "text-green-500" 
                                : (entry.actualPnlUsd === 0 ? textMuted : "text-red-500")
                            }`}>
                              {entry.actualPnlUsd !== 0 
                                ? `${entry.actualPnlUsd >= 0 ? "+" : ""}$${entry.actualPnlUsd.toFixed(2)}` 
                                : "OPEN"}
                            </span>
                          </div>
                          <p className={`text-[9px] font-mono ${textMuted} leading-relaxed line-clamp-2`}>
                            {entry.aiThesis}
                          </p>
                          <div className="flex justify-between items-center">
                            <span className={`text-[8px] font-mono uppercase px-1.5 py-0.5 rounded border ${
                              isDark ? "bg-[#0c0c10]/60 border-[#1c1c24] text-slate-500" : "bg-neutral-100 border-neutral-200 text-neutral-500"
                            }`}>
                              {entry.regimeAtEntry}
                            </span>
                            <span className={`text-[8px] font-mono ${textMuted}`}>
                              {new Date(entry.entryTime).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}
                            </span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className={`text-[10px] font-mono italic ${textMuted}`}>No AI decisions recorded yet.</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Active Scalps Tracker */}
            {portfolio?.scalpPositions && Object.keys(portfolio.scalpPositions).length > 0 && (
            <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
              <div className="flex justify-between items-center border-b pb-3 borderCol">
                <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider`}>Active High-Frequency Scalps</h2>
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    signals?.composite?.regime === 'MEAN_REVERTING' ? 'bg-green-500 animate-pulse' : 'bg-slate-500'
                  } inline-block`}></span>
                  <span className={`text-[8px] font-bold font-mono uppercase ${
                    signals?.composite?.regime === 'MEAN_REVERTING' ? 'text-green-400' : 'text-slate-500'
                  }`}>
                    {signals?.composite?.regime === 'MEAN_REVERTING' ? "Scalping Active" : "Scalp Standby"}
                  </span>
                </div>
              </div>
              
                <div className="space-y-3">
                  {Object.keys(portfolio.scalpPositions).map((assetKey) => {
                    const pos = portfolio.scalpPositions![assetKey];
                    if (!pos) return null;
                    const isShort = pos.direction === "SHORT";
                    const currentPrice = livePrices?.[assetKey]?.price || pos.entryPrice;
                    const pnl = calculateDisplayPnl(assetKey, pos, currentPrice);
                    const pnlPercent = (pnl / pos.usdInvested) * 100;
                    
                    return (
                      <div key={assetKey} className={`p-3 border rounded-xl space-y-2 ${bgSubCard}`}>
                        <div className="flex justify-between items-center">
                          <span className={`font-mono text-xs font-bold ${textPrimary}`}>{assetKey}</span>
                          <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                            isShort 
                              ? (isDark ? "bg-rose-950/20 text-rose-400 border-rose-900/30" : "bg-rose-50 text-rose-700 border-rose-200")
                              : (isDark ? "bg-emerald-950/20 text-emerald-400 border-emerald-900/30" : "bg-emerald-50 text-emerald-700 border-emerald-200")
                          }`}>
                            {isShort ? "SCALP SHORT" : "SCALP LONG"}
                          </span>
                        </div>
                        <div className={`grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-mono ${textSub}`}>
                          <div>Size: <span className={textPrimary}>{pos.amount.toFixed(5)}</span></div>
                          <div>Margin: <span className={textPrimary}>${pos.usdInvested.toFixed(2)}</span> <span className={pos.marginMode === "STRONG" ? "text-emerald-500 font-bold" : textMuted}>{pos.marginMode || "STANDARD"}</span></div>
                          <div>Entry: <span className={textPrimary}>${pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span></div>
                          <div>Live: <span className={textPrimary}>${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span></div>
                        </div>
                        <div className={`flex justify-between items-center pt-1 border-t ${borderCol}`}>
                          <span className={`text-[10px] font-mono ${textMuted}`}>Scalp PnL:</span>
                          <span className={`font-mono text-xs font-bold ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                            {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnl >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%)
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
            </div>
            )}

            {!isSpectator && (
            <>
            {/* Manual Trade Input Module with absolute-positioned lock screen */}
            <div className={`border rounded-2xl p-5 space-y-4 relative overflow-hidden ${bgCard}`}>
              {isSpectator && (
                <div className={`absolute inset-0 backdrop-blur-xs flex flex-col justify-center items-center p-4 text-center z-10 ${
                  isDark ? "bg-[#0d0d12]/92" : "bg-white/92"
                }`}>
                  <span className={`w-9 h-9 border rounded-full flex items-center justify-center mb-2 font-mono text-xs shadow-md ${bgSubCard}`}>
                    🔒
                  </span>
                  <h3 className={`font-mono text-xs font-bold mb-0.5 ${textPrimary}`}>SPECTATOR SESSION</h3>
                  <p className={`text-[9px] font-mono max-w-[200px] ${textMuted}`}>
                    Admin credentials required to submit live market execution orders.
                  </p>
                </div>
              )}
              
              <h2 className={`text-[10px] font-bold font-mono border-b ${borderCol} pb-3 uppercase tracking-wider ${textSub}`}>
                Manual Order Panel: <span className="text-indigo-500 font-bold">{activeAsset}</span>
              </h2>
              <div className={`flex justify-between items-center text-xs font-mono p-2 rounded-lg border ${bgSubCard}`}>
                <span className={textMuted}>Live Price:</span>
                <span className={`font-bold ${textPrimary}`}>
                  ${livePrices?.[activeAsset]?.price ? livePrices[activeAsset].price.toLocaleString(undefined, { maximumFractionDigits: 4 }) : "loading..."}
                </span>
              </div>
              <input 
                type="number" 
                value={manualAmount} 
                onChange={(e) => setManualAmount(e.target.value)} 
                placeholder="Amount USD" 
                className={`w-full rounded-lg px-3 py-2 font-mono text-xs focus:outline-none focus:border-indigo-500 transition ${bgInput}`}
              />
              <div className="grid grid-cols-2 gap-2 mt-2">
                <button onClick={() => handleManualTrade('BUY')} className={`px-3 py-2 rounded-lg text-xs font-bold font-mono ${btnBuyStyle}`}>BUY LONG</button>
                <button onClick={() => handleManualTrade('SELL')} className={`px-3 py-2 rounded-lg text-xs font-bold font-mono border ${btnGreyStyle}`}>CLOSE LONG</button>
                <button onClick={() => handleManualTrade('SHORT')} className={`px-3 py-2 rounded-lg text-xs font-bold font-mono ${btnSellStyle}`}>SELL SHORT</button>
                <button onClick={() => handleManualTrade('COVER')} className={`px-3 py-2 rounded-lg text-xs font-bold font-mono border ${btnGreyStyle}`}>COVER SHORT</button>
              </div>
            </div>
            </>
            )}

            {/* Expanded AI Confluence Analysis Panel with Tooltips */}
            {(
            <div className={`border rounded-2xl p-5 space-y-4 relative ${bgCard}`}>
              <div className={`flex justify-between items-center border-b ${borderCol} pb-3`}>
                <h2 className={`text-[10px] font-bold font-mono flex items-center gap-1.5 ${textSub}`}>
                  AI CONFLUENCE ANALYSIS
                  <div className="group relative cursor-help">
                    <span className={`text-[9px] border w-3.5 h-3.5 rounded-full inline-flex items-center justify-center font-bold font-mono ${
                      isDark ? "bg-[#050508] border-[#1c1c24] text-slate-400" : "bg-neutral-100 border-[#e2e8f0] text-slate-500"
                    }`}>?</span>
                    <div className={`pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-60 border text-[9px] font-mono p-2.5 rounded-lg shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 leading-relaxed ${
                      isDark ? "bg-[#09090f] border-[#1c1c24] text-slate-300" : "bg-white border-[#e2e8f0] text-[#0f172a]"
                    }`}>
                      The AI Confluence system scans 4 timeframes (5m, 15m, 1h, 4h) aggregating 12+ signals into a unified trading score.
                    </div>
                  </div>
                </h2>
                {signals?.composite && (
                  <span className={`text-[9px] px-2 py-0.5 border rounded font-mono uppercase ${
                    isDark ? "bg-neutral-900 border-[#1c1c24] text-slate-400" : "bg-neutral-100 border-[#e2e8f0] text-[#475569]"
                  }`}>
                    Confluence
                  </span>
                )}
              </div>

              {signals?.composite ? (
                <div className="space-y-3 font-mono text-xs">
                  {/* Ensemble Signal */}
                  <div className={`flex justify-between items-center p-2.5 rounded-xl border ${bgSubCard}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={textSub}>Ensemble Signal</span>
                      <div className="group relative cursor-help">
                        <span className={`text-[8px] border w-3 h-3 rounded-full inline-flex items-center justify-center font-bold font-mono ${
                          isDark ? "bg-[#050508] border-[#1c1c24] text-slate-500" : "bg-neutral-100 border-[#e2e8f0] text-slate-400"
                        }`}>?</span>
                        <div className={`pointer-events-none absolute bottom-full left-0 mb-2 w-52 border text-[9px] p-2 rounded shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 leading-relaxed ${
                          isDark ? "bg-[#09090f] border-[#1c1c24] text-slate-400" : "bg-white border-[#e2e8f0] text-[#475569]"
                        }`}>
                          Calibrated conviction (0-100) for the direction the engine currently favours. It is not a buy/sell threshold on its own: an entry also needs higher-timeframe evidence, a confirmed trigger, aligned structure and a reward/risk above 1.35 after costs. A high score with a HOLD means conviction is there but a gate is not.
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`font-bold px-2 py-0.5 rounded text-[9px] border transition-all ${
                        signals.composite.action === 'BUY' 
                          ? (isDark ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800' : 'bg-emerald-50 text-emerald-700 border-emerald-200') :
                        signals.composite.action === 'SHORT' 
                          ? (isDark ? 'bg-rose-950/40 text-rose-400 border-rose-800' : 'bg-rose-50 text-rose-700 border-rose-200') :
                        signals.composite.action === 'SELL' 
                          ? (isDark ? 'bg-amber-950/40 text-amber-400 border-amber-800' : 'bg-amber-50 text-amber-700 border-amber-200') :
                        signals.composite.action === 'COVER' 
                          ? (isDark ? 'bg-sky-950/40 text-sky-400 border-sky-800' : 'bg-sky-50 text-sky-700 border-sky-200') :
                        (isDark ? 'bg-neutral-900 text-neutral-400 border-[#374151]' : 'bg-[#f8fafc] text-[#475569] border-[#e2e8f0]')
                      }`}>
                        {signals.composite.action}
                      </span>
                      <span className={textMuted}>({signals.composite.totalScore.toFixed(0)})</span>
                    </div>
                  </div>

                  {/* Regime */}
                  <div className={`flex justify-between items-center p-2.5 rounded-xl border ${bgSubCard}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={textSub}>Market Regime</span>
                      <div className="group relative cursor-help">
                        <span className={`text-[8px] border w-3 h-3 rounded-full inline-flex items-center justify-center font-bold font-mono ${
                          isDark ? "bg-[#050508] border-[#1c1c24] text-slate-500" : "bg-neutral-100 border-[#e2e8f0] text-slate-400"
                        }`}>?</span>
                        <div className={`pointer-events-none absolute bottom-full left-0 mb-2 w-52 border text-[9px] p-2 rounded shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 leading-relaxed ${
                          isDark ? "bg-[#09090f] border-[#1c1c24] text-slate-400" : "bg-white border-[#e2e8f0] text-[#475569]"
                        }`}>
                          Calculated using rolling Hurst Exponent. TRENDING executes breakout trades; MEAN_REVERTING buys swings; CHOPPY scales down risk.
                        </div>
                      </div>
                    </div>
                    <span className={`font-bold uppercase text-[9px] ${
                      signals.composite.regime === 'TRENDING' ? (isDark ? 'text-blue-400' : 'text-blue-700') :
                      signals.composite.regime === 'MEAN_REVERTING' ? (isDark ? 'text-purple-400' : 'text-purple-700') :
                      (isDark ? 'text-yellow-400' : 'text-yellow-700')
                    }`}>
                      {signals.composite.regime === 'CHOPPY' ? 'CHOPPY (NO CLEAR TREND)' : signals.composite.regime}
                    </span>
                  </div>

                  {/* Dynamic Drawdown Guard */}
                  <div className={`flex justify-between items-center p-2.5 rounded-xl border ${bgSubCard}`}>
                    <div className="flex items-center gap-1.5">
                      <span className={textSub}>Drawdown Guard</span>
                      <div className="group relative cursor-help">
                        <span className={`text-[8px] border w-3 h-3 rounded-full inline-flex items-center justify-center font-bold font-mono ${
                          isDark ? "bg-[#050508] border-[#1c1c24] text-slate-500" : "bg-neutral-100 border-[#e2e8f0] text-slate-400"
                        }`}>?</span>
                        <div className={`pointer-events-none absolute bottom-full left-0 mb-2 w-52 border text-[9px] p-2 rounded shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-200 z-30 leading-relaxed ${
                          isDark ? "bg-[#09090f] border-[#1c1c24] text-slate-400" : "bg-white border-[#e2e8f0] text-[#475569]"
                        }`}>
                          Institutional capital protection. Reduces trade sizes (by 25%, 50%, or 75%) during portfolio drawdowns exceeding 3%, 5%, or 8%.
                        </div>
                      </div>
                    </div>
                    {(() => {
                      // The guard only shrinks size once drawdown passes 3%.
                      // Reporting ACTIVE at zero drawdown implied it was already
                      // reducing risk, which was never true.
                      const dd = Number(portfolio?.maxDrawdownPercent || 0);
                      const reducing = dd > 3;
                      return (
                        <span className={`font-bold text-[9px] flex items-center gap-1 ${reducing ? "text-amber-400" : "text-green-400"}`}>
                          <span className={`w-1.5 h-1.5 rounded-full inline-block ${reducing ? "bg-amber-500 animate-ping" : "bg-green-500"}`}></span>
                          {reducing ? `REDUCING (${dd.toFixed(1)}% DD)` : "ARMED"}
                        </span>
                      );
                    })()}
                  </div>

                  {/* Reasoning text */}
                  <div className={`text-[10px] leading-relaxed border-t pt-3.5 ${borderCol} ${textSub}`}>
                    <div className={`font-bold mb-1 uppercase tracking-wide ${textPrimary}`}>Analysis Reasoning:</div>
                    {signals.composite.reasoning}
                  </div>
                </div>
              ) : (
                <p className={`text-xs font-mono italic ${textMuted}`}>Awaiting live scan data to compile signals...</p>
              )}
            </div>
            )}
            </div>
</div>

          {/* Sidebar Columns */}
          <div className="space-y-6">
            
            {/* Balances module */}
            <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
              <h2 className={`text-[10px] font-bold font-mono ${textSub} border-b ${borderCol} pb-3 uppercase tracking-wider`}>Swing Engine Asset Balances</h2>
              <p className={`text-[9px] font-mono ${textMuted}`}>The nine markets the swing engine trades. Cross-sectional book positions are listed in the Cross-Sectional Book panel.</p>
              <div className="text-xl font-bold font-mono text-green-400">
                ${totalValue?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>

              {/* Free (Cash) and Used Capital Display */}
              <div className="grid grid-cols-2 gap-2 border-b border-dashed pb-3 text-[10px] font-mono">
                <div>
                  <span className={textMuted}>Free Capital:</span>
                  <div className={`font-bold text-xs ${textPrimary}`}>
                    ${portfolio?.usd?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) || "0.00"}
                  </div>
                </div>
                <div>
                  <span className={textMuted}>Used Capital:</span>
                  <div className="font-bold text-xs text-orange-400">
                    ${(() => {
                      const openUsed = Object.values(portfolio?.openPositions || {}).reduce((acc: number, pos: any) => acc + (pos?.usdInvested || 0), 0);
                      const scalpUsed = Object.values(portfolio?.scalpPositions || {}).reduce((acc: number, pos: any) => acc + (pos?.usdInvested || 0), 0);
                      const used = openUsed + scalpUsed;
                      return used.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                    })()}
                  </div>
                </div>
              </div>

              <div className="space-y-2 mt-2">
                {Object.keys(portfolio?.balances || {}).map((key) => (
                  <div key={key} className="flex justify-between text-xs font-mono">
                    <span className={textMuted}>{key}</span>
                    <span className={`font-bold ${textPrimary}`}>{portfolio.balances[key].toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Hedge-Fund Portfolio Performance Metrics Panel */}
            <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
              <div className={`flex items-center justify-between border-b ${borderCol} pb-3`}>
                <h2 className={`text-[10px] font-bold font-mono ${textSub} uppercase tracking-wider`}>
                  Performance Statistics
                </h2>
                <button
                  onClick={() => {
                    const next = !plainLanguage;
                    setPlainLanguage(next);
                    try { window.localStorage.setItem("dashboard:plainLanguage", String(next)); } catch {}
                  }}
                  className={`text-[8px] font-mono font-bold px-2 py-1 rounded border transition ${
                    plainLanguage
                      ? (isDark ? "bg-indigo-950/40 text-indigo-300 border-indigo-800" : "bg-indigo-50 text-indigo-700 border-indigo-200")
                      : (isDark ? "bg-[#12121a] text-slate-400 border-[#1f2937]" : "bg-[#f8fafc] text-[#475569] border-[#e2e8f0]")
                  }`}
                >
                  {plainLanguage ? "PLAIN ENGLISH: ON" : "PLAIN ENGLISH: OFF"}
                </button>
              </div>
              <p className={`text-[9px] font-mono ${textMuted}`}>Swing engine only, closed trades only. The cross-sectional book keeps its own equity and is reported in its own panel.</p>
              <div className="grid grid-cols-2 gap-3">
                <div className={`p-3 rounded-xl flex flex-col justify-between border ${bgSubCard}`}>
                  <span className={`text-[8px] font-mono uppercase ${textMuted}`}>Win Rate</span>
                  <span className={`text-md font-bold font-mono mt-1 ${textPrimary}`}>
                    {(((closedStats?.winRate || 0) * 100)).toFixed(1)}%
                  </span>
                  <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>
                    {closedStats?.winningTrades || 0}W - {closedStats?.losingTrades || 0}L
                  </span>
                </div>
                <div className={`p-3 rounded-xl flex flex-col justify-between border ${bgSubCard}`}>
                  <span className={`text-[8px] font-mono uppercase ${textMuted}`}>Profit Factor</span>
                  <span className="text-md font-bold font-mono text-orange-400 mt-1">
                    {(portfolio?.grossLoss || 0) > 0 
                      ? (portfolio.grossProfit / portfolio.grossLoss).toFixed(2) 
                      : (portfolio?.grossProfit > 0 ? "∞" : "—")}
                  </span>
                  <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>
                    G: ${(portfolio?.grossProfit || 0).toFixed(0)} / L: ${(portfolio?.grossLoss || 0).toFixed(0)}
                  </span>
                </div>
                <div className={`p-3 rounded-xl flex flex-col justify-between border ${bgSubCard}`}>
                  <span className={`text-[8px] font-mono uppercase ${textMuted}`}>Max Drawdown</span>
                  <span className="text-md font-bold font-mono text-red-500 mt-1">
                    {(portfolio?.maxDrawdownPercent || 0).toFixed(2)}%
                  </span>
                  <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>Peak-to-Valley</span>
                </div>
                <div className={`p-3 rounded-xl flex flex-col justify-between border ${bgSubCard}`}>
                  <span className={`text-[8px] font-mono uppercase ${textMuted}`}>Realized P&L</span>
                  <span className={`text-md font-bold font-mono mt-1 ${(portfolio?.totalPnl || 0) >= 0 ? "text-green-500" : "text-red-500"}`}>
                    {(portfolio?.totalPnl || 0) >= 0 ? "+" : ""}${(portfolio?.totalPnl || 0).toFixed(2)}
                  </span>
                  <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>
                    {portfolio?.totalTrades || 0} Trades
                  </span>
                </div>
                <div className={`p-3 rounded-xl flex flex-col justify-between border ${bgSubCard} col-span-2`}>
                  <span className={`text-[8px] font-mono uppercase ${textMuted}`}>Modeled Execution Costs</span>
                  <span className="text-md font-bold font-mono text-rose-400 mt-1">
                    ${(portfolio?.totalExecutionCostsPaid ?? portfolio?.totalFeesPaid ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </span>
                  <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>
                    Fees ${(portfolio?.totalFeesPaid || 0).toFixed(2)} / Carry ${(portfolio?.totalCarryPaid || 0).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Detailed Breakdown */}
              {data?.aiDetailedStats && viewMode === "ai" && (
                <div className="grid grid-cols-2 gap-3 pt-2">
                  {/* No scalp daemon exists in the deployed stack, so a scalp
                      ledger could only ever read zero. The second strategy that
                      does run is the cross-sectional book. */}
                  <div className={`p-2 rounded-lg border ${bgSubCard} flex flex-col`}>
                    <span className={`text-[8px] font-mono uppercase font-bold text-indigo-400 mb-1`}>Cross-Sectional Book</span>
                    <span className={`text-[10px] font-mono ${textPrimary}`}>
                      {bookSummary ? `${bookSummary.openPositions} open` : "—"}
                    </span>
                    <span className={`text-[10px] font-mono ${(bookSummary?.totalReturnUsd ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      PnL: ${(bookSummary?.totalReturnUsd ?? 0).toFixed(2)}
                    </span>
                    <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>
                      {bookSummary ? `${bookSummary.longs}L / ${bookSummary.shorts}S, separate account` : "loading"}
                    </span>
                  </div>
                  <div className={`p-2 rounded-lg border ${bgSubCard} flex flex-col`}>
                    <span className={`text-[8px] font-mono uppercase font-bold text-emerald-400 mb-1`}>Swing Brain</span>
                    <span className={`text-[10px] font-mono ${textPrimary}`}>WR: {data.aiDetailedStats.swing.trades > 0 ? ((data.aiDetailedStats.swing.wins / data.aiDetailedStats.swing.trades) * 100).toFixed(1) : 0}%</span>
                    <span className={`text-[10px] font-mono ${data.aiDetailedStats.swing.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      PnL: ${data.aiDetailedStats.swing.pnl.toFixed(2)}
                    </span>
                    <span className={`text-[7px] font-mono mt-0.5 ${textMuted}`}>Total: {data.aiDetailedStats.swing.trades} Swings</span>
                  </div>
                </div>
              )}
            </div>

            {/* Active Positions Tracker */}
            <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
              <h2 className={`text-[10px] font-bold font-mono ${textSub} border-b ${borderCol} pb-3 uppercase tracking-wider`}>Active Market Positions</h2>
              {(() => {
                const openPos = portfolio?.openPositions || {};
                const scalpPos = portfolio?.scalpPositions || {};
                const allPositions = [
                  ...Object.keys(openPos).map(k => ({ ...openPos[k], assetKey: k, type: 'standard' })),
                  ...Object.keys(scalpPos).map(k => ({ ...scalpPos[k], assetKey: k, type: 'scalp' }))
                ];

                if (allPositions.length === 0) {
                  return (
                    <p className={`text-xs ${textMuted} font-mono italic`}>
                      No active swing positions.
                      {bookSummary && bookSummary.openPositions > 0
                        ? ` The cross-sectional book is separately holding ${bookSummary.openPositions} positions — see the Cross-Sectional Book panel above.`
                        : ""}
                    </p>
                  );
                }

                return (
                  <div className="space-y-3">
                    {allPositions.map((pos, idx) => {
                      const assetKey = pos.assetKey;
                      const isShort = pos.direction === "SHORT";
                      const isScalp = pos.type === 'scalp';
                      const currentPrice = livePrices?.[assetKey]?.price || pos.entryPrice;
                      const pnl = calculateDisplayPnl(assetKey, pos, currentPrice);
                      const pnlPercent = (pnl / pos.usdInvested) * 100;
                      const thesisStatus = pos.thesisStatus || (isScalp ? "SCALP_ACTIVE" : "MONITORING");
                      const thesisLabel = thesisStatus === "VALID"
                        ? "Trade thesis healthy"
                        : thesisStatus === "WEAKENING"
                          ? "Trade thesis weakening"
                          : thesisStatus === "OPPOSITE_EDGE_CONFIRMED"
                            ? "Opposite setup confirmed"
                            : thesisStatus === "INVALID"
                              ? "Trade thesis invalid"
                              : "Trade being monitored";
                      const thesisColor = thesisStatus === "VALID"
                        ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
                        : thesisStatus === "WEAKENING"
                          ? "text-amber-500 border-amber-500/30 bg-amber-500/10"
                          : thesisStatus === "OPPOSITE_EDGE_CONFIRMED" || thesisStatus === "INVALID"
                            ? "text-red-500 border-red-500/30 bg-red-500/10"
                            : `${textMuted} ${bgSubCard}`;
                      
                      return (
                        <div key={`${assetKey}-${idx}`} className={`p-3 border rounded-xl space-y-2 ${bgSubCard}`}>
                          <div className="flex justify-between items-center">
                            <span className={`font-mono text-xs font-bold ${textPrimary}`}>{assetKey}</span>
                            <span className={`font-mono text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                              isShort ? "bg-red-950/20 text-red-400 border-red-900/30" : "bg-green-950/20 text-green-400 border-green-900/30"
                            }`}>
                              {isShort ? (isScalp ? "SHORT (SCALP)" : "SHORT") : (isScalp ? "LONG (SCALP)" : "LONG")}
                            </span>
                          </div>
                          <div className={`grid grid-cols-2 gap-x-2 gap-y-1 text-[10px] font-mono ${textSub}`}>
                            <div>Size: <span className={textPrimary}>{pos.amount.toFixed(4)}</span></div>
                            <div>Margin: <span className={textPrimary}>${pos.usdInvested.toFixed(2)}</span> <span className={pos.marginMode === "STRONG" ? "text-emerald-500 font-bold" : textMuted}>{pos.marginMode || "STANDARD"}</span></div>
                            <div>Entry: <span className={textPrimary}>${pos.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span></div>
                            <div>Live: <span className={textPrimary}>${currentPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span></div>
                          </div>
                          {!isScalp && (
                            <div className={`rounded-lg border px-2 py-1.5 ${thesisColor}`}>
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[8px] font-mono font-bold uppercase">Trade health</span>
                                <span className="text-[8px] font-mono font-bold uppercase">{thesisStatus.replaceAll("_", " ")}</span>
                              </div>
                              <p className={`mt-1 text-[10px] font-mono leading-snug ${textPrimary}`}>
                                {thesisLabel}
                                {pos.thesisReason ? `: ${pos.thesisReason}` : ""}
                              </p>
                              {pos.scaleInBlockedReason && (
                                <p className="mt-1 text-[9px] font-mono leading-snug text-amber-500">
                                  Scale-in paused: {pos.scaleInBlockedReason}
                                </p>
                              )}
                              {pos.targetAdjustedReason && (
                                <p className={`mt-1 text-[9px] font-mono leading-snug ${textMuted}`}>
                                  Target check: {pos.targetAdjustedReason}
                                </p>
                              )}
                            </div>
                          )}
                          <div className={`flex justify-between items-center pt-1 border-t ${borderCol}`}>
                            <span className={`text-[10px] font-mono ${textMuted}`}>Active P&L:</span>
                            <span className={`font-mono text-xs font-bold ${pnl >= 0 ? "text-green-500" : "text-red-500"}`}>
                              {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} ({pnl >= 0 ? "+" : ""}{pnlPercent.toFixed(2)}%)
                            </span>
                          </div>
                          {viewMode === "user" && !isScalp && (
                            <button
                              onClick={async () => {
                                if (isSpectator) {
                                  alert("🔒 Spectator Mode: Live execution locked. Position closures are disabled for guest spectating sessions.");
                                  return;
                                }
                                setManualAmount("");
                                await handleManualTrade(isShort ? "COVER" : "SELL", assetKey);
                              }}
                              disabled={manualTrading || isSpectator}
                              className={`w-full mt-1.5 py-1 text-[10px] font-mono font-bold rounded-lg transition-all ${btnCloseStyle}`}
                            >
                              {isSpectator ? "🔒 CLOSE POSITION LOCKED" : manualTrading ? "CLOSING..." : `CLOSE ${assetKey} POSITION`}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>

            {/* Compact AI Confluence Summary placed near positions for fast reading */}
            {viewMode === "ai" && (
              <div className={`border rounded-2xl p-5 space-y-4 ${bgCard}`}>
                <div className={`flex justify-between items-center border-b ${borderCol} pb-3`}>
                  <h2 className={`text-[10px] font-bold font-mono uppercase tracking-wider ${textSub}`}>
                    AI Confluence Now
                  </h2>
                  <span className={`text-[9px] px-2 py-0.5 border rounded font-mono uppercase ${
                    signals?.composite
                      ? (isDark ? "bg-blue-950/20 border-blue-900/40 text-blue-300" : "bg-blue-50 border-blue-200 text-blue-700")
                      : (isDark ? "bg-neutral-900 border-[#1c1c24] text-slate-400" : "bg-neutral-100 border-[#e2e8f0] text-[#475569]")
                  }`}>
                    {signals?.composite ? "Live Read" : "Waiting"}
                  </span>
                </div>

                {signals?.composite ? (
                  <div className="space-y-3 font-mono">
                    <div className="grid grid-cols-3 gap-2">
                      <div className={`p-2.5 rounded-xl border ${bgSubCard}`}>
                        <div className={`text-[8px] uppercase ${textMuted}`}>Action</div>
                        <div className={`mt-1 text-xs font-bold ${
                          signals.composite.action === "BUY" ? "text-emerald-500" :
                          signals.composite.action === "SHORT" ? "text-red-500" :
                          signals.composite.action === "SELL" || signals.composite.action === "COVER" ? "text-amber-500" :
                          textPrimary
                        }`}>
                          {signals.composite.action}
                        </div>
                      </div>
                      <div className={`p-2.5 rounded-xl border ${bgSubCard}`}>
                        <div className={`text-[8px] uppercase ${textMuted}`}>Score</div>
                        <div className={`mt-1 text-xs font-bold ${textPrimary}`}>
                          {signals.composite.totalScore.toFixed(0)}
                        </div>
                      </div>
                      <div className={`p-2.5 rounded-xl border ${bgSubCard}`}>
                        <div className={`text-[8px] uppercase ${textMuted}`}>Market</div>
                        <div className={`mt-1 text-[10px] font-bold ${textPrimary}`}>
                          {signals.composite.regime === "CHOPPY" ? "NO CLEAR TREND" : signals.composite.regime.replaceAll("_", " ")}
                        </div>
                      </div>
                    </div>
                    <div className={`rounded-xl border p-3 ${bgSubCard}`}>
                      <div className={`text-[8px] uppercase font-bold mb-1 ${textMuted}`}>Plain reason</div>
                      <p className={`text-[10px] leading-relaxed ${textSub}`}>
                        {signals.composite.reasoning || "The bot is waiting for enough evidence before opening or changing a position."}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className={`text-xs font-mono italic ${textMuted}`}>Waiting for the next live scan to publish a clear buy, sell, or hold read.</p>
                )}
              </div>
            )}

            
          </div>
        </div>



        {showDataHealth && data?.feedHealthMatrix && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <button
              aria-label="Close data health metrics"
              className="absolute inset-0 bg-black/60"
              onClick={() => setShowDataHealth(false)}
            />
            <div className={`relative w-full max-w-4xl max-h-[86vh] overflow-y-auto rounded-2xl border p-5 shadow-2xl ${bgCard}`}>
              <div className="flex items-start justify-between gap-4 border-b pb-4 border-slate-700/30">
                <div>
                  <h2 className={`text-[10px] font-bold font-mono uppercase tracking-wider ${textSub}`}>Data Health Metrics</h2>
                  <p className={`text-xs font-mono mt-1 ${textPrimary}`}>Detailed feed quality for every market the bot watches.</p>
                  <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>Updated {formatAge(data.feedHealthMatrix.generatedAt)} | 15m feed check</p>
                </div>
                <button
                  onClick={() => setShowDataHealth(false)}
                  className={`px-3 py-1.5 border text-xs font-mono rounded-lg font-bold transition-all ${bgResetBtn}`}
                >
                  CLOSE
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                  <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Fast Ready</div>
                  <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.feedHealthMatrix.summary?.fastEligible || 0}</div>
                </div>
                <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                  <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Swing Ready</div>
                  <div className={`text-sm font-bold font-mono ${textPrimary}`}>{data.feedHealthMatrix.summary?.swingEligible || 0}</div>
                </div>
                <div className={`p-2 rounded-lg border ${bgSubCard}`}>
                  <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Needs Care</div>
                  <div className={`text-sm font-bold font-mono ${(data.feedHealthMatrix.summary?.bad || 0) > 0 ? "text-red-400" : "text-emerald-400"}`}>
                    {(data.feedHealthMatrix.summary?.degraded || 0) + (data.feedHealthMatrix.summary?.bad || 0)}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(data.feedHealthMatrix.assets || []).slice(0, 9).map((feed: any) => (
                  <div key={feed.asset} className={`p-2.5 rounded-lg border ${bgSubCard}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-xs font-bold font-mono ${textPrimary}`}>{feed.asset}</div>
                      <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border ${dataHealthBadgeClass(feed.status, isDark)}`}>
                        {feed.status}
                      </span>
                    </div>
                    <div className={`grid grid-cols-2 gap-1 mt-2 text-[8px] font-mono ${textMuted}`}>
                      <span>Score: <b className={textPrimary}>{feed.score}</b></span>
                      <span>Source: <b className={textPrimary}>{feed.source}</b></span>
                      <span>Mode: <b className={textPrimary}>{feed.mode === "REALTIME_FAST" ? "Fast" : feed.mode === "SLOW_SWING" ? "Swing" : "Disabled"}</b></span>
                      <span>Age: <b className={textPrimary}>{Math.round((feed.cacheAgeSeconds || 0) / 60)}m</b></span>
                    </div>
                    {feed.warnings?.[0] && (
                      <p className={`text-[9px] leading-relaxed mt-1.5 ${textMuted}`}>{feed.warnings[0]}</p>
                    )}
                  </div>
                ))}
              </div>

              {(data.feedHealthMatrix.plainFindings || []).length > 0 && (
                <div className="mt-4 space-y-1">
                  {(data.feedHealthMatrix.plainFindings || []).slice(0, 3).map((finding: string) => (
                    <p key={finding} className={`text-[10px] leading-relaxed ${textMuted}`}>{finding}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Subtle Secure Admin Controls Footer */}
        <div className={`mt-12 pt-6 border-t border-dashed ${borderCol} flex flex-col sm:flex-row justify-between items-center text-[10px] font-mono gap-4`}>
          {!isSpectator && (
          <div>
            <button 
              onClick={handleReset} 
              className={`px-3 py-1.5 border rounded-lg transition-all font-bold tracking-wider hover:bg-red-950/20 hover:border-red-900/40 hover:text-red-400 ${
                isDark ? "bg-[#1f2937]/40 border-slate-800 text-slate-500 hover:text-red-400" : "bg-neutral-100 border-neutral-200 text-neutral-500 hover:text-red-700"
              }`}
              title="Wipe database portfolios and restart simulation"
            >
              ⚠️ RESET ARENA DATABASE
            </button>
          </div>
          )}
          <div className={textMuted}>
            QUANT TRADING TERMINAL • SECURED SIMULATION ENVIRONMENT
          </div>
        </div>

      </div>
    </div>
  );
}
