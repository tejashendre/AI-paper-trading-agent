import { getConfiguredInstrument, isMetadataUsable, type ConfiguredAsset, type BybitInstrumentMetadata } from '@/lib/trading/instrumentRegistry';
import { alignStopTowardEntry, decimalString, floorOrderQty, getAssetSpec, validateOrderSize } from '@/lib/trading/assetSpecs';
import { buildPaperExecutionPlan, expectedFundingTimes } from '@/lib/trading/executionCostModel';
import { evidenceHash, freezeBrainCosts } from './evidence';
import type { SwingSetup } from './engine';
export interface RiskExposure { asset: ConfiguredAsset; riskUsdt: number; notionalUsdt: number; marginUsdt: number }
export interface RiskRequest extends RiskExposure { id: string; riskTier?: 'INITIAL' | 'ESCALATED' }
export interface RiskAllocation extends RiskRequest { scale: number; reason: string }
export interface BrainOrderInput { setup: SwingSetup; metadata: BybitInstrumentMetadata; nowMs: number; riskBudgetUsdt: number;
  equity: number; availableCash: number; capacityNotionalUsdt: number; halfSpreadBps: number; fundingRate: number;
  riskTier?: 'INITIAL' | 'ESCALATED'; stressed?: boolean }
export interface BrainOrderPlan { approved: boolean; reason: string; quantity: number; entryPrice: number; stopLoss: number;
  takeProfit: number; notionalUsdt: number; marginUsdt: number; leverage: number; initialRiskUsdt: number;
  fundingReserveUsdt: number; netRewardRisk: number; entryFeeUsdt: number; costHash: string }
