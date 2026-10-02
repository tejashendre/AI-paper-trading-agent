import { createHash, randomUUID } from 'node:crypto';
import { getRedis } from '@/lib/redis';
import { CONFIGURED_ASSETS, getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import { strategyFamilyConfigHash } from '@/lib/swingEngine';
import { EXECUTION_COST_MODEL_VERSION } from '@/lib/trading/executionCostModel';
import { TRADING_STRATEGY_VERSION } from '@/lib/trading/executionLedger';
import { RISK_POLICY_VERSION, feeScheduleFor } from '@/lib/trading/assetSpecs';
import type { CompletedPositionOutcome } from '@/lib/trading/positionOutcomes';
import { CandidateDefinition, ResearchOutcome, getCandidateRegistry, registerCandidate,
  evaluatePromotion, recordPromotionReview } from './candidateRegistry';

export const RESEARCH_OUTCOMES_KEY = `research:${TRADING_STRATEGY_VERSION}:outcomes`;
export const RESEARCH_STATUS_KEY = `research:${TRADING_STRATEGY_VERSION}:status`;
export async function ensureResearchBaselines(nowMs=Date.now()) {
  const existing=await getCandidateRegistry();
  for (const asset of CONFIGURED_ASSETS) for (const family of ['TREND_PULLBACK','RANGE_REVERSION'] as const) {
    const configHash=strategyFamilyConfigHash(family,asset), instrument=getConfiguredInstrument(asset);
    const candidateId=createHash('sha256').update([instrument.instrumentVersion,family,configHash,TRADING_STRATEGY_VERSION].join(':')).digest('hex');
    if (existing.some(d=>d.candidateId===candidateId)) continue;
    const holdoutStartMs=nowMs,holdoutEndMs=nowMs+5*365*86400000;
    // The collection manifest freezes instrument, family, versions and window.
    // Captured records have their own content hashes; a manifest never proves costs.
    const evidenceManifestHash=createHash('sha256').update(JSON.stringify({candidateId,
      schema:'bybit-closed-bars-v1',holdoutStartMs,holdoutEndMs})).digest('hex');
    await registerCandidate({candidateId,family,configHash,strategyVersion:TRADING_STRATEGY_VERSION,
      instrumentVersions:[instrument.instrumentVersion],costModelVersion:EXECUTION_COST_MODEL_VERSION,
      riskPolicyVersion:RISK_POLICY_VERSION,registeredAtMs:nowMs,labelHorizonMs:86400000,
      holdoutId:TRADING_STRATEGY_VERSION+':'+candidateId,mode:'SHADOW',evidenceManifestHash,holdoutStartMs,holdoutEndMs});
  }
}
export async function storeResearchOutcome(outcome:ResearchOutcome) {
  const redis=getRedis(), key=RESEARCH_OUTCOMES_KEY+':seen:'+outcome.positionId;
  if (await redis.get(key)) return;
  const definitions=await getCandidateRegistry();
  const definition=definitions.find(d=>matchesDefinition(outcome,d));
  if (definition) {
    const scope=independentKey(definition,outcome.researchOrigin??'PAPER'),lock=scope+':lock',token=randomUUID();
    if (!await redis.set(lock,token,{nx:true,ex:30})) throw new Error('Independent research cohort is busy; retry label');
    try {
      const rows=(await redis.lrange(scope,0,255)).map(raw=>JSON.parse(raw) as ResearchOutcome);
      const last=rows[0];
      const start=outcome.featureStartMs??outcome.openedAtMs;
      const end=Math.max(outcome.closedAtMs,outcome.labelEndMs??outcome.openedAtMs+definition.labelHorizonMs);
      if (!rows.some(row=>row.positionId===outcome.positionId) && Number.isFinite(start) && Number.isFinite(end) &&
        end>start && (!last || start>=Math.max(last.closedAtMs,last.labelEndMs??last.openedAtMs+definition.labelHorizonMs))) {
        if (!await redis.replaceList(scope,[JSON.stringify(outcome),...rows.map(row=>JSON.stringify(row))].slice(0,256),lock,token))
          throw new Error('Independent research cohort lease expired; retry label');
      }
    } finally {await redis.compareAndDelete(lock,token);}
  }
  // Append before the id marker: a crash may repeat the row, never lose the
  // outcome. All research consumers deduplicate by immutable position ID.
  await redis.lpush(RESEARCH_OUTCOMES_KEY,JSON.stringify(outcome));
  await redis.ltrim(RESEARCH_OUTCOMES_KEY,0,4095);
  await redis.set(key,true,{ex:86400*365});
}
function matchesDefinition(o:ResearchOutcome,d:CandidateDefinition) {
  return d.instrumentVersions.includes(o.instrument.instrumentVersion) && d.family===o.setupFamily &&
    d.configHash===o.configHash && d.strategyVersion===o.strategyVersion && d.costModelVersion===o.costModelVersion &&
    d.riskPolicyVersion===o.riskPolicyVersion && d.evidenceManifestHash===o.evidenceManifestHash;
}
function independentKey(d:CandidateDefinition,origin:string) {
  const scope=[...d.instrumentVersions].sort().join(',')+':'+[d.family,d.configHash,d.strategyVersion,
    d.costModelVersion,d.riskPolicyVersion,d.evidenceManifestHash,origin].join(':');
  return RESEARCH_OUTCOMES_KEY+':independent:'+createHash('sha256').update(scope).digest('hex');
}
/**
 * Families promoted to live paper trading, as `${instrumentVersion}:${family}:${configHash}`.
 * The entry scan lets only these trade beyond the trend baseline.
 */
export async function activeFamilyKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const d of await getCandidateRegistry()) {
    if (d.mode !== 'PAPER_ACTIVE') continue;
    for (const version of d.instrumentVersions) keys.add(`${version}:${d.family}:${d.configHash}`);
  }
  return keys;
}
/**
 * A completed live paper position as a research row for its family's
 * demotion check. Costs are the realized fills and funding; a loss beyond
 * 1.5R (a gap well past the stop) is recorded as a risk-limit breach.
 */
