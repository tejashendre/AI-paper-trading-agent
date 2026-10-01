import { createHash } from 'node:crypto';
import { getRedis } from '@/lib/redis';
import { CONFIGURED_ASSETS, getConfiguredInstrument } from '@/lib/trading/instrumentRegistry';
import { strategyFamilyConfigHash } from '@/lib/swingEngine';
import { EXECUTION_COST_MODEL_VERSION } from '@/lib/trading/executionCostModel';
import { TRADING_STRATEGY_VERSION } from '@/lib/trading/executionLedger';
import { RISK_POLICY_VERSION, feeScheduleFor } from '@/lib/trading/assetSpecs';
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
    await registerCandidate({candidateId,family,configHash,strategyVersion:TRADING_STRATEGY_VERSION,
      instrumentVersions:[instrument.instrumentVersion],costModelVersion:EXECUTION_COST_MODEL_VERSION,
      riskPolicyVersion:RISK_POLICY_VERSION,registeredAtMs:nowMs,labelHorizonMs:86400000,
      holdoutId:TRADING_STRATEGY_VERSION+':'+candidateId,mode:'SHADOW'});
  }
}
export async function storeResearchOutcome(outcome:ResearchOutcome) {
  const redis=getRedis(), key=RESEARCH_OUTCOMES_KEY+':seen:'+outcome.positionId;
  if (await redis.get(key)) return;
  // Append before the id marker: a crash may repeat the row, never lose the
  // outcome. All research consumers deduplicate by immutable position ID.
  await redis.lpush(RESEARCH_OUTCOMES_KEY,JSON.stringify(outcome));
  await redis.ltrim(RESEARCH_OUTCOMES_KEY,0,4095);
  await redis.set(key,true,{ex:86400*365});
}
export async function reviewRegisteredCandidates(nowMs=Date.now()) {
  await ensureResearchBaselines(nowMs);
  const redis=getRedis(), trials=await getCandidateRegistry();
  const rows=await redis.lrange(RESEARCH_OUTCOMES_KEY,0,4095);
  const outcomes=rows.map(raw=>typeof raw==='string'?JSON.parse(raw):raw) as ResearchOutcome[];
  const summaries=[];
  for (const definition of trials) {
    const asset=CONFIGURED_ASSETS.find(a=>definition.instrumentVersions.includes(getConfiguredInstrument(a).instrumentVersion));
    const report=evaluatePromotion({definition,outcomes,trials,holdoutConsumed:Boolean(definition.holdoutConsumed),
      feesVerified:asset ? feeScheduleFor(getConfiguredInstrument(asset)).status==='PUBLIC_BASELINE' : false});
    await recordPromotionReview(definition,report);
    summaries.push({asset,family:definition.family,candidateId:definition.candidateId,
      mode:report.eligible?'REVIEW_ELIGIBLE':'SHADOW',reasons:report.reasons,metrics:report.metrics});
  }
  const status={version:TRADING_STRATEGY_VERSION,reviewedAt:new Date(nowMs).toISOString(),
    activationRequiresHumanReview:true,trialCount:trials.length,candidates:summaries};
  await redis.set(RESEARCH_STATUS_KEY,status);
  return status;
}
