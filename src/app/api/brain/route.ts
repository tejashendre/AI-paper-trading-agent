import path from 'node:path';
import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { getRedis } from '@/lib/redis';
import { activeAiRun, aiRunKeys, previewAiRunReset, REPLACEMENT_BRAIN_VERSION } from '@/lib/admin/resetAiRun';
import { brainDefinition } from '@/lib/strategy/v6/engine';
import { CONFIGURED_ASSETS } from '@/lib/trading/instrumentRegistry';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
// Telemetry is an allowlisted view, never a serialized internal runtime object.
const text = (value: unknown): string | null => typeof value === 'string' && value.length <= 240 &&
  !/[\\/\u2014]|(?:secret|token|password|\.env|99_PRIVATE)/i.test(value) ? value : null;
const reasons = (value: unknown): string[] => Array.isArray(value) ? value.slice(0, 20).map(text).filter((x): x is string => x !== null) : [];
const assetModes = ['DISABLED', 'WARMING_UP', 'SHADOW', 'VALIDATION_READY', 'PAPER_ACTIVE', 'REDUCE_ONLY', 'RETIRED'];
const runtimeModes = ['RESET_REQUIRED', 'SHADOW', 'PAPER_ACTIVE', 'REDUCE_ONLY', 'ERROR'];

/** Public read-only projection. Never initialize accounts, evaluate evidence, or reset on a GET. */
export async function GET(_request: Request) {
  try {
    const redis = getRedis();
    const active = await activeAiRun(redis);
    const validRun = active && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(active.runId) &&
      active.brainVersion === REPLACEMENT_BRAIN_VERSION && active.initialCapital === 10000 &&
      Number.isFinite(Date.parse(active.startedAt)) ? active : null;
    const [rawStatus, rawPortfolio] = await Promise.all([
      redis.get<unknown>('brain:v6:status'),
      validRun ? redis.get<unknown>(aiRunKeys(validRun.runId).portfolio) : Promise.resolve(null),
    ]);
    const runtime = record(rawStatus), portfolio = record(rawPortfolio);
    const age = Date.now() - (number(runtime.generatedAtMs) ?? 0);
    const fresh = Boolean(validRun && runtime.version === 'v6' && runtime.runId === validRun.runId && age >= 0 && age <= 180000);
    const portfolioAvailable = rawPortfolio !== null && number(portfolio.usd) !== null;
    const rows = fresh && Array.isArray(runtime.assets) ? runtime.assets : [];
    const mode = !validRun ? 'RESET_REQUIRED' : !portfolioAvailable || !fresh ? 'UNAVAILABLE' :
      runtimeModes.includes(runtime.mode) ? runtime.mode : 'UNAVAILABLE';
    const grossProfit = number(portfolio.grossProfit), grossLoss = number(portfolio.grossLoss);
    return reply({
      version: 'v6', brainVersion: REPLACEMENT_BRAIN_VERSION, mode,
      generatedAt: fresh ? new Date(runtime.generatedAtMs).toISOString() : null,
      telemetry: { state: fresh ? 'FRESH' : rawStatus === null ? 'MISSING' : 'STALE_OR_DIFFERENT_RUN',
        scanId: fresh ? count(runtime.scanId) : null, scanIntervalMs: 60000, watchdogIntervalMs: 5000 },
      currentRun: validRun ? { runId: validRun.runId, startedAt: validRun.startedAt, initialCapitalUsdt: 10000,
        archiveDigest: /^[a-f0-9]{64}$/.test(validRun.archive?.sha256) ? validRun.archive.sha256 : null } : null,
      account: validRun && portfolioAvailable ? { cashUsdt: number(portfolio.usd), equityUsdt: fresh ? number(runtime.equityUsdt) : null,
        realizedPnlUsdt: number(portfolio.totalPnl), completedTrades: count(portfolio.totalTrades),
        profitFactor: grossProfit !== null && grossProfit >= 0 && grossLoss !== null && grossLoss > 0 ? grossProfit / grossLoss : null,
        feesPaidUsdt: number(portfolio.totalFeesPaid), peakEquityUsdt: number(portfolio.peakValue) } : null,
      risk: { sharedCapitalUsdt: 10000, initialRiskFraction: 0.0025, escalatedRiskFraction: 0.005,
        escalationRequiresEvidence: true, drawdownStopFraction: 0.1, aggregateOpenRiskFraction: 0.02, factorRiskFraction: 0.01,
        haltReasons: fresh ? reasons(runtime.haltReasons) : [!validRun ? 'RESET_REQUIRED' : !portfolioAvailable ? 'RUN_PORTFOLIO_UNAVAILABLE' : 'RUNTIME_TELEMETRY_UNAVAILABLE'] },
      assets: CONFIGURED_ASSETS.map(asset => {
        const definition = brainDefinition(asset);
        const matches = rows.filter((row: any) => row?.asset === asset);
        const row = record(matches.length === 1 ? matches[0] : null), evidence = record(row.evidence), decision = record(row.decision);
        // Reject mismatched definitions instead of attributing older evidence to today's brain.
        const identityMatches = row.strategyId === definition.strategyId && row.configHash === definition.configHash;
        const available = fresh && matches.length === 1 && identityMatches && portfolioAvailable;
        return { asset, strategyId: definition.strategyId, configHash: definition.configHash, riskBucket: definition.riskBucket,
          mode: !validRun ? 'DISABLED' : available && assetModes.includes(row.mode) ? row.mode : 'UNAVAILABLE',
          riskTier: available && row.riskTier === 'ESCALATED' ? 'ESCALATED' : available && row.riskTier === 'BASE' ? 'BASE' : null,
          definition: { h4Warmup: definition.parameters.h4Warmup, dailyWarmup: definition.parameters.dailyWarmup,
            targetR: definition.parameters.targetR, maxHoldDays: definition.parameters.maxHoldMs / 86400000 },
          evidence: { historicalCount: available ? count(evidence.historicalCount) : null, forwardCount: available ? count(evidence.forwardCount) : null,
            paperCount: available ? count(evidence.paperCount) : null, nextEligibleAtMs: available ? number(evidence.nextEligibleAtMs) : null,
            reasons: available ? reasons(evidence.reasons) : [!validRun ? 'RESET_REQUIRED' : 'ASSET_TELEMETRY_UNAVAILABLE'] },
          decision: available ? { status: text(decision.status), code: text(decision.code), reason: text(decision.reason) } : null };
      }),
      history: { legacyAi: 'HISTORICAL_ONLY', xsecMode: 'HISTORICAL_ONLY', allocatedCapitalUsdt: 0,
        note: 'Legacy AI and XSEC results are excluded from the current run. XSEC receives no additional capital.' },
      reset: { previewMethod: 'POST', dashboardAuthorizationRequired: true, executionAvailable: false },
    });
  } catch {
    return reply({ error: 'Brain status unavailable', mode: 'UNAVAILABLE' }, 503);
  }
}

