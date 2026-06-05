import { OpenPosition } from "@/lib/types";

export type AssetClass = "crypto" | "forex" | "commodity";

export interface AssetContractSpec {
  asset: string;
  assetClass: AssetClass;
  quoteCurrency: "USD" | "JPY";
  unitLabel: string;
  maxLeverage: number;
  maxMarginPercent: number;
  feeRate: number;
  minMarginUsd: number;
}

const DEFAULT_FEE_RATE = 0.0005;

export const ASSET_CONTRACT_SPECS: Record<string, AssetContractSpec> = {
  BTC: {
    asset: "BTC",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "BTC",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  ETH: {
    asset: "ETH",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "ETH",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  SOL: {
    asset: "SOL",
    assetClass: "crypto",
    quoteCurrency: "USD",
    unitLabel: "SOL",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  EURUSD: {
    asset: "EURUSD",
    assetClass: "forex",
    quoteCurrency: "USD",
    unitLabel: "EUR",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  GBPUSD: {
    asset: "GBPUSD",
    assetClass: "forex",
    quoteCurrency: "USD",
    unitLabel: "GBP",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  USDJPY: {
    asset: "USDJPY",
    assetClass: "forex",
    quoteCurrency: "JPY",
    unitLabel: "USD",
    maxLeverage: 5,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  GOLD: {
    asset: "GOLD",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "oz",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  OIL: {
    asset: "OIL",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "barrel",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
  },
  SILVER: {
    asset: "SILVER",
    assetClass: "commodity",
    quoteCurrency: "USD",
    unitLabel: "oz",
    maxLeverage: 3,
    maxMarginPercent: 0.1,
    feeRate: DEFAULT_FEE_RATE,
    minMarginUsd: 10,
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

export function estimateFeeUsd(asset: string, amount: number, price: number): number {
  const spec = getAssetSpec(asset);
  return estimateNotionalUsd(asset, amount, price) * spec.feeRate;
}
