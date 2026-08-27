"use client";

import { useEffect, useState } from "react";

/**
 * Live view of the cross-sectional momentum book.
 *
 * This is the strategy that carries the measured edge, so the panel leads with
 * the numbers that show whether it is working — return, drawdown, and how
 * neutral the book actually is — rather than with decoration.
 */

interface BookPosition {
  symbol: string;
  side: "LONG" | "SHORT";
  quantity: number;
  entryPrice: number;
  markPrice: number;
  notionalUsd: number;
  unrealizedUsd: number;
  unrealizedPercent: number;
}

interface CostVerdict {
  sampleSize: number;
  totalRatio: number | null;
  modelTotalBps: number;
  observedTotalBps: number;
  verdict: "INSUFFICIENT_DATA" | "MODEL_HONEST" | "MODEL_OPTIMISTIC" | "MODEL_CONSERVATIVE";
  message: string;
}

interface EdgeCheck {
  verdict: "INSUFFICIENT_DATA" | "NO_ESTABLISHED_EDGE" | "EDGE_STABLE" | "EDGE_WEAKENING" | "EDGE_GONE";
  explanation: string;
  baselineMeanBps: number;
  recentMeanBps: number;
  retentionRatio: number | null;
  windowPeriods: number;
  windowsAnalysed: number;
  periodsRecorded: number;
  shouldHalt: boolean;
}

interface Capacity {
  capacityUsd: number;
  bindingSymbol: string | null;
  bindingTurnoverUsd: number;
  utilisation: number;
  participationLimit: number;
  namesAssessed: number;
  explanation: string;
}

interface BookResponse {
  strategy: { name: string; version: string; lookbackHours: number; holdHours: number; bookSize: number; rankBuffer: number; universeCap: number };
  performance: {
    equityUsd: number; initialCapitalUsd: number; totalReturnUsd: number; totalReturnPercent: number;
    realizedPnlUsd: number; unrealizedPnlUsd: number; feesPaidUsd: number; fundingPaidUsd: number;
    maxDrawdownPercent: number; totalRebalances: number; totalFills: number;
  };
  exposure: { openPositions: number; longs: number; shorts: number; grossExposure: number; netExposure: number };
  positions: BookPosition[];
  lastRebalance: { at?: string; turnover?: number; executed?: number; reason?: string; universeSize?: number } | null;
  costModel: CostVerdict | null;
  edgeCheck: EdgeCheck | null;
  capacity: Capacity | null;
  error?: string;
}

