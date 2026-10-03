/**
 * The halted cross-sectional book releases itself only on its own shadow
 * evidence, and a released book halts again on a much smaller further loss.
 * Before this, nothing produced the release verdict, and a flat book's
 * drawdown was frozen above the breaker, so it could never come back.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { epochDrawdownPercent, evaluateBookRisk, evaluateShadowEvidence, PROMOTION_EVIDENCE_PASSED } from "@/lib/execution/bookRiskPolicy";
import type { EquityPoint } from "@/lib/execution/equityCurve";
import { CONFIGURED_ASSETS, CONFIGURED_INSTRUMENTS } from "@/lib/trading/instrumentRegistry";
import { MemoryRedis } from "./helpers/memoryRedis";
import { createVenue, installVenue, minuteBars } from "./helpers/fakeBybitVenue";

const HOUR = 3_600_000;
/** A shadow curve sampled every 12h from `start` with the given per-period returns. */
function curve(returns: number[], start = 10_000): EquityPoint[] {
  const t0 = Date.UTC(2026, 9, 1);
  let equity = start;
  const points: EquityPoint[] = [{ at: new Date(t0).toISOString(), equityUsd: equity, realizedEquityUsd: equity }];
  returns.forEach((r, i) => {
    equity *= 1 + r;
    points.push({ at: new Date(t0 + (i + 1) * 12 * HOUR).toISOString(), equityUsd: equity, realizedEquityUsd: equity });
  });
  return points;
}
const steady = (n: number) => Array.from({ length: n }, (_, i) => 0.004 + (i % 3 === 0 ? -0.002 : 0.001));

describe("shadow evidence for an autonomous release", () => {
  it("needs at least 30 periods (15 days)", () => {
    const result = evaluateShadowEvidence(curve(steady(29)));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some((r) => r.startsWith("INSUFFICIENT_SHADOW_PERIODS")), result.reasons.join(";"));
  });

  it("passes a consistently positive shadow book with a small drawdown", () => {
    const result = evaluateShadowEvidence(curve(steady(40)));
    assert.equal(result.passed, true, result.reasons.join(";"));
  });

  it("rejects a shadow book without an established positive mean", () => {
    const noise = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.0102));
    const result = evaluateShadowEvidence(curve(noise));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some((r) => r.startsWith("SHADOW_EDGE_NOT_ESTABLISHED")));
  });

  it("rejects a shadow book whose own drawdown is too deep", () => {
    const deep = [...steady(20), -0.09, -0.09, ...steady(25)];
    const result = evaluateShadowEvidence(curve(deep));
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some((r) => r.startsWith("SHADOW_DRAWDOWN")));
  });
});

describe("release and re-arm", () => {
  const flat = {
    previous: "SHADOW" as const, lifetimeMaxDrawdownPercent: 28.15, currentDrawdownPercent: 26.52,
    hasOpenPositions: false, entryDataReady: true, exitDataReady: true, releaseAuthorized: true,
    edgeVerdict: PROMOTION_EVIDENCE_PASSED,
  };

  it("a flat book whose drawdown is frozen above the breaker can still be released on evidence", () => {
    assert.equal(evaluateBookRisk(flat).state, "ACTIVE");
    assert.equal(evaluateBookRisk({ ...flat, edgeVerdict: "NO_ESTABLISHED_EDGE" }).state, "SHADOW");
  });

  it("after release, drawdown is measured from the release epoch's peak", () => {
    const epoch = { releaseEquityUsd: 8421, epochPeakEquityUsd: 9000 };
    assert.equal(epochDrawdownPercent(epoch, 9000), 0);
    assert.equal(+epochDrawdownPercent(epoch, 8100).toFixed(4), 10);
  });

  it("a released book halts again once its lifetime drawdown deepens past the acknowledged level", () => {
    const released = { ...flat, previous: "ACTIVE" as const, breachAcknowledgedAtPercent: 28.15, currentDrawdownPercent: 2, hasOpenPositions: true };
    assert.equal(evaluateBookRisk({ ...released, lifetimeMaxDrawdownPercent: 28.15 }).state, "ACTIVE");
    assert.equal(evaluateBookRisk({ ...released, lifetimeMaxDrawdownPercent: 28.2 }).state, "REDUCE_ONLY");
  });
});