/** Administrative preview only. Raw source/human snapshots and server paths never leave this process. */
export async function POST(request: Request) {
  try {
    const auth = verifyAuth(request);
    if (!auth.authorized || auth.source !== 'dashboard') return reply({ error: 'Dashboard authorization required' }, 403);
    let input: Record<string, any>;
    try { input = record(await request.json()); } catch { return reply({ error: 'Invalid preview request' }, 400); }
    if (input.action !== 'preview' || typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.runId) ||
      Object.keys(input).some(key => !['action', 'runId'].includes(key))) return reply({ error: 'Only a scoped reset preview is available' }, 400);
    const preview = await previewAiRunReset({ runId: input.runId, archiveDirectory: path.resolve(process.cwd(), 'data', 'ai-run-archives') });
    const blockers = [...new Set(preview.blockers.map(blocker => blocker.includes('REDUCE_ONLY') ? 'AI_OR_XSEC_POSITIONS_REQUIRE_STAGED_CLOSURE' :
      blocker.includes('liabilities') ? 'FUNDING_OR_LEDGER_SETTLEMENT_REQUIRED' : blocker.includes('Target run') ? 'RUN_ID_ALREADY_EXISTS' :
      blocker.includes('human') ? 'HUMAN_PRESERVATION_SNAPSHOT_UNAVAILABLE' : 'SOURCE_PORTFOLIO_REQUIRES_REVIEW'))];
    return reply({ version: 'v6', runId: preview.runId, capitalUsdt: preview.capital, canReset: preview.canReset, blockers,
      executionAvailable: false, counts: { archivedKeys: preview.coverage.archivedKeys.length, affectedKeys: preview.affectedKeys.length,
        evidenceNamespaces: Object.keys(preview.inventories).length },
      digests: { source: preview.sourceDigest, humanPreservation: preview.humanDigest },
      risk: { drawdownStopFraction: 0.1, initialRiskFraction: 0.0025, escalatedRiskFraction: 0.005, escalationRequiresEvidence: true },
      scope: 'AI only. Human state preserved. Legacy XSEC historical only. Release gates remain required.' });
  } catch {
    return reply({ error: 'Reset preview unavailable' }, 503);
  }
}
