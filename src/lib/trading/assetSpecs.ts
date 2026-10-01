import { OpenPosition, Portfolio, Trade } from "@/lib/types";
import { getConfiguredInstrument, InstrumentRef, legacyInstrument } from "@/lib/trading/instrumentRegistry";

export type AssetClass = "crypto" | "forex" | "commodity";

export interface AssetContractSpec {
  asset: string;
  assetClass: AssetClass;
  quoteCurrency: "USD" | "JPY";
  unitLabel: string;
  maxLeverage: number;
  maxMarginPercent: number;
  makerFeeRate: number;
  takerFeeRate: number;
  /** Legacy alias. New execution paths should use makerFeeRate/takerFeeRate. */
  feeRate: number;
  minMarginUsd: number;
}

/**
 * Version of the leverage, margin and minimum-margin policy below, frozen
 * onto every new position so later policy edits cannot relabel old risk.
 */
export const RISK_POLICY_VERSION = "risk-policy-v1-2026-10-01";

const CRYPTO_MAKER_FEE_RATE = 0.0002;
const CRYPTO_TAKER_FEE_RATE = 0.00055;
const SYNTHETIC_FX_FEE_RATE = 0;
const SYNTHETIC_COMMODITY_FEE_RATE = 0.0001;

export const ASSET_CONTRACT_SPECS: Record<string, AssetContractSpec> = {
  BTC: {
    asset: "BTC",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "BTC",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: CRYPTO_MAKER_FEE_RATE,
    takerFeeRate: CRYPTO_TAKER_FEE_RATE,
    feeRate: CRYPTO_TAKER_FEE_RATE,
    minMarginUsd: 50,
  },
  ETH: {
    asset: "ETH",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "ETH",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: CRYPTO_MAKER_FEE_RATE,
    takerFeeRate: CRYPTO_TAKER_FEE_RATE,
    feeRate: CRYPTO_TAKER_FEE_RATE,
    minMarginUsd: 50,
  },
  SOL: {
    asset: "SOL",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "SOL",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: CRYPTO_MAKER_FEE_RATE,
    takerFeeRate: CRYPTO_TAKER_FEE_RATE,
    feeRate: CRYPTO_TAKER_FEE_RATE,
    minMarginUsd: 50,
  },
  EURUSD: {
    asset: "EURUSD",
    assetClass: "forex",
    quoteCurrency: "USD",
    unitLabel: "EUR",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_FX_FEE_RATE,
    takerFeeRate: SYNTHETIC_FX_FEE_RATE,
    feeRate: SYNTHETIC_FX_FEE_RATE,
    minMarginUsd: 50,
  },
  GBPUSD: {
    asset: "GBPUSD",
    assetClass: "forex",
    quoteCurrency: "USD",
    unitLabel: "GBP",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_FX_FEE_RATE,
    takerFeeRate: SYNTHETIC_FX_FEE_RATE,
    feeRate: SYNTHETIC_FX_FEE_RATE,
    minMarginUsd: 50,
  },
  USDJPY: {
    asset: "USDJPY",
    assetClass: "forex",
    quoteCurrency: "JPY",
    unitLabel: "USD",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_FX_FEE_RATE,
    takerFeeRate: SYNTHETIC_FX_FEE_RATE,
    feeRate: SYNTHETIC_FX_FEE_RATE,
    minMarginUsd: 50,
  },
  GOLD: {
    asset: "GOLD",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "oz",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    takerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    feeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    minMarginUsd: 50,
  },
  OIL: {
    asset: "OIL",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "barrel",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    takerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    feeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    minMarginUsd: 50,
  },
  SILVER: {
    asset: "SILVER",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "oz",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    makerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    takerFeeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    feeRate: SYNTHETIC_COMMODITY_FEE_RATE,
    minMarginUsd: 50,
  },
};

export function getAssetSpec(asset: string): AssetContractSpec {
  const spec = ASSET_CONTRACT_SPECS[asset];
  if (!spec) {
    throw new Error(`Missing asset contract spec for ${asset}`);
  }
  return spec;
}

// Legacy synthetic formulas. Their quantity unit is USD exposure for a
// JPY-quoted pair, so they are reachable only through a LEGACY_* instrument,
// never for a new trade.
function legacyMovePerUnit(asset: string, fromPrice: number, toPrice: number): number {
  const priceMove = Math.abs(toPrice - fromPrice);
  if (!Number.isFinite(priceMove) || priceMove <= 0) return 0;
  return getAssetSpec(asset).quoteCurrency === "JPY" ? priceMove / Math.max(toPrice, 1e-9) : priceMove;
}

function legacyNotional(asset: string, amount: number, price: number): number {
  return getAssetSpec(asset).quoteCurrency === "JPY" ? amount : amount * price;
}

function legacyAmountFromNotional(asset: string, notional: number, price: number): number {
  return getAssetSpec(asset).quoteCurrency === "JPY" ? notional : notional / price;
}

function legacyPnl(asset: string, entryPrice: number, exitPrice: number, amount: number, direction: OpenPosition["direction"]): number {
  const signedMove = direction === "SHORT" ? entryPrice - exitPrice : exitPrice - entryPrice;
  return getAssetSpec(asset).quoteCurrency === "JPY"
    ? (signedMove * amount) / Math.max(exitPrice, 1e-9)
    : signedMove * amount;
}

