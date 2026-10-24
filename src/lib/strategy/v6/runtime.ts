import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getRedis, brainEntryReceipt, type RedisClient, type RawRedisSnapshot } from '@/lib/redis';
import type { OpenPosition, Portfolio, Trade } from '@/lib/types';
import { MarketService, type MarketPriceSnapshot } from '@/lib/market';
import { bybitPublicGet } from '@/lib/data/bybitPublic';
import { CONFIGURED_ASSETS, getConfiguredInstrument, type ConfiguredAsset } from '@/lib/trading/instrumentRegistry';
import { markedEquity, riskMarksReady } from '@/lib/trading/markedEquity';
import { expectedFundingTimes } from '@/lib/trading/executionCostModel';
import { capacityNotionalCap, evaluateFillCapacity } from '@/lib/execution/liquidityCost';
import { ExecutionLedger, type ExecutionLedgerEventInput } from '@/lib/trading/executionLedger';
import { loadBrainBars } from './data';
import { readCalendarManifest } from './calendarSource';
import { persistBrainDecisionArchive } from './archive';
import { brainDefinition, evaluateBrain, type BrainDecision, type CalendarManifest, type SwingSetup } from './engine';
import { brainEvidenceIdentity, brainPermission, evaluateBrainEvidence, evidenceHash, freezeBrainCosts, readBrainReview, registerBrain, saveBrainReview,
  type BrainEvidenceReview, type BrainFundingObservation, type BrainRegistration, type BrainTrial, type BrainOutcome } from './evidence';
import { allocateBrainRisk, brainVolatilityScale, evaluateBrainBreakers, sizeBrainOrder, type BrainBreakerLatch, type BrainOrderPlan, type BrainRiskOutcome } from './risk';
import { advanceBrainShadow, brainStressedEntry, emptyBrainShadow, shadowEquity, shadowExecution, BRAIN_EXECUTION_CONTEXT, type BrainShadowState, type ShadowFrame } from './shadow';

export const BRAIN_SCAN_INTERVAL_MS=60000,BRAIN_WATCHDOG_INTERVAL_MS=5000;
const LOCK='portfolio:write-lock:ai',ACTIVE='brain:v6:activeRun';
const RISK_POLICY={version:'v6-risk-1',initialCapital:10000,riskFraction:.0025,escalatedRiskFraction:.005,accountRisk:.02,factorRisk:.01,
  grossNotional:2.5,margin:.4,drawdown:.1,volatilityOverlay:{lookbackDays:30,targetAnnualVol:.2,annualDays:365,downOnly:true},executionContext:BRAIN_EXECUTION_CONTEXT};
export interface RuntimeFrame extends ShadowFrame {bars:Awaited<ReturnType<typeof loadBrainBars>>}
export interface RuntimeDeps {redis:RedisClient;clock:()=>number;assets:readonly ConfiguredAsset[];sourceHash:()=>string;
  capture:(asset:ConfiguredAsset,startedAtMs:number)=>Promise<RuntimeFrame>;calendar:()=>Promise<CalendarManifest|null>;
  executionCapture?:(asset:ConfiguredAsset)=>Promise<ShadowFrame>;
  funding:(asset:ConfiguredAsset,fromMs:number,toMs:number)=>Promise<BrainFundingObservation[]>;
  ledger:(event:ExecutionLedgerEventInput&{id:string})=>Promise<unknown>;
  archive?:(runId:string,id:string,tape:unknown)=>Promise<unknown>}
export interface BrainRuntimeAsset {asset:ConfiguredAsset;strategyId:string;configHash:string;mode:string;riskTier:'BASE'|'ESCALATED';
  evidence:{historicalCount:number;forwardCount:number;paperCount:number;nextEligibleAtMs:number|null;reasons:string[]};
  decision:{status:string;code?:string;reason?:string;setupId?:string}}
export interface BrainRuntimeStatus {version:'v6';runId:string|null;mode:'RESET_REQUIRED'|'SHADOW'|'PAPER_ACTIVE'|'REDUCE_ONLY'|'ERROR';
  generatedAt:string;generatedAtMs:number;commit:string|null;scanId:number;scanIntervalMs:number;watchdogIntervalMs:number;capitalUsdt:10000;
  equityUsdt:number|null;haltReasons:string[];assets:BrainRuntimeAsset[];virtualShadow:{equityUsdt:number;openPositions:number;capitalAllocatedUsdt:0}}
