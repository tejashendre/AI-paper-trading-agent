import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHealth, tradfiWeekend } from "../scripts/health-monitor.mjs";

const NOW = Date.parse("2026-10-06T12:00:00Z"); // a Tuesday
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const feed = (asset: string, category: string, minutesAgo: number) => ({ asset, category, dataEligibility: { quoteEventTimeMs: NOW - minutesAgo * 60_000 } });

function healthy() {
  return {
    status: {
      swingScan: { completedAt: iso(1), summary: { ERROR: 0 } },
      executionLedger: { lastEventAt: iso(1) },
      researchQueue: { rejectedNew: 0 },
      feedHealthMatrix: { assets: [feed("BTC", "crypto", 0.5), feed("EURUSD", "forex", 1)] },
    },
    book: { rebalanceSchedule: { overdue: false } },
  };
}

test("health monitor reports each silent failure in plain English", async (t) => {
  await t.test("a healthy system raises nothing", () => {
    assert.deepEqual(evaluateHealth({ ...healthy(), nowMs: NOW }), []);
  });

  await t.test("stale scan, quiet ledger, scan errors, full queue, stale feed and overdue rebalance all alert", () => {
    const { status, book } = healthy();
    status.swingScan = { completedAt: iso(6), summary: { ERROR: 2 } };
    status.executionLedger.lastEventAt = iso(11);
    status.researchQueue.rejectedNew = 3;
    status.feedHealthMatrix.assets[0] = feed("BTC", "crypto", 11);
    book.rebalanceSchedule.overdue = true;
    const problems: string[] = evaluateHealth({ status, book, nowMs: NOW });
    assert.equal(problems.length, 6, problems.join("\n"));
    for (const word of [/scan is stale/, /asset error/, /ledger/, /dropped 3/, /BTC quote/, /rebalance is overdue/]) {
      assert.ok(problems.some((p) => word.test(p)), `missing ${word}`);
    }
  });

  await t.test("an asset whose cost-passing candidates are all blocked by risk gates alerts", () => {
    const { status, book } = healthy();
    const coverage: Array<Record<string, unknown>> = [
      { asset: "BTC", funnel7d: { costPass: 171, riskPass: 0, "veto:NO_SETUP": 2743, "veto:PORTFOLIO_RISK_BUDGET": 171 } },
      { asset: "GOLD", funnel7d: { costPass: 5, riskPass: 1 } },
    ];
    (status as Record<string, unknown>).assetCoverage = coverage;
    assert.deepEqual(evaluateHealth({ status, book, nowMs: NOW }).length, 1);
    // Once any asset fills again the alert clears, although the 7-day funnel still remembers.
    coverage[1].lastFillAt = iso(60);
    assert.deepEqual(evaluateHealth({ status, book, nowMs: NOW }), []);
    coverage[1].lastFillAt = iso(80 * 60);
    assert.deepEqual(evaluateHealth({ status, book, nowMs: NOW }), [], "inside a cool-off plus a day: no alert");
    coverage[1].lastFillAt = iso(97 * 60);
    const problems: string[] = evaluateHealth({ status, book, nowMs: NOW });
    assert.deepEqual(problems, ["BTC: 171 candidates passed cost checks in 7 days and risk gates blocked all of them (top veto PORTFOLIO_RISK_BUDGET)."]);
  });

  await t.test("FX and commodity quotes may pause over the weekend; crypto may not", () => {
    const saturday = Date.parse("2026-10-10T12:00:00Z");
    assert.equal(tradfiWeekend(saturday), true);
    assert.equal(tradfiWeekend(NOW), false);
    const status = { ...healthy().status, swingScan: { completedAt: new Date(saturday).toISOString() }, executionLedger: { lastEventAt: new Date(saturday).toISOString() } };
    status.feedHealthMatrix = { assets: [{ asset: "EURUSD", category: "forex", dataEligibility: { quoteEventTimeMs: saturday - 3_600_000 } }, { asset: "BTC", category: "crypto", dataEligibility: { quoteEventTimeMs: saturday - 3_600_000 } }] };
    const problems: string[] = evaluateHealth({ status, book: {}, nowMs: saturday });
    assert.deepEqual(problems, ["BTC quote is older than 10 minutes."]);
  });

  await t.test("an older deployment without the rebalance schedule field is not an alert by itself", () => {
    assert.deepEqual(evaluateHealth({ status: healthy().status, book: {}, nowMs: NOW }), []);
  });
});

