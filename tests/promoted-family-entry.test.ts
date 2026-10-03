/**
 * A strategy family the research loop promoted to PAPER_ACTIVE trades through
 * the normal entry path as a controlled probe. Families that are not
 * promoted, and every family while the trend baseline already has a trade
 * idea, stay as they were.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { promotedFamilySignal, selectPromotedCandidate, type StrategyCandidate } from "@/lib/swingEngine";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";

const instrument = getConfiguredInstrument("GOLD");
const range: StrategyCandidate = {
  candidateId: "c-range", asset: "GOLD", instrument, family: "RANGE_REVERSION", regime: "RANGE", direction: "LONG",
  entryPrice: 4100, stopPrice: 4080, targetPrice: 4140, initialRiskUsdt: 20, featureCutoffMs: 1, configHash: "cfg-range",
  mode: "SHADOW", netRewardRisk: 1.7, reasons: ["Closed-bar ADX(14) 15.0; RANGE_REVERSION hypothesis"],
};
const key = `${instrument.instrumentVersion}:RANGE_REVERSION:cfg-range`;

describe("promoted family selection", () => {
  it("selects a candidate only when its exact family and configuration are promoted", () => {
    assert.equal(selectPromotedCandidate([range], new Set([key]), instrument.instrumentVersion), range);
    assert.equal(selectPromotedCandidate([range], new Set(), instrument.instrumentVersion), null);
    assert.equal(selectPromotedCandidate([range], new Set([`${instrument.instrumentVersion}:RANGE_REVERSION:other`]), instrument.instrumentVersion), null);
    assert.equal(selectPromotedCandidate([{ ...range, family: "TREND_PULLBACK" }], new Set([key.replace("RANGE_REVERSION", "TREND_PULLBACK")]), instrument.instrumentVersion), null,
      "the trend baseline has its own path");
  });

  it("builds a probe entry carrying the candidate's levels and provenance", () => {
    const base = { action: "HOLD", finalConviction: 64, entryPrice: 4101, stopLoss: 0, takeProfit: 0 } as any;
    const signal = promotedFamilySignal(base, range);
    assert.equal(signal.action, "SWING_BUY");
    assert.equal(signal.entryMode, "CONTROLLED_PROBE");
    assert.equal(signal.paperSize, "Probe");
    assert.equal(signal.stopLoss, 4080);
    assert.equal(signal.takeProfit, 4140);
    assert.equal(signal.family, "RANGE_REVERSION");
    assert.equal(signal.configHash, "cfg-range");
    assert.equal(signal.candidateId, "c-range");
    assert.equal(signal.finalConviction, 64, "conviction is the engine's own, never invented");
    assert.deepEqual(signal.setupTags, ["RANGE_REVERSION"]);
    assert.equal(promotedFamilySignal(base, { ...range, direction: "SHORT", stopPrice: 4120, targetPrice: 4060 }).action, "SWING_SHORT");
  });
});
