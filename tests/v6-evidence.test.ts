import test from "node:test";
import assert from "node:assert/strict";
import { brainDefinition, type BrainDefinition } from "@/lib/strategy/v6/engine";
import { brainEvidenceIdentity, brainPermission, evaluateBrainEvidence, freezeBrainCosts, evidenceHash,
  registerBrain, saveBrainReview, readBrainReview, type BrainEvidenceInput, type EvidenceRedis,
} from "@/lib/strategy/v6/evidence";

const DAY = 86_400_000, START = Date.parse("2026-01-01T00:00:00Z"), SOURCE = "a".repeat(64);
function fixture(count = 40): BrainEvidenceInput {
  const definition = brainDefinition("BTC");
  const costs = freezeBrainCosts("BTC");
  const trials = Array.from({ length: 39 }, (_, i) => ({ trialId: `trial-${i}`, sourceHash: SOURCE, registeredAtMs: START - DAY, kind: i < 30 ? "LEGACY" as const : "INITIAL" as const }));
  const registration = { runId: "run-a", sourceHash: SOURCE, costHash: evidenceHash(costs), riskPolicyHash: SOURCE,
    exitPolicyHash: SOURCE, registeredAtMs: START, releasedAtMs: START, firstEvaluationAtMs: START + DAY,
    trialSnapshotHash: evidenceHash(trials), costs, folds: [] };
  const identityHash = brainEvidenceIdentity(definition, registration);
  const outcomes = Array.from({ length: count }, (_, i) => {
    const openedAtMs = START + (2 * i + 1) * DAY, closedAtMs = openedAtMs + DAY / 4;
    return { positionId: `position-${i}`, identityHash, runId: "run-a", sourceHash: SOURCE,
      origin: "SHADOW" as const, openedAtMs, closedAtMs, availableAtMs: closedAtMs,
      netR: i % 3 === 0 ? 0.8 : 1.2, stressedNetR: 0.5, initialRiskUsdt: 25,
      costHash: registration.costHash, executions: [openedAtMs, closedAtMs].map(atMs => ({ atMs, availableAtMs: atMs,
        sourceHash: SOURCE, halfSpreadBps: 1, depthNotionalUsdt: 50_000 })), fundingIntervalMs: 8 * 3_600_000,
      funding: [openedAtMs + 8 * 3_600_000].filter(atMs => atMs <= closedAtMs).map(atMs => ({ atMs, availableAtMs: atMs, sourceHash: SOURCE, actualRate: 0.0001, mark: 100, intervalMinutes: 480 })),
      criticalViolation: false };
  });
  const nowMs = START + (2 * count + 2) * DAY;
  return { definition, registration, outcomes, trials, nowMs, expiresAtMs: nowMs + DAY,
    dailyReturns: Array.from({ length: 2 * count }, (_, i) => ({ dayStartMs: START + i * DAY,
      availableAtMs: START + (i + 1) * DAY, identityHash, runId: "run-a", sourceHash: SOURCE,
      costHash: registration.costHash, baseRiskFraction: 0.0025, netReturn: i % 2 ? 0.003 : 0.001 })),
    portfolio: { identityHash, runId: "run-a", sourceHash: SOURCE, riskFraction: 0.0025,
      alignedBlockMs: 10 * DAY, factorClusters: ["crypto"], equity: [
        { atMs: START, equityUsdt: 10_000 }, { atMs: nowMs, equityUsdt: 10_500 }], unresolvedBreaker: false,
      integrityRestored: true } };
}

test("new and tiny cohorts remain shadow with unavailable statistics", () => {
  const review = evaluateBrainEvidence(fixture(2));
  assert.equal(review.mode, "SHADOW");
  assert.equal(review.forwardStats, null);
  assert.equal(review.dailyStats, null);
  assert.equal(brainPermission(fixture().definition, undefined, START).allowed, false);
});

