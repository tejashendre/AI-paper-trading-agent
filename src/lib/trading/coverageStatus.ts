import type { Trade } from "@/lib/types";
import type { PerpTicker } from "@/lib/data/perpUniverse";
import type { BookPortfolio } from "@/lib/execution/bookRebalancer";
import type { CompletedPositionOutcome } from "@/lib/trading/positionOutcomes";
import { CONFIGURED_ASSETS, CONFIGURED_INSTRUMENTS, ConfiguredAsset, getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";
import { feeScheduleFor } from "@/lib/trading/assetSpecs";

/**
 * Per-asset coverage: whether each configured asset's data is ready, whether
 * the strategy produced a candidate, and which check stopped it. A healthy
 * feed is one fact among several; it never means "this asset can trade".
 */

/** The first check that stopped a scan decision. Text follows as "CODE: explanation". */
export type VetoCode =
  | "ACTIVE_POSITION"
  | "COOLDOWN"
  | "MIGRATION_CONFLICT"
  | "SESSION_CLOSED"
  | "EVENT_BLACKOUT"
  | "FEED_UNHEALTHY"
  | "OFF_PEAK_CONVICTION"
  | "SIGNAL_UNAVAILABLE"
  | "NO_SETUP"
  | "DATA_NOT_ELIGIBLE"
  | "WARMING_UP"
  | "PORTFOLIO_GUARD"
  | "INVALID_STOP"
  | "ADMISSION"
  | "LEARNING"
  | "IDENTITY"
  | "LIQUIDITY"
  | "VENUE_SIZE"
  | "EXECUTION_COST"
  | "PORTFOLIO_RISK_BUDGET"
  | "ERROR";

export const FUNNEL_STAGES = ["closedBars", "evaluations", "candidates", "provenancePass", "costPass", "riskPass", "fills"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const THROUGH_PROVENANCE: FunnelStage[] = ["closedBars", "evaluations", "candidates", "provenancePass"];
const STAGES_BY_VETO: Record<VetoCode, FunnelStage[]> = {
  ACTIVE_POSITION: [],
  COOLDOWN: [],
  MIGRATION_CONFLICT: [],
  SESSION_CLOSED: [],
  EVENT_BLACKOUT: [],
  FEED_UNHEALTHY: [],
  OFF_PEAK_CONVICTION: ["closedBars", "evaluations", "candidates"],
  SIGNAL_UNAVAILABLE: [],
  ERROR: [],
  NO_SETUP: ["closedBars", "evaluations"],
  WARMING_UP: ["evaluations", "candidates"],
  DATA_NOT_ELIGIBLE: ["closedBars", "evaluations", "candidates"],
  PORTFOLIO_GUARD: THROUGH_PROVENANCE,
  INVALID_STOP: THROUGH_PROVENANCE,
  ADMISSION: THROUGH_PROVENANCE,
  LEARNING: THROUGH_PROVENANCE,
  IDENTITY: THROUGH_PROVENANCE,
  LIQUIDITY: THROUGH_PROVENANCE,
  VENUE_SIZE: THROUGH_PROVENANCE,
  EXECUTION_COST: THROUGH_PROVENANCE,
  PORTFOLIO_RISK_BUDGET: [...THROUGH_PROVENANCE, "costPass"],
};
const DATA_VETOES = new Set<VetoCode>(["DATA_NOT_ELIGIBLE", "WARMING_UP", "SIGNAL_UNAVAILABLE", "FEED_UNHEALTHY"]);
const COST_VETOES = new Set<VetoCode>(["LIQUIDITY", "VENUE_SIZE", "EXECUTION_COST"]);
const RISK_VETOES = new Set<VetoCode>(["PORTFOLIO_GUARD", "INVALID_STOP", "ADMISSION", "LEARNING", "IDENTITY", "PORTFOLIO_RISK_BUDGET", "MIGRATION_CONFLICT"]);

/** One asset's outcome in one scan; recorded once per decision id. */
export interface ScanDecision {
  decisionId: string;
  asset: string;
  at: string;
  action: string;
  vetoCode?: VetoCode | null;
  reason: string;
}

export function stagesReached(decision: ScanDecision): FunnelStage[] {
  if (decision.action === "ENTRY") return [...FUNNEL_STAGES];
  return STAGES_BY_VETO[decision.vetoCode ?? "ERROR"] ?? [];
}

export interface DailyFunnel {
  day: string;
  counts: Record<FunnelStage, number>;
  vetoes: Record<string, number>;
  decisionIds: string[];
}

const emptyCounts = (): Record<FunnelStage, number> =>
  Object.fromEntries(FUNNEL_STAGES.map((stage) => [stage, 0])) as Record<FunnelStage, number>;

/** Add a decision to its day. A decision id already counted is ignored, so retries never inflate a funnel. */
export function recordFunnelDecision(days: DailyFunnel[], decision: ScanDecision, keepDays = 31): DailyFunnel[] {
  const day = decision.at.slice(0, 10);
  const next = days.map((entry) => ({ ...entry, counts: { ...entry.counts }, vetoes: { ...entry.vetoes }, decisionIds: [...entry.decisionIds] }));
  let target = next.find((entry) => entry.day === day);
  if (!target) {
    target = { day, counts: emptyCounts(), vetoes: {}, decisionIds: [] };
    next.push(target);
  }
  if (target.decisionIds.includes(decision.decisionId)) return days;
  target.decisionIds.push(decision.decisionId);
  for (const stage of stagesReached(decision)) target.counts[stage] += 1;
  if (decision.action !== "ENTRY" && decision.vetoCode) {
    target.vetoes[decision.vetoCode] = (target.vetoes[decision.vetoCode] ?? 0) + 1;
  }
  // Retries happen within the same day, so only today's ids are kept.
  for (const entry of next) if (entry.day !== day) entry.decisionIds = [];
  return next.sort((a, b) => a.day.localeCompare(b.day)).slice(-keepDays);
}

/** Stage counts and veto counts ("veto:CODE") over the last `windowDays` days. */
export function summarizeFunnel(days: DailyFunnel[], windowDays: number, nowMs: number): Record<string, number> {
  const since = new Date(nowMs - (windowDays - 1) * 86_400_000).toISOString().slice(0, 10);
  const summary: Record<string, number> = emptyCounts();
  for (const entry of days.filter((day) => day.day >= since)) {
    for (const stage of FUNNEL_STAGES) summary[stage] += entry.counts[stage] ?? 0;
    for (const [code, count] of Object.entries(entry.vetoes)) summary[`veto:${code}`] = (summary[`veto:${code}`] ?? 0) + count;
  }
  return summary;
}

export interface AssetCoverageStatus {
  asset: ConfiguredAsset;
  symbol: string;
  dataReady: boolean;
  strategyReady: boolean;
  entryPathReady: boolean;
  costReady: boolean;
  riskAllowed: boolean;
  learningStatus: string;
  /** The first check that stopped the latest decision, as "CODE: explanation". */
  primaryVeto: string | null;
  secondaryReasons: string[];
  /** Required history still missing; this blocks entries. */
  intradayWarmUp: string[];
  /** Optional features that are unavailable; these do not block entries. */
  limitations: string[];
  quoteAgeMs: number | null;
  lastEvaluatedAt: string | null;
  lastFillAt: string | null;
  completedPositions: number;
  /** Cash from every exit leg, partials included. Not a count of positions. */
  realizedCashFromExitLegs: number;
  funnel7d: Record<string, number>;
  funnel30d: Record<string, number>;
  /** Plain-language facts about the instrument and the evidence behind it. */
  notes: string[];
}

export interface AssetCoverageInput {
  dataEligibility?: { allowed: boolean; state: string; reasons: string[] } | null;
  quoteEventTimeMs?: number | null;
  lastDecision?: ScanDecision | null;
  fundingIntervalMinutes?: number | null;
}

const RESEARCH_MINIMUM_POSITIONS = 30;

function notesFor(asset: ConfiguredAsset, completedPositions: number, fundingIntervalMinutes?: number | null): string[] {
  const instrument = getConfiguredInstrument(asset);
  const notes = [
    `Settles in USDT on Bybit's ${instrument.symbol} perpetual. Prices, history and fills all come from this one venue, so there is no second venue to cross-check a bad print.`,
    "Signals read completed 4-hour and weekly bars only; the bar still forming is ignored.",
  ];
  if (asset === "OIL") notes.push("OIL tracks WTI crude (CLUSDT), not Brent.");
  if (CONFIGURED_INSTRUMENTS[asset].riskClass !== "crypto") {
    notes.push("The contract trades around the clock, but the underlying market closes at weekends, when liquidity is thin.");
  }
  const fees = feeScheduleFor(instrument);
  if (fees.status === "UNVERIFIED_STRESS_RATE") {
    notes.push("Bybit has not confirmed the fee schedule for this FX contract, so a higher stress fee is assumed and its results cannot be promoted.");
  }
  if (fundingIntervalMinutes) notes.push(`Funding is exchanged every ${fundingIntervalMinutes / 60} hours at the venue's published settlements.`);
  if (completedPositions < RESEARCH_MINIMUM_POSITIONS) {
    notes.push(`${completedPositions} completed position(s): too few to judge whether this asset has an edge.`);
  }
  return notes;
}

export function buildCoverageSnapshot(input: {
  nowMs: number;
  assets: Partial<Record<string, AssetCoverageInput>>;
  outcomes: CompletedPositionOutcome[];
  trades: Trade[];
  funnels: Partial<Record<string, DailyFunnel[]>>;
}): AssetCoverageStatus[] {
  return CONFIGURED_ASSETS.map((asset) => {
    const row = input.assets[asset] ?? {};
    const eligibility = row.dataEligibility ?? null;
    const decision = row.lastDecision ?? null;
    const veto = decision && decision.action !== "ENTRY" ? decision.vetoCode ?? "ERROR" : null;
    const stages = decision ? stagesReached(decision) : [];
    const completed = input.outcomes.filter((outcome) => outcome.asset === asset);
    const exitLegs = input.trades.filter((trade) => trade.asset === asset && typeof trade.pnl === "number");
    const fills = input.trades
      .filter((trade) => trade.asset === asset && !/SELL|COVER/.test(trade.action))
      .map((trade) => trade.timestamp)
      .sort();
    const reasons = eligibility?.reasons ?? [];
    const dataReady = Boolean(eligibility?.allowed);
    const primaryVeto = !eligibility
      ? "DATA_NOT_ELIGIBLE: no data decision for this asset (its inputs could not be read)"
      : veto
        ? `${veto}: ${decision!.reason}`
        : !dataReady
          ? `DATA_NOT_ELIGIBLE: ${reasons[0] ?? eligibility.state}`
          : null;
    const funnelDays = input.funnels[asset] ?? [];
    return {
      asset,
      symbol: getConfiguredInstrument(asset).symbol,
      dataReady,
      strategyReady: Boolean(decision) && stages.includes("candidates"),
      entryPathReady: dataReady && stages.includes("provenancePass"),
      costReady: Boolean(decision) && !(veto && COST_VETOES.has(veto)) && stages.includes("provenancePass"),
      riskAllowed: Boolean(decision) && !(veto && (RISK_VETOES.has(veto) || DATA_VETOES.has(veto))),
      learningStatus: veto === "LEARNING"
        ? "Learning is restricting this asset after its recent outcomes."
        : `${completed.length} completed position(s) feed learning for this asset.`,
      primaryVeto,
      secondaryReasons: reasons.filter((reason) => !primaryVeto?.includes(reason)),
      intradayWarmUp: reasons.filter((reason) => reason.startsWith("WARMING_UP_")),
      limitations: reasons.filter((reason) => reason.startsWith("WEEKLY_FEATURE_UNAVAILABLE")),
      quoteAgeMs: row.quoteEventTimeMs ? Math.max(0, input.nowMs - row.quoteEventTimeMs) : null,
      lastEvaluatedAt: decision?.at ?? null,
      lastFillAt: fills[fills.length - 1] ?? null,
      completedPositions: completed.length,
      realizedCashFromExitLegs: exitLegs.reduce((sum, trade) => sum + Number(trade.pnl), 0),
      funnel7d: summarizeFunnel(funnelDays, 7, input.nowMs),
      funnel30d: summarizeFunnel(funnelDays, 30, input.nowMs),
      notes: notesFor(asset, completed.length, row.fundingIntervalMinutes),
    };
  });
}

/** What a halted or reducing book is doing, for the dashboard. */
export function describeBookRisk(input: {
  portfolio: BookPortfolio;
  prices: Map<string, PerpTicker>;
  edgeVerdict: string | null;
  edgeReviewedAt: string | null;
}) {
  const { portfolio, prices } = input;
  const positions = Object.values(portfolio.positions);
  let unrealized = 0;
  let grossExposureUsdt = 0;
  for (const position of positions) {
    const mark = prices.get(position.symbol)?.markPrice;
    const price = Number.isFinite(mark) && mark ? mark : position.entryPrice;
    unrealized += position.quantity * (price - position.entryPrice);
    grossExposureUsdt += Math.abs(position.quantity) * price;
  }
  const equity = portfolio.cashUsd + unrealized;
  return {
    state: portfolio.riskState?.state ?? "ACTIVE",
    reasons: portfolio.riskState?.reasons ?? [],
    openPositions: positions.length,
    grossExposureUsdt,
    currentDrawdownPercent: portfolio.peakEquityUsd > 0 ? Math.max(0, ((portfolio.peakEquityUsd - equity) / portfolio.peakEquityUsd) * 100) : 0,
    lifetimeMaxDrawdownPercent: portfolio.maxDrawdownPercent,
    lastUnwind: portfolio.riskState?.lastUnwind ?? null,
    edgeVerdict: input.edgeVerdict,
    edgeReviewedAt: input.edgeReviewedAt,
  };
}

/** Forward evidence from the capital-free shadow book. Never live profit. */
export function describeShadowEvidence(shadow: BookPortfolio | null, prices: Map<string, PerpTicker>) {
  const positions = Object.values(shadow?.positions ?? {});
  const unrealized = positions.reduce((sum, position) => {
    const mark = prices.get(position.symbol)?.markPrice;
    return sum + (Number.isFinite(mark) && mark ? position.quantity * (mark - position.entryPrice) : 0);
  }, 0);
  return {
    label: "SHADOW_ONLY" as const,
    liveCapital: false as const,
    explanation: "Hypothetical trades on a book with no capital, kept while the live book is halted. They show whether the strategy would have worked; they are not profit.",
    fills: shadow?.totalFills ?? 0,
    rebalances: shadow?.totalRebalances ?? 0,
    openPositions: positions.length,
    feesUsdt: shadow?.feesPaidUsd ?? 0,
    fundingUsdt: shadow?.fundingPaidUsd ?? 0,
    hypotheticalRealizedPnlUsdt: shadow?.realizedPnlUsd ?? 0,
    hypotheticalUnrealizedPnlUsdt: unrealized,
  };
}