function sourceHash():string {
  const files=['src/lib/strategy/v6/engine.ts','src/lib/strategy/v6/risk.ts','src/lib/strategy/v6/evidence.ts','src/lib/strategy/v6/runtime.ts',
    'src/lib/strategy/v6/shadow.ts','src/lib/strategy/v6/calendar.ts','src/lib/strategy/v6/calendarSource.ts','src/lib/strategy/v6/data.ts','src/lib/strategy/v6/archive.ts',
    'src/lib/trading/executionCostModel.ts','src/lib/trading/assetSpecs.ts','src/lib/trading/instrumentRegistry.ts','src/lib/execution/swingLifecycle.ts'];
  return evidenceHash(files.map(file=>({file,content:fs.readFileSync(path.join(process.cwd(),file),'utf8')})));
}
async function capture(asset:ConfiguredAsset,startedAtMs:number):Promise<RuntimeFrame>{
  const [bars,execution]=await Promise.all([loadBrainBars(asset,startedAtMs),captureExecution(asset)]);
  const body={...execution,bars,availableAtMs:Date.now()};return {...body,sourceHash:evidenceHash(body)};
}
async function captureExecution(asset:ConfiguredAsset):Promise<ShadowFrame>{
  const [quote,metadata,liquidity,sensors]=await Promise.all([MarketService.getCurrentPriceSnapshot(asset),MarketService.getInstrumentMetadata(asset),
    MarketService.getLiquiditySnapshot(asset),MarketService.getDeepSensors(asset)]);
  const availableAtMs=Date.now(),body={asset,quote,metadata,liquidity,fundingRate:sensors.fundingRate??NaN,
    fundingObservedAtMs:sensors.observedAtMs??NaN,availableAtMs};
  return {...body,sourceHash:evidenceHash(body)};
}
/** Retain the actual settlement rate, boundary mark and response receipt clocks. */
export async function captureBrainFunding(asset:ConfiguredAsset,fromMs:number,toMs:number):Promise<BrainFundingObservation[]>{
  const symbol=getConfiguredInstrument(asset).symbol;
  const requestPath=`/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${Math.floor(fromMs)+1}&endTime=${Math.floor(toMs)}&limit=200`;
  const history=await bybitPublicGet<{list?:{fundingRateTimestamp:string;fundingRate:string}[]}>(requestPath),historyAvailableAtMs=Date.now();
  const metadata=await MarketService.getInstrumentMetadata(asset),rows:BrainFundingObservation[]=[];
  for(const raw of history.result.list??[]){
    const atMs=Number(raw.fundingRateTimestamp),actualRate=Number(raw.fundingRate);
    if(!Number.isFinite(atMs)||!Number.isFinite(actualRate)||atMs<=fromMs||atMs>toMs)continue;
    const markPath=`/v5/market/mark-price-kline?category=linear&symbol=${symbol}&interval=1&start=${atMs}&end=${atMs+59999}&limit=1`;
    const marks=await bybitPublicGet<{list?:unknown[][]}>(markPath),availableAtMs=Date.now();
    const bar=marks.result.list?.find(x=>Number(x[0])===atMs),mark=Number(bar?.[1]);
    if(!(mark>0)||!Number.isFinite(mark))continue;
    rows.push({atMs,actualRate,mark,intervalMinutes:metadata.fundingIntervalMinutes,availableAtMs,
      sourceHash:evidenceHash({requestPath,history,historyAvailableAtMs,markPath,marks,availableAtMs})});
  }
  return rows;
}
async function archive(runId:string,id:string,tape:unknown){
  persistBrainDecisionArchive({directory:path.join(process.cwd(),'data','research','v6'),runId,decisionId:id,tape,
    maxBytes:Number(process.env.BRAIN_ARCHIVE_MAX_BYTES??2*1024*1024*1024)});
}
function dependencies(overrides:Partial<RuntimeDeps>):RuntimeDeps{return {redis:overrides.redis??getRedis(),clock:Date.now,assets:CONFIGURED_ASSETS,sourceHash,capture,
  executionCapture:overrides.capture?(asset=>overrides.capture!(asset,(overrides.clock??Date.now)())):captureExecution,
  calendar:()=>process.env.BRAIN_CALENDAR_MANIFEST?readCalendarManifest(path.resolve(process.env.BRAIN_CALENDAR_MANIFEST)):Promise.resolve(null),
  funding:captureBrainFunding,ledger:e=>ExecutionLedger.recordOnce(e),archive,...overrides};}
function parse<T>(raw:unknown):T|null {if(raw==null)return null;try{return (typeof raw==='string'?JSON.parse(raw):raw) as T;}catch{return null;}}
function rawString(raw:RawRedisSnapshot,key:string):string|null {const value=raw[key];return value?.type==='string'?value.value:null;}
function prefix(runId:string){return `brain:v6:run:${runId}:`;}
function assetStatus(asset:ConfiguredAsset,code:string,reason=code):BrainRuntimeAsset {const d=brainDefinition(asset);return {asset,strategyId:d.strategyId,configHash:d.configHash,
  mode:'SHADOW',riskTier:'BASE',evidence:{historicalCount:0,forwardCount:0,paperCount:0,nextEligibleAtMs:null,reasons:[reason]},decision:{status:'NO_TRADE',code,reason}};}