test("positive complete forward evidence earns exact identity permission with an immutable proof", () => {
  const input = fixture(), review = evaluateBrainEvidence(input);
  assert.equal(review.mode, "PAPER_ACTIVE", review.reasons.join(", "));
  assert.equal(review.route, "FORWARD_ONLY");
  assert.equal(review.forwardCount, 40);
  assert.equal(review.dailyStats?.trials, 39);
  assert.ok(review.forwardStats!.blockMs >= 10 * DAY);
  assert.ok(review.forwardStats!.low > 0);
  assert.equal(brainPermission(input.definition, review, input.nowMs).allowed, true);
  assert.throws(() => { review.reasons.push("tamper"); });
  input.outcomes[0].netR = -100;
  assert.equal(brainPermission(input.definition, review, input.nowMs).allowed, true);
});

test("future portfolio marks cannot qualify an otherwise positive evidence review", () => {
  const input = fixture();
  input.portfolio.equity.forEach(row => { row.atMs += 1000 * DAY; });
  const review = evaluateBrainEvidence(input);
  assert.equal(review.mode, "SHADOW");
  assert.ok(review.reasons.includes("INELIGIBLE_PORTFOLIO_REVIEW"));
});

test("entry and exit observations must be available by their respective modeled fills", () => {
  for (const executionIndex of [0, 1]) {
    const input = fixture();
    input.outcomes.forEach(row => { row.executions[executionIndex].availableAtMs = input.nowMs; });
    const review = evaluateBrainEvidence(input);
    assert.equal(review.mode, "SHADOW");
    assert.ok(review.reasons.includes("OUTCOME_IDENTITY_CLOCK_OR_COST_COVERAGE"));
  }
});

test("quote observations received before a fill remain causal and later funding receipts can reconcile", () => {
  const input = fixture();
  const held = input.outcomes[0];
  held.closedAtMs += DAY / 4;
  held.availableAtMs = held.closedAtMs + 100;
  held.executions[1].atMs = held.closedAtMs;
  held.executions[1].availableAtMs = held.closedAtMs;
  const settlementAtMs = held.openedAtMs + 8 * 3_600_000;
  held.funding.push({ atMs: settlementAtMs, availableAtMs: settlementAtMs + 100,
    sourceHash: SOURCE, actualRate: 0.0001, mark: 100, intervalMinutes: 480 });
  input.outcomes.forEach(row => {
    row.executions.forEach(execution => { execution.availableAtMs -= 10; });
  });
  assert.equal(evaluateBrainEvidence(input).mode, "PAPER_ACTIVE");
});

test("staged protective reductions retain each causal execution observation through final completion", () => {
  const input = fixture();
  input.outcomes.forEach(row => {
    const atMs = (row.openedAtMs + row.closedAtMs) / 2;
    row.executions.splice(1, 0, { atMs, availableAtMs: atMs, sourceHash: SOURCE, halfSpreadBps: 1, depthNotionalUsdt: 50000 });
  });
  assert.equal(evaluateBrainEvidence(input).mode, "PAPER_ACTIVE");
  input.outcomes[0].executions[1].atMs = input.outcomes[0].openedAtMs;
  input.outcomes[0].executions[1].availableAtMs = input.outcomes[0].openedAtMs;
  assert.equal(evaluateBrainEvidence(input).mode, "SHADOW");
});

test("old runs, mismatched identities, source gaps and missing critical costs cannot promote", () => {
  for (const mutate of [
    (x: BrainEvidenceInput) => { x.outcomes[0].runId = "old-run"; },
    (x: BrainEvidenceInput) => { x.outcomes[0].identityHash = "other-asset"; },
    (x: BrainEvidenceInput) => { x.outcomes[0].costHash = "other-costs"; },
    (x: BrainEvidenceInput) => { x.outcomes[0].sourceHash = ""; },
    (x: BrainEvidenceInput) => { x.outcomes[0].executions.pop(); },
    (x: BrainEvidenceInput) => { x.outcomes[0].fundingIntervalMs = 0; },
    (x: BrainEvidenceInput) => { x.dailyReturns.splice(3, 1); },
    (x: BrainEvidenceInput) => { x.trials.pop(); },
    (x: BrainEvidenceInput) => { x.registration.costs.stress.spreadMultiplier = 1; },
  ]) {
    const input = fixture(); mutate(input);
    assert.equal(evaluateBrainEvidence(input).mode, "SHADOW");
  }
});

