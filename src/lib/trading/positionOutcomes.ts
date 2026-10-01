import crypto from "node:crypto";
import type { OpenPosition, Trade } from "@/lib/types";
import {
  ConfiguredAsset,
  InstrumentRef,
  isConfiguredAsset,
  legacyInstrument,
} from "@/lib/trading/instrumentRegistry";

/**
 * One economic result per completed position, built from its preserved legs
 * and shared by learning, trade review, research and reporting. Exit legs
 * are realized cash events; they are never independent trades.
 *
 * Trade.pnl on an exit leg is already net of that leg's share of the entry
 * fee, its exit fee and its carry or allocated funding, so the outcome sums
 * leg results and never subtracts fees a second time.
 */

export interface CompletedPositionOutcome {
  positionId: string;
  asset: ConfiguredAsset;
  instrument: InstrumentRef;
  direction: "LONG" | "SHORT";
  openedAtMs: number;
  closedAtMs: number;
  strategyVersion: string;
  setupFamily: string;
  regime: string;
  entryMode: string;
  configHash: string;
  dataSchemaVersion: string;
  costModelVersion: string;
  riskPolicyVersion: string;
  setupTags: string[];
  grossPnlUsdt: number;
  feesUsdt: number;
  /** Positive received. Legacy legs report their modeled carry here as a cost. */
  fundingCashflowUsdt: number;
  netPnlUsdt: number;
  /** Null when the position did not record its initial risk. */
  initialRiskUsdt: number | null;
  /** Null without initial-risk provenance; never estimated. */
  netR: number | null;
  returnOnInitialMargin: number;
  legIds: string[];
}

const isExitLeg = (trade: Trade) => /SELL|COVER/.test(trade.action) && typeof trade.pnl === "number";
const isEntryLeg = (trade: Trade) => !/SELL|COVER/.test(trade.action);

function legDirection(trade: Trade): "LONG" | "SHORT" {
  if (trade.direction) return trade.direction;
  return /SHORT|COVER/.test(trade.action) ? "SHORT" : "LONG";
}

/** Deterministic identity of a pre-upgrade position, from its recorded entry time. */
export function legacyPositionId(asset: string, direction: "LONG" | "SHORT", entryTime: string): string {
  const digest = crypto.createHash("sha256").update(`${asset}|${direction}|${entryTime}`).digest("hex");
  return `legacy:${digest.slice(0, 24)}`;
}

/** The position a leg belongs to, or null when it records no lineage. */
function lineageOf(trade: Trade): string | null {
  if (trade.positionId) return trade.positionId;
  if (trade.entryTime && isConfiguredAsset(trade.asset)) return legacyPositionId(trade.asset, legDirection(trade), trade.entryTime);
  return null;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const finite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return value !== undefined && value !== null && Number.isFinite(parsed) ? parsed : undefined;
};