function status(deps:RuntimeDeps,runId:string|null,mode:BrainRuntimeStatus['mode'],now:number,assets:BrainRuntimeAsset[],haltReasons:string[]=[]):BrainRuntimeStatus {
  return {version:'v6',runId,mode,generatedAt:new Date(now).toISOString(),generatedAtMs:now,commit:process.env.APP_COMMIT_SHA??null,scanId:0,
    scanIntervalMs:BRAIN_SCAN_INTERVAL_MS,watchdogIntervalMs:BRAIN_WATCHDOG_INTERVAL_MS,capitalUsdt:10000,equityUsdt:null,haltReasons,assets,
    virtualShadow:{equityUsdt:10000,openPositions:0,capitalAllocatedUsdt:0}};
}
async function publish(deps:RuntimeDeps,s:BrainRuntimeStatus,startedAtMs:number){
  const results=s.assets.map(a=>({asset:a.asset,action:a.decision.status==='ENTRY'?'ENTRY':a.decision.status==='ERROR'?'ERROR':'HOLD',reason:a.decision.reason??a.decision.code??a.mode,
    decisionState:a.mode,simpleStatus:a.mode,simpleReason:a.evidence.reasons.join('; '),timestamp:s.generatedAt}));
  const summary=results.reduce((s,r)=>({...s,[r.action]:(s[r.action]??0)+1}),{HOLD:0,BLOCKED:0,ENTRY:0,SKIPPED:0,ERROR:0} as Record<string,number>);
  await deps.redis.set('brain:v6:status',s);
  await deps.redis.set('swing:lastScan:ai',{scanId:s.scanId,runtimeCommit:s.commit,startedAt:new Date(startedAtMs).toISOString(),completedAt:s.generatedAt,
    nextScanAt:new Date(s.generatedAtMs+BRAIN_SCAN_INTERVAL_MS).toISOString(),entryScanIntervalMs:BRAIN_SCAN_INTERVAL_MS,exitWatchdogIntervalMs:BRAIN_WATCHDOG_INTERVAL_MS,
    durationMs:s.generatedAtMs-startedAtMs,brainVersion:'v6',runId:s.runId,mode:s.mode,summary,decisionSummary:{},blockerSummary:[],results},{ex:600});
}
async function currentRun(deps:RuntimeDeps){
  const active=await deps.redis.get<{runId:string;brainVersion:string;initialCapital:number}>(ACTIVE);
  if(!active||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(active.runId)||active.brainVersion!=='replacement-swing-v6-2026-10-24'||active.initialCapital!==10000)return null;
  return active;
}
async function registration(deps:RuntimeDeps,runId:string,asset:ConfiguredAsset,now:number,source:string):Promise<BrainRegistration>{
  const p=prefix(runId),d=brainDefinition(asset),key=p+'runtimeRegistration:'+asset;
  let existing=await deps.redis.get<BrainRegistration>(key);
  if(!existing){
    let trials=await deps.redis.get<BrainTrial[]>(p+'trials');
    if(!trials){
      const legacy=(await deps.redis.lrange('research:swing-v5.0.0-2026-10-01:candidates',0,-1)).flatMap(raw=>{
        const row=parse<{candidateId:string;registeredAtMs:number}>(raw);
        return row?.candidateId&&Number.isFinite(row.registeredAtMs)&&row.registeredAtMs<=now?[{trialId:'legacy:'+row.candidateId,sourceHash:evidenceHash(row),registeredAtMs:row.registeredAtMs,kind:'LEGACY' as const}]:[];
      });
      const initial=CONFIGURED_ASSETS.map(a=>({trialId:`v6:${a}:${brainDefinition(a).configHash}`,sourceHash:source,registeredAtMs:now,kind:'INITIAL' as const}));
      await deps.redis.set(p+'trials',Array.from(new Map([...legacy,...initial].map(x=>[x.trialId,x])).values()),{nx:true});
      trials=(await deps.redis.get<BrainTrial[]>(p+'trials'))!;
    }
    const costs=freezeBrainCosts(asset),candidate:BrainRegistration={runId,sourceHash:source,costHash:evidenceHash(costs),costs,
      riskPolicyHash:evidenceHash(RISK_POLICY),exitPolicyHash:evidenceHash({policy:d.parameters,executionContext:BRAIN_EXECUTION_CONTEXT}),
      registeredAtMs:now,releasedAtMs:now,firstEvaluationAtMs:now,trialSnapshotHash:evidenceHash(trials),folds:[]};
    await deps.redis.set(key,candidate,{nx:true});existing=(await deps.redis.get<BrainRegistration>(key))!;
  }
  if(existing.sourceHash!==source||existing.costHash!==evidenceHash(freezeBrainCosts(asset))||existing.riskPolicyHash!==evidenceHash(RISK_POLICY)||
    existing.exitPolicyHash!==evidenceHash({policy:d.parameters,executionContext:BRAIN_EXECUTION_CONTEXT}))throw new Error('REGISTRATION_MISMATCH');
  await registerBrain(deps.redis,d,existing);return existing;
}
function frameValid(f:RuntimeFrame,now:number):boolean {
  return [f.availableAtMs,f.bars.h4AvailableAtMs,f.bars.d1AvailableAtMs].every(t=>Number.isFinite(t)&&t<=now)&&
    f.availableAtMs>=f.bars.h4AvailableAtMs&&f.availableAtMs>=f.bars.d1AvailableAtMs&&/^[a-f0-9]{64}$/.test(f.sourceHash);
}
async function prefetchFunding(deps:RuntimeDeps,runId:string,toMs:number){
  const state=await deps.redis.get<BrainShadowState>(prefix(runId)+'shadow'),windows=new Map<ConfiguredAsset,{fromMs:number;toMs:number}>();
  if(state)for(const position of [...Object.values(state.open),...state.pending]){
    if(!position)continue;const end='closedAtMs' in position?Number(position.closedAtMs):toMs;
    const known=new Set(position.funding.map(f=>f.atMs));
    const missing=expectedFundingTimes(position.openedAtMs,end,position.fundingIntervalMinutes).filter(at=>!known.has(at));if(!missing.length)continue;
    const old=windows.get(position.setup.asset);windows.set(position.setup.asset,{fromMs:Math.min(old?.fromMs??Infinity,...missing)-1,toMs:Math.max(old?.toMs??0,end)});
  }
  const rows=new Map<ConfiguredAsset,BrainFundingObservation[]>();
  await Promise.all([...windows].map(async([asset,w])=>{rows.set(asset,await deps.funding(asset,w.fromMs,w.toMs).catch(()=>[]));}));
  return async(asset:ConfiguredAsset,fromMs:number,endMs:number)=>(rows.get(asset)??[]).filter(f=>f.atMs>fromMs&&f.atMs<=endMs);
}
/** Financial outbox records survive ambiguous commits and process restarts. Never drop on append failure. */
export async function drainBrainOutbox(deps:RuntimeDeps,runId:string):Promise<void>{
  for(const key of await deps.redis.scanKeys(prefix(runId)+'outbox:*')){
    const raw=(await deps.redis.readRaw([key]))[key];if(raw.type!=='string')throw new Error('Malformed financial outbox');
    const event=parse<ExecutionLedgerEventInput&{id:string}>(raw.value);
    if(!event?.id||key!==prefix(runId)+'outbox:'+event.id)throw new Error('Conflicting financial outbox identity');
    await deps.ledger(event);await deps.redis.compareAndDelete(key,raw.value);
  }
}
/** Recover evidence from preserved financial legs. Missing provenance is a diagnostic, never a zero cost. */
export async function collectBrainPaperOutcomes(deps:RuntimeDeps,runId:string,portfolio:Portfolio,nowMs:number):Promise<{outcomes:BrainOutcome[];riskOutcomes:BrainRiskOutcome[]}>{
  await drainBrainOutbox(deps,runId);
  const p=prefix(runId),trades=(await deps.redis.lrange(p+'trades',0,-1)).map(x=>parse<Trade>(x)).filter((x):x is Trade=>!!x&&x.brainRunId===runId);
  const positions=new Map<string,Trade[]>();for(const t of trades)if(t.positionId)positions.set(t.positionId,[...(positions.get(t.positionId)??[]),t]);
  const riskOutcomes:BrainRiskOutcome[]=[];
  for(const [positionId,legs] of positions){
    if(Object.values(portfolio.openPositions??{}).some(pos=>pos.positionId===positionId))continue;
    const unique=[...new Map(legs.map(t=>[t.id,t])).values()],entries=unique.filter(t=>t.action==='BUY'||t.action==='SHORT'),
      exits=unique.filter(t=>t.action==='SELL'||t.action==='COVER').sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
    if(!exits.length)continue;
    const entry=entries[0],exit=exits.at(-1)!,closedAtMs=Date.parse(exit.timestamp),openedAtMs=Date.parse(entry?.timestamp??'');
    const initialRiskUsdt=entry?.initialRiskUsdt??NaN;
    const realized=exits.reduce((sum,t)=>sum+(t.pnl??NaN),0);
    riskOutcomes.push({positionId,asset:exit.asset as ConfiguredAsset,closedAtMs,netPnlUsdt:realized,netR:initialRiskUsdt>0?realized/initialRiskUsdt:null,
      exitReason:exit.exitReason==='TRAILING_STOP_PROFIT'?'TRAILING':exit.exitReason??'INVALID_INPUT'});
    const completedId=`completed:${runId}:${evidenceHash(positionId)}`;
    await deps.ledger({id:completedId,type:'POSITION_COMPLETED',source:'REPLACEMENT_SWING_V6',asset:exit.asset,positionId,timestamp:exit.timestamp,
      payload:{runId,positionId,tradeIds:unique.map(t=>t.id).sort(),realizedNetPnlAtCloseUsdt:realized,fundingStatus:exit.fundingStatus??'UNVERIFIED'}});
    const diagnostic=(reason:string)=>deps.redis.set(p+'paperCoverage:'+evidenceHash(positionId),{positionId,reason,observedAtMs:nowMs});
    if(entries.length!==1||Math.abs(entry.amount-exits.reduce((sum,t)=>sum+t.amount,0))>1e-8*Math.max(1,entry.amount)||exit.isPartialExit||!Number.isFinite(openedAtMs)||!Number.isFinite(closedAtMs)||
      closedAtMs<=openedAtMs||closedAtMs>nowMs||!(initialRiskUsdt>0)){await diagnostic('INCOMPLETE_POSITION_LEGS_OR_RISK');continue;}
    const first=entry.brainEntryObservation,exitObservations=exits.map(t=>t.brainExitObservation),interval=entry.brainFundingIntervalMinutes;
    if(!first||first.atMs!==openedAtMs||!interval||!entry.brainCosts||!entry.brainIdentityHash||
      !entry.brainStressedEntry||exits.some(t=>!t.brainStressedExit||!t.brainExitObservation||t.brainExitObservation.atMs!==Date.parse(t.timestamp))||
      [first,...exitObservations].some(o=>!o||!/^[a-f0-9]{64}$/.test(o.sourceHash)||!Number.isFinite(o.availableAtMs)||
        o.availableAtMs>o.atMs||o.atMs-o.availableAtMs>5000||!Number.isFinite(o.halfSpreadBps)||o.halfSpreadBps<0||!Number.isFinite(o.depthNotionalUsdt)||o.depthNotionalUsdt<=0)){
      await diagnostic('MISSING_ACTUAL_EXECUTION_OR_FROZEN_STRESS_PROVENANCE');continue;
    }
    const funding=new Map<number,BrainFundingObservation>();let conflict=false;
    for(const f of [...exits.flatMap(t=>t.brainFundingObservations??[]),...(portfolio.brainFundingObservations?.[positionId]??[])]){
      const old=funding.get(f.atMs);if(old&&(old.actualRate!==f.actualRate||old.mark!==f.mark||old.intervalMinutes!==f.intervalMinutes))conflict=true;
      if(!old||f.availableAtMs<old.availableAtMs)funding.set(f.atMs,f);
    }
    const boundaries=expectedFundingTimes(openedAtMs,closedAtMs,interval);
    if(conflict||boundaries.some(at=>{const f=funding.get(at);return !f||f.intervalMinutes!==interval||![f.actualRate,f.mark,f.availableAtMs].every(Number.isFinite)||
      f.mark<=0||f.availableAtMs<at||f.availableAtMs>nowMs||!/^[a-f0-9]{64}$/.test(f.sourceHash);})){await diagnostic('PENDING_OR_CONFLICTING_ACTUAL_FUNDING');continue;}
    const settlements=boundaries.map(at=>funding.get(at)!),sign=entry.direction==='SHORT'?-1:1;
    const heldAt=(at:number)=>Math.max(0,entry.amount-exits.filter(t=>Date.parse(t.timestamp)<at).reduce((sum,t)=>sum+t.amount,0));
    const actualFunding=settlements.reduce((sum,f)=>sum-sign*heldAt(f.atMs)*f.mark*f.actualRate,0);
    const stressedFunding=settlements.reduce((sum,f)=>sum-2*heldAt(f.atMs)*f.mark*Math.max(Math.abs(f.actualRate),.0001*interval/480),0);
    const net=exits.reduce((sum,t)=>sum+sign*t.amount*(t.price-entry.price)-(t.exitFeeUsd??NaN),0)-(entry.entryFeeUsd??NaN)+actualFunding;
    const stressed=exits.reduce((sum,t)=>sum+sign*t.amount*(t.brainStressedExit!.fillPrice-entry.brainStressedEntry!.fillPrice)-t.brainStressedExit!.feeUsdt,0)-entry.brainStressedEntry.feeUsdt+stressedFunding;
    if(!Number.isFinite(net)||!Number.isFinite(stressed)){await diagnostic('MISSING_ACTUAL_FEE_OR_STRESS_VALUES');continue;}
    // Late funding tails refine the whole-position risk result after their cash events settle.
    riskOutcomes[riskOutcomes.length-1]={...riskOutcomes.at(-1)!,netPnlUsdt:net,netR:net/initialRiskUsdt};
    const outcome:BrainOutcome={positionId,identityHash:entry.brainIdentityHash,runId,origin:'PAPER',openedAtMs,closedAtMs,netR:net/initialRiskUsdt,
      stressedNetR:Math.min(net,stressed)/initialRiskUsdt,initialRiskUsdt,costHash:evidenceHash(entry.brainCosts),executions:[first,...exitObservations] as NonNullable<Trade['brainEntryObservation']>[],fundingIntervalMs:interval*60000,
      funding:settlements,criticalViolation:net/initialRiskUsdt < -1.5,availableAtMs:Math.max(closedAtMs,...settlements.map(f=>f.availableAtMs)),
      sourceHash:evidenceHash({entry,exits,settlements})};
    const key=p+'brainOutcome:'+evidenceHash(positionId),accepted=await deps.redis.set(key,outcome,{nx:true});
    if(!accepted){const previous=await deps.redis.get<BrainOutcome>(key);if(evidenceHash(previous)!==evidenceHash(outcome))throw new Error('Immutable paper outcome conflict');}
  }
  const stored=await Promise.all((await deps.redis.scanKeys(p+'brainOutcome:*')).map(key=>deps.redis.get<BrainOutcome>(key)));
  const legacy=(await deps.redis.lrange(p+'brainOutcomes',0,-1)).map(x=>parse<BrainOutcome>(x));
  return {outcomes:[...new Map([...stored,...legacy].filter((x):x is BrainOutcome=>!!x).map(x=>[x.positionId,x])).values()],riskOutcomes};
}
function relevantLatch(asset:ConfiguredAsset,latches:BrainBreakerLatch[]){const bucket=brainDefinition(asset).riskBucket;
  return latches.find(l=>l.kind==='DRAWDOWN')??latches.find(l=>l.scope==='account'||l.scope===asset||l.scope===bucket);}
