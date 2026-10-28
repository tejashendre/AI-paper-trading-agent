import type { Candle } from '@/lib/types';
import type { MarketPriceSnapshot } from '@/lib/market';
import { decimalString, floorOrderQty } from '@/lib/trading/assetSpecs';
import { estimatePaperFill, expectedFundingTimes } from '@/lib/trading/executionCostModel';
import { getConfiguredInstrument, type ConfiguredAsset } from '@/lib/trading/instrumentRegistry';
import { brainDefinition, decideBrainExit, evaluateBrain, type BrainExitInput, type CalendarManifest, type SwingSetup } from './engine';
import type { BrainRegistration } from './evidence';
import { evidenceHash, freezeBrainCosts } from './evidence';
import { verifyBrainDataset, type BrainDataset } from './data';
import { allocateBrainRisk, brainVolatilityScale, evaluateBrainBreakers, sizeBrainOrder, type BrainOrderPlan, type BrainBreakerLatch, type BrainRiskOutcome } from './risk';

/** Bar replay is pessimistic about unknown intrabar order. It cannot establish tick-level execution evidence. */
export function replayExitBar(input: Omit<BrainExitInput,'currentPrice'>,bar:Candle){
  if(![bar.open,bar.high,bar.low,bar.close].every(x=>Number.isFinite(x)&&x>0)||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close))throw new Error('Invalid exit bar');
  const long=input.direction==='LONG',sign=long?1:-1;
  const barOpenMs=Math.max(input.openedAtMs,bar.time*1000);
  const atOpen=decideBrainExit({...input,nowMs:barOpenMs,currentPrice:bar.open});
  if(atOpen.action==='EXIT')return {...atOpen,exitPrice:bar.open};
  // An old stop has precedence over every favorable extreme in the same bar.
  if(long?bar.low<=input.stopLoss:bar.high>=input.stopLoss){
    const result=decideBrainExit({...input,currentPrice:input.stopLoss});
    return {...result,exitPrice:input.stopLoss};
  }
  // A max-hold deadline inside this bar has no observed tick price. Use its
  // adverse bound, rather than pretending the earlier opening price was available then.
  if(input.nowMs>=input.openedAtMs+input.policy.maxHoldMs){
    const adverse=long?bar.low:bar.high;
    return {...decideBrainExit({...input,currentPrice:adverse}),action:'EXIT' as const,reason:'TIME' as const,exitPrice:adverse};
  }
  const target=input.entryPrice+sign*input.policy.priceRDistance*input.policy.targetR;
  if(long?bar.high>=target:bar.low<=target)return {...decideBrainExit({...input,currentPrice:target}),exitPrice:target};
  const favorable=long?bar.high:bar.low;
  const moved=decideBrainExit({...input,currentPrice:favorable});
  const adverse=long?bar.low:bar.high;
  if(moved.stopLoss!==input.stopLoss&&(long?adverse<=moved.stopLoss:adverse>=moved.stopLoss)){
    return {...moved,action:'EXIT' as const,reason:'TRAILING' as const,exitPrice:moved.stopLoss};
  }
  const result=decideBrainExit({...input,stopLoss:moved.stopLoss,watermark:moved.watermark,currentPrice:bar.close});
  return {...result,exitPrice:result.action==='EXIT'?bar.close:null};
}
export interface ReplaySettlement {atMs:number;rate:number;mark:number|null;availableAtMs:number;sourceHash:string}
export function replayFunding(input:{openedAtMs:number;closedAtMs:number;intervalMinutes:number;direction:'LONG'|'SHORT';quantity:number;settlements:ReplaySettlement[]}){
  if(![input.openedAtMs,input.closedAtMs,input.intervalMinutes,input.quantity].every(Number.isFinite)||input.closedAtMs<input.openedAtMs||input.intervalMinutes<=0||input.quantity<=0||!['LONG','SHORT'].includes(input.direction))throw new Error('Invalid funding interval or exposure');
  const missingTimes:number[]=[];let cashflowUsdt=0;
  for(const atMs of expectedFundingTimes(input.openedAtMs,input.closedAtMs,input.intervalMinutes)){
    const rows=input.settlements.filter(s=>s.atMs===atMs),s=rows[0];
    if(rows.length!==1||!s||!Number.isFinite(s.rate)||s.mark===null||!Number.isFinite(s.mark)||s.mark<=0||
      !Number.isFinite(s.availableAtMs)||s.availableAtMs<atMs||!/^[a-f0-9]{64}$/.test(s.sourceHash)){missingTimes.push(atMs);continue;}
    cashflowUsdt+=(input.direction==='LONG'?-1:1)*input.quantity*s.mark*s.rate;
  }
  return {cashflowUsdt,missingTimes,complete:missingTimes.length===0};
}
/** Native OHLC backfills are a signal diagnostic. They never become observed forward executions. */
export function replaySwingV6(input:{datasets:BrainDataset[];startMs:number;endMs:number;registration?:BrainRegistration;calendars?:CalendarManifest[]}){
  if(![input.startMs,input.endMs].every(Number.isFinite)||input.endMs<=input.startMs)throw new Error('Invalid replay interval');
  const assets=new Set<string>(),reasons=new Set<string>(['HISTORICAL_BID_ASK_DEPTH','HISTORICAL_FUNDING_MARKS','HISTORICAL_CALENDAR_SNAPSHOTS']);
  const decisions: {asset:string;atMs:number;status:string;code:string;modeledStatus:string;modeledCode:string;setupId:string|null}[]=[];
  for(const raw of input.datasets){
    const data=verifyBrainDataset(raw);
    if(assets.has(data.asset))throw new Error('Duplicate asset dataset');assets.add(data.asset);
    if(data.startMs>input.startMs||data.endMs<input.endMs)reasons.add('INCOMPLETE_REQUESTED_INTERVAL');
    data.missing.forEach(r=>reasons.add(r));
    const definition=brainDefinition(data.asset),instrument=getConfiguredInstrument(data.asset),costs=freezeBrainCosts(data.asset);
    if(data.d1.length<definition.parameters.dailyWarmup||data.h4.length<definition.parameters.h4Warmup)reasons.add(`INSUFFICIENT_NATIVE_WARMUP_${data.asset}`);
    for(const bar of data.h4){
      const nowMs=(bar.time+14400)*1000;
      if(nowMs<input.startMs||nowMs>input.endMs)continue;
      const h4=data.h4.filter(b=>(b.time+14400)*1000<=nowMs),d1=data.d1.filter(b=>(b.time+86400)*1000<=nowMs);
      const actual=evaluateBrain({asset:data.asset,nowMs,h4,d1,quote:null,calendar:null});
      const half=costs.profile.halfSpreadBps/10000;
      const modeled=evaluateBrain({asset:data.asset,nowMs,h4,d1,calendar:null,quote:{price:bar.close,bid:bar.close*(1-half),ask:bar.close*(1+half),markPrice:bar.close,indexPrice:bar.close,
        source:'HTTP',transport:'REST',provider:'BYBIT_LINEAR_HTTP',venue:'BYBIT_LINEAR',instrument:instrument.symbol,instrumentVersion:instrument.instrumentVersion,
        updatedAt:new Date(nowMs).toISOString(),eventTimeMs:nowMs,receivedAtMs:nowMs,quoteTimes:{lastPriceMs:nowMs,bidAskMs:nowMs,markMs:nowMs}}});
      decisions.push({asset:data.asset,atMs:nowMs,status:actual.status,code:actual.status==='NO_TRADE'?actual.code:'SETUP',modeledStatus:modeled.status,
        modeledCode:modeled.status==='NO_TRADE'?modeled.code:'SETUP',setupId:modeled.status==='SETUP'?modeled.setup.id:null});
    }
  }
  const ordered=input.datasets.map(verifyBrainDataset).sort((a,b)=>a.asset.localeCompare(b.asset));
  const scenario=simulateBrainScenario(ordered,input.startMs,input.endMs,input.calendars??[]);
  return {version:'v6-replay-1',verdict:'NOT_TESTABLE',eligible:false,capitalAllocatedUsdt:0,ordersSubmitted:0,trades:[],scenario,
    standalone:ordered.map(data=>({asset:data.asset,...simulateBrainScenario([data],input.startMs,input.endMs,input.calendars??[])})),
    evaluationPlan:input.registration?{registrationHash:evidenceHash(input.registration),declaredBeforeFirstEvaluation:input.registration.folds.every(f=>f.declaredAtMs<=input.registration!.firstEvaluationAtMs),
      folds:input.registration.folds.map(f=>({...f,scenarioTrades:scenario.trades.filter(t=>t.openedAtMs>=f.evaluationStartMs&&t.closedAtMs<=f.evaluationEndMs).length})),promotionEvidence:false}:{status:'NOT_PREREGISTERED',folds:[],promotionEvidence:false},
    reasons:[...reasons].sort(),decisions:decisions.sort((a,b)=>a.atMs-b.atMs||a.asset.localeCompare(b.asset)),
    assumptions:['Modeled signal quotes use the frozen profile spread and close-time availability. They are descriptive only.',
      'No historical calendar coverage, execution depth or actual funding marks are inferred from candles.',
      'This report is not promotion evidence or a measured profitability backtest.']};
}

