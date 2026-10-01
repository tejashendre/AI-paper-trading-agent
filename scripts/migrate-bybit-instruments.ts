/**
 * Instrument and position-identity migration for the Bybit upgrade.
 *
 *   npx tsx scripts/migrate-bybit-instruments.ts --input <snapshot.json> --output <preview.json> [--now <iso>]
 *
 * Snapshot: { schemaVersion: 1, accounts: [{ name, portfolio, trades }] }.
 *
 * Offline preview only: it reads a snapshot file and writes a preview file.
 * It never connects to Redis or the ledger. Applying a migration to live state
 * is a separate, release-authorized operation that this tool does not perform.
 *
 * The migration only adds labels. Every original field keeps its value, each
 * record lists the fields the migration added (deleting them restores the
 * original), and old ledger events are never rewritten.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { InstrumentMigrationMarker, OpenPosition, Portfolio, Trade } from "@/lib/types";
import {
  EconomicsModel,
  getConfiguredInstrument,
  InstrumentRef,
  isConfiguredAsset,
  legacyInstrument,
} from "@/lib/trading/instrumentRegistry";
import { positionInstrument } from "@/lib/trading/assetSpecs";
// One definition of legacy identity, shared with the outcome builder.
import { legacyPositionId } from "@/lib/trading/positionOutcomes";

export const INSTRUMENT_MIGRATION_VERSION = "instrument-migration-v1-2026-10-01";
const ACCOUNTING_ASSUMPTION =
  "1 USD_PROXY = 1 USDT paper-account relabel. Historical cash was a nominal USD proxy; no currency conversion was executed.";
/** An entry fill is matched to its position only when it was written this close to the recorded entry time. */
const ENTRY_FILL_TOLERANCE_MS = 5_000;

export interface InstrumentMigrationPlan {
  migratedPortfolios: Portfolio[];
  migratedTrades: Trade[];
  conflicts: string[];
  originalHash: string;
  migrationVersion: string;
  /** One line per labeled record, for review. */
  journal: string[];
}

type Direction = "LONG" | "SHORT";
type Labeled = { migrationAddedFields?: string[] };

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The record as it was before any migration labels were added. */
function unlabel<T extends Labeled>(record: T): T {
  const copy: Record<string, unknown> = { ...record };
  for (const field of record.migrationAddedFields ?? []) delete copy[field];
  delete copy.migrationAddedFields;
  return copy as T;
}

function unlabelPortfolio(portfolio: Portfolio): Portfolio {
  const copy: Record<string, unknown> = { ...portfolio };
  for (const field of portfolio.instrumentMigration?.addedFields ?? []) delete copy[field];
  delete copy.instrumentMigration;
  for (const map of ["openPositions", "scalpPositions"] as const) {
    const positions = portfolio[map];
    if (positions) {
      copy[map] = Object.fromEntries(Object.entries(positions).map(([key, pos]) => [key, unlabel(pos)]));
    }
  }
  return copy as unknown as Portfolio;
}

function addLabel<T extends Labeled>(record: T, field: keyof T & string, value: unknown) {
  (record as Record<string, unknown>)[field] = value;
  record.migrationAddedFields = Array.from(new Set([...(record.migrationAddedFields ?? []), field]));
}

function sameInstrument(a: InstrumentRef, b: InstrumentRef): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** Why a position's recorded provenance cannot be trusted, or null if it can. */
function provenanceConflict(key: string, pos: OpenPosition): string | null {
  if (pos.asset !== key) return `position stored under ${key} is recorded as ${pos.asset}`;
  if (!isConfiguredAsset(pos.asset)) return `${pos.asset} is not a configured asset`;
  if (!(Number.isFinite(pos.entryPrice) && pos.entryPrice > 0 && Number.isFinite(pos.amount) && pos.amount > 0)) {
    return "entry price or quantity is missing or not positive";
  }
  if (pos.instrument) {
    const expected = pos.instrument.venue === "BYBIT"
      ? getConfiguredInstrument(key)
      : pos.instrument.economicsModel === "BYBIT_LINEAR_USDT_V1"
        ? null
        : legacyInstrument(key, pos.instrument.economicsModel as Exclude<EconomicsModel, "BYBIT_LINEAR_USDT_V1">);
    if (!expected || !sameInstrument(pos.instrument, expected)) {
      return `recorded instrument ${pos.instrument.instrumentVersion} (${pos.instrument.symbol}) does not match a known model for ${key}`;
    }
  }
  if (pos.economicsModel && pos.economicsModel !== positionInstrument(pos).economicsModel) {
    return `economicsModel ${pos.economicsModel} disagrees with the recorded instrument`;
  }
  return null;
}

function tradeDirection(trade: Trade): Direction {
  if (trade.direction) return trade.direction;
  return trade.action.includes("SHORT") || trade.action.includes("COVER") ? "SHORT" : "LONG";
}

