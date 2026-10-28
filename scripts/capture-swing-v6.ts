import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIGURED_ASSETS, isConfiguredAsset } from '../src/lib/trading/instrumentRegistry';
import { captureBrainDataset } from '../src/lib/strategy/v6/data';

const arg=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
async function main(){
  const output=arg('--output'),startMs=arg('--start')==='listing'?0:Date.parse(arg('--start')??''),endMs=Date.parse(arg('--end')??'');
  if(!output||!path.isAbsolute(output)||!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs>Date.now())throw new Error('Use --output ABSOLUTE_DIRECTORY --start ISO_DATE_OR_listing --end ISO_DATE');
  const assets=!arg('--assets')||arg('--assets')==='all'?[...CONFIGURED_ASSETS]:arg('--assets')!.split(',');
  if(!assets.every(isConfiguredAsset))throw new Error('Unknown configured asset');
  await mkdir(output,{recursive:true});
  for(const asset of assets){
    const dataset=await captureBrainDataset({asset,startMs,endMs,includeH1:process.argv.includes('--include-h1'),maxPages:Number(arg('--max-pages')??100)});
    const file=path.join(output,`${asset}-${dataset.sourceHash}.json`);
    await writeFile(file,JSON.stringify(dataset),{flag:'wx'});
    console.log(JSON.stringify({asset,file,sourceHash:dataset.sourceHash,startMs:dataset.startMs,h4:dataset.h4.length,d1:dataset.d1.length,h1:dataset.h1.length,
      funding:dataset.funding?.length??0,fundingMarks:dataset.funding?.filter(r=>r.mark!==null).length??0,currentMetadataVersion:dataset.metadata?.metadataVersion??null,missing:dataset.missing}));
  }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
