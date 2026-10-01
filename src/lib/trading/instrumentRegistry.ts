import crypto from "node:crypto";
import { z } from "zod";

/**
 * The single source of instrument identity for the configured universe.
 *
 * Asset keys and risk classes are the long-standing public names; the Bybit
 * symbol is what an autonomous entry actually trades. Everything that needs to
 * know "which contract is this" (routing, admission, sizing, learning cohorts)
 * should ask here rather than keep its own list.
 */

export const CONFIGURED_ASSETS = [
  "BTC", "ETH", "SOL", "EURUSD", "GBPUSD", "USDJPY", "GOLD", "OIL", "SILVER",
] as const;

export type ConfiguredAsset = (typeof CONFIGURED_ASSETS)[number];
export type RiskClass = "crypto" | "forex" | "commodity";
export type EconomicsModel = "BYBIT_LINEAR_USDT_V1" | "LEGACY_SYNTHETIC_V1" | "LEGACY_PAPER_V1";

export interface InstrumentRef {
  asset: ConfiguredAsset;
  symbol: string;
  venue: "BYBIT" | "LEGACY";
  economicsModel: EconomicsModel;
  instrumentVersion: string;
  settlementCurrency: "USDT" | "USD_PROXY";
}

export interface BybitInstrumentMetadata {
  symbol: string;
  status: string;
  contractType: string;
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  launchTimeMs: number;
  fundingIntervalMinutes: number;
  tickSize: string;
  qtyStep: string;
  minOrderQty: string;
  maxMarketOrderQty: string;
  minNotional: string;
  maxLeverage: number;
  symbolType: string;
  verifiedAtMs: number;
  metadataVersion: string;
}

interface ConfiguredInstrumentSpec {
  name: string;
  riskClass: RiskClass;
  symbol: string;
}

// Verified against public instruments-info on 2026-10-01: every row returned
// status Trading, LinearPerpetual, USDT quote and USDT settlement.
// OIL is WTI (CLUSDT), not Brent. FX perpetuals are not MT5 CFDs or spot FX.
export const CONFIGURED_INSTRUMENTS: Record<ConfiguredAsset, ConfiguredInstrumentSpec> = {
  BTC: { name: "Bitcoin", riskClass: "crypto", symbol: "BTCUSDT" },
  ETH: { name: "Ethereum", riskClass: "crypto", symbol: "ETHUSDT" },
  SOL: { name: "Solana", riskClass: "crypto", symbol: "SOLUSDT" },
  EURUSD: { name: "EUR/USD", riskClass: "forex", symbol: "EURUSDUSDT" },
  GBPUSD: { name: "GBP/USD", riskClass: "forex", symbol: "GBPUSDUSDT" },
  USDJPY: { name: "USD/JPY", riskClass: "forex", symbol: "USDJPYUSDT" },
  GOLD: { name: "Gold", riskClass: "commodity", symbol: "XAUUSDT" },
  OIL: { name: "Crude Oil", riskClass: "commodity", symbol: "CLUSDT" },
  SILVER: { name: "Silver", riskClass: "commodity", symbol: "XAGUSDT" },
};

const LINEAR_ECONOMICS: EconomicsModel = "BYBIT_LINEAR_USDT_V1";

/** Metadata older than this cannot admit a new entry. */
export const METADATA_MAX_AGE_MS = 24 * 3_600_000;
/** A verification stamp this far ahead of the local clock is not trusted. */
const METADATA_FUTURE_TOLERANCE_MS = 5_000;

export function isConfiguredAsset(asset: string): asset is ConfiguredAsset {
  return (CONFIGURED_ASSETS as readonly string[]).includes(asset);
}

/**
 * Stable identity of a mapping plus its economic definition. It deliberately
 * excludes fetch time and filter values, so a routine metadata refresh does
 * not start a new learning cohort.
 */
export function instrumentVersion(symbol: string, model: EconomicsModel = LINEAR_ECONOMICS): string {
  return `${model}:${symbol}`;
}

