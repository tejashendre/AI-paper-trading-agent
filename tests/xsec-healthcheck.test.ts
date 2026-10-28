import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateXsecHealth } from '../scripts/xsec-healthcheck.mjs';

const nowMs=Date.parse('2026-10-28T12:00:00Z');
function retired(){return {active:{runId:'test',brainVersion:'replacement-swing-v6-2026-10-24',initialCapital:10000,startedAt:new Date(nowMs-60000).toISOString()},
  mode:'HISTORICAL_ONLY',acknowledged:true,replacement:{version:'v6',runId:'test',mode:'SHADOW',generatedAtMs:nowMs-1000,scanId:1,commit:'release'},
  portfolio:{cashUsd:10000,positions:{},fundingTail:[],pendingLedgerEvents:[]},equity:null,lastRebalanceAt:null,commit:'release',nowMs};}
test('XSEC health explicitly accepts retirement only under a fresh matching replacement epoch',()=>{
  assert.equal(evaluateXsecHealth(retired()),true);
  const compose=fs.readFileSync('docker-compose.yml','utf8');
  assert.match(compose,/"node", "scripts\/xsec-healthcheck.mjs"/);
  for(const change of [
    {active:null},{active:{...retired().active,runId:'../bad'}},{active:{...retired().active,initialCapital:50000}},
    {mode:null},{mode:'ACTIVE'},{acknowledged:false},{replacement:null},
    {replacement:{...retired().replacement,runId:'old'}},{replacement:{...retired().replacement,commit:'old'}},
    {replacement:{...retired().replacement,generatedAtMs:nowMs-180000}},{replacement:{...retired().replacement,generatedAtMs:nowMs+1}},
    {replacement:{...retired().replacement,mode:'ERROR'}},{replacement:{...retired().replacement,scanId:0}},
    {replacement:{...retired().replacement,scanId:'1'}},{replacement:{...retired().replacement,generatedAtMs:String(nowMs)}},
    {portfolio:{cashUsd:10000,positions:{BTC:{}}}},{portfolio:{cashUsd:10000,positions:{},fundingTail:[{}]}},{portfolio:null},
    {portfolio:{positions:{}}},{portfolio:{cashUsd:10000,positions:{},fundingTail:{}}},
  ])assert.equal(evaluateXsecHealth({...retired(),...change}),false,JSON.stringify(change));
});
test('legacy XSEC still requires a recent rebalance and fails invalid clocks',()=>{
  const legacy={...retired(),active:null,mode:null,equity:'present',lastRebalanceAt:nowMs-1000};
  assert.equal(evaluateXsecHealth(legacy),true);
  for(const lastRebalanceAt of [null,NaN,nowMs-13*3600000,nowMs+1])assert.equal(evaluateXsecHealth({...legacy,lastRebalanceAt}),false);
});
