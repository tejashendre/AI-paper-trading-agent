import { NextResponse } from 'next/server';
import { verifyAuth } from '@/lib/auth';
import { MarketService, SUPPORTED_ASSETS } from '@/lib/market';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = verifyAuth(request);
  if (!auth.authorized) return NextResponse.json({ error: auth.error }, { status: 401 });

  const prices: Record<string, { price: number; change24h: number; changePercent24h: number; high24h: number; low24h: number; volume24h: number }> = {};

  const assets = Object.keys(SUPPORTED_ASSETS);
  
  await Promise.all(assets.map(async (asset) => {
    try {
      const [price, stats] = await Promise.all([
        MarketService.getCurrentPrice(asset),
        MarketService.get24hStats(asset)
      ]);
      prices[asset] = {
        price,
        change24h: stats.priceChange,
        changePercent24h: stats.priceChangePercent,
        high24h: stats.high,
        low24h: stats.low,
        volume24h: stats.volume
      };
    } catch {
      prices[asset] = { price: 0, change24h: 0, changePercent24h: 0, high24h: 0, low24h: 0, volume24h: 0 };
    }
  }));

  return NextResponse.json({ success: true, prices, timestamp: new Date().toISOString() });
}
