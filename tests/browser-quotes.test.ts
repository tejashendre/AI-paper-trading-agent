import assert from 'node:assert/strict';
import { test } from 'node:test';
test('browser stream merges deltas, uses bounded rendering and resets quotes on reconnect with REST recovery', async () => {
  const m:any=await import('../src/lib/data/browserQuoteStream').catch(()=>({}));
  assert.equal(typeof m.createBrowserQuoteStream,'function');
  let now=100000, fallbackCalls=0;const sockets:any[]=[];const timers=new Map<number,{fn:()=>void,ms:number}>();let id=0;
  const updates:any[]=[];
  const stream=m.createBrowserQuoteStream({symbols:{BTC:'BTCUSDT',EURUSD:'EURUSDUSDT'},now:()=>now,
    socketFactory:()=>{const s:any={readyState:1,send:()=>{},close:()=>{s.readyState=3;}};sockets.push(s);return s;},
    setTimer:(fn:()=>void,ms:number)=>{const key=++id;timers.set(key,{fn:()=>{timers.delete(key);fn();},ms});return key;},clearTimer:(key:number)=>timers.delete(key),
    fetchFallback:async()=>{fallbackCalls++;return {prices:{BTC:{price:90,source:'REST',fresh:true,updatedAt:new Date(now).toISOString()}}};},
    onUpdate:(update:any)=>updates.push(update)});
  await Promise.resolve();await Promise.resolve();
  sockets[0].onopen();
  const message=(data:any)=>sockets.at(-1).onmessage({data:JSON.stringify(data)});
  message({topic:'tickers.BTCUSDT',type:'snapshot',ts:now,data:{lastPrice:'100',bid1Price:'99',ask1Price:'101'}});
  message({topic:'tickers.BTCUSDT',type:'delta',ts:now+1,data:{fundingRate:'0.001'}});
  const render=[...timers.values()].find(t=>t.ms===100)!;assert.ok(render);
  render.fn();
  assert.equal(updates.at(-1).prices.BTC.price,100);
  assert.equal(updates.at(-1).prices.BTC.updatedAt,new Date(now).toISOString());
  assert.equal(updates.at(-1).prices.BTC.source,'WEBSOCKET');
  sockets[0].onclose();
  const retry=[...timers.values()].filter(t=>t.ms===1000).at(-1)!;retry.fn();
  assert.ok(sockets.length>=2);
  message({topic:'tickers.BTCUSDT',type:'delta',ts:now+2,data:{lastPrice:'999'}});
  render.fn();
  assert.notEqual(updates.at(-1).prices.BTC.price,999);
  assert.ok(fallbackCalls>=1);
  stream.stop();assert.equal(timers.size,0);
});
