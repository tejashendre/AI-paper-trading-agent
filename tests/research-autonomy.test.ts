/**
 * Self-learning without an LLM: a strategy family earns live paper trading
 * from its own forward shadow evidence, and loses it when live results
 * contradict that evidence. Before this, every shadow outcome was recorded
 * as lacking cost evidence and no promotion transition existed, so nothing
 * could ever be learned into behavior.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { definition, outcomes } from "./helpers/researchFixtures";
import { MemoryRedis } from "./helpers/memoryRedis";
import { setRedisClient } from "@/lib/redis";
import {
  evaluateDemotion,
  evaluatePromotion,
  getCandidateRegistry,
  recordPromotionReview,
  registerCandidate,
} from "@/lib/research/candidateRegistry";
import { activeFamilyKeys } from "@/lib/research/researchLoop";
import { shadowCostsObserved } from "@/lib/trading/opportunityJournal";
import { getConfiguredInstrument } from "@/lib/trading/instrumentRegistry";

const forwardOnly = (n: number) => outcomes(n).map((o) => ({ ...o, researchOrigin: "SHADOW" }));
const input = (rows: any[]) => ({ definition, outcomes: rows, trials: [definition], holdoutConsumed: false, feesVerified: true });

describe("forward evidence route to promotion", () => {
  it("strong forward shadow evidence alone is enough", () => {
    const report = evaluatePromotion(input(forwardOnly(40)));
    assert.equal(report.eligible, true, JSON.stringify(report.reasons));
  });

  it("too few forward positions are not enough", () => {
    const report = evaluatePromotion(input(forwardOnly(20)));
    assert.equal(report.eligible, false);
  });

  it("losing forward evidence is not enough", () => {
    const rows = forwardOnly(40).map((o) => ({ ...o, netPnlUsdt: -5, netR: -0.05, returnOnInitialMargin: -0.005, stressedNetPnlUsdt: -8 }));
    assert.equal(evaluatePromotion(input(rows)).eligible, false);
  });

  it("forward outcomes without observed costs are not enough", () => {
    assert.equal(evaluatePromotion(input(forwardOnly(40).map((o) => ({ ...o, historicalCostsAvailable: false })))).eligible, false);
  });

  it("an unrelated replay row lacking cost evidence does not veto a strong forward record", () => {
    const rows = [...forwardOnly(40), { ...outcomes(1)[0], positionId: "replay-x", researchOrigin: "REPLAY", historicalCostsAvailable: false }];
    const report = evaluatePromotion(input(rows));
    assert.equal(report.eligible, true, JSON.stringify(report.reasons));
  });

  it("unverified fees still block promotion", () => {
    assert.equal(evaluatePromotion({ ...input(forwardOnly(40)), feesVerified: false }).eligible, false);
  });
});

describe("observed costs on forward shadow outcomes", () => {
  it("are present when the spread was observed and the fee schedule is published", () => {
    assert.equal(shadowCostsObserved({ halfSpreadBps: 0.4 }, getConfiguredInstrument("GOLD")), true);
    assert.equal(shadowCostsObserved({ halfSpreadBps: undefined }, getConfiguredInstrument("GOLD")), false);
    assert.equal(shadowCostsObserved({ halfSpreadBps: 0.4 }, getConfiguredInstrument("EURUSD")), false);
  });
});

describe("demotion from live paper results", () => {
  const paper = (r: number[]) => r.map((netR, i) => ({ ...outcomes(1)[0], positionId: "paper-" + i,
    openedAtMs: outcomes(1)[0].openedAtMs + i * 3 * 86400000, closedAtMs: outcomes(1)[0].openedAtMs + i * 3 * 86400000 + 3600000,
    labelEndMs: outcomes(1)[0].openedAtMs + i * 3 * 86400000 + 86400000, featureStartMs: outcomes(1)[0].openedAtMs + i * 3 * 86400000 - 3600000,
    researchOrigin: "PAPER", netR, netPnlUsdt: netR * 100, returnOnInitialMargin: netR / 10 }));

  it("keeps a family whose live results are mixed but within budget", () => {
    assert.equal(evaluateDemotion(paper([1, -1, 1.5, -1, -1])).demote, false);
  });

  it("demotes a family that spends its 6R loss budget", () => {
    const result = evaluateDemotion(paper([-1, -1, -1, -1, -1, -1.1]));
    assert.equal(result.demote, true);
    assert.ok(result.reasons.some((r) => r.startsWith("PAPER_LOSS_BUDGET")));
  });

  it("demotes a family whose live edge is reliably negative", () => {
    const rows = Array.from({ length: 20 }, (_, i) => (i % 5 === 0 ? 0.2 : -0.3));
    assert.equal(evaluateDemotion(paper(rows)).demote, true);
  });
});

describe("autonomous promotion and demotion", () => {
  it("an eligible review promotes to PAPER_ACTIVE; contradicting paper results reject it for good", async () => {
    const memory = new MemoryRedis();
    setRedisClient(memory);
    try {
      await registerCandidate(definition);
      const good = evaluatePromotion(input(forwardOnly(40)));
      await recordPromotionReview(definition, good, []);
      let current = (await getCandidateRegistry())[0];
      assert.equal(current.mode, "PAPER_ACTIVE");
      assert.deepEqual([...(await activeFamilyKeys())], [`${definition.instrumentVersions[0]}:${definition.family}:${definition.configHash}`]);

      const losing = Array.from({ length: 7 }, (_, i) => ({ ...outcomes(1)[0], positionId: "loss-" + i,
        openedAtMs: outcomes(1)[0].openedAtMs + i * 3 * 86400000, researchOrigin: "PAPER", netR: -1, netPnlUsdt: -100 }));
      await recordPromotionReview(current, good, losing);
      current = (await getCandidateRegistry())[0];
      assert.equal(current.mode, "REJECTED");
      assert.equal((await activeFamilyKeys()).size, 0);

      // The same evidence cannot re-promote a family that live trading contradicted.
      await recordPromotionReview(current, good, []);
      assert.equal((await getCandidateRegistry())[0].mode, "REJECTED");
    } finally {
      setRedisClient(null);
    }
  });
});

describe("live paper outcomes feed demotion, not promotion", () => {
  it("a completed live position becomes a PAPER research outcome with its realized result", async () => {
    const { paperResearchOutcome } = await import("@/lib/research/researchLoop");
    const live = { ...outcomes(1)[0], researchOrigin: undefined, netPnlUsdt: -120, initialRiskUsdt: 100, netR: -1.2 };
    const row = paperResearchOutcome(live as any);
    assert.equal(row.researchOrigin, "PAPER");
    assert.equal(row.historicalCostsAvailable, true);
    assert.equal(row.stressedNetPnlUsdt, -120);
    assert.equal(row.riskLimitBreached, false);
  });

  it("PAPER rows never count toward promotion", () => {
    const paperOnly = outcomes(60).map((o) => ({ ...o, researchOrigin: "PAPER" }));
    const report = evaluatePromotion(input(paperOnly));
    assert.equal(report.eligible, false);
    assert.equal(report.metrics.compatiblePositions, 0);
  });
});
