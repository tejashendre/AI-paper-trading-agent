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
  error?: string;
}

export default function CrossSectionalBook({ isDark }: { isDark: boolean }) {
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
  const longs = positions.filter((p) => p.side === "LONG");
  const shorts = positions.filter((p) => p.side === "SHORT");
  const shown = expanded ? positions : positions.slice(0, 6);

  return (
    <div className={`p-4 rounded-xl border ${bgCard}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Cross-Sectional Book</div>
          <p className={`text-xs font-mono mt-1 ${textPrimary}`}>
            Long the {strategy.bookSize} strongest perps, short the {strategy.bookSize} weakest, dollar-neutral.
          </p>
          <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>
            {strategy.lookbackHours}h momentum · rebalanced every {strategy.holdHours}h · ranked from up to {strategy.universeCap} markets
          </p>
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
          <div className={`text-[7px] font-mono uppercase ${textMuted}`}>Net Exposure</div>
          <div className={`text-sm font-bold font-mono ${Math.abs(exposure.netExposure) < 0.1 ? textPrimary : "text-amber-400"}`}>
            {(exposure.netExposure * 100).toFixed(1)}%
          </div>
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
