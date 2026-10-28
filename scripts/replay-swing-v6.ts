import { readFile, writeFile } from 'node:fs/promises';
import { replaySwingV6 } from '../src/lib/strategy/v6/replay';
import type { BrainDataset } from '../src/lib/strategy/v6/data';
const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
async function main(){
  const files=arg('--datasets')?.split(','),output=arg('--output');
  if(!files?.length||!output)throw new Error('Use --datasets FILE[,FILE] --start ISO_DATE --end ISO_DATE --output FILE');
  const datasets:BrainDataset[]=await Promise.all(files.map(async f=>JSON.parse(await readFile(f,'utf8'))));
  const registration=arg('--registration')?JSON.parse(await readFile(arg('--registration')!,'utf8')):undefined;
  const calendars=arg('--calendars')?JSON.parse(await readFile(arg('--calendars')!,'utf8')):undefined;
  const report=replaySwingV6({datasets,startMs:Date.parse(arg('--start')??''),endMs:Date.parse(arg('--end')??''),registration,calendars});
  await writeFile(output,JSON.stringify(report,null,2),{flag:'wx'});
  console.log(JSON.stringify({output,verdict:report.verdict,eligible:report.eligible,decisions:report.decisions.length,
    descriptiveScenario:{trades:report.scenario.trades.length,finalEquityUsdt:report.scenario.finalEquityUsdt,stressedFinalEquityUsdt:report.scenario.stressedFinalEquityUsdt,
      maxDrawdown:report.scenario.maxDrawdown,gaps:report.scenario.gaps.length,promotionEvidence:false},reasons:report.reasons}));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