test("permission rejects asset, config, risk relabels, stale proof and proof mutation", () => {
  const input = fixture(), review = evaluateBrainEvidence(input);
  for (const delta of [{ asset: "ETH" }, { configHash: "new" }, { riskBucket: "other" }])
    assert.equal(brainPermission({ ...input.definition, ...delta } as BrainDefinition, review, input.nowMs).allowed, false);
  assert.equal(brainPermission(input.definition, review, review.expiresAtMs).allowed, false);
  assert.equal(brainPermission(input.definition, { ...review, riskTier: "ESCALATED" }, input.nowMs).allowed, false);
  assert.equal(evaluateBrainEvidence({ ...input, expiresAtMs: input.nowMs + DAY + 1 }).mode, "SHADOW");
});

test("thirty completions need thirty calendar days and overlapping positions are not extra trials", () => {
  const input = fixture(30);
  assert.equal(evaluateBrainEvidence(input).mode, "PAPER_ACTIVE");
  input.outcomes = input.outcomes.map((x, i) => ({ ...x, openedAtMs: START + DAY, closedAtMs: START + 2 * DAY, positionId: `overlap-${i}` }));
  const review = evaluateBrainEvidence(input);
  assert.equal(review.mode, "SHADOW");
  assert.equal(review.forwardCount, 1);
  assert.equal(review.forwardStats, null);
  assert.equal(review.dailyStats, null);
});

test("negative netR, missing funding boundaries and portfolio drawdown reject otherwise positive evidence", () => {
  const negative = fixture(); negative.outcomes.forEach(x => { x.netR = -0.5; });
  assert.equal(evaluateBrainEvidence(negative).mode, "SHADOW");
  const funding = fixture(); funding.outcomes[0].closedAtMs += DAY;
  assert.equal(evaluateBrainEvidence(funding).mode, "SHADOW");
  const dd = fixture(); dd.portfolio.equity[1].equityUsdt = 8_999;
  assert.equal(evaluateBrainEvidence(dd).mode, "REDUCE_ONLY");
});

test("positive daily autocorrelation lowers effective observations without trade annualization", () => {
  const input = fixture(100);
  input.dailyReturns.forEach((row, i) => { row.netReturn = 0.002 + 0.001 * Math.sin(i / 10); });
  const stats = evaluateBrainEvidence(input).dailyStats!;
  assert.ok(stats.effectiveDays < stats.days / 2);
  assert.ok(stats.sharpePerDay > 0 && stats.sharpePerDay < 5);
  assert.equal(stats.annualisedSharpe, null);
});

test("fifteen losing paper completions retire permanently, including after a fresh positive review", () => {
  const input = fixture(); input.outcomes.slice(0, 15).forEach(x => { x.origin = "PAPER"; x.netR = -1; x.stressedNetR = -1.2; });
  const retired = evaluateBrainEvidence(input);
  assert.equal(retired.mode, "RETIRED");
  const next = fixture(); next.previousReview = retired;
  assert.equal(evaluateBrainEvidence(next).mode, "RETIRED");
});

test("streak rearm requires fifteen new non-overlapping post-halt outcomes and integrity restoration", () => {
  const input = fixture();
  input.halt = { kind: "STREAK", atMs: input.outcomes[25].closedAtMs, sourceHash: SOURCE };
  assert.equal(evaluateBrainEvidence(input).mode, "REDUCE_ONLY");
  input.halt.atMs = input.outcomes[24].closedAtMs;
  const rearmed = evaluateBrainEvidence(input);
  assert.equal(rearmed.rearmed, true);
  assert.equal(rearmed.mode, "PAPER_ACTIVE");
  input.portfolio.unresolvedBreaker = true;
  assert.equal(evaluateBrainEvidence(input).mode, "REDUCE_ONLY");
  input.halt.kind = "DRAWDOWN";
  input.portfolio.unresolvedBreaker = false;
  assert.equal(evaluateBrainEvidence(input).mode, "REDUCE_ONLY");
});

