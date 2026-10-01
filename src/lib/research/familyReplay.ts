import { createHash } from 'node:crypto';
import type { Candle, OpenPosition, Portfolio } from '@/lib/types';
import type { StrategyCandidate } from '@/lib/swingEngine';
import { STRATEGY_DATA_SCHEMA_VERSION } from '@/lib/swingEngine';
import { calculateInstrumentPnl, RISK_POLICY_VERSION } from '@/lib/trading/assetSpecs';
import { TradeAdmissionController } from '@/lib/trading/tradeAdmission';
import { buildPaperExecutionPlan, estimatePaperFill, EXECUTION_COST_MODEL_VERSION,
  getExecutionCostProfile, expectedFundingTimes, fundingCashflow, FundingSettlement } from '@/lib/trading/executionCostModel';
import { decideSwingExit, PARTIAL_PROFIT_POLICY } from '@/lib/execution/exitPolicy';
import { TRADING_STRATEGY_VERSION } from '@/lib/trading/executionLedger';
import type { ResearchOutcome } from './candidateRegistry';

export interface CandidateReplayInput {
  candidate: StrategyCandidate;
  bars: Candle[];
  barIntervalMs: number;
  featureStartMs: number;
  labelEndMs: number;
  funding: FundingSettlement[];
  fundingIntervalMinutes: number;
  historicalCostsAvailable: boolean;
  halfSpreadBps?: number;
  researchOrigin?: 'REPLAY' | 'SHADOW';
}
/** Hypothetical research only. Admission, fees, R exits and partial thresholds
 * share production policy. Bar fills are assumptions, never measured slippage. */
