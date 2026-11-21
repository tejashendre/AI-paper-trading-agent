import { capacityNotionalCap, evaluateFillCapacity, type LiquiditySnapshot } from '@/lib/execution/liquidityCost';
import type { MarketPriceSnapshot } from '@/lib/market';
import { estimatePaperFill, expectedFundingTimes } from '@/lib/trading/executionCostModel';
import { decideBrainExit, type SwingSetup } from './engine';
import { allocateBrainRisk, brainVolatilityScale, sizeBrainOrder, type BrainOrderPlan } from './risk';
import type { Candle } from '@/lib/types';
import { brainEvidenceIdentity, evidenceHash, type BrainDailyReturn, type BrainExecutionObservation, type BrainFundingObservation, type BrainOutcome, type BrainRegistration } from './evidence';
import { brainDefinition } from './engine';
import { getConfiguredInstrument, type BybitInstrumentMetadata, type ConfiguredAsset } from '@/lib/trading/instrumentRegistry';
import { validateExitQuote } from '@/lib/trading/entryEligibility';

const DAY=86400000;

export function shadowDailyBoundary(nowMs: number): number | null {
  const boundary = Math.floor(nowMs / DAY) * DAY;
  return nowMs - boundary <= 60000 ? boundary : null;
}

function shadowDailyMark(frame: ShadowMarkFrame | undefined, boundary: number, now: number) {
  const quote = frame?.quote;
  const markTime = quote?.quoteTimes.markMs;
  const price = quote?.markPrice;
  if (!frame || !quote || markTime == null || price == null ||
      ![markTime, quote.receivedAtMs, frame.availableAtMs].every(Number.isFinite) ||
      markTime < boundary || frame.availableAtMs - markTime > 5000 || markTime > (quote.transport === 'REST' ? frame.availableAtMs : quote.receivedAtMs) ||
      quote.receivedAtMs > frame.availableAtMs || frame.availableAtMs > Math.min(now, boundary + 60000) ||
      !/^[a-f0-9]{64}$/.test(frame.sourceHash)) return null;
  const valuationQuote = { ...quote, price, quoteTimes: { ...quote.quoteTimes, lastPriceMs: markTime } };
  return validateExitQuote({ instrument: getConfiguredInstrument(frame.asset), quote: valuationQuote, nowMs: frame.availableAtMs }).valid
    ? { price, markTime, availableAtMs: frame.availableAtMs, sourceHash: frame.sourceHash } : null;
}
// These inputs are frozen into the registration source hash and shared with sizing/exits.
export const BRAIN_EXECUTION_CONTEXT={assetMode:'SLOW_SWING',dataQuality:100,isPeakLiquidity:true,liquidityState:'NEUTRAL',reason:'ENTRY'} as const;
export type ShadowMarkFrame = Pick<ShadowFrame, 'asset' | 'quote' | 'availableAtMs' | 'sourceHash'>;
export interface ShadowFrame {asset:ConfiguredAsset;quote:MarketPriceSnapshot|null;liquidity:LiquiditySnapshot|null;metadata:BybitInstrumentMetadata;
  bars?:{d1:readonly Candle[]};
  fundingRate:number;fundingObservedAtMs:number;availableAtMs:number;sourceHash:string}
export interface ShadowPosition {id:string;setup:SwingSetup;plan:BrainOrderPlan;registration:BrainRegistration;openedAtMs:number;
  stopLoss:number;watermark:number;lastPrice:number;lastObservedAtMs:number;entryObservation:BrainExecutionObservation;
  funding:BrainFundingObservation[];fundingIntervalMinutes:number;fundingCashflow:number;stressedEntryPrice:number;stressedEntryFee:number;criticalViolation:boolean}
interface PendingShadow extends ShadowPosition {closedAtMs:number;exitObservation:BrainExecutionObservation;exitPrice:number;exitFee:number;
  stressedExitPrice:number;stressedExitFee:number;missingFundingTimes:number[];exitReason:string}
type DailyValues<T> = Partial<Record<ConfiguredAsset, T>>;
interface DailyPosition {
  id: string;
  identityHash: string;
  openedAtMs: number;
  intervalMinutes: number;
  side: 1 | -1;
  quantity: number;
  entryPrice: number;
  entryFeeUsdt: number;
}
interface DailySnapshot {
  boundary: number;
  positions: DailyValues<DailyPosition>;
  realized: DailyValues<number>;
  pending: { id: string; asset: ConfiguredAsset }[];
}

