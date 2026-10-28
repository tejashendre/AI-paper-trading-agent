import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CalendarManifest } from './engine';
import { evidenceHash } from './evidence';

const releases = z.enum(['FED','US_CPI','US_PAYROLLS','ECB','BOE','BOJ','EIA_WPSR']);
const stamp = z.number().finite().nonnegative();
const event = z.object({id:z.string().min(1),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),timeMs:stamp.nullable(),timeUncertain:z.boolean(),confirmedPastAtMs:stamp.optional()}).strict();
const inputSchema = z.object({version:z.literal('v6-calendar-input-1'),observedAtMs:stamp,expiresAtMs:stamp,coverageStartMs:stamp,coverageEndMs:stamp,
  sources:z.array(z.object({release:releases,source:z.string().url(),timezone:z.string().min(1),retrievedAtMs:stamp,coverageStartMs:stamp,coverageEndMs:stamp,
    content:z.string().min(1),contentHash:z.string().regex(/^[a-f0-9]{64}$/),verifiedBy:z.string().min(1),coverageVerified:z.literal(true),events:z.array(event)}).strict()).min(1)}).strict();
const hosts={FED:'federalreserve.gov',US_CPI:'bls.gov',US_PAYROLLS:'bls.gov',ECB:'ecb.europa.eu',BOE:'bankofengland.co.uk',BOJ:'boj.or.jp',EIA_WPSR:'eia.gov'};
export const calendarContentHash=(content:string)=>createHash('sha256').update(content).digest('hex');
export function ingestCalendarManifest(raw:unknown,nowMs:number){
  const input=inputSchema.parse(raw),DAY=86400000;
  if(!Number.isFinite(nowMs)||input.observedAtMs>nowMs||input.expiresAtMs<=input.observedAtMs||input.expiresAtMs-input.observedAtMs>DAY||
    input.coverageStartMs>input.observedAtMs||input.coverageEndMs<input.observedAtMs+7*DAY)throw new Error('Invalid calendar capture coverage or freshness');
  const seen=new Set<string>();
  for(const s of input.sources){
    const u=new URL(s.source),host=hosts[s.release];
    if(u.protocol!=='https:'||u.username||u.password||!(u.hostname===host||u.hostname.endsWith(`.${host}`)))throw new Error('Calendar source must be official');
    if(seen.has(s.release))throw new Error('Duplicate source coverage');seen.add(s.release);
    new Intl.DateTimeFormat('en-GB',{timeZone:s.timezone}).format(0);
    if(calendarContentHash(s.content)!==s.contentHash)throw new Error('Calendar content hash mismatch');
    if(s.retrievedAtMs>input.observedAtMs||input.observedAtMs-s.retrievedAtMs>DAY||s.coverageStartMs>input.coverageStartMs||s.coverageEndMs<input.coverageEndMs)throw new Error('Source coverage or observation clock invalid');
    const ids=new Set<string>();
    for(const e of s.events){
      if(ids.has(e.id))throw new Error('Duplicate calendar event');ids.add(e.id);
      if(!Number.isFinite(Date.parse(e.date))||new Date(e.date).toISOString().slice(0,10)!==e.date||
        (e.timeUncertain?e.timeMs!==null:e.timeMs===null)||
        (e.confirmedPastAtMs!==undefined&&e.confirmedPastAtMs>s.retrievedAtMs))throw new Error('Invalid calendar event timing');
      if(e.timeMs!==null){
        const parts=new Intl.DateTimeFormat('en-CA',{timeZone:s.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(e.timeMs);
        const part=(key:string)=>parts.find(p=>p.type===key)!.value;
        if(`${part('year')}-${part('month')}-${part('day')}`!==e.date)throw new Error('Calendar date contradicts release time');
      }
    }
  }
  const manifest:CalendarManifest={version:'v6-calendar-1',retrievedAtMs:input.observedAtMs,expiresAtMs:input.expiresAtMs,coverageStartMs:input.coverageStartMs,coverageEndMs:input.coverageEndMs,
    sources:input.sources.map(({release,source,timezone,retrievedAtMs,coverageStartMs,coverageEndMs})=>({release,source,timezone,retrievedAtMs,coverageStartMs,coverageEndMs})),
    events:input.sources.flatMap(s=>s.events.map(e=>({...e,release:s.release,source:s.source,timezone:s.timezone})))};
  return {version:'v6-calendar-capture-1' as const,input,manifest,sourceHash:evidenceHash({input,manifest})};
}
/** Only a retained, content-verified source capture is accepted; raw event lists cannot assert coverage. */
export async function readCalendarManifest(filePath:string):Promise<CalendarManifest|null>{
  try{
    const raw=JSON.parse(await readFile(filePath,'utf8'));
    if(raw.version!=='v6-calendar-capture-1')return null;
    const checked=ingestCalendarManifest(raw.input,raw.input.observedAtMs);
    return raw.sourceHash===checked.sourceHash&&evidenceHash(raw.manifest)===evidenceHash(checked.manifest)?checked.manifest:null;
  }catch{return null;}
}
export const loadCalendarManifest=readCalendarManifest;
