"use client";

import { useEffect, useState } from "react";
import { benchmarkRows } from "@/lib/ui/dashboardLabels";

/** Does the bot beat doing something simple? Same start, same capital, same costs. */
export interface BenchmarksResponse {
  startAt: string;
  computedAt: string;
  equalWeightHold: { returnPercent: number; maxDrawdownPercent: number; days: number };
  trendDaily: {
    returnPercent: number; maxDrawdownPercent: number; days: number; mode: string; registeredAt: string;
    forwardEvidence: { passed: boolean; reasons: string[]; metrics: { periods: number } };
  };
  bot: { swingReturnPercent: number | null; crossSectionalReturnPercent: number | null };
  note: string;
  error?: string;
}

export default function Benchmarks({ isDark }: { isDark: boolean }) {
  const [data, setData] = useState<BenchmarksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await (await fetch("/api/benchmarks", { cache: "no-store" })).json();
        if (cancelled) return;
        if (payload.error) setError(payload.error);
        else { setData(payload); setError(null); }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Benchmarks unavailable");
      }
    };
    load();
    const timer = setInterval(load, 10 * 60_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const bgCard = isDark ? "bg-[#0d0d12] border-[#1f2937]" : "bg-white border-[#e2e8f0]";
  const textMuted = isDark ? "text-slate-400" : "text-[#475569]";
  const textPrimary = isDark ? "text-[#f8fafc]" : "text-[#0f172a]";
  const tone = (v: number | null) => v === null ? textMuted : v >= 0 ? (isDark ? "text-emerald-300" : "text-emerald-700") : (isDark ? "text-rose-300" : "text-rose-700");

  return (
    <div className={`p-4 rounded-xl border ${bgCard}`}>
      <div className={`text-[9px] font-bold font-mono ${textMuted} uppercase tracking-wider`}>Benchmarks</div>
      {error && <p className={`text-xs font-mono mt-2 ${textMuted}`}>Benchmarks unavailable: {error}</p>}
      {!error && !data && <p className={`text-xs font-mono mt-2 ${textMuted}`}>Loading…</p>}
      {data && (
        <>
          <p className={`text-[9px] font-mono mt-1 ${textMuted}`}>Since {data.startAt.slice(0, 10)}, $10,000 each, net of taker fees and funding.</p>
          <div className="mt-2 space-y-1">
            {benchmarkRows(data).map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3">
                <span className={`text-xs font-mono ${textPrimary}`}>{row.label}</span>
                <span className={`text-xs font-mono font-bold ${tone(row.returnPercent)}`}>{row.value}</span>
              </div>
            ))}
          </div>
          <p className={`text-[9px] font-mono mt-2 ${textMuted}`}>
            Trend baseline is a shadow strategy: {data.trendDaily.forwardEvidence.metrics.periods} forward day(s) since {data.trendDaily.registeredAt.slice(0, 10)};
            {data.trendDaily.forwardEvidence.passed ? " its evidence gate has passed." : " it needs 30 days and a positive lower bound before its evidence gate passes."}
          </p>
        </>
      )}
    </div>
  );
}
