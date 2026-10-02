/**
 * Plain-language labels the dashboard shows, kept pure so their wording can
 * be tested against the states that used to be mislabeled.
*/

/** Approval is a ceiling; the frozen initial stop risk is what was taken. */
export function entryRiskUsage(position: { riskAmountUsd?: number; initialRiskUsdt?: number }) {
  const approvedUsdt = Number.isFinite(position.riskAmountUsd) && position.riskAmountUsd! > 0 ? position.riskAmountUsd! : null;
  const takenUsdt = Number.isFinite(position.initialRiskUsdt) && position.initialRiskUsdt! >= 0 ? position.initialRiskUsdt! : null;
  return { approvedUsdt, takenUsdt,
    utilizationPercent: approvedUsdt !== null && takenUsdt !== null ? takenUsdt / approvedUsdt * 100 : null };
}

export function emptyBookMessage(input: { totalRebalances: number; riskState?: string | null }): string {
  if (input.totalRebalances === 0) return "No book yet. The daemon opens one at its first rebalance.";
  const state = input.riskState && input.riskState !== "ACTIVE" ? ` while it is in ${input.riskState}` : "";
  return `The book is flat: it holds no positions${state}.`;
}

export function describeLastBookAction(last: {
  at?: string;
  executed?: number;
  turnover?: number;
  universeSize?: number;
  reason?: string;
}): { title: string; detail: string } {
  const fills = `${last.executed ?? 0} fills`;
  const turnover = `${((last.turnover ?? 0) * 100).toFixed(1)}% turnover`;
  if (/REDUCE_ONLY|unwind/i.test(last.reason ?? "")) {
    return { title: "Last unwind step", detail: `${fills} · ${turnover} · reductions only, no new ranking` };
  }
  return { title: "Last rebalance", detail: `${fills} · ${turnover} · ranked ${last.universeSize ?? 0} markets` };
}

/**
 * The swing tile reports completed positions, like the statistics panel, so
 * the page never shows two different win rates for one account. Exit legs
 * (partial exits counted separately) are named as such.
 */
export function swingWinRateTile(
  positions: { totalTrades: number; winningTrades: number; totalPnl: number; exitLegs?: number } | null | undefined,
  legs: { trades: number; wins: number; pnl: number } | null | undefined
): { winRateText: string; pnl: number; countText: string } {
  const total = positions?.totalTrades ?? 0;
  const winRate = total > 0 ? ((positions!.winningTrades / total) * 100).toFixed(1) : "0.0";
  const exitLegs = positions?.exitLegs ?? legs?.trades ?? 0;
  return {
    winRateText: `${winRate}%`,
    pnl: positions?.totalPnl ?? legs?.pnl ?? 0,
    countText: `${total} positions · ${exitLegs} exit legs`,
  };
}

export function rebalanceScheduleNote(
  schedule: { lastAtMs: number | null; nextDueAtMs: number | null; overdue: boolean } | null | undefined,
  nowMs = Date.now()
): string | null {
  if (!schedule || !schedule.overdue) return null;
  if (schedule.nextDueAtMs === null) return "No rebalance has been recorded yet.";
  const hours = Math.floor((nowMs - schedule.nextDueAtMs) / 3_600_000);
  return `Rebalance overdue by ${hours}h: the daemon has not completed its scheduled pass.`;
}
