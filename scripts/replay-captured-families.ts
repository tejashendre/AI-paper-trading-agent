import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readResearchEvidence, ResearchEvidence } from '../src/lib/research/researchArchive';
import { replayStrategyCandidate } from '../src/lib/research/familyReplay';
import { evaluateStrategyFamilies } from '../src/lib/swingEngine';
import { getConfiguredInstrument, CONFIGURED_ASSETS } from '../src/lib/trading/instrumentRegistry';
import { Candle } from '../src/lib/types';
import { MarketPriceSnapshot } from '../src/lib/market';
import { ResearchOutcome } from '../src/lib/research/candidateRegistry';
import { getExecutionCostProfile } from '../src/lib/trading/executionCostModel';
import { TRADING_STRATEGY_VERSION } from '../src/lib/trading/executionLedger';

/** Offline only. An explicit captured archive is required. No account or Redis
 * access, historical proxy sources, invented 1m bars or automatic promotion. */
export function replayCapturedFamilies(records:ResearchEvidence[], maxCandidates=200) {
  const reports=[];
  for (const asset of CONFIGURED_ASSETS) {
    const evidence=records.filter(r=>r.asset===asset), instrument=getConfiguredInstrument(asset);
    const series=(interval:string)=>Array.from(new Map(evidence.flatMap(r=>(r.candles[interval]??[]) as Candle[])
      .map(bar=>[bar.time,bar])).values()).sort((a,b)=>a.time-b.time);
    const m15=series('15m'),h1=series('1h'),h4=series('4h'),w1=series('1w');
    const outcomes:ResearchOutcome[]=[];const blocked:Record<string,number>={}; let attempted=0;
    for (const bar of m15) {
      const at=(bar.time+900)*1000;
      if (at+86400000>(m15.at(-1)?.time??0)*1000+900000 || attempted>=maxCandidates) continue;
      const quote={price:bar.close,provider:'REPLAY',venue:'REPLAY',source:'HTTP',transport:'REST',
        instrument:instrument.symbol,instrumentVersion:instrument.instrumentVersion,updatedAt:new Date(at).toISOString(),
        eventTimeMs:at,receivedAtMs:at,bid:bar.close*(1-0.0001),ask:bar.close*(1+0.0001),
        quoteTimes:{lastPriceMs:at,bidAskMs:at,markMs:null}} as MarketPriceSnapshot;
      const decision=evaluateStrategyFamilies({instrument,candles15m:m15.filter(c=>(c.time+900)*1000<=at),
        candles1h:h1.filter(c=>(c.time+3600)*1000<=at),candles4h:h4.filter(c=>(c.time+14400)*1000<=at),
        weeklyCandles:w1.filter(c=>(c.time+604800)*1000<=at),quote,nowMs:at,dataMode:'REPLAY'});
      for (const candidate of decision) {
        attempted++;
        const metadata=evidence[0]?.metadata as any;
        const interval=metadata?.metadata?.fundingIntervalMinutes;
        const result=replayStrategyCandidate({candidate,bars:m15,barIntervalMs:900000,
          featureStartMs:at-100*4*3600000,labelEndMs:at+86400000,
          funding:[],fundingIntervalMinutes:interval??480,historicalCostsAvailable:false,
          halfSpreadBps:Math.max(1,getExecutionCostProfile(asset).halfSpreadBps),researchOrigin:'REPLAY'});
        if(result.status==='COMPLETED') outcomes.push(result.outcome);
        else blocked[result.status]=(blocked[result.status]??0)+1;
      }
    }
    reports.push({asset,symbol:instrument.symbol,range:m15.length?{from:new Date(m15[0].time*1000).toISOString(),
      to:new Date((m15.at(-1)!.time+900)*1000).toISOString()}:null,
      counts:{m15:m15.length,h1:h1.length,h4:h4.length,w1:w1.length},attempted,completed:outcomes.length,blocked,outcomes,
      promotionEligible:false,limitations:['15m bar resolution','Modeled spread, impact and one-bar latency',
        'Historical funding mark prices and order-book evidence unavailable in this capture',
        'No dynamic scale-ins or baseline signal reversals; descriptive family replay only']});
  }
  const report={schemaVersion:1,strategyVersion:TRADING_STRATEGY_VERSION,
    dataHash:createHash('sha256').update(JSON.stringify(records)).digest('hex'),
    candidateLimitPerAsset:maxCandidates,reports};
  return {...report,reportHash:createHash('sha256').update(JSON.stringify(report)).digest('hex')};
}
async function main() {
  const option=(name:string)=>{const at=process.argv.indexOf(name);return at>=0?process.argv[at+1]:undefined;};
  const input=option('--input'),output=option('--output');
  if(!input||!output) throw new Error('Explicit --input archive directory and --output report file are required');
  const report=replayCapturedFamilies(readResearchEvidence(path.resolve(input)));
  fs.writeFileSync(path.resolve(output),JSON.stringify(report,null,2));
  console.log(JSON.stringify({reportHash:report.reportHash,dataHash:report.dataHash,
    reports:report.reports.map(({outcomes,...summary})=>summary)},null,2));
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1;});