export function getConfiguredInstrument(asset: string): InstrumentRef {
  if (!isConfiguredAsset(asset)) {
    throw new Error(`"${asset}" is not a configured asset`);
  }
  const { symbol } = CONFIGURED_INSTRUMENTS[asset];
  return {
    asset,
    symbol,
    venue: "BYBIT",
    economicsModel: LINEAR_ECONOMICS,
    instrumentVersion: instrumentVersion(symbol),
    settlementCurrency: "USDT",
  };
}

// Positive decimal string as Bybit publishes it. Kept as a string so that
// lot/tick arithmetic can be done exactly later; never defaulted to zero.
const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "must be a decimal string")
  .refine((value) => Number(value) > 0, "must be positive");

const instrumentSchema = z.object({
  symbol: z.string().min(1),
  status: z.string(),
  contractType: z.string(),
  baseCoin: z.string().min(1),
  quoteCoin: z.string(),
  settleCoin: z.string(),
  launchTime: z.string().regex(/^\d+$/),
  fundingInterval: z.number().int().positive(),
  symbolType: z.string().optional().default(""),
  leverageFilter: z.object({ maxLeverage: positiveDecimal }),
  priceFilter: z.object({ tickSize: positiveDecimal }),
  lotSizeFilter: z.object({
    qtyStep: positiveDecimal,
    minOrderQty: positiveDecimal,
    maxMktOrderQty: positiveDecimal,
    minNotionalValue: positiveDecimal,
  }),
});

/**
 * Validate one instruments-info row for the symbol the caller expects.
 * Throws with the offending field named; a contract that is not a Trading
 * USDT linear perpetual is never usable here, configured or not.
 */
export function validateBybitMetadata(expectedSymbol: string, raw: unknown, nowMs: number): BybitInstrumentMetadata {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`${expectedSymbol}: metadata is not an object`);
  }
  const parsed = instrumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${expectedSymbol}: invalid metadata at ${issue.path.join(".")}: ${issue.message}`);
  }
  const row = parsed.data;
  const mismatch = (field: string, actual: string, expected: string) =>
    new Error(`${expectedSymbol}: ${field} is ${actual || "(empty)"}, expected ${expected}`);

  if (row.symbol !== expectedSymbol) throw mismatch("symbol", row.symbol, expectedSymbol);
  if (row.status !== "Trading") throw mismatch("status", row.status, "Trading");
  if (row.contractType !== "LinearPerpetual") throw mismatch("contractType", row.contractType, "LinearPerpetual");
  if (row.quoteCoin !== "USDT") throw mismatch("quoteCoin", row.quoteCoin, "USDT");
  if (row.settleCoin !== "USDT") throw mismatch("settleCoin", row.settleCoin, "USDT");

  const content = {
    symbol: row.symbol,
    status: row.status,
    contractType: row.contractType,
    baseCoin: row.baseCoin,
    quoteCoin: row.quoteCoin,
    settleCoin: row.settleCoin,
    launchTimeMs: Number(row.launchTime),
    fundingIntervalMinutes: row.fundingInterval,
    tickSize: row.priceFilter.tickSize,
    qtyStep: row.lotSizeFilter.qtyStep,
    minOrderQty: row.lotSizeFilter.minOrderQty,
    maxMarketOrderQty: row.lotSizeFilter.maxMktOrderQty,
    minNotional: row.lotSizeFilter.minNotionalValue,
    maxLeverage: Number(row.leverageFilter.maxLeverage),
    symbolType: row.symbolType,
  };
  const metadataVersion = crypto
    .createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex")
    .slice(0, 16);

  return { ...content, verifiedAtMs: nowMs, metadataVersion };
}

/** Whether metadata is recent and trustworthy enough to admit a new entry. */
export function isMetadataUsable(metadata: BybitInstrumentMetadata, nowMs: number): boolean {
  const age = nowMs - metadata.verifiedAtMs;
  return (
    metadata.status === "Trading" &&
    age >= -METADATA_FUTURE_TOLERANCE_MS &&
    age <= METADATA_MAX_AGE_MS
  );
}