export interface BrainShadowState {version:'v6-shadow-1';runId:string;cash:number;peak:number;open:Partial<Record<ConfiguredAsset,ShadowPosition>>;
  peakAtMs?:number;drawdownLatched?:boolean;
  seen:string[];pending:PendingShadow[];outcomes:BrainOutcome[];realizedByAsset:Partial<Record<ConfiguredAsset,number>>;
  equity:{atMs:number;equityUsdt:number}[];dailyReturns:BrainDailyReturn[];
  dailyAnchor:{dayStartMs:number;values:DailyValues<number>;identities?:DailyValues<string>}|null;
  dailySnapshot?: DailySnapshot;
  forwardAnchors?: Record<string, number>;
  gaps:string[];
  lastMissingBoundaryByGap?: Record<string, number>;
  legacyGapAnchorMs?: number | null;
}
export function emptyBrainShadow(runId:string):BrainShadowState {
  return {version:'v6-shadow-1',runId,cash:10000,peak:10000,open:{},seen:[],pending:[],outcomes:[],realizedByAsset:{},equity:[],dailyReturns:[],dailyAnchor:null,gaps:[]};
}
export function shadowIntegrityRestored(state: BrainShadowState, registration: BrainRegistration): boolean {
  // Old gap records were written only when a valid anchor resumed. Preserve
  // that anchor as the upper bound when the old records lack an end timestamp.
  const historicalAnchor = state.legacyGapAnchorMs === undefined ? state.dailyAnchor?.dayStartMs : state.legacyGapAnchorMs;
  return state.pending.length === 0 && state.gaps.every(gap => {
    const lastMissing = state.lastMissingBoundaryByGap?.[gap] ?? historicalAnchor;
    return typeof lastMissing === 'number' && Number.isFinite(lastMissing) && lastMissing < registration.registeredAtMs;
  });
}

export function shadowExecution(frame:ShadowFrame,atMs:number,direction:'LONG'|'SHORT',quantity:number,price:number,stop:number):BrainExecutionObservation|null {
  const q=frame.quote,l=frame.liquidity;
  if(!q||!l||![q.bid,q.ask,l.observedAtMs,frame.availableAtMs,q.receivedAtMs].every(Number.isFinite)||
    frame.availableAtMs>atMs||l.observedAtMs>atMs||atMs-l.observedAtMs>5000||q.receivedAtMs>atMs||atMs-q.receivedAtMs>5000||
    !(q.bid!>0&&q.ask!>q.bid!))return null;
  if(!validateExitQuote({instrument:getConfiguredInstrument(frame.asset),quote:q,nowMs:atMs}).valid||
    [q.eventTimeMs,...Object.values(q.quoteTimes)].some(t=>t===null||!Number.isFinite(t)||t>atMs||t>q.receivedAtMs||atMs-t>5000))return null;
  const c=evaluateFillCapacity({side:direction==='LONG'?'BUY':'SELL',quantity,entryPrice:price,stopPrice:stop,impactBps:0,liquidity:l});
  if(!c.allowed||!('depthWithinBandUsdt' in c.snapshot)||!(c.snapshot.depthWithinBandUsdt!>0))return null;
  return {atMs,availableAtMs:frame.availableAtMs,halfSpreadBps:(q.ask!-q.bid!)/(q.ask!+q.bid!)*10000,
    depthNotionalUsdt:c.snapshot.depthWithinBandUsdt!,sourceHash:evidenceHash({frame:frame.sourceHash,liquidity:l,quote:q})};
}
export function shadowEquity(s:BrainShadowState):number {
  return s.cash+Object.values(s.open).reduce((sum,p)=>sum+p!.plan.marginUsdt+(p!.setup.direction==='LONG'?1:-1)*p!.plan.quantity*(p!.lastPrice-p!.plan.entryPrice),0);
}
function profile(p:ShadowPosition,halfSpreadBps:number,stress=false){const x=p.registration.costs.profile,k=stress?2:1;
  return {...x,halfSpreadBps:Math.max(x.halfSpreadBps,halfSpreadBps)*k,baseSlippageBps:x.baseSlippageBps*k,sizeImpactBps:x.sizeImpactBps*k,stopGapBps:x.stopGapBps*k};}
