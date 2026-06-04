import WebSocket from 'ws';
import { getRedis } from '../redis';
import { SUPPORTED_ASSETS } from '../market';

const BINANCE_WS_URL = 'wss://fstream.binance.com/stream';

// Binance stream format for depth and trades
// e.g. btcusdt@aggTrade, btcusdt@depth20@100ms
const ASSETS_TO_STREAM = ['BTC', 'ETH', 'SOL'];
const redis = getRedis();

function startDaemon() {
  const streams = ASSETS_TO_STREAM.flatMap(asset => {
    const symbol = `${asset.toLowerCase()}usdt`;
    return [`${symbol}@aggTrade`, `${symbol}@depth20@100ms`];
  });

  const streamQuery = streams.join('/');
  const wsUrl = `${BINANCE_WS_URL}?streams=${streamQuery}`;
  
  console.log(`[StreamDaemon] Connecting to Binance Futures WSS...`);
  console.log(`[StreamDaemon] Streams: ${streamQuery}`);

  let ws = new WebSocket(wsUrl);
  let pingInterval: NodeJS.Timeout;

  ws.on('open', () => {
    console.log(`[StreamDaemon] Connected successfully to Binance WSS.`);
    
    // Binance requires ping frames to keep connection alive
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 3 * 60 * 1000); // every 3 minutes
  });

  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (!payload.data || !payload.stream) return;

      const streamName = payload.stream;
      const eventData = payload.data;

      // Extract asset from stream name (e.g. "btcusdt@aggTrade" -> "BTC")
      const symbolMatch = streamName.split('@')[0];
      const assetKey = ASSETS_TO_STREAM.find(a => `${a.toLowerCase()}usdt` === symbolMatch);
      if (!assetKey) return;

      if (eventData.e === 'aggTrade') {
        // Live Price Tick
        const price = parseFloat(eventData.p);
        if (!isNaN(price)) {
          // Fire and forget to Redis
          redis.set(`market:live:${assetKey}`, price, { ex: 30 }); // 30s expiry
        }
      } else if (streamName.includes('depth')) {
        // Orderbook Update
        // eventData.b is bids [price, qty], eventData.a is asks [price, qty]
        const bids = eventData.b || [];
        const asks = eventData.a || [];

        let bidVolume = 0;
        let askVolume = 0;

        for (const bid of bids) {
          bidVolume += parseFloat(bid[1]);
        }
        for (const ask of asks) {
          askVolume += parseFloat(ask[1]);
        }

        const totalVol = bidVolume + askVolume;
        if (totalVol > 0) {
          const imbalance = (bidVolume - askVolume) / totalVol; // ranges from -1.0 to +1.0
          // Fire and forget to Redis
          redis.set(`market:imbalance:${assetKey}`, imbalance, { ex: 30 });
        }
      }
    } catch (err) {
      console.warn(`[StreamDaemon] Error processing message:`, err);
    }
  });

  ws.on('close', () => {
    console.log(`[StreamDaemon] Connection closed. Reconnecting in 5 seconds...`);
    clearInterval(pingInterval);
    setTimeout(startDaemon, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[StreamDaemon] WebSocket error:`, err);
    ws.close(); // will trigger 'close' event and reconnect
  });
}

// Start the daemon immediately
console.log(`[StreamDaemon] Booting real-time ingestion pipeline...`);
startDaemon();
