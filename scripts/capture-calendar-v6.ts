import { readFile, writeFile } from 'node:fs/promises';
import { ingestCalendarManifest } from '../src/lib/strategy/v6/calendarSource';
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
async function main(){
  const input=arg('--input'),output=arg('--output');
  if(!input||!output)throw new Error('Use --input SOURCE_STAMPED_JSON --output CAPTURE_FILE. Retain official source content and verify its coverage before ingestion.');
  const capture=ingestCalendarManifest(JSON.parse(await readFile(input,'utf8')),Date.now());
  await writeFile(output,JSON.stringify(capture,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,sourceHash:capture.sourceHash,releases:capture.manifest.sources.map(s=>s.release),expiresAtMs:capture.manifest.expiresAtMs}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
