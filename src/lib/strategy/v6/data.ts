import type { Candle } from '@/lib/types';
import { bybitPublicGet } from '@/lib/data/bybitPublic';
import { getConfiguredInstrument, isConfiguredAsset, validateBybitMetadata, type ConfiguredAsset, type BybitInstrumentMetadata } from '@/lib/trading/instrumentRegistry';
import { evidenceHash, freezeBrainCosts, type BrainFrozenCosts } from './evidence';

export type PublicMarketRequest = <T>(path: string) => Promise<{ result: T; serverTimeMs: number }>;
export interface BrainDataset {
  version: 'v6-dataset-1'; asset: ConfiguredAsset; symbol: string;
  startMs: number; endMs: number; capturedAtMs: number;
  requestedStartMs?: number;
  h4: Candle[]; d1: Candle[]; h1: Candle[];
  receipts: { path: string; serverTimeMs: number; availableAtMs: number; payloadHash: string }[];
  observations: never[]; missing: string[]; sourceHash: string;
  /** Captured current rules, never asserted to be historical metadata. */
  metadata?: BybitInstrumentMetadata;
  costs?: BrainFrozenCosts;
  markH1?: Candle[];
  funding?: { atMs: number; rate: number; mark: number | null; availableAtMs: number; sourceHash: string }[];
}
const HOUR = 3_600_000, DAY = 24 * HOUR;
function parseBars(rows: unknown, intervalMs: number, endMs: number, startMs = 0): Candle[] {
  if (!Array.isArray(rows)) throw new Error('Native candle list is missing');
  const bars = new Map<number, Candle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) throw new Error('Invalid native candle row');
    const [at, open, high, low, close, volume] = row.slice(0, 6).map(Number);
    if (![at,open,high,low,close,volume].every(Number.isFinite) || at < 0 || at % intervalMs !== 0 ||
        Math.min(open,high,low,close) <= 0 || volume < 0 || high < Math.max(open,close,low) || low > Math.min(open,close)) throw new Error('Invalid native bar geometry');
    if (at < startMs || at + intervalMs > endMs) continue;
    const bar = {time:at/1000,open,high,low,close,volume};
    const prior = bars.get(at);
    if (prior && evidenceHash(prior) !== evidenceHash(bar)) throw new Error('Conflicting duplicate native bar');
    bars.set(at,bar);
  }
  return [...bars.values()].sort((a,b)=>a.time-b.time);
}
function limits(value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid capture limit');
  return value;
}
export async function loadBrainBars(asset: ConfiguredAsset, nowMs: number, options: {
  request?: PublicMarketRequest; clock?:()=>number; h4Limit?:number; d1Limit?:number;
} = {}) {
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('Invalid decision clock');
  const symbol = getConfiguredInstrument(asset).symbol, request = options.request ?? bybitPublicGet, clock = options.clock ?? Date.now;
  const load = async (interval:string, ms:number, limit:number) => {
    const path = `/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limits(limit,1000)}&end=${nowMs}`;
    const response = await request<{list:unknown}>(path), availableAtMs = clock();
    if (!Number.isFinite(availableAtMs) || availableAtMs < nowMs || !Number.isFinite(response.serverTimeMs) || response.serverTimeMs > availableAtMs + 5000) throw new Error('Invalid native capture clock');
    return {bars:parseBars(response.result.list,ms,Math.min(nowMs,response.serverTimeMs)), availableAtMs,
      receipt:{path,serverTimeMs:response.serverTimeMs,availableAtMs,payloadHash:evidenceHash(response.result)}};
  };
  const [h4,d1] = await Promise.all([load('240',4*HOUR,options.h4Limit??240),load('D',DAY,options.d1Limit??240)]);
  const observations = [h4.receipt,d1.receipt];
  return {h4:h4.bars,d1:d1.bars,h4AvailableAtMs:h4.availableAtMs,d1AvailableAtMs:d1.availableAtMs,
    observations,sourceHash:evidenceHash({asset,observations,h4:h4.bars,d1:d1.bars})};
}
export async function captureBrainDataset(input: {asset:ConfiguredAsset;startMs:number;endMs:number;includeH1?:boolean;
  maxPages?:number;request?:PublicMarketRequest;clock?:()=>number}): Promise<BrainDataset> {
  if (![input.startMs,input.endMs].every(Number.isFinite) || input.startMs < 0 || input.endMs <= input.startMs) throw new Error('Invalid capture interval');
  const maxPages = limits(input.maxPages??100,1000), symbol = getConfiguredInstrument(input.asset).symbol;
  const request = input.request??bybitPublicGet, clock = input.clock??Date.now;
  const receipts:BrainDataset['receipts']=[], missing=['HISTORICAL_BID_ASK_DEPTH','HISTORICAL_CALENDAR_SNAPSHOTS','HISTORICAL_FUNDING_MARKS'];
  const record=async<T>(path:string)=>{
    const response=await request<T>(path),availableAtMs=clock();
    if(!Number.isFinite(response.serverTimeMs)||!Number.isFinite(availableAtMs)||availableAtMs<input.endMs||response.serverTimeMs>availableAtMs+5000)throw new Error('Invalid capture availability');
    receipts.push({path,serverTimeMs:response.serverTimeMs,availableAtMs,payloadHash:evidenceHash(response.result)});
    return {response,availableAtMs};
  };
  let metadata:BybitInstrumentMetadata|undefined;
  try {
    const {response,availableAtMs}=await record<{list?:unknown[]}>(`/v5/market/instruments-info?category=linear&symbol=${symbol}`);
    const raw=response.result.list?.find(row=>row&&typeof row==='object'&&(row as {symbol?:string}).symbol===symbol);
    metadata=validateBybitMetadata(symbol,raw,availableAtMs);
  } catch { missing.push('CURRENT_METADATA_UNAVAILABLE'); }
  missing.push('HISTORICAL_METADATA_INTERVAL_SCHEDULE');
  const captureStartMs=Math.max(input.startMs,metadata?Math.floor(metadata.launchTimeMs/DAY)*DAY:input.startMs);
  const load=async(interval:string,ms:number,mark=false)=>{
    const rows:Candle[]=[];let end=input.endMs;
    for(let page=0;page<maxPages;page++){
      const path=`/v5/market/${mark?'mark-price-kline':'kline'}?category=linear&symbol=${symbol}&interval=${interval}&limit=1000&start=${captureStartMs}&end=${end}`;
      const {response}=await record<{list:unknown}>(path);
      const raw=mark&&Array.isArray(response.result.list)?response.result.list.map(row=>Array.isArray(row)?[...row.slice(0,5),'0']:row):response.result.list;
      const bars=parseBars(raw,ms,Math.min(input.endMs+(mark?ms:0),response.serverTimeMs),captureStartMs);
      rows.push(...bars);
      if(!bars.length||bars[0].time*1000>=end)break;
      const oldest=bars[0].time*1000;
      if(oldest<=captureStartMs)break;
      end=oldest-1;
      if(page===maxPages-1)missing.push(`PAGINATION_BOUND_${mark?'MARK_':''}${interval}`);
    }
    // Reuse the same duplicate and geometry validation across page boundaries.
    const result=parseBars(rows.map(b=>[b.time*1000,b.open,b.high,b.low,b.close,b.volume]),ms,input.endMs+(mark?ms:0),captureStartMs);
    if(result.length&&result[0].time*1000>Math.ceil(captureStartMs/ms)*ms)missing.push(`NATIVE_START_GAP_${mark?'MARK_':''}${interval}`);
    if(result.some((b,i)=>i>0&&(b.time-result[i-1].time)*1000!==ms))missing.push(`BAR_GAPS_${mark?'MARK_':''}${interval}`);
    return result;
  };
  const h4=await load('240',4*HOUR),d1=await load('D',DAY),h1=input.includeH1?await load('60',HOUR):[];
  let markH1:Candle[]=[];
  try { markH1=await load('60',HOUR,true); } catch { missing.push('MARK_HISTORY_UNAVAILABLE'); }
  const rates=new Map<number,{rate:number;availableAtMs:number;sourceHash:string}>();
  let fundingEnd=input.endMs;
  try {
    for(let page=0;page<maxPages;page++){
      const path=`/v5/market/funding/history?category=linear&symbol=${symbol}&startTime=${captureStartMs}&endTime=${fundingEnd}&limit=200`;
      const {response,availableAtMs}=await record<{list?:{fundingRateTimestamp:string;fundingRate:string}[]}>(path);
      if(!Array.isArray(response.result.list))throw new Error('Missing funding list');
      let oldest=Infinity;
      for(const raw of response.result.list){
        const atMs=Number(raw.fundingRateTimestamp),rate=Number(raw.fundingRate);
        if(!Number.isFinite(atMs)||!Number.isFinite(rate)||atMs<0)throw new Error('Invalid native funding settlement');
        if(atMs<captureStartMs||atMs>input.endMs)continue;
        const prior=rates.get(atMs);
        if(prior&&prior.rate!==rate)throw new Error('Conflicting native funding settlement');
        rates.set(atMs,{rate,availableAtMs,sourceHash:evidenceHash({path,response})});oldest=Math.min(oldest,atMs);
      }
      if(!Number.isFinite(oldest)||oldest<=captureStartMs||oldest>=fundingEnd||response.result.list.length<200)break;
      fundingEnd=oldest-1;
      if(page===maxPages-1)missing.push('PAGINATION_BOUND_FUNDING');
    }
  } catch { missing.push('FUNDING_HISTORY_UNAVAILABLE'); }
  const marks=new Map(markH1.map(b=>[b.time*1000,b.open]));
  const funding=[...rates].sort((a,b)=>a[0]-b[0]).map(([atMs,row])=>({...row,atMs,mark:marks.get(atMs)??null}));
  if(funding.length>0&&funding.every(row=>row.mark!==null))missing.splice(missing.indexOf('HISTORICAL_FUNDING_MARKS'),1);
  const capturedAtMs=clock();
  const body:Omit<BrainDataset,'sourceHash'>={version:'v6-dataset-1',asset:input.asset,symbol,startMs:captureStartMs,requestedStartMs:input.startMs,endMs:input.endMs,capturedAtMs,h4,d1,h1,receipts,observations:[],missing:[...new Set(missing)],
    ...(metadata?{metadata}:{}),costs:freezeBrainCosts(input.asset),markH1,funding};
  return {...body,sourceHash:evidenceHash(body)};
}
export function verifyBrainDataset(value: BrainDataset): BrainDataset {
  const {sourceHash,...body}=value;
  if(value.version!=='v6-dataset-1'||!isConfiguredAsset(value.asset)||value.symbol!==getConfiguredInstrument(value.asset).symbol||
    sourceHash!==evidenceHash(body)||!Array.isArray(value.observations)||value.observations.length!==0||
    ![value.startMs,value.endMs,value.capturedAtMs].every(Number.isFinite)||value.endMs<=value.startMs||value.capturedAtMs<value.endMs)throw new Error('Invalid native dataset hash, identity or capture clocks');
  if(value.metadata&&(value.metadata.symbol!==value.symbol||!Number.isFinite(value.metadata.verifiedAtMs)||value.metadata.verifiedAtMs>value.capturedAtMs))throw new Error('Invalid current metadata capture');
  if(value.costs&&evidenceHash(value.costs)!==evidenceHash(freezeBrainCosts(value.asset)))throw new Error('Dataset costs differ from current frozen definition');
  if(value.funding&&(!Array.isArray(value.funding)||value.funding.some((row,i)=>![row.atMs,row.rate,row.availableAtMs].every(Number.isFinite)||row.atMs<value.startMs||row.atMs>value.endMs||row.availableAtMs<row.atMs||row.availableAtMs>value.capturedAtMs||
    (row.mark!==null&&(!Number.isFinite(row.mark)||row.mark<=0))||!/^[a-f0-9]{64}$/.test(row.sourceHash)||(i>0&&row.atMs<=value.funding![i-1].atMs))))throw new Error('Invalid funding observation coverage');
  for(const [bars,ms] of [[value.h4,4*HOUR],[value.d1,DAY],[value.h1,HOUR],[value.markH1??[],HOUR]] as const){
    if(!Array.isArray(bars))throw new Error('Missing native bar series');
    const normalized=parseBars(bars.map(b=>[b.time*1000,b.open,b.high,b.low,b.close,b.volume]),ms,value.endMs+(bars===value.markH1?HOUR:0),value.startMs);
    if(evidenceHash(normalized)!==evidenceHash(bars))throw new Error('Duplicate, unsorted or invalid native bars');
  }
  return value;
}