const HOUR=3600000,DAY=24*HOUR,ENTRY_LATENCY_MS=60000;
const CONTEXT={assetMode:'SLOW_SWING',dataQuality:100,isPeakLiquidity:true,liquidityState:'NEUTRAL'} as const;
export interface BrainScenarioTrade {
  asset:ConfiguredAsset;setupId:string;openedAtMs:number;closedAtMs:number;entryPrice:number;exitPrice:number;quantity:number;
  initialRiskUsdt:number;netPnlUsdt:number;netR:number;stressedNetPnlUsdt:number;stressedNetR:number;entryFeeUsdt:number;exitFeeUsdt:number;
  fundingCashflowUsdt:number;fundingComplete:boolean;exitReason:string;
}
interface ScenarioPosition {
  data:BrainDataset;setup:SwingSetup;plan:BrainOrderPlan;openedAtMs:number;stopLoss:number;watermark:number;lastPrice:number;
  fundingCashflow:number;stressedFunding:number;fundingComplete:boolean;fundingThroughMs:number;stressEntry:number;stressEntryFee:number;
}
function scenarioQuote(data:BrainDataset,price:number,nowMs:number):MarketPriceSnapshot{
  const i=getConfiguredInstrument(data.asset),half=freezeBrainCosts(data.asset).profile.halfSpreadBps/10000;
  return {price,bid:price*(1-half),ask:price*(1+half),markPrice:price,indexPrice:price,source:'HTTP',transport:'REST' as const,
    provider:'BYBIT_LINEAR_HTTP',venue:'BYBIT_LINEAR',instrument:i.symbol,instrumentVersion:i.instrumentVersion,
    updatedAt:new Date(nowMs).toISOString(),eventTimeMs:nowMs,receivedAtMs:nowMs,
    quoteTimes:{lastPriceMs:nowMs,bidAskMs:nowMs,markMs:nowMs}};
}
function holdBaseline(datasets:BrainDataset[],startMs:number,endMs:number){
  let cash=10000,stressCash=10000;const gaps:string[]=[];
  for(const data of datasets){
    const first=data.h1.find(b=>b.time*1000>=startMs&&b.time*1000+ENTRY_LATENCY_MS<endMs);
    const last=data.h1.filter(b=>(b.time+3600)*1000<=endMs).at(-1),metadata=data.metadata,costs=freezeBrainCosts(data.asset);
    if(!first||!last||!metadata){gaps.push(`BASELINE_DATA_UNAVAILABLE_${data.asset}`);continue;}
    const vol=volatilityScale(data,first.time*1000);if(vol===null){gaps.push(`BASELINE_VOLATILITY_UNAVAILABLE_${data.asset}`);continue;}
    const quantity=Number(floorOrderQty(decimalString(10000/datasets.length*vol/first.open),metadata));if(!(quantity>0))continue;
    const fill=(price:number,entry:boolean,stress:boolean)=>estimatePaperFill({asset:data.asset,action:entry?'BUY':'SELL',requestedPrice:price,amount:quantity,
      context:{...CONTEXT,reason:entry?'ENTRY':'TAKE_PROFIT'},profile:stress?stressProfile(data):costs.profile,feeScheduleVersion:costs.feeSchedule.version});
    const entry=fill(first.open,true,false),exit=fill(last.close,false,false),stressEntry=fill(first.open,true,true),stressExit=fill(last.close,false,true);
    cash+=quantity*(exit.fillPrice-entry.fillPrice)-entry.feeUsd-exit.feeUsd;
    stressCash+=quantity*(stressExit.fillPrice-stressEntry.fillPrice)-2*(stressEntry.feeUsd+stressExit.feeUsd);
    for(const atMs of expectedFundingTimes(first.time*1000+ENTRY_LATENCY_MS,Math.min(endMs,(last.time+3600)*1000),metadata.fundingIntervalMinutes)){
      const row=data.funding?.find(r=>r.atMs===atMs),mark=row?.mark??last.close,floor=.0001*metadata.fundingIntervalMinutes/480;
      if(!row||row.mark===null)gaps.push(`BASELINE_MODELED_FUNDING_${data.asset}:${atMs}`);
      cash-=quantity*mark*(row&&row.mark!==null?row.rate:Math.max(Math.abs(row?.rate??0),floor));
      stressCash-=2*quantity*mark*Math.max(Math.abs(row?.rate??0),floor);
    }
  }
  return {name:'EQUAL_WEIGHT_BUY_HOLD_INITIAL_VOL_SCALED',initialEquityUsdt:10000,finalEquityUsdt:cash,stressedFinalEquityUsdt:stressCash,gaps,
    assumptions:['Equal capital weights, down-only initial 30-day volatility scaling, no leverage or rebalancing, current lot rules and frozen taker costs.',
      'Missing actual funding marks retain an explicit gap and adverse modeled charge. This baseline is descriptive only.']};
}
function volatilityScale(data:BrainDataset,nowMs:number):number|null {
  return brainVolatilityScale(data.d1.filter(b=>(b.time+86400)*1000<=nowMs),nowMs);
}
function stressProfile(data:BrainDataset){const p=freezeBrainCosts(data.asset).profile;return {...p,halfSpreadBps:p.halfSpreadBps*2,
  baseSlippageBps:p.baseSlippageBps*2,sizeImpactBps:p.sizeImpactBps*2,stopGapBps:p.stopGapBps*2};}