export interface BrainBreakerLatch { kind: 'DRAWDOWN'|'STREAK'|'INTEGRITY'; scope: string; atMs: number; reason: string }
export interface BrainRiskOutcome { asset: ConfiguredAsset; closedAtMs: number; netPnlUsdt: number; netR: number|null; exitReason: string }
export function evaluateBrainBreakers(input: {equity:number;initialCapital:number;peakEquity:number;nowMs:number;
  outcomes:BrainRiskOutcome[];previous?:BrainBreakerLatch[]}):{latches:BrainBreakerLatch[];rollingBlock:string|null} {
  const latches=[...(input.previous??[])];
  const add=(kind:BrainBreakerLatch['kind'],scope:string,reason:string)=>{
    if(!latches.some(x=>x.kind===kind&&x.scope===scope))latches.push({kind,scope,atMs:input.nowMs,reason});
  };
  if(![input.equity,input.initialCapital,input.peakEquity,input.nowMs].every(x=>Number.isFinite(x)&&x>0)) add('INTEGRITY','account','INVALID_MARKED_ACCOUNT');
  if(input.equity<=Math.max(.9*input.initialCapital,.9*input.peakEquity))add('DRAWDOWN','account','TEN_PERCENT_DRAWDOWN');
  const outcomes=[...input.outcomes].sort((a,b)=>b.closedAtMs-a.closedAtMs);
  if(outcomes.some(x=>![x.closedAtMs,x.netPnlUsdt].every(Number.isFinite)||x.closedAtMs>input.nowMs))add('INTEGRITY','account','INVALID_OUTCOME_CLOCK_OR_VALUE');
  for(const x of outcomes)if(x.netR!==null&&(!Number.isFinite(x.netR)||x.netR < -1.5))add('INTEGRITY',x.asset,'LOSS_BEYOND_FROZEN_RISK');
  const cluster=(a:ConfiguredAsset)=>['BTC','ETH','SOL'].includes(a)?'crypto':['GOLD','SILVER'].includes(a)?'metals':a==='OIL'?'oil':'fx';
  const streak=(rows:BrainRiskOutcome[])=>{let n=0;for(const x of rows){if(x.netPnlUsdt>=0)break;if(['STOP','STOP_LOSS','TRAILING'].includes(x.exitReason))n++;}return n;};
  if(streak(outcomes)>=4)add('STREAK','account','FOUR_COMPLETED_STOP_LOSSES');
  for(const group of ['crypto','fx','metals','oil'])if(streak(outcomes.filter(x=>cluster(x.asset)===group))>=3)add('STREAK',group,'THREE_FACTOR_STOP_LOSSES');
  const pnl=(ms:number)=>outcomes.filter(x=>x.closedAtMs>=input.nowMs-ms&&x.closedAtMs<=input.nowMs).reduce((s,x)=>s+x.netPnlUsdt,0);
  return {latches,rollingBlock:pnl(86400000)<=-.02*input.equity?'DAILY_LOSS_BRAKE':pnl(7*86400000)<=-.04*input.equity?'WEEKLY_LOSS_BRAKE':null};
}
export function allocateBrainRisk(input: { equity: number; initialCapital: number; peakEquity: number;
  open: RiskExposure[]; candidates: RiskRequest[]; halted?: boolean; freeCash?: number }): RiskAllocation[] {
  const refuse = (reason: string) => input.candidates.map(x => ({ ...x, riskUsdt: 0, notionalUsdt: 0, marginUsdt: 0, scale: 0, reason }));
  const validExposure = (x: RiskExposure) => [x.riskUsdt,x.notionalUsdt,x.marginUsdt].every(v=>Number.isFinite(v)&&v>=0);
  if (input.halted || ![input.equity,input.initialCapital,input.peakEquity].every(v=>Number.isFinite(v)&&v>0) ||
    ![...input.open,...input.candidates].every(validExposure) || new Set(input.candidates.map(x=>x.id)).size!==input.candidates.length ||
    (input.freeCash!==undefined && (!Number.isFinite(input.freeCash)||input.freeCash<0))) return refuse('INVALID_OR_HALTED_ACCOUNT');
  const floor = Math.max(input.initialCapital*0.9,input.peakEquity*0.9);
  if (input.equity<=floor) return refuse('DRAWDOWN_HALT');
  const sum = (xs: RiskExposure[], field: 'riskUsdt'|'notionalUsdt'|'marginUsdt') => xs.reduce((s,x)=>s+x[field],0);
  const candidates=input.candidates.map(x=>{
    const cap=input.equity*(x.riskTier==='ESCALATED'?0.005:0.0025);
    const scale=x.riskUsdt>0?Math.min(1,cap/x.riskUsdt):0;
    return {...x,riskUsdt:x.riskUsdt*scale,notionalUsdt:x.notionalUsdt*scale,marginUsdt:x.marginUsdt*scale,baseScale:scale};
  });
  const ratio=(capacity:number,demand:number)=>demand>0?Math.max(0,Math.min(1,capacity/demand)):1;
  const common=Math.min(ratio(Math.min(input.equity*.02,input.equity-floor)-sum(input.open,'riskUsdt'),sum(candidates,'riskUsdt')),
    ratio(input.equity*2.5-sum(input.open,'notionalUsdt'),sum(candidates,'notionalUsdt')),
    ratio(Math.min(input.equity*.4-sum(input.open,'marginUsdt'),input.freeCash??Infinity),sum(candidates,'marginUsdt')));
  const group=(a:ConfiguredAsset)=>['BTC','ETH','SOL'].includes(a)?'crypto': ['EURUSD','GBPUSD','USDJPY'].includes(a)?'fx':
    ['GOLD','SILVER'].includes(a)?'metals':'oil';
  return candidates.map(x=>{
    const key=group(x.asset), room=input.equity*.01-sum(input.open.filter(p=>group(p.asset)===key),'riskUsdt');
    const factor=Math.min(common,ratio(room,sum(candidates.filter(p=>group(p.asset)===key),'riskUsdt')));
    const {baseScale,...row}=x;
    return {...row,riskUsdt:x.riskUsdt*factor,notionalUsdt:x.notionalUsdt*factor,marginUsdt:x.marginUsdt*factor,
      scale:baseScale*factor,reason:factor>0?'BOUNDED_BATCH_ALLOCATION':'CAPACITY_EXHAUSTED'};
  });
}
export function sizeBrainOrder(input: BrainOrderInput): BrainOrderPlan {
  const reject=(reason:string):BrainOrderPlan=>({approved:false,reason,quantity:0,entryPrice:0,stopLoss:0,takeProfit:0,
    notionalUsdt:0,marginUsdt:0,leverage:1,initialRiskUsdt:0,fundingReserveUsdt:0,netRewardRisk:0,entryFeeUsdt:0,costHash:''});
  const {setup:s,metadata:m}=input;
  if (![input.nowMs,input.riskBudgetUsdt,input.equity,input.availableCash,input.capacityNotionalUsdt,s.entryPrice,s.stopLoss,s.atr,s.policy.targetR,s.policy.maxHoldMs].every(v=>Number.isFinite(v)&&v>0) ||
    !Number.isFinite(input.halfSpreadBps)||input.halfSpreadBps<0||!Number.isFinite(input.fundingRate) ||
    !Number.isFinite(s.expiresAtMs)||input.nowMs>s.expiresAtMs||input.nowMs<s.featureCutoffMs) return reject('INVALID_OR_EXPIRED_ORDER');
  if (m.symbol!==getConfiguredInstrument(s.asset).symbol || !isMetadataUsable(m,input.nowMs) || !(m.fundingIntervalMinutes>0)) return reject('INVALID_CONTRACT_METADATA');
  const sign=s.direction==='LONG'?1:-1;
  if (sign*(s.entryPrice-s.stopLoss)<=0) return reject('INVALID_STOP');
  const spec=getAssetSpec(s.asset), costs=freezeBrainCosts(s.asset), costHash=evidenceHash(costs);
  const multiple=input.stressed?2:1;
  const profile={...costs.profile,halfSpreadBps:Math.max(costs.profile.halfSpreadBps,input.halfSpreadBps)*multiple,
    baseSlippageBps:costs.profile.baseSlippageBps*multiple,sizeImpactBps:costs.profile.sizeImpactBps*multiple,
    stopGapBps:costs.profile.stopGapBps*multiple};
  const stopLoss=alignStopTowardEntry({price:s.stopLoss,entryPrice:s.entryPrice,metadata:m});
  const riskBudget=Math.min(input.riskBudgetUsdt,input.equity*(input.riskTier==='ESCALATED'?.005:.0025));
  const maxLeverage=Math.min(spec.maxLeverage,m.maxLeverage);
  const notionalCap=Math.min(input.capacityNotionalUsdt,input.equity*spec.maxMarginPercent*maxLeverage,input.equity*2.5);
  const settlements=expectedFundingTimes(input.nowMs,input.nowMs+s.policy.maxHoldMs,m.fundingIntervalMinutes).length;
  const fundingRate=Math.max(Math.abs(input.fundingRate),.0001*m.fundingIntervalMinutes/480)*multiple;
  const estimate=(amount:number)=>{
    const context={assetMode:'SLOW_SWING' as const,dataQuality:100,isPeakLiquidity:true,liquidityState:'NEUTRAL'};
    const initial=buildPaperExecutionPlan({asset:s.asset,direction:s.direction,entryPrice:s.entryPrice,stopLoss,
      takeProfit:s.takeProfit,amount,context,profile,feeScheduleVersion:costs.feeSchedule.version});
    const rawTarget=initial.entry.fillPrice+sign*Math.abs(initial.entry.fillPrice-stopLoss)*s.policy.targetR;
    const target=alignStopTowardEntry({price:rawTarget,entryPrice:initial.entry.fillPrice,metadata:m});
    const plan=buildPaperExecutionPlan({asset:s.asset,direction:s.direction,entryPrice:s.entryPrice,stopLoss,
      takeProfit:target,amount,context,profile,feeScheduleVersion:costs.feeSchedule.version});
    const funding=plan.entry.notionalUsd*fundingRate*settlements;
    const netLoss=plan.netLossUsd+funding+(multiple-1)*(plan.entry.feeUsd+plan.stopExit.feeUsd);
    const netReward=plan.netRewardUsd-funding-(multiple-1)*(plan.entry.feeUsd+plan.targetExit.feeUsd);
    return {plan,target,funding,netLoss,netReward};
  };
  let lo=0,hi=Math.min(notionalCap/s.entryPrice,riskBudget/Math.abs(s.entryPrice-stopLoss));
  try {
    for(let i=0;i<60;i++) {const mid=(lo+hi)/2;if(!(mid>0))break;const e=estimate(mid);
      const requiredLev=Math.max(1,Math.ceil(e.plan.entry.notionalUsd/(input.equity*spec.maxMarginPercent)));
      const margin=e.plan.entry.notionalUsd/requiredLev;
      if(e.netLoss<=riskBudget && requiredLev<=maxLeverage && margin+e.plan.entry.feeUsd*multiple<=input.availableCash)lo=mid;else hi=mid;}
    const text=floorOrderQty(decimalString(lo),m),quantity=Number(text);
    if(!(quantity>0))return reject('BELOW_MINIMUM_QUANTITY');
    const e=estimate(quantity),notional=e.plan.entry.notionalUsd;
    const leverage=Math.max(1,Math.ceil(notional/(input.equity*spec.maxMarginPercent))),margin=notional/leverage;
    const check=validateOrderSize({quantity:text,price:e.plan.entry.fillPrice,metadata:m,maxNotionalUsdt:notionalCap});
    const rr=e.netLoss>0?e.netReward/e.netLoss:0;
    if(!check.allowed)return reject(check.reasons.join('; '));
    if(margin<spec.minMarginUsd || leverage>maxLeverage || margin+e.plan.entry.feeUsd*multiple>input.availableCash ||
      e.netLoss>riskBudget+1e-8 || !Number.isFinite(rr)||rr<1.5) return reject('COST_RISK_OR_MARGIN_GATE');
    return {approved:true,reason:'BOUNDED_NET_STOP_RISK',quantity,entryPrice:e.plan.entry.fillPrice,stopLoss,takeProfit:e.target,
      notionalUsdt:notional,marginUsdt:margin,leverage,initialRiskUsdt:e.netLoss,fundingReserveUsdt:e.funding,
      netRewardRisk:rr,entryFeeUsdt:e.plan.entry.feeUsd*multiple,costHash};
  } catch { return reject('UNUSABLE_EXECUTION_OR_LOT_RULES'); }
}
