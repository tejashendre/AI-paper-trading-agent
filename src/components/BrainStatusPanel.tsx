import React from 'react';

export function diagnosticMetric(value: unknown, digits = 2): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'Unavailable';
}

export interface BrainStatusView {
  mode: string;
  generatedAt: string | null;
  currentRun: { runId: string; startedAt: string; initialCapitalUsdt: number; archiveDigest: string | null } | null;
  account: { equityUsdt: number | null; cashUsdt: number | null; completedTrades: number | null; realizedPnlUsdt: number | null } | null;
  risk: { haltReasons: string[] };
  assets: { asset: string; strategyId: string; configHash: string; mode: string; riskTier: string | null;
    definition: { targetR: number; maxHoldDays: number; h4Warmup: number; dailyWarmup: number };
    evidence: { historicalCount: number | null; forwardCount: number | null; paperCount: number | null; reasons: string[]; nextEligibleAtMs: number | null };
    decision: { status: string | null; code: string | null; reason: string | null } | null }[];
}

export function BrainStatusPanel({ status, isDark }: { status: BrainStatusView | null; isDark: boolean }) {
  const card = isDark ? 'bg-[#0c0c10] border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-900';
  const sub = isDark ? 'text-slate-300' : 'text-slate-700';
  const border = isDark ? 'border-slate-700' : 'border-slate-300';
  return <section aria-labelledby="replacement-brain-heading" className={`border rounded-xl p-4 space-y-4 ${card}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 id="replacement-brain-heading" className="text-sm font-bold font-mono">Replacement swing brain v6</h2>
      <span className="text-xs font-bold font-mono">{status?.mode ?? 'Status unavailable'}</span>
    </div>
    <p className={`text-sm ${sub}`}>
      {status?.currentRun ? <>Current run: <strong>{status.currentRun.runId}</strong> since {status.currentRun.startedAt}.</> :
        'No current v6 run is verified. AI reset and release prerequisites remain required.'}
      {' '}One shared $10,000 AI book. The 10% drawdown stop applies to the initial capital and high-water equity.
      {' '}Initial risk is 0.25% ($25 at $10,000); 0.50% ($50) requires later evidence gates. SHADOW allocates no orders.
    </p>
    <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs font-mono">
      <div><dt className={sub}>Current marked equity</dt><dd className="mt-1 font-bold">{status?.account?.equityUsdt == null ? 'Unavailable' : `$${diagnosticMetric(status.account.equityUsdt)}`}</dd></div>
      <div><dt className={sub}>Current realized P&amp;L</dt><dd className="mt-1 font-bold">{status?.account?.realizedPnlUsdt == null ? 'Unavailable' : `$${diagnosticMetric(status.account.realizedPnlUsdt)}`}</dd></div>
      <div><dt className={sub}>Completed positions</dt><dd className="mt-1 font-bold">{status?.account?.completedTrades ?? 'Unavailable'}</dd></div>
      <div><dt className={sub}>Last runtime observation</dt><dd className="mt-1 break-words">{status?.generatedAt ?? 'Unavailable'}</dd></div>
    </dl>
    {status?.risk?.haltReasons?.length ? <p role="status" className="text-xs font-mono">Entry blockers: {status.risk.haltReasons.join('; ')}</p> : null}
    {status?.assets?.length ? <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <caption className={`text-left pb-3 ${sub}`}>Per-asset definitions and completed evidence counts. Unavailable means no verified current observation.</caption>
        <thead className="font-mono"><tr>{['Asset and definition', 'Mode', 'Historical / Forward / Paper', 'Decision and evidence blockers'].map(label => <th key={label} scope="col" className={`p-2 border-b ${border}`}>{label}</th>)}</tr></thead>
        <tbody>{status.assets.map(row => <tr key={row.asset} className={`align-top border-b ${border}`}>
          <th scope="row" className="p-2 min-w-48 font-normal"><strong>{row.asset}</strong><div className={`mt-1 ${sub}`}>{row.strategyId}</div>
            <div className={`mt-1 ${sub}`}>Target {row.definition.targetR}R; max {row.definition.maxHoldDays} days</div>
            <details className="mt-1"><summary className="cursor-pointer">Definition identity</summary><p className="mt-1 break-all font-mono">{row.configHash}</p>
              <p className="mt-1">Warmup: {row.definition.h4Warmup} H4 / {row.definition.dailyWarmup} daily bars</p></details></th>
          <td className="p-2 font-mono">{row.mode}<div className={`mt-1 ${sub}`}>{row.riskTier ?? 'Risk tier unavailable'}</div></td>
          <td className="p-2 font-mono">{[row.evidence.historicalCount, row.evidence.forwardCount, row.evidence.paperCount].map(x => x ?? 'Unavailable').join(' / ')}</td>
          <td className="p-2 min-w-48"><div>{row.decision?.code ?? row.decision?.status ?? 'Decision unavailable'}</div>
            {row.decision?.reason && <p className={`mt-1 ${sub}`}>{row.decision.reason}</p>}
            {row.evidence.reasons.length > 0 && <p className={`mt-1 ${sub}`}>{row.evidence.reasons.join('; ')}</p>}
            {row.evidence.nextEligibleAtMs !== null && <p className="mt-1">Next review: {new Date(row.evidence.nextEligibleAtMs).toISOString()}</p>}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="text-sm">Per-asset status unavailable.</p>}
    <p className={`text-xs ${sub}`}>Historical AI and XSEC results are separate from this run. XSEC has $0 allocated in v6 and receives no second $10,000 book. Missing metrics remain unavailable.</p>
    {status?.currentRun?.archiveDigest && <details className="text-xs"><summary className="cursor-pointer">Historical archive digest</summary><p className="mt-2 break-all font-mono">{status.currentRun.archiveDigest}</p></details>}
  </section>;
}