export default function CrossSectionalBook({ isDark, plainLanguage = false }: { isDark: boolean; plainLanguage?: boolean }) {
  const [data, setData] = useState<BookResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/book", { cache: "no-store" });
        const payload = await response.json();
        if (cancelled) return;
        if (payload.error) { setError(payload.error); return; }
        setData(payload);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load book");
      }
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const bgCard = isDark ? "bg-[#0d0d12] border-[#1f2937]" : "bg-white border-[#e2e8f0]";
  const bgSub = isDark ? "bg-[#12121a] border-[#1f2937]" : "bg-[#f8fafc] border-[#e2e8f0]";
  const textMuted = isDark ? "text-slate-400" : "text-[#475569]";
  const textPrimary = isDark ? "text-[#f8fafc]" : "text-[#0f172a]";
  const border = isDark ? "border-[#1f2937]" : "border-[#e2e8f0]";

  if (error) {
    return (
      <div className={`p-4 rounded-xl border ${bgCard}`}>
        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Cross-Sectional Book</div>
        <p className={`text-xs font-mono mt-2 ${textMuted}`}>Book unavailable: {error}</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`p-4 rounded-xl border ${bgCard}`}>
        <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Cross-Sectional Book</div>
        <p className={`text-xs font-mono mt-2 ${textMuted}`}>Loading…</p>
      </div>
    );
  }

  const { strategy, performance, exposure, positions, lastRebalance } = data;
  const positive = performance.totalReturnUsd >= 0;
  const money = (v: number) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  // Capacity figures span thousands to billions, so they are abbreviated
  // rather than printed in full; an exact dollar is meaningless on an estimate.
  const usd = (v: number) => {
    if (!Number.isFinite(v)) return "no limit";
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
    return `$${v.toFixed(0)}`;
  };
  const longs = positions.filter((p) => p.side === "LONG");
  const shorts = positions.filter((p) => p.side === "SHORT");
  const shown = expanded ? positions : positions.slice(0, 6);

  return (
    <div className={`p-4 rounded-xl border ${bgCard}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Cross-Sectional Book</div>
          {plainLanguage ? (
            <>
              <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                Every {strategy.holdHours} hours the bot scores up to {strategy.universeCap} crypto markets on how
                much they moved in the last {strategy.lookbackHours} hours. It buys the {strategy.bookSize} strongest
                and bets against the {strategy.bookSize} weakest.
              </p>
              <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                Because it buys and sells the same amount of money, it can profit whether crypto goes up or down —
                what matters is whether the strong keep beating the weak.
              </p>
            </>
          ) : (
            <>
              <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
                Long the {strategy.bookSize} strongest perps, short the {strategy.bookSize} weakest, dollar-neutral.
              </p>
              <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
                {strategy.lookbackHours}h momentum · rebalanced every {strategy.holdHours}h · ranked from up to {strategy.universeCap} markets
              </p>
            </>
          )}
        </div>
        <span className={`text-[8px] font-mono font-bold px-2 py-0.5 rounded border whitespace-nowrap ${
          isDark ? "border-emerald-900/40 text-emerald-300 bg-emerald-950/20" : "border-emerald-200 text-emerald-700 bg-emerald-50"
        }`}>
          {exposure.openPositions > 0 ? "ACTIVE" : "FLAT"}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
        <div className={`p-2 rounded-lg border ${bgSub}`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Equity</div>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>${performance.equityUsd.toFixed(2)}</div>
        </div>
        <div className={`p-2 rounded-lg border ${bgSub}`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Net Return</div>
          <div className={`text-sm font-bold font-mono ${positive ? "text-emerald-400" : "text-rose-400"}`}>
            {performance.totalReturnPercent >= 0 ? "+" : ""}{performance.totalReturnPercent.toFixed(2)}%
          </div>
        </div>
        <div className={`p-2 rounded-lg border ${bgSub}`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Max Drawdown</div>
          <div className={`text-sm font-bold font-mono ${textPrimary}`}>{performance.maxDrawdownPercent.toFixed(2)}%</div>
        </div>
        <div className={`p-2 rounded-lg border ${bgSub}`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>{plainLanguage ? "Market Bet" : "Net Exposure"}</div>
          <div className={`text-sm font-bold font-mono ${Math.abs(exposure.netExposure) < 0.1 ? textPrimary : "text-amber-400"}`}>
            {(exposure.netExposure * 100).toFixed(1)}%
          </div>
          {plainLanguage && (
            <div className={`text-[7px] font-mono ${textMuted}`}>
              {Math.abs(exposure.netExposure) < 0.1 ? "balanced — not betting on direction" : "leaning one way"}
            </div>
          )}
        </div>
      </div>

      <div className={`flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[9px] font-mono ${textMuted}`}>
        <span>{exposure.longs}L / {exposure.shorts}S</span>
        <span>gross {exposure.grossExposure.toFixed(2)}x</span>
        <span>realised {money(performance.realizedPnlUsd)}</span>
        <span>open {money(performance.unrealizedPnlUsd)}</span>
        <span>fees ${performance.feesPaidUsd.toFixed(2)}</span>
        <span>funding {money(-performance.fundingPaidUsd)}</span>
        <span>{performance.totalRebalances} rebalances</span>
      </div>

      {data.costModel && (
        <div className={`mt-3 p-2 rounded-lg border ${
          data.costModel.verdict === "MODEL_OPTIMISTIC"
            ? (isDark ? "border-rose-900/50 bg-rose-950/20" : "border-rose-200 bg-rose-50")
            : data.costModel.verdict === "MODEL_HONEST"
              ? (isDark ? "border-emerald-900/40 bg-emerald-950/20" : "border-emerald-200 bg-emerald-50")
              : bgSub
        }`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>
            {plainLanguage ? "Are the cost estimates realistic?" : "Cost model reconciliation"}
          </div>
          <div className={`text-[10px] font-mono mt-0.5 ${textPrimary}`}>
            {plainLanguage
              ? (data.costModel.verdict === "INSUFFICIENT_DATA"
                  ? `Still measuring. ${data.costModel.sampleSize} trades checked so far.`
                  : data.costModel.verdict === "MODEL_HONEST"
                    ? "Yes. What trading actually costs matches what the bot assumed, so its past results can be trusted."
                    : data.costModel.verdict === "MODEL_OPTIMISTIC"
                      ? "No — trading is costing more than the bot assumed, so its past results look better than reality."
                      : "Trading is cheaper than the bot assumed, so its past results understate what it can do.")
              : data.costModel.message}
          </div>
          {data.costModel.totalRatio !== null && (
            <div className={`text-[9px] font-mono mt-1 ${textMuted}`}>
              observed {data.costModel.observedTotalBps.toFixed(1)}bps vs modelled {data.costModel.modelTotalBps.toFixed(1)}bps
              {" "}({data.costModel.totalRatio.toFixed(2)}x) · {data.costModel.sampleSize} fills measured
            </div>
          )}
        </div>
      )}

      {data.edgeCheck && (
        <div className={`mt-2 p-2 rounded-lg border ${
          data.edgeCheck.verdict === "EDGE_GONE"
            ? (isDark ? "border-rose-900/50 bg-rose-950/20" : "border-rose-200 bg-rose-50")
            : data.edgeCheck.verdict === "EDGE_WEAKENING"
              ? (isDark ? "border-amber-900/50 bg-amber-950/20" : "border-amber-200 bg-amber-50")
              : data.edgeCheck.verdict === "EDGE_STABLE"
                ? (isDark ? "border-emerald-900/40 bg-emerald-950/20" : "border-emerald-200 bg-emerald-50")
                : bgSub
        }`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>
            {plainLanguage ? "Is the strategy still working?" : "Rolling edge re-validation"}
          </div>
          <div className={`text-[10px] font-mono mt-0.5 ${textPrimary}`}>
            {plainLanguage
              ? (data.edgeCheck.verdict === "INSUFFICIENT_DATA"
                  ? `Too early to say. The bot needs about ${data.edgeCheck.windowPeriods * 2} trading rounds before it can judge itself; it has ${data.edgeCheck.periodsRecorded} so far.`
                  : data.edgeCheck.verdict === "NO_ESTABLISHED_EDGE"
                    ? "Not proven yet. The bot is making money and losing it in roughly the proportions luck alone would produce, so there is no demonstrated skill here to have gone missing. This is the honest reading, not a malfunction."
                    : data.edgeCheck.verdict === "EDGE_STABLE"
                      ? "Yes. Recent trading is earning about what it earned before, so nothing has stopped working."
                      : data.edgeCheck.verdict === "EDGE_WEAKENING"
                        ? "Partly. It is still making money, but noticeably less per trade than it used to. Worth watching."
                        : "No. Recent trading has turned loss-making after a stretch that worked, so the bot has stopped opening new positions on its own.")
              : data.edgeCheck.explanation}
          </div>
          <div className={`text-[9px] font-mono mt-1 ${textMuted}`}>
            recent {data.edgeCheck.recentMeanBps.toFixed(1)}bps vs baseline {data.edgeCheck.baselineMeanBps.toFixed(1)}bps
            {data.edgeCheck.retentionRatio !== null && ` (${(data.edgeCheck.retentionRatio * 100).toFixed(0)}% retained)`}
            {" "}· {data.edgeCheck.periodsRecorded} periods recorded
          </div>
        </div>
      )}

      {data.capacity && data.capacity.namesAssessed > 0 && (
        <div className={`mt-2 p-2 rounded-lg border ${bgSub}`}>
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>
            {plainLanguage ? "How much money could this actually handle?" : "Capacity"}
          </div>
          <div className={`text-[10px] font-mono mt-0.5 ${textPrimary}`}>
            {plainLanguage
              ? `About ${usd(data.capacity.capacityUsd)}. Past that, the bot's own orders would be too large a share of daily trading in ${data.capacity.bindingSymbol ?? "its thinnest holding"} and would move the price against it. Percentage returns only mean something below this line.`
              : data.capacity.explanation}
          </div>
          <div className={`text-[9px] font-mono mt-1 ${textMuted}`}>
            ceiling {usd(data.capacity.capacityUsd)} · using {(data.capacity.utilisation * 100).toFixed(2)}% of it ·
            {" "}capped by {data.capacity.bindingSymbol} at ${(data.capacity.bindingTurnoverUsd / 1e6).toFixed(1)}M/day
          </div>
        </div>
      )}

      {lastRebalance?.at && (
        <p className={`text-[9px] font-mono mt-2 ${textMuted}`}>
          Last rebalance {new Date(lastRebalance.at).toLocaleString()} · {lastRebalance.executed ?? 0} fills ·{" "}
          {((lastRebalance.turnover ?? 0) * 100).toFixed(1)}% turnover · ranked {lastRebalance.universeSize ?? 0} markets
        </p>
      )}

      {positions.length === 0 ? (
        <p className={`text-xs font-mono mt-3 ${textMuted}`}>
          No book yet. The daemon opens one at its first rebalance.
        </p>
      ) : (
        <>
          <div className={`grid grid-cols-2 gap-2 mt-3 pt-3 border-t ${border}`}>
            <div>
              <div className={`text-[8px] font-mono uppercase mb-1 text-emerald-400`}>Long {longs.length}</div>
              <div className={`text-[9px] font-mono leading-relaxed ${textMuted}`}>
                {longs.map((p) => p.symbol.replace("USDT", "")).join(" · ") || "—"}
              </div>
            </div>
            <div>
              <div className={`text-[8px] font-mono uppercase mb-1 text-rose-400`}>Short {shorts.length}</div>
              <div className={`text-[9px] font-mono leading-relaxed ${textMuted}`}>
                {shorts.map((p) => p.symbol.replace("USDT", "")).join(" · ") || "—"}
              </div>
            </div>
          </div>

          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[9px] font-mono">
              <thead>
                <tr className={textMuted}>
                  <th className="text-left font-normal pb-1">Market</th>
                  <th className="text-left font-normal pb-1">Side</th>
                  <th className="text-right font-normal pb-1">Notional</th>
                  <th className="text-right font-normal pb-1">Open P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.symbol} className={`border-t ${border}`}>
                    <td className={`py-1 ${textPrimary}`}>{p.symbol.replace("USDT", "")}</td>
                    <td className={p.side === "LONG" ? "text-emerald-400" : "text-rose-400"}>{p.side}</td>
                    <td className={`text-right ${textMuted}`}>${p.notionalUsd.toFixed(0)}</td>
                    <td className={`text-right ${p.unrealizedUsd >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {money(p.unrealizedUsd)} ({p.unrealizedPercent >= 0 ? "+" : ""}{p.unrealizedPercent.toFixed(1)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {positions.length > 6 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className={`mt-2 text-[9px] font-mono underline ${textMuted}`}
            >
              {expanded ? "Show fewer" : `Show all ${positions.length} positions`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