export function brainStressedEntry(setup:SwingSetup,plan:BrainOrderPlan,r:BrainRegistration,halfSpreadBps:number){
  const cost=r.costs.profile,fill=estimatePaperFill({asset:setup.asset,action:setup.direction==='LONG'?'BUY':'SHORT',requestedPrice:setup.entryPrice,amount:plan.quantity,
    context:BRAIN_EXECUTION_CONTEXT,profile:{...cost,halfSpreadBps:Math.max(cost.halfSpreadBps,halfSpreadBps)*2,
      baseSlippageBps:cost.baseSlippageBps*2,sizeImpactBps:cost.sizeImpactBps*2,stopGapBps:cost.stopGapBps*2},feeScheduleVersion:r.costs.feeSchedule.version});
  return {fillPrice:fill.fillPrice,feeUsdt:2*fill.feeUsd};
}
/** One shared virtual account. It never writes a portfolio, trade, or capital allocation. */
export async function advanceBrainShadow(input:{state:BrainShadowState;frames:ShadowFrame[];setups:SwingSetup[];registrations:Map<ConfiguredAsset,BrainRegistration>;
  nowMs:number;funding:(asset:ConfiguredAsset,fromMs:number,toMs:number)=>Promise<BrainFundingObservation[]>}):Promise<BrainShadowState>{
  const s=structuredClone(input.state),now=input.nowMs,frames=new Map(input.frames.map(f=>[f.asset,f]));
  pinDailySnapshot(s, shadowDailyBoundary(now));
  const settle=async(p:ShadowPosition,toMs:number)=>{
    const interval=p.entryObservation&&p.registration?getInterval(p):0;
    const expected=expectedFundingTimes(p.openedAtMs,toMs,interval),known=new Set(p.funding.map(f=>f.atMs));
    const missing=expected.filter(at=>!known.has(at));if(!missing.length)return [];
    const rows=await input.funding(p.setup.asset,Math.min(...missing)-1,toMs).catch(()=>[]);
    for(const row of rows){
      if(!missing.includes(row.atMs)||known.has(row.atMs)||row.availableAtMs>now||row.availableAtMs<row.atMs||
        ![row.actualRate,row.mark,row.intervalMinutes].every(Number.isFinite)||row.mark<=0||row.intervalMinutes!==interval||!/^[a-f0-9]{64}$/.test(row.sourceHash))continue;
      known.add(row.atMs);p.funding.push(row);const flow=(p.setup.direction==='LONG'?-1:1)*p.plan.quantity*row.mark*row.actualRate;
      p.fundingCashflow+=flow;s.cash+=flow;
    }
    return expected.filter(at=>!known.has(at));
  };
  for(const p of Object.values(s.open)){
    if(!p)continue;
    await settle(p, now);
    const f=frames.get(p.setup.asset),q=f?.quote;
    if(!f||!q)continue;
    const observed=shadowExecution(f,now,p.setup.direction==='LONG'?'SHORT':'LONG',p.plan.quantity,q.price,p.stopLoss);
    if(!observed)continue;
    if(now-p.lastObservedAtMs>10000)p.criticalViolation=true;
    p.lastPrice=q.markPrice??q.price;p.lastObservedAtMs=now;
    const exit=decideBrainExit({policy:{...p.setup.policy,priceRDistance:Math.abs(p.plan.entryPrice-p.plan.stopLoss)},direction:p.setup.direction,
      entryPrice:p.plan.entryPrice,stopLoss:p.stopLoss,currentPrice:p.setup.direction==='LONG'?q.bid!:q.ask!,openedAtMs:p.openedAtMs,nowMs:now,watermark:p.watermark});
    p.stopLoss=exit.stopLoss;p.watermark=exit.watermark;if(exit.action!=='EXIT')continue;
    const fill=(stressed:boolean)=>estimatePaperFill({asset:p.setup.asset,action:p.setup.direction==='LONG'?'SELL':'COVER',requestedPrice:q.price,amount:p.plan.quantity,
      context:{...BRAIN_EXECUTION_CONTEXT,reason:exit.reason==='STOP'||exit.reason==='TRAILING'?'STOP_LOSS':'TAKE_PROFIT'},
      profile:profile(p,observed.halfSpreadBps,stressed),feeScheduleVersion:p.registration.costs.feeSchedule.version});
    const base=fill(false),stress=fill(true);
    s.cash+=p.plan.marginUsdt+(p.setup.direction==='LONG'?1:-1)*p.plan.quantity*(base.fillPrice-p.plan.entryPrice)-base.feeUsd;
    delete s.open[p.setup.asset];
    s.pending.push({...p,closedAtMs:now,exitPrice:base.fillPrice,exitFee:base.feeUsd,stressedExitPrice:stress.fillPrice,stressedExitFee:2*stress.feeUsd,
      exitObservation:observed,missingFundingTimes:[],exitReason:exit.reason??'INVALID_INPUT'});
  }
  for(const p of s.pending){
    p.missingFundingTimes=await settle(p,p.closedAtMs);if(p.missingFundingTimes.length)continue;
    const sign=p.setup.direction==='LONG'?1:-1,net=sign*p.plan.quantity*(p.exitPrice-p.plan.entryPrice)-p.plan.entryFeeUsdt-p.exitFee+p.fundingCashflow;
    const stressedFunding=p.funding.reduce((sum,f)=>sum-2*p.plan.quantity*f.mark*Math.max(Math.abs(f.actualRate),.0001*f.intervalMinutes/480),0);
    const stressed=sign*p.plan.quantity*(p.stressedExitPrice-p.stressedEntryPrice)-p.stressedEntryFee-p.stressedExitFee+stressedFunding;
    const outcome:BrainOutcome={positionId:p.id,identityHash:brainEvidenceIdentity(brainDefinition(p.setup.asset),p.registration),runId:s.runId,origin:'SHADOW',
      openedAtMs:p.openedAtMs,closedAtMs:p.closedAtMs,netR:net/p.plan.initialRiskUsdt,stressedNetR:Math.min(net,stressed)/p.plan.initialRiskUsdt,
      initialRiskUsdt:p.plan.initialRiskUsdt,costHash:p.registration.costHash,executions:[p.entryObservation,p.exitObservation],fundingIntervalMs:getInterval(p)*60000,
      funding:p.funding,criticalViolation:p.criticalViolation,availableAtMs:now,sourceHash:evidenceHash(p)};
    if(!s.outcomes.some(x=>x.positionId===p.id)){s.outcomes.push(outcome);s.realizedByAsset[p.setup.asset]=(s.realizedByAsset[p.setup.asset]??0)+net;}
  }
  s.pending=s.pending.filter(p=>p.missingFundingTimes.length>0);
  const equity=shadowEquity(s);if(equity>s.peak){s.peak=equity;s.peakAtMs=now;}
  const candidates=input.setups.filter(x=>!s.open[x.asset]&&!s.seen.includes(x.id)&&!s.pending.some(p=>p.setup.asset===x.asset)).sort((a,b)=>a.asset.localeCompare(b.asset));
  const plans=candidates.flatMap(setup=>{
    const f=frames.get(setup.asset),r=input.registrations.get(setup.asset);if(!f||!r||!f.quote)return [];
    const observation=shadowExecution(f,now,setup.direction,1,setup.entryPrice,setup.stopLoss),capacity=capacityNotionalCap({side:setup.direction==='LONG'?'BUY':'SELL',liquidity:f.liquidity});
    if(!observation||capacity===null||!Number.isFinite(f.fundingRate)||now-f.fundingObservedAtMs>60000||f.fundingObservedAtMs>now)return [];
    const volatility=brainVolatilityScale(f.bars?.d1??[],now);if(volatility===null)return [];
    const order={setup,metadata:f.metadata,nowMs:now,riskBudgetUsdt:equity*.0025*volatility,equity,availableCash:s.cash,capacityNotionalUsdt:capacity,
      halfSpreadBps:observation.halfSpreadBps,fundingRate:f.fundingRate};
    const plan=sizeBrainOrder(order);return plan.approved?[{setup,f,r,observation,order,plan}]:[];
  });
  const allocations=allocateBrainRisk({equity,initialCapital:10000,peakEquity:s.peak,freeCash:s.cash,
    open:Object.values(s.open).map(p=>({asset:p!.setup.asset,riskUsdt:p!.plan.initialRiskUsdt,notionalUsdt:p!.plan.notionalUsdt,marginUsdt:p!.plan.marginUsdt})),
    candidates:plans.map(p=>({id:p.setup.id,asset:p.setup.asset,riskUsdt:p.plan.initialRiskUsdt,notionalUsdt:p.plan.notionalUsdt,marginUsdt:p.plan.marginUsdt}))});
  for(const allocation of allocations){
    const c=plans.find(p=>p.setup.id===allocation.id)!;if(!(allocation.scale>0))continue;
    const plan=sizeBrainOrder({...c.order,riskBudgetUsdt:allocation.riskUsdt,capacityNotionalUsdt:allocation.notionalUsdt,availableCash:Math.min(s.cash,allocation.marginUsdt+c.plan.entryFeeUsdt)});
    if(!plan.approved)continue;
    const stress=brainStressedEntry(c.setup,plan,c.r,c.observation.halfSpreadBps);
    s.cash-=plan.marginUsdt+plan.entryFeeUsdt;s.seen.push(c.setup.id);
    s.open[c.setup.asset]={id:`shadow:${s.runId}:${c.setup.id}`,setup:{...c.setup,policy:{...c.setup.policy,priceRDistance:Math.abs(plan.entryPrice-plan.stopLoss)}},plan,
      registration:c.r,openedAtMs:now,stopLoss:plan.stopLoss,watermark:plan.entryPrice,lastPrice:c.f.quote!.markPrice??c.f.quote!.price,lastObservedAtMs:now,
      entryObservation:c.observation,funding:[],fundingCashflow:0,stressedEntryPrice:stress.fillPrice,stressedEntryFee:stress.feeUsdt,criticalViolation:false,
      fundingIntervalMinutes:c.f.metadata.fundingIntervalMinutes};
  }
  const endEquity=shadowEquity(s);
  const breached=endEquity<=Math.max(9000,.9*s.peak);
  // Keep the full daily series and the first observed breaker without rewriting a growing 5-second curve forever.
  if(breached&&!s.drawdownLatched){
    if(s.peakAtMs&&s.peakAtMs<now&&!s.equity.some(x=>x.atMs===s.peakAtMs))s.equity.push({atMs:s.peakAtMs,equityUsdt:s.peak});
    s.equity.push({atMs:now,equityUsdt:endEquity});s.drawdownLatched=true;s.equity.sort((a,b)=>a.atMs-b.atMs);
  }else if(!s.equity.length||now-s.equity.at(-1)!.atMs>=30*60000)s.equity.push({atMs:now,equityUsdt:endEquity});
  return s;
}