/**
 * Descriptive scenario only. OHLC opening prices proxy a fill after a fixed
 * one-minute latency. Current captured lot rules are held fixed as a scenario
 * assumption; their actual verification timestamp is never rewritten.
 */
function simulateBrainScenario(datasets:BrainDataset[],startMs:number,endMs:number,calendars:CalendarManifest[]){
  let cash=10000,stressCash=10000,peak=10000,maxDrawdown=0,maxOpenRiskUsdt=0,maxGrossNotionalUsdt=0,maxMarginUsdt=0;
  let latches:BrainBreakerLatch[]=[];
  const open=new Map<ConfiguredAsset,ScenarioPosition>(),trades:BrainScenarioTrade[]=[],gaps=new Set<string>(),seen=new Set<string>();
  const equity:{atMs:number;equityUsdt:number;stressedEquityUsdt:number}[]=[{atMs:startMs,equityUsdt:10000,stressedEquityUsdt:10000}];
  const dailyReturns:{dayStartMs:number;netReturn:number;stressedNetReturn:number}[]=[];
  let dailyAnchor:{atMs:number;value:number;stress:number}|null=startMs%DAY===0?{atMs:startMs,value:10000,stress:10000}:null;
  const timeline=new Set<number>([startMs,endMs]),entries=new Map<number,{data:BrainDataset;bar:Candle}[]>(),exitBars=new Map<number,Map<ConfiguredAsset,Candle>>();
  for(let day=Math.floor(startMs/DAY)*DAY+DAY;day<=endMs;day+=DAY)timeline.add(day);
  for(const data of datasets){
    if(!data.metadata)gaps.add(`CURRENT_METADATA_UNAVAILABLE_${data.asset}`);
    if(!data.h1.length)gaps.add(`HOURLY_EXIT_PATH_UNAVAILABLE_${data.asset}`);
    for(const bar of data.h1){const end=(bar.time+3600)*1000;if(end<startMs||end>endMs)continue;timeline.add(end);
      const map=exitBars.get(end)??new Map<ConfiguredAsset,Candle>();map.set(data.asset,bar);exitBars.set(end,map);}
    for(const bar of data.h4){const atMs=(bar.time+14400)*1000+ENTRY_LATENCY_MS;if(atMs<startMs||atMs>=endMs)continue;
      timeline.add(atMs);entries.set(atMs,[...(entries.get(atMs)??[]),{data,bar}]);}
  }
  const value=(stress=false)=>[...open.values()].reduce((sum,p)=>sum+p.plan.marginUsdt+(p.setup.direction==='LONG'?1:-1)*p.plan.quantity*(p.lastPrice-(stress?p.stressEntry:p.plan.entryPrice)),stress?stressCash:cash);
  const settle=(p:ScenarioPosition,toMs:number)=>{
    const interval=p.data.metadata!.fundingIntervalMinutes;
    for(const atMs of expectedFundingTimes(p.fundingThroughMs,toMs,interval)){
      const row=p.data.funding?.find(f=>f.atMs===atMs),floor=.0001*interval/480;
      const known=!!row&&row.mark!==null,mark=known?row!.mark!:p.lastPrice;
      const base=known?(p.setup.direction==='LONG'?-1:1)*p.plan.quantity*mark*row!.rate:-p.plan.quantity*mark*Math.max(Math.abs(row?.rate??0),floor);
      const stress=-2*p.plan.quantity*mark*Math.max(Math.abs(row?.rate??0),floor);
      if(!known){p.fundingComplete=false;gaps.add(`MODELED_MISSING_FUNDING_${p.data.asset}:${atMs}`);}
      p.fundingCashflow+=base;p.stressedFunding+=stress;cash+=base;stressCash+=stress;
    }
    p.fundingThroughMs=toMs;
  };
  const close=(p:ScenarioPosition,price:number,atMs:number,reason:string)=>{
    settle(p,atMs);const asset=p.data.asset,sign=p.setup.direction==='LONG'?1:-1,costs=freezeBrainCosts(asset);
    const fill=(stress:boolean)=>estimatePaperFill({asset,action:sign===1?'SELL':'COVER',requestedPrice:price,amount:p.plan.quantity,
      context:{...CONTEXT,reason:reason==='STOP'||reason==='TRAILING'?'STOP_LOSS':'TAKE_PROFIT'},profile:stress?stressProfile(p.data):costs.profile,feeScheduleVersion:costs.feeSchedule.version});
    const exit=fill(false),stressed=fill(true),exitFee=exit.feeUsd,stressExitFee=2*stressed.feeUsd;
    const pnl=sign*p.plan.quantity*(exit.fillPrice-p.plan.entryPrice)-p.plan.entryFeeUsdt-exitFee+p.fundingCashflow;
    const stressPnl=sign*p.plan.quantity*(stressed.fillPrice-p.stressEntry)-p.stressEntryFee-stressExitFee+p.stressedFunding;
    cash+=p.plan.marginUsdt+sign*p.plan.quantity*(exit.fillPrice-p.plan.entryPrice)-exitFee;
    stressCash+=p.plan.marginUsdt+sign*p.plan.quantity*(stressed.fillPrice-p.stressEntry)-stressExitFee;
    trades.push({asset,setupId:p.setup.id,openedAtMs:p.openedAtMs,closedAtMs:atMs,entryPrice:p.plan.entryPrice,exitPrice:exit.fillPrice,
      quantity:p.plan.quantity,initialRiskUsdt:p.plan.initialRiskUsdt,netPnlUsdt:pnl,netR:pnl/p.plan.initialRiskUsdt,
      stressedNetPnlUsdt:stressPnl,stressedNetR:stressPnl/p.plan.initialRiskUsdt,entryFeeUsdt:p.plan.entryFeeUsdt,exitFeeUsdt:exitFee,
      fundingCashflowUsdt:p.fundingCashflow,fundingComplete:p.fundingComplete,exitReason:reason});open.delete(asset);
  };
  for(const nowMs of [...timeline].sort((a,b)=>a-b)){
    const bars=exitBars.get(nowMs);
    for(const p of [...open.values()]){
      const bar=bars?.get(p.data.asset);if(!bar)continue;
      if((bar.time+3600)*1000<=p.openedAtMs)continue;
      settle(p,nowMs);
      const exit=replayExitBar({policy:{...p.setup.policy,priceRDistance:Math.abs(p.plan.entryPrice-p.plan.stopLoss)},direction:p.setup.direction,
        entryPrice:p.plan.entryPrice,stopLoss:p.stopLoss,openedAtMs:p.openedAtMs,nowMs,watermark:p.watermark},bar);
      p.stopLoss=exit.stopLoss;p.watermark=exit.watermark;p.lastPrice=bar.close;
      if(exit.action==='EXIT')close(p,exit.exitPrice!,nowMs,exit.reason??'INVALID_INPUT');
    }
    let marked=value();peak=Math.max(peak,marked);
    const outcomes:BrainRiskOutcome[]=trades.map(t=>({positionId:t.setupId,asset:t.asset,closedAtMs:t.closedAtMs,netPnlUsdt:t.netPnlUsdt,netR:t.netR,exitReason:t.exitReason}));
    const breakers=evaluateBrainBreakers({equity:marked,initialCapital:10000,peakEquity:peak,nowMs,outcomes,previous:latches});latches=breakers.latches;
    if(latches.some(l=>l.kind==='DRAWDOWN'))for(const p of [...open.values()])close(p,p.lastPrice,nowMs,'DRAWDOWN');
    const candidates=(entries.get(nowMs)??[]).sort((a,b)=>a.data.asset.localeCompare(b.data.asset)).flatMap(({data})=>{
      const def=brainDefinition(data.asset);
      if(open.has(data.asset)||!data.metadata||breakers.rollingBlock||latches.some(l=>l.scope==='account'||l.scope===data.asset||l.scope===def.riskBucket))return [];
      const next=data.h1.find(b=>b.time*1000===nowMs-ENTRY_LATENCY_MS);
      if(!next){gaps.add(`NEXT_ENTRY_OPEN_UNAVAILABLE_${data.asset}:${nowMs}`);return [];}
      const h4=data.h4.filter(b=>(b.time+14400)*1000<=nowMs),d1=data.d1.filter(b=>(b.time+86400)*1000<=nowMs);
      const calendar=[...calendars].filter(c=>c.retrievedAtMs<=nowMs).sort((a,b)=>b.retrievedAtMs-a.retrievedAtMs)[0]??null;
      const decision=evaluateBrain({asset:data.asset,nowMs,h4,d1,calendar,quote:scenarioQuote(data,next.open,nowMs)});
      if(decision.status!=='SETUP'||seen.has(decision.setup.id))return [];
      const vol=volatilityScale(data,nowMs);if(vol===null){gaps.add(`VOLATILITY_HISTORY_UNAVAILABLE_${data.asset}`);return [];}
      const setup=decision.setup,metadata=data.metadata;
      const currentFunding=[...(data.funding??[])].filter(f=>f.atMs<=nowMs).at(-1)?.rate??.0001*metadata.fundingIntervalMinutes/480;
      // This adapter asks the unchanged sizing solver for a scenario using the
      // actually captured current lot rules. No historical metadata receipt is invented.
      const order={setup:{...setup,featureCutoffMs:metadata.verifiedAtMs,expiresAtMs:metadata.verifiedAtMs+300000},metadata,nowMs:metadata.verifiedAtMs,
        riskBudgetUsdt:marked*.0025*vol,equity:marked,availableCash:cash,capacityNotionalUsdt:marked*2.5,
        halfSpreadBps:freezeBrainCosts(data.asset).profile.halfSpreadBps,fundingRate:currentFunding};
      const plan=sizeBrainOrder(order);return plan.approved?[{data,setup,order,plan}]:[];
    });
    const allocations=allocateBrainRisk({equity:marked,initialCapital:10000,peakEquity:peak,freeCash:cash,
      open:[...open.values()].map(p=>({asset:p.data.asset,riskUsdt:p.plan.initialRiskUsdt,notionalUsdt:p.plan.notionalUsdt,marginUsdt:p.plan.marginUsdt})),
      candidates:candidates.map(c=>({id:c.setup.id,asset:c.data.asset,riskUsdt:c.plan.initialRiskUsdt,notionalUsdt:c.plan.notionalUsdt,marginUsdt:c.plan.marginUsdt}))});
    for(const allocation of allocations){
      const c=candidates.find(row=>row.setup.id===allocation.id)!;if(!(allocation.scale>0))continue;
      const plan=sizeBrainOrder({...c.order,riskBudgetUsdt:allocation.riskUsdt,capacityNotionalUsdt:allocation.notionalUsdt,availableCash:Math.min(cash,allocation.marginUsdt+c.plan.entryFeeUsdt)});
      if(!plan.approved)continue;
      const costs=freezeBrainCosts(c.data.asset),stress=estimatePaperFill({asset:c.data.asset,action:c.setup.direction==='LONG'?'BUY':'SHORT',requestedPrice:c.setup.entryPrice,
        amount:plan.quantity,context:{...CONTEXT,reason:'ENTRY'},profile:stressProfile(c.data),feeScheduleVersion:costs.feeSchedule.version});
      cash-=plan.marginUsdt+plan.entryFeeUsdt;stressCash-=plan.marginUsdt+2*stress.feeUsd;
      open.set(c.data.asset,{data:c.data,setup:c.setup,plan,openedAtMs:nowMs,stopLoss:plan.stopLoss,watermark:plan.entryPrice,lastPrice:c.setup.referencePrice,
        fundingCashflow:0,stressedFunding:0,fundingComplete:true,fundingThroughMs:nowMs,stressEntry:stress.fillPrice,stressEntryFee:2*stress.feeUsd});seen.add(c.setup.id);
    }
    if(nowMs===endMs)for(const p of [...open.values()])close(p,p.lastPrice,nowMs,'END_OF_WINDOW');
    const exposures=[...open.values()];maxOpenRiskUsdt=Math.max(maxOpenRiskUsdt,exposures.reduce((s,p)=>s+p.plan.initialRiskUsdt,0));
    maxGrossNotionalUsdt=Math.max(maxGrossNotionalUsdt,exposures.reduce((s,p)=>s+p.plan.notionalUsdt,0));maxMarginUsdt=Math.max(maxMarginUsdt,exposures.reduce((s,p)=>s+p.plan.marginUsdt,0));
    marked=value();peak=Math.max(peak,marked);maxDrawdown=Math.max(maxDrawdown,(peak-marked)/peak);
    const stressMarked=value(true);equity.push({atMs:nowMs,equityUsdt:marked,stressedEquityUsdt:stressMarked});
    if(nowMs%DAY===0){if(dailyAnchor&&nowMs===dailyAnchor.atMs+DAY)dailyReturns.push({dayStartMs:dailyAnchor.atMs,netReturn:marked/dailyAnchor.value-1,stressedNetReturn:stressMarked/dailyAnchor.stress-1});dailyAnchor={atMs:nowMs,value:marked,stress:stressMarked};}
  }
  const definition={definitions:datasets.map(d=>brainDefinition(d.asset)),costs:datasets.map(d=>freezeBrainCosts(d.asset)),
    datasetHashes:datasets.map(d=>d.sourceHash),riskFraction:.0025,volatilityOverlay:{lookbackDays:30,targetAnnualVol:.2,annualDays:365,downOnly:true},entryLatencyMs:ENTRY_LATENCY_MS};
  return {label:'DESCRIPTIVE_OHLC_SCENARIO',promotionEvidence:false,metadataPolicy:'CURRENT_METADATA_FROZEN_FOR_SCENARIO',definitionHash:evidenceHash(definition),definition,
    trades,equity,dailyReturns,finalEquityUsdt:value(),stressedFinalEquityUsdt:value(true),netPnlUsdt:value()-10000,maxDrawdown,maxOpenRiskUsdt,maxGrossNotionalUsdt,maxMarginUsdt,
    gaps:[...gaps].sort(),latches,baselines:[{name:'CASH',initialEquityUsdt:10000,finalEquityUsdt:10000},holdBaseline(datasets,startMs,endMs)],
    assumptions:['Current captured tick/lot/leverage rules are frozen for this scenario, not observed historical metadata.',
      'Entry uses next hourly opening price with a fixed one-minute latency; spread, slippage, depth and gap behavior are modeled.',
      'The complete first hourly bar is used conservatively after entry; no tick ordering or five-second protection parity is claimed.',
      'Missing funding is charged an adverse modeled payer amount and remains a coverage gap.',
      'Stress doubles all frozen execution/fee costs and charges every settlement as an adverse payer at twice the actual-rate/floor maximum.',
      'Stress holds base quantities and trigger timestamps fixed. It is a sensitivity scenario, not a separately optimized path.']};
}
