import { randomUUID } from 'node:crypto';
import { getRedis } from '../lib/redis';
import { PortfolioManager } from '../lib/portfolio';
import { Logger } from '../lib/logger';
import { liveFundingDeps } from '../lib/data/bybitPublic';
import { WebsocketDataMesh } from './websocketDataMesh';
import { consumeSwingScanRequest } from '../lib/trading/scanControl';
import { persistBrainPortfolioMutation, settleAndPersistFunding, settleOpenPositionFunding, sweepSwingExits } from '../lib/execution/swingLifecycle';
import { BRAIN_SCAN_INTERVAL_MS, BRAIN_WATCHDOG_INTERVAL_MS, refreshBrainProtectiveBreakers, runReplacementScan, runReplacementShadowSweep } from '../lib/strategy/v6/runtime';
import type { BrainBreakerLatch } from '../lib/strategy/v6/risk';
import { expectedFundingTimes,quantityHeldAt,type FundingDeps } from '../lib/trading/executionCostModel';
import type { Portfolio } from '../lib/types';

let scanning=false,protecting=false,observing=false,reconciling=false;
/** Protective legacy positions remain managed before the archive-first reset. No entry evaluator is imported. */
export async function runReplacementWatchdog(){
  if(protecting)return;protecting=true;
  const redis=getRedis(),token=randomUUID(),lock='portfolio:write-lock:ai';let acquired=false;
  try{
    acquired=await redis.set(lock,token,{nx:true,ex:60})==='OK';if(!acquired)return;
    const active=await redis.get<{runId:string}>('brain:v6:activeRun');
    if(!active){
      const legacy=await redis.get<unknown>('ai:portfolio');if(!legacy)return;
      const portfolio=await PortfolioManager.getPortfolio('ai');
      await settleAndPersistFunding(portfolio,'ai','V6_LEGACY_PROTECTION');
      await sweepSwingExits(portfolio,{portfolioType:'ai',source:'V6_LEGACY_PROTECTION'});return;
    }
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(active.runId))throw new Error('Invalid active protective epoch');
    const prefix=`brain:v6:run:${active.runId}:`;
    if(await redis.get(prefix+'ledgerAcknowledged')!==true)return;
    const expected=await redis.readRaw(['brain:v6:activeRun',prefix+'portfolio']);
    const portfolio=await PortfolioManager.getPortfolio('ai'),context={runId:active.runId,leaseToken:token,expected};
    // Mark due liabilities without waiting for funding-history transport.
    for(const pos of Object.values(portfolio.openPositions??{}))if(pos?.brainPolicy&&pos.brainFundingIntervalMinutes&&pos.quantityLegs){
      pos.fundingPendingTimes=expectedFundingTimes(Date.parse(pos.entryTime),Date.now(),pos.brainFundingIntervalMinutes)
        .filter(at=>!(pos.fundingSettledTimes??[]).includes(at)&&quantityHeldAt(pos.quantityLegs!,at)>0);
    }
    await persistBrainPortfolioMutation(portfolio,context);
    const latches=await redis.get<BrainBreakerLatch[]>(prefix+'breakers')??[];
    const forceReduceOnly=latches.some(l=>l.scope==='account'&&(l.kind==='DRAWDOWN'||l.kind==='INTEGRITY'));
    await sweepSwingExits(portfolio,{portfolioType:'ai',source:'REPLACEMENT_SWING_WATCHDOG',brainTransaction:context,forceReduceOnly});
    const freshLatches=await refreshBrainProtectiveBreakers(active.runId,portfolio,token);
    if(!forceReduceOnly&&freshLatches.some(l=>l.scope==='account'&&(l.kind==='DRAWDOWN'||l.kind==='INTEGRITY'))){
      await sweepSwingExits(portfolio,{portfolioType:'ai',source:'REPLACEMENT_SWING_HALT',brainTransaction:context,forceReduceOnly:true});
    }
  }catch(error){await Logger.error(`[V6 protection] ${error instanceof Error?error.message:String(error)}`);}
  finally{if(acquired)await redis.compareAndDelete(lock,token);protecting=false;}
}

