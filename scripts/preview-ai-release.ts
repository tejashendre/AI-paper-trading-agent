import { previewAiRunReset } from '../src/lib/admin/resetAiRun';
import { getRedis } from '../src/lib/redis';

const option=(name:string)=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
async function main(){
  const runId=option('--run-id'),archiveDirectory=option('--archive-dir');
  if(!runId||!archiveDirectory)throw new Error('Explicit --run-id and --archive-dir are required');
  try{
    const p=await previewAiRunReset({runId,archiveDirectory});
    console.log(JSON.stringify({mode:'PREVIEW',runId:p.runId,capital:p.capital,canReset:p.canReset,blockers:p.blockers,
      requiredPreparation:p.requiredPreparation,sourceDigest:p.sourceDigest,humanDigest:p.humanDigest,
      coverage:{archivedKeys:p.coverage.archivedKeys.length,gaps:p.coverage.gaps}},null,2));
  }finally{await getRedis().quit();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