export function buildPositionOutcomes(input: {
  trades: Trade[];
  openPositions: Array<Pick<OpenPosition, "asset" | "positionId"> & Partial<OpenPosition>>;
}): { completed: CompletedPositionOutcome[]; incompletePositionIds: string[]; conflicts: string[] } {
  const openIds = new Set(input.openPositions.map((pos) => pos.positionId).filter((id): id is string => Boolean(id)));
  const groups = new Map<string, Trade[]>();
  const seen = new Set<string>();
  const conflicts: string[] = [];

  for (const trade of input.trades) {
    if (seen.has(trade.id)) continue; // a replayed leg counts once
    seen.add(trade.id);
    const key = lineageOf(trade);
    if (!key) {
      if (isExitLeg(trade)) conflicts.push(`${trade.asset}: exit leg ${trade.id} has no positionId or entry time (missing lineage)`);
      continue;
    }
    groups.set(key, [...(groups.get(key) ?? []), trade]);
  }

  const completed: CompletedPositionOutcome[] = [];
  const incompletePositionIds: string[] = [];
  for (const [positionId, legs] of groups) {
    const exits = legs.filter(isExitLeg);
    const entries = legs.filter(isEntryLeg);
    const finals = exits.filter((leg) => !leg.isPartialExit);
    const asset = legs[0].asset;
    const reject = (reason: string) => conflicts.push(`${asset}: position ${positionId} ${reason}`);

    if (openIds.has(positionId)) {
      if (finals.length > 0) reject("has a final exit but is still open");
      else incompletePositionIds.push(positionId);
      continue;
    }
    if (finals.length === 0) {
      if (exits.length > 0) incompletePositionIds.push(positionId);
      continue;
    }
    if (finals.length > 1) {
      reject(`has ${finals.length} final exits`);
      continue;
    }
    const versions = new Set(legs.map((leg) => leg.instrument?.instrumentVersion).filter(Boolean));
    if (versions.size > 1) {
      reject(`mixes instrument versions ${[...versions].join(", ")}`);
      continue;
    }
    if (entries.length > 0) {
      const opened = sum(entries.map((leg) => Number(leg.amount) || 0));
      const remaining = opened - sum(exits.map((leg) => Number(leg.amount) || 0));
      const tolerance = 1e-9 * Math.max(1, opened);
      if (remaining < -tolerance) {
        reject(`closes more quantity than it opened (negative remaining quantity ${remaining})`);
        continue;
      }
      if (remaining > tolerance) {
        reject(`leaves ${remaining} quantity unreconciled after its final exit`);
        continue;
      }
    }
    if (!isConfiguredAsset(asset)) {
      reject("is not in a configured asset");
      continue;
    }

    const final = finals[0];
    const instrument = legs.find((leg) => leg.instrument)?.instrument ?? legacyInstrument(asset, "LEGACY_SYNTHETIC_V1");
    const netPnlUsdt = sum(exits.map((leg) => Number(leg.pnl)));
    const feesUsdt = sum(exits.map((leg) => (finite(leg.entryFeeUsd) ?? 0) + (finite(leg.exitFeeUsd) ?? 0)));
    const fundingCashflowUsdt = sum(exits.map((leg) => finite(leg.fundingCashflowUsdt) ?? -(finite(leg.carryCostUsd) ?? 0)));
    const grossLegs = exits.map((leg) => finite(leg.grossPnlUsd));
    const grossPnlUsdt = grossLegs.every((value) => value !== undefined)
      ? sum(grossLegs as number[])
      : netPnlUsdt + feesUsdt - fundingCashflowUsdt;
    const releasedMargin = sum(exits.map((leg) => (Number(leg.usdValue) || 0) - (finite(leg.entryFeeUsd) ?? 0) - Number(leg.pnl)));
    const initialRiskUsdt = legs.map((leg) => finite(leg.initialRiskUsdt)).find((value) => value !== undefined && value > 0) ?? null;
    const entryTime = legs.find((leg) => leg.entryTime)?.entryTime;
    const firstFillMs = Math.min(...legs.map((leg) => Date.parse(leg.timestamp)).filter(Number.isFinite));

    completed.push({
      positionId,
      asset,
      instrument,
      direction: legDirection(final),
      openedAtMs: entryTime ? Date.parse(entryTime) : firstFillMs,
      closedAtMs: Date.parse(final.exitTime ?? final.timestamp),
      strategyVersion: final.strategyVersion ?? "legacy-unversioned",
      setupFamily: final.setupTags?.[0] ?? "UNTAGGED",
      regime: final.marketRegime ?? "UNKNOWN",
      entryMode: final.entryMode ?? "UNKNOWN",
      configHash: "unversioned",
      dataSchemaVersion: instrument.venue === "BYBIT" ? "bybit-data-v1" : "legacy",
      costModelVersion: (entries[0] ?? final).executionCostModelVersion ?? "unknown",
      riskPolicyVersion: legs.find((leg) => leg.riskPolicyVersion)?.riskPolicyVersion ?? "unversioned",
      setupTags: final.setupTags ?? [],
      grossPnlUsdt,
      feesUsdt,
      fundingCashflowUsdt,
      netPnlUsdt,
      initialRiskUsdt,
      netR: initialRiskUsdt ? netPnlUsdt / initialRiskUsdt : null,
      returnOnInitialMargin: releasedMargin > 0 ? netPnlUsdt / releasedMargin : 0,
      legIds: legs.map((leg) => leg.id),
    });
  }

  completed.sort((a, b) => a.closedAtMs - b.closedAtMs);
  return { completed, incompletePositionIds, conflicts };
}

