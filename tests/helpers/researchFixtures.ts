import { getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import { TRADING_STRATEGY_VERSION } from '@/lib/trading/executionLedger';
const registered = Date.parse("2026-01-01T00:00:00Z");
export const definition: any = { candidateId: "baseline-btc-trend", family: "TREND_PULLBACK", configHash: "config-1",
  strategyVersion: TRADING_STRATEGY_VERSION, instrumentVersions: [getConfiguredInstrument("BTC").instrumentVersion],
  costModelVersion: "cost-v3", riskPolicyVersion: "risk-v3", registeredAtMs: registered,
  labelHorizonMs: 86400000, holdoutId: "untouched-1", mode: "SHADOW",
  evidenceManifestHash:'a'.repeat(64),holdoutStartMs:registered,holdoutEndMs:registered+300*86400000 };
export function outcomes(count = 90): any[] {
  return Array.from({ length: count }, (_, i) => {
    const openedAtMs = registered + (i * 3 + 1) * 86400000;
    const pnl = i % 4 === 0 ? -10 : 50;
    return { positionId: "p-" + i, asset: "BTC", instrument: getConfiguredInstrument("BTC"), direction: "LONG",
      openedAtMs, closedAtMs: openedAtMs + 3600000, featureStartMs: openedAtMs - 3600000,
      labelEndMs: openedAtMs + 86400000, strategyVersion: TRADING_STRATEGY_VERSION,
      setupFamily: definition.family, regime: "TREND", entryMode: "STANDARD", configHash: definition.configHash,
      dataSchemaVersion: "bybit-closed-bars-v1", costModelVersion: definition.costModelVersion,
      riskPolicyVersion: definition.riskPolicyVersion, setupTags: [], grossPnlUsdt: pnl + 5, feesUsdt: 5,
      fundingCashflowUsdt: 0, netPnlUsdt: pnl, initialRiskUsdt: 100, netR: pnl / 100,
      returnOnInitialMargin: pnl / 1000, legIds: ["leg-" + i],
      evidenceManifestHash:definition.evidenceManifestHash,
      researchOrigin: i < 70 ? "REPLAY" : "SHADOW", historicalCostsAvailable: true,
      stressedNetPnlUsdt: pnl - 5, riskLimitBreached: false };
  });
}