/** Repair missing boundary opens from retained one-minute mark responses, with a bounded request count. */
export async function completeBrainFundingMarks(dataset:BrainDataset,options:{request?:PublicMarketRequest;clock?:()=>number;maxRequests?:number}={}):Promise<BrainDataset>{
  verifyBrainDataset(dataset);
  const result=structuredClone(dataset),request=options.request??bybitPublicGet,clock=options.clock??Date.now,max=limits(options.maxRequests??512,10000);
  let count=0;
  for(const row of result.funding??[]){
    if(row.mark!==null)continue;
    if(count++>=max)break;
    const path=`/v5/market/mark-price-kline?category=linear&symbol=${result.symbol}&interval=1&start=${row.atMs}&end=${row.atMs+59999}&limit=1`;
    const response=await request<{list?:unknown[][]}>(path),availableAtMs=clock();
    if(!Number.isFinite(availableAtMs)||availableAtMs<result.capturedAtMs||!Number.isFinite(response.serverTimeMs)||response.serverTimeMs>availableAtMs+5000)throw new Error('Invalid mark repair capture clock');
    const receipt={path,serverTimeMs:response.serverTimeMs,availableAtMs,payloadHash:evidenceHash(response.result)};result.receipts.push(receipt);
    const raw=response.result.list?.find(b=>Number(b[0])===row.atMs);
    if(raw){
      const bar=parseBars([[...raw.slice(0,5),0]],60000,Math.min(row.atMs+60000,response.serverTimeMs),row.atMs)[0];
      if(bar){row.mark=bar.open;row.sourceHash=evidenceHash({priorSourceHash:row.sourceHash,receipt,mark:bar.open});row.availableAtMs=Math.max(row.availableAtMs,availableAtMs);}
    }
    result.capturedAtMs=Math.max(result.capturedAtMs,availableAtMs);
  }
  if(result.funding?.length&&result.funding.every(r=>r.mark!==null))result.missing=result.missing.filter(r=>r!=='HISTORICAL_FUNDING_MARKS');
  const {sourceHash:_old,...body}=result;result.sourceHash=evidenceHash(body);
  return verifyBrainDataset(result);
}
