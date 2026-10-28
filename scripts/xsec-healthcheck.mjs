import { pathToFileURL } from 'node:url';

/** Retirement is healthy only for an acknowledged, current replacement epoch. */
export function evaluateXsecHealth({ active, mode, acknowledged, replacement, portfolio, equity, lastRebalanceAt, commit, nowMs }) {
  if (active !== null || mode !== null) {
    const age = nowMs - Number(replacement?.generatedAtMs);
    return Boolean(active && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(active.runId) &&
      active.brainVersion === 'replacement-swing-v6-2026-10-24' && active.initialCapital === 10000 &&
      Number.isFinite(Date.parse(active.startedAt)) && Date.parse(active.startedAt) <= nowMs &&
      mode === 'HISTORICAL_ONLY' && acknowledged === true && replacement?.version === 'v6' &&
      replacement.runId === active.runId && ['SHADOW', 'PAPER_ACTIVE', 'REDUCE_ONLY'].includes(replacement.mode) &&
      commit && commit !== 'unknown' && replacement.commit === commit && Number.isSafeInteger(replacement.scanId) && replacement.scanId > 0 &&
      Number.isFinite(replacement.generatedAtMs) && Number.isFinite(age) && age >= 0 && age < 180000 && portfolio?.positions &&
      !Array.isArray(portfolio.positions) && Object.keys(portfolio.positions).length === 0 &&
      Number.isFinite(portfolio.cashUsd) && portfolio.cashUsd >= 0 &&
      (portfolio.fundingTail === undefined || Array.isArray(portfolio.fundingTail) && portfolio.fundingTail.length === 0) &&
      (portfolio.pendingLedgerEvents === undefined || Array.isArray(portfolio.pendingLedgerEvents) && portfolio.pendingLedgerEvents.length === 0));
  }
  const age = nowMs - Number(lastRebalanceAt);
  return Boolean(equity && Number.isFinite(age) && age >= 0 && age < 13 * 3600000);
}

async function main() {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(process.env.REDIS_URL);
  const decode = value => value === null ? null : JSON.parse(value);
  try {
    const [rawActive, rawMode, rawReplacement, rawPortfolio, equity, lastRebalanceAt] = await redis.mget(
      'brain:v6:activeRun', 'brain:v6:xsecMode', 'brain:v6:status', 'xsec:portfolio', 'xsec:equity', 'xsec:lastRebalanceAt');
    const active = decode(rawActive);
    const acknowledged = active?.runId ? decode(await redis.get(`brain:v6:run:${active.runId}:ledgerAcknowledged`)) : null;
    process.exitCode = evaluateXsecHealth({ active, mode: rawMode, acknowledged, replacement: decode(rawReplacement),
      portfolio: decode(rawPortfolio), equity, lastRebalanceAt, commit: process.env.APP_COMMIT_SHA, nowMs: Date.now() }) ? 0 : 1;
  } catch {
    process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