const isExitLeg = (trade: Trade) => /SELL|COVER/.test(trade.action);
const isScaleIn = (trade: Trade) => !isExitLeg(trade) && /^Scaled into/i.test(trade.reasoning || "");
const lineageKey = (asset: string, direction: Direction, entryTime: string) => `${asset}|${direction}|${entryTime}`;

/**
 * Plan the migration without touching any store. Pure: the same input gives
 * the same output, and running it on its own output changes nothing.
 */
export function planInstrumentMigration(input: {
  portfolios: Portfolio[];
  trades: Trade[];
  nowMs: number;
}): InstrumentMigrationPlan {
  for (const portfolio of input.portfolios) {
    const version = portfolio.instrumentMigration?.version;
    if (version && version !== INSTRUMENT_MIGRATION_VERSION) {
      throw new Error(`Account was migrated by unknown version ${version}; refusing to migrate it again`);
    }
  }

  const originalHash = crypto
    .createHash("sha256")
    .update(stableStringify({
      portfolios: input.portfolios.map(unlabelPortfolio),
      trades: input.trades.map(unlabel),
    }))
    .digest("hex");

  const portfolios = clone(input.portfolios);
  const trades = clone(input.trades);
  const conflicts: string[] = [];
  const journal: string[] = [];
  const blockedByPortfolio = portfolios.map(() => ({} as Record<string, string>));

  // 1. Position provenance and economic model.
  const openByLineage = new Map<string, Array<{ pos: OpenPosition; label: string }>>();
  portfolios.forEach((portfolio, index) => {
    for (const map of ["openPositions", "scalpPositions"] as const) {
      for (const [key, pos] of Object.entries(portfolio[map] ?? {})) {
        const label = `portfolio[${index}].${map}.${key}`;
        const conflict = provenanceConflict(key, pos);
        if (conflict) {
          conflicts.push(`${key}: ${conflict} (${label})`);
          blockedByPortfolio[index][key] = conflict;
          continue;
        }
        if (!pos.instrument) {
          const instrument = positionInstrument(pos);
          addLabel(pos, "instrument", instrument);
          addLabel(pos, "economicsModel", instrument.economicsModel);
          journal.push(`${label}: labeled ${instrument.economicsModel} (${instrument.settlementCurrency})`);
        }
        if (!pos.positionId) {
          const lineage = lineageKey(key, pos.direction, pos.entryTime);
          openByLineage.set(lineage, [...(openByLineage.get(lineage) ?? []), { pos, label }]);
        }
      }
    }
  });

  // 2. Historical lineage: one identity per (asset, direction, entry time),
  //    assigned only when the evidence is unambiguous.
  const exitGroups = new Map<string, Trade[]>();
  for (const trade of trades) {
    if (trade.positionId || !isExitLeg(trade) || !trade.entryTime) continue;
    const key = lineageKey(trade.asset, tradeDirection(trade), trade.entryTime);
    exitGroups.set(key, [...(exitGroups.get(key) ?? []), trade]);
  }
  const lineages = new Set([...exitGroups.keys(), ...openByLineage.keys()]);

  for (const lineage of [...lineages].sort()) {
    const [asset, direction, entryTime] = lineage.split("|") as [string, Direction, string];
    const legs = exitGroups.get(lineage) ?? [];
    const open = openByLineage.get(lineage) ?? [];
    const entryMs = Date.parse(entryTime);
    const lastMs = open.length > 0
      ? Number.POSITIVE_INFINITY
      : Math.max(...legs.map((leg) => Date.parse(leg.timestamp)));
    const sameSide = (trade: Trade) => trade.asset === asset && tradeDirection(trade) === direction && !isExitLeg(trade);
    const entryFills = trades.filter((trade) =>
      sameSide(trade) && !isScaleIn(trade) && !trade.positionId &&
      Math.abs(Date.parse(trade.timestamp) - entryMs) <= ENTRY_FILL_TOLERANCE_MS
    );
    const scaleIns = trades.filter((trade) => {
      const at = Date.parse(trade.timestamp);
      return sameSide(trade) && isScaleIn(trade) && at >= entryMs && at <= lastMs;
    });

    const problems: string[] = [];
    const finals = legs.filter((leg) => !leg.isPartialExit);
    if (finals.length > 1) problems.push(`${finals.length} final exits share one entry`);
    if (finals.length > 0 && open.length > 0) problems.push("a final exit exists while the position is still open");
    if (open.length > 1) problems.push(`${open.length} open positions share one entry`);
    if (new Set(legs.map((leg) => leg.entryPrice)).size > 1) problems.push("exit legs record conflicting entry prices");
    if (scaleIns.length > 0 || open.some(({ pos }) => (pos.scaleInCount ?? 0) > 0)) {
      problems.push("a scale-in sits inside the lineage, so its fills need review");
    }
    if (entryFills.length > 1) problems.push(`${entryFills.length} entry fills match the entry time`);

    if (problems.length > 0) {
      conflicts.push(`${asset}: lineage ${direction} from ${entryTime} left unassigned: ${problems.join("; ")}`);
      continue;
    }

    const positionId = legacyPositionId(asset, direction, entryTime);
    for (const trade of [...entryFills, ...legs]) addLabel(trade, "positionId", positionId);
    for (const { pos, label } of open) {
      addLabel(pos, "positionId", positionId);
      journal.push(`${label}: positionId ${positionId}`);
    }
    journal.push(`${asset} ${direction} ${entryTime}: ${entryFills.length + legs.length} trade leg(s) -> ${positionId}`);
  }

  // 3. Account units, labeled as an assumption with the original unit kept.
  portfolios.forEach((portfolio, index) => {
    const previous = portfolio.instrumentMigration;
    const addedFields = previous?.addedFields ?? [];
    if (!portfolio.accountingCurrency) {
      portfolio.accountingCurrency = "USDT";
      addedFields.push("accountingCurrency");
      journal.push(`portfolio[${index}]: cash relabeled USD_PROXY -> USDT (assumption, no conversion)`);
    }
    const marker: InstrumentMigrationMarker = {
      version: INSTRUMENT_MIGRATION_VERSION,
      appliedAtMs: previous?.appliedAtMs ?? input.nowMs,
      originalHash,
      previousAccountingCurrency: "USD_PROXY",
      accountingAssumption: ACCOUNTING_ASSUMPTION,
      addedFields,
      blockedAssets: blockedByPortfolio[index],
    };
    portfolio.instrumentMigration = marker;
  });

  return {
    migratedPortfolios: portfolios,
    migratedTrades: trades,
    conflicts,
    originalHash,
    migrationVersion: INSTRUMENT_MIGRATION_VERSION,
    journal,
  };
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args: string[]) {
  if (args.includes("--apply")) {
    console.error("Live apply is a separate, release-authorized operation. This tool only writes an offline preview.");
    process.exit(2);
  }
  const inputPath = argument(args, "--input");
  const outputPath = argument(args, "--output");
  if (!inputPath || !outputPath) {
    console.error("Usage: npx tsx scripts/migrate-bybit-instruments.ts --input <snapshot.json> --output <preview.json> [--now <iso>]");
    process.exit(2);
  }
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    console.error("Refusing to overwrite the input snapshot.");
    process.exit(2);
  }
  const nowArg = argument(args, "--now");
  const nowMs = nowArg ? Date.parse(nowArg) : Date.now();
  if (!Number.isFinite(nowMs)) {
    console.error(`Invalid --now value: ${nowArg}`);
    process.exit(2);
  }

  type Account = { name: string; portfolio: Portfolio; trades: Trade[] };
  const snapshot = JSON.parse(fs.readFileSync(inputPath, "utf8")) as { schemaVersion?: number; accounts?: Account[] };
  const accounts = snapshot.accounts;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(accounts) ||
      !accounts.every((account) => account.name && account.portfolio && Array.isArray(account.trades))) {
    console.error("Snapshot must be { schemaVersion: 1, accounts: [{ name, portfolio, trades }] }.");
    process.exit(2);
  }

  // Each account is migrated against its own trades, so lineage from one
  // account can never be attached to a position in another.
  const results = accounts.map((account) => {
    const plan = planInstrumentMigration({ portfolios: [account.portfolio], trades: account.trades, nowMs });
    const [portfolio] = plan.migratedPortfolios;
    const positions = Object.values({ ...portfolio.openPositions, ...(portfolio.scalpPositions ?? {}) });
    return {
      account: account.name,
      originalHash: plan.originalHash,
      // Reviewed and approved separately from the quantity-model labels.
      accountLabeling: {
        from: "USD_PROXY",
        to: portfolio.accountingCurrency,
        assumption: portfolio.instrumentMigration?.accountingAssumption,
        cashUnchanged: portfolio.usd === account.portfolio.usd,
      },
      quantityModel: {
        openPositionsByModel: positions.reduce<Record<string, number>>((acc, pos) => {
          const model = pos.economicsModel ?? "UNLABELED_CONFLICT";
          acc[model] = (acc[model] ?? 0) + 1;
          return acc;
        }, {}),
        tradesWithInferredPositionId: plan.migratedTrades.filter((trade) => trade.migrationAddedFields?.includes("positionId")).length,
        tradesLeftWithoutPositionId: plan.migratedTrades.filter((trade) => !trade.positionId).length,
      },
      conflicts: plan.conflicts,
      blockedAssets: portfolio.instrumentMigration?.blockedAssets ?? {},
      journal: plan.journal,
      migratedPortfolio: portfolio,
      migratedTrades: plan.migratedTrades,
    };
  });

  const preview = {
    migrationVersion: INSTRUMENT_MIGRATION_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    input: path.basename(inputPath),
    applied: false,
    accounts: results,
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(preview, null, 2)}
`);
  for (const result of results) {
    console.log(
      `${result.account}: ${result.journal.length} journal line(s), ${result.conflicts.length} conflict(s), hash ${result.originalHash.slice(0, 16)}.`
    );
  }
  console.log(`Preview written to ${outputPath}. Nothing was applied.`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