// Asset-keyed helpers price a NEW trade in the asset, which always means its
// configured Bybit linear contract. Existing positions use their own frozen
// instrument through the position functions below.
export function getUsdMovePerUnit(asset: string, fromPrice: number, toPrice: number): number {
  return instrumentMovePerUnit(getConfiguredInstrument(asset), fromPrice, toPrice);
}

export function estimateNotionalUsd(asset: string, amount: number, price: number): number {
  return instrumentNotional(getConfiguredInstrument(asset), amount, price);
}

export function amountFromNotionalUsd(asset: string, notionalUsd: number, price: number): number {
  return instrumentQuantityFromNotional(getConfiguredInstrument(asset), notionalUsd, price);
}

export function calculatePnlUsd(
  asset: string,
  entryPrice: number,
  exitPrice: number,
  amount: number,
  direction: OpenPosition["direction"]
): number {
  return calculateInstrumentPnl({ instrument: getConfiguredInstrument(asset), entryPrice, exitPrice, quantity: amount, direction });
}

export function estimateFeeUsd(
  asset: string,
  amount: number,
  price: number,
  liquidity: "maker" | "taker" = "taker"
): number {
  return instrumentFee(getConfiguredInstrument(asset), amount, price, liquidity);
}

// ---------------------------------------------------------------------------
// Position economics. Every calculation on an existing position goes through
// the model frozen on that position, never through today's asset routing.
// ---------------------------------------------------------------------------

/** The instrument a position was opened on; pre-upgrade records read as legacy. */
export function positionInstrument(
  position: Pick<OpenPosition, "asset" | "instrument" | "strategyType">
): InstrumentRef {
  if (position.instrument) return position.instrument;
  const autonomous = position.strategyType === "swing" || position.strategyType === "scalp";
  return legacyInstrument(position.asset, autonomous ? "LEGACY_SYNTHETIC_V1" : "LEGACY_PAPER_V1");
}

const isLinear = (instrument: InstrumentRef) => instrument.economicsModel === "BYBIT_LINEAR_USDT_V1";

/** Gross P&L in the instrument's settlement unit. Linear: quantity times price change. */
export function calculateInstrumentPnl(input: {
  instrument: InstrumentRef;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  direction: OpenPosition["direction"];
}): number {
  if (!isLinear(input.instrument)) {
    return legacyPnl(input.instrument.asset, input.entryPrice, input.exitPrice, input.quantity, input.direction);
  }
  const signedMove = input.direction === "SHORT" ? input.entryPrice - input.exitPrice : input.exitPrice - input.entryPrice;
  return signedMove * input.quantity;
}

export function instrumentNotional(instrument: InstrumentRef, quantity: number, price: number): number {
  return isLinear(instrument) ? quantity * price : legacyNotional(instrument.asset, quantity, price);
}

export function instrumentQuantityFromNotional(instrument: InstrumentRef, notional: number, price: number): number {
  return isLinear(instrument) ? notional / price : legacyAmountFromNotional(instrument.asset, notional, price);
}

/** Settlement-currency P&L per unit of quantity for a move between two prices. */
export function instrumentMovePerUnit(instrument: InstrumentRef, fromPrice: number, toPrice: number): number {
  if (!isLinear(instrument)) return legacyMovePerUnit(instrument.asset, fromPrice, toPrice);
  const priceMove = Math.abs(toPrice - fromPrice);
  return Number.isFinite(priceMove) && priceMove > 0 ? priceMove : 0;
}

/** The instrument a trade leg was written under; rows without one predate the upgrade. */
export function tradeInstrument(trade: Pick<Trade, "asset" | "instrument">): InstrumentRef {
  return trade.instrument ?? legacyInstrument(trade.asset, "LEGACY_SYNTHETIC_V1");
}

export function instrumentFee(
  instrument: InstrumentRef,
  quantity: number,
  price: number,
  liquidity: "maker" | "taker" = "taker"
): number {
  const spec = getAssetSpec(instrument.asset);
  const rate = liquidity === "maker" ? spec.makerFeeRate : spec.takerFeeRate;
  return instrumentNotional(instrument, quantity, price) * rate;
}

/** Identity every new autonomous position must carry from its first fill. */
export function autonomousPositionIdentity(input: {
  instrument: InstrumentRef;
  initialRiskUsdt: number;
  costModelVersion: string;
  positionId?: string;
}) {
  if (!Number.isFinite(input.initialRiskUsdt) || input.initialRiskUsdt <= 0) {
    throw new Error(`initialRiskUsdt must be a positive amount, got ${input.initialRiskUsdt}`);
  }
  if (!input.costModelVersion) throw new Error("costModelVersion is required");
  return {
    positionId: input.positionId ?? crypto.randomUUID(),
    instrument: input.instrument,
    economicsModel: input.instrument.economicsModel,
    initialRiskUsdt: input.initialRiskUsdt,
    costModelVersion: input.costModelVersion,
    riskPolicyVersion: RISK_POLICY_VERSION,
  };
}

/** Identity copied from a position onto each of its entry, scale-in and exit legs. */
export function positionLegIdentity(position: OpenPosition) {
  const instrument = positionInstrument(position);
  return { positionId: position.positionId, instrument, economicsModel: instrument.economicsModel };
}

/** Why a migration conflict blocks new entries in this asset, or null. */
export function migrationEntryBlock(portfolio: Pick<Portfolio, "instrumentMigration">, asset: string): string | null {
  const reason = portfolio.instrumentMigration?.blockedAssets?.[asset];
  return reason ? `${asset}: new entries wait for a migration conflict to be resolved (${reason})` : null;
}
