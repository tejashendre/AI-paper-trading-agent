// Read-only health check against the public spectator endpoints. A scheduled
// GitHub workflow runs it; a non-zero exit fails the run and GitHub emails the
// repository owner. No new service and no secret: SPECTATOR is the public token.
import { pathToFileURL } from "node:url";

const MINUTE = 60_000;
const TRADFI = new Set(["forex", "commodity"]);

/** Underlying FX and commodity markets close from Friday 21:00 to Sunday 22:00 UTC. */
export function tradfiWeekend(nowMs) {
  const now = new Date(nowMs);
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  return (day === 5 && hour >= 21) || day === 6 || (day === 0 && hour < 22);
}

/** Returns one plain-English line per problem; an empty list means healthy. */
export function evaluateHealth({ status, book, brain, nowMs }) {
  const problems = [];
  const age = (iso) => {
    const elapsed = iso ? nowMs - new Date(iso).getTime() : NaN;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : Infinity;
  };

  const scan = status?.swingScan;
  const replacement = scan?.brainVersion === 'v6' || brain?.version === 'v6';
  const weekend = tradfiWeekend(nowMs);
  if (age(scan?.completedAt) > 5 * MINUTE) problems.push(`Swing scan is stale: last completed ${scan?.completedAt ?? "never"}.`);
  if (Number(scan?.summary?.ERROR) > 0) problems.push(`Swing scan reported ${scan.summary.ERROR} asset error(s).`);
  if (age(status?.executionLedger?.lastEventAt) > 10 * MINUTE) {
    problems.push(`Execution ledger has had no event since ${status?.executionLedger?.lastEventAt ?? "never"}.`);
  }
  if (!replacement && Number(status?.researchQueue?.rejectedNew) > 0) {
    problems.push(`Research queue is full and dropped ${status.researchQueue.rejectedNew} new observation(s).`);
  }

  // A breaker that never releases looks healthy everywhere else. Only alert
  // while the whole bot has gone 96h without a fill: the 72h cool-off after
  // a probation loss, with margin, so a normal cool-off never alerts.
  const coverageList = status?.assetCoverage ?? [];
  const lastFillMs = Math.max(0, ...coverageList.map((coverage) => new Date(coverage?.lastFillAt ?? 0).getTime() || 0));
  for (const coverage of !replacement && nowMs - lastFillMs > 96 * 60 * MINUTE ? coverageList : []) {
    const funnel = coverage?.funnel7d ?? {};
    if (Number(funnel.costPass) >= 20 && Number(funnel.riskPass) === 0) {
      const vetoes = Object.entries(funnel).filter(([key]) => key.startsWith("veto:") && key !== "veto:NO_SETUP").sort((a, b) => b[1] - a[1]);
      problems.push(`${coverage.asset}: ${funnel.costPass} candidates passed cost checks in 7 days and risk gates blocked all of them (top veto ${vetoes[0]?.[0]?.slice(5) ?? "unknown"}).`);
    }
  }

  let retiredXsec = false;
  if (replacement) {
    if (!status?.deployment?.commit || scan?.runtimeCommit !== status.deployment.commit ||
      !Number.isSafeInteger(scan?.scanId) || scan.scanId <= 0) problems.push('Replacement scan has no matching release or durable progress.');
    const waiting = scan?.mode === 'RESET_REQUIRED' && scan?.runId === null && brain?.mode === 'RESET_REQUIRED' && brain?.currentRun === null;
    if (!waiting) {
      const runId = brain?.currentRun?.runId;
      const matching = brain?.version === 'v6' && typeof runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId) &&
        runId === scan?.runId && brain?.currentRun?.initialCapitalUsdt === 10000;
      if (!matching || brain?.telemetry?.state !== 'FRESH' || age(brain?.generatedAt) > 3 * MINUTE ||
        !['SHADOW', 'PAPER_ACTIVE', 'REDUCE_ONLY'].includes(brain?.mode)) problems.push('Replacement epoch telemetry is unavailable, stale, mismatched or in error.');
      retiredXsec = matching && brain?.telemetry?.state === 'FRESH' && age(brain?.generatedAt) <= 3 * MINUTE &&
        ['SHADOW', 'PAPER_ACTIVE', 'REDUCE_ONLY'].includes(brain?.mode) && brain?.history?.xsecMode === 'HISTORICAL_ONLY' && brain?.history?.allocatedCapitalUsdt === 0;
      if (retiredXsec && (!Array.isArray(book?.positions) || book.positions.length)) problems.push('Retired cross-sectional book is unavailable or still holds positions.');
      if (!Number.isFinite(brain?.account?.cashUsdt) || brain.account.cashUsdt < 0 || !Number.isFinite(brain?.account?.equityUsdt) ||
        status?.aiPortfolio?.initialCapital !== 10000) problems.push('Replacement account capital or marked equity is unavailable or invalid.');
      for (const reason of brain?.risk?.haltReasons ?? []) problems.push(`Replacement risk halt: ${reason}.`);
      if (!Array.isArray(brain?.assets) || !brain.assets.length) problems.push('Replacement asset telemetry is missing.');
      for (const asset of brain?.assets ?? []) {
        const closed = weekend && TRADFI.has(status?.feedHealthMatrix?.assets?.find(feed => feed.asset === asset.asset)?.category);
        if (asset.mode === 'UNAVAILABLE' || !asset.decision || asset.decision.status === 'ERROR' ||
          asset.decision.code === 'REGISTRATION_MISMATCH' || !closed && ['CAPTURE_FAILED', 'INVALID_CAPTURE'].includes(asset.decision.code)) problems.push(`${asset.asset} replacement source or strategy telemetry is unavailable.`);
      }
    }
    if (!status?.feedHealthMatrix?.assets?.length) problems.push('Replacement feed health is missing.');
    const portfolio = status?.aiPortfolio;
    const held = Object.values(portfolio?.openPositions ?? {});
    if (!waiting || held.length) {
      const sweep = status?.lastExitSweep;
      if (age(sweep?.timestamp) > MINUTE || Number(sweep?.errors) !== 0 ||
        !['REPLACEMENT_SWING_WATCHDOG', 'REPLACEMENT_SWING_HALT', 'V6_LEGACY_PROTECTION'].includes(sweep?.source)) problems.push('Replacement protective exit sweep is stale, missing or reported errors.');
    }
    if (portfolio?.pendingLedgerEvents?.length || portfolio?.fundingTail?.some(tail => tail.pendingTimes?.length) ||
      held.some(position => position.fundingPendingTimes?.length)) problems.push('Replacement funding or financial ledger reconciliation is pending.');
  }

  for (const asset of status?.feedHealthMatrix?.assets ?? []) {
    if (weekend && TRADFI.has(asset.category)) continue;
    const quoteMs = Number(asset?.dataEligibility?.quoteEventTimeMs);
    if (!Number.isFinite(quoteMs) || nowMs - quoteMs > 10 * MINUTE) {
      problems.push(`${asset.asset} quote is older than 10 minutes.`);
    }
  }

  if (!retiredXsec && book?.rebalanceSchedule?.overdue === true) problems.push("Cross-sectional book rebalance is overdue.");
  return problems;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Authorization: "Bearer SPECTATOR" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const base = process.env.MONITOR_BASE_URL || "https://trader.tejashendre.com";
  let problems;
  try {
    const [status, book] = await Promise.all([fetchJson(`${base}/api/user/status`), fetchJson(`${base}/api/book`)]);
    const brain = status?.swingScan?.brainVersion === 'v6' ? await fetchJson(`${base}/api/brain`) : undefined;
    console.log(`Deployed commit ${status?.deployment?.commit ?? "unknown"}; scan ${status?.swingScan?.completedAt ?? "none"}.`);
    problems = evaluateHealth({ status, book, brain, nowMs: Date.now() });
  } catch (error) {
    problems = [`Dashboard unreachable: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (problems.length === 0) {
    console.log("Healthy.");
    return;
  }
  for (const problem of problems) console.error(`ALERT: ${problem}`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