test("risk escalation needs thirty additional paper positions in a distinct saved review", async () => {
  const input = fixture(71), baseInput = fixture(40), base = evaluateBrainEvidence(baseInput);
  const values = new Map<string, string>();
  const redis: EvidenceRedis = { get: async key => values.get(key) ?? null,
    set: async (key, value, options) => { if (options?.nx && values.has(key)) return null; values.set(key, value); return "OK"; } };
  await registerBrain(redis, input.definition, input.registration);
  await saveBrainReview(redis, base);
  input.previousReview = (await readBrainReview(redis, input.definition, input.registration))!; input.activatedAtMs = baseInput.nowMs;
  input.outcomes.slice(41).forEach(x => { x.origin = "PAPER" as typeof x.origin; });
  input.escalation = true; input.portfolio.riskFraction = 0.005;
  const review = evaluateBrainEvidence(input);
  assert.equal(review.riskTier, "ESCALATED");
  assert.equal(brainPermission(input.definition, review, input.nowMs).allowed, false, "escalation requires saving separately");
  await saveBrainReview(redis, review);
  assert.equal(brainPermission(input.definition, (await readBrainReview(redis, input.definition, input.registration))!, input.nowMs).allowed, true);
});

test("historical qualification needs two purged complete folds and fifteen forward completions", () => {
  const input = fixture(45);
  const original = input.registration;
  original.folds = [0, 1].map(i => ({ foldId: `fold-${i}`, trainEndMs: START - 50 * DAY, validationEndMs: START - 30 * DAY,
    evaluationStartMs: START + (1 + 40 * i) * DAY, evaluationEndMs: START + (31 + 40 * i) * DAY,
    embargoMs: 10 * DAY, purged: true, declaredAtMs: START }));
  input.outcomes.slice(0, 30).forEach((x, i) => {
    x.origin = "HISTORICAL"; x.foldId = `fold-${i < 15 ? 0 : 1}`;
    if (i >= 15) { const shift = 10 * DAY; x.openedAtMs += shift; x.closedAtMs += shift; x.availableAtMs += shift;
      x.executions.forEach(e => { e.atMs += shift; e.availableAtMs += shift; }); }
  });
  // Put forward observations after the locked historical evaluation, over four hold blocks.
  input.outcomes.slice(30).forEach((x, i) => {
    const shift = (20 + 2 * i) * DAY; x.openedAtMs += shift; x.closedAtMs += shift; x.availableAtMs += shift;
    x.executions.forEach(e => { e.atMs += shift; e.availableAtMs += shift; });
  });
  input.nowMs += 60 * DAY; input.expiresAtMs = input.nowMs + DAY;
  const identity = brainEvidenceIdentity(input.definition, original);
  input.outcomes.forEach(x => { x.identityHash = identity; }); input.portfolio.identityHash = identity;
  input.portfolio.equity[1].atMs = input.nowMs;
  const template = input.dailyReturns[0];
  input.dailyReturns = Array.from({ length: 150 }, (_, i) => ({ ...template, identityHash: identity,
    dayStartMs: START + i * DAY, availableAtMs: START + (i + 1) * DAY, netReturn: i % 2 ? 0.003 : 0.001 }));
  const review = evaluateBrainEvidence(input);
  assert.equal(review.mode, "PAPER_ACTIVE", review.reasons.join(", "));
  assert.equal(review.route, "HISTORICAL");
  input.outcomes.pop();
  assert.equal(evaluateBrainEvidence(input).mode, "SHADOW");
});

test("proof cannot cross run boundaries and invalid expiry cannot regain permission", () => {
  const input = fixture(), review = evaluateBrainEvidence(input);
  assert.equal(brainPermission(input.definition, review, input.nowMs, { runId: "new-run" }).allowed, false);
  const bad = { ...input, expiresAtMs: NaN };
  assert.equal(brainPermission(input.definition, evaluateBrainEvidence(bad), input.nowMs).allowed, false);
});

