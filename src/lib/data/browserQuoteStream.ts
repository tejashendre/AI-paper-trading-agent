import { BybitTickerBook } from './bybitTicker';

type SocketLike={readyState:number;send:(data:string)=>void;close:()=>void;
  onopen:(()=>void)|null;onclose:(()=>void)|null;onerror:(()=>void)|null;
  onmessage:((event:{data:string})=>void)|null};
export function createBrowserQuoteStream(input:{symbols:Record<string,string>;
  fetchFallback:()=>Promise<any>;onUpdate:(update:any)=>void;
  socketFactory?:(url:string)=>SocketLike;now?:()=>number;
  setTimer?:(fn:()=>void,ms:number)=>any;clearTimer?:(id:any)=>void}) {
  const now=input.now??Date.now, schedule=input.setTimer??setTimeout, cancel=input.clearTimer??clearTimeout;
  const book=new BybitTickerBook(), assetsBySymbol=Object.fromEntries(Object.entries(input.symbols).map(([asset,symbol])=>[symbol,asset]));
  const latest:Record<string,any>={};const timers=new Set<any>();
  let stopped=false,inFlight=false,socket:SocketLike|null=null,retryDelay=1000;
  let lastReceiptMs=0;
  let lastPublished='';
  const timer=(fn:()=>void,ms:number)=>{const id=schedule(()=>{timers.delete(id);if(!stopped)fn();},ms);timers.add(id);return id;};
  const wsFresh=(symbol:string)=>{const s=book.get(symbol);return Boolean(s?.lastPrice && s.lastPriceEventMs &&
    now()-s.lastPriceEventMs<=10000 && now()-s.lastPriceEventMs>=-2000 && now()-s.receivedAtMs<=10000);};
  const recover=async()=>{
    if(stopped||inFlight||Object.values(input.symbols).every(wsFresh))return;
    inFlight=true;
    try {
      const response=await input.fetchFallback();
      if(stopped)return;
      for(const [asset,value] of Object.entries(response.prices??{})) {
        const snapshot=value as any, symbol=input.symbols[asset];
        if(symbol && !wsFresh(symbol) && Number(snapshot.price)>0) latest[asset]={...snapshot,deliveryPath:'SERVER_RECOVERY'};
      }
    } catch { /* The render clock exposes stale age; an outage never invents a price. */ }
    finally{inFlight=false;}
  };
  const publish=()=>{
    const prices:Record<string,any>={};
    for(const [asset,symbol] of Object.entries(input.symbols)) {
      const state=book.get(symbol);
      if(state?.lastPrice && wsFresh(symbol)) latest[asset]={...latest[asset],price:state.lastPrice,
        provider:'BYBIT_PUBLIC_BROWSER_WS',instrument:symbol,source:'WEBSOCKET',fresh:true,
        // Bybit's spot index: a live reference when the contract itself trades rarely.
        indexPrice:state.indexPrice,
        updatedAt:new Date(state.lastPriceEventMs!).toISOString(),receivedAtMs:state.receivedAtMs,
        deliveryPath:'BROWSER_WEBSOCKET',eventClockDifferenceMs:state.receivedAtMs-state.lastEventMs};
      const snapshot=latest[asset];if(!snapshot)continue;
      const age=now()-Date.parse(snapshot.updatedAt??'');
      prices[asset]={...snapshot,fresh:Number.isFinite(age)&&age>=-2000&&age<=10000 &&
        (snapshot.deliveryPath!=='BROWSER_WEBSOCKET' || wsFresh(symbol)),
        ageSeconds:Number.isFinite(age)?Math.max(0,age/1000):null,
        receiptAgeMs:snapshot.receivedAtMs?Math.max(0,now()-snapshot.receivedAtMs):null};
    }
    const fingerprint=JSON.stringify([Math.floor(now()/1000),Object.entries(prices).map(([a,p])=>[a,p.price,p.source,p.fresh])]);
    if(fingerprint!==lastPublished) {
    lastPublished=fingerprint;
    input.onUpdate({prices,timestamp:new Date(now()).toISOString(),refreshMode:'browser-stream',summary:{
      total:Object.keys(input.symbols).length,websocket:Object.values(prices).filter(p=>p.source==='WEBSOCKET'&&p.fresh).length,
      rest:Object.values(prices).filter(p=>p.source==='REST').length,
      missing:Object.values(input.symbols).length-Object.values(prices).filter(p=>p.fresh).length,
      independentVenues:1,streamConnected:socket?.readyState===1,
      streamReceiptAgeMs:lastReceiptMs?Math.max(0,now()-lastReceiptMs):null,renderIntervalMs:100}});
    }
    timer(publish,100);
  };
  const connect=()=>{
    if(stopped)return;
    book.reset();
    try {socket=input.socketFactory?input.socketFactory('wss://stream.bybit.com/v5/public/linear'):
      new WebSocket('wss://stream.bybit.com/v5/public/linear') as unknown as SocketLike;}
    catch {timer(connect,retryDelay);retryDelay=Math.min(30000,retryDelay*2);return;}
    const current=socket;lastReceiptMs=now();
    current.onopen=()=>{if(stopped||socket!==current)return;current.send(JSON.stringify({op:'subscribe',
      args:Object.values(input.symbols).flatMap(symbol=>['tickers.'+symbol,'publicTrade.'+symbol])}));};
    current.onmessage=event=>{
      if(stopped||socket!==current)return;
      try {const frame=JSON.parse(event.data);const state=book.apply(frame,now());
        if(state && assetsBySymbol[state.symbol]){lastReceiptMs=now();retryDelay=1000;}}
      catch { /* Ignore malformed public messages. */ }
    };
    current.onclose=()=>{if(stopped||socket!==current)return;book.reset();socket=null;void recover();
      timer(connect,retryDelay);retryDelay=Math.min(30000,retryDelay*2);};
    current.onerror=()=>{current.close();};
  };
  const heartbeat=()=>{if(socket?.readyState===1) {try{socket.send(JSON.stringify({op:'ping'}));}catch{socket.close();}}timer(heartbeat,20000);};
  const fallback=()=>{if(socket?.readyState===1 && now()-lastReceiptMs>45000)socket.close();void recover();timer(fallback,1000);};
  connect();void recover();timer(publish,100);timer(fallback,1000);timer(heartbeat,20000);
  return {stop:()=>{stopped=true;for(const id of timers)cancel(id);timers.clear();book.reset();
    if(socket){socket.onclose=null;socket.onmessage=null;socket.onopen=null;socket.onerror=null;socket.close();socket=null;}}};
}