function replacement() {
  const base=healthy();
  const status:any={...base.status,deployment:{commit:'release'},
    swingScan:{...base.status.swingScan,brainVersion:'v6',runId:'run-one',scanId:3,mode:'SHADOW',runtimeCommit:'release'},
    researchQueue:{rejectedNew:99},assetCoverage:[{asset:'BTC',funnel7d:{costPass:50,riskPass:0}}],
    aiPortfolio:{initialCapital:10000,usd:10000,openPositions:{},fundingTail:[],pendingLedgerEvents:[]},
    lastExitSweep:{source:'REPLACEMENT_SWING_WATCHDOG',timestamp:iso(.1),errors:0}};
  const brain:any={version:'v6',mode:'SHADOW',generatedAt:iso(1),currentRun:{runId:'run-one',initialCapitalUsdt:10000},
    telemetry:{state:'FRESH',scanId:3},account:{cashUsdt:10000,equityUsdt:10000},risk:{haltReasons:[]},
    assets:[{asset:'BTC',mode:'SHADOW',decision:{status:'NO_TRADE',code:'NO_SETUP'}}],history:{xsecMode:'HISTORICAL_ONLY',allocatedCapitalUsdt:0}};
  return {status,brain,book:{positions:[],rebalanceSchedule:{overdue:true}}};
}
test('replacement SHADOW checks current epoch and sources while retired v5 funnels, queue and XSEC may be inactive',()=>{
  assert.deepEqual(evaluateHealth({...replacement(),nowMs:NOW}),[]);
});
test('replacement health fails missing, stale or mismatched telemetry and protection/funding faults',()=>{
  const fixtures=[
    (f:ReturnType<typeof replacement>)=>{f.brain=null;},
    (f:ReturnType<typeof replacement>)=>{f.brain.telemetry.state='STALE_OR_DIFFERENT_RUN';},
    (f:ReturnType<typeof replacement>)=>{f.brain.currentRun.runId='old';},
    (f:ReturnType<typeof replacement>)=>{f.status.swingScan.runtimeCommit='old';},
    (f:ReturnType<typeof replacement>)=>{f.brain.mode='ERROR';},
    (f:ReturnType<typeof replacement>)=>{f.brain.assets[0].decision.code='CAPTURE_FAILED';},
    (f:ReturnType<typeof replacement>)=>{f.brain.risk.haltReasons=['INTEGRITY'];},
    (f:ReturnType<typeof replacement>)=>{f.status.lastExitSweep.timestamp=iso(3);},
    (f:ReturnType<typeof replacement>)=>{f.status.lastExitSweep.errors=1;},
    (f:ReturnType<typeof replacement>)=>{f.status.aiPortfolio.fundingTail=[{pendingTimes:[NOW-1000]}];},
    (f:ReturnType<typeof replacement>)=>{f.status.aiPortfolio.pendingLedgerEvents=[{}];},
    (f:ReturnType<typeof replacement>)=>{f.status.feedHealthMatrix.assets=[];},
    (f:ReturnType<typeof replacement>)=>{(f.book.positions as unknown[])=[{symbol:'BTCUSDT'}];},
  ];
  for(const mutate of fixtures){const f=replacement();mutate(f);assert.ok(evaluateHealth({...f,nowMs:NOW}).length>0,mutate.toString());}
});
test('pre-reset replacement progress needs fresh durable events, with legacy XSEC still checked',()=>{
  const f=replacement();f.status.swingScan.mode='RESET_REQUIRED';f.status.swingScan.runId=null;
  f.brain={version:'v6',mode:'RESET_REQUIRED',currentRun:null};
  assert.deepEqual(evaluateHealth({...f,nowMs:NOW}),['Cross-sectional book rebalance is overdue.']);
  f.book.rebalanceSchedule.overdue=false;
  assert.deepEqual(evaluateHealth({...f,nowMs:NOW}),[]);
  f.status.executionLedger.lastEventAt=iso(11);
  assert.ok(evaluateHealth({...f,nowMs:NOW}).some((p:string)=>/ledger/.test(p)));
});
test('closed weekend TradFi execution captures may wait while crypto and integrity checks remain active',()=>{
  const f=replacement(),saturday=Date.parse('2026-10-10T12:00:00Z'),fresh=new Date(saturday-1000).toISOString();
  f.status.swingScan.completedAt=fresh;f.status.executionLedger.lastEventAt=fresh;
  f.status.lastExitSweep.timestamp=fresh;f.brain.generatedAt=fresh;
  f.status.feedHealthMatrix.assets=[{asset:'BTC',category:'crypto',dataEligibility:{quoteEventTimeMs:saturday-1000}},
    {asset:'EURUSD',category:'forex',dataEligibility:{quoteEventTimeMs:saturday-86400000}}];
  f.brain.assets.push({asset:'EURUSD',mode:'SHADOW',decision:{status:'NO_TRADE',code:'INVALID_CAPTURE'}});
  assert.deepEqual(evaluateHealth({...f,nowMs:saturday}),[]);
  f.brain.assets[1].decision.code='REGISTRATION_MISMATCH';
  assert.ok(evaluateHealth({...f,nowMs:saturday}).some((p:string)=>/EURUSD/.test(p)));
});