test("scoped registry preserves immutable registration and review proofs and terminal retirement", async () => {
  const values = new Map<string, string>();
  const redis: EvidenceRedis = { get: async key => values.get(key) ?? null,
    set: async (key, value, options) => { if (options?.nx && values.has(key)) return null; values.set(key, value); return "OK"; } };
  const input = fixture();
  await registerBrain(redis, input.definition, input.registration);
  const review = evaluateBrainEvidence(input);
  await saveBrainReview(redis, review);
  const read = await readBrainReview(redis, input.definition, input.registration);
  assert.equal(read?.proofHash, review.proofHash);
  await assert.rejects(registerBrain(redis, input.definition, { ...input.registration, sourceHash: "b".repeat(64) }));
  assert.ok([...values.keys()].every(x => x.startsWith("brain:v6:")));
  await saveBrainReview(redis, review);
  const latest = [...values.keys()].find(x => x.includes(":latest:"))!;
  values.set(latest, "b".repeat(64));
  values.set(`brain:v6:run:run-a:proof:${"b".repeat(64)}`, "not-json");
  assert.equal(await readBrainReview(redis, input.definition, input.registration), null);
});

test("unregistered and altered proof persistence fails closed and retirement survives run and label changes", async () => {
  const values = new Map<string, string>();
  const redis: EvidenceRedis = { get: async key => values.get(key) ?? null,
    set: async (key, value, options) => { if (options?.nx && values.has(key)) return null; values.set(key, value); return "OK"; } };
  const input = fixture(), active = evaluateBrainEvidence(input);
  await assert.rejects(saveBrainReview(redis, active));
  await registerBrain(redis, input.definition, input.registration);
  await assert.rejects(saveBrainReview(redis, { ...active, forwardCount: 999 }));
  input.outcomes.slice(0, 15).forEach(x => { x.origin = "PAPER"; x.netR = -1; x.stressedNetR = -1.2; });
  const retired = evaluateBrainEvidence(input);
  await saveBrainReview(redis, retired);
  await assert.rejects(saveBrainReview(redis, active));
  await assert.rejects(registerBrain(redis, { ...input.definition, strategyId: "cosmetic-new-id", configHash: "new-label" },
    { ...input.registration, runId: "new-run" }));
});

test("stressed outcomes cannot improve netR, and a malformed previous proof cannot qualify", () => {
  const input = fixture(); input.outcomes[0].stressedNetR = 10;
  assert.equal(evaluateBrainEvidence(input).mode, "SHADOW");
  const second = fixture(); second.previousReview = { ...evaluateBrainEvidence(second), proofHash: "bad" };
  assert.equal(evaluateBrainEvidence(second).mode, "SHADOW");
});

test("drawdown latch survives positive evidence after persisted run recovery", async () => {
  const values = new Map<string, string>();
  const redis: EvidenceRedis = { get: async key => values.get(key) ?? null,
    set: async (key, value, options) => { if (options?.nx && values.has(key)) return null; values.set(key, value); return "OK"; } };
  const input = fixture(), positive = evaluateBrainEvidence(input);
  await registerBrain(redis, input.definition, input.registration);
  input.halt = { kind: "DRAWDOWN", atMs: input.nowMs - DAY, sourceHash: SOURCE };
  await saveBrainReview(redis, evaluateBrainEvidence(input));
  await assert.rejects(saveBrainReview(redis, positive));
  assert.equal((await readBrainReview(redis, input.definition, input.registration))?.mode, "REDUCE_ONLY");
});

test("risk escalation cannot downgrade terminal or suspended states and omitting a streak halt does not clear it", () => {
  const input = fixture(); input.halt = { kind: "DRAWDOWN", atMs: input.nowMs - DAY, sourceHash: SOURCE };
  input.escalation = true; input.portfolio.riskFraction = 0.005;
  assert.equal(evaluateBrainEvidence(input).mode, "REDUCE_ONLY");
  const streak = fixture(); streak.halt = { kind: "STREAK", atMs: streak.nowMs - DAY, sourceHash: SOURCE };
  const halted = evaluateBrainEvidence(streak);
  const later = fixture(); later.previousReview = halted;
  assert.equal(evaluateBrainEvidence(later).mode, "REDUCE_ONLY");
});

test("thirty tightly spaced completions do not replace thirty days of forward observation", () => {
  const input = fixture(30);
  input.outcomes.forEach((x, i) => { const shift = -i * DAY; x.openedAtMs += shift; x.closedAtMs += shift; x.availableAtMs += shift;
    x.executions.forEach(e => { e.atMs += shift; e.availableAtMs += shift; }); });
  const review = evaluateBrainEvidence(input);
  assert.equal(review.forwardCount, 30);
  assert.equal(review.mode, "SHADOW");
});
