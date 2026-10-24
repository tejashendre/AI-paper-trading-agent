import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import { evidenceHash } from './evidence';

function locations(input:{directory:string;runId:string;decisionId:string}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.runId)||!/^[a-f0-9]{64}$/.test(input.decisionId))throw new Error('Invalid decision archive identity');
  const root=path.resolve(input.directory);
  return {root,features:path.join(root,'features'),decision:path.join(root,input.runId,'decisions',input.decisionId+'.json.gz')};
}
function byteSize(directory:string):number{
  if(!fs.existsSync(directory))return 0;
  return fs.readdirSync(directory,{withFileTypes:true}).reduce((sum,e)=>{
    if(e.isSymbolicLink())throw new Error('Decision archive cannot follow symbolic links');
    const file=path.join(directory,e.name);return sum+(e.isDirectory()?byteSize(file):fs.statSync(file).size);
  },0);
}
function atomic(file:string,bytes:Buffer){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx');
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);
}
export function persistBrainDecisionArchive(input:{directory:string;runId:string;decisionId:string;tape:unknown;maxBytes?:number}):void{
  const target=locations(input),maxBytes=input.maxBytes??2*1024*1024*1024;
  if(!Number.isFinite(maxBytes)||maxBytes<=0||evidenceHash(input.tape)!==input.decisionId)throw new Error('Invalid decision archive hash or budget');
  if(fs.existsSync(target.decision)){
    if(evidenceHash(readBrainDecisionArchive(input))!==input.decisionId)throw new Error('Decision archive identity conflict');return;
  }
  const features=new Map<string,unknown>();
  const pack=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(pack);
    if(value&&typeof value==='object'){
      const object=value as Record<string,unknown>;
      if(Array.isArray(object.h4)&&Array.isArray(object.d1)){
        const {h4,d1,...other}=object,body={h4,d1},hash=evidenceHash(body);features.set(hash,body);
        return {...Object.fromEntries(Object.entries(other).map(([key,v])=>[key,pack(v)])),brainFeatureReference:hash};
      }
      return Object.fromEntries(Object.entries(object).map(([key,v])=>[key,pack(v)]));
    }
    return value;
  };
  const compact=pack(input.tape),pending=new Map<string,Buffer>();
  for(const [hash,body] of features){const file=path.join(target.features,hash+'.json.gz');
    if(fs.existsSync(file)){if(evidenceHash(JSON.parse(gunzipSync(fs.readFileSync(file)).toString()))!==hash)throw new Error('Corrupted archived features');}
    else pending.set(file,gzipSync(JSON.stringify(body)));
  }
  pending.set(target.decision,gzipSync(JSON.stringify({version:'v6-decision-archive-1',decisionId:input.decisionId,tape:compact})));
  if(byteSize(target.root)+[...pending.values()].reduce((sum,b)=>sum+b.length,0)>maxBytes)throw new Error('Decision archive storage budget exhausted; preserve old evidence and block new entries');
  for(const [file,bytes] of pending)atomic(file,bytes);
}
export function readBrainDecisionArchive(input:{directory:string;runId:string;decisionId:string}):unknown{
  const target=locations(input),record=JSON.parse(gunzipSync(fs.readFileSync(target.decision)).toString());
  if(record.version!=='v6-decision-archive-1'||record.decisionId!==input.decisionId)throw new Error('Invalid decision archive record');
  const unpack=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(unpack);
    if(value&&typeof value==='object'){
      const {brainFeatureReference,...other}=value as Record<string,unknown>;
      const output=Object.fromEntries(Object.entries(other).map(([key,v])=>[key,unpack(v)]));
      if(brainFeatureReference!==undefined){
        if(typeof brainFeatureReference!=='string'||!/^[a-f0-9]{64}$/.test(brainFeatureReference))throw new Error('Invalid archived feature reference');
        const body=JSON.parse(gunzipSync(fs.readFileSync(path.join(target.features,brainFeatureReference+'.json.gz'))).toString());
        if(evidenceHash(body)!==brainFeatureReference)throw new Error('Archived feature hash mismatch');Object.assign(output,body);
      }
      return output;
    }
    return value;
  };
  const tape=unpack(record.tape);if(evidenceHash(tape)!==input.decisionId)throw new Error('Decision archive hash mismatch');return tape;
}