export function paperResearchOutcome(outcome: CompletedPositionOutcome): ResearchOutcome {
  return {
    ...outcome,
    researchOrigin: 'PAPER',
    historicalCostsAvailable: true,
    stressedNetPnlUsdt: outcome.netPnlUsdt,
    riskLimitBreached: Number.isFinite(outcome.netR) ? (outcome.netR as number) < -1.5 : false,
  };
}
/** Bind a forward observation to the immutable collection window it belongs to. */
export async function bindResearchManifest(outcome:ResearchOutcome):Promise<ResearchOutcome> {
  const definition=(await getCandidateRegistry()).find(d=>d.instrumentVersions.includes(outcome.instrument.instrumentVersion) &&
    d.family===outcome.setupFamily && d.configHash===outcome.configHash && d.strategyVersion===outcome.strategyVersion &&
    outcome.openedAtMs>=d.holdoutStartMs && (outcome.labelEndMs??outcome.closedAtMs)<=d.holdoutEndMs);
  return definition?{...outcome,evidenceManifestHash:definition.evidenceManifestHash}:outcome;
}
export async function reviewRegisteredCandidates(nowMs=Date.now()) {
  await ensureResearchBaselines(nowMs);
  const redis=getRedis(), trials=await getCandidateRegistry();
  const rows=(await Promise.all(trials.flatMap(d=>['REPLAY','SHADOW','PAPER'].map(origin=>
    redis.lrange(independentKey(d,origin),0,255))))).flat();
  const outcomes=rows.map(raw=>JSON.parse(raw)) as ResearchOutcome[];
  const summaries=[];
  for (const definition of trials) {
    const asset=CONFIGURED_ASSETS.find(a=>definition.instrumentVersions.includes(getConfiguredInstrument(a).instrumentVersion));
    const promotionEvidence={definition,outcomes,trials,holdoutConsumed:Boolean(definition.holdoutConsumed),
      feesVerified:asset ? feeScheduleFor(getConfiguredInstrument(asset)).status==='PUBLIC_BASELINE' : false};
    const report=evaluatePromotion(promotionEvidence);
    const paper=outcomes.filter(o=>o.researchOrigin==='PAPER' && matchesDefinition(o,definition));
    const mode=await recordPromotionReview(definition,report,paper,promotionEvidence);
    summaries.push({asset,family:definition.family,candidateId:definition.candidateId,
      mode,reasons:report.reasons,metrics:report.metrics});
  }
  // Promotion and demotion are autonomous (owner decision, 2026-10-02); the
  // evidence gates and every transition are recorded in the ledger.
  const status={version:TRADING_STRATEGY_VERSION,reviewedAt:new Date(nowMs).toISOString(),
    activationRequiresHumanReview:false,trialCount:trials.length,candidates:summaries};
  await redis.set(RESEARCH_STATUS_KEY,status);
  return status;
}
