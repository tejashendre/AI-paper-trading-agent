import assert from 'node:assert/strict';
import test from 'node:test';
import { validateCalendar } from '../src/lib/strategy/v6/calendar';
const sourceModule=import('../src/lib/strategy/v6/calendarSource').catch(()=>null);
const NOW=Date.parse('2026-10-20T12:00:00Z'),DAY=86400000;
const input=()=>({version:'v6-calendar-input-1' as const,observedAtMs:NOW,expiresAtMs:NOW+DAY,coverageStartMs:NOW-DAY,coverageEndMs:NOW+8*DAY,sources:[{release:'EIA_WPSR' as const,source:'https://www.eia.gov/reports/upcoming.php',timezone:'America/New_York',retrievedAtMs:NOW,coverageStartMs:NOW-DAY,coverageEndMs:NOW+8*DAY,content:'Official source capture: no WPSR release in declared test interval.',contentHash:'',verifiedBy:'fixture reviewer',coverageVerified:true,events:[]}]});
test('calendar ingestion requires an actual content hash and explicit verified coverage',async()=>{
 const source=await sourceModule;assert.ok(source,'source-stamped ingestion exists');
 const doc=input();doc.sources[0].contentHash=source.calendarContentHash(doc.sources[0].content);
 const out=source.ingestCalendarManifest(doc,NOW);assert.equal(validateCalendar({asset:'OIL',manifest:out.manifest,nowMs:NOW}).allowed,true);
 assert.throws(()=>source.ingestCalendarManifest({...doc,sources:[{...doc.sources[0],coverageVerified:false}]},NOW),/coverage/i);
 assert.throws(()=>source.ingestCalendarManifest({...doc,sources:[{...doc.sources[0],content:'changed'}]},NOW),/hash/i);
});
test('calendar loader leaves absence and uncertain event coverage visible without inventing dates',async()=>{
 const source=await sourceModule;assert.ok(source);
 assert.equal(await source.readCalendarManifest('this-calendar-does-not-exist.json'),null);
 const doc=input();doc.sources[0].contentHash=source.calendarContentHash(doc.sources[0].content);
 const withEvent={...doc,sources:[{...doc.sources[0],events:[{id:'uncertain',date:'2026-10-20',timeMs:null,timeUncertain:true}]}]};
 const out=source.ingestCalendarManifest(withEvent,NOW);
 assert.equal(out.manifest.events.length,1);assert.equal(validateCalendar({asset:'OIL',manifest:out.manifest,nowMs:NOW}).allowed,false);
 assert.throws(()=>source.ingestCalendarManifest({...doc,sources:[{...doc.sources[0],source:'https://unofficial.invalid/eia'}]},NOW),/official/i);
});
