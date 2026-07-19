import { OpenPosition } from "@/lib/types";

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

export function getUsdMovePerUnit(asset: string, fromPrice: number, toPrice: number): number {
  const priceMove = Math.abs(toPrice - fromPrice);
  if (!Number.isFinite(priceMove) || priceMove <= 0) return 0;

  const spec = getAssetSpec(asset);
  if (spec.quoteCurrency === "JPY") {
    return priceMove / Math.max(toPrice, 1e-9);
  }

  return priceMove;
}

export function estimateNotionalUsd(asset: string, amount: number, price: number): number {
  const spec = getAssetSpec(asset);
  if (spec.quoteCurrency === "JPY") {
    return amount;
  }

  return amount * price;
}

export function amountFromNotionalUsd(asset: string, notionalUsd: number, price: number): number {
  const spec = getAssetSpec(asset);
  if (spec.quoteCurrency === "JPY") {
    return notionalUsd;
  }

  return notionalUsd / price;
}

export function calculatePnlUsd(
  asset: string,
  entryPrice: number,
  exitPrice: number,
  amount: number,
  direction: OpenPosition["direction"]
): number {
  const isShort = direction === "SHORT";
  const signedMove = isShort ? entryPrice - exitPrice : exitPrice - entryPrice;
  const spec = getAssetSpec(asset);

  if (spec.quoteCurrency === "JPY") {
    return (signedMove * amount) / Math.max(exitPrice, 1e-9);
  }

  return signedMove * amount;
}

export function estimateFeeUsd(
  asset: string,
  amount: number,
  price: number,
  liquidity: "maker" | "taker" = "taker"
): number {
  const spec = getAssetSpec(asset);
  const feeRate = liquidity === "maker" ? spec.makerFeeRate : spec.takerFeeRate;
  return estimateNotionalUsd(asset, amount, price) * feeRate;
}