/** Public funding transport happens outside the financial lease and cannot hold up protective exits. */
export async function runReplacementFunding(){
  if(reconciling)return;reconciling=true;
  const redis=getRedis(),token=randomUUID(),lock='portfolio:write-lock:ai';let acquired=false;
  try{
    const active=await redis.get<{runId:string}>('brain:v6:activeRun');
    if(!active||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(active.runId))return;
    const prefix=`brain:v6:run:${active.runId}:`,initial=await redis.get<Portfolio>(prefix+'portfolio');if(!initial)return;
    const windows=new Map<string,{from:number;interval:number}>(),until=Date.now();
    for(const pos of Object.values(initial.openPositions??{}))if(pos?.brainPolicy&&pos.instrument&&pos.quantityLegs?.length&&pos.brainFundingIntervalMinutes){
      const due=expectedFundingTimes(Date.parse(pos.entryTime),until,pos.brainFundingIntervalMinutes).filter(at=>!(pos.fundingSettledTimes??[]).includes(at)&&quantityHeldAt(pos.quantityLegs!,at)>0);
      if(due.length)windows.set(pos.instrument.symbol,{from:Math.min(...due),interval:pos.brainFundingIntervalMinutes});
    }
    for(const tail of initial.fundingTail??[])if(tail.brainFundingIntervalMinutes){
      const due=tail.pendingTimes.filter(at=>!tail.settledTimes.includes(at));if(!due.length)continue;
      const prior=windows.get(tail.symbol),from=Math.min(...due);
      windows.set(tail.symbol,{from:Math.min(prior?.from??Infinity,from),interval:tail.brainFundingIntervalMinutes});
    }
    if(!windows.size)return;
    const cache=new Map<string,Awaited<ReturnType<FundingDeps['settlements']>>|null>();
    await Promise.all([...windows].map(async([symbol,w])=>{cache.set(symbol,await liveFundingDeps.settlements(symbol,w.from-1,until).catch(()=>null));}));
    acquired=await redis.set(lock,token,{nx:true,ex:60})==='OK';if(!acquired)return;
    if(await redis.get(prefix+'ledgerAcknowledged')!==true)return;
    const expected=await redis.readRaw(['brain:v6:activeRun',prefix+'portfolio']),portfolio=await redis.get<Portfolio>(prefix+'portfolio');if(!portfolio)return;
    const cached:FundingDeps={nowMs:Date.now,intervalMinutes:async symbol=>{const w=windows.get(symbol);if(!w)throw new Error('Funding interval not captured');return w.interval;},
      settlements:async(symbol,from,to)=>{const rows=cache.get(symbol);if(!rows)throw new Error('Funding source unavailable');return rows.filter(r=>r.settlementTimeMs>from&&r.settlementTimeMs<=to);}};
    await settleOpenPositionFunding(portfolio,cached,{recordLedger:true});
    await persistBrainPortfolioMutation(portfolio,{runId:active.runId,leaseToken:token,expected},{kind:'FUNDING'});
  }catch(error){await Logger.warn(`[V6 funding] ${error instanceof Error?error.message:String(error)}`);}
  finally{if(acquired)await redis.compareAndDelete(lock,token);reconciling=false;}
}
async function scan(){
  if(scanning)return;scanning=true;
  try{await runReplacementScan();}catch(error){await Logger.error(`[V6 scan] ${error instanceof Error?error.message:String(error)}`);}
  finally{scanning=false;}
}
async function observe(){
  if(observing)return;observing=true;
  try{await runReplacementShadowSweep();}catch(error){await Logger.warn(`[V6 shadow] ${error instanceof Error?error.message:String(error)}`);}
  finally{observing=false;}
}
export function startReplacementSwingDaemon(){
  const mesh=new WebsocketDataMesh();mesh.start();
  console.log('Starting replacement v6 swing daemon: 60-second scans and 5-second protection.');
  void runReplacementWatchdog();void scan();void runReplacementFunding();
  const timers=[setInterval(()=>void scan(),BRAIN_SCAN_INTERVAL_MS),setInterval(()=>void runReplacementWatchdog(),BRAIN_WATCHDOG_INTERVAL_MS),
    setInterval(()=>void observe(),BRAIN_WATCHDOG_INTERVAL_MS),setInterval(()=>void runReplacementFunding(),60000),setInterval(()=>{
      if(scanning)return;void consumeSwingScanRequest().then(request=>request?scan():undefined).catch(error=>Logger.warn(`[V6 scan control] ${String(error)}`));
    },BRAIN_WATCHDOG_INTERVAL_MS)];
  const shutdown=()=>{for(const timer of timers)clearInterval(timer);mesh.stop();};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);return shutdown;
}
if(require.main===module)startReplacementSwingDaemon();