describe("the daemon releases the halted book by itself", () => {
  const originalCwd = process.cwd();
  let restore: () => void;
  let m: {
    xsec: typeof import("@/daemon/crossSectionalDaemon");
    redis: typeof import("@/lib/redis");
    book: typeof import("@/lib/execution/bookRebalancer");
  };

  before(async () => {
    process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "xsec-autonomy-")));
    process.env.EXECUTION_LEDGER_DIR = path.join(process.cwd(), "ledger");
    const venue = createVenue(Date.now());
    for (const asset of CONFIGURED_ASSETS) venue.series.set(CONFIGURED_INSTRUMENTS[asset].symbol, minuteBars(100, 0, Date.now(), 400));
    restore = installVenue(venue).restore;
    m = {
      xsec: await import("@/daemon/crossSectionalDaemon"),
      redis: await import("@/lib/redis"),
      book: await import("@/lib/execution/bookRebalancer"),
    };
  });
  after(() => {
    restore();
    m.redis.setRedisClient(null);
    process.chdir(originalCwd);
  });

  async function haltedBook(memory: MemoryRedis, shadowReturns: number[]) {
    m.redis.setRedisClient(memory);
    const book = await m.book.loadBookPortfolio();
    book.cashUsd = 8421.34;
    book.peakEquityUsd = 11460.59;
    book.maxDrawdownPercent = 28.15;
    book.riskState = { state: "SHADOW", reasons: [], allowEntries: false, allowReductions: false, policyVersion: "test", updatedAt: new Date().toISOString() };
    await m.book.saveBookPortfolio(book);
    for (const point of curve(shadowReturns)) await memory.lpush(m.book.SHADOW_BOOK_EQUITY_CURVE_KEY, JSON.stringify(point));
  }

  it("writes its own release and goes ACTIVE when shadow evidence passes", async () => {
    const memory = new MemoryRedis();
    await haltedBook(memory, steady(40));
    await m.xsec.runRebalance();
    const release = await memory.get<{ authorizedBy?: string; documentedAt?: string; evidence?: unknown }>("xsec:riskRelease");
    assert.equal(release?.authorizedBy, "AUTONOMOUS_EVIDENCE_GATE");
    assert.ok(release?.documentedAt && release.evidence);
    assert.ok(Array.isArray((release as any).evidenceCurve), 'release must retain its exact shadow curve');
    assert.deepEqual(evaluateShadowEvidence((release as any).evidenceCurve), release.evidence);
    const book = await m.book.loadBookPortfolio();
    assert.equal(book.riskState?.state, "ACTIVE", (book.riskState?.reasons ?? []).join(" "));
    assert.equal(book.riskState?.breachAcknowledgedAtPercent, 28.15);
    assert.equal(Math.round(book.riskState?.releaseEpoch?.releaseEquityUsd ?? 0), 8421);
  });

  it('cannot publish a risk release before its durable proof is written and retries after recovery', async () => {
    const memory = new MemoryRedis(); await haltedBook(memory, steady(40));
    const original = process.env.EXECUTION_LEDGER_DIR;
    const unavailable = path.join(process.cwd(), 'unavailable'); fs.writeFileSync(unavailable, 'fixture');
    process.env.EXECUTION_LEDGER_DIR = unavailable;
    try {
      await m.xsec.runRebalance();
      assert.equal(await memory.get('xsec:riskRelease'), null);
      assert.equal((await m.book.loadBookPortfolio()).riskState?.state, 'SHADOW');
    } finally { process.env.EXECUTION_LEDGER_DIR = original; }
    await m.xsec.runRebalance();
    assert.equal((await memory.get<any>('xsec:riskRelease'))?.authorizedBy, 'AUTONOMOUS_EVIDENCE_GATE');
  });

  it("stays halted and writes nothing when shadow evidence is weak", async () => {
    const memory = new MemoryRedis();
    await haltedBook(memory, steady(10));
    await m.xsec.runRebalance();
    assert.equal(await memory.get("xsec:riskRelease"), null);
    assert.equal((await m.book.loadBookPortfolio()).riskState?.state, "SHADOW");
  });
});