export function replayStrategyCandidate(input: CandidateReplayInput) {
  const c = input.candidate, openedAtMs = c.featureCutoffMs;
  const bars = input.bars.filter(b => b.time * 1000 >= openedAtMs &&
    (b.time * 1000 + input.barIntervalMs) <= input.labelEndMs).sort((a,b) => a.time-b.time);
  if (!(input.barIntervalMs > 0) || input.labelEndMs <= openedAtMs || !bars.length ||
    bars[0].time * 1000 > openedAtMs + input.barIntervalMs ||
    bars[bars.length-1].time * 1000 + input.barIntervalMs < input.labelEndMs-input.barIntervalMs ||
    bars.some((b,i) => [b.open,b.high,b.low,b.close].some(p => !Number.isFinite(p) || p <= 0) ||
      (i > 0 && (b.time-bars[i-1].time)*1000 !== input.barIntervalMs)))
    return { status: 'INSUFFICIENT_PATH' as const, assumptions: ['MISSING_CLOSED_BARS'] };
  const portfolio = { usd:10000, initialCapital:10000, peakValue:10000, openPositions:{}, scalpPositions:{} } as Portfolio;
  const admission = TradeAdmissionController.evaluate({portfolio, asset:c.asset, direction:c.direction,
    entryPrice:c.entryPrice, stopLoss:c.stopPrice, takeProfit:c.targetPrice, signalScore:25, finalConviction:80,
    reasoning:'Preregistered hypothetical candidate', strategyType:'swing', setupTags:[c.family], dataQuality:100,
    assetMode:['BTC','ETH','SOL'].includes(c.asset) ? 'REALTIME_FAST' : 'SLOW_SWING'});
  if (!admission.approved) return {status:'ADMISSION_BLOCKED' as const, assumptions:[admission.reason]};
  const base = getExecutionCostProfile(c.asset);
  const profile = {...base, halfSpreadBps:Math.max(base.halfSpreadBps, input.halfSpreadBps ?? 0)};
  const plan = buildPaperExecutionPlan({asset:c.asset, direction:c.direction, entryPrice:c.entryPrice,
    stopLoss:c.stopPrice, takeProfit:c.targetPrice, amount:admission.amount, profile});
  if (plan.netRewardRiskRatio < 1.35 || plan.netLossUsd > admission.riskAmountUsd * 1.01)
    return {status:'COST_OR_RISK_BLOCKED' as const, assumptions:['NET_REWARD_OR_RISK_LIMIT']};
  const positionId = createHash('sha256').update([c.candidateId, openedAtMs, input.labelEndMs].join(':')).digest('hex');
  function scenario(multiplier: number, delayed: boolean) {
    const costs = {...profile, halfSpreadBps:profile.halfSpreadBps*multiplier,
      baseSlippageBps:profile.baseSlippageBps*multiplier, sizeImpactBps:profile.sizeImpactBps*multiplier};
    // A full-bar entry delay is a disclosed adverse timing scenario, not a
    // claim about measured millisecond execution latency.
    const fillBars = delayed ? bars.slice(1) : bars;
    const requestedEntry = delayed ? fillBars[0]?.open : c.entryPrice;
    if (!requestedEntry || !fillBars.length) return null;
    const entryTimeMs = delayed ? fillBars[0].time*1000 : openedAtMs;
    const entry = estimatePaperFill({asset:c.asset, instrument:c.instrument, amount:admission.amount,
      action:c.direction === 'LONG' ? 'BUY':'SHORT', requestedPrice:requestedEntry, profile:costs, context:{reason:'ENTRY'}});
    const pos = {asset:c.asset, instrument:c.instrument, direction:c.direction, entryPrice:entry.fillPrice,
      entryTime:new Date(entryTimeMs).toISOString(), amount:admission.amount, usdInvested:admission.requiredMarginUsd,
      stopLoss:c.stopPrice, initialStopLoss:c.stopPrice, takeProfit:c.targetPrice,
      maxLossUsd:plan.netLossUsd, riskAmountUsd:admission.riskAmountUsd,
      highestPriceReached:entry.fillPrice, lowestPriceReached:entry.fillPrice} as OpenPosition;
    let remaining=admission.amount, gross=0, fees=entry.feeUsd, funding=0, peak=0, partial=false;
    let closedAtMs=fillBars[fillBars.length-1].time*1000+input.barIntervalMs;
    const legs:{at:number; quantity:number}[]=[];
    const exit = (price:number, qty:number, at:number, reason:'STOP_LOSS'|'TAKE_PROFIT'|'PARTIAL_EXIT'|'END_REPLAY') => {
      const fill=estimatePaperFill({asset:c.asset,instrument:c.instrument,amount:qty, requestedPrice:price,
        action:c.direction==='LONG'?'SELL':'COVER',profile:costs,context:{reason}});
      gross += calculateInstrumentPnl({instrument:c.instrument,entryPrice:entry.fillPrice,exitPrice:fill.fillPrice,quantity:qty,direction:c.direction});
      fees += fill.feeUsd; remaining-=qty; legs.push({at,quantity:qty});
    };
    for (const bar of fillBars) {
      const barEnd=bar.time*1000+input.barIntervalMs;
      const stopped=c.direction==='LONG'?bar.low<=pos.stopLoss:bar.high>=pos.stopLoss;
      const target=c.direction==='LONG'?bar.high>=pos.takeProfit:bar.low<=pos.takeProfit;
      if (stopped || target) {
        // Stops win an ambiguous bar. Gap-through stops fill at the worse open.
        const price=stopped ? (c.direction==='LONG'?Math.min(bar.open,pos.stopLoss):Math.max(bar.open,pos.stopLoss)) : pos.takeProfit;
        exit(price,remaining,barEnd,stopped?'STOP_LOSS':'TAKE_PROFIT'); closedAtMs=barEnd; break;
      }
      const openNet=calculateInstrumentPnl({instrument:c.instrument,entryPrice:entry.fillPrice,exitPrice:bar.close,quantity:remaining,direction:c.direction}) - fees;
      peak=Math.max(peak,openNet); pos.highestPriceReached=Math.max(pos.highestPriceReached!,bar.close);
      pos.lowestPriceReached=Math.min(pos.lowestPriceReached!,bar.close); pos.amount=remaining;
      const decision=decideSwingExit({position:pos,currentPrice:bar.close,netPnlUsd:openNet,peakNetPnlUsd:peak,oppositeEdgeConfirmed:false});
      if (decision.kind==='CLOSE') {exit(bar.close,remaining,barEnd,'END_REPLAY');closedAtMs=barEnd;break;}
      if (decision.kind==='MOVE_STOP') pos.stopLoss=decision.newStopLoss;
      const distance=Math.abs(entry.fillPrice-c.stopPrice);
      const profitR=(c.direction==='LONG'?bar.close-entry.fillPrice:entry.fillPrice-bar.close)/distance;
      if (!partial && profitR>=PARTIAL_PROFIT_POLICY.activationR) {
        exit(bar.close,remaining*PARTIAL_PROFIT_POLICY.fraction,barEnd,'PARTIAL_EXIT'); partial=true;
      }
    }
    if (remaining>1e-12) exit(fillBars[fillBars.length-1].close,remaining,closedAtMs,'END_REPLAY');
    const required=expectedFundingTimes(entryTimeMs,closedAtMs,input.fundingIntervalMinutes);
    const seen=new Set<number>();
    for (const settlement of input.funding) {
      if (settlement.symbol!==c.instrument.symbol || settlement.settlementTimeMs<=entryTimeMs ||
        settlement.settlementTimeMs>closedAtMs || seen.has(settlement.settlementTimeMs) ||
        !Number.isFinite(settlement.rate) || !(settlement.markPrice>0)) continue;
      seen.add(settlement.settlementTimeMs);
      const held=admission.amount-legs.filter(leg=>leg.at<settlement.settlementTimeMs).reduce((s,l)=>s+l.quantity,0);
      funding+=fundingCashflow({direction:c.direction,quantity:held,settlement});
    }
    return {gross,fees,funding,net:gross-fees+funding,closedAtMs,completeFunding:required.every(at=>seen.has(at)),partial};
  }
  const baseResult=scenario(1,false)!, stress=scenario(2,false)!, latency=scenario(2,true);
  const assumptions=['MODELED_SPREAD_AND_IMPACT','BAR_RESOLUTION_LIMITATION','STOP_FIRST_AMBIGUOUS_BAR',
    'ONE_BAR_LATENCY_STRESS','SHADOW_ADMISSION_SCORE_ASSUMPTION','NO_SCALE_INS_OR_SIGNAL_REVERSALS'];
  if (!baseResult.completeFunding || !stress.completeFunding || !latency?.completeFunding) assumptions.push('MISSING_FUNDING_SETTLEMENTS');
  if (!input.historicalCostsAvailable) assumptions.push('MISSING_HISTORICAL_DEPTH_OR_FEE_EVIDENCE');
  const outcome:ResearchOutcome={positionId,asset:c.instrument.asset,instrument:c.instrument,direction:c.direction,
    openedAtMs,closedAtMs:baseResult.closedAtMs,featureStartMs:input.featureStartMs,labelEndMs:input.labelEndMs,
    strategyVersion:TRADING_STRATEGY_VERSION,setupFamily:c.family,configHash:c.configHash,regime:c.regime,
    entryMode:'SHADOW',dataSchemaVersion:STRATEGY_DATA_SCHEMA_VERSION,costModelVersion:EXECUTION_COST_MODEL_VERSION,
    riskPolicyVersion:RISK_POLICY_VERSION,setupTags:[c.family],grossPnlUsdt:baseResult.gross,feesUsdt:baseResult.fees,
    fundingCashflowUsdt:baseResult.funding,netPnlUsdt:baseResult.net,initialRiskUsdt:plan.netLossUsd,
    netR:baseResult.net/plan.netLossUsd,returnOnInitialMargin:baseResult.net/admission.requiredMarginUsd,
    legIds:[positionId+':entry',positionId+':final'],researchOrigin:input.researchOrigin??'REPLAY',
    historicalCostsAvailable:input.historicalCostsAvailable && baseResult.completeFunding &&
      stress.completeFunding && Boolean(latency?.completeFunding),
    stressedNetPnlUsdt:Math.min(stress.net,latency?.net??-Infinity),
    riskLimitBreached:baseResult.net < -admission.riskAmountUsd*1.01};
  return {status:'COMPLETED' as const,outcome,assumptions,partialTaken:baseResult.partial,
    scenarios:{base:baseResult.net,doubleCosts:stress.net,latency:latency?.net??null}};
}