async function review(deps:RuntimeDeps,r:BrainRegistration,asset:ConfiguredAsset,shadow:BrainShadowState,latches:BrainBreakerLatch[],paper:BrainOutcome[],now:number,leaseToken:string):Promise<BrainEvidenceReview|null>{
  const d=brainDefinition(asset),previous=await readBrainReview(deps.redis,d,r);
  if(previous&&now-previous.createdAtMs<3600000&&now<previous.expiresAtMs&&!relevantLatch(asset,latches))return previous;
  const identity=brainEvidenceIdentity(d,r),halt=relevantLatch(asset,latches);
  const reviewed=evaluateBrainEvidence({definition:d,registration:r,nowMs:now,expiresAtMs:now+2*3600000,previousReview:previous??undefined,
    outcomes:[...shadow.outcomes,...paper].filter(x=>x.identityHash===identity),dailyReturns:shadow.dailyReturns.filter(x=>x.identityHash===identity),
    trials:await deps.redis.get<BrainTrial[]>(prefix(r.runId)+'trials')??[],
    halt:halt?{kind:halt.kind,atMs:halt.atMs,sourceHash:r.sourceHash}:undefined,
    portfolio:{identityHash:identity,runId:r.runId,sourceHash:evidenceHash(shadow),riskFraction:.0025,alignedBlockMs:d.parameters.maxHoldMs,
      factorClusters:['crypto','fx','metals','oil'],equity:shadow.equity,unresolvedBreaker:!!halt&&halt.kind!=='STREAK',integrityRestored:shadow.pending.length===0&&shadow.gaps.length===0}});
  // Prepare the existing proof writer against captured bytes, then publish its
  // immutable proof and latest pointer together under the financial lease.
  const expected=await deps.redis.readRaw([ACTIVE]),writes:Record<string,string>={};
  const observe=async(key:string)=>{
    if(!Object.hasOwn(expected,key))Object.assign(expected,await deps.redis.readRaw([key]));
    const raw=expected[key];
    return raw.type==='string'?parse<unknown>(raw.value):null;
  };
  const evidencePort={get:observe,set:async(key:string,value:string,options?:{nx?:boolean})=>{
    const previous=await observe(key);if(options?.nx&&previous!==null)return null;writes[key]=value;return 'OK';
  }};
  await saveBrainReview(evidencePort,reviewed);
  await deps.redis.commitBrainObservation({runId:r.runId,leaseToken,expected,writes});
  return readBrainReview(deps.redis,d,r);
}
function permissionKeys(r:BrainRegistration,asset:ConfiguredAsset,proof:BrainEvidenceReview):string[]{
  const p=prefix(r.runId),id=brainEvidenceIdentity(brainDefinition(asset),r);
  return [p+'runtimeRegistration:'+asset,p+'registration:'+id,p+'latest:'+id,p+'proof:'+proof.proofHash,
    'brain:v6:retired:'+proof.semanticHash,p+'drawdown',p+'breakers',p+'shadow',p+'ledgerAcknowledged'];
}
function toPosition(setup:SwingSetup,plan:BrainOrderPlan,r:BrainRegistration,f:RuntimeFrame,now:number):OpenPosition {
  const instrument=getConfiguredInstrument(setup.asset),observation=shadowExecution(f,now,setup.direction,plan.quantity,plan.entryPrice,plan.stopLoss)!;
  return {asset:setup.asset,entryPrice:plan.entryPrice,amount:plan.quantity,btcAmount:plan.quantity,usdInvested:plan.marginUsdt,stopLoss:plan.stopLoss,initialStopLoss:plan.stopLoss,
    takeProfit:plan.takeProfit,entryTime:new Date(now).toISOString(),signalScore:0,reasoning:'Exact v6 evidence permission and bounded batch risk',direction:setup.direction,strategyType:'swing',
    entryFeePaid:plan.entryFeeUsdt,notionalUsd:plan.notionalUsdt,leverageUsed:plan.leverage,riskAmountUsd:plan.initialRiskUsdt,initialRiskUsdt:plan.initialRiskUsdt,
    maxLossUsd:plan.initialRiskUsdt,positionId:`v6:${r.runId}:${setup.id}`,strategyFamily:setup.strategyId,strategyConfigHash:setup.configHash,
    strategyDataSchemaVersion:'v6-native-closed',featureCutoffMs:setup.featureCutoffMs,strategyVersion:'replacement-swing-v6-2026-10-24',instrument,economicsModel:instrument.economicsModel,
    feeScheduleVersion:r.costs.feeSchedule.version,costModelVersion:r.costs.modelVersion,executionCostModelVersion:r.costs.modelVersion,riskPolicyVersion:r.riskPolicyHash,
    highestPriceReached:plan.entryPrice,lowestPriceReached:plan.entryPrice,lastMarkPrice:f.quote!.markPrice,lastMarkAt:new Date(now).toISOString(),quantityLegs:[{atMs:now,quantityDelta:plan.quantity}],
    marketDataBid:f.quote!.bid,marketDataAsk:f.quote!.ask,marketDataProvider:f.quote!.provider,marketDataVenue:f.quote!.venue,marketDataInstrument:f.quote!.instrument,
    brainPolicy:{...setup.policy,priceRDistance:Math.abs(plan.entryPrice-plan.stopLoss)},brainRunId:r.runId,brainCosts:r.costs,
    brainIdentityHash:brainEvidenceIdentity(brainDefinition(setup.asset),r),brainSourceHash:r.sourceHash,brainRiskPolicyHash:r.riskPolicyHash,brainExitPolicyHash:r.exitPolicyHash,
    brainEntryObservation:observation,brainStressedEntry:brainStressedEntry(setup,plan,r,observation.halfSpreadBps),
    brainFundingIntervalMinutes:f.metadata.fundingIntervalMinutes,brainFundingObservations:[],fillLiquidity:{...f.liquidity},fundingRate:f.fundingRate};
}
async function fillBatch(deps:RuntimeDeps,runId:string,token:string,frames:RuntimeFrame[],setups:SwingSetup[],registrations:Map<ConfiguredAsset,BrainRegistration>,
  reviews:Map<ConfiguredAsset,BrainEvidenceReview>,portfolio:Portfolio,raw:RawRedisSnapshot,latches:BrainBreakerLatch[],now:number):Promise<ConfiguredAsset[]>{
  const p=prefix(runId),equity=markedEquity(portfolio),candidates=[];
  if(!riskMarksReady(portfolio,now)||await deps.redis.get('swing:entryFreeze')!==null||await deps.redis.get('brain:v6:migration-freeze')!==null||
    (await deps.redis.scanKeys(p+'outbox:*')).length||(portfolio.pendingLedgerEvents?.length??0)>0||
    (portfolio.fundingTail??[]).some(t=>t.pendingTimes.length>0)||Object.values(portfolio.openPositions??{}).some(pos=>(pos.fundingPendingTimes?.length??0)>0))return [];
  for(const setup of setups){
    const r=registrations.get(setup.asset),proof=reviews.get(setup.asset),f=frames.find(x=>x.asset===setup.asset),d=brainDefinition(setup.asset);
    if(!r||!proof||!f||portfolio.openPositions?.[setup.asset])continue;
    const halt=relevantLatch(setup.asset,latches);if(halt&&(halt.kind!=='STREAK'||!proof.rearmed))continue;
    const permission=brainPermission(d,proof,now,{runId,sourceHash:r.sourceHash,costHash:r.costHash,riskPolicyHash:r.riskPolicyHash,exitPolicyHash:r.exitPolicyHash,riskTier:proof.riskTier});
    if(!permission.allowed)continue;
    const observation=shadowExecution(f,now,setup.direction,1,setup.entryPrice,setup.stopLoss),capacity=capacityNotionalCap({side:setup.direction==='LONG'?'BUY':'SELL',liquidity:f.liquidity});
    if(!observation||capacity===null||!Number.isFinite(f.fundingRate)||!Number.isFinite(f.fundingObservedAtMs)||f.fundingObservedAtMs>now||now-f.fundingObservedAtMs>60000)continue;
    const volatility=brainVolatilityScale(f.bars.d1,now);if(volatility===null)continue;
    const order={setup,metadata:f.metadata,nowMs:now,riskBudgetUsdt:equity*(proof.riskTier==='ESCALATED'?.005:.0025)*volatility,riskTier:proof.riskTier==='ESCALATED'?'ESCALATED' as const:'INITIAL' as const,
      equity,availableCash:portfolio.usd,capacityNotionalUsdt:capacity,halfSpreadBps:observation.halfSpreadBps,fundingRate:f.fundingRate};
    const plan=sizeBrainOrder(order);if(plan.approved)candidates.push({setup,r,proof,f,order,plan});
  }
  const allocations=allocateBrainRisk({equity,initialCapital:10000,peakEquity:Math.max(10000,portfolio.peakValue??10000),freeCash:portfolio.usd,
    open:Object.values(portfolio.openPositions??{}).map(pos=>({asset:pos.asset as ConfiguredAsset,riskUsdt:pos.initialRiskUsdt??NaN,notionalUsdt:pos.notionalUsd??NaN,marginUsdt:pos.usdInvested})),
    candidates:candidates.map(c=>({id:c.setup.id,asset:c.setup.asset,riskUsdt:c.plan.initialRiskUsdt,notionalUsdt:c.plan.notionalUsdt,marginUsdt:c.plan.marginUsdt,riskTier:c.order.riskTier}))});
  const trades:Trade[]=[],events:(ExecutionLedgerEventInput&{id:string})[]=[],filled:ConfiguredAsset[]=[];
  const next=structuredClone(portfolio);next.openPositions??={};next.balances??={};
  const expectedKeys:string[]=[ACTIVE,p+'portfolio'];
  for(const allocation of allocations){
    if(!(allocation.scale>0))continue;const c=candidates.find(x=>x.setup.id===allocation.id)!;
    const plan=sizeBrainOrder({...c.order,riskBudgetUsdt:allocation.riskUsdt,capacityNotionalUsdt:allocation.notionalUsdt,availableCash:Math.min(next.usd,allocation.marginUsdt+c.plan.entryFeeUsdt)});
    if(!plan.approved||!evaluateFillCapacity({side:c.setup.direction==='LONG'?'BUY':'SELL',quantity:plan.quantity,entryPrice:plan.entryPrice,stopPrice:plan.stopLoss,impactBps:0,liquidity:c.f.liquidity}).allowed)continue;
    const current=await readBrainReview(deps.redis,brainDefinition(c.setup.asset),c.r);
    if(current?.proofHash!==c.proof.proofHash)continue;
    expectedKeys.push(...permissionKeys(c.r,c.setup.asset,c.proof));
    const pos=toPosition(c.setup,plan,c.r,c.f,now);next.openPositions[c.setup.asset]=pos;
    next.usd-=plan.marginUsdt+plan.entryFeeUsdt;next.balances[c.setup.asset]=c.setup.direction==='LONG'?plan.quantity:-plan.quantity;
    next.totalFeesPaid=(next.totalFeesPaid??0)+plan.entryFeeUsdt;next.totalExecutionCostsPaid=(next.totalExecutionCostsPaid??0)+plan.entryFeeUsdt;
    if(c.setup.asset==='BTC'){next.btc=next.balances.BTC;next.openPosition=pos;}
    const trade:Trade={...pos,id:`entry:${pos.positionId}`,timestamp:new Date(now).toISOString(),action:c.setup.direction==='LONG'?'BUY':'SHORT',price:plan.entryPrice,
      usdValue:plan.marginUsdt,entryFeeUsd:plan.entryFeeUsdt,reasoning:pos.reasoning};
    trades.push(trade);filled.push(c.setup.asset);
    events.push({id:`filled:${pos.positionId}`,type:'ENTRY_FILLED',source:'REPLACEMENT_SWING_V6',asset:c.setup.asset,decisionId:c.setup.id,tradeId:trade.id,positionId:pos.positionId,
      timestamp:trade.timestamp,payload:{runId,position:pos,trade,proofHash:c.proof.proofHash,registration:c.r,execution:plan,captureHash:c.f.sourceHash}});
  }
  if(!trades.length)return [];
  next.lastUpdated=new Date(now).toISOString();
  const expected=await deps.redis.readRaw([...new Set(expectedKeys)]);
  for(const c of candidates.filter(c=>filled.includes(c.setup.asset))){
    const identity=brainEvidenceIdentity(brainDefinition(c.setup.asset),c.r);
    if(rawString(expected,p+'latest:'+identity)!==c.proof.proofHash||expected['brain:v6:retired:'+c.proof.semanticHash]?.type!=='none'||
      expected[p+'drawdown']?.type!=='none')throw new Error('EVIDENCE_CHANGED_BEFORE_COMMIT');
  }
  // Preserve the portfolio and epoch observed under the lease, not a later reread.
  expected[ACTIVE]=raw[ACTIVE];expected[p+'portfolio']=raw[p+'portfolio'];
  const financial={portfolio:JSON.stringify(next),trades:trades.map(t=>JSON.stringify(t)),events:events.map(e=>({id:e.id,event:JSON.stringify(e)}))};
  const expiresAtMs=Math.min(...candidates.filter(c=>filled.includes(c.setup.asset)).map(c=>Math.min(c.setup.expiresAtMs,c.f.availableAtMs+5000,
    c.f.quote!.eventTimeMs+5000,c.f.quote!.receivedAtMs+5000,...Object.values(c.f.quote!.quoteTimes).map(t=>(t??0)+5000),c.proof.expiresAtMs-1)));
  await deps.redis.commitBrainEntry({runId,transactionId:evidenceHash(trades.map(t=>t.id)),leaseToken:token,expected,...financial,receipt:brainEntryReceipt(financial),expiresAtMs});
  await drainBrainOutbox(deps,runId);return filled;
}
/** Fetch outside the financial lease, then use one causal batch boundary and one fenced batch commit. */
export async function runReplacementScan(overrides:Partial<RuntimeDeps>={}):Promise<BrainRuntimeStatus>{
  const deps=dependencies(overrides),started=deps.clock(),run=await currentRun(deps);
  if(!run||await deps.redis.get(prefix(run.runId)+'ledgerAcknowledged')!==true){
    const s=status(deps,run?.runId??null,'RESET_REQUIRED',deps.clock(),deps.assets.map(a=>assetStatus(a,'RESET_REQUIRED')));await publish(deps,s,started);return s;
  }
  const [captures,calendar]=await Promise.all([Promise.allSettled(deps.assets.map(asset=>deps.capture(asset,started))),deps.calendar().catch(()=>null)]);
  const funding=await prefetchFunding(deps,run.runId,deps.clock());
  const now=deps.clock(),source=deps.sourceHash(),frames:RuntimeFrame[]=[],assets=deps.assets.map((asset,i)=>{
    const result=captures[i];if(result.status!=='fulfilled')return assetStatus(asset,'CAPTURE_FAILED',String(result.reason));
    if(result.value.asset!==asset||!frameValid(result.value,now))return assetStatus(asset,'INVALID_CAPTURE');
    frames.push(result.value);return assetStatus(asset,'PENDING');
  });
  const token=randomUUID();if(!await deps.redis.set(LOCK,token,{nx:true,ex:300})){
    const s=status(deps,run.runId,'SHADOW',now,assets,['PORTFOLIO_BUSY']);await publish(deps,s,started);return s;
  }
  try{
    const p=prefix(run.runId),raw=await deps.redis.readRaw([ACTIVE,p+'portfolio',p+'shadow',p+'breakers']);
    if(parse<{runId:string}>(raw[ACTIVE].type==='string'?raw[ACTIVE].value:null)?.runId!==run.runId)throw new Error('AI_EPOCH_CHANGED');
    const portfolio=parse<Portfolio>(rawString(raw,p+'portfolio'));
    if(!portfolio||portfolio.initialCapital!==10000||!Number.isFinite(portfolio.usd)||portfolio.usd<0)throw new Error('INVALID_ACTIVE_ACCOUNT');
    await drainBrainOutbox(deps,run.runId);
    const registrations=new Map<ConfiguredAsset,BrainRegistration>(),setups:SwingSetup[]=[],decisions:BrainDecision[]=[];
    for(const f of frames){const row=assets.find(a=>a.asset===f.asset)!;
      try{
        const r=await registration(deps,run.runId,f.asset,now,source);registrations.set(f.asset,r);
        const decision=evaluateBrain({asset:f.asset,nowMs:now,...f.bars,quote:f.quote,calendar});decisions.push(decision);
        row.decision=decision.status==='SETUP'?{status:'SETUP',setupId:decision.setup.id}:{status:'NO_TRADE',code:decision.code,reason:decision.reason};
        if(decision.status==='SETUP')setups.push(decision.setup);
      }catch(error){row.decision={status:'NO_TRADE',code:'REGISTRATION_MISMATCH',reason:String(error)};row.evidence.reasons=[String(error)];}
    }
    const tape={version:'v6-decision-1',runId:run.runId,startedAtMs:started,decidedAtMs:now,sourceHash:source,frames,calendar,decisions,registrations:[...registrations],
      captures:captures.map((c,i)=>c.status==='fulfilled'?{asset:deps.assets[i],status:c.status,value:c.value}:{asset:deps.assets[i],status:c.status,error:String(c.reason)}),
      captureErrors:assets.filter(a=>['CAPTURE_FAILED','INVALID_CAPTURE'].includes(a.decision.code??''))};
    const decisionId=evidenceHash(tape);await deps.archive?.(run.runId,decisionId,tape);
    await deps.redis.set(p+'decision:'+decisionId,{version:'v6-decision-reference-1',runId:run.runId,decisionId,sourceHash:source,startedAtMs:started,decidedAtMs:now},{nx:true});
    const oldShadow=parse<BrainShadowState>(rawString(raw,p+'shadow'))??emptyBrainShadow(run.runId);
    if(oldShadow.runId!==run.runId||oldShadow.version!=='v6-shadow-1')throw new Error('INVALID_SHADOW_EPOCH');
    const shadow=await advanceBrainShadow({state:oldShadow,frames,setups,registrations,nowMs:now,funding});
    const paper=await collectBrainPaperOutcomes(deps,run.runId,portfolio,now);
    const breakers=evaluateBrainBreakers({equity:markedEquity(portfolio),initialCapital:10000,peakEquity:Math.max(10000,portfolio.peakValue??10000),nowMs:now,
      outcomes:paper.riskOutcomes,previous:parse<BrainBreakerLatch[]>(rawString(raw,p+'breakers'))??[]});
    await deps.redis.commitBrainObservation({runId:run.runId,leaseToken:token,expected:{[ACTIVE]:raw[ACTIVE],[p+'shadow']:raw[p+'shadow'],[p+'breakers']:raw[p+'breakers']},
      writes:{[p+'shadow']:JSON.stringify(shadow),[p+'breakers']:JSON.stringify(breakers.latches)}});
    const reviews=new Map<ConfiguredAsset,BrainEvidenceReview>();
    for(const [asset,r] of registrations){const proof=await review(deps,r,asset,shadow,breakers.latches,paper.outcomes,now,token);if(!proof)continue;reviews.set(asset,proof);
      const row=assets.find(a=>a.asset===asset)!;row.mode=proof.mode;row.riskTier=proof.riskTier;row.evidence={historicalCount:proof.historicalCount,forwardCount:proof.forwardCount,
        paperCount:proof.paperCount,nextEligibleAtMs:proof.nextEligibleAtMs,reasons:proof.reasons};}
    const filled=breakers.rollingBlock?[]:await fillBatch(deps,run.runId,token,frames,setups,registrations,reviews,portfolio,raw,breakers.latches,now);
    for(const asset of filled)assets.find(a=>a.asset===asset)!.decision.status='ENTRY';
    const mode=breakers.latches.some(l=>l.kind!=='STREAK')?'REDUCE_ONLY':assets.some(a=>a.mode==='PAPER_ACTIVE')?'PAPER_ACTIVE':'SHADOW';
    const result=status(deps,run.runId,mode,now,assets,[...breakers.latches.map(l=>l.reason),...(breakers.rollingBlock?[breakers.rollingBlock]:[])]);
    result.equityUsdt=markedEquity(portfolio);result.virtualShadow={equityUsdt:shadowEquity(shadow),openPositions:Object.keys(shadow.open).length,capitalAllocatedUsdt:0};
    result.scanId=(await deps.redis.get<number>(p+'scanSequence')??0)+1;await deps.redis.set(p+'scanSequence',result.scanId);
    await deps.ledger({id:`scan:${run.runId}:${decisionId}`,type:'SCAN_COMPLETED',source:'REPLACEMENT_SWING_V6',timestamp:result.generatedAt,payload:{runId:run.runId,decisionId,
      scanId:result.scanId,sourceHash:source,capitalAllocatedUsdt:0,entries:filled,mode:result.mode}});
    await publish(deps,result,started);return result;
  }finally{await deps.redis.compareAndDelete(LOCK,token);}
}
/** Called alongside protective exits; entry freezes never disable virtual protective observations. */
export async function runReplacementShadowSweep(overrides:Partial<RuntimeDeps>={}):Promise<void>{
  const deps=dependencies(overrides),run=await currentRun(deps);if(!run)return;
  const p=prefix(run.runId),peek=await deps.redis.get<BrainShadowState>(p+'shadow');if(!peek)return;
  const held=[...new Set([...Object.keys(peek.open),...peek.pending.map(x=>x.setup.asset)])] as ConfiguredAsset[];
  if(!held.length)return;
  const captured=await Promise.allSettled(held.map(a=>deps.executionCapture!(a))),funding=await prefetchFunding(deps,run.runId,deps.clock()),now=deps.clock();
  const frames=captured.flatMap(x=>x.status==='fulfilled'&&Number.isFinite(x.value.availableAtMs)&&x.value.availableAtMs<=now?[x.value]:[]);
  const token=randomUUID();if(!await deps.redis.set(LOCK,token,{nx:true,ex:60}))return;
  try{
    const raw=await deps.redis.readRaw([ACTIVE,p+'shadow']);const old=parse<BrainShadowState>(rawString(raw,p+'shadow'));if(!old)return;
    const registrations=new Map<ConfiguredAsset,BrainRegistration>();
    for(const asset of CONFIGURED_ASSETS){const r=await deps.redis.get<BrainRegistration>(p+'runtimeRegistration:'+asset);if(r)registrations.set(asset,r);}
    const next=await advanceBrainShadow({state:old,frames,setups:[],registrations,nowMs:now,funding});
    await deps.redis.commitBrainObservation({runId:run.runId,leaseToken:token,expected:raw,writes:{[p+'shadow']:JSON.stringify(next)}});
  }finally{await deps.redis.compareAndDelete(LOCK,token);}
}

/** Five-second protection updates account latches independently of the slower entry scan. */
export async function refreshBrainProtectiveBreakers(runId:string,portfolio:Portfolio,leaseToken:string,overrides:Partial<RuntimeDeps>={}):Promise<BrainBreakerLatch[]>{
  const deps=dependencies(overrides),p=prefix(runId),expected=await deps.redis.readRaw([ACTIVE,p+'breakers']);
  const paper=await collectBrainPaperOutcomes(deps,runId,portfolio,deps.clock());
  const result=evaluateBrainBreakers({equity:markedEquity(portfolio),initialCapital:10000,peakEquity:Math.max(10000,portfolio.peakValue??10000),nowMs:deps.clock(),
    outcomes:paper.riskOutcomes,previous:parse<BrainBreakerLatch[]>(rawString(expected,p+'breakers'))??[]});
  await deps.redis.commitBrainObservation({runId,leaseToken,expected,writes:{[p+'breakers']:JSON.stringify(result.latches)}});
  return result.latches;
}