function pinDailySnapshot(s: BrainShadowState, boundary: number | null) {
  if (boundary !== null && boundary > (s.dailyAnchor?.dayStartMs ?? -1) && s.dailySnapshot?.boundary !== boundary) {
    const positions: DailyValues<DailyPosition> = {};
    for (const p of Object.values(s.open)) {
      positions[p.setup.asset] = {
        id: p.id, identityHash: brainEvidenceIdentity(brainDefinition(p.setup.asset), p.registration),
        openedAtMs: p.openedAtMs, intervalMinutes: p.fundingIntervalMinutes,
        side: p.setup.direction === 'LONG' ? 1 : -1, quantity: p.plan.quantity,
        entryPrice: p.plan.entryPrice, entryFeeUsdt: p.plan.entryFeeUsdt,
      };
    }
    s.dailySnapshot = { boundary, positions, realized: { ...s.realizedByAsset },
      pending: s.pending.map(p => ({ id: p.id, asset: p.setup.asset })) };
  }
}

export function recordShadowDailyReturn(input: { state: BrainShadowState; marks: ShadowMarkFrame[];
  registrations: Map<ConfiguredAsset, BrainRegistration>; nowMs: number }): BrainShadowState {
  const now = input.nowMs;
  const boundary = shadowDailyBoundary(now);
  if (boundary === null || boundary <= (input.state.dailyAnchor?.dayStartMs ?? -1)) return input.state;
  const s = structuredClone(input.state);
  pinDailySnapshot(s, boundary);
  const snapshot = s.dailySnapshot;
  if (boundary === null || snapshot?.boundary !== boundary || !input.registrations.size) return s;

  // Use the positions and realized equity held before processing the boundary
  // sweep. A late mark still represents that cohort, even if an exit or entry
  // was processed while waiting for the mark.
  const outcomes = new Map(s.outcomes.map(row => [row.positionId, row]));
  const realized = { ...snapshot.realized };
  for (const pending of snapshot.pending) {
    const outcome = outcomes.get(pending.id);
    if (!outcome) return s;
    realized[pending.asset] = (realized[pending.asset] ?? 0) + outcome.netR * outcome.initialRiskUsdt;
  }
  const boundaryFrames = new Map(input.marks.map(frame => [frame.asset, frame]));
  const marks: DailyValues<NonNullable<ReturnType<typeof shadowDailyMark>>> = {};
  const unrealized: DailyValues<number> = {};
  for (const [key, position] of Object.entries(snapshot.positions)) {
    const asset = key as ConfiguredAsset;
    const registration = input.registrations.get(asset);
    if (!registration || position.identityHash !== brainEvidenceIdentity(brainDefinition(asset), registration)) continue;
    const mark = shadowDailyMark(boundaryFrames.get(asset), boundary, now);
    if (!mark) return s;
    const open = s.open[asset];
    const funding = (open?.id === position.id ? open.funding
      : s.pending.find(p => p.id === position.id)?.funding ?? outcomes.get(position.id)?.funding) ?? [];
    const settled = new Set(funding.map(row => row.atMs));
    const dueBeforeBoundary = expectedFundingTimes(position.openedAtMs, boundary - 1, position.intervalMinutes);
    if (dueBeforeBoundary.some(at => !settled.has(at))) return s;
    const cashflow = funding.reduce((cash, row) => row.atMs < boundary
      ? cash - position.side * position.quantity * row.mark * row.actualRate : cash, 0);
    unrealized[asset] = position.side * position.quantity * (mark.price - position.entryPrice) -
      position.entryFeeUsdt + cashflow;
    marks[asset] = mark;
  }
  const values: DailyValues<number> = {};
  const identities: DailyValues<string> = {};
  for (const [asset, registration] of input.registrations) {
    if (Math.max(registration.registeredAtMs, registration.releasedAtMs) > boundary) continue;
    const identityHash = brainEvidenceIdentity(brainDefinition(asset), registration);
    const position = snapshot.positions[asset];
    if (position && position.identityHash !== identityHash) continue;
    const value = 10000 + (realized[asset] ?? 0) + (unrealized[asset] ?? 0);
    values[asset] = value;
    identities[asset] = identityHash;
    s.forwardAnchors ??= {};
    s.forwardAnchors[identityHash] ??= boundary;
    const previousValue = s.dailyAnchor?.values[asset];
    if (s.dailyAnchor && boundary === s.dailyAnchor.dayStartMs + DAY && previousValue !== undefined &&
        s.dailyAnchor.identities?.[asset] === identityHash) {
      s.dailyReturns.push({
        identityHash, runId: s.runId, costHash: registration.costHash, dayStartMs: s.dailyAnchor.dayStartMs,
        baseRiskFraction: .0025, netReturn: value / previousValue - 1, availableAtMs: now,
        sourceHash: evidenceHash({ asset, boundary, value, mark: marks[asset], previous: s.dailyAnchor }),
      });
    }
  }
  if (s.legacyGapAnchorMs === undefined && s.gaps.some(gap => !Object.hasOwn(s.lastMissingBoundaryByGap ?? {}, gap))) {
    s.legacyGapAnchorMs = s.dailyAnchor?.dayStartMs ?? null;
  }
  if (s.dailyAnchor && boundary > s.dailyAnchor.dayStartMs + DAY) {
    const gap = `MISSED_DAILY_MARK:${s.dailyAnchor.dayStartMs}`;
    s.gaps.push(gap);
    s.lastMissingBoundaryByGap ??= {};
    s.lastMissingBoundaryByGap[gap] = boundary - DAY;
  }
  s.dailyAnchor = { dayStartMs: boundary, values, identities };
  delete s.dailySnapshot;
  return s;
}
function getInterval(p:ShadowPosition):number{return p.fundingIntervalMinutes;}