/** Learning cohort: same instrument, strategy, setup, cost and risk definitions. */
export function positionOutcomeCohortKey(outcome: CompletedPositionOutcome): string {
  return [
    outcome.asset,
    outcome.instrument.instrumentVersion,
    outcome.strategyVersion,
    outcome.setupFamily,
    outcome.costModelVersion,
    outcome.riskPolicyVersion,
  ].join("|");
}

/** Hash of the legs an outcome was built from, stored with the persisted outcome. */
export function outcomeSourceHash(outcome: CompletedPositionOutcome): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ legs: [...outcome.legIds].sort(), net: outcome.netPnlUsdt, closedAtMs: outcome.closedAtMs }))
    .digest("hex");
}

/**
 * Position-level statistics. Win rate, profit factor and expectancy count
 * completed positions; realized cash from exit legs (including partial exits
 * of still-open positions) is reported separately and labeled as such.
 */
export function summarizeCompletedPositions(input: {
  outcomes: CompletedPositionOutcome[];
  trades: Trade[];
  initialCapital?: number;
}) {
  const outcomes = [...input.outcomes].sort((a, b) => a.closedAtMs - b.closedAtMs);
  const results = outcomes.map((outcome) => outcome.netPnlUsdt);
  const wins = results.filter((pnl) => pnl >= 0);
  const losses = results.filter((pnl) => pnl < 0);
  const grossProfit = sum(wins);
  const grossLoss = Math.abs(sum(losses));
  const totalPnl = grossProfit - grossLoss;
  let equity = input.initialCapital ?? 10_000;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  for (const pnl of results) {
    equity += pnl;
    if (equity > peak) peak = equity;
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, peak > 0 ? ((peak - equity) / peak) * 100 : 0);
  }
  const seen = new Set<string>();
  const exitLegs = input.trades.filter((trade) => isExitLeg(trade) && !seen.has(trade.id) && seen.add(trade.id));
  return {
    source: "completed_positions" as const,
    completedPositions: outcomes.length,
    winningPositions: wins.length,
    losingPositions: losses.length,
    winRate: outcomes.length > 0 ? wins.length / outcomes.length : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? null : 0,
    totalPnl,
    averageWin: wins.length > 0 ? grossProfit / wins.length : 0,
    averageLoss: losses.length > 0 ? grossLoss / losses.length : 0,
    expectancy: outcomes.length > 0 ? totalPnl / outcomes.length : 0,
    maxDrawdown,
    maxDrawdownPercent,
    latestClosedAt: outcomes.length > 0 ? new Date(outcomes[outcomes.length - 1].closedAtMs).toISOString() : null,
    /** Cash events, not positions: every exit leg, partials included. */
    exitLegs: exitLegs.length,
    realizedCashFromExitLegs: sum(exitLegs.map((trade) => Number(trade.pnl))),
  };
}

/** An outcome in the shape older trade-based consumers read, with the position as the unit. */
export function outcomeAsTrade(outcome: CompletedPositionOutcome): Trade {
  const closed = new Date(outcome.closedAtMs).toISOString();
  return {
    id: outcome.positionId,
    positionId: outcome.positionId,
    timestamp: closed,
    exitTime: closed,
    entryTime: new Date(outcome.openedAtMs).toISOString(),
    asset: outcome.asset,
    action: outcome.direction === "SHORT" ? "COVER" : "SELL",
    direction: outcome.direction,
    amount: 0,
    btcAmount: 0,
    price: 0,
    usdValue: 0,
    stopLoss: 0,
    takeProfit: 0,
    signalScore: 0,
    reasoning: "Completed position outcome",
    setupTags: outcome.setupTags,
    strategyVersion: outcome.strategyVersion,
    marketRegime: outcome.regime as Trade["marketRegime"],
    entryMode: outcome.entryMode as Trade["entryMode"],
    instrument: outcome.instrument,
    pnl: outcome.netPnlUsdt,
    pnlPercent: outcome.returnOnInitialMargin * 100,
  };
}
